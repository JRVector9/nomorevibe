import { describe, expect, it } from "vitest";
import { uptimeSplitPolicyHash, type UptimeSplitPolicy } from "@/lib/domain/products/uptime-split-policy";
import { formatUptimeSplitResult, formatUptimeSplitStatus, heldHomeHosts, parseUptimeSplitArgs, planUptimeSplit, uptimeExclusionError,
  uptimeSplitDatabaseUrl, uptimeSplitStageInput, type UptimeSplitReadback, type UptimeSplitSnapshot, type UptimeSplitTransition } from "@/lib/operations/uptime-split";
import { classifyStage } from "@/lib/operations/worker-progress";

const audit = ["--operator=jr", "--reason=u1c unit"];
function transition(...args: string[]): UptimeSplitTransition {
  const command = parseUptimeSplitArgs([...args, ...audit]);
  if (command.name === "status") throw new Error("unexpected status");
  return command;
}
const POLICY: UptimeSplitPolicy = { version: 1,
  hosts: [{ host: "m3", instanceId: "m3-maintenance", region: "kr-home", class: "home" },
    { host: "mini", instanceId: "mini-maintenance-standby", region: "kr-home", class: "home" }],
  claim: { ttlMs: 180_000 }, confirm: { affinityDays: 7 },
  breaker: { windowMinutes: 10, minChecks: 100, openRatio: 0.08, batchMin: 30, batchOpenRatio: 0.3, coolDownMinutes: 10,
    maxCoolDownMinutes: 60, probeSize: 30, probeCloseRatio: 0.05 } };
const HASH = uptimeSplitPolicyHash(POLICY);
const AT = "2026-10-19T03:00:00.000Z";

function readback(overrides: Partial<UptimeSplitReadback> = {}, control: Partial<UptimeSplitReadback["control"]> = {}): UptimeSplitReadback {
  return { at: AT, control: { mode: "legacy", epoch: 3, policy: POLICY, policyHash: HASH, ...control },
    uptimeControl: { observationsEnabled: false, gateEnabled: false },
    queue: { due: 0, dueOldestMinutes: null, claimed: 0, submitted: 0, submittedOldestMinutes: null, confirm: 0, confirmOldestMinutes: null,
      applied5m: 0, missingRows: 0 },
    breakers: [], outcomes1h: {}, applied1h: {}, ...overrides };
}
function snapshot(over: Partial<UptimeSplitSnapshot> = {}, back: UptimeSplitReadback = readback()): UptimeSplitSnapshot {
  return { readback: back, fence: "active", batchMode: "legacy", runners: ["m3-maintenance", "mini-maintenance-standby"], ...over };
}

describe("uptime split arguments", () => {
  it("parses status, policy and mode with every expectation and audit field, dry-run by default", () => {
    expect(parseUptimeSplitArgs(["status", "--json"])).toEqual({ name: "status", json: true });
    expect(transition("policy", "--file=p.json", "--expect-epoch=3", "--expect-policy-hash=none")).toEqual({ name: "policy", file: "p.json",
      expectEpoch: 3, expectPolicyHash: null, operator: "jr", reason: "u1c unit", execute: false, json: false });
    expect(transition("mode", "--to=claims", "--from-mode=legacy", "--expect-epoch=4", "--execute")).toMatchObject({ name: "mode", to: "claims",
      fromMode: "legacy", expectEpoch: 4, execute: true });
  });
  it("refuses missing expectations, unknown or duplicate options, bad values and URL arguments", () => {
    expect(() => parseUptimeSplitArgs(["mode", "--to=claims", "--expect-epoch=1", ...audit])).toThrow("uptime_split_missing_from_mode");
    expect(() => parseUptimeSplitArgs(["mode", "--to=claims", "--from-mode=legacy", "--expect-epoch=1", "--operator=jr"])).toThrow("uptime_split_missing_reason");
    expect(() => transition("mode", "--to=open", "--from-mode=legacy", "--expect-epoch=1")).toThrow("uptime_split_invalid_to");
    expect(() => transition("mode", "--to=claims", "--from-mode=legacy", "--expect-epoch=0")).toThrow("uptime_split_invalid_expect_epoch");
    expect(() => transition("policy", "--file=p", "--expect-epoch=1", "--expect-policy-hash=abc")).toThrow("uptime_split_invalid_expect_policy_hash");
    expect(() => transition("mode", "--to=claims", "--to=legacy", "--from-mode=legacy", "--expect-epoch=1")).toThrow("uptime_split_duplicate_option");
    expect(() => parseUptimeSplitArgs(["status", "--execute"])).toThrow("uptime_split_unknown_option");
    expect(() => parseUptimeSplitArgs(["status", "postgres://x"])).toThrow("uptime_split_url_argument_rejected");
    expect(() => parseUptimeSplitArgs(["breaker"])).toThrow("uptime_split_unknown_command");
  });
  it("reads only its own database variable and refuses libpq overrides", () => {
    expect(() => uptimeSplitDatabaseUrl({ DATABASE_URL: "postgres://app" })).toThrow("explicit_UPTIME_SPLIT_DATABASE_URL_required");
    expect(() => uptimeSplitDatabaseUrl({ UPTIME_SPLIT_DATABASE_URL: "postgres://ops", PGHOST: "elsewhere" })).toThrow("database_override_rejected");
    expect(uptimeSplitDatabaseUrl({ UPTIME_SPLIT_DATABASE_URL: "postgres://ops" })).toBe("postgres://ops");
  });
});

describe("uptime split plan", () => {
  it("switches legacy → claims with a verified policy, epoch+1, and keeps the policy for the way back", () => {
    const plan = planUptimeSplit(transition("mode", "--to=claims", "--from-mode=legacy", "--expect-epoch=3"), snapshot());
    expect(plan).toMatchObject({ blocked: [], change: "legacy → claims, epoch 3 → 4", next: { mode: "claims", policyHash: HASH } });
    const back = planUptimeSplit(transition("mode", "--to=legacy", "--from-mode=claims", "--expect-epoch=3"),
      snapshot({}, readback({ queue: { ...readback().queue, submitted: 2, claimed: 5 } }, { mode: "claims" })));
    expect(back).toMatchObject({ blocked: [], next: { mode: "legacy", policyHash: HASH } });
    expect(back.warnings).toEqual(["submitted_results_discarded:2", "live_claims_expire:5"]);
  });
  it("refuses stale expectations, a missing or unverifiable policy, PR09 observation, fenced DB and versioned batches", () => {
    const claims = (over: Partial<UptimeSplitSnapshot> = {}, back?: UptimeSplitReadback) =>
      planUptimeSplit(transition("mode", "--to=claims", "--from-mode=legacy", "--expect-epoch=3"), snapshot(over, back)).blocked;
    expect(planUptimeSplit(transition("mode", "--to=claims", "--from-mode=claims", "--expect-epoch=2"), snapshot()).blocked)
      .toEqual(["expect_epoch_mismatch:3", "expect_mode_mismatch:legacy", "uptime_split_transition_invalid"]);
    expect(claims({}, readback({}, { policy: null, policyHash: null }))).toEqual(["uptime_split_policy_missing"]);
    expect(claims({}, readback({}, { policyHash: "0".repeat(64) }))).toEqual(["uptime_split_policy_invalid"]);
    expect(claims({}, readback({ uptimeControl: { observationsEnabled: true, gateEnabled: false } }))).toEqual(["uptime_control_enabled"]);
    expect(claims({ fence: "fenced" })).toEqual(["site_fenced"]);
    expect(claims({ batchMode: "versioned" })).toEqual(["batch_mode_not_legacy:versioned"]);
    // 최근 maintenance 후보가 policy 에 home 으로 없으면 그 후보가 역할을 쥐는 동안 확인이 멈춘다
    expect(claims({ runners: ["m3-maintenance", "m3-maintenance-2"] })).toEqual(["uptime_runner_unconfigured:m3-maintenance-2"]);
  });
  it("validates a new policy: schema, unchanged, min checks ≤ 100 and the legacy 30·30% batch rule", () => {
    const policy = (file: unknown, back = readback({}, { policy: null, policyHash: null })) =>
      planUptimeSplit(transition("policy", "--file=p.json", "--expect-epoch=3", `--expect-policy-hash=${back.control.policyHash ?? "none"}`), snapshot({}, back), file);
    expect(policy(POLICY)).toMatchObject({ blocked: [], next: { mode: "legacy", policyHash: HASH }, change: `policy unset → ${HASH.slice(0, 12)}, epoch 3 → 4` });
    expect(policy(POLICY, readback()).blocked).toEqual(["policy_unchanged"]);
    expect(policy({ ...POLICY, version: 2 }).blocked[0]).toMatch(/^policy_invalid:version/);
    expect(policy({ ...POLICY, breaker: { ...POLICY.breaker, minChecks: 200 } }).blocked).toEqual(["policy_min_checks_above:100"]);
    expect(policy({ ...POLICY, breaker: { ...POLICY.breaker, batchMin: 50 } }).blocked).toEqual(["policy_batch_rule_differs_from_legacy:30/0.3"]);
    expect(policy({ ...POLICY, breaker: { ...POLICY.breaker, batchOpenRatio: 0.5 } }).blocked).toEqual(["policy_batch_rule_differs_from_legacy:30/0.3"]);
    expect(planUptimeSplit(transition("policy", "--file=p.json", "--expect-epoch=3", "--expect-policy-hash=none"), snapshot(), POLICY).blocked)
      .toEqual([`expect_policy_hash_mismatch:${HASH}`, "policy_unchanged"]);
  });
  it("in claims mode a policy change must keep every recent runner home and PR09 off, and drops in-flight claims", () => {
    const back = readback({}, { mode: "claims" });
    const next = { ...POLICY, hosts: [POLICY.hosts[0], { host: "oracle-osaka-smoke" as const, instanceId: "oracle-uptime-1", region: "ap-osaka-1",
      class: "probe" as const, maxPerHour: 1_000, batch: 40, concurrency: 4 }] };
    const plan = planUptimeSplit(transition("policy", "--file=p.json", "--expect-epoch=3", `--expect-policy-hash=${HASH}`), snapshot({}, back), next);
    expect(plan.blocked).toEqual(["uptime_runner_unconfigured:mini-maintenance-standby"]);
    expect(plan.warnings).toEqual(["in_flight_claims_discarded"]);
    const added = { ...POLICY, hosts: [...POLICY.hosts, next.hosts[1]] };
    expect(planUptimeSplit(transition("policy", "--file=p.json", "--expect-epoch=3", `--expect-policy-hash=${HASH}`), snapshot({}, back), added))
      .toMatchObject({ blocked: [], next: { mode: "claims", policyHash: uptimeSplitPolicyHash(added) } });
    // legacy 에서는 경고만 — 전환할 때 다시 막는다
    expect(planUptimeSplit(transition("policy", "--file=p.json", "--expect-epoch=3", `--expect-policy-hash=${HASH}`), snapshot(), next))
      .toMatchObject({ blocked: [], warnings: ["uptime_runner_unconfigured:mini-maintenance-standby"] });
  });
  it("formats status and results without the database URL", () => {
    const text = formatUptimeSplitStatus(snapshot());
    expect(text).toContain("mode=legacy epoch=3");
    expect(text).toContain("m3:m3-maintenance(home)");
    const plan = planUptimeSplit(transition("mode", "--to=claims", "--from-mode=legacy", "--expect-epoch=3"), snapshot());
    expect(formatUptimeSplitResult({ command: "mode", dryRun: true, executed: false, blocked: false, plan, before: snapshot() }))
      .toContain("dry-run 허용 — DB 쓰기 없음");
  });
});

describe("uptime split progress", () => {
  const now = new Date(AT);
  const claims = (queue: Partial<UptimeSplitReadback["queue"]>, breakers: UptimeSplitReadback["breakers"] = []) =>
    readback({ queue: { ...readback().queue, ...queue }, breakers }, { mode: "claims" });
  const open = (host: "m3" | "mini" | "oracle-osaka-smoke", probeAfter: string) => ({ host, state: "open" as const, reason: "batch_ratio", ratio: 0.8,
    openedAt: AT, probeAfter, probeChecks: 0, probeFailures: 0 });

  it("reports the uptime stage only in claims mode: due plus submitted, the older wait, and applied progress", () => {
    expect(uptimeSplitStageInput(readback())).toBeNull();
    expect(uptimeSplitStageInput(claims({ due: 12, dueOldestMinutes: 3, submitted: 2, submittedOldestMinutes: 9, applied5m: 40 })))
      .toEqual({ key: "uptime", enabled: true, waiting: 14, oldestMinutes: 9, completed5m: 40, progress5m: 40, errors5m: null, held: false });
    expect(uptimeSplitStageInput(claims({}))).toMatchObject({ waiting: 0, oldestMinutes: null });
  });
  it("treats an open home breaker before its probe time as a deliberate hold, not a stall", () => {
    const held = claims({ due: 500, dueOldestMinutes: 20 }, [open("m3", "2026-10-19T03:05:00.000Z")]);
    expect(heldHomeHosts(held)).toEqual(["m3"]);
    const stage = uptimeSplitStageInput(held)!;
    expect(classifyStage(stage, null, true, now)).toMatchObject({ role: "maintenance", stage: "uptime", reason: "backoff", alarm: false, restartEligible: false });
    // 시험 시각이 지났거나 probe(Oracle) 차단기면 home 은 쉬지 않는다 — 진행이 없으면 지금처럼 경보다
    expect(heldHomeHosts(claims({}, [open("m3", "2026-10-19T02:59:00.000Z")]))).toEqual([]);
    expect(heldHomeHosts(claims({}, [open("oracle-osaka-smoke", "2026-10-19T03:05:00.000Z")]))).toEqual([]);
    const stalled = uptimeSplitStageInput(claims({ due: 500, dueOldestMinutes: 20 }))!;
    expect(classifyStage(stalled, null, true, now)).toMatchObject({ reason: "no_progress", alarm: true });
    expect(classifyStage({ ...stalled, progress5m: 30, completed5m: 30 }, null, true, now)).toMatchObject({ reason: "progressing", alarm: false });
    // 막 쌓인 일은 5분까지 데우는 중이다
    expect(classifyStage(uptimeSplitStageInput(claims({ due: 3, dueOldestMinutes: 2 }))!, null, true, now).reason).toBe("warming_up");
  });
});

describe("mutual exclusion trigger errors", () => {
  it("maps only the 0104 trigger rejections (also inside a wrapped cause) to a refusal code", () => {
    const pg = Object.assign(new Error("uptime_control_requires_split_legacy"), { code: "55000" });
    expect(uptimeExclusionError(pg)).toBe("uptime_control_requires_split_legacy");
    expect(uptimeExclusionError(Object.assign(new Error("Failed query: update ..."), { cause: Object.assign(
      new Error("uptime_split_requires_uptime_control_disabled"), { code: "55000" }) }))).toBe("uptime_split_requires_uptime_control_disabled");
    expect(uptimeExclusionError(Object.assign(new Error("other"), { code: "55000" }))).toBeNull();
    expect(uptimeExclusionError(Object.assign(new Error("uptime_control_requires_split_legacy"), { code: "23514" }))).toBeNull();
    expect(uptimeExclusionError(null)).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advanceUptimeBreaker, closedUptimeBreaker, dbTimestampMicros, decideSplitResults, parseUptimeSplitControl, settleUptimeBreaker,
  splitResetStreak, uptimeClaimAllowance, uptimeHealthDay, uptimeSplitClockValid, uptimeSplitHostEntry, UptimeSplitPolicySchema,
  uptimeSplitPolicyHash, uptimeWindowBucket, uptimeWindowSince, UPTIME_RECHECK_MS, UPTIME_SPLIT_HOLD_MS,
  type UptimeClaimSnapshot, type UptimeHealthSnapshot, type UptimeHost, type UptimeHostBreaker, type UptimeProductSnapshot,
  type UptimeSplitContext, type UptimeSplitInput, type UptimeSplitPolicy, type UptimeSplitResult,
} from "@/lib/domain/products/uptime-split-policy";

// U1a: split-v1 순수 판정. DB 경로(claim·제출·적용)는 U1b 통합 테스트가 본다.
const policy: UptimeSplitPolicy = { version: 1, hosts: [
  { host: "m3", instanceId: "m3-maintenance", region: "kr-home", class: "home" },
  { host: "mini", instanceId: "mini-maintenance-standby", region: "kr-home", class: "home" },
  { host: "oracle-osaka-smoke", instanceId: "oracle-uptime-1", region: "ap-osaka-1", class: "probe", maxPerHour: 1000, batch: 40, concurrency: 4 }],
  claim: { ttlMs: 180_000 }, confirm: { affinityDays: 7 },
  breaker: { windowMinutes: 10, minChecks: 200, openRatio: 0.08, batchMin: 30, batchOpenRatio: 0.3, coolDownMinutes: 10,
    maxCoolDownMinutes: 60, probeSize: 30, probeCloseRatio: 0.05 } };
const INSTANCE: Record<UptimeHost, string> = { m3: "m3-maintenance", mini: "mini-maintenance-standby", "oracle-osaka-smoke": "oracle-uptime-1" };
const wall = new Date("2026-10-19T03:00:00.000Z");
const at = (ms: number) => new Date(wall.getTime() + ms);
const MIN = 60_000, HOUR = 60 * MIN;
const control = { mode: "claims" as const, epoch: 5, policy, policyHash: uptimeSplitPolicyHash(policy) };
const context = (change: Partial<UptimeSplitContext> = {}): UptimeSplitContext => ({ control, uptimeControl: { observationsEnabled: false, gateEnabled: false },
  wall, breakers: [], windows: {}, ...change });

let sequence = 0;
type Shape = { host?: UptimeHost; status?: number; kind?: UptimeSplitResult["kind"]; claim?: Partial<UptimeClaimSnapshot>;
  result?: Partial<UptimeSplitResult>; product?: Partial<UptimeProductSnapshot> | null; health?: Partial<UptimeHealthSnapshot> | null };
function input(shape: Shape = {}): UptimeSplitInput {
  const id = ++sequence, host = shape.host ?? "m3", token = `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
  const kind = shape.kind ?? "http", status = shape.status ?? (kind === "http" ? 200 : 0);
  const claim: UptimeClaimSnapshot = { productId: id, state: host === "m3" ? "claimed" : "submitted", token, epoch: 3, controlEpoch: 5,
    ownerInstanceId: INSTANCE[host], host, hostClass: host === "oracle-osaka-smoke" ? "probe" : "home", claimedAt: at(-60_000),
    claimSlug: `p-${id}`, claimUrl: `https://p${id}.example`, dueAt: at(-2 * MIN), confirmClass: null, confirmReason: null,
    confirmRequestedAt: null, affinityHomeUntil: null, conflictCount: 0, ...shape.claim };
  const result: UptimeSplitResult = { token, epoch: 3, startedAt: at(-50_000), observedAt: at(-49_000), kind, status, latencyMs: 812, ...shape.result };
  const product = shape.product === null ? null : { id, slug: `p-${id}`, url: `https://p${id}.example`, status: "verified", accessMode: "website",
    updatedAt: "2026-10-01 00:00:00.123456", ...shape.product };
  const health = shape.health === null ? null : { checkedAt: new Date(result.observedAt.getTime() - 7 * HOUR), failures: 0, downSince: null, ...shape.health };
  return { claim, result, product, health };
}
const one = (value: UptimeSplitInput, change: Partial<UptimeSplitContext> = {}) => decideSplitResults([value], context(change)).decisions[0];
const failures = (host: UptimeHost, count: number, total: number, kind: UptimeSplitResult["kind"] = "timeout") =>
  Array.from({ length: total }, (_, index) => index < count ? input({ host, kind }) : input({ host }));
const breaker = (host: UptimeHost, change: Partial<UptimeHostBreaker>): UptimeHostBreaker => ({ ...closedUptimeBreaker(host, policy), ...change });

describe("split policy·hash·control", () => {
  it("accepts the design policy and hashes canonically (key order·host order)", () => {
    expect(UptimeSplitPolicySchema.parse(policy)).toEqual(policy);
    const shuffled = JSON.parse(JSON.stringify({ breaker: policy.breaker, confirm: policy.confirm, claim: policy.claim,
      hosts: [...policy.hosts].reverse(), version: 1 }));
    expect(uptimeSplitPolicyHash(shuffled)).toBe(uptimeSplitPolicyHash(policy));
    expect(uptimeSplitPolicyHash(policy)).toMatch(/^[a-f0-9]{64}$/);
    expect(uptimeSplitPolicyHash({ ...policy, confirm: { affinityDays: 6 } })).not.toBe(uptimeSplitPolicyHash(policy));
    expect(uptimeSplitHostEntry(policy, "oracle-uptime-1")?.class).toBe("probe");
    expect(uptimeSplitHostEntry(policy, "unknown")).toBeNull();
  });
  it.each([
    ["Oracle as home", { hosts: [policy.hosts[0], { ...policy.hosts[2], class: "home" }] }],
    ["M3 as probe", { hosts: [{ ...policy.hosts[0], class: "probe", maxPerHour: 1, batch: 1, concurrency: 1 }, policy.hosts[1]] }],
    ["Oracle outside Osaka", { hosts: [policy.hosts[0], { ...policy.hosts[2], region: "us-ashburn-1" }] }],
    ["probe without pacing", { hosts: [policy.hosts[0], { host: "oracle-osaka-smoke", instanceId: "o", region: "ap-osaka-1", class: "probe" }] }],
    ["duplicate instance", { hosts: [policy.hosts[0], { ...policy.hosts[1], instanceId: "m3-maintenance" }] }],
    ["two regions for one host", { hosts: [policy.hosts[0], { ...policy.hosts[0], instanceId: "m3-2", region: "elsewhere" }] }],
    ["no home host", { hosts: [policy.hosts[2]] }],
    ["instance longer than SERVICE_INSTANCE_ID", { hosts: [{ ...policy.hosts[0], instanceId: "m".repeat(49) }] }],
    ["unknown key", { extra: true }],
    ["cool-down shorter than the window", { breaker: { ...policy.breaker, coolDownMinutes: 5 } }],
    ["max cool-down below cool-down", { breaker: { ...policy.breaker, maxCoolDownMinutes: 9 } }],
    ["open ratio 1 (never opens)", { breaker: { ...policy.breaker, openRatio: 1 } }],
  ])("rejects %s", (_name, change) => {
    expect(UptimeSplitPolicySchema.safeParse({ ...policy, ...change }).success).toBe(false);
  });
  it("allows a second home consumer on the same host (same region)", () => {
    expect(UptimeSplitPolicySchema.safeParse({ ...policy, hosts: [...policy.hosts, { ...policy.hosts[0], instanceId: "uptime-consumer-m3-2" }] }).success).toBe(true);
  });
  it("reads the control row: legacy needs no policy, claims needs a matching hash", () => {
    expect(parseUptimeSplitControl({ mode: "legacy", epoch: 1, policy: null, policyHash: null })).toEqual({ mode: "legacy", epoch: 1, policy: null, policyHash: null });
    const stored = JSON.parse(JSON.stringify({ ...policy, version: 1 }));
    expect(parseUptimeSplitControl({ mode: "claims", epoch: 5, policy: stored, policyHash: control.policyHash }).policy).toEqual(policy);
    expect(() => parseUptimeSplitControl({ mode: "claims", epoch: 5, policy: null, policyHash: null })).toThrow("uptime_split_policy_required");
    expect(() => parseUptimeSplitControl({ mode: "claims", epoch: 5, policy, policyHash: "0".repeat(64) })).toThrow("uptime_split_policy_hash_mismatch");
    expect(() => parseUptimeSplitControl({ mode: "claims", epoch: 5, policy, policyHash: null })).toThrow("uptime_split_control_invalid");
    expect(() => parseUptimeSplitControl({ mode: "gate", epoch: 5, policy: null, policyHash: null })).toThrow();
    expect(() => parseUptimeSplitControl({ mode: "legacy", epoch: 0, policy: null, policyHash: null })).toThrow("uptime_split_control_invalid");
  });
});

describe("clock·slot·day", () => {
  it("keeps products.updated_at microseconds", () => {
    expect(dbTimestampMicros("2026-10-19 03:00:00.000500")).toBe(Date.parse("2026-10-19T03:00:00Z") * 1000 + 500);
    expect(dbTimestampMicros("2026-10-19T03:00:00")).toBe(Date.parse("2026-10-19T03:00:00Z") * 1000);
    expect(dbTimestampMicros("2026-10-19 03:00:00.5")).toBe(Date.parse("2026-10-19T03:00:00Z") * 1000 + 500_000);
    for (const bad of ["2026-10-19 03:00:00+00", "2026-10-19", "infinity", "2026-13-40 00:00:00"]) expect(() => dbTimestampMicros(bad)).toThrow("invalid_db_timestamp");
  });
  it("accepts host clocks within ±30s of the claim and the apply wall", () => {
    const base = { claimedAt: at(-60_000), startedAt: at(-90_000), observedAt: at(30_000), wall };
    expect(uptimeSplitClockValid(base)).toBe(true);
    expect(uptimeSplitClockValid({ ...base, startedAt: at(-90_001) })).toBe(false);
    expect(uptimeSplitClockValid({ ...base, observedAt: at(30_001) })).toBe(false);
    expect(uptimeSplitClockValid({ ...base, observedAt: at(-90_001) })).toBe(false);
    expect(uptimeSplitClockValid({ ...base, claimedAt: null })).toBe(false);
    expect(uptimeSplitClockValid({ ...base, wall: new Date(Number.NaN) })).toBe(false);
  });
  it("uses KST days like writeHealthResult and minute buckets for the breaker window", () => {
    expect(uptimeHealthDay(new Date("2026-10-18T14:59:59.999Z"))).toBe("2026-10-18");
    expect(uptimeHealthDay(new Date("2026-10-18T15:00:00.000Z"))).toBe("2026-10-19");
    expect(uptimeWindowBucket(new Date("2026-10-19T03:04:59.999Z"))).toEqual(new Date("2026-10-19T03:04:00Z"));
    expect(uptimeWindowSince(policy, wall)).toEqual(at(-10 * MIN));
  });
  it("puts the raw observation in the 6h slot of its start (uptime_observations_time)", () => {
    const edge = input({ host: "oracle-osaka-smoke", status: 403, claim: { claimedAt: new Date("2026-10-19T05:59:00Z") },
      result: { startedAt: new Date("2026-10-19T05:59:59.999Z"), observedAt: new Date("2026-10-19T06:00:00.500Z") } });
    const later = new Date("2026-10-19T06:01:00Z");
    expect(decideSplitResults([edge], context({ wall: later })).decisions[0].raw?.observation.slot).toEqual(new Date("2026-10-19T00:00:00Z"));
    const next = input({ host: "oracle-osaka-smoke", status: 403, claim: { claimedAt: new Date("2026-10-19T06:00:00Z") },
      result: { startedAt: new Date("2026-10-19T06:00:00Z"), observedAt: new Date("2026-10-19T06:00:01Z") } });
    expect(decideSplitResults([next], context({ wall: later })).decisions[0].raw?.observation.slot).toEqual(new Date("2026-10-19T06:00:00Z"));
  });
  it("restarts a streak only when the product changed after it began (PR-0a meaning), to the microsecond", () => {
    const checked = new Date("2026-10-19T00:00:00.000Z");
    expect(splitResetStreak(null, "2026-10-19 00:00:00.000500")).toBe(false);
    expect(splitResetStreak({ checkedAt: checked, failures: 2, downSince: checked }, "2026-10-19 00:00:00.000500")).toBe(true);
    expect(splitResetStreak({ checkedAt: checked, failures: 2, downSince: checked }, "2026-10-19 00:00:00")).toBe(false);
    expect(splitResetStreak({ checkedAt: at(0), failures: 2, downSince: new Date("2026-10-18T00:00:00Z") }, "2026-10-18 12:00:00")).toBe(true);
    expect(splitResetStreak({ checkedAt: at(0), failures: 2, downSince: null }, "2026-10-01 00:00:00")).toBe(true);
    expect(splitResetStreak({ checkedAt: at(0), failures: 0, downSince: null }, "2026-10-01 00:00:00")).toBe(false);
  });
});

describe("decideSplitResults — design §3.2 table", () => {
  it("claim lost: another claim round owns the row, nothing is written", () => {
    for (const value of [input({ claim: { token: "00000000-0000-4000-8000-ffffffffffff" } }), input({ claim: { epoch: 4 } }),
      input({ claim: { state: "idle", token: null } })]) {
      expect(one(value)).toEqual({ productId: value.claim.productId, host: "m3", outcome: "lost", reason: "claim_lost", claim: null, health: null, raw: null, textSample: false });
    }
  });
  it.each([
    ["mode_legacy", { control: { ...control, mode: "legacy" as const } }],
    ["uptime_control_enabled", { uptimeControl: { observationsEnabled: true, gateEnabled: false } }],
    ["uptime_control_enabled", { uptimeControl: { observationsEnabled: true, gateEnabled: true } }],
    ["control_epoch", { control: { ...control, epoch: 6 } }],
  ] as const)("row 1 %s: discard, idle, due unchanged, no raw", (reason, change) => {
    const value = input({ host: "oracle-osaka-smoke", status: 500, claim: { confirmClass: null } });
    expect(one(value, change)).toMatchObject({ outcome: "discarded", reason, health: null, raw: null,
      claim: { token: value.claim.token, epoch: 3, dueAt: value.claim.dueAt, lastOutcome: reason, lastApplied: null } });
  });
  it.each([
    ["unknown instance", { ownerInstanceId: "oracle-uptime-9" }],
    ["host differs from the policy", { host: "mini" as const, hostClass: "home" as const }],
    ["class differs from the policy", { hostClass: "home" as const }],
  ])("row 1 source_unconfigured: %s", (_name, claim) => {
    expect(one(input({ host: "oracle-osaka-smoke", claim }))).toMatchObject({ outcome: "discarded", reason: "source_unconfigured", health: null });
  });
  it("row 1 submitted_not_probe: a submitted row written as home is never judged (only the home job's own results count)", () => {
    const forged = { ...input({ host: "m3", kind: "network", claim: { state: "submitted" } }), submitted: true };
    expect(one(forged)).toMatchObject({ outcome: "discarded", reason: "submitted_not_probe", health: null, raw: null,
      claim: { dueAt: forged.claim.dueAt, lastOutcome: "submitted_not_probe", lastApplied: null } });
    expect(one({ ...input({ host: "m3", status: 200, claim: { state: "submitted" } }), submitted: true })).toMatchObject({ outcome: "discarded" });
    // 같은 home 결과라도 잡이 직접 연 것(own)은 센다. probe 의 제출 행은 그대로 판정한다
    expect(one(input({ host: "m3", kind: "network" }))).toMatchObject({ outcome: "applied", reason: "split_counted" });
    expect(one({ ...input({ host: "oracle-osaka-smoke", kind: "network" }), submitted: true })).toMatchObject({ outcome: "confirm_requested" });
  });
  it("row 1 legacy without policy: leftover submitted rows go idle", () => {
    const batch = decideSplitResults([input({ host: "oracle-osaka-smoke" })], context({ control: { mode: "legacy", epoch: 6, policy: null, policyHash: null } }));
    expect(batch.decisions[0]).toMatchObject({ outcome: "discarded", reason: "mode_legacy" });
    expect(batch).toMatchObject({ windows: [], breakers: [] });
  });
  it.each([
    ["product_missing", { product: null }, false],
    ["product_unlisted", { product: { status: "banned" } }, false],
    ["product_unlisted", { product: { accessMode: "installable" } }, false],
    ["url_changed", { product: { url: "https://moved.example" } }, true],
    ["product_changed", { product: { slug: "renamed" } }, false],
    // 시작 49.999초 전(...:59:10.000) 뒤에 바뀐 것: 마이크로초 하나라도 늦으면 stale
    ["product_changed", { product: { updatedAt: "2026-10-19 02:59:10.000001" } }, false],
  ] as const)("row 2 %s: stale, counter unchanged", (reason, shape, dueNow) => {
    const value = input({ status: 500, ...shape });
    const decision = one(value);
    expect(decision).toMatchObject({ outcome: "stale", reason, health: null, raw: null });
    expect(decision.claim?.dueAt).toEqual(dueNow ? wall : value.claim.dueAt);
  });
  it("row 2 boundary: a product changed exactly at the start is still current", () => {
    expect(one(input({ product: { updatedAt: "2026-10-19 02:59:10" } })).outcome).toBe("applied");
  });
  it.each([
    ["start before claim −30s", { result: { startedAt: at(-90_001) } }],
    ["observed after wall +30s", { result: { observedAt: at(30_001) } }],
    ["observed before start", { result: { startedAt: at(-40_000), observedAt: at(-41_000) } }],
  ])("row 3 clock (%s): stale, due 15 minutes later (the same site is not reopened every tick)", (_name, shape) => {
    const value = input({ host: "oracle-osaka-smoke", status: 403, ...shape });
    expect(one(value)).toMatchObject({ outcome: "stale", reason: "clock", health: null, raw: null, claim: { dueAt: at(UPTIME_SPLIT_HOLD_MS) } });
  });
  it("row 4 older: health already at or after this observation", () => {
    const observed = at(-49_000);
    expect(one(input({ health: { checkedAt: observed } }))).toMatchObject({ outcome: "stale", reason: "older_observation", health: null,
      claim: { dueAt: new Date(observed.getTime() + UPTIME_RECHECK_MS) } });
  });
  it("row 5 minimum_interval: within 6h of the last applied check, held to checked+6h", () => {
    const checkedAt = new Date(at(-49_000).getTime() - UPTIME_RECHECK_MS + 1);
    expect(one(input({ status: 500, health: { checkedAt } }))).toMatchObject({ outcome: "held", reason: "minimum_interval", health: null, raw: null,
      claim: { dueAt: new Date(checkedAt.getTime() + UPTIME_RECHECK_MS) } });
    // 정확히 6시간이면 통과(legacy 의 6시간과 같은 경계)
    expect(one(input({ status: 500, health: { checkedAt: new Date(at(-49_000).getTime() - UPTIME_RECHECK_MS) } })).outcome).toBe("applied");
  });
  it("row 6 success from any host is applied (failures 0, down_since null); only home refreshes the text sample", () => {
    const sick = { failures: 7, downSince: new Date("2026-10-17T00:00:00Z") };
    const oracle = one(input({ host: "oracle-osaka-smoke", status: 301, health: sick, result: { latencyMs: 2_147_483_648.4 } }));
    expect(oracle).toMatchObject({ outcome: "applied", reason: "split_success", raw: null, textSample: false,
      health: { status: 301, failures: 0, downSince: null, alive: true, latencyMs: 2_147_483_647, checkedAt: at(-49_000), day: "2026-10-19" },
      claim: { dueAt: at(-49_000 + UPTIME_RECHECK_MS), confirmClass: null, conflictCount: 0, lastOutcome: "split_success",
        lastApplied: { at: wall, host: "oracle-osaka-smoke" } } });
    expect(one(input({ status: 204 }))).toMatchObject({ outcome: "applied", textSample: true, health: { latencyMs: 812 } });
    expect(one(input({ status: 200, health: null }))).toMatchObject({ health: { failures: 0, downSince: null } });
  });
  it("row 6 home success on a confirm row: regional conflict, 7-day home affinity, applied raw", () => {
    const value = input({ claim: { confirmClass: "home", confirmReason: "http:403", confirmRequestedAt: at(-3 * MIN), conflictCount: 2 } });
    const decision = one(value);
    expect(decision).toMatchObject({ outcome: "applied", reason: "split_confirm_success", textSample: true,
      claim: { confirmClass: null, confirmReason: null, confirmRequestedAt: null, conflictCount: 3, affinityHomeUntil: at(7 * 24 * HOUR) },
      raw: { disposition: "applied", reason: "split_confirm_success",
        observation: { observationId: value.claim.token, productId: value.claim.productId, slug: value.product!.slug, url: value.product!.url,
          source: { host: "m3", instanceId: "m3-maintenance", region: "kr-home" }, kind: "http", status: 200, latencyMs: 812 } } });
  });
  it("row 7 probe failure while the probe breaker is open: returned to the pool, due unchanged, nothing recorded", () => {
    const value = input({ host: "oracle-osaka-smoke", status: 403 });
    const open = breaker("oracle-osaka-smoke", { state: "open", openedAt: at(-MIN), probeAfter: at(9 * MIN), reason: "batch_ratio", ratio: 1 });
    expect(one(value, { breakers: [open] })).toMatchObject({ outcome: "returned", reason: "probe_breaker_open", health: null, raw: null,
      claim: { dueAt: value.claim.dueAt, confirmClass: null } });
  });
  it.each([[403, "http", "http:403"], [503, "http", "http:503"], [0, "timeout", "timeout:0"], [0, "dns", "dns:0"]] as const)(
    "row 8 probe failure %s/%s never counts: home confirm requested, raw_only", (status, kind, reason) => {
      const value = input({ host: "oracle-osaka-smoke", status, kind, health: { failures: 2, downSince: new Date("2026-10-18T00:00:00Z") } });
      expect(one(value)).toMatchObject({ outcome: "confirm_requested", reason: "split_confirm_required", health: null, textSample: false,
        claim: { dueAt: wall, confirmClass: "home", confirmReason: reason, confirmRequestedAt: wall, lastApplied: null },
        raw: { disposition: "raw_only", reason: "split_confirm_required", observation: { source: { host: "oracle-osaka-smoke", region: "ap-osaka-1" } } } });
    });
  it("row 9 home failure while the home breaker is open: judgement held like legacy (checked time only, due 6h), the confirm ends, observation_hold raw", () => {
    const value = input({ status: 500, claim: { confirmClass: "home", confirmReason: "http:403", confirmRequestedAt: at(-2 * MIN) } });
    const open = breaker("m3", { state: "open", openedAt: at(-MIN), probeAfter: at(9 * MIN), reason: "window_ratio", ratio: 0.5 });
    expect(one(value, { breakers: [open] })).toMatchObject({ outcome: "held", reason: "split_broad_failure", textSample: false,
      health: { kind: "held", checkedAt: at(-49_000), failures: 0, downSince: null, alive: false, latencyMs: null, status: 500 },
      claim: { dueAt: at(-49_000 + UPTIME_RECHECK_MS), confirmClass: null, confirmReason: null, confirmRequestedAt: null, lastApplied: null },
      raw: { disposition: "observation_hold", reason: "split_broad_failure" } });
  });
  it("row 9 held keeps the streak and first failure time; a new product gets a 0-failure row; at the auto-ban threshold nothing is written (15 minutes)", () => {
    const open = breaker("m3", { state: "open", openedAt: at(-MIN), probeAfter: at(9 * MIN), reason: "window_ratio", ratio: 0.5 });
    const since = new Date("2026-10-18T09:00:00Z");
    expect(one(input({ kind: "network", health: { failures: 2, downSince: since } }), { breakers: [open] }))
      .toMatchObject({ outcome: "held", health: { kind: "held", failures: 2, downSince: since, status: 0 } });
    // 제품이 바뀌어 센다면 1 로 다시 셀 실패도 보류면 그대로다(writeHealthHeld 는 연속 실패를 보지 않는다)
    expect(one(input({ status: 503, health: { failures: 9, downSince: since }, product: { updatedAt: "2026-10-18 10:00:00" } }), { breakers: [open] }))
      .toMatchObject({ health: { kind: "held", failures: 9, downSince: since } });
    expect(one(input({ status: 503, health: null }), { breakers: [open] })).toMatchObject({ health: { kind: "held", failures: 0, downSince: null, status: 503 } });
    const unbanned = input({ status: 404, health: { failures: 10, downSince: since },
      claim: { confirmClass: "home", confirmReason: "http:404", confirmRequestedAt: at(-2 * MIN) } });
    expect(one(unbanned, { breakers: [open] })).toMatchObject({ outcome: "held", reason: "split_broad_failure", health: null,
      claim: { dueAt: at(UPTIME_SPLIT_HOLD_MS), confirmClass: "home" }, raw: { disposition: "observation_hold" } });
  });
  it("row 9 home batch shaped like a broad failure (≥30, >30%): failures held, successes still applied, breaker opens", () => {
    const rows = failures("m3", 10, 30);
    const batch = decideSplitResults(rows, context());
    expect(batch.decisions.slice(0, 10).every(row => row.outcome === "held" && row.reason === "split_broad_failure"
      && row.health?.kind === "held" && row.health.failures === 0 && row.claim?.dueAt.getTime() === at(-49_000 + UPTIME_RECHECK_MS).getTime())).toBe(true);
    expect(batch.decisions.slice(10).every(row => row.outcome === "applied" && row.health?.failures === 0)).toBe(true);
    expect(batch.breakers).toEqual([{ ...closedUptimeBreaker("m3", policy), state: "open", openedAt: wall, probeAfter: at(10 * MIN),
      reason: "batch_ratio", ratio: 10 / 30 }]);
    expect(batch.windows).toEqual([{ host: "m3", bucket: wall, checks: 30, failures: 10, transport: 10 }]);
    // 9/30 = 30% 는 초과가 아니다
    expect(decideSplitResults(failures("m3", 9, 30), context()).decisions[0].outcome).toBe("applied");
  });
  it("row 10 home failure counts: +1 keeping down_since, 1 after a product change, 1 for a new product", () => {
    const since = new Date("2026-10-18T09:00:00Z");
    expect(one(input({ status: 500, health: { failures: 2, downSince: since } }))).toMatchObject({ outcome: "applied", reason: "split_counted", textSample: false,
      health: { failures: 3, downSince: since, alive: false, latencyMs: null, status: 500 },
      claim: { dueAt: at(-49_000 + UPTIME_RECHECK_MS), lastApplied: { at: wall, host: "m3" } },
      raw: { disposition: "applied", reason: "split_counted", observation: { kind: "http", status: 500 } } });
    expect(one(input({ kind: "network", health: { failures: 9, downSince: since }, product: { updatedAt: "2026-10-18 10:00:00" } })))
      .toMatchObject({ health: { failures: 1, downSince: at(-49_000), status: 0 } });
    expect(one(input({ kind: "timeout", health: null }))).toMatchObject({ health: { failures: 1, downSince: at(-49_000) } });
    expect(one(input({ status: 404, host: "mini", health: { failures: 9, downSince: since } }))).toMatchObject({ health: { failures: 10 } });
  });
  it("row 10 home confirm of an Oracle failure counts as split_confirmed and clears the confirm", () => {
    // home 이 본 403 은 알 수 없는 응답이라 세지 않는다(아래 9a) — 센 실패의 예는 503 이다
    const value = input({ status: 503, claim: { confirmClass: "home", confirmReason: "http:403", confirmRequestedAt: at(-2 * MIN) },
      health: { failures: 1, downSince: new Date("2026-10-18T21:00:00Z") } });
    expect(one(value)).toMatchObject({ outcome: "applied", reason: "split_confirmed", health: { failures: 2 },
      claim: { confirmClass: null, confirmReason: null, confirmRequestedAt: null, conflictCount: 0 },
      raw: { disposition: "applied", reason: "split_confirmed" } });
  });
  it.each([401, 403, 429, 999])("row 9a home %s is unknown like legacy: not counted nor reset, checked time and status only, no daily, due 6h", status => {
    const since = new Date("2026-10-18T09:00:00Z");
    const value = input({ status, health: { failures: 3, downSince: since } });
    expect(one(value)).toMatchObject({ outcome: "applied", reason: "split_unknown", textSample: false,
      health: { kind: "unknown", status, failures: 3, downSince: since, alive: false, latencyMs: null, checkedAt: at(-49_000) },
      claim: { dueAt: at(-49_000 + UPTIME_RECHECK_MS), confirmClass: null, conflictCount: 0, lastApplied: { at: wall, host: "m3" } },
      raw: { disposition: "applied", reason: "split_unknown",
        observation: status === 999 ? { kind: "unknown", status: 0, latencyMs: null } : { kind: "http", status } } });
    // 제품이 바뀌어도 이어 붙이거나 1 로 다시 세지 않는다(writeHealthUnknown 은 연속 실패를 보지 않는다). 새 제품은 실패 0 행
    expect(one(input({ status, health: { failures: 9, downSince: since }, product: { updatedAt: "2026-10-18 10:00:00" } })))
      .toMatchObject({ health: { kind: "unknown", failures: 9, downSince: since } });
    expect(one(input({ status, health: null }))).toMatchObject({ health: { kind: "unknown", failures: 0, downSince: null, status } });
  });
  it("row 9a home unknown on a confirm row ends the confirm without a regional conflict", () => {
    const value = input({ status: 403, claim: { confirmClass: "home", confirmReason: "timeout:0", confirmRequestedAt: at(-2 * MIN), conflictCount: 2 },
      health: { failures: 1, downSince: new Date("2026-10-18T21:00:00Z") } });
    expect(one(value)).toMatchObject({ outcome: "applied", reason: "split_unknown", health: { kind: "unknown", failures: 1 },
      claim: { confirmClass: null, confirmReason: null, confirmRequestedAt: null, conflictCount: 2, affinityHomeUntil: null } });
  });
  it("row 9a unknown counts as failure for the breaker ratio (like legacy) but is still written while real failures are held", () => {
    // 30건 중 403 7건 + 연결 실패 3건 = 10/30 > 30% → 열린다. legacy 틱 보류도 (실패 + 알 수 없음) / 확인 수로 본다
    const rows = [...Array.from({ length: 7 }, () => input({ status: 403 })), ...failures("m3", 3, 23)];
    const batch = decideSplitResults(rows, context());
    expect(batch.breakers).toEqual([expect.objectContaining({ host: "m3", state: "open", reason: "batch_ratio", ratio: 10 / 30 })]);
    expect(batch.windows).toEqual([{ host: "m3", bucket: wall, checks: 30, failures: 10, transport: 3 }]);
    expect(batch.decisions.slice(0, 7).every(row => row.reason === "split_unknown" && row.health?.kind === "unknown")).toBe(true);
    expect(batch.decisions.slice(7, 10).every(row => row.reason === "split_broad_failure" && row.health?.kind === "held")).toBe(true);
    // 403 만 9건이면 9/30 = 30% — 초과가 아니라 실패 1건을 센다
    const nine = decideSplitResults([...Array.from({ length: 8 }, () => input({ status: 403 })), ...failures("m3", 1, 22)], context());
    expect(nine.breakers[0].state).toBe("closed");
    expect(nine.decisions[8]).toMatchObject({ reason: "split_counted", health: { kind: "counted", failures: 1 } });
  });
  it.each([[401, "http", "http:401"], [429, "http", "http:429"], [0, "unknown", "unknown:0"]] as const)(
    "row 8 probe %s/%s (bot or login block, 999 arrives as unknown/0) is a probe failure: never counted, home confirm", (status, kind, reason) => {
      const value = input({ host: "oracle-osaka-smoke", status, kind, health: { failures: 2, downSince: new Date("2026-10-18T00:00:00Z") } });
      expect(one(value)).toMatchObject({ outcome: "confirm_requested", reason: "split_confirm_required", health: null,
        claim: { confirmClass: "home", confirmReason: reason } });
    });
  it("Oracle-only blocks never hide: four 6h cycles of Oracle 403 + home success leave failures at 0", () => {
    let health: UptimeHealthSnapshot = { checkedAt: new Date("2026-10-18T00:00:00Z"), failures: 0, downSince: null };
    for (let cycle = 0; cycle < 4; cycle++) {
      const base = new Date(health.checkedAt.getTime() + UPTIME_RECHECK_MS + MIN), cycleWall = new Date(base.getTime() + 2 * MIN);
      const probe = input({ host: "oracle-osaka-smoke", status: 403, health, claim: { claimedAt: base },
        result: { startedAt: base, observedAt: new Date(base.getTime() + 1000) } });
      expect(decideSplitResults([probe], context({ wall: cycleWall })).decisions[0]).toMatchObject({ outcome: "confirm_requested", health: null });
      const confirm = input({ health, claim: { confirmClass: "home", confirmReason: "http:403", confirmRequestedAt: cycleWall, claimedAt: cycleWall },
        result: { startedAt: cycleWall, observedAt: new Date(cycleWall.getTime() + 1000) } });
      const applied = decideSplitResults([confirm], context({ wall: new Date(cycleWall.getTime() + 5000) })).decisions[0];
      expect(applied).toMatchObject({ reason: "split_confirm_success", health: { failures: 0 } });
      health = { checkedAt: applied.health!.checkedAt, failures: applied.health!.failures, downSince: applied.health!.downSince };
    }
  });
  it("both hosts open: no failure from any host counts", () => {
    const open = (host: UptimeHost) => breaker(host, { state: "open", openedAt: at(-MIN), probeAfter: at(9 * MIN), reason: "batch_ratio", ratio: 1 });
    const batch = decideSplitResults([input({ status: 500 }), input({ host: "oracle-osaka-smoke", status: 500 })],
      context({ breakers: [open("m3"), open("oracle-osaka-smoke")] }));
    expect(batch.decisions.map(row => [row.outcome, row.health?.kind ?? null, row.health?.failures ?? null])).toEqual([["held", "held", 0], ["returned", null, null]]);
  });
  it("rejects a duplicate product and malformed results instead of guessing", () => {
    const value = input();
    expect(() => decideSplitResults([value, value], context())).toThrow("uptime_split_duplicate_product");
    expect(() => one(input({ kind: "http", status: 0 }))).toThrow("uptime_split_input_invalid");
    expect(() => one(input({ kind: "timeout", status: 504 }))).toThrow("uptime_split_input_invalid");
    expect(() => one(input({ result: { latencyMs: -1 } }))).toThrow("uptime_split_input_invalid");
    expect(() => one(input({ product: { id: 999_999 } }))).toThrow("uptime_split_input_invalid");
    expect(() => one(input(), { wall: new Date(Number.NaN) })).toThrow("uptime_split_input_invalid");
  });
  it("keeps input order and leaves the inputs unchanged", () => {
    const rows = [input({ status: 500 }), input({ host: "oracle-osaka-smoke", status: 403 }), input({ product: null }), input()];
    const before = structuredClone(rows);
    expect(decideSplitResults(rows, context()).decisions.map(row => row.productId)).toEqual(rows.map(row => row.claim.productId));
    expect(rows).toEqual(before);
  });
});

describe("host breaker — open·probe·close", () => {
  it("opens on the 10-minute window ratio (≥ minChecks, > 8%) and holds this batch's home failures", () => {
    const rows = failures("m3", 10, 20);
    const batch = decideSplitResults(rows, context({ windows: { m3: { checks: 190, failures: 10, transport: 3 } } }));
    expect(batch.breakers[0]).toMatchObject({ state: "open", reason: "window_ratio", ratio: 20 / 210, probeAfter: at(10 * MIN) });
    expect(batch.decisions.filter(row => row.outcome === "held")).toHaveLength(10);
    // 창이 minChecks 에 못 미치면 비율이 높아도 열지 않는다(묶음 규칙만 남는다)
    const thin = decideSplitResults(failures("m3", 10, 20), context({ windows: { m3: { checks: 100, failures: 30, transport: 0 } } }));
    expect(thin.breakers[0].state).toBe("closed");
    expect(thin.decisions.filter(row => row.outcome === "applied" && row.health?.failures === 1)).toHaveLength(10);
  });
  it("Oracle broad failure opens the probe breaker without a confirm flood", () => {
    const batch = decideSplitResults(failures("oracle-osaka-smoke", 40, 40), context());
    expect(batch.decisions.every(row => row.outcome === "returned" && row.raw === null)).toBe(true);
    expect(batch.breakers).toEqual([expect.objectContaining({ host: "oracle-osaka-smoke", state: "open", reason: "batch_ratio", ratio: 1 })]);
  });
  it("open → probing only after probe_after; claims allowed only up to probeSize", () => {
    const open = breaker("m3", { state: "open", openedAt: at(-10 * MIN), probeAfter: at(1), reason: "batch_ratio", ratio: 1 });
    expect(advanceUptimeBreaker(open, wall)).toBe(open);
    expect(uptimeClaimAllowance(open, policy, { requested: 150, inFlight: 0 })).toBe(0);
    const probing = advanceUptimeBreaker(open, at(1));
    expect(probing).toEqual({ ...open, state: "probing", probeChecks: 0, probeFailures: 0 });
    expect(uptimeClaimAllowance(probing, policy, { requested: 150, inFlight: 12 })).toBe(18);
    expect(uptimeClaimAllowance({ ...probing, probeChecks: 25 }, policy, { requested: 150, inFlight: 12 })).toBe(0);
    expect(uptimeClaimAllowance(closedUptimeBreaker("m3", policy), policy, { requested: 150, inFlight: 99 })).toBe(150);
  });
  it("probing closes after probeSize checks with ≤5% failures and resets the cool-down", () => {
    const probing = breaker("m3", { state: "probing", openedAt: at(-20 * MIN), probeAfter: at(-MIN), coolDownMs: 40 * MIN, reason: "probe_ratio", ratio: 0.5 });
    const rows = failures("m3", 1, 30).map(row => ({ ...row, claim: { ...row.claim, claimedAt: at(-50_000) },
      result: { ...row.result, startedAt: at(-45_000), observedAt: at(-44_000) } }));
    const batch = decideSplitResults(rows, context({ breakers: [probing] }));
    expect(batch.breakers[0]).toEqual({ ...probing, state: "closed", probeAfter: null, coolDownMs: 10 * MIN, reason: null, ratio: 1 / 30,
      probeChecks: 0, probeFailures: 0 });
    // probing 중 home 실패는 세지 않는다(닫히는 묶음이라도)
    expect(batch.decisions[0]).toMatchObject({ outcome: "held", reason: "split_broad_failure" });
  });
  it("probing re-opens as soon as the close ratio cannot hold, doubling the cool-down up to the maximum", () => {
    const probing = breaker("oracle-osaka-smoke", { state: "probing", openedAt: at(-20 * MIN), probeAfter: at(-MIN), coolDownMs: 10 * MIN, reason: "batch_ratio", ratio: 1 });
    const rows = failures("oracle-osaka-smoke", 2, 5).map(row => ({ ...row, claim: { ...row.claim, claimedAt: at(-50_000) },
      result: { ...row.result, startedAt: at(-45_000), observedAt: at(-44_000) } }));
    const batch = decideSplitResults(rows, context({ breakers: [probing] }));
    // opened_at 은 이번 열림 구간의 시작 그대로다(오래 열림 경보가 처음 연 시각부터 잰다)
    expect(batch.breakers[0]).toEqual({ ...probing, state: "open", openedAt: at(-20 * MIN), probeAfter: at(20 * MIN), coolDownMs: 20 * MIN,
      reason: "probe_ratio", ratio: 2 / 5, probeChecks: 0, probeFailures: 0 });
    expect(batch.decisions.slice(0, 2).every(row => row.outcome === "returned")).toBe(true);
    const capped = settleUptimeBreaker({ ...probing, coolDownMs: 40 * MIN }, policy,
      { window: { checks: 0, failures: 0, transport: 0 }, batch: { checks: 2, failures: 2, transport: 2 }, probe: { checks: 2, failures: 2, transport: 2 } }, wall);
    expect(capped).toMatchObject({ state: "open", coolDownMs: 60 * MIN, probeAfter: at(60 * MIN) });
  });
  it("probing keeps counting below probeSize and ignores results claimed before probing began", () => {
    const probing = breaker("m3", { state: "probing", openedAt: at(-20 * MIN), probeAfter: at(-MIN), reason: "batch_ratio", ratio: 1, probeChecks: 5 });
    const fresh = Array.from({ length: 10 }, () => input({ claim: { claimedAt: at(-50_000) },
      result: { startedAt: at(-45_000), observedAt: at(-44_000) } }));
    const straggler = input({ kind: "timeout", claim: { claimedAt: at(-2 * MIN) }, result: { startedAt: at(-110_000), observedAt: at(-100_000) } });
    const batch = decideSplitResults([...fresh, straggler], context({ breakers: [probing] }));
    expect(batch.breakers[0]).toMatchObject({ state: "probing", probeChecks: 15, probeFailures: 0 });
    expect(batch.decisions.at(-1)).toMatchObject({ outcome: "held", reason: "split_broad_failure" });
    expect(batch.windows).toEqual([{ host: "m3", bucket: wall, checks: 11, failures: 1, transport: 1 }]);
  });
  it("advances an untouched open breaker to probing on the apply tick even without results", () => {
    const open = breaker("oracle-osaka-smoke", { state: "open", openedAt: at(-11 * MIN), probeAfter: at(-MIN), reason: "batch_ratio", ratio: 1 });
    expect(decideSplitResults([], context({ breakers: [open] })).breakers).toEqual([{ ...open, state: "probing" }]);
  });
});

describe("0103 migration text", () => {
  const migration = readFileSync("drizzle/0103_uptime_split.sql", "utf8").replace(/--(?!> statement-breakpoint).*$/gm, "");
  it("adds tables only; the one existing-table change is the uptime_control guard trigger, then the products FK last", () => {
    expect([...migration.matchAll(/CREATE TABLE (\w+)/g)].map(match => match[1])).toEqual(["uptime_split_control", "uptime_claims", "uptime_host_windows", "uptime_host_breakers"]);
    expect([...migration.matchAll(/ALTER TABLE (\w+)/g)].map(match => match[1])).toEqual(["uptime_claims"]);
    expect([...migration.matchAll(/CREATE TRIGGER \w+ BEFORE INSERT OR UPDATE ON (\w+)/g)].map(match => match[1])).toEqual(["uptime_split_control", "uptime_control"]);
    expect(migration).not.toMatch(/\b(GRANT|REVOKE|DROP|TRUNCATE|ADD COLUMN|ALTER COLUMN)\b|\bUPDATE (?!ON|OR)/);
    expect([...migration.matchAll(/(?:INSERT INTO|DELETE FROM) (\w+)/g)].map(match => match[1])).toEqual(["uptime_split_control", "uptime_claims", "uptime_claims"]);
    // 외래 키는 백필·색인 뒤 마지막에 건다(products 쓰기를 막는 구간을 짧게)
    const statements = migration.split("--> statement-breakpoint").map(part => part.trim());
    expect(statements.slice(-3).map(statement => statement.split(" ").slice(0, 3).join(" "))).toEqual(["LOCK TABLE products", "DELETE FROM uptime_claims", "ALTER TABLE uptime_claims"]);
  });
  it("is journal entry 103 strictly after 0102", () => {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.find(entry => entry.tag === "0103_uptime_split")).toEqual({ idx: 103, version: "7", when: 1794086400015, tag: "0103_uptime_split", breakpoints: true });
  });
});

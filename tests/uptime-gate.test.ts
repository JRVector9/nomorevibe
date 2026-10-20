import { describe, expect, it } from "vitest";
import type { UptimeSource } from "@/lib/domain/products/uptime-policy";
import { formatUptimeGateError, parseUptimeGateArgs, planUptimeTransition, shadowEvaluateUptimeGate, uptimeGateDatabaseUrl,
  uptimeRollbackTarget, type UptimeGateSnapshot, type UptimeShadowRow } from "@/lib/operations/uptime-gate";

const m3: UptimeSource = { host: "m3", instanceId: "m3-maintenance", region: "primary-region" };
const mini: UptimeSource = { host: "mini", instanceId: "mini-maintenance-standby", region: "primary-region" };
const oracle: UptimeSource = { host: "oracle-osaka-smoke", instanceId: "oracle-product-health", region: "ap-osaka-1" };
const NOW = "2026-10-17T12:10:00.000Z";
const SLOTS = ["2026-10-16T06:00:00.000Z", "2026-10-16T12:00:00.000Z", "2026-10-16T18:00:00.000Z",
  "2026-10-17T00:00:00.000Z", "2026-10-17T06:00:00.000Z", "2026-10-17T12:00:00.000Z"];
const host = (source: UptimeSource, total: number, configured = true) => ({ ...source, configured, total, positive: total - 1, negative: 1,
  dispositions: { applied: total, raw_only: 0, observation_hold: 0, stale: 0 },
  firstObservedAt: "2026-10-16T06:00:00.000Z", lastObservedAt: "2026-10-17T12:05:00.000Z" });

function snapshot(change: (value: UptimeGateSnapshot) => void = () => {}): UptimeGateSnapshot {
  const value: UptimeGateSnapshot = {
    now: NOW, control: { observationsEnabled: true, gateEnabled: false, revision: 7, sources: [m3, mini, oracle] },
    window: { from: "2026-10-15T12:10:00.000Z", to: NOW },
    observations: { total: 5000, firstObservedAt: "2026-10-16T06:00:00.000Z", lastObservedAt: "2026-10-17T12:05:00.000Z", slots: [...SLOTS] },
    hosts: [host(m3, 4000), host(oracle, 1000)], holdReasons: {}, runners: ["m3-maintenance", "mini-maintenance-standby"],
    gates: { admitted: 0, held: 0, heldReasons: {}, due: 0, currentRevision: 0 }, impact: { hiddenNow: 12, banEligibleNow: 3 },
    shadow: { negatives: 200, held: 40, admitted: 160, reasons: { independent_evidence_missing: 40 }, holdRatio: 0.2 },
  };
  change(value);
  return value;
}

describe("gate transition requires raw canary evidence", () => {
  it("allows the gate after a fresh, continuous, two-region canary with a bounded shadow hold ratio", () => {
    expect(planUptimeTransition("gate", snapshot())).toEqual({ target: "gate", from: "raw-only", allowed: true, blocked: [],
      next: { observationsEnabled: true, gateEnabled: true, sources: [m3, mini, oracle] } });
  });
  it.each<[string, (value: UptimeGateSnapshot) => void, string]>([
    ["disabled", value => { value.control.observationsEnabled = false; }, "uptime_gate_requires_raw_only"],
    ["already gated", value => { value.control.gateEnabled = true; }, "uptime_gate_requires_raw_only"],
    ["no raw facts", value => { value.observations.firstObservedAt = null; value.observations.lastObservedAt = null; }, "uptime_canary_missing"],
    ["23h canary", value => { value.observations.firstObservedAt = "2026-10-16T13:10:00.001Z"; }, "uptime_canary_too_short"],
    ["slot gap", value => { value.observations.slots = SLOTS.filter(slot => slot !== "2026-10-17T00:00:00.000Z"); }, "uptime_canary_slot_gap"],
    ["stale facts", value => { value.observations.lastObservedAt = "2026-10-17T11:39:59.999Z"; }, "uptime_observations_stale"],
    ["one region", value => { value.hosts = [host(m3, 4000), host(mini, 10)]; }, "uptime_region_coverage_insufficient"],
    ["unconfigured region", value => { value.hosts = [host(m3, 4000), host(oracle, 1000, false)]; }, "uptime_region_coverage_insufficient"],
    ["no shadow", value => { value.shadow = null; }, "uptime_shadow_evidence_insufficient"],
    ["thin shadow", value => { value.shadow = { ...value.shadow!, negatives: 99, held: 0, admitted: 99, holdRatio: 0 }; }, "uptime_shadow_evidence_insufficient"],
    ["high hold", value => { value.shadow = { ...value.shadow!, held: 102, admitted: 98, holdRatio: 0.51 }; }, "uptime_shadow_hold_ratio_exceeded"],
    ["runner gap", value => { value.runners.push("m3-maintenance-2"); }, "uptime_runner_unconfigured:m3-maintenance-2"],
  ])("refuses the gate without evidence: %s", (_name, change, code) => {
    const plan = planUptimeTransition("gate", snapshot(change));
    expect(plan.allowed).toBe(false);
    expect(plan.blocked).toContain(code);
  });
  it("keeps the exact 24h, 30-minute and 50% boundaries admissible", () => {
    expect(planUptimeTransition("gate", snapshot(value => {
      value.observations.firstObservedAt = "2026-10-16T12:10:00.000Z";
      value.observations.lastObservedAt = "2026-10-17T11:40:00.000Z";
      value.shadow = { ...value.shadow!, held: 100, admitted: 100, holdRatio: 0.5 };
    })).blocked).toEqual([]);
  });
  it("freezes the canary sources while enabling the gate", () => {
    expect(planUptimeTransition("gate", snapshot(), [m3, oracle]).blocked).toContain("uptime_gate_sources_frozen");
  });
});

describe("raw-only transition validates source and runner coverage only", () => {
  const disabled = (value: UptimeGateSnapshot) => {
    value.control = { observationsEnabled: false, gateEnabled: false, revision: 1, sources: [] };
    value.observations = { total: 0, firstObservedAt: null, lastObservedAt: null, slots: [] };
    value.hosts = []; value.shadow = null;
  };
  it("starts a raw canary from disabled with configured runners", () => {
    expect(planUptimeTransition("raw-only", snapshot(disabled), [m3, mini, oracle])).toEqual({ target: "raw-only", from: "disabled",
      allowed: true, blocked: [], next: { observationsEnabled: true, gateEnabled: false, sources: [m3, mini, oracle] } });
  });
  it.each<[string, unknown, string]>([
    ["missing", undefined, "uptime_sources_missing"],
    ["duplicate host", [m3, { ...m3, instanceId: "other" }], "uptime_sources_invalid"],
    ["wrong Oracle region", [m3, mini, { ...oracle, region: "us-ashburn-1" }], "uptime_sources_invalid"],
    ["extra field", [{ ...m3, networkHealthy: true }, mini], "uptime_sources_invalid"],
    ["Oracle only", [oracle], "uptime_authoritative_source_missing"],
    ["runner gap", [m3, oracle], "uptime_runner_unconfigured:mini-maintenance-standby"],
  ])("refuses raw-only sources: %s", (_name, sources, code) => {
    const plan = planUptimeTransition("raw-only", snapshot(disabled), sources);
    expect(plan.allowed).toBe(false);
    expect(plan.blocked).toContain(code);
  });
  it("a source change in raw-only restarts the canary; an identical one is refused; gate must roll back", () => {
    expect(planUptimeTransition("raw-only", snapshot(), [m3, mini]).allowed).toBe(true);
    expect(planUptimeTransition("raw-only", snapshot(), [oracle, mini, m3]).blocked).toEqual(["uptime_no_change"]);
    expect(planUptimeTransition("raw-only", snapshot()).blocked).toEqual(["uptime_no_change"]);
    expect(planUptimeTransition("raw-only", snapshot(value => { value.control.gateEnabled = true; })).blocked).toContain("uptime_rollback_required");
  });
  it("refuses raw-only and gate while the uptime split runs in claims mode (0104 mutual exclusion)", () => {
    const claims = (value: UptimeGateSnapshot) => { disabled(value); value.split = { mode: "claims", epoch: 5 }; };
    expect(planUptimeTransition("raw-only", snapshot(claims), [m3, mini, oracle]).blocked).toEqual(["uptime_split_claims_active"]);
    expect(planUptimeTransition("gate", snapshot(value => { value.split = { mode: "claims", epoch: 5 }; })).blocked).toEqual(["uptime_split_claims_active"]);
    expect(planUptimeTransition("raw-only", snapshot(value => { disabled(value); value.split = { mode: "legacy", epoch: 5 }; }), [m3, mini, oracle]).allowed).toBe(true);
  });
  it("rolls back exactly one step toward disabled", () => {
    expect(uptimeRollbackTarget({ observationsEnabled: true, gateEnabled: true })).toEqual({ observationsEnabled: true, gateEnabled: false });
    expect(uptimeRollbackTarget({ observationsEnabled: true, gateEnabled: false })).toEqual({ observationsEnabled: false, gateEnabled: false });
    expect(uptimeRollbackTarget({ observationsEnabled: false, gateEnabled: false })).toBeNull();
  });
});

describe("shadow evaluation replays regional-v1 on raw facts", () => {
  const at = new Date("2026-10-17T12:00:00.000Z");
  let id = 0;
  const row = (source: UptimeSource, status: number, minutesBefore: number, change: Partial<UptimeShadowRow> = {}): UptimeShadowRow => ({
    observationId: `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`, productId: 1, url: "https://one.example/", ...source,
    kind: "http", status, observedAt: new Date(at.getTime() - minutesBefore * 60_000),
    disposition: source.host === "oracle-osaka-smoke" ? "raw_only" : "applied", reason: null, ...change,
  });
  const network = (source: UptimeSource, minutesBefore = 1) => [0, 1].map(index => row(source, 200, minutesBefore,
    { productId: 100 + index, url: `https://healthy${index}.example/` }));

  it("counts held and admitted negatives by policy reason, excluding positives", () => {
    const oracle403 = row(oracle, 403, 0), m3Down = row(m3, 500, 0, { productId: 2, url: "https://two.example/" });
    const m3Regional = row(m3, 500, 0, { productId: 3, url: "https://three.example/" });
    const evidence = [...network(m3), ...network(oracle), row(oracle, 200, 10, { productId: 3, url: "https://three.example/" })];
    const result = shadowEvaluateUptimeGate([oracle403, m3Down, m3Regional], [...evidence, oracle403, m3Down, m3Regional], [m3, mini, oracle]);
    expect(result).toEqual({ negatives: 3, held: 2, admitted: 1, holdRatio: 2 / 3,
      reasons: { independent_evidence_missing: 1, regional_conflict: 1 } });
  });
  it("ignores stale, unconfigured and out-of-window evidence and minimum-interval holds", () => {
    const candidate = row(m3, 500, 0);
    const rogue = { ...m3, instanceId: "rogue" };
    const evidence = [...network(m3).map(value => ({ ...value, disposition: "stale" as const })), ...network(rogue), ...network(m3, 31)];
    const held = row(m3, 500, 0, { productId: 4, url: "https://four.example/", disposition: "observation_hold", reason: "minimum_interval" });
    expect(shadowEvaluateUptimeGate([candidate, held, row(m3, 200, 0)], evidence, [m3])).toEqual({ negatives: 1, held: 1, admitted: 0,
      holdRatio: 1, reasons: { network_evidence_missing: 1 } });
    expect(shadowEvaluateUptimeGate([], evidence, [m3])).toEqual({ negatives: 0, held: 0, admitted: 0, holdRatio: null, reasons: {} });
  });
});

describe("operator CLI contract", () => {
  it("parses read-only and dry-run-by-default write commands", () => {
    expect(parseUptimeGateArgs(["status"])).toEqual({ command: "status" });
    expect(parseUptimeGateArgs(["plan", "gate"])).toEqual({ command: "plan", target: "gate" });
    expect(parseUptimeGateArgs(["plan", "raw-only", "--sources=/tmp/sources.json"])).toEqual({ command: "plan", target: "raw-only", sourcesPath: "/tmp/sources.json" });
    expect(parseUptimeGateArgs(["apply", "gate", "--expect-revision=7", "--operator=jr"]))
      .toEqual({ command: "apply", target: "gate", expectRevision: 7, operator: "jr", apply: false });
    expect(parseUptimeGateArgs(["apply", "raw-only", "--sources=s.json", "--expect-revision=1", "--operator=jr", "--apply"]))
      .toEqual({ command: "apply", target: "raw-only", sourcesPath: "s.json", expectRevision: 1, operator: "jr", apply: true });
    expect(parseUptimeGateArgs(["rollback", "--expect-revision=8", "--operator=jr"])).toEqual({ command: "rollback", expectRevision: 8, operator: "jr", apply: false });
  });
  it.each<[string[], string]>([
    [[], "uptime_gate_unknown_command"], [["apply"], "uptime_gate_unknown_target"], [["plan", "disabled"], "uptime_gate_unknown_target"],
    [["status", "--apply"], "uptime_gate_unknown_option"], [["plan", "gate", "--sources=s.json"], "uptime_gate_unknown_option"],
    [["apply", "gate", "--operator=jr"], "uptime_gate_missing_expect_revision"], [["apply", "gate", "--expect-revision=7"], "uptime_gate_missing_operator"],
    [["rollback", "--expect-revision=0", "--operator=jr"], "uptime_gate_invalid_expect_revision"],
    [["rollback", "--expect-revision=1.5", "--operator=jr"], "uptime_gate_invalid_expect_revision"],
    [["rollback", "--expect-revision=7", "--operator=j r"], "uptime_gate_invalid_operator"],
    [["rollback", "--expect-revision=7", "--operator=jr", "--apply=1"], "uptime_gate_invalid_option"],
    [["rollback", "--expect-revision=7", "--expect-revision=8", "--operator=jr"], "uptime_gate_duplicate_option"],
    [["status", "postgres://user:secret@db.example:5432/nomorevibe"], "uptime_gate_url_argument_rejected"],
    [["plan", "raw-only", "--sources=postgres://db.example/x"], "uptime_gate_url_argument_rejected"],
  ])("rejects %j", (args, code) => {
    expect(() => parseUptimeGateArgs(args)).toThrow(code);
  });
  it("reads only the explicit database variable and rejects libpq overrides", () => {
    expect(uptimeGateDatabaseUrl({ UPTIME_GATE_DATABASE_URL: "postgres://u@127.0.0.1:5432/db" })).toBe("postgres://u@127.0.0.1:5432/db");
    expect(() => uptimeGateDatabaseUrl({ DATABASE_URL: "postgres://u@127.0.0.1:5432/db" })).toThrow("explicit_UPTIME_GATE_DATABASE_URL_required");
    for (const key of ["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS"]) {
      expect(() => uptimeGateDatabaseUrl({ UPTIME_GATE_DATABASE_URL: "postgres://u@127.0.0.1:5432/db", [key]: "x" })).toThrow("database_override_rejected");
    }
  });
  it("prints only fixed error codes", () => {
    expect(formatUptimeGateError(new Error("uptime_control_revision_conflict"))).toBe("uptime_control_revision_conflict");
    expect(formatUptimeGateError(new Error("connect ECONNREFUSED postgres://u:secret@db:5432/x"))).toBe("uptime_gate_failed");
    expect(formatUptimeGateError("boom")).toBe("uptime_gate_failed");
  });
});

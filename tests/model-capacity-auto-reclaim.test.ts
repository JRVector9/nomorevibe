import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock("@/lib/operations/dr/reclaim", () => ({ releaseEvidencedDispatches: mocks.release }));
import { AUTO_RECLAIM_SKEW_MS, autoReclaimLatestReleaseMs, autoReclaimPolicies, type AutoReclaimDeclaration } from "@/lib/operations/model-capacity-auto-reclaim";
import { judgeModelReclaim, type ProcessGroupEvent } from "@/lib/operations/dr/call-drain";
import { REVIEW_GATEWAY_LADDER } from "@/lib/llm/deadline-ladder";
import { reclaimEvidencedModelCapacity } from "@/lib/jobs/model-capacity-reclaim";

const supa: AutoReclaimDeclaration = { providerBudgetId: "supa", ladder: REVIEW_GATEWAY_LADDER,
  generation: { maxOutputTokens: 3_000, minDecodeTokensPerSec: 100, maxPrefillMs: 5_000 }, reference: "docs/operations/2026-10-28-deadline-ladder.md#supa" };
const ctx = () => ({ log: vi.fn() }) as unknown as Parameters<typeof reclaimEvidencedModelCapacity>[0];

beforeEach(() => { mocks.release.mockReset(); mocks.release.mockResolvedValue({ rows: [] }); });
afterEach(() => { vi.unstubAllEnvs(); });

it("turns a verified ladder into a provider_bound policy with the outermost inner bound as hard deadline", () => {
  const { policies, rejected } = autoReclaimPolicies(JSON.stringify([supa]));
  expect(rejected).toEqual([]);
  expect(policies.get("supa")).toEqual({ termination: "provider_bound", hardDeadlineMs: 50_000, skewBoundMs: AUTO_RECLAIM_SKEW_MS, reference: supa.reference });
  // Latest automatic release after the client gave up stays inside the 5-minute requirement.
  expect(autoReclaimLatestReleaseMs(supa)).toBeLessThanOrEqual(5 * 60_000);
});

it("declares nothing by default and refuses inverted ladders, unbounded generation, duplicates and bad JSON", () => {
  expect(autoReclaimPolicies(undefined).policies.size).toBe(0);
  expect(autoReclaimPolicies("").policies.size).toBe(0);
  const cases: [unknown, string][] = [
    [[{ ...supa, ladder: { engineMs: 45_000, relayMs: null, gatewayMs: 600_000, clientMs: 60_000 } }], "deadline_order_inverted"],
    [[{ ...supa, generation: { maxOutputTokens: 8_000, minDecodeTokensPerSec: 20, maxPrefillMs: 5_000 } }], "generation_exceeds_engine_bound"],
    [[supa, supa], "duplicate_budget"],
    [[{ ...supa, extra: true }], "invalid_declaration"],
  ];
  for (const [value, reason] of cases) {
    const result = autoReclaimPolicies(JSON.stringify(value));
    expect(result.rejected.map(row => row.reason)).toContain(reason);
    expect(result.policies.size).toBe(0); // partly wrong declarations are not used at all
  }
  expect(autoReclaimPolicies("{").rejected).toEqual([{ index: -1, providerBudgetId: null, reason: "invalid_json" }]);
});

it("drills through the existing judgement: timeout/connection-drop, owner replacement, and no evidence (no TTL)", () => {
  const policy = autoReclaimPolicies(JSON.stringify([supa])).policies.get("supa")!;
  const T0 = Date.parse("2026-10-28T00:00:00.000Z"), boot = "0a6bd6a3-6c2a-4f6e-9a39-2d6f7b0e5c21";
  const owner = { instanceId: "m3-reviewer", bootId: boot }, runId = "6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11";
  const dispatchAtMs = T0 + 1_000, base = { state: "indeterminate" as const, dispatchAtMs, bindingHash: null, owner };
  // Client timeout or dropped connection: the owner records its local end at dispatch + client deadline.
  const localEnd = { endedAtMs: dispatchAtMs + REVIEW_GATEWAY_LADDER.clientMs, owner, bindingHash: null };
  const due = localEnd.endedAtMs + 50_000 + AUTO_RECLAIM_SKEW_MS;
  expect(judgeModelReclaim({ ...base, events: [], localEnd }, policy, due - 1).status).toBe("waiting");
  expect(judgeModelReclaim({ ...base, events: [], localEnd }, policy, due)).toMatchObject({ status: "reclaimable", evidence: "local_call_ended" });
  expect(due - dispatchAtMs).toBeLessThanOrEqual(5 * 60_000);
  // Owner replaced (process group of the old owner exited, recorded by the supervisor).
  const event = (kind: ProcessGroupEvent["kind"], seq: number, ms: number, pid: number | null = null): ProcessGroupEvent =>
    ({ kind, seq, runId: kind === "owner_opened" ? null : runId, pid, recordedAtMs: T0 + ms });
  const exited = [event("owner_opened", 0, 0), event("spawn_intent", 1, 100), event("spawned", 1, 200, 4242), event("group_exited", 1, 9_000, 4242)];
  expect(judgeModelReclaim({ ...base, state: "dispatched", events: exited, localEnd: null }, policy, T0 + 9_000 + 50_000 + AUTO_RECLAIM_SKEW_MS))
    .toMatchObject({ status: "reclaimable", evidence: "process_group_exit" });
  // Response lost without any end evidence: never released by elapsed time alone.
  expect(judgeModelReclaim({ ...base, events: [], localEnd: null }, policy, T0 + 86_400_000).status).toBe("unproven");
});

it("the maintenance job does nothing without a declaration and only touches declared budgets when declared", async () => {
  await reclaimEvidencedModelCapacity(ctx());
  expect(mocks.release).not.toHaveBeenCalled();
  vi.stubEnv("MODEL_CAPACITY_AUTO_RECLAIM", JSON.stringify([{ ...supa, ladder: { ...supa.ladder, gatewayMs: 600_000 } }]));
  expect(await reclaimEvidencedModelCapacity(ctx())).toMatchObject({ done: true, degraded: { code: "auto_reclaim_declaration_invalid" } });
  expect(mocks.release).not.toHaveBeenCalled();
  vi.stubEnv("MODEL_CAPACITY_AUTO_RECLAIM", JSON.stringify([supa]));
  vi.stubEnv("SERVICE_INSTANCE_ID", "m3-maintenance");
  mocks.release.mockResolvedValueOnce({ rows: [{ requestId: "3f0c8a52-91c4-4d1e-9a51-6b8f9d3c2e10", released: true, reason: null }] });
  expect(await reclaimEvidencedModelCapacity(ctx())).toEqual({ done: true });
  expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ operator: "auto-reclaim:m3-maintenance", onlyDeclaredBudgets: true,
    policies: new Map([["supa", expect.objectContaining({ hardDeadlineMs: 50_000 })]]) }), true);
});

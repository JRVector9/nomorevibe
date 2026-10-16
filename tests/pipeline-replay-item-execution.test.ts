import { expect, it } from "vitest";
import { itemBindingHash, type Ai1ItemBinding } from "@/lib/jobs/items/types";
import { applyReplayMixedChanges, replayMixedProjectionHashes, reduceReplayMixedCoverage } from "@/lib/operations/pipeline-replay-item-execution";

const at = "2026-10-16T01:02:03.123456Z";
function state() {
  return { kind: "pipeline-replay-combined-state", version: 1, domain: { version: 1, referenceTime: at,
    universe: [], tables: { crawl_settings: [], crawl_candidates: [], crawl_documents: [], crawl_review_attempts: [], second_reviews: [],
      agent_repository_scans: [], agent_repository_observations: [], products: [], crawl_frontier: [], jobs: [], operations_observations: [], capacity_calls: [] } },
    items: { kind: "pipeline-replay-item-state", version: 1, tables: { pipeline_stage_modes:
      ["fetch", "ai1", "ai2"].map(stage => ({ stage, mode: "legacy", draining_from: null, epoch: 1, writer_contract_version: 0, updated_at: at })), pipeline_item_leases: [] } } };
}
it("keeps global mixed ordinals and full OLD comparison while reusing both reducers", () => {
  const original = state(), stage = original.items.tables.pipeline_stage_modes[2];
  const facts = [{ ordinal: 1, table_name: "pipeline_stage_modes", operation: "UPDATE", old_row: stage, new_row: { ...stage, mode: "items", writer_contract_version: 1 } },
    { ordinal: 2, table_name: "operations_observations", operation: "INSERT", old_row: null,
      new_row: { key: "mixed-proof", value: { source: "actual" }, observed_at: at } }];
  const result = applyReplayMixedChanges(original, facts);
  expect(result.items.tables.pipeline_stage_modes.find(row => row.stage === "ai2")?.mode).toBe("items");
  expect(result.domain.tables.operations_observations).toHaveLength(1);
  expect(original.items.tables.pipeline_stage_modes[2].mode).toBe("legacy");
  expect(() => applyReplayMixedChanges(original, [facts[1], facts[0]])).toThrow("replay_mixed_ordinal_mismatch");
  expect(() => applyReplayMixedChanges(result, facts)).toThrow("item_state_old_mismatch");
});

function expiryInitial() {
  const value = applyReplayMixedChanges(state(), []);
  value.domain.referenceTime = "2001-01-01T00:00:00.000Z";
  value.domain.tables.crawl_settings = [{ id: 1, values: { firstReview: { provider: "abcllm", model: "first" } }, updated_by: null, updated_at: at }];
  const binding: Ai1ItemBinding = { stage: "ai1", candidateId: 1, inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64),
    policyHash: "c".repeat(64), promptVersion: "history", rulesVersion: "history", reviewer: { provider: "abcllm", model: "first" } };
  value.items.tables.pipeline_item_leases = [{ stage: "ai1", work_key: "ai1:1", binding, binding_hash: itemBindingHash(binding),
    owner_instance_id: "foreign-history", owner_boot_id: "00000000-0000-4000-8000-000000000001", token: "00000000-0000-4000-8000-000000000002",
    stage_epoch: 1, item_epoch: 1, lease_until: "2026-10-16T01:02:03.000001Z", created_at: at, updated_at: at }];
  const capturedAt = "2026-10-16T01:02:03.000000Z";
  return { projection: value, capturedAt, ...replayMixedProjectionHashes(value, capturedAt) };
}
it("retains an exact one-microsecond foreign item expiry boundary without promoting it to readiness", () => {
  const initial = expiryInitial(), before = structuredClone(initial);
  const result = reduceReplayMixedCoverage(initial, { transactions: [], gaps: [] }, {
    from: "2026-10-16T01:02:03.000000Z", until: "2026-10-16T01:02:03.000003Z" });
  expect(result.intervals).toHaveLength(2);
  expect(result.intervals[0].until).toBe("2026-10-16T01:02:03.000001Z");
  expect(result.intervals.every(row => row.firstReadyLower === 0 && row.secondReadyLower === 0)).toBe(true);
  expect(result.coverage).toBe("starved");
  expect(initial).toEqual(before);
});
it("keeps an explicit execution gap unknown across item expiry rather than certifying coverage", () => {
  const result = reduceReplayMixedCoverage(expiryInitial(), { transactions: [], gaps: [{
    from: "2026-10-16T01:02:03.000001Z", until: "2026-10-16T01:02:03.000002Z", reason: "unconfirmed" }] }, {
    from: "2026-10-16T01:02:03.000000Z", until: "2026-10-16T01:02:03.000003Z" });
  expect(result.coverage).toBe("missing");
  expect(result.intervals.some(row => row.status === "unknown" && row.reasons.includes("execution_gap"))).toBe(true);
});

import { expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { pipelineItemLeases, pipelineStageModes } from "@/lib/db/operations-schema";
import { itemBindingHash, type Ai1ItemBinding } from "@/lib/jobs/items/types";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { applyReplayItemStateChanges, canonicalReplayItemState, replayItemStateExpiries,
  replayItemStateHash, ReplayItemStateSchema, type ReplayItemState } from "@/lib/operations/pipeline-replay-item-state";

const at = "2026-10-16T01:02:03.123Z";
function binding(id: number): Ai1ItemBinding {
  return { stage: "ai1", candidateId: id, inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64),
    policyHash: "c".repeat(64), promptVersion: "prompt-v1", rulesVersion: "rules-v1",
    reviewer: { provider: "abcllm", model: "first-reviewer" } };
}
function item(id = 2, expiry = at): ReplayItemState["tables"]["pipeline_item_leases"][number] {
  const value = binding(id);
  return { stage: "ai1", work_key: `ai1:${id}`, binding: value, binding_hash: itemBindingHash(value),
    owner_instance_id: "foreign-worker", owner_boot_id: "00000000-0000-4000-8000-000000000001",
    token: "00000000-0000-4000-8000-000000000002", stage_epoch: 1, item_epoch: 1,
    lease_until: expiry, created_at: at, updated_at: at };
}
function state(items: ReturnType<typeof item>[] = []): ReplayItemState {
  return { kind: "pipeline-replay-item-state", version: 1, tables: {
    pipeline_stage_modes: (["fetch", "ai2", "ai1"] as const).map(stage => ({ stage, mode: "legacy",
      draining_from: null, epoch: 2, writer_contract_version: 0, updated_at: at })), pipeline_item_leases: items,
  } };
}

it("canonicalizes every full raw row and returns independent codepoint-sorted copies", () => {
  const input = state([item(2), item(10)]), before = structuredClone(input);
  input.tables.pipeline_stage_modes[0].updated_at = "2026-10-16 10:02:03.123000+09:00";
  before.tables.pipeline_stage_modes[0].updated_at = input.tables.pipeline_stage_modes[0].updated_at;
  const result = canonicalReplayItemState(input);
  expect(result.tables.pipeline_stage_modes.map(row => row.stage)).toEqual(["ai1", "ai2", "fetch"]);
  expect(result.tables.pipeline_item_leases.map(row => row.work_key)).toEqual(["ai1:10", "ai1:2"]);
  expect(result.tables.pipeline_stage_modes[2].updated_at).toBe(at);
  expect(input).toEqual(before);
  const copiedBinding = result.tables.pipeline_item_leases[0].binding;
  if (copiedBinding.stage !== "ai1") throw new Error("unexpected fixture binding");
  copiedBinding.reviewer.model = "changed-copy";
  expect(input).toEqual(before);
  expect(Object.keys(result.tables.pipeline_stage_modes[0]).sort()).toEqual(Object.values(getTableColumns(pipelineStageModes)).map(column => column.name).sort());
  expect(Object.keys(result.tables.pipeline_item_leases[0]).sort()).toEqual(Object.values(getTableColumns(pipelineItemLeases)).map(column => column.name).sort());
});

it("hashes the entire canonical payload including microsecond and original ownership facts", () => {
  const original = state([item()]), reordered = structuredClone(original);
  reordered.tables.pipeline_stage_modes.reverse();
  reordered.tables.pipeline_item_leases[0].updated_at = "2026-10-15T18:02:03.123000-07:00";
  expect(replayItemStateHash(reordered)).toBe(replayItemStateHash(original));
  expect(replayItemStateHash(original)).toBe(reviewHash(canonicalReplayItemState(original)));
  for (const changed of [
    { ...item(), updated_at: "2026-10-16T01:02:03.123001Z" },
    { ...item(), token: "00000000-0000-4000-8000-000000000003" },
    { ...item(), stage_epoch: 2 },
  ]) expect(replayItemStateHash(state([changed]))).not.toBe(replayItemStateHash(original));
});

it("applies full INSERT, UPDATE and DELETE facts without modifying the original state or facts", () => {
  const initial = state(), inserted = item(), next = { ...inserted, lease_until: "2026-10-16T01:03:03.123001Z" };
  const facts = [
    { table_name: "pipeline_item_leases", operation: "INSERT", old_row: null, new_row: inserted, ordinal: 1 },
    { table_name: "pipeline_item_leases", operation: "UPDATE", old_row: inserted, new_row: next, ordinal: 2 },
  ];
  const before = structuredClone({ initial, facts });
  expect(applyReplayItemStateChanges(initial, facts).tables.pipeline_item_leases).toEqual([next]);
  expect(applyReplayItemStateChanges(initial, [...facts,
    { table_name: "pipeline_item_leases", operation: "DELETE", old_row: next, new_row: null, ordinal: 3 }]))
    .toEqual(canonicalReplayItemState(initial));
  expect({ initial, facts }).toEqual(before);
});

it("returns exact sorted unique expiry instants for active foreign and stale rows only", () => {
  const released = { ...item(5), owner_instance_id: null, owner_boot_id: null, token: null, lease_until: null, item_epoch: 0 };
  const input = state([item(2, "2026-10-16T01:02:03.123002Z"), item(3, "2026-10-16T10:02:03.123001+09:00"),
    item(4, "2026-10-16T01:02:03.123001Z"), released, item(6, "2020-01-01T00:00:00Z")]);
  expect(replayItemStateExpiries(input)).toEqual(["2020-01-01T00:00:00.000Z",
    "2026-10-16T01:02:03.123001Z", "2026-10-16T01:02:03.123002Z"]);
});

it("reports invalid nested binding refinements through safeParse without throwing", () => {
  const invalid = state([item()]), row = invalid.tables.pipeline_item_leases[0];
  row.stage = "ai2"; row.work_key = "ai2:2";
  row.binding = { ...binding(2), stage: "ai2", secondReviewId: 2,
    source: { kind: "first_attempt", firstAttemptId: 3 }, generationKey: "d".repeat(64), vote: 99, fallbackForId: null };
  expect(ReplayItemStateSchema.safeParse(invalid).success).toBe(false);
});

import { expect, it } from "vitest";
import type postgres from "postgres";
import { itemBindingHash, type Ai1ItemBinding } from "@/lib/jobs/items/types";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import type { ReplayItemState } from "@/lib/operations/pipeline-replay-item-state";
import { captureReplayItemState } from "@/lib/operations/pipeline-replay-item-capture";

const utc = "2026-10-16T01:02:03.123001Z";
const rawAt = "2026-10-16 10:02:03.123001+09:00";
function binding(id: number): Ai1ItemBinding {
  return { stage: "ai1", candidateId: id, inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64),
    policyHash: "c".repeat(64), promptVersion: "prompt-v1", rulesVersion: "rules-v1",
    reviewer: { provider: "abcllm", model: "first-reviewer" } };
}
function item(id: number): ReplayItemState["tables"]["pipeline_item_leases"][number] {
  const value = binding(id);
  return { stage: "ai1", work_key: `ai1:${id}`, binding: value, binding_hash: itemBindingHash(value),
    owner_instance_id: "foreign-worker", owner_boot_id: "00000000-0000-4000-8000-000000000001",
    token: "00000000-0000-4000-8000-000000000002", stage_epoch: 1, item_epoch: 4,
    lease_until: rawAt, created_at: rawAt, updated_at: rawAt };
}
function payload(items = [item(2), item(10)]): ReplayItemState {
  return { kind: "pipeline-replay-item-state", version: 1, tables: {
    pipeline_stage_modes: (["fetch", "ai2", "ai1"] as const).map(stage => ({ stage, mode: "legacy",
      draining_from: null, epoch: 2, writer_contract_version: 0, updated_at: rawAt })),
    pipeline_item_leases: items,
  } };
}
function expected(items = [item(10), item(2)]): ReplayItemState {
  return { kind: "pipeline-replay-item-state", version: 1, tables: {
    pipeline_stage_modes: (["ai1", "ai2", "fetch"] as const).map(stage => ({ stage, mode: "legacy",
      draining_from: null, epoch: 2, writer_contract_version: 0, updated_at: utc })),
    pipeline_item_leases: items.map(row => ({ ...row, lease_until: utc, created_at: utc, updated_at: utc })),
  } };
}
// This boundary double supplies raw SQL rows only; it issues no item authority.
function sqlRows(rows: unknown[] | Error) {
  const statements: { sql: string; parameters: unknown[] }[] = [];
  const tx = (async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    statements.push({ sql: strings.join("?"), parameters });
    if (rows instanceof Error) throw rows;
    return rows;
  }) as unknown as postgres.TransactionSql;
  return { tx, statements };
}

it("returns the entire canonical state from one parameter-free SELECT", async () => {
  const input = payload(), before = structuredClone(input), db = sqlRows([{ state: input }]);
  const captured = await captureReplayItemState(db.tx);
  expect(captured.state).toEqual(expected());
  expect(input).toEqual(before);
  expect(db.statements).toHaveLength(1);
  expect(db.statements[0].parameters).toEqual([]);
  expect(db.statements[0].sql).toContain("public.pipeline_stage_modes");
  expect(db.statements[0].sql).toContain("public.pipeline_item_leases");
});

it("hashes all canonical state fields rather than raw timestamp spellings or row order", async () => {
  const input = payload(), result = await captureReplayItemState(sqlRows([{ state: input }]).tx);
  expect(result.stateHash).toBe(reviewHash(expected()));
  const equivalent = expected();
  equivalent.tables.pipeline_stage_modes.reverse();
  equivalent.tables.pipeline_item_leases.reverse();
  expect((await captureReplayItemState(sqlRows([{ state: equivalent }]).tx)).stateHash).toBe(result.stateHash);
  const changed = payload();
  changed.tables.pipeline_item_leases[0].token = "00000000-0000-4000-8000-000000000003";
  expect((await captureReplayItemState(sqlRows([{ state: changed }]).tx)).stateHash).not.toBe(result.stateHash);
});

it("captures an empty item universe with all three canonical stage rows", async () => {
  expect(await captureReplayItemState(sqlRows([{ state: payload([]) }]).tx))
    .toEqual({ state: expected([]), stateHash: reviewHash(expected([])) });
});

it("returns independent nested bindings without changing caller-owned raw rows", async () => {
  const input = payload(), before = structuredClone(input);
  const captured = await captureReplayItemState(sqlRows([{ state: input }]).tx);
  const copied = captured.state.tables.pipeline_item_leases[0].binding;
  if (copied.stage !== "ai1") throw new Error("unexpected fixture binding");
  copied.reviewer.model = "changed-copy";
  captured.state.tables.pipeline_stage_modes[0].epoch = 99;
  expect(input).toEqual(before);
});

it("rejects unknown or missing full-row columns through the strict state parser", async () => {
  const unknown = payload(), missing = payload();
  Object.assign(unknown.tables.pipeline_stage_modes[0], { unknown_column: true });
  Reflect.deleteProperty(missing.tables.pipeline_item_leases[0], "binding_hash");
  await expect(captureReplayItemState(sqlRows([{ state: unknown }]).tx)).rejects.toThrow();
  await expect(captureReplayItemState(sqlRows([{ state: missing }]).tx)).rejects.toThrow();
});

it("preserves the original SQL cancellation error and fails closed on missing result rows", async () => {
  const cancelled = Object.assign(new Error("canceling statement due to user request"), { code: "57014" });
  await expect(captureReplayItemState(sqlRows(cancelled).tx)).rejects.toBe(cancelled);
  await expect(captureReplayItemState(sqlRows([]).tx)).rejects.toThrow();
  await expect(captureReplayItemState(sqlRows([{ state: null }]).tx)).rejects.toThrow();
});

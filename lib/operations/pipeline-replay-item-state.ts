import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { itemBindingHash, itemBindingSchema, itemOwnerSchema, itemStageModeSchema, itemStageSchema,
  itemWorkKey } from "@/lib/jobs/items/types";

const positive = z.number().int().positive().safe();
const thousand = BigInt(1_000);
/** Date checks the local calendar/milliseconds only. Sub-millisecond arithmetic
 * and ordering stay in BigInt, including instants before the Unix epoch. */
function timestampValue(value: string): { canonical: string; microseconds: bigint } | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59
    || Number(match[8] ?? 0) > 23 || Number(match[9] ?? 0) > 59) return;
  const fraction = (match[5] ?? "").padEnd(6, "0");
  const localText = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${fraction.slice(0, 3)}Z`;
  const local = Date.parse(localText);
  if (!Number.isFinite(local) || new Date(local).toISOString() !== localText) return;
  const offset = (Number(match[8] ?? 0) * 60 + Number(match[9] ?? 0)) * 60_000 * (match[7] === "-" ? -1 : 1);
  const microseconds = BigInt(local - offset) * thousand + BigInt(fraction.slice(3));
  let milliseconds = microseconds / thousand, extra = microseconds % thousand;
  if (extra < BigInt(0)) { milliseconds -= BigInt(1); extra += thousand; }
  const base = new Date(Number(milliseconds)).toISOString();
  if (!/^\d{4}-/.test(base)) return;
  return { canonical: extra === BigInt(0) ? base : `${base.slice(0, -1)}${String(extra).padStart(3, "0")}Z`, microseconds };
}
const timestamp = z.string().refine(value => timestampValue(value) !== undefined, "invalid_item_state_timestamp");
const stageRow = z.object({ stage: itemStageSchema, mode: itemStageModeSchema,
  draining_from: z.enum(["legacy", "items"]).nullable(), epoch: positive,
  writer_contract_version: z.number().int().min(0).max(2_147_483_647), updated_at: timestamp }).strict()
  .refine(row => (row.mode === "draining") === (row.draining_from !== null), "invalid_item_stage_drain");
const itemRow = z.object({ stage: itemStageSchema, work_key: z.string().min(1).max(80), binding: itemBindingSchema,
  binding_hash: z.string().regex(/^[a-f0-9]{64}$/), owner_instance_id: itemOwnerSchema.shape.instanceId.nullable(),
  owner_boot_id: itemOwnerSchema.shape.bootId.nullable(), token: z.uuid().nullable(), stage_epoch: positive,
  item_epoch: z.number().int().nonnegative().safe(), lease_until: timestamp.nullable(),
  created_at: timestamp, updated_at: timestamp }).strict().superRefine((row, context) => {
  const ownership = [row.owner_instance_id, row.owner_boot_id, row.token, row.lease_until];
  if (!(ownership.every(value => value === null) || ownership.every(value => value !== null) && row.item_epoch >= 1))
    context.addIssue({ code: "custom", message: "invalid_item_state_owner" });
  // Nested refinement failures are continuable in Zod. Do not rethrow them
  // through the generic binding helpers from this schema's safeParse path.
  const binding = itemBindingSchema.safeParse(row.binding);
  if (binding.success && (row.stage !== binding.data.stage || row.work_key !== itemWorkKey(binding.data)
    || row.binding_hash !== itemBindingHash(binding.data)))
    context.addIssue({ code: "custom", message: "invalid_item_state_binding" });
});

type RawRow = z.infer<typeof stageRow> | z.infer<typeof itemRow>;
type TableName = "pipeline_stage_modes" | "pipeline_item_leases";
function rowKey(table: TableName, row: RawRow): string {
  return table === "pipeline_stage_modes" ? row.stage : JSON.stringify([row.stage, "work_key" in row ? row.work_key : undefined]);
}

/** Structural state evidence only; this schema issues no execution or domain authority. */
export const ReplayItemStateSchema = z.object({ kind: z.literal("pipeline-replay-item-state"), version: z.literal(1),
  tables: z.object({ pipeline_stage_modes: z.array(stageRow), pipeline_item_leases: z.array(itemRow) }).strict() }).strict()
  .superRefine((value, context) => {
    const stages = value.tables.pipeline_stage_modes;
    if (stages.length !== 3 || new Set(stages.map(row => row.stage)).size !== 3)
      context.addIssue({ code: "custom", message: "invalid_item_state_stage_universe" });
    const items = value.tables.pipeline_item_leases;
    if (new Set(items.map(row => rowKey("pipeline_item_leases", row))).size !== items.length)
      context.addIssue({ code: "custom", message: "duplicate_item_state_key" });
  });
export type ReplayItemState = z.infer<typeof ReplayItemStateSchema>;
const changeFields = { operation: z.enum(["INSERT", "UPDATE", "DELETE"]), ordinal: positive };
export const ReplayItemStateChangeSchema = z.discriminatedUnion("table_name", [
  z.object({ ...changeFields, table_name: z.literal("pipeline_stage_modes"), old_row: stageRow.nullable(), new_row: stageRow.nullable() }).strict(),
  z.object({ ...changeFields, table_name: z.literal("pipeline_item_leases"), old_row: itemRow.nullable(), new_row: itemRow.nullable() }).strict(),
]).refine(change => change.operation === "INSERT" ? change.old_row === null && change.new_row !== null
  : change.operation === "DELETE" ? change.old_row !== null && change.new_row === null
    : change.old_row !== null && change.new_row !== null, "invalid_item_state_change_rows");

function normalizeRow<T extends RawRow>(row: T): T {
  // The schemas validate without rewriting the raw text. Only the canonical
  // functions normalize it; their parsed rows/bindings are independent copies.
  row.updated_at = timestampValue(row.updated_at)!.canonical;
  if ("created_at" in row) {
    row.created_at = timestampValue(row.created_at)!.canonical;
    if (row.lease_until !== null) row.lease_until = timestampValue(row.lease_until)!.canonical;
  }
  return row;
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export function canonicalReplayItemState(value: unknown): ReplayItemState {
  const state = ReplayItemStateSchema.parse(value);
  state.tables.pipeline_stage_modes = state.tables.pipeline_stage_modes.map(normalizeRow).sort((a, b) => compare(a.stage, b.stage));
  state.tables.pipeline_item_leases = state.tables.pipeline_item_leases.map(normalizeRow)
    .sort((a, b) => compare(a.stage, b.stage) || compare(a.work_key, b.work_key));
  return state;
}
export function replayItemStateHash(value: unknown): string { return reviewHash(canonicalReplayItemState(value)); }
export function applyReplayItemStateChanges(value: unknown, changes: readonly unknown[]): ReplayItemState {
  const state = canonicalReplayItemState(value), facts = z.array(ReplayItemStateChangeSchema).parse(changes);
  for (const [index, change] of facts.entries()) {
    ensure(change.ordinal === index + 1, "invalid_item_state_change_ordinal");
    const old = change.old_row === null ? null : normalizeRow(change.old_row);
    const next = change.new_row === null ? null : normalizeRow(change.new_row);
    const key = rowKey(change.table_name, old ?? next!);
    ensure(!old || !next || key === rowKey(change.table_name, next), "item_state_update_key_changed");
    const rows: RawRow[] = state.tables[change.table_name];
    const position = rows.findIndex(row => rowKey(change.table_name, row) === key);
    if (change.operation === "INSERT") {
      ensure(position === -1, "item_state_insert_exists");
      rows.push(next!);
    } else {
      ensure(position !== -1 && isDeepStrictEqual(rows[position], old), "item_state_old_mismatch");
      if (change.operation === "DELETE") rows.splice(position, 1);
      else rows[position] = next!;
    }
  }
  return canonicalReplayItemState(state);
}
export function replayItemStateExpiries(value: unknown): string[] {
  const rows = canonicalReplayItemState(value).tables.pipeline_item_leases;
  return [...new Set(rows.flatMap(row => row.owner_instance_id === null ? [] : [row.lease_until!]))]
    .sort((a, b) => {
      const left = timestampValue(a)!.microseconds, right = timestampValue(b)!.microseconds;
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

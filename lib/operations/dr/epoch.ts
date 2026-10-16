import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ProductTransaction } from "@/lib/domain/products/generation";

/** 실제 DB 하나의 정체. 같은 cluster 안의 다른 DB(복원 사본)도 oid로 구별한다. */
export const identity = (max: number) => z.string().min(1).max(max)
  .refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), "invalid_identity");
export const positiveEpoch = z.number().int().min(1).max(9007199254740991);
export const isoMillis = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "invalid_timestamp");
export const dbIdentitySchema = z.object({ systemIdentifier: z.string().regex(/^[1-9][0-9]{0,19}$/),
  databaseOid: z.string().regex(/^[1-9][0-9]{0,9}$/), databaseName: identity(63) }).strict();
export type DbIdentity = Readonly<z.infer<typeof dbIdentitySchema>>;
export function sameDatabase(a: DbIdentity, b: DbIdentity): boolean {
  return a.systemIdentifier === b.systemIdentifier && a.databaseOid === b.databaseOid && a.databaseName === b.databaseName;
}

export const writerFenceSchema = z.object({ lineageId: z.uuid(), writerEpoch: positiveEpoch, state: z.enum(["active", "fenced"]),
  reason: z.enum(["operator_fence", "promotion_sealed"]).nullable(), fencedDb: dbIdentitySchema.nullable(), promotionId: z.uuid().nullable(),
}).strict().refine(value => value.state === "active" ? value.reason === null && value.fencedDb === null : value.reason !== null && value.fencedDb !== null,
  "invalid_writer_fence").refine(value => value.reason !== "promotion_sealed" || value.promotionId !== null, "invalid_writer_fence");
export type WriterFence = Readonly<z.infer<typeof writerFenceSchema>>;
/** 프로세스가 boot에 잡은 DB lineage 세대. 이것만으로 권한이 생기지 않는다(각 장부의 token은 그대로 검사). */
export const writerBindingSchema = z.object({ lineageId: z.uuid(), writerEpoch: positiveEpoch }).strict();
export type WriterBinding = Readonly<z.infer<typeof writerBindingSchema>>;
export type WriterFenceReason = "lineage_mismatch" | "epoch_stale" | "epoch_ahead" | "site_fenced";

export class DrWriterFencedError extends Error {
  constructor(readonly reason: WriterFenceReason) { super(`dr_writer_${reason}`); }
}

/** 순수 판정: 다른 lineage, 옛/앞선 epoch, fenced site는 모두 쓰기 거절이다. */
export function checkWriterBinding(fenceValue: WriterFence, bindingValue: WriterBinding): { ok: true } | { ok: false; reason: WriterFenceReason } {
  const fence = writerFenceSchema.parse(fenceValue), binding = writerBindingSchema.parse(bindingValue);
  if (fence.lineageId !== binding.lineageId) return { ok: false, reason: "lineage_mismatch" };
  if (binding.writerEpoch < fence.writerEpoch) return { ok: false, reason: "epoch_stale" };
  if (binding.writerEpoch > fence.writerEpoch) return { ok: false, reason: "epoch_ahead" };
  if (fence.state !== "active") return { ok: false, reason: "site_fenced" };
  return { ok: true };
}

/** DB clock 문자열(UTC, ms 절삭). 절삭은 barrier를 늦게 통과시키는 보수 방향이다. */
export const dbNowIso = sql`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export async function readDatabaseIdentity(tx: Pick<ProductTransaction, "execute">): Promise<DbIdentity> {
  const [row] = await tx.execute<{ system_identifier: string; database_oid: string; database_name: string }>(sql`
    SELECT (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS system_identifier,
      (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) AS database_oid, current_database() AS database_name`);
  return dbIdentitySchema.parse({ systemIdentifier: row.system_identifier, databaseOid: row.database_oid, databaseName: row.database_name });
}

type FenceRow = { lineage_id: string; writer_epoch: string | number; state: string; reason: string | null; fenced_db: unknown; promotion_id: string | null };
export function fenceFromRow(row: FenceRow | undefined): WriterFence {
  if (!row) throw new Error("dr_writer_fence_missing");
  const parsed = writerFenceSchema.safeParse({ lineageId: row.lineage_id, writerEpoch: Number(row.writer_epoch), state: row.state,
    reason: row.reason, fencedDb: row.fenced_db ?? null, promotionId: row.promotion_id });
  if (!parsed.success) throw new Error("dr_writer_fence_invalid");
  return parsed.data;
}

/** 모든 DR/writer TX의 첫 lock. 승격·fence는 같은 행을 UPDATE로 잡는다. 행이 없으면 fail-closed다. */
export async function lockWriterFence(tx: Pick<ProductTransaction, "execute">, mode: "share" | "update"): Promise<WriterFence> {
  const [row] = await tx.execute<FenceRow>(mode === "update"
    ? sql`SELECT lineage_id::text, writer_epoch, state, reason, fenced_db, promotion_id::text FROM dr_writer_fence WHERE id = 1 FOR UPDATE`
    : sql`SELECT lineage_id::text, writer_epoch, state, reason, fenced_db, promotion_id::text FROM dr_writer_fence WHERE id = 1 FOR SHARE`);
  return fenceFromRow(row);
}

/** role 선출/갱신 관문: fenced DB에서는 어떤 background writer도 역할을 얻거나 유지하지 않는다. */
export async function writerSiteActive(tx: Pick<ProductTransaction, "execute">): Promise<boolean> {
  return (await lockWriterFence(tx, "share")).state === "active";
}

export async function bindWriterFence(tx: Pick<ProductTransaction, "execute">): Promise<WriterBinding> {
  const fence = await lockWriterFence(tx, "share");
  if (fence.state !== "active") throw new DrWriterFencedError("site_fenced");
  return Object.freeze({ lineageId: fence.lineageId, writerEpoch: fence.writerEpoch });
}

/** writer 결과 TX 안에서 호출한다. 외부 호출 동안 이 TX를 열어 두지 않는다. */
export async function assertWriterFence(tx: Pick<ProductTransaction, "execute">, binding: WriterBinding): Promise<void> {
  const checked = checkWriterBinding(await lockWriterFence(tx, "share"), binding);
  if (!checked.ok) throw new DrWriterFencedError(checked.reason);
}

export const oldDbFencedPayloadSchema = z.object({ version: z.literal(1), db: dbIdentitySchema, lineageId: z.uuid(),
  writerEpoch: positiveEpoch, state: z.literal("fenced"), fencedDb: dbIdentitySchema, observedAt: isoMillis }).strict()
  .refine(value => sameDatabase(value.db, value.fencedDb), "fence_applied_elsewhere");
export type OldDbFencedPayload = Readonly<z.infer<typeof oldDbFencedPayloadSchema>>;

/** 옛 DB를 운영자가 직접 fence한다. 한 방향(active→fenced)이며 같은 DB를 다시 여는 API는 없다.
 * 이미 이 DB에서 operator_fence된 같은 lineage/epoch이면 readback만 돌려준다. */
export async function fenceWriterSite(tx: ProductTransaction, expected: { lineageId: string; writerEpoch: number; db: DbIdentity; operator: string }): Promise<OldDbFencedPayload> {
  const want = z.object({ lineageId: z.uuid(), writerEpoch: positiveEpoch, db: dbIdentitySchema, operator: identity(120) }).strict().parse(expected);
  const fence = await lockWriterFence(tx, "update"), db = await readDatabaseIdentity(tx);
  if (!sameDatabase(db, want.db)) throw new Error("dr_database_identity_mismatch");
  if (fence.lineageId !== want.lineageId || fence.writerEpoch !== want.writerEpoch) throw new Error("dr_writer_fence_expectation_mismatch");
  const already = fence.state === "fenced" && fence.reason === "operator_fence" && fence.fencedDb !== null && sameDatabase(fence.fencedDb, db);
  if (fence.state !== "active" && !already) throw new Error("dr_writer_fence_not_active");
  if (!already) {
    await tx.execute(sql`UPDATE dr_writer_fence SET state = 'fenced', reason = 'operator_fence', fenced_db = ${JSON.stringify(db)}::text::jsonb,
      updated_at = clock_timestamp() WHERE id = 1 AND state = 'active'`);
    await tx.execute(sql`INSERT INTO dr_fence_events (lineage_id, from_epoch, to_epoch, from_state, to_state, reason, db_identity, operator)
      VALUES (${fence.lineageId}::uuid, ${fence.writerEpoch}, ${fence.writerEpoch}, 'active', 'fenced', 'operator_fence', ${JSON.stringify(db)}::text::jsonb, ${want.operator})`);
  }
  const after = await lockWriterFence(tx, "update");
  const [clock] = await tx.execute<{ now: string }>(sql`SELECT ${dbNowIso} AS now`);
  if (after.state !== "fenced" || after.reason !== "operator_fence" || !after.fencedDb || !sameDatabase(after.fencedDb, db)) throw new Error("dr_writer_fence_readback_mismatch");
  return oldDbFencedPayloadSchema.parse({ version: 1, db, lineageId: after.lineageId, writerEpoch: after.writerEpoch,
    state: "fenced", fencedDb: after.fencedDb, observedAt: clock.now });
}

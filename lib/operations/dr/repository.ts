import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { dbNowIso, identity, lockWriterFence, readDatabaseIdentity, sameDatabase,
  type DbIdentity, type WriterFence } from "./epoch";
import { contentHash, evaluatePromotion, parseEvidence, promotionPlanHash, promotionPlanSchema, sealSnapshotSchema,
  EVIDENCE_KINDS, type EvidenceKind, type EvidenceRecord, type PromotionEvaluation, type PromotionPlan, type PromotionRecord } from "./promotion";
import { evaluateProcessReclaim, type ProcessGroupEvent, type ReclaimPolicy } from "./call-drain";
import { processAttestationSchema, SUCCESSOR_EXIT_METHOD, type ProcessAttestation } from "./process-attestation";

const fail = (code: string): never => { throw new Error(code); };
/** DR 쓰기는 항상 primary의 짧은 자체 TX다. replay scope에서는 열지 않는다. */
export function drTransaction<T>(load: (tx: ProductTransaction) => Promise<T>): Promise<T> {
  if (currentReplayDb()) return Promise.reject(new Error("dr_replay_unsupported"));
  return onPrimary(() => db.transaction(load));
}
/** dry-run: 같은 TX를 실제로 실행한 뒤 ROLLBACK한다. 결과는 “commit했다면”의 readback이다. */
class DryRunRollback<T> extends Error { constructor(readonly value: T) { super("dr_dry_run_rollback"); } }
export async function drTransactionMaybeDry<T>(apply: boolean, load: (tx: ProductTransaction) => Promise<T>): Promise<T> {
  try { return await drTransaction(async tx => { const value = await load(tx); if (!apply) throw new DryRunRollback(value); return value; }); }
  catch (error) { if (error instanceof DryRunRollback) return error.value as T; throw error; }
}

type PromotionRow = { promotion_id: string; plan: unknown; plan_hash: string; state: string; db_identity: unknown; seal_snapshot: unknown };
function promotionFromRow(row: PromotionRow | undefined): PromotionRecord {
  if (!row) return fail("dr_promotion_missing");
  const plan = promotionPlanSchema.parse(row.plan);
  if (promotionPlanHash(plan) !== row.plan_hash || plan.promotionId !== row.promotion_id || !["sealed", "promoted"].includes(row.state)) fail("dr_promotion_invalid");
  return { promotionId: row.promotion_id, plan, planHash: row.plan_hash, state: row.state as "sealed" | "promoted",
    dbIdentity: z.object({ systemIdentifier: z.string(), databaseOid: z.string(), databaseName: z.string() }).strict().parse(row.db_identity),
    sealSnapshot: sealSnapshotSchema.parse(row.seal_snapshot) };
}
async function lockPromotion(tx: ProductTransaction, promotionId: string): Promise<PromotionRecord> {
  const [row] = await tx.execute<PromotionRow>(sql`SELECT promotion_id::text, plan, plan_hash, state, db_identity, seal_snapshot
    FROM dr_promotions WHERE promotion_id = ${z.uuid().parse(promotionId)}::uuid FOR UPDATE`);
  return promotionFromRow(row);
}
async function readEvidence(tx: ProductTransaction, promotionId: string): Promise<EvidenceRecord[]> {
  const rows = await tx.execute<{ id: string; kind: EvidenceKind; subject: string; payload: unknown; payload_hash: string; operator: string }>(sql`
    SELECT id::text, kind, subject, payload, payload_hash, operator FROM dr_promotion_evidence WHERE promotion_id = ${promotionId}::uuid ORDER BY id`);
  return Array.from(rows).map(row => {
    // 저장된 근거도 매번 같은 계약으로 다시 검증한다. 손상/수동 변경은 승격 근거가 아니다.
    const parsed = parseEvidence(row.kind, row.subject, row.payload);
    if (contentHash(parsed.payload) !== row.payload_hash) fail("dr_evidence_hash_mismatch");
    return { id: Number(row.id), kind: row.kind, subject: row.subject, payload: parsed.payload, operator: row.operator };
  });
}
export async function dbNow(tx: ProductTransaction): Promise<{ iso: string; ms: number }> {
  const [row] = await tx.execute<{ now: string }>(sql`SELECT ${dbNowIso} AS now`);
  return { iso: row.now, ms: Date.parse(row.now) };
}

/** 복원된 R을 fence하고 복사된 모든 권한을 한 TX에서 폐기한다. 되돌리는 API는 없다(막히면 R을 버리고 새로 복원).
 * lock 순서: fence → model/http control → role → item → source claim → jobs (기존 writer의 role→jobs, item→jobs 순서와 같다). */
export async function sealRestoredDatabase(planValue: PromotionPlan, apply: boolean): Promise<PromotionRecord & { otherClients: number }> {
  const plan = promotionPlanSchema.parse(planValue);
  return drTransactionMaybeDry(apply, async tx => {
    const fence = await lockWriterFence(tx, "update"), here = await readDatabaseIdentity(tx);
    if (!sameDatabase(here, plan.restoredDb)) fail("dr_database_identity_mismatch");
    if (plan.oldDbs.some(old => sameDatabase(old, here))) fail("dr_restored_is_old_db");
    if (fence.lineageId !== plan.lineageId || fence.writerEpoch !== plan.fromEpoch) fail("dr_writer_fence_expectation_mismatch");
    // 제자리 재승격 금지: 이 DB 자신에 걸린 operator fence나 이미 진행된 seal은 다시 열지 않는다.
    if (fence.state === "fenced" && (fence.reason !== "operator_fence" || !fence.fencedDb || sameDatabase(fence.fencedDb, here))) fail("dr_in_place_promotion_forbidden");
    const [existing] = await tx.execute(sql`SELECT 1 FROM dr_promotions WHERE lineage_id = ${plan.lineageId}::uuid AND to_epoch = ${plan.fromEpoch + 1}`);
    if (existing) fail("dr_promotion_exists");
    const instances = Array.from(await tx.execute<{ instance: string }>(sql`SELECT DISTINCT instance FROM (
      SELECT owner_instance_id AS instance FROM role_leases WHERE owner_instance_id IS NOT NULL
      UNION SELECT owner_instance_id FROM pipeline_item_leases WHERE token IS NOT NULL
      UNION SELECT instance_id FROM evidence_source_claims WHERE token IS NOT NULL
      UNION SELECT owner_instance_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')
      UNION SELECT instance_id FROM http_origin_hops WHERE state IN ('reserved','dispatched','indeterminate')
      UNION SELECT instance_id FROM job_batch_candidates) owners WHERE instance IS NOT NULL`)).map(row => row.instance).sort();
    const budgets = Array.from(await tx.execute<{ budget: string }>(sql`SELECT DISTINCT budget FROM (
      SELECT provider_budget_id AS budget FROM model_capacity_requests WHERE state IN ('reserved','dispatched','indeterminate')
      UNION SELECT jsonb_object_keys(policy->'providerLimits') FROM model_capacity_control WHERE id = 1 AND policy IS NOT NULL) b`)).map(row => row.budget).sort();
    const [counts] = await tx.execute<{ model: number; http: number; clients: number }>(sql`SELECT
      (SELECT count(*)::int FROM model_capacity_requests WHERE state IN ('reserved','dispatched','indeterminate')) AS model,
      (SELECT count(*)::int FROM http_origin_hops WHERE state IN ('reserved','dispatched','indeterminate')) AS http,
      (SELECT count(*)::int FROM pg_catalog.pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend') AS clients`);
    const [model] = await tx.execute<{ epoch: string; revision: string; mode: "disabled" | "draining" }>(sql`UPDATE model_capacity_control
      SET mode = CASE WHEN policy IS NULL THEN 'disabled' ELSE 'draining' END, epoch = epoch + 1, revision = revision + 1, updated_at = clock_timestamp()
      WHERE id = 1 AND epoch < 9007199254740991 AND revision < 9007199254740991 RETURNING epoch::text, revision::text, mode`);
    const [http] = await tx.execute<{ epoch: string; mode: "disabled" | "draining" }>(sql`UPDATE http_origin_control
      SET mode = CASE WHEN policy IS NULL THEN 'disabled' ELSE 'draining' END, epoch = epoch + 1, updated_at = clock_timestamp()
      WHERE id = 1 AND epoch < 9007199254740991 RETURNING epoch::text, mode`);
    if (!model || !http) fail("dr_permit_control_unavailable");
    const roles = await tx.execute(sql`UPDATE role_leases SET owner_instance_id = NULL, owner_boot_id = NULL, owner_kind = NULL,
      lease_until = now(), epoch = epoch + 1, updated_at = now() WHERE epoch < 9007199254740991 RETURNING role`);
    const [roleTotal] = await tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM role_leases`);
    if (roles.length !== roleTotal.count) fail("dr_role_epoch_exhausted");
    const items = await tx.execute(sql`UPDATE pipeline_item_leases SET owner_instance_id = NULL, owner_boot_id = NULL, token = NULL,
      lease_until = NULL, updated_at = clock_timestamp() WHERE token IS NOT NULL RETURNING work_key`);
    const claims = await tx.execute(sql`UPDATE evidence_source_claims SET token = NULL, instance_id = NULL, boot_id = NULL, lease_until = NULL,
      job = NULL, updated_at = clock_timestamp() WHERE token IS NOT NULL RETURNING product_id`);
    const jobsRevoked = await tx.execute(sql`UPDATE jobs SET lease_token = NULL, locked_at = NULL WHERE lease_token IS NOT NULL RETURNING name`);
    const now = await dbNow(tx);
    const snapshot = sealSnapshotSchema.parse({ version: 1, sealedAt: now.iso, instances, modelBudgets: budgets,
      activeModelCalls: counts.model, activeHttpHops: counts.http,
      revoked: { roles: roles.length, jobs: jobsRevoked.length, items: items.length, sourceClaims: claims.length },
      modelControl: { epoch: Number(model.epoch), revision: Number(model.revision), mode: model.mode }, httpControl: { epoch: Number(http.epoch), mode: http.mode } });
    await tx.execute(sql`INSERT INTO dr_promotions (promotion_id, lineage_id, from_epoch, to_epoch, state, plan, plan_hash, db_identity, seal_snapshot, operator)
      VALUES (${plan.promotionId}::uuid, ${plan.lineageId}::uuid, ${plan.fromEpoch}, ${plan.fromEpoch + 1}, 'sealed', ${JSON.stringify(plan)}::text::jsonb,
        ${promotionPlanHash(plan)}, ${JSON.stringify(here)}::text::jsonb, ${JSON.stringify(snapshot)}::text::jsonb, ${plan.operator})`);
    await tx.execute(sql`UPDATE dr_writer_fence SET state = 'fenced', reason = 'promotion_sealed', fenced_db = ${JSON.stringify(here)}::text::jsonb,
      promotion_id = ${plan.promotionId}::uuid, updated_at = clock_timestamp() WHERE id = 1`);
    await tx.execute(sql`INSERT INTO dr_fence_events (lineage_id, from_epoch, to_epoch, from_state, to_state, reason, db_identity, promotion_id, operator)
      VALUES (${fence.lineageId}::uuid, ${fence.writerEpoch}, ${fence.writerEpoch}, ${fence.state}, 'fenced', 'promotion_sealed', ${JSON.stringify(here)}::text::jsonb,
        ${plan.promotionId}::uuid, ${plan.operator})`);
    return { ...await lockPromotion(tx, plan.promotionId), otherClients: counts.clients };
  });
}

/** 근거는 append-only다. 외부 근거는 이 도구가 조회하지 않으며 운영자 이름·reference·hash로 남긴다. */
export async function recordPromotionEvidence(value: { promotionId: string; kind: EvidenceKind; subject: string; payload: unknown; operator: string },
  apply: boolean): Promise<EvidenceRecord> {
  const kind = z.enum(EVIDENCE_KINDS).parse(value.kind), operator = identity(120).parse(value.operator);
  if (kind === "http_hops_released") fail("dr_evidence_kind_internal");
  const parsed = parseEvidence(kind, value.subject, value.payload);
  return drTransactionMaybeDry(apply, async tx => {
    await lockWriterFence(tx, "share");
    const promotion = await lockPromotion(tx, value.promotionId);
    if (promotion.state !== "sealed") fail("dr_promotion_not_sealed");
    const [row] = await tx.execute<{ id: string }>(sql`INSERT INTO dr_promotion_evidence (promotion_id, kind, subject, payload, payload_hash, operator)
      VALUES (${promotion.promotionId}::uuid, ${kind}, ${parsed.subject}, ${JSON.stringify(parsed.payload)}::text::jsonb, ${contentHash(parsed.payload)}, ${operator}) RETURNING id::text`);
    return { id: Number(row.id), kind, subject: parsed.subject, payload: parsed.payload, operator };
  });
}

export type PromotionStatus = Readonly<{ promotion: PromotionRecord; fence: WriterFence; dbIdentity: DbIdentity; now: string;
  evaluation: PromotionEvaluation; evidence: readonly EvidenceRecord[] }>;
async function readStatus(tx: ProductTransaction, promotionId: string, lock: "share" | "update"): Promise<PromotionStatus> {
  const fence = await lockWriterFence(tx, lock), dbIdentity = await readDatabaseIdentity(tx);
  const promotion = await lockPromotion(tx, promotionId), evidence = await readEvidence(tx, promotionId), now = await dbNow(tx);
  return { promotion, fence, dbIdentity, now: now.iso, evidence, evaluation: evaluatePromotion({ promotion, fence, dbIdentity, evidence, nowMs: now.ms }) };
}
/** 읽기 전용 평가(ROLLBACK). */
export function readPromotionStatus(promotionId: string): Promise<PromotionStatus> {
  return drTransactionMaybeDry(false, tx => readStatus(tx, promotionId, "share"));
}

/** fence UPDATE 아래 같은 TX에서 DB clock으로 다시 평가한다. 막히면 아무것도 쓰지 않는다. */
export async function promoteSealedDatabase(value: { promotionId: string; operator: string }, apply: boolean):
  Promise<{ kind: "blocked"; status: PromotionStatus } | { kind: "promoted"; fence: WriterFence; status: PromotionStatus }> {
  const operator = identity(120).parse(value.operator);
  return drTransactionMaybeDry(apply, async tx => {
    const status = await readStatus(tx, value.promotionId, "update");
    if (!status.evaluation.ready) return { kind: "blocked" as const, status };
    const plan = status.promotion.plan;
    await tx.execute(sql`UPDATE dr_writer_fence SET state = 'active', reason = NULL, fenced_db = NULL, writer_epoch = ${plan.fromEpoch + 1},
      promotion_id = ${plan.promotionId}::uuid, updated_at = clock_timestamp() WHERE id = 1 AND state = 'fenced' AND writer_epoch = ${plan.fromEpoch}`);
    await tx.execute(sql`UPDATE dr_promotions SET state = 'promoted', promoted_at = clock_timestamp() WHERE promotion_id = ${plan.promotionId}::uuid AND state = 'sealed'`);
    await tx.execute(sql`INSERT INTO dr_fence_events (lineage_id, from_epoch, to_epoch, from_state, to_state, reason, db_identity, promotion_id, operator)
      VALUES (${plan.lineageId}::uuid, ${plan.fromEpoch}, ${plan.fromEpoch + 1}, 'fenced', 'active', 'promotion_activated', ${JSON.stringify(status.dbIdentity)}::text::jsonb,
        ${plan.promotionId}::uuid, ${operator})`);
    const fence = await lockWriterFence(tx, "update");
    if (fence.state !== "active" || fence.writerEpoch !== plan.fromEpoch + 1 || fence.promotionId !== plan.promotionId) fail("dr_promotion_readback_mismatch");
    return { kind: "promoted" as const, fence, status };
  });
}

/** promote 뒤 permit adapter가 쓰는 읽기: 이 DB가 이 승격으로 active인지 확인하고 근거를 돌려준다. */
export async function lockPromotedState(tx: ProductTransaction, promotionId: string): Promise<{ promotion: PromotionRecord; evidence: EvidenceRecord[]; now: { iso: string; ms: number } }> {
  const fence = await lockWriterFence(tx, "share"), here = await readDatabaseIdentity(tx), promotion = await lockPromotion(tx, promotionId);
  if (fence.state !== "active" || fence.promotionId !== promotion.promotionId || fence.writerEpoch !== promotion.plan.fromEpoch + 1
    || promotion.state !== "promoted" || !sameDatabase(here, promotion.dbIdentity)) fail("dr_promotion_not_active");
  return { promotion, evidence: await readEvidence(tx, promotionId), now: await dbNow(tx) };
}
export async function insertInternalEvidence(tx: ProductTransaction, promotionId: string, kind: "http_hops_released", subject: string, payload: unknown, operator: string): Promise<void> {
  const parsed = parseEvidence(kind, subject, payload);
  await tx.execute(sql`INSERT INTO dr_promotion_evidence (promotion_id, kind, subject, payload, payload_hash, operator)
    VALUES (${promotionId}::uuid, ${kind}, ${parsed.subject}, ${JSON.stringify(parsed.payload)}::text::jsonb, ${contentHash(parsed.payload)}, ${identity(120).parse(operator)})`);
}

// ---- D11: 프로세스 그룹 종료 근거 ----
export const processOwnerSchema = z.object({ instanceId: identity(120), bootId: z.uuid() }).strict();
export type ProcessOwner = Readonly<z.infer<typeof processOwnerSchema>>;
/** kill(-pgid,0): ESRCH만 “그룹 없음”이다. EPERM 등은 살아 있을 수 있다. */
export function processGroupGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return fail("dr_invalid_pid");
  try { process.kill(-pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
/** role-worker boot마다 child보다 먼저 한 번. 이 기록 이전에 dispatch된 행은 이 근거로 회수하지 않는다.
 * 멱등이다(commit 결과를 모른 재시도가 첫 기록 시각을 바꾸지 않는다). */
export async function openProcessGroupOwner(ownerValue: ProcessOwner, attestationValue: ProcessAttestation | null = null): Promise<void> {
  const owner = processOwnerSchema.parse(ownerValue), attestation = attestationValue === null ? null : processAttestationSchema.parse(attestationValue);
  // PR15f: attestation(이 boot 의 커널·PID namespace)은 owner_opened 와 같은 행이다. 없으면 detail 열을 쓰지 않는다(0101 전 DB 와 같은 INSERT).
  await drTransaction(tx => tx.execute(attestation ? sql`INSERT INTO dr_process_group_events (owner_instance_id, owner_boot_id, kind, seq, detail)
    VALUES (${owner.instanceId}, ${owner.bootId}::uuid, 'owner_opened', 0, ${JSON.stringify(attestation)}::text::jsonb)
    ON CONFLICT (owner_instance_id, owner_boot_id, kind, seq) DO NOTHING` : sql`INSERT INTO dr_process_group_events (owner_instance_id, owner_boot_id, kind, seq)
    VALUES (${owner.instanceId}, ${owner.bootId}::uuid, 'owner_opened', 0)
    ON CONFLICT (owner_instance_id, owner_boot_id, kind, seq) DO NOTHING`));
}
/** spawn 전에 commit해야 한다. 실패하면 슈퍼바이저는 spawn하지 않는다(그래야 기록 없는 child가 없다). */
export async function recordSpawnIntent(ownerValue: ProcessOwner): Promise<{ seq: number; runId: string }> {
  const owner = processOwnerSchema.parse(ownerValue), runId = randomUUID();
  return drTransaction(async tx => {
    // owner별 번호 할당 직렬화. 행 lock 대신 xact advisory lock이라 append-only 근거 표에 UPDATE 권한이 필요 없다(Oracle 최소 권한).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["dr_process_group", owner.instanceId, owner.bootId])}, 0))`);
    const [opened] = await tx.execute(sql`SELECT 1 FROM dr_process_group_events WHERE owner_instance_id = ${owner.instanceId}
      AND owner_boot_id = ${owner.bootId}::uuid AND kind = 'owner_opened'`);
    if (!opened) fail("dr_process_owner_not_opened");
    const [row] = await tx.execute<{ seq: number }>(sql`INSERT INTO dr_process_group_events (owner_instance_id, owner_boot_id, kind, seq, run_id)
      SELECT ${owner.instanceId}, ${owner.bootId}::uuid, 'spawn_intent', coalesce(max(seq), 0) + 1, ${runId}::uuid FROM dr_process_group_events
      WHERE owner_instance_id = ${owner.instanceId} AND owner_boot_id = ${owner.bootId}::uuid AND kind = 'spawn_intent' RETURNING seq`);
    return { seq: Number(row.seq), runId };
  });
}
export async function recordSpawned(ownerValue: ProcessOwner, spawn: { seq: number; runId: string }, pid: number): Promise<void> {
  const owner = processOwnerSchema.parse(ownerValue);
  if (!Number.isSafeInteger(pid) || pid <= 1) fail("dr_invalid_pid");
  await drTransaction(async tx => {
    const [intent] = await tx.execute(sql`SELECT 1 FROM dr_process_group_events WHERE owner_instance_id = ${owner.instanceId} AND owner_boot_id = ${owner.bootId}::uuid
      AND kind = 'spawn_intent' AND seq = ${spawn.seq} AND run_id = ${spawn.runId}::uuid`);
    if (!intent) fail("dr_spawn_intent_missing");
    await tx.execute(sql`INSERT INTO dr_process_group_events (owner_instance_id, owner_boot_id, kind, seq, run_id, pid)
      VALUES (${owner.instanceId}, ${owner.bootId}::uuid, 'spawned', ${spawn.seq}, ${spawn.runId}::uuid, ${pid})`);
  });
}
/** 기록 직전에 이 프로세스가 직접 ESRCH를 관측해야 한다. 그룹이 남아 있으면 쓰지 않는다. */
export async function recordGroupExited(ownerValue: ProcessOwner, spawn: { seq: number; runId: string }, pid: number,
  probe: (pid: number) => boolean = processGroupGone): Promise<void> {
  const owner = processOwnerSchema.parse(ownerValue);
  await drTransaction(async tx => {
    const [spawned] = await tx.execute(sql`SELECT 1 FROM dr_process_group_events WHERE owner_instance_id = ${owner.instanceId} AND owner_boot_id = ${owner.bootId}::uuid
      AND kind = 'spawned' AND seq = ${spawn.seq} AND run_id = ${spawn.runId}::uuid AND pid = ${pid}`);
    if (!spawned) fail("dr_spawned_record_missing");
    if (!probe(pid)) fail("dr_process_group_alive");
    await tx.execute(sql`INSERT INTO dr_process_group_events (owner_instance_id, owner_boot_id, kind, seq, run_id, pid, method)
      VALUES (${owner.instanceId}, ${owner.bootId}::uuid, 'group_exited', ${spawn.seq}, ${spawn.runId}::uuid, ${pid}, 'pgid_esrch_after_sigkill')`);
  });
}

export type SuccessorExit = Readonly<{ bootId: string; seq: number; runId: string; pid: number }>;
export type SuccessorProbeResult = Readonly<{ recorded: SuccessorExit[]; alive: number }>;
/**
 * PR15f: supervisor 가 child 와 함께 죽어(컨테이너·OOM·unit 재시작) group_exited 를 남기지 못한 옛 boot 의 child 그룹을, 같은 instance 의 후속 boot 가
 * 직접 kill(-pgid,0)=ESRCH 로 관측해 그 옛 owner 의 group_exited 로 남긴다. 대상은 attestation 이 이 boot 와 같은(같은 커널 boot·같은 PID namespace)
 * 옛 owner 의 spawned 기록 중 종료가 없는 것뿐이다. 살아 있거나(EPERM 포함) 다른 namespace 면 쓰지 않는다. 시간 경과는 근거가 아니다.
 * 이 boot 가 같은 attestation 으로 owner_opened 를 먼저 commit 했어야 한다. 같은 instance 의 관측자끼리는 advisory lock 으로 직렬화한다.
 */
export async function recordSuccessorExits(ownerValue: ProcessOwner, attestationValue: ProcessAttestation,
  probe: (pid: number) => boolean = processGroupGone): Promise<SuccessorProbeResult> {
  const owner = processOwnerSchema.parse(ownerValue), attestation = processAttestationSchema.parse(attestationValue);
  const attested = JSON.stringify(attestation);
  return drTransaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["dr_process_group_successor", owner.instanceId])}, 0))`);
    const [self] = await tx.execute(sql`SELECT 1 FROM dr_process_group_events WHERE owner_instance_id = ${owner.instanceId} AND owner_boot_id = ${owner.bootId}::uuid
      AND kind = 'owner_opened' AND detail = ${attested}::text::jsonb`);
    if (!self) fail("dr_process_owner_not_attested");
    const candidates = await tx.execute<{ boot_id: string; seq: number; run_id: string; pid: number }>(sql`
      SELECT s.owner_boot_id::text AS boot_id, s.seq, s.run_id::text AS run_id, s.pid FROM dr_process_group_events s
      JOIN dr_process_group_events o ON o.owner_instance_id = s.owner_instance_id AND o.owner_boot_id = s.owner_boot_id AND o.kind = 'owner_opened'
      WHERE s.owner_instance_id = ${owner.instanceId} AND s.owner_boot_id <> ${owner.bootId}::uuid AND s.kind = 'spawned' AND o.detail = ${attested}::text::jsonb
        AND NOT EXISTS (SELECT 1 FROM dr_process_group_events x WHERE x.owner_instance_id = s.owner_instance_id AND x.owner_boot_id = s.owner_boot_id
          AND x.kind = 'group_exited' AND x.seq = s.seq)
      ORDER BY s.id LIMIT 4096`);
    const recorded: SuccessorExit[] = [];
    let alive = 0;
    const detail = JSON.stringify({ version: 1, observerBootId: owner.bootId, kernelBootId: attestation.kernelBootId, pidNamespace: attestation.pidNamespace });
    for (const row of candidates) {
      const pid = Number(row.pid);
      // 관측 직후에만 쓴다. 같은 seq 를 옛 supervisor 가 늦게라도 남겼으면 그 기록을 그대로 둔다.
      if (!probe(pid)) { alive++; continue; }
      const inserted = await tx.execute(sql`INSERT INTO dr_process_group_events (owner_instance_id, owner_boot_id, kind, seq, run_id, pid, method, detail)
        VALUES (${owner.instanceId}, ${row.boot_id}::uuid, 'group_exited', ${Number(row.seq)}, ${row.run_id}::uuid, ${pid}, ${SUCCESSOR_EXIT_METHOD}, ${detail}::text::jsonb)
        ON CONFLICT (owner_instance_id, owner_boot_id, kind, seq) DO NOTHING RETURNING seq`);
      if (inserted.length === 1) recorded.push({ bootId: row.boot_id, seq: Number(row.seq), runId: row.run_id, pid });
    }
    return { recorded, alive };
  });
}

export type SpawnRecord = Readonly<{ seq: number; runId: string }>;
/** worker-supervisor가 child마다 쓰는 D11 기록기. intent가 commit되지 않으면 spawn하지 않고, exited는 그룹 SIGKILL 뒤에만 부른다. */
export type ProcessGroupRecorder = Readonly<{ intent: () => Promise<SpawnRecord>; spawned: (spawn: SpawnRecord, pid: number) => Promise<void>;
  exited: (spawn: SpawnRecord, pid: number) => Promise<void>;
  /** 기록 owner. 슈퍼바이저가 child env 로만 넘겨 child 의 장부 행·HTTP hop 이 같은 owner 로 남게 한다(PR15d). */
  owner?: ProcessOwner;
  /** PR15f: attestation 이 있을 때만. owner_opened(attestation 포함)를 먼저 commit 한 뒤 같은 instance 의 옛 boot 그룹 종료를 관측한다. */
  probePredecessors?: () => Promise<SuccessorProbeResult> }>;
/** role-worker boot 하나(=모델 장부 owner)의 기록기. owner_opened는 첫 intent(또는 PR15f 후속 관측) 직전에 한 번 쓴다 — 이 boot의 장부 행은 child가 생긴 뒤에만 생긴다. */
export function processGroupRecorder(ownerValue: ProcessOwner, options: { attestation?: ProcessAttestation | null } = {}): ProcessGroupRecorder {
  const owner = processOwnerSchema.parse(ownerValue);
  const attestation = options.attestation ? processAttestationSchema.parse(options.attestation) : null;
  let opened: Promise<void> | null = null;
  const open = () => (opened ??= openProcessGroupOwner(owner, attestation).catch(error => { opened = null; throw error; }));
  return Object.freeze({
    owner,
    intent: async () => {
      await open();
      return recordSpawnIntent(owner);
    },
    spawned: (spawn: SpawnRecord, pid: number) => recordSpawned(owner, spawn, pid),
    exited: (spawn: SpawnRecord, pid: number) => recordGroupExited(owner, spawn, pid),
    ...(attestation ? { probePredecessors: async () => { await open(); return recordSuccessorExits(owner, attestation); } } : {}),
  });
}
/** owner의 근거 행 전체(기록 순서). 시각은 같은 DB clock, ms 절삭이다. */
export async function readProcessGroupEvents(tx: ProductTransaction, owner: ProcessOwner): Promise<ProcessGroupEvent[]> {
  return Array.from(await tx.execute<{ kind: ProcessGroupEvent["kind"]; seq: number; run_id: string | null; pid: number | null; at: string;
    method: string | null; detail: unknown }>(sql`
    SELECT kind, seq, run_id::text, pid, ${sql.raw(`to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)} AS at, method, detail FROM dr_process_group_events
    WHERE owner_instance_id = ${owner.instanceId} AND owner_boot_id = ${owner.bootId}::uuid ORDER BY id`))
    .map(row => ({ kind: row.kind, seq: Number(row.seq), runId: row.run_id, pid: row.pid === null ? null : Number(row.pid), recordedAtMs: Date.parse(row.at),
      method: row.method, detail: row.detail }));
}

export type ProcessReclaimRow = Readonly<{ requestId: string; state: "dispatched" | "indeterminate"; providerBudgetId: string; dispatchAt: string | null;
  reclaimable: boolean; reason: string | null; notBefore: string | null }>;
/** 읽기 전용 보고. 실제 장부 해제는 reclaim.ts가 장부 hook(releaseModelDispatchWithEvidence) 안에서 같은 TX로 이 판정을 다시 한다. */
export async function readProcessReclaimReport(ownerValue: ProcessOwner, policies: ReadonlyMap<string, ReclaimPolicy>): Promise<{ now: string; rows: ProcessReclaimRow[] }> {
  const owner = processOwnerSchema.parse(ownerValue);
  return drTransactionMaybeDry(false, async tx => {
    const events = await readProcessGroupEvents(tx, owner);
    const rows = await tx.execute<{ request_id: string; state: "dispatched" | "indeterminate"; provider_budget_id: string; dispatch_at: string | null }>(sql`
      SELECT r.request_id::text, r.state, r.provider_budget_id, ${sql.raw(`to_char(coalesce(r.dispatched_at, (SELECT min(e.created_at) FROM model_capacity_events e
        WHERE e.request_id = r.request_id AND e.kind = 'dispatch_started')) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)} AS dispatch_at
      FROM model_capacity_requests r WHERE r.owner_instance_id = ${owner.instanceId} AND r.owner_boot_id = ${owner.bootId}::uuid
        AND r.state IN ('dispatched','indeterminate') ORDER BY r.queue_ordinal`);
    const now = await dbNow(tx);
    return { now: now.iso, rows: Array.from(rows).map(row => {
      const policy = policies.get(row.provider_budget_id) ?? { termination: "provider_bound" as const, hardDeadlineMs: null, skewBoundMs: 1 };
      if (!row.dispatch_at) return { requestId: row.request_id, state: row.state, providerBudgetId: row.provider_budget_id, dispatchAt: null,
        reclaimable: false, reason: "dispatch_time_unknown", notBefore: null };
      const result = evaluateProcessReclaim(events, Date.parse(row.dispatch_at), policy, now.ms);
      return { requestId: row.request_id, state: row.state, providerBudgetId: row.provider_budget_id, dispatchAt: row.dispatch_at,
        reclaimable: result.reclaimable, reason: result.reclaimable ? null : result.reason,
        notBefore: result.notBeforeMs === null ? null : new Date(result.notBeforeMs).toISOString() };
    }) };
  });
}

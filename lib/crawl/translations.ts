import { assertJobLease, type JobLease } from "@/lib/jobs/control";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, onReplica, onPrimary } from "@/lib/db";
import { createMemo } from "@/lib/cache/memo";
import { sharedStore } from "@/lib/cache/shared";
import { roleLeases, textTranslations } from "@/lib/db/schema";
import { needsKorean, textHash } from "./translate";
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { reviewHash } from './agent-review-contract';
import { assertJobLeaseAtWallTime } from '@/lib/jobs/control';
import { assertJobBatchAdmission } from '@/lib/jobs/batch-repository';
import { RoleLeaseLostError, type RoleLease } from '@/lib/jobs/role-leader';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { lockModelCapacityCallerControl, lockReasonTranslationModelCapacityDispatch,
  finishReasonTranslationModelCapacityDispatch } from '@/lib/llm/capacity-repository';
import { modelCapacityRequestIdentitySchema, modelCapacityReservationSchema, reasonTranslationInputSchema,
  reasonTranslationDispatchBindingSchema, reasonTranslationLogicalWorkKey, reasonTranslationInputHash,
  type ReasonTranslationMember, type ReasonTranslationModelDispatch, type ReasonTranslationDispatchBinding,
  type ModelCapacityReservation, type ModelCapacityRequestIdentity } from '@/lib/llm/capacity';
import type { PreparedReasonTranslationGatewayCall } from './agent-review-gateway';

/**
 * 번역해 둘 글과 번역해 둔 글.
 *
 * 글이 나오는 곳은 심사 화면에 뜨는 두 가지다 — AI 심사 기록의 사유(reason 이 있으면 그것, 없으면
 * outcome.reason. 화면의 summarizeAttempt 와 같은 순서)와 2차 판단 사유. 같은 글은 한 번만 번역한다.
 * 해시는 DB 에서도 JS 에서도 원문 UTF-8 의 sha256 이라 서로 맞는다.
 */
const SOURCES = sql`
  select coalesce(a.reason, a.outcome->>'reason') as body, coalesce(a.completed_at, a.started_at) as at
    from crawl_review_attempts a where coalesce(a.reason, a.outcome->>'reason') is not null
  union all
  select s.second_reason, coalesce(s.reviewed_at, s.created_at) from second_reviews s where s.second_reason is not null`;

/**
 * translate.ts needsKorean 과 같은 기준 — 글자 중 한글이 30% 미만.
 *
 * 한글이 하나도 없으면 비율을 잴 것도 없이 참이다(0 < 0.3 × 1 이상). 그 값싼 확인을 먼저 해서
 * 대부분의 행에서 regexp_replace 두 번을 건너뛴다 — 그 둘이 행마다 새 문자열을 만든다.
 * 프로드 실측(2026-09-18, 46,237행 중 한글이 조금이라도 있는 행은 1,222행): 9,652ms → 360ms.
 * 같은 스냅샷에서 두 식의 결과가 완전히 같은 것을 확인했다.
 */
const NEEDS_KOREAN = sql`length(btrim(body)) > 0 and (body !~ '[가-힣]'
  or length(regexp_replace(body, '[^가-힣]', '', 'g'))
     < 0.3 * greatest(1, length(regexp_replace(body, '[^A-Za-z가-힣]', '', 'g'))))`;

const UNIQUE_SOURCES = sql`select encode(sha256(convert_to(body, 'UTF8')), 'hex') as hash, body, max(at) as at
  from (${SOURCES}) src where ${NEEDS_KOREAN} group by 1, 2`;

export type PendingTranslation = { hash: string; body: string; attempts: number };

/**
 * 아직 한 번도 옮기지 않은 글 — 최근 것부터. 심사 화면이 보는 것이 최근 사유라서다.
 */
export async function untriedTranslations(limit: number): Promise<PendingTranslation[]> {
  const rows = await db.execute<{ hash: string; body: string; attempts: number }>(sql`
    select u.hash, u.body, 0::int as attempts
      from (${UNIQUE_SOURCES}) u
      left join ${textTranslations} t on t.source_hash = u.hash and t.target_lang = 'ko'
     where t.source_hash is null
     order by u.at desc nulls last
     limit ${limit}`);
  return [...rows].map((row) => ({ hash: row.hash, body: row.body, attempts: Number(row.attempts) }));
}

/**
 * 다시 볼 때가 된 실패 — 오래 기다린 것부터.
 *
 * 한 대기열에 섞어 원문 최신순으로 세웠더니 실패가 영영 차례를 얻지 못했다. 프로드에서
 * 실패 1,871건 중 1,854건이 시도 1회에 멈춘 채 엿새를 기다렸다 — 재시도 시각은 진작 지났는데
 * 새로 들어오는 글이 늘 앞에 섰기 때문이다. 줄을 나눠 세우고 잡이 번갈아 가져간다.
 */
export async function retryableTranslations(limit: number): Promise<PendingTranslation[]> {
  const rows = await db.execute<{ hash: string; body: string; attempts: number }>(sql`
    select u.hash, u.body, t.attempts::int as attempts
      from (${UNIQUE_SOURCES}) u
      join ${textTranslations} t on t.source_hash = u.hash and t.target_lang = 'ko'
     where t.status = 'failed' and (t.retry_at is null or t.retry_at <= now())
     order by t.retry_at asc nulls first, t.attempts asc
     limit ${limit}`);
  return [...rows].map((row) => ({ hash: row.hash, body: row.body, attempts: Number(row.attempts) }));
}

/** Oldest currently selectable translation, using the same source and retry predicates as the worker. */
export async function oldestPendingTranslationMinutes(): Promise<number | null> {
  const [row] = await db.execute<{ minutes: number | null }>(sql`
    select extract(epoch from (now() - min(u.at))) / 60 as minutes
      from (${UNIQUE_SOURCES}) u
      left join ${textTranslations} t on t.source_hash = u.hash and t.target_lang = 'ko'
     where t.source_hash is null or (t.status = 'failed' and (t.retry_at is null or t.retry_at <= now()))
  `);
  return row?.minutes === null || row?.minutes === undefined ? null : Number(row.minutes);
}

/**
 * 결과를 남긴다. 실패는 5분·10분·20분… 뒤에 다시(최대 하루) — 느려도 끝까지 이어 가되
 * 늘 실패하는 한 건이 매 틱을 잡아먹지 않게.
 *
 * targetLang 은 표의 기본키 한쪽이다. 사유는 'ko'(영어 → 한국어), 검색어는 'en'(한국어 → 영어)로
 * 같은 표를 쓴다 — 해시가 같아도 방향이 다르면 다른 행이다.
 */
type TranslationResult = { hash: string; translated: string | null; error?: string };
/** Non-worker HTTP/search path retains its independent lifecycle. */
export async function recordTranslations(results: TranslationResult[], model: string, targetLang = "ko") {
  await writeTranslations(db, results, model, targetLang);
}
/** Worker callers cannot omit their lease. */
export function recordWorkerTranslations(results: TranslationResult[], model: string, lease: JobLease): Promise<void>;
export function recordWorkerTranslations(results: TranslationResult[], model: string, lease: JobLease,
  expectation: ReasonTranslationWriteExpectation): Promise<number>;
export async function recordWorkerTranslations(results: TranslationResult[], model: string, lease: JobLease,
  expectation?: ReasonTranslationWriteExpectation): Promise<void | number> {
  if (expectation) return writeReservedReasonTranslations(results, model, lease, expectation);
  await db.transaction(async tx => {
    await writeTranslations(tx, results, model, "ko");
    await assertJobLease(tx, lease);
  });
}

async function writeTranslations(executor: ProductTransaction | typeof db, results: { hash: string; translated: string | null; error?: string }[], model: string, targetLang = "ko"): Promise<void> {
  for (const result of results) {
    const done = result.translated !== null;
    await executor.insert(textTranslations).values({
      sourceHash: result.hash, targetLang, status: done ? "done" : "failed", translated: result.translated, model,
      attempts: 1, errorCode: done ? null : (result.error ?? "invalid_output").slice(0, 60),
      retryAt: done ? null : sql`now() + interval '5 minutes'`, updatedAt: sql`now()`,
    }).onConflictDoUpdate({
      target: [textTranslations.sourceHash, textTranslations.targetLang],
      set: done
        ? { status: "done", translated: result.translated, model, errorCode: null, retryAt: null, updatedAt: sql`now()`,
            attempts: sql`${textTranslations.attempts} + 1` }
        : { status: "failed", model, errorCode: (result.error ?? "invalid_output").slice(0, 60), updatedAt: sql`now()`,
            attempts: sql`${textTranslations.attempts} + 1`,
            retryAt: sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, ${textTranslations.attempts}))` },
      // 번역이 이미 있으면 실패로 덮지 않는다
      setWhere: done ? undefined : sql`${textTranslations.status} <> 'done'`,
    });
  }
}

/** 화면에 뜨는 글의 번역 — 원문 → 번역. 번역이 없거나 옮길 필요가 없는 글은 빠진다 */
export async function translationsFor(texts: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = new Map<string, string>();
  for (const text of texts) if (text && needsKorean(text)) wanted.set(textHash(text), text);
  if (!wanted.size) return new Map();
  const rows = await db.select({ hash: textTranslations.sourceHash, translated: textTranslations.translated }).from(textTranslations)
    .where(and(inArray(textTranslations.sourceHash, [...wanted.keys()]), eq(textTranslations.targetLang, "ko"), eq(textTranslations.status, "done")));
  return new Map(rows.flatMap((row) => row.translated ? [[wanted.get(row.hash)!, row.translated] as const] : []));
}

/** 실패 사유 한 줄 — 무엇이 몇 건 막혔고 언제 다시 보는지 */
export type TranslationFailure = { code: string; count: number; dueNow: number; maxAttempts: number };

/** measuredAt — 센 시각(ISO). 아래 캐시 때문에 최대 1분 지난 값일 수 있어 화면이 "N초 전 집계"로 밝힌다 */
export type TranslationProgress = { total: number; done: number; failed: number; pending: number; lastHour: number; lastSecondsAgo: number | null; failures: TranslationFailure[]; measuredAt: string };

/**
 * 실패 사유별 집계.
 *
 * 실패는 errorCode 로 남는데 화면 어디에도 나오지 않아 "1,876건 실패"라는 숫자만 보였다.
 * 무엇이 막혔는지 알아야 게이트웨이를 볼지 글을 볼지 판단한다.
 */
async function failureBreakdown(): Promise<TranslationFailure[]> {
  const rows = await db.execute<{ code: string | null; count: number; due_now: number; max_attempts: number }>(sql`
    select error_code as code, count(*)::int as count,
           (count(*) filter (where retry_at is null or retry_at <= now()))::int as due_now,
           max(attempts)::int as max_attempts
      from ${textTranslations} where status = 'failed' and target_lang = 'ko'
     group by 1 order by count(*) desc limit 8`);
  return [...rows].map((row) => ({
    code: row.code ?? "(사유 없음)",
    count: Number(row.count),
    dueNow: Number(row.due_now),
    maxAttempts: Number(row.max_attempts),
  }));
}

/**
 * 진행률은 1분 늦어도 된다 — 60초 담아 두고 웹 6대가 Valkey 로 나눠 쓴다(lib/cache/memo.ts).
 *
 * 원본 14만 행마다 한글 비율과 sha256 을 다시 재 한 번에 2.2초·버퍼 50만 개였다(2026-10-08 복제본 EXPLAIN).
 * 운영센터는 10초마다 다시 읽고 심사 큐도 매번 불러, 두 화면이 늘 이 2.2초를 기다렸다. 세는 곳도 복제본으로 옮겨
 * 워커와 다른 DB 가 같이 쓰는 주 DB 를 비운다 — 진행률은 방금 쓴 값을 읽을 필요가 없다.
 */
const PROGRESS_TTL_MS = 60_000;
const progressMemo = createMemo<TranslationProgress>({ ttlMs: PROGRESS_TTL_MS, max: 1,
  shared: { store: sharedStore, namespace: "admin:translation-progress" } });

/** 운영센터·심사 큐가 보여 주는 진행 — 옮길 글(같은 글은 하나) 중 몇 개를 옮겼나 */
export function translationProgress(): Promise<TranslationProgress> {
  return progressMemo.get("ko", () => onReplica(countTranslationProgress));
}

async function countTranslationProgress(): Promise<TranslationProgress> {
  const measuredAt = new Date().toISOString();
  const [row] = [...await db.execute<{ total: number; done: number; failed: number; last_hour: number; last_ago: number | null }>(sql`
    select count(*)::int as total,
           (count(*) filter (where t.status = 'done'))::int as done,
           (count(*) filter (where t.status = 'failed'))::int as failed,
           -- 검색어 번역이 같은 표에 'en' 으로 들어온다. 이 화면은 사유 번역만 센다
           (select count(*)::int from ${textTranslations} where status = 'done' and target_lang = 'ko' and updated_at > now() - interval '1 hour') as last_hour,
           (select extract(epoch from now() - max(updated_at))::int from ${textTranslations} where status = 'done' and target_lang = 'ko') as last_ago
      from (${UNIQUE_SOURCES}) u
      left join ${textTranslations} t on t.source_hash = u.hash and t.target_lang = 'ko'`)];
  const total = Number(row?.total ?? 0), done = Number(row?.done ?? 0);
  const failed = Number(row?.failed ?? 0);
  return { total, done, failed, pending: total - done, lastHour: Number(row?.last_hour ?? 0),
    lastSecondsAgo: row?.last_ago === null || row?.last_ago === undefined ? null : Number(row.last_ago),
    failures: failed > 0 ? await failureBreakdown() : [], measuredAt };
}

/** A positive call retains the exact cache snapshot through its final writer.
 * The object itself is a private, one-use module capability, not a caller flag. */
export type ReasonTranslationWriteExpectation = Readonly<{ kind: 'reason_translation_write' }>;
type CacheRow = Record<string, unknown>;
type ReasonRole = ReasonTranslationDispatchBinding['role'];
type CacheSnapshot = { sourceHash: string; raw: CacheRow | null; attempts: number };
const reasonWrites = new WeakMap<ReasonTranslationWriteExpectation, {
  lease: JobLease; role: ReasonRole; model: string; rows: CacheSnapshot[]; used: boolean;
}>();
class ReasonTranslationChanged extends Error { constructor() { super('reason_translation_input_changed'); } }

/** Fixed batch validation runs before the first asynchronous read. */
export function snapshotReasonTranslationBatch(value: readonly PendingTranslation[]): PendingTranslation[] {
  const rows = z.array(z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), body: z.string(),
    attempts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict()).min(1).max(4).parse(structuredClone(value));
  if (new Set(rows.map(row => row.hash)).size !== rows.length
    || rows.some(row => textHash(row.body) !== row.hash)
    || rows.length > 1 && (rows.some(row => row.attempts >= 3) || rows.reduce((n, row) => n + row.body.length, 0) > 1600))
    throw new Error('invalid_reason_translation_batch');
  return rows;
}
function snapshotReasonJob(value: JobLease): JobLease {
  return z.object({ name: z.literal('reason-translate'), token: z.string().uuid(),
    requestedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict().parse(structuredClone(value));
}
function roleFromLease(lease: RoleLease, kind: 'primary' | 'standby'): ReasonRole {
  const owner = { instanceId: lease.instanceId, bootId: lease.bootId, release: lease.release, kind, epoch: lease.epoch };
  if (lease.role === 'text' && lease.batchVersion === undefined) return { ...owner, role: 'text', batch: { mode: 'legacy' } };
  if (lease.role === 'translation' && lease.batchVersion === 1 && lease.host && lease.batchEpoch)
    return { ...owner, role: 'translation', batch: { mode: 'versioned', host: lease.host, batchEpoch: lease.batchEpoch } };
  throw new ModelCapacityDeferredError('owner_unavailable');
}
async function lockReasonRole(tx: ProductTransaction, lease: RoleLease): Promise<ReasonRole> {
  const [row] = await tx.select().from(roleLeases).where(eq(roleLeases.role, lease.role)).for('share');
  // ENV has no owner-kind field. Match its entire actual identity, and preserve
  // the locked DB owner kind; never manufacture standby/primary authority.
  if (!row || row.ownerInstanceId !== lease.instanceId || row.ownerBootId !== lease.bootId
    || row.ownerRelease !== lease.release || row.epoch !== lease.epoch
    || (row.ownerKind !== 'primary' && row.ownerKind !== 'standby')) throw new RoleLeaseLostError();
  const role = roleFromLease(lease, row.ownerKind);
  await assertReasonRoleWall(tx, role);
  return role;
}
async function assertReasonRoleWall(tx: ProductTransaction, role: ReasonRole): Promise<void> {
  const [row] = await tx.select({ role: roleLeases.role }).from(roleLeases).where(and(
    eq(roleLeases.role, role.role), eq(roleLeases.ownerInstanceId, role.instanceId),
    eq(roleLeases.ownerBootId, role.bootId), eq(roleLeases.ownerRelease, role.release),
    eq(roleLeases.ownerKind, role.kind), eq(roleLeases.epoch, role.epoch),
    sql`${roleLeases.leaseUntil} > clock_timestamp()`));
  if (!row) throw new RoleLeaseLostError();
}
async function lockReasonCache(tx: ProductTransaction, batch: PendingTranslation[], currentSource: boolean): Promise<CacheSnapshot[]> {
  const rows: CacheSnapshot[] = [];
  for (const item of [...batch].sort((a, b) => a.hash.localeCompare(b.hash))) {
    if (currentSource) {
      const [source] = await tx.execute<{ present: boolean }>(sql`SELECT EXISTS (
        SELECT 1 FROM (${UNIQUE_SOURCES}) u WHERE u.hash = ${item.hash} AND u.body = ${item.body}
      ) AS present`);
      if (!source?.present) throw new ReasonTranslationChanged();
    }
    const [row] = await tx.execute<{ raw: CacheRow; due: boolean }>(sql`
      SELECT to_jsonb(t) AS raw, (t.status = 'failed' AND (t.retry_at IS NULL OR t.retry_at <= clock_timestamp())) AS due
      FROM text_translations t WHERE t.source_hash = ${item.hash} AND t.target_lang = 'ko' FOR UPDATE`);
    if (currentSource && (row && !row.due || Number(row?.raw.attempts ?? 0) !== item.attempts)) throw new ReasonTranslationChanged();
    rows.push({ sourceHash: item.hash, raw: row?.raw ?? null, attempts: Number(row?.raw.attempts ?? 0) });
  }
  return rows;
}
function memberSnapshots(batch: PendingTranslation[], rows: CacheSnapshot[]): ReasonTranslationMember[] {
  return batch.map(item => {
    const row = rows.find(row => row.sourceHash === item.hash)!;
    return { sourceHash: item.hash, cache: row.raw === null ? { kind: 'absent' as const }
      : { kind: 'present' as const, rowIdentityHash: reviewHash(row.raw), attempts: row.attempts } };
  });
}
type ReasonPreparationOptions = { roleLease: RoleLease; call: PreparedReasonTranslationGatewayCall;
  reserved?: { reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; members: readonly ReasonTranslationMember[]; role: ReasonRole } };
type ReasonPreparation = { kind: 'disabled' } | { kind: 'skipped' }
  | { kind: 'ready'; members: ReasonTranslationMember[]; role: ReasonRole }
  | { kind: 'ready'; dispatch: ReasonTranslationModelDispatch; expectation: ReasonTranslationWriteExpectation };

/** No connection spans queue waiting or native transport. The reserved variant
 * uses the private control/request UPDATE prefix before batch/role/cache/job. */
export async function prepareReasonTranslationDispatch(value: readonly PendingTranslation[], job: JobLease,
  valueOptions: ReasonPreparationOptions): Promise<ReasonPreparation> {
  const batch = snapshotReasonTranslationBatch(value), lease = snapshotReasonJob(job);
  const roleLease = structuredClone(valueOptions.roleLease), call = valueOptions.call;
  const reserved = valueOptions.reserved && { reservation: modelCapacityReservationSchema.parse(valueOptions.reserved.reservation),
    identity: modelCapacityRequestIdentitySchema.parse(valueOptions.reserved.identity),
    members: reasonTranslationInputSchema.shape.members.parse(valueOptions.reserved.members),
    role: structuredClone(valueOptions.reserved.role) };
  let writer: Parameters<typeof reasonWrites.set>[1] | undefined;
  try {
    const result = await onPrimary(() => db.transaction(async tx => {
      const locked = reserved ? await lockReasonTranslationModelCapacityDispatch(tx, reserved) : null;
      if (reserved && !locked) throw new ModelCapacityDeferredError('reservation_lost');
      const control = locked?.control ?? await lockModelCapacityCallerControl(tx);
      if (!reserved && control.mode === 'disabled') return { kind: 'disabled' } as const;
      if (control.mode !== 'open') throw new ModelCapacityDeferredError(control.mode === 'draining' ? 'draining' : 'disabled');
      if (!control.policy?.routes.some(route => route.routeId === 'reason-translate' && route.provider === 'abcllm' && route.model === call.model))
        throw new ModelCapacityDeferredError('unmapped');
      await assertJobBatchAdmission(tx, 'reason-translate', roleLease);
      const role = await lockReasonRole(tx, roleLease);
      const rows = await lockReasonCache(tx, batch, true), members = memberSnapshots(batch, rows);
      await assertJobLeaseAtWallTime(tx, lease, 'update');
      if (!reserved) { await assertReasonRoleWall(tx, role); return { kind: 'ready', members, role } as const; }
      if (!isDeepStrictEqual(role, reserved.role) || !isDeepStrictEqual(members, reserved.members)) throw new ReasonTranslationChanged();
      const binding = reasonTranslationDispatchBindingSchema.parse({ kind: 'reason_translation_gateway', version: 1,
        members, model: call.model, logicalWorkKey: reasonTranslationLogicalWorkKey(members),
        inputHash: reasonTranslationInputHash({ members, model: call.model }), provider: 'abcllm', routeId: 'reason-translate',
        wireHash: call.wireHash, servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound,
        chargedTokens: call.totalTokenBound, job: lease, role });
      const dispatch = await finishReasonTranslationModelCapacityDispatch(tx, locked!, binding);
      await assertReasonRoleWall(tx, role); await assertJobLeaseAtWallTime(tx, lease, 'update');
      writer = { lease, role, model: call.model, rows, used: false };
      return { kind: 'ready', dispatch } as const;
    }));
    if (result.kind === 'ready' && 'dispatch' in result) {
      const expectation = Object.freeze({ kind: 'reason_translation_write' as const });
      reasonWrites.set(expectation, writer!); // Only after actual commit ACK.
      return { ...result, expectation };
    }
    return result;
  } catch (error) {
    if (error instanceof ReasonTranslationChanged) return { kind: 'skipped' };
    if (error instanceof Error && error.message === 'reason_translation_model_reservation_lost')
      throw new ModelCapacityDeferredError('reservation_lost');
    throw error;
  }
}

async function writeReservedReasonTranslations(value: TranslationResult[], model: string, job: JobLease,
  expectation: ReasonTranslationWriteExpectation): Promise<number> {
  const proof = reasonWrites.get(expectation), results = structuredClone(value), lease = snapshotReasonJob(job);
  if (!proof || proof.used || !isDeepStrictEqual(lease, proof.lease) || model !== proof.model
    || results.length !== proof.rows.length || new Set(results.map(row => row.hash)).size !== results.length
    || results.some(row => !proof.rows.some(expected => expected.sourceHash === row.hash)
      || row.translated !== null && typeof row.translated !== 'string' || row.error !== undefined && typeof row.error !== 'string'))
    throw new Error('invalid_reason_translation_write_expectation');
  proof.used = true;
  try {
    return await onPrimary(() => db.transaction(async tx => {
      await tx.select({ role: roleLeases.role }).from(roleLeases).where(eq(roleLeases.role, proof.role.role)).for('share');
      await assertReasonRoleWall(tx, proof.role);
      const current = await lockReasonCache(tx, results.map(row => ({ hash: row.hash, body: '', attempts: 0 })), false);
      if (!isDeepStrictEqual(current, proof.rows)) throw new ReasonTranslationChanged();
      await assertJobLeaseAtWallTime(tx, lease, 'update');
      for (const result of [...results].sort((a, b) => a.hash.localeCompare(b.hash))) {
        const expected = proof.rows.find(row => row.sourceHash === result.hash)!, done = result.translated !== null;
        const error = done ? null : (result.error ?? 'invalid_output').slice(0, 60);
        const changed = expected.raw === null
          ? await tx.execute(sql`INSERT INTO text_translations
              (source_hash,target_lang,status,translated,model,attempts,error_code,retry_at,updated_at)
              VALUES (${result.hash},'ko',${done ? 'done' : 'failed'},${result.translated},${model},1,${error},
                CASE WHEN ${done} THEN NULL ELSE now()+interval '5 minutes' END,now())
              ON CONFLICT (source_hash,target_lang) DO NOTHING RETURNING source_hash`)
          : await tx.execute(sql`UPDATE text_translations t SET status=${done ? 'done' : 'failed'},
              translated=CASE WHEN ${done} THEN ${result.translated} ELSE t.translated END,model=${model},
              attempts=t.attempts+1,error_code=${error},updated_at=now(),
              retry_at=CASE WHEN ${done} THEN NULL ELSE now()+least(interval '24 hours',interval '5 minutes'*power(2,t.attempts)) END
              WHERE t.source_hash=${result.hash} AND t.target_lang='ko'
                AND to_jsonb(t)=${JSON.stringify(expected.raw)}::text::jsonb RETURNING source_hash`);
        if (changed.length !== 1) throw new ReasonTranslationChanged();
      }
      await assertReasonRoleWall(tx, proof.role); await assertJobLeaseAtWallTime(tx, lease, 'update');
      return results.length;
    }));
  } catch (error) { if (error instanceof ReasonTranslationChanged) return 0; throw error; }
}

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { crawlCandidates, crawlSettings } from '@/lib/db/schema';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { reviewHash } from '@/lib/crawl/agent-review-contract';
import { reviewCandidatePredicate } from '@/lib/crawl/agent-review-repository';
import { lockPipelineInputStages } from '@/lib/crawl/pipeline-stage-context';
import { mergeWithDefaults } from '@/lib/crawl/settings';
import type { CrawlSettings } from '@/lib/crawl/settings-schema';
import { assertJobLeaseAtWallTime, type JobLease } from '@/lib/jobs/control';
import { itemOwnerSchema, type ItemOwner } from '@/lib/jobs/items/types';
import { writerSiteActive } from '@/lib/operations/dr/epoch';
import { AGENT_DETECTOR_VERSION } from './types';
import { normalizeAgentRepositoryKey, type CollectResult } from './collect';
import { lockRepositoryAgentEvidence } from './lock';
import { agentRefreshDueAtSql } from './refresh-policy';
import { getLatestRepositoryAgentScan, persistableAgentScanResult, validatedAgentObservations, writeRepositoryAgentScanIn } from './repository';
import { agentScanRecordAllowed, lockAgentScanControl } from './claim-control';

/**
 * 제작 근거 스캔의 저장소 단위 claim(0105). 여러 서버의 consumer 가 같은 큐를 나눠 맡는다.
 *
 * - claim: fence SHARE → control SHARE(items·contract≥1) → 행 하나 FOR UPDATE SKIP LOCKED → token·epoch+1. 전역 mutex 가 없다.
 * - 기록: fence SHARE → stage SHARE → control SHARE(기록 관문·control epoch) → 저장소 identity → claim 행 FOR UPDATE(owner CAS)
 *   → 스캔 행·관측 → claim 행 갱신 → 잠근 lease_until 이 아직 살아 있는지 마지막 확인(아니면 전체 rollback).
 * - 포기: fence SHARE → control SHARE → claim 행(owner CAS, 만료돼도 다른 owner 가 없으면 푼다). 시계·실패 수는 그대로 둔다.
 * - 큐 채우기: fence SHARE → control SHARE → 채우기 advisory → claim 행들 → (jobs). identity 는 잡지 않는다.
 * TTL 120초, heartbeat 없음. consumer 는 claim 뒤 60초(AGENT_SCAN_RECORD_CUTOFF_MS)가 지나면 기록을 시작하지 않고 포기한다.
 * 시각 열은 시간대 없는 UTC 다. 비교·계산은 모두 SQL 에서 clock_timestamp() AT TIME ZONE 'UTC' 로 하고 JS 에는 ISO(Z) 문자열로만 돌려준다.
 */
export const AGENT_SCAN_CLAIM_TTL_MS = 120_000;
export const AGENT_SCAN_RECORD_CUTOFF_MS = 60_000;
/** 작을수록 먼저. 큐 채우기만 정한다(consumer 는 바꾸지 않는다) */
export const AGENT_SCAN_PRIORITY = { admin: 0, review: 1, newProduct: 2, newCandidate: 3, resume: 4, regular: 5, failing: 6 } as const;
const MAX_EPOCH = 9007199254740991;
const ISO = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const KEY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
/** 저장소 탓으로 끝난 실패만 실패 수로 센다(repository.ts 의 지수 backoff 와 같은 셋). 공급자 한도·인증 대기(retryAt)는 그 시각을 따른다 */
const REPOSITORY_FAILURE_CODES = new Set(['timeout', 'unavailable', 'invalid']);

const epochSchema = z.number().int().min(1).max(MAX_EPOCH);
const isoSchema = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
const repositoryKeySchema = z.string().max(200).regex(KEY).refine(key => key.split('/').every(part => part !== '.' && part !== '..'));
export const agentScanBindingSchema = z.strictObject({ v: z.literal(1), repositoryKey: repositoryKeySchema,
  detectorVersion: z.string().regex(/^[a-zA-Z0-9.-]{1,40}$/), scope: z.literal('') });
export type AgentScanBinding = z.infer<typeof agentScanBindingSchema>;
export const agentScanLeaseSchema = z.strictObject({ repositoryKey: repositoryKeySchema, binding: agentScanBindingSchema,
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/), owner: itemOwnerSchema, token: z.uuid(), epoch: epochSchema, controlEpoch: epochSchema,
  claimedAt: isoSchema, leaseUntil: isoSchema, priority: z.number().int().min(0).max(9), requiresDaily: z.boolean() });
/** claimedAt·leaseUntil 은 DB 시계의 관측값이다(ISO, UTC). 권한은 token·epoch·controlEpoch·bindingHash 와 DB 의 lease_until 이다 */
export type AgentScanLease = Readonly<z.infer<typeof agentScanLeaseSchema>>;
export type AgentScanIdleReason = 'fenced' | 'mode' | 'disabled' | 'detector' | 'empty';
export type AgentScanClaim = { kind: 'claimed'; lease: AgentScanLease } | { kind: 'idle'; reason: AgentScanIdleReason };
export type AgentScanRecordOutcome = 'complete' | 'partial' | 'failed' | 'cached';
export type AgentScanRecord = { outcome: AgentScanRecordOutcome; scanId: number | null; failureStreak: number; dueAt: string; retryAfter: string | null };
export type AgentScanQueueFill = { upserted: number; gone: number };

const lost = () => new Error('agent_scan_lease_lost');
function supported() { if (currentReplayDb()) throw new Error('agent_scan_replay_unsupported'); }
function agentScanBindingHash(binding: AgentScanBinding): string { return reviewHash(agentScanBindingSchema.parse(binding)); }
function parseLease(value: AgentScanLease): AgentScanLease {
  const lease = agentScanLeaseSchema.parse(structuredClone(value));
  if (lease.binding.repositoryKey !== lease.repositoryKey || agentScanBindingHash(lease.binding) !== lease.bindingHash) throw new Error('invalid_agent_scan_lease');
  return lease;
}
async function readCrawlSettings(tx: ProductTransaction): Promise<CrawlSettings> {
  const [row] = await tx.select({ values: crawlSettings.values }).from(crawlSettings).where(eq(crawlSettings.id, 1));
  return mergeWithDefaults(row?.values);
}
/** 저장소 하나의 최신 스캔(refresh 의 캐시 판단과 같은 기준: 이 탐지기 버전, 전체 범위, 가장 늦게 시작한 것) */
function latestScanSql(repositoryKey: ReturnType<typeof sql>) {
  return sql`SELECT scan.id, scan.state, scan.last_error_code, scan.next_attempt_at, scan.started_at, scan.completed_at, scan.cursor, scan.coverage
    FROM agent_repository_scans scan WHERE scan.repository_key = ${repositoryKey} AND scan.scope = '' AND scan.detector_version = ${AGENT_DETECTOR_VERSION}
    ORDER BY scan.started_at DESC, scan.id DESC LIMIT 1`;
}

type ClaimRow = { repository_key: string; token: string; instance_id: string; boot_id: string; epoch: string; control_epoch: string;
  binding_hash: string; claimed_at: string; lease_until: string; priority: number; requires_daily: boolean };

/**
 * 다음 저장소 하나를 맡는다. order 'due' 는 priority 를 무시하고 오래 기다린 것부터 고른다 — consumer 가 몇 번에 한 번 써서
 * 뒤 순위(정기·오류)도 굶지 않게 한다. idle 이유: fenced(DR 차단 DB) · mode(items 아님 또는 contract 0) · disabled(설정 꺼짐)
 * · detector(설정 탐지기 버전 ≠ 이 release) · empty(지금 맡을 저장소 없음).
 */
export async function claimAgentRepository(input: { owner: ItemOwner; order?: 'priority' | 'due' }): Promise<AgentScanClaim> {
  supported();
  const owner = itemOwnerSchema.parse(structuredClone(input.owner));
  const order = input.order === 'due' ? sql`c.due_at, c.repository_key` : sql`c.priority, c.due_at, c.repository_key`;
  const idle = (reason: AgentScanIdleReason): AgentScanClaim => ({ kind: 'idle', reason });
  return onPrimary(() => db.transaction(async tx => {
    // DR writer fence 가 첫 lock 이다. fenced DB 는 새 소유권을 내주지 않는다
    if (!await writerSiteActive(tx)) return idle('fenced');
    const control = await lockAgentScanControl(tx, 'share');
    if (control.mode !== 'items' || control.writerContractVersion < 1) return idle('mode');
    const settings = await readCrawlSettings(tx);
    if (!settings.agentEvidence.enabled) return idle('disabled');
    // release 가 섞여도(M3·Oracle) 판정이 쓰는 탐지기 버전과 다른 스캔을 만들지 않는다
    if (settings.agentEvidence.detectorVersion !== AGENT_DETECTOR_VERSION) return idle('detector');
    const [picked] = await tx.execute<{ repository_key: string }>(sql`
      SELECT c.repository_key FROM agent_repository_claims c
      WHERE c.state = 'active' AND c.due_at <= (SELECT clock_timestamp() AT TIME ZONE 'UTC')
        AND (c.retry_after IS NULL OR c.retry_after <= (SELECT clock_timestamp() AT TIME ZONE 'UTC'))
        AND (c.token IS NULL OR c.lease_until <= (SELECT clock_timestamp() AT TIME ZONE 'UTC')) AND c.epoch < ${MAX_EPOCH}
      ORDER BY ${order} LIMIT 1 FOR UPDATE OF c SKIP LOCKED`);
    if (!picked) return idle('empty');
    const binding = agentScanBindingSchema.parse({ v: 1, repositoryKey: picked.repository_key, detectorVersion: AGENT_DETECTOR_VERSION, scope: '' });
    const bindingHash = agentScanBindingHash(binding);
    // 잠근 뒤의 실제 시계로 다시 확인하고 claimed_at·lease_until 을 같은 값에서 잰다(TX 시작 시각은 owner 가 살아 있다는 근거가 아니다)
    const [row] = await tx.execute<ClaimRow>(sql`
      WITH clock AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at)
      UPDATE agent_repository_claims c SET token = ${randomUUID()}::uuid, instance_id = ${owner.instanceId}, boot_id = ${owner.bootId}::uuid,
        epoch = c.epoch + 1, control_epoch = ${control.epoch}, binding_hash = ${bindingHash},
        claimed_at = clock.at, lease_until = clock.at + ${AGENT_SCAN_CLAIM_TTL_MS} * interval '1 millisecond', updated_at = clock.at
      FROM clock
      WHERE c.repository_key = ${picked.repository_key} AND c.state = 'active' AND c.epoch < ${MAX_EPOCH}
        AND (c.token IS NULL OR c.lease_until <= clock.at)
      RETURNING c.repository_key, c.token::text AS token, c.instance_id, c.boot_id::text AS boot_id, c.epoch::text AS epoch,
        c.control_epoch::text AS control_epoch, c.binding_hash, to_char(c.claimed_at, ${ISO}) AS claimed_at,
        to_char(c.lease_until, ${ISO}) AS lease_until, c.priority, c.requires_daily`);
    if (!row) return idle('empty');
    const lease = agentScanLeaseSchema.parse({ repositoryKey: row.repository_key, binding, bindingHash: row.binding_hash,
      owner: { instanceId: row.instance_id, bootId: row.boot_id }, token: row.token, epoch: Number(row.epoch), controlEpoch: Number(row.control_epoch),
      claimedAt: row.claimed_at, leaseUntil: row.lease_until, priority: Number(row.priority), requiresDaily: row.requires_daily });
    return { kind: 'claimed', lease };
  }));
}

/** owner CAS. 잠근 뒤 같은 행을 읽는다(SELECT FOR UPDATE 의 목록 값은 잠그기 전 판일 수 있다) */
async function lockOwnedClaim(tx: ProductTransaction, lease: AgentScanLease) {
  await tx.execute(sql`SELECT 1 FROM agent_repository_claims WHERE repository_key = ${lease.repositoryKey} FOR UPDATE`);
  const [row] = await tx.execute<{ token: string | null; instance_id: string | null; boot_id: string | null; epoch: string; control_epoch: string | null;
    binding_hash: string | null; live: boolean; claimed_at: string | null; lease_until: string | null }>(sql`
    SELECT token::text AS token, instance_id, boot_id::text AS boot_id, epoch::text AS epoch, control_epoch::text AS control_epoch, binding_hash,
      coalesce(lease_until > (clock_timestamp() AT TIME ZONE 'UTC'), false) AS live,
      to_char(claimed_at, ${ISO}) AS claimed_at, lease_until::text AS lease_until
    FROM agent_repository_claims WHERE repository_key = ${lease.repositoryKey}`);
  if (!row || row.token !== lease.token || row.instance_id !== lease.owner.instanceId || row.boot_id !== lease.owner.bootId
    || Number(row.epoch) !== lease.epoch || row.control_epoch === null || Number(row.control_epoch) !== lease.controlEpoch
    || row.binding_hash !== lease.bindingHash || !row.live || !row.claimed_at || !row.lease_until) throw lost();
  return { claimedAt: new Date(row.claimed_at), leaseUntilText: row.lease_until };
}
/** 기록 TX 의 마지막 확인. 잠근 행에서 읽은 text 를 쓴다 — 호출자의 Date 는 권한이 아니다 */
async function finalAuthority(tx: ProductTransaction, leaseUntilText: string) {
  const [row] = await tx.execute<{ live: boolean }>(sql`SELECT ${leaseUntilText}::timestamp > (clock_timestamp() AT TIME ZONE 'UTC') AS live`);
  if (!row?.live) throw lost();
}

/**
 * 맡은 저장소의 수집 결과를 쓴다. result 가 null 이면 캐시(최신 스캔이 아직 다시 볼 때가 아님)라 스캔은 쓰지 않고 기한만 다시 잰다.
 * budget_exhausted 결과는 받지 않는다 — abandonAgentRepositoryClaim 으로 푼다. 소유를 잃었으면(옛 token·epoch·control epoch,
 * 만료, 모드 아님, DR fence) 'agent_scan_lease_lost' 로 아무것도 쓰지 않는다.
 *
 * 시계: 스캔 행의 started_at 은 claim 시각(DB 시계)이다. 성공하면 실패 수·retry_after 를 비우고 due_at 을 방금 쓴 최신 스캔으로 다시 잰다
 * (큐 채우기와 같은 식). 스캔 행이 없는 저장소 실패(처음 보는 저장소의 metadata 404 등)는 retry_after 를 15분×2^(n−1), 7일 상한으로 미룬다.
 */
export async function recordAgentRepositoryScan(value: AgentScanLease, result: CollectResult | null): Promise<AgentScanRecord> {
  supported();
  const lease = parseLease(value);
  if (result && (result.errorCode === 'budget_exhausted' || normalizeAgentRepositoryKey(result.repositoryKey) !== lease.repositoryKey
    || result.scope !== '' || (!result.repositoryId && !result.errorCode))) throw new Error('agent_scan_record_invalid');
  const code = result?.errorCode ?? null;
  const repositoryFailure = !!code && REPOSITORY_FAILURE_CODES.has(code) && !result?.retryAt;
  const providerWait = !!code && !repositoryFailure;
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw lost();
    await lockPipelineInputStages(tx);
    const control = await lockAgentScanControl(tx, 'share');
    if (!agentScanRecordAllowed(control, lease.controlEpoch)) throw lost();
    await lockRepositoryAgentEvidence(tx, lease.repositoryKey);
    const owned = await lockOwnedClaim(tx, lease);
    const settings = await readCrawlSettings(tx);
    if (settings.agentEvidence.detectorVersion !== lease.binding.detectorVersion || lease.binding.detectorVersion !== AGENT_DETECTOR_VERSION) throw lost();
    let scan: { id: number; state: string } | null = null;
    if (result) {
      // 같은 identity 잠금 아래에서 읽은 최신 행에 묶는다(legacy refresh 의 변환과 같은 규칙)
      const persisted = persistableAgentScanResult(result, await getLatestRepositoryAgentScan(lease.repositoryKey, '', tx));
      if (persisted.repositoryId && persisted.commitSha) {
        scan = await writeRepositoryAgentScanIn(tx, persisted, validatedAgentObservations(persisted), owned.claimedAt);
      }
    }
    const kind = !result ? 'cached' : scan ? 'scan' : 'scanless';
    const outcome: AgentScanRecordOutcome = !result ? 'cached' : code ? 'failed' : scan?.state === 'complete' ? 'complete' : 'partial';
    const keepFailure = providerWait || kind === 'cached';
    const due = agentRefreshDueAtSql(sql`latest`, sql`c.requires_daily`, settings.agentEvidence.backgroundRefreshDays, sql`clock.at`);
    const retryAt = result?.retryAt ? result.retryAt.toISOString() : null;
    const [row] = await tx.execute<{ failure_streak: number; due_at: string; retry_after: string | null }>(sql`
      WITH clock AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at)
      UPDATE agent_repository_claims c SET token = NULL, instance_id = NULL, boot_id = NULL, claimed_at = NULL, lease_until = NULL,
        control_epoch = NULL, binding_hash = NULL, last_outcome = ${outcome}, last_finished_at = clock.at, updated_at = clock.at,
        due_at = CASE WHEN ${kind !== 'scanless'} THEN coalesce((SELECT ${due} FROM (${latestScanSql(sql`c.repository_key`)}) latest), c.due_at)
          ELSE c.due_at END,
        retry_after = CASE WHEN ${kind !== 'scanless'} THEN NULL
          WHEN ${repositoryFailure} THEN clock.at + least(interval '7 days', interval '15 minutes' * power(2, least(c.failure_streak, 10)))
          ELSE greatest(clock.at, coalesce(${retryAt}::timestamp, clock.at + interval '15 minutes')) END,
        failure_streak = CASE WHEN ${repositoryFailure} THEN least(c.failure_streak + 1, 1000000) WHEN ${keepFailure} THEN c.failure_streak ELSE 0 END,
        first_failure_at = CASE WHEN ${repositoryFailure} THEN coalesce(c.first_failure_at, clock.at) WHEN ${keepFailure} THEN c.first_failure_at ELSE NULL END,
        last_error_code = CASE WHEN ${repositoryFailure} THEN ${code} WHEN ${keepFailure} THEN c.last_error_code ELSE NULL END
      FROM clock WHERE c.repository_key = ${lease.repositoryKey} AND c.token = ${lease.token}::uuid
      RETURNING c.failure_streak, to_char(c.due_at, ${ISO}) AS due_at, to_char(c.retry_after, ${ISO}) AS retry_after`);
    if (!row) throw lost();
    await finalAuthority(tx, owned.leaseUntilText);
    return { outcome, scanId: scan?.id ?? null, failureStreak: Number(row.failure_streak), dueAt: row.due_at, retryAfter: row.retry_after };
  }));
}

/**
 * 맡은 저장소를 쓰지 않고 푼다(예산 소진·종료 신호·60초 마감). due_at·retry_after·실패 수는 그대로 둔다 — 실패로 세지 않는다.
 * 만료됐어도 다른 owner 가 아직 맡지 않았으면 푼다. 이미 잃었으면 false.
 */
export async function abandonAgentRepositoryClaim(value: AgentScanLease): Promise<boolean> {
  supported();
  const lease = parseLease(value);
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return false;
    await lockAgentScanControl(tx, 'share');
    const released = await tx.execute(sql`
      UPDATE agent_repository_claims SET token = NULL, instance_id = NULL, boot_id = NULL, claimed_at = NULL, lease_until = NULL,
        control_epoch = NULL, binding_hash = NULL, last_outcome = 'abandoned', updated_at = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE repository_key = ${lease.repositoryKey} AND token = ${lease.token}::uuid AND instance_id = ${lease.owner.instanceId}
        AND boot_id = ${lease.owner.bootId}::uuid AND epoch = ${lease.epoch} AND control_epoch = ${lease.controlEpoch}
        AND binding_hash = ${lease.bindingHash}
      RETURNING repository_key`);
    return released.length === 1;
  }));
}

/**
 * 큐 채우기(컨트롤러 sweep). 수요(공개·비공개 제품 + 진행 중 후보)마다 priority·requires_daily·due_at 을 다시 재서 바뀐 행만 쓴다.
 * 살아 있는 claim 은 덮지 않는다. 수요에서 빠진 키는 지우지 않고 gone 으로 둔다. 모드와 무관하게 돈다(legacy 에서 미리 채워도 무해).
 * fenced DB 에서는 아무것도 쓰지 않고 null. lease 를 주면 같은 TX 끝에서 job lease 를 확인한다(잃었으면 전체 rollback).
 *
 * priority: 0 관리자 추가 수집(미소비 요청) · 1 1차 심사가 스캔을 기다림 · 6 오류 반복(최신 스캔 오류 또는 claim 실패 수>0)
 * · 2 스캔 없는 공개 제품(due = 제품 created_at) · 3 스캔 없는 후보 · 4 이어 하기 · 5 정기 도래. due_at 은 최신 스캔이 있으면
 * agentRefreshDueAtSql(잡의 일반 대기와 같은 식), 없으면 공개 제품 created_at → 기존 due_at → 지금 순이다.
 * 저장소 키는 수집기(normalizeAgentRepositoryKey)가 받는 모양만 넣는다.
 */
export async function fillAgentScanQueue(input: { settings: CrawlSettings; lease?: JobLease }): Promise<AgentScanQueueFill | null> {
  supported();
  const { settings } = input;
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return null;
    await lockAgentScanControl(tx, 'share');
    // 채우기끼리는 한 번에 하나(job lease 밖에서 불려도 claim 행을 서로 다른 순서로 잠그지 않게)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('agent-scan-queue-fill', 0))`);
    const due = agentRefreshDueAtSql(sql`latest`, sql`d.requires_daily`, settings.agentEvidence.backgroundRefreshDays, sql`clock.at`);
    const [row] = await tx.execute<AgentScanQueueFill>(sql`
      WITH clock AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at),
      inputs AS (
        SELECT lower(regexp_replace(repo_url, '^https://github.com/([^/]+/[^/#?]+?)([.]git)?/?$', '\\1')) AS repository_key,
          status NOT IN ('seeded', 'verified') AS requires_daily, CASE WHEN status IN ('seeded', 'verified') THEN created_at END AS public_created_at
        FROM products WHERE status != 'banned' AND repo_url ~ '^https://github.com/[^/]+/[^/#?]+/?$'
        UNION ALL
        SELECT lower(repo), true, NULL FROM crawl_candidates WHERE state IN ('new', 'needs_review', 'approved')
      ),
      demand AS (
        SELECT repository_key, bool_or(requires_daily) AS requires_daily, min(public_created_at) AS public_created_at FROM inputs
        WHERE repository_key ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' AND char_length(repository_key) <= 200
          AND split_part(repository_key, '/', 1) NOT IN ('.', '..') AND split_part(repository_key, '/', 2) NOT IN ('.', '..')
        GROUP BY repository_key
      ),
      admin AS (
        SELECT DISTINCT lower(candidate.repo) AS repository_key FROM crawl_candidates candidate
        WHERE candidate.state = 'needs_review' AND candidate.decided_by = 'auto' AND candidate.published_slug IS NULL
          AND EXISTS (SELECT 1 FROM crawl_review_attempts request WHERE request.candidate_id = candidate.id AND request.kind = 'evidence_refresh'
            AND request.id > CASE WHEN jsonb_typeof(candidate.signals->'adminEvidenceRefreshConsumedId') = 'number'
              THEN (candidate.signals->>'adminEvidenceRefreshConsumedId')::numeric ELSE 0 END)
      ),
      review AS (
        SELECT DISTINCT lower(${crawlCandidates.repo}) AS repository_key FROM ${crawlCandidates}
        WHERE ${reviewCandidatePredicate(settings, { staleScanOnly: true })}
      ),
      computed AS (
        SELECT d.repository_key, d.requires_daily,
          (CASE WHEN admin.repository_key IS NOT NULL THEN ${AGENT_SCAN_PRIORITY.admin}
            WHEN review.repository_key IS NOT NULL THEN ${AGENT_SCAN_PRIORITY.review}
            WHEN (latest.last_error_code IS NOT NULL AND latest.last_error_code <> 'alias_recheck_required')
              OR coalesce(claim.failure_streak, 0) > 0 THEN ${AGENT_SCAN_PRIORITY.failing}
            WHEN latest.id IS NULL AND d.public_created_at IS NOT NULL THEN ${AGENT_SCAN_PRIORITY.newProduct}
            WHEN latest.id IS NULL THEN ${AGENT_SCAN_PRIORITY.newCandidate}
            WHEN latest.state IN ('partial', 'complete') AND (latest.last_error_code = 'alias_recheck_required'
              OR jsonb_array_length(coalesce(latest.cursor->'pendingTrees', '[]'::jsonb)) > 0
              OR jsonb_array_length(coalesce(latest.cursor->'pendingBlobs', '[]'::jsonb)) > 0
              OR jsonb_array_length(coalesce(latest.cursor->'pendingCommits', '[]'::jsonb)) > 0) THEN ${AGENT_SCAN_PRIORITY.resume}
            ELSE ${AGENT_SCAN_PRIORITY.regular} END)::smallint AS priority,
          (CASE WHEN latest.id IS NOT NULL THEN ${due} ELSE coalesce(d.public_created_at, claim.due_at, clock.at) END)::timestamp AS due_at,
          claim.repository_key IS NOT NULL AS existing,
          claim.token IS NULL OR claim.lease_until <= clock.at AS settled,
          claim.priority AS old_priority, claim.requires_daily AS old_requires_daily, claim.due_at AS old_due_at, claim.state AS old_state
        FROM demand d CROSS JOIN clock
        LEFT JOIN LATERAL (${latestScanSql(sql`d.repository_key`)}) latest ON true
        LEFT JOIN agent_repository_claims claim ON claim.repository_key = d.repository_key
        LEFT JOIN admin ON admin.repository_key = d.repository_key
        LEFT JOIN review ON review.repository_key = d.repository_key
      ),
      upserted AS (
        INSERT INTO agent_repository_claims (repository_key, priority, requires_daily, due_at, updated_at)
        SELECT computed.repository_key, computed.priority, computed.requires_daily, computed.due_at, clock.at FROM computed CROSS JOIN clock
        WHERE NOT computed.existing OR (computed.settled AND (computed.old_priority, computed.old_requires_daily, computed.old_due_at, computed.old_state)
          IS DISTINCT FROM (computed.priority, computed.requires_daily, computed.due_at, 'active'))
        ORDER BY computed.repository_key
        ON CONFLICT (repository_key) DO UPDATE SET priority = excluded.priority, requires_daily = excluded.requires_daily,
          due_at = excluded.due_at, state = 'active', updated_at = excluded.updated_at
        WHERE (agent_repository_claims.token IS NULL OR agent_repository_claims.lease_until <= excluded.updated_at)
          AND (agent_repository_claims.priority, agent_repository_claims.requires_daily, agent_repository_claims.due_at, agent_repository_claims.state)
            IS DISTINCT FROM (excluded.priority, excluded.requires_daily, excluded.due_at, 'active')
        RETURNING 1
      ),
      gone AS (
        UPDATE agent_repository_claims c SET state = 'gone', updated_at = clock.at FROM clock
        WHERE c.state = 'active' AND (c.token IS NULL OR c.lease_until <= clock.at)
          AND NOT EXISTS (SELECT 1 FROM demand d WHERE d.repository_key = c.repository_key)
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM upserted)::int AS upserted, (SELECT count(*) FROM gone)::int AS gone`);
    if (input.lease) await assertJobLeaseAtWallTime(tx, input.lease);
    return { upserted: Number(row.upserted), gone: Number(row.gone) };
  }));
}

import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { RejectedRerunSnapshot, RejectedRerunTarget } from '@/app/(operator)/admin/review/rejected-rerun-contract';
import { db } from '@/lib/db';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import {
  crawlCandidates,
  crawlDocuments,
  crawlReviewAttempts,
  modelCapacityRequests,
  operationsAudit,
  pipelineItemLeases,
} from '@/lib/db/schema';
import { requestJob } from '@/lib/jobs/control';
import { adminAuditRow } from '@/lib/operations/admin-log';
import { DrWriterFencedError, writerSiteActive } from '@/lib/operations/dr/epoch';
import { judgeRevision } from './rules';
import { getSettings, settingsUnreadable } from './settings';
import { adminReviewListPredicates } from './admin-review-query';
import {
  candidateRevisionHash,
  listAdminReviewEntries,
  lockedInput,
  type AdminReviewEntry,
  type AdminReviewListOptions,
} from './admin-review';
import { REVIEW_FRESH_MS } from './agent-review-contract';
import { hasLiveAgentReviewItem } from './agent-review-ownership';
import { lockPipelineInputStages } from './pipeline-stage-context';

const MAX_TARGETS = 50;
const MAX_QUERY_LENGTH = 4096;
const MAX_SNAPSHOT_AGE_MS = 60 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;

const SKIP = {
  stale: '근거 갱신 필요',
  running: '진행 중',
  changed: '후보·근거 변경',
  protected: '차단·스팸 보호',
  state: '상태 변경',
  disabled: '운영 중지',
  missing: '원본 없음',
} as const;

type SkipReason = (typeof SKIP)[keyof typeof SKIP];
const KNOWN_SKIP_REASONS = new Set<string>(Object.values(SKIP));

type TargetResult = { queued: true } | { queued: false; reason: SkipReason };
type FilterScope = { where: SQL | undefined; afterId: number; upperId: number; startedAt: Date };
const STALE_AUTHORITY_MARKERS = [
  'adminReviewAttemptId',
  'adminReviewPrevious',
  'delegatedReviewAttemptId',
  'heldQwenAttemptId',
  'agentReviewAttemptId',
  'starAutoApproval',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function dateMs(value: unknown): number | null {
  const parsed = toDate(value);
  return parsed ? parsed.getTime() : null;
}

async function readDbNow(executor: typeof db | ProductTransaction): Promise<Date> {
  const [clock] = await executor.execute<{ now: string | Date }>(sql`select clock_timestamp() as now`);
  const now = toDate(clock?.now);
  if (!now) throw new Error('db_clock_unavailable');
  return now;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function assertQuery(query: unknown): void {
  if (typeof query !== 'string' || query.length === 0 || query.length > MAX_QUERY_LENGTH || query.trim().length === 0) {
    throw new Error('invalid_query');
  }
}

function normalizeActor(actor: unknown): string {
  if (typeof actor !== 'string') throw new Error('invalid_actor');
  const trimmed = actor.trim();
  if (trimmed.length < 1 || trimmed.length > 120) throw new Error('invalid_actor');
  return trimmed;
}

function assertSnapshot(snapshot: RejectedRerunSnapshot, dbNow: Date): void {
  if (!isPlainRecord(snapshot)) throw new Error('invalid_snapshot');
  assertQuery(snapshot.query);
  for (const key of ['upperId', 'afterId', 'total', 'processed', 'queued', 'skipped'] as const) {
    if (!isNonNegativeSafeInteger(snapshot[key])) throw new Error(`invalid_snapshot_${key}`);
  }
  if (snapshot.afterId > snapshot.upperId) throw new Error('invalid_snapshot_after');
  if (typeof snapshot.startedAt !== 'string') throw new Error('invalid_snapshot_started_at');
  const startedMs = Date.parse(snapshot.startedAt);
  if (!Number.isFinite(startedMs) || new Date(startedMs).toISOString() !== snapshot.startedAt) {
    throw new Error('invalid_snapshot_started_at');
  }
  const age = dbNow.getTime() - startedMs;
  if (age < 0 || age > MAX_SNAPSHOT_AGE_MS) throw new Error('invalid_snapshot_age');
  if (snapshot.processed !== snapshot.queued + snapshot.skipped) throw new Error('invalid_snapshot_counters');
  if (snapshot.skipReasons !== undefined) {
    if (!isPlainRecord(snapshot.skipReasons)) throw new Error('invalid_snapshot_skip_reasons');
    for (const [reason, count] of Object.entries(snapshot.skipReasons)) {
      if (!KNOWN_SKIP_REASONS.has(reason) || !isNonNegativeSafeInteger(count)) {
        throw new Error('invalid_snapshot_skip_reasons');
      }
    }
  }
}

function normalizeTargets(targets: unknown): RejectedRerunTarget[] {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_TARGETS) {
    throw new Error('invalid_targets');
  }
  for (const target of targets) {
    if (!isRecord(target)) throw new Error('invalid_target');
    const { repo } = target;
    if (typeof repo !== 'string' || repo.length < 1 || repo.length > 200 || repo.trim().length === 0) {
      throw new Error('invalid_target_repo');
    }
    if (!isSha256(target.inputHash) || !isSha256(target.sourceRevisionHash) || !isSha256(target.candidateRevisionHash)) {
      throw new Error('invalid_target_hashes');
    }
  }
  return targets as RejectedRerunTarget[];
}

function rejectedMembershipOptions(options: AdminReviewListOptions): AdminReviewListOptions {
  if (!options || options.state !== 'rejected') throw new Error('invalid_rejected_scope');
  const membership: AdminReviewListOptions = { ...options, state: 'rejected' };
  delete membership.offset;
  delete membership.cursor;
  delete membership.sort;
  delete membership.limit;
  delete membership.after;
  return membership;
}

function skip(reason: SkipReason): TargetResult {
  return { queued: false, reason };
}

function addReason(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

export async function prepareRejectedRerun(
  options: AdminReviewListOptions,
  query: string,
): Promise<RejectedRerunSnapshot> {
  assertQuery(query);
  const membership = rejectedMembershipOptions(options);
  const { where } = adminReviewListPredicates(membership);
  const now = await readDbNow(db);
  const [scope] = await db
    .select({
      total: sql<number>`count(*)::int`,
      upperId: sql<number>`coalesce(max(${crawlCandidates.id}), 0)::int`,
    })
    .from(crawlCandidates)
    .where(and(
      where,
      eq(crawlCandidates.state, 'rejected'),
      isNull(crawlCandidates.publishedSlug),
      lte(crawlCandidates.updatedAt, now),
    ));
  const total = Number(scope?.total ?? 0);
  const upperId = Number(scope?.upperId ?? 0);
  if (!isNonNegativeSafeInteger(total) || !isNonNegativeSafeInteger(upperId)) {
    throw new Error('invalid_prepared_scope');
  }
  return {
    query,
    upperId,
    afterId: 0,
    startedAt: now.toISOString(),
    total,
    processed: 0,
    queued: 0,
    skipped: 0,
  };
}

export async function rerunRejectedBatch(input: {
  snapshot: RejectedRerunSnapshot;
  options: AdminReviewListOptions;
  actor: string;
}): Promise<{ snapshot: RejectedRerunSnapshot; done: boolean }> {
  const actor = normalizeActor(input.actor);
  const membership = rejectedMembershipOptions(input.options);
  const dbNow = await readDbNow(db);
  assertSnapshot(input.snapshot, dbNow);

  const { where } = adminReviewListPredicates(membership);
  const startedAt = new Date(input.snapshot.startedAt);
  const nowMs = dbNow.getTime();
  const rows = await db
    .select({
      id: crawlCandidates.id,
      repo: crawlCandidates.repo,
      documentRepo: crawlDocuments.repo,
      fetchedAt: crawlDocuments.fetchedAt,
    })
    .from(crawlCandidates)
    .leftJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(and(
      where,
      eq(crawlCandidates.state, 'rejected'),
      isNull(crawlCandidates.publishedSlug),
      gt(crawlCandidates.id, input.snapshot.afterId),
      lte(crawlCandidates.id, input.snapshot.upperId),
      lte(crawlCandidates.updatedAt, startedAt),
    ))
    .orderBy(asc(crawlCandidates.id))
    .limit(MAX_TARGETS + 1);

  const done = rows.length <= MAX_TARGETS;
  const page = rows.slice(0, MAX_TARGETS);
  const freshIds: number[] = [];
  for (const row of page) {
    if (!row.documentRepo) continue;
    const fetchedMs = dateMs(row.fetchedAt);
    if (fetchedMs !== null && fetchedMs <= nowMs && nowMs - fetchedMs <= REVIEW_FRESH_MS) {
      freshIds.push(row.id);
    }
  }

  let byId = new Map<number, AdminReviewEntry>();
  if (freshIds.length > 0) {
    const settings = await getSettings();
    if (settingsUnreadable(settings)) throw new Error('settings_unreadable');
    const listed = await listAdminReviewEntries(settings, {
      state: 'rejected',
      ids: freshIds,
      limit: MAX_TARGETS,
      sort: '' as AdminReviewListOptions['sort'],
    });
    const nextById = new Map<number, AdminReviewEntry>();
    for (const entry of listed.entries) nextById.set(entry.candidate.id, entry);
    byId = nextById;
  }

  const scope: FilterScope = {
    where,
    afterId: input.snapshot.afterId,
    upperId: input.snapshot.upperId,
    startedAt,
  };
  let processed = input.snapshot.processed;
  let queued = input.snapshot.queued;
  let skipped = input.snapshot.skipped;
  const skipReasons: Record<string, number> = { ...(input.snapshot.skipReasons ?? {}) };

  const observe = (result: TargetResult): void => {
    processed += 1;
    if (result.queued) {
      queued += 1;
      return;
    }
    skipped += 1;
    addReason(skipReasons, result.reason);
  };

  for (const row of page) {
    if (!row.documentRepo) {
      observe(skip(SKIP.missing));
      continue;
    }
    const fetchedMs = dateMs(row.fetchedAt);
    if (fetchedMs === null || fetchedMs > nowMs || nowMs - fetchedMs > REVIEW_FRESH_MS) {
      observe(skip(SKIP.stale));
      continue;
    }
    const entry = byId.get(row.id);
    if (!entry || entry.candidate.repo !== row.repo) {
      observe(skip(SKIP.changed));
      continue;
    }
    if (!entry.inputHash || !entry.sourceRevisionHash) {
      observe(skip(SKIP.missing));
      continue;
    }
    if (!isSha256(entry.candidateRevisionHash)) {
      observe(skip(SKIP.changed));
      continue;
    }
    observe(await rerunRejectedTarget({
      repo: row.repo,
      inputHash: entry.inputHash,
      sourceRevisionHash: entry.sourceRevisionHash,
      candidateRevisionHash: entry.candidateRevisionHash,
    }, actor, scope));
  }

  const nextAfterId = page.length === 0 ? input.snapshot.upperId : page[page.length - 1]!.id;
  const snapshot: RejectedRerunSnapshot = {
    query: input.snapshot.query,
    upperId: input.snapshot.upperId,
    afterId: nextAfterId,
    startedAt: input.snapshot.startedAt,
    total: input.snapshot.total,
    processed,
    queued,
    skipped,
    ...(Object.keys(skipReasons).length > 0 ? { skipReasons } : {}),
  };
  return { snapshot, done };
}

export async function rerunRejectedSelection(
  targets: RejectedRerunTarget[],
  actor: string,
): Promise<{ queued: number; skipped: number; skipReasons?: Record<string, number> }> {
  const normalizedActor = normalizeActor(actor);
  const validTargets = normalizeTargets(targets);
  let queued = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};
  for (const target of validTargets) {
    const result = await rerunRejectedTarget(target, normalizedActor);
    if (result.queued) {
      queued += 1;
    } else {
      skipped += 1;
      addReason(skipReasons, result.reason);
    }
  }
  return {
    queued,
    skipped,
    ...(Object.keys(skipReasons).length > 0 ? { skipReasons } : {}),
  };
}

async function rerunRejectedTarget(
  target: RejectedRerunTarget,
  actor: string,
  scope?: FilterScope,
): Promise<TargetResult> {
  return db.transaction(async (tx): Promise<TargetResult> => {
    await tx.execute(sql`set local lock_timeout = '3s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);

    if (!(await writerSiteActive(tx))) throw new DrWriterFencedError('site_fenced');
    await lockPipelineInputStages(tx);

    const [initial] = await tx
      .select({
        id: crawlCandidates.id,
        state: crawlCandidates.state,
        reason: crawlCandidates.reason,
        publishedSlug: crawlCandidates.publishedSlug,
      })
      .from(crawlCandidates)
      .where(eq(crawlCandidates.repo, target.repo))
      .for('update');

    if (!initial || initial.state !== 'rejected' || initial.publishedSlug) {
      return skip(SKIP.state);
    }
    if (initial.reason === 'banned' || initial.reason === 'suspected_spam') {
      return skip(SKIP.protected);
    }

    const locked = await lockedInput(tx, target.repo);
    if (!locked) return skip(SKIP.missing);

    const candidate = locked.candidate;
    if (candidate.id !== initial.id || candidate.state !== 'rejected' || candidate.publishedSlug) {
      return skip(SKIP.state);
    }
    if (candidate.reason === 'banned' || candidate.reason === 'suspected_spam') {
      return skip(SKIP.protected);
    }

    if (scope) {
      const [matchesScope] = await tx
        .select({ id: crawlCandidates.id })
        .from(crawlCandidates)
        .where(and(
          eq(crawlCandidates.id, candidate.id),
          gt(crawlCandidates.id, scope.afterId),
          lte(crawlCandidates.id, scope.upperId),
          lte(crawlCandidates.updatedAt, scope.startedAt),
          eq(crawlCandidates.state, 'rejected'),
          isNull(crawlCandidates.publishedSlug),
          scope.where,
        ))
        .limit(1);
      if (!matchesScope) return skip(SKIP.changed);
    }

    const input = locked.input;
    if (!input
      || input.inputHash !== target.inputHash
      || input.sourceRevisionHash !== target.sourceRevisionHash
      || candidateRevisionHash(candidate) !== target.candidateRevisionHash) {
      return skip(SKIP.changed);
    }

    const document = locked.document;
    if ((document.productUrl ?? null) !== (candidate.productUrl ?? null)) {
      return skip(SKIP.changed);
    }
    if (!locked.settings.enabled || locked.settings.reviewMode === 'off') {
      return skip(SKIP.disabled);
    }

    const wallNow = await readDbNow(tx);
    const validUntil = dateMs(input.validUntil);
    const fetchedAt = dateMs(document.fetchedAt);
    const wallMs = wallNow.getTime();
    if (validUntil === null || validUntil <= wallMs) return skip(SKIP.stale);
    if (fetchedAt === null || fetchedAt > wallMs || wallMs - fetchedAt > REVIEW_FRESH_MS) {
      return skip(SKIP.stale);
    }

    const [running] = await tx
      .select({ id: crawlReviewAttempts.id })
      .from(crawlReviewAttempts)
      .where(and(
        eq(crawlReviewAttempts.candidateId, candidate.id),
        eq(crawlReviewAttempts.state, 'running'),
      ))
      .limit(1);
    if (running) return skip(SKIP.running);

    if (await hasLiveAgentReviewItem(tx, candidate.id)) return skip(SKIP.running);

    const [liveAi2] = await tx
      .select({ workKey: pipelineItemLeases.workKey })
      .from(pipelineItemLeases)
      .where(and(
        eq(pipelineItemLeases.stage, 'ai2'),
        sql`${pipelineItemLeases.binding}->>'candidateId' = ${String(candidate.id)}`,
        sql`${pipelineItemLeases.token} is not null`,
        sql`${pipelineItemLeases.leaseUntil} > clock_timestamp()`,
      ))
      .limit(1);
    if (liveAi2) return skip(SKIP.running);

    const [capacity] = await tx
      .select({ requestId: modelCapacityRequests.requestId })
      .from(modelCapacityRequests)
      .where(and(
        eq(modelCapacityRequests.logicalWorkKey, `ai1:${candidate.id}`),
        or(
          and(
            eq(modelCapacityRequests.state, 'waiting'),
            sql`${modelCapacityRequests.queueUntil} > clock_timestamp()`,
          ),
          and(
            eq(modelCapacityRequests.state, 'reserved'),
            sql`${modelCapacityRequests.reservedUntil} > clock_timestamp()`,
          ),
          inArray(modelCapacityRequests.state, ['dispatched', 'indeterminate']),
        ),
      ))
      .limit(1);
    if (capacity) return skip(SKIP.running);

    const requestId = randomUUID();
    const oldJudgedMs = dateMs(candidate.judgedAt);
    const judgedAt = new Date(Math.max(
      wallNow.getTime(),
      oldJudgedMs === null ? wallNow.getTime() : oldJudgedMs + 1,
    ));
    const signals: Record<string, unknown> = isRecord(candidate.signals) ? { ...candidate.signals } : {};
    signals.adminFirstReviewRerunId = requestId;
    signals.judgedRevision = judgeRevision(locked.document);
    for (const marker of STALE_AUTHORITY_MARKERS) delete signals[marker];

    const before = {
      state: candidate.state,
      reason: candidate.reason,
      decidedBy: candidate.decidedBy,
    };

    await tx
      .update(crawlCandidates)
      .set({
        state: 'needs_review' as const,
        reason: 'ambiguous' as const,
        decidedBy: 'auto' as const,
        decidedAt: null,
        signals,
        judgedAt,
        updatedAt: judgedAt,
      })
      .where(eq(crawlCandidates.id, candidate.id));

    await tx.insert(operationsAudit).values(await adminAuditRow(actor, {
      action: 'candidate-ai1-rerun',
      target: candidate.repo,
      detail: {
        requestId,
        before,
        inputHash: target.inputHash,
        sourceRevisionHash: target.sourceRevisionHash,
        candidateRevisionHash: target.candidateRevisionHash,
      },
    }));

    await requestJob('crawl-agent-review', tx);
    return { queued: true };
  });
}

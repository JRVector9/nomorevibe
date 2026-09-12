import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, crawlDocuments, crawlFrontier,
  crawlReviewAttempts, crawlSettings, type CrawlCandidate, type CrawlReviewAttempt } from '@/lib/db/schema';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { requestJob } from '@/lib/jobs/control';
import { operationsAudit } from '@/lib/db/operations-schema';
import { lockRepositoryAgentEvidence } from '@/lib/domain/evidence/agents/lock';
import { secondReviewsFor } from './second-review';
import { translationsFor } from './translations';
import { createReviewInput, MAX_REVIEW_ATTEMPTS, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewHash,
  type ReviewInput } from './agent-review-contract';
import { loadReviewInput } from './agent-review-repository';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from './settings-schema';
import { mergeWithDefaults, getSettings } from './settings';
import { judge, factsFromRepoMeta, pageFactsFromDocument, type AmbiguityCause, type RuleStep } from './rules';
import { loadAgentJudgeInputs } from './admin-review-batch';

export const MAX_EVIDENCE_REFRESHES = 2;
export const EVIDENCE_REFRESH_COOLDOWN_MS = 15 * 60_000;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const adminReviewRequestSchema = z.object({
  repo: z.string().min(1).max(200), actor: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(2000), inputHash: hash, sourceRevisionHash: hash, candidateRevisionHash: hash,
});
export type AdminReviewRequest = z.infer<typeof adminReviewRequestSchema>;
export type AdminReviewResult = { ok: true; message: string } | { ok: false; message: string };
export const candidateRevisionHash = (candidate: CrawlCandidate) => reviewHash({
  id: candidate.id, state: candidate.state, reason: candidate.reason, decidedBy: candidate.decidedBy,
  productUrl: candidate.productUrl, publishedSlug: candidate.publishedSlug, signals: candidate.signals,
  judgedAt: candidate.judgedAt?.toISOString(), decidedAt: candidate.decidedAt?.toISOString(), updatedAt: candidate.updatedAt.toISOString(),
});

/** Same lock order as review/publication, without any network call or held external operation. */
async function lockedInput(tx: ProductTransaction, repo: string) {
  const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo)).for('update');
  if (!candidate || candidate.state === 'published' || candidate.publishedSlug) return null;
  const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.repo, repo)).for('share');
  if (!document) return null;
  await tx.insert(crawlSettings).values({ id: 1, values: DEFAULT_CRAWL_SETTINGS }).onConflictDoNothing();
  const [settingsRow] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for('share');
  const settings = mergeWithDefaults(settingsRow.values);
  await lockRepositoryAgentEvidence(tx, repo.toLowerCase());
  const [scan] = await tx.select().from(agentRepositoryScans).where(and(
    eq(agentRepositoryScans.repositoryKey, repo.toLowerCase()), eq(agentRepositoryScans.scope, ''),
  )).orderBy(desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)).limit(1).for('update');
  if (scan) await tx.select({ id: agentRepositoryObservations.id }).from(agentRepositoryObservations)
    .where(eq(agentRepositoryObservations.scanId, scan.id)).for('share');
  const input = await loadReviewInput(candidate, document, settings, tx);
  return { candidate, document, settings, scan, input };
}
function matchesRequest(current: NonNullable<Awaited<ReturnType<typeof lockedInput>>>, request: AdminReviewRequest) {
  return current.input.inputHash === request.inputHash && current.input.sourceRevisionHash === request.sourceRevisionHash &&
    candidateRevisionHash(current.candidate) === request.candidateRevisionHash;
}
function auditValues(candidateId: number, input: ReviewInput, actor: string, reason: string, now: Date) {
  return { candidateId, state: 'succeeded' as const, inputHash: input.inputHash, policyHash: input.policyHash,
    sourceRevisionHash: input.sourceRevisionHash, snapshot: input.snapshot, source: input.source,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    actor, reason, startedAt: now, completedAt: now, validUntil: input.validUntil };
}

export async function overrideCandidate(request: AdminReviewRequest & {
  decision: 'approve' | 'reject'; reasonCode: 'passed' | 'personal_site' | 'not_a_product' | 'large_oss';
}): Promise<AdminReviewResult> {
  const parsed = adminReviewRequestSchema.safeParse(request);
  if (!parsed.success) return { ok: false, message: '최신 심사 화면에서 사유를 1~2000자로 입력해주세요.' };
  if (request.decision !== 'approve' && request.decision !== 'reject' ||
      request.decision === 'approve' && request.reasonCode !== 'passed' ||
      request.decision === 'reject' && !['personal_site', 'not_a_product', 'large_oss'].includes(request.reasonCode)) {
    return { ok: false, message: '알 수 없는 결정 또는 거부 사유입니다.' };
  }
  return db.transaction(async tx => {
    const current = await lockedInput(tx, parsed.data.repo);
    if (!current) return { ok: false, message: '이미 발행되었거나 심사 원본이 없는 후보입니다.' };
    if (!matchesRequest(current, parsed.data) || current.document.productUrl !== current.candidate.productUrl) {
      return { ok: false, message: '후보 또는 근거가 변경되었습니다. 새로고침 후 다시 판단해주세요.' };
    }
    const now = new Date();
    const [count] = await tx.select({ count: sql<number>`count(*)::int` }).from(crawlReviewAttempts)
      .where(and(eq(crawlReviewAttempts.candidateId, current.candidate.id), eq(crawlReviewAttempts.kind, 'admin_override')));
    await tx.update(crawlReviewAttempts).set({ state: 'superseded', errorCode: 'admin_override', completedAt: now })
      .where(and(eq(crawlReviewAttempts.candidateId, current.candidate.id), eq(crawlReviewAttempts.state, 'running')));
    const [audit] = await tx.insert(crawlReviewAttempts).values({
      ...auditValues(current.candidate.id, current.input, parsed.data.actor, parsed.data.reason, now),
      kind: 'admin_override', attemptNumber: count.count + 1,
      outcome: { decision: request.decision, reason: parsed.data.reason, evidenceIds: ['product'] },
    }).returning({ id: crawlReviewAttempts.id });
    await tx.update(crawlCandidates).set({
      state: request.decision === 'approve' ? 'approved' : 'rejected', reason: request.reasonCode,
      decidedBy: 'admin', decidedAt: now, judgedAt: now, updatedAt: now,
      signals: { ...current.candidate.signals, adminReviewAttemptId: audit.id },
    }).where(eq(crawlCandidates.id, current.candidate.id));
    if (request.decision === 'approve') await requestJob('crawl-publish', tx);
    return { ok: true, message: request.decision === 'approve' ? '관리자 승인과 사유를 기록했습니다. 발행 워커가 최종 조건을 확인합니다.' : '관리자 거부와 사유를 기록했습니다.' };
  });
}

export async function requestCandidateEvidence(request: AdminReviewRequest): Promise<AdminReviewResult> {
  const parsed = adminReviewRequestSchema.safeParse(request);
  if (!parsed.success) return { ok: false, message: '최신 심사 화면에서 수집 사유를 1~2000자로 입력해주세요.' };
  return db.transaction(async tx => {
    const current = await lockedInput(tx, parsed.data.repo);
    if (!current || current.candidate.decidedBy !== 'auto' || current.candidate.state !== 'needs_review') {
      return { ok: false, message: '자동 판정에서 보류된 후보만 추가 근거를 요청할 수 있습니다.' };
    }
    if (!matchesRequest(current, parsed.data)) return { ok: false, message: '후보 또는 근거가 변경되었습니다. 새로고침해주세요.' };
    if (!current.settings.enabled || !current.settings.agentEvidence.enabled) {
      return { ok: false, message: '크롤 수집과 개발 근거 수집을 먼저 켜주세요.' };
    }
    const previous = await tx.select().from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.candidateId, current.candidate.id), eq(crawlReviewAttempts.kind, 'evidence_refresh'),
      eq(crawlReviewAttempts.inputHash, current.input.inputHash),
    )).orderBy(desc(crawlReviewAttempts.id)).for('update');
    const now = new Date();
    if (previous.length >= MAX_EVIDENCE_REFRESHES) return { ok: false, message: '같은 입력의 추가 수집은 최대 2회입니다. 직접 확인해주세요.' };
    if (previous[0] && (previous[0].sourceRevisionHash === current.input.sourceRevisionHash ||
        previous[0].startedAt.getTime() + EVIDENCE_REFRESH_COOLDOWN_MS > now.getTime())) {
      return { ok: false, message: '이전 수집 이후 원본이 갱신되고 15분이 지나야 다시 요청할 수 있습니다.' };
    }
    const [frontier] = await tx.select().from(crawlFrontier).where(eq(crawlFrontier.repo, current.candidate.repo)).for('update');
    if (frontier && (frontier.state === 'pending' || frontier.state === 'fetching')) {
      return { ok: false, message: '이미 수집 대기 또는 진행 중입니다. 완료 후 다시 확인해주세요.' };
    }
    if (frontier) await tx.update(crawlFrontier).set({ state: 'pending', attempts: 0,
      // Error cooldowns remain in force; a completed fetch's old lease deadline is not a quota wait.
      nextAttemptAt: frontier.lastError ? sql`greatest(now(), ${crawlFrontier.nextAttemptAt})` : sql`now()`,
      updatedAt: sql`now()`,
    }).where(eq(crawlFrontier.id, frontier.id));
    else await tx.insert(crawlFrontier).values({ repo: current.candidate.repo, signal: 'admin-evidence-refresh', priority: 100 });
    if (current.scan && !current.scan.lastErrorCode && current.scan.state === 'complete') {
      await tx.update(agentRepositoryScans).set({ nextAttemptAt: sql`now()` }).where(eq(agentRepositoryScans.id, current.scan.id));
    }
    await tx.insert(crawlReviewAttempts).values({
      ...auditValues(current.candidate.id, current.input, parsed.data.actor, parsed.data.reason, now),
      kind: 'evidence_refresh', attemptNumber: previous.length + 1,
    });
    await requestJob('crawl-fetch', tx);
    await requestJob('agent-evidence-refresh', tx);
    return { ok: true, message: '추가 근거 수집을 접수했습니다. 수집 완료를 뜻하지 않으며 외부 호출 제한을 기다릴 수 있습니다.' };
  });
}

/** Called only after a fresh collector result; one accepted request permits one rule rejudge. */
export async function requeueAfterAdminEvidenceRefresh(repo: string): Promise<boolean> {
  const [pending] = await db.select({ id: crawlReviewAttempts.id }).from(crawlReviewAttempts)
    .innerJoin(crawlCandidates, eq(crawlCandidates.id, crawlReviewAttempts.candidateId)).where(and(
      eq(crawlCandidates.repo, repo), eq(crawlCandidates.decidedBy, 'auto'), eq(crawlCandidates.state, 'needs_review'),
      eq(crawlReviewAttempts.kind, 'evidence_refresh'),
    )).limit(1);
  if (!pending) return false;
  return db.transaction(async tx => {
    const current = await lockedInput(tx, repo);
    if (!current || current.candidate.decidedBy !== 'auto' || current.candidate.state !== 'needs_review') return false;
    const [request] = await tx.select().from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.candidateId, current.candidate.id), eq(crawlReviewAttempts.kind, 'evidence_refresh'),
    )).orderBy(desc(crawlReviewAttempts.id)).limit(1).for('share');
    if (!request || Number(current.candidate.signals?.adminEvidenceRefreshConsumedId ?? 0) >= request.id ||
        request.source.candidateJudgedAt !== (current.candidate.judgedAt?.toISOString() ?? null)) return false;
    const freshDocument = current.document.fetchedAt > new Date(request.source.documentFetchedAt);
    const freshScan = !!current.scan?.completedAt && current.scan.state === 'complete' && !current.scan.lastErrorCode &&
      current.scan.completedAt > new Date(request.source.scanCompletedAt ?? request.startedAt.toISOString());
    if (!freshDocument && !freshScan) return false;
    await tx.update(crawlCandidates).set({ state: 'new', reason: 'source_changed', updatedAt: new Date(),
      signals: { ...current.candidate.signals, adminEvidenceRefreshConsumedId: request.id },
    }).where(eq(crawlCandidates.id, current.candidate.id));
    await requestJob('crawl-judge', tx);
    return true;
  });
}

/**
 * 지금 기준으로 다시 판정한 결과.
 *
 * 규칙은 순수 함수이고 원본을 보관하므로, 저장된 사유 코드("ambiguous") 대신 어디까지
 * 통과했고 어디서 왜 멈췄는지를 그대로 재생할 수 있다. 화면이 규칙을 따로 구현하지
 * 않으므로 규칙을 고치면 근거도 함께 바뀐다.
 */
export type AdminReviewVerdict = {
  trace: RuleStep[];
  /** 다시 판정하며 잰 사실. 목록 요약도 이걸 써야 근거의 숫자와 어긋나지 않는다 */
  signals: Record<string, unknown>;
  cause: AmbiguityCause | null;
  state: 'approved' | 'rejected' | 'needs_review';
  reason: string;
  /** 저장된 판정과 다르면 그 뒤로 기준이 바뀐 것이다 */
  matchesStored: boolean;
};

/**
 * 한 번에 갈래를 셀 후보 수. 넘으면 세다 만 것을 화면이 밝힌다.
 *
 * 갈래는 원본을 다시 태워 얻으므로 문서를 읽어야 한다 — 실측 평균 2KB라 2,000건이 4MB
 * 남짓이다. 500이면 큐가 그보다 커진 순간 칩 합계가 큐 크기와 어긋나 오히려 헷갈린다.
 */
export const REVIEW_QUEUE_SCAN_LIMIT = 2_000;
/**
 * 갈래 버킷.
 *
 * 'resolved' 는 지금 기준으로 다시 판정하면 보류가 아닌 것 — 판정한 뒤 시간이 지나
 * 방치 기준을 넘겼거나 기준을 바꾼 경우다. 사람이 볼 필요가 없으므로 재판정으로 한 번에
 * 빠진다. 'unknown' 은 원본이 없어 되짚을 수 없는 것이고, 둘은 할 일이 전혀 다르다.
 *
 * 'ai_reject' 는 AI 심사가 거부로 판정한 것이다. 규칙이 못 가른 것을 AI가 갈랐다는 뜻이라
 * 사람은 사유만 확인하면 된다 — 목록을 손으로 옮기지 않고 갈래로 묶어 한 번에 처리한다.
 * 규칙이 지금 스스로 가르는 것('resolved')이 더 싸므로 그쪽을 먼저 본다.
 */
export type ReviewQueueBucket = AmbiguityCause | 'ai_reject' | 'resolved' | 'unknown';
export type ReviewQueueCauses = {
  counts: { cause: ReviewQueueBucket; count: number }[];
  ids: Map<ReviewQueueBucket, number[]>;
  total: number;
  truncated: boolean;
};

/**
 * 보류 후보를 갈래별로 센다.
 *
 * 저장된 사유는 전부 "ambiguous"라 목록만 봐서는 무엇을 판단해야 하는지 알 수 없다.
 * 갈래를 알면 같은 판단을 한 번에 처리할 수 있다.
 */
export async function reviewQueueCauses(settings: CrawlSettings): Promise<ReviewQueueCauses> {
  const candidates = await db.select().from(crawlCandidates)
    .where(eq(crawlCandidates.state, 'needs_review'))
    .orderBy(asc(crawlCandidates.id)).limit(REVIEW_QUEUE_SCAN_LIMIT + 1);
  const page = candidates.slice(0, REVIEW_QUEUE_SCAN_LIMIT);
  const [documents, aiAttempts] = page.length ? await Promise.all([
    db.select().from(crawlDocuments).where(inArray(crawlDocuments.repo, page.map(row => row.repo))),
    db.selectDistinctOn([crawlReviewAttempts.candidateId]).from(crawlReviewAttempts).where(and(
      inArray(crawlReviewAttempts.candidateId, page.map(row => row.id)), eq(crawlReviewAttempts.kind, 'automatic'),
    )).orderBy(crawlReviewAttempts.candidateId, desc(crawlReviewAttempts.id)),
  ]) : [[], []];
  const ids = new Map<ReviewQueueBucket, number[]>();
  for (const candidate of page) {
    const document = documents.find(row => row.repo === candidate.repo);
    const verdict = document
      ? judge(factsFromRepoMeta(candidate.repo, document.repoMeta), pageFactsFromDocument(document), settings)
      : null;
    const aiRejected = aiAttempts.find(row => row.candidateId === candidate.id)?.outcome?.decision === 'reject';
    const key: ReviewQueueBucket = !verdict ? 'unknown'
      : verdict.cause ? (aiRejected ? 'ai_reject' : verdict.cause) : 'resolved';
    ids.set(key, [...(ids.get(key) ?? []), candidate.id]);
  }
  return {
    counts: [...ids].map(([cause, list]) => ({ cause, count: list.length })).sort((a, b) => b.count - a.count),
    ids, total: page.length, truncated: candidates.length > REVIEW_QUEUE_SCAN_LIMIT,
  };
}

/**
 * 지금 기준으로는 보류가 아닌 후보를 규칙 판정으로 되돌린다.
 *
 * 판정한 뒤 시간이 지나 방치 기준을 넘겼거나 기준을 바꾸면, 저장된 상태는 보류인데 지금
 * 규칙으로는 승인이나 거부로 갈린다. 사람이 볼 필요가 없는데 큐에 남아 진짜 판단해야 할
 * 것을 가린다.
 *
 * 지우지 않는다 — state 만 new 로 되돌려 규칙이 다시 가르게 한다. 사람이 이미 결정한
 * 후보(decidedBy='admin')는 건드리지 않는다.
 */
export async function requeueResolvedCandidates(actor: string, limit = REVIEW_QUEUE_SCAN_LIMIT): Promise<{
  scanned: number; requeued: number; byReason: { reason: string; count: number }[];
}> {
  const settings = await getSettings();
  const candidates = await db.select().from(crawlCandidates).where(and(
    eq(crawlCandidates.state, 'needs_review'), eq(crawlCandidates.decidedBy, 'auto'),
  )).orderBy(asc(crawlCandidates.id)).limit(limit);
  if (!candidates.length) return { scanned: 0, requeued: 0, byReason: [] };

  const documents = await db.select().from(crawlDocuments)
    .where(inArray(crawlDocuments.repo, candidates.map(row => row.repo)));
  const resolved: { id: number; reason: string }[] = [];
  for (const candidate of candidates) {
    const document = documents.find(row => row.repo === candidate.repo);
    if (!document) continue;
    const verdict = judge(factsFromRepoMeta(candidate.repo, document.repoMeta),
      pageFactsFromDocument(document), settings);
    if (verdict.state !== 'needs_review') resolved.push({ id: candidate.id, reason: `${verdict.state}:${verdict.reason}` });
  }
  if (!resolved.length) return { scanned: candidates.length, requeued: 0, byReason: [] };

  await db.transaction(async tx => {
    // 판정 큐로만 되돌린다. 결과는 규칙이 정한다 — 여기서 승인·거부를 대신 쓰지 않는다.
    await tx.update(crawlCandidates).set({ state: 'new', updatedAt: new Date() })
      .where(and(inArray(crawlCandidates.id, resolved.map(row => row.id)), eq(crawlCandidates.state, 'needs_review')));
    await tx.insert(operationsAudit).values({ actor, action: 'requeue-resolved', target: 'crawl_candidates',
      detail: { requeued: resolved.length, scanned: candidates.length } });
    await requestJob('crawl-judge', tx);
  });

  const byReason = [...resolved.reduce((map, row) => map.set(row.reason, (map.get(row.reason) ?? 0) + 1), new Map<string, number>())]
    .map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  return { scanned: candidates.length, requeued: resolved.length, byReason };
}

export type AdminReviewStatus = 'unreviewed' | 'running' | 'succeeded' | 'failed' | 'exhausted' | 'outdated';
export function currentReviewStatus(input: ReviewInput | null, attempts: CrawlReviewAttempt[], now = new Date()): AdminReviewStatus {
  if (!input) return 'unreviewed';
  const unique = [...new Map(attempts.map(row => [row.id, row])).values()];
  const current = unique.filter(row => row.kind === 'automatic' && row.inputHash === input.inputHash &&
    row.sourceRevisionHash === input.sourceRevisionHash).sort((a, b) => b.id - a.id);
  if (current.some(row => row.state === 'running')) return 'running';
  if (current.some(row => row.state === 'succeeded' && row.validUntil > now)) return 'succeeded';
  if (current.filter(row => row.state === 'failed' || row.state === 'superseded').length >= MAX_REVIEW_ATTEMPTS) return 'exhausted';
  if (current.some(row => row.state === 'failed')) return 'failed';
  return attempts.some(row => row.kind === 'automatic') ? 'outdated' : 'unreviewed';
}
/** reasonKo: 미리 옮겨 둔 한국어 사유(translations.ts). 없으면 null — 화면이 원문과 "번역 대기"를 보여 준다 */
type AdminReviewAttempt = { kind: string; state: string; decision: string | null; confidence: number | null; reason: string | null; reasonKo: string | null; provider: string | null;
  model: string | null; actor: string | null; error: string | null; retryAfter: string | null; at: string };
function summarizeAttempt(attempt: CrawlReviewAttempt | undefined): AdminReviewAttempt | null {
  return attempt ? { kind: attempt.kind, state: attempt.state, decision: attempt.outcome?.decision ?? null,
    confidence: typeof attempt.outcome?.confidence === 'number' ? attempt.outcome.confidence : null,
    reason: attempt.reason ?? attempt.outcome?.reason ?? null, reasonKo: null, provider: attempt.provider, model: attempt.model,
    actor: attempt.actor, error: attempt.errorCode, retryAfter: attempt.retryAfter?.toISOString() ?? null,
    at: attempt.startedAt.toISOString() } : null;
}
export type AdminReviewEntry = {
  candidate: CrawlCandidate; inputHash: string | null; sourceRevisionHash: string | null; candidateRevisionHash: string;
  name: string; description: string; relationship: string; scanState: string;
  evidence: { id: string; label: string; url: string }[]; status: AdminReviewStatus; refreshCount: number;
  latest: AdminReviewAttempt | null; review: AdminReviewAttempt | null;
  verdict: AdminReviewVerdict | null;
  /** 2차 심사의 표 — 모델마다 하나. 1차와 나란히 본다 */
  seconds: { decision: string | null; confidence: number | null; reason: string | null; reasonKo: string | null; model: string | null;
    provider: string | null; status: string; trigger: string; errorCode: string | null }[];
};

/**
 * Bounded batch reads. 두 가지 넘김을 받는다 — after(id 다음부터, 끝까지 이어 읽기)와
 * offset(쪽 번호). 심사 화면은 한 화면에 들어오는 만큼만 보여 주고 쪽을 넘기므로 offset 과
 * 전체 수(total)를 쓴다.
 */
export async function listAdminReviewEntries(settings: CrawlSettings, options: {
  state?: 'pending' | 'needs_review' | 'rejected' | 'published'; after?: number; offset?: number; limit?: number;
  /** 갈래로 걸러 볼 때. 계산으로 얻은 값이라 SQL로 거를 수 없어 id 를 받는다 */
  ids?: number[];
} = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 50));
  const states = options.state === 'rejected' ? ['rejected'] as const : options.state === 'published' ? ['published'] as const :
    options.state === 'needs_review' ? ['needs_review'] as const : ['new', 'approved', 'needs_review'] as const;
  if (options.ids?.length === 0) return { entries: [] as AdminReviewEntry[], nextAfter: null, total: 0 };
  const where = and(inArray(crawlCandidates.state, [...states]),
    options.ids ? inArray(crawlCandidates.id, options.ids) : undefined,
    sql`${crawlCandidates.id} > ${Math.max(0, options.after ?? 0)}`);
  const [candidates, [{ total }]] = await Promise.all([
    db.select().from(crawlCandidates).where(where).orderBy(asc(crawlCandidates.id))
      .limit(limit + 1).offset(Math.max(0, options.offset ?? 0)),
    db.select({ total: sql<number>`count(*)::int` }).from(crawlCandidates).where(where),
  ]);
  const page = candidates.slice(0, limit);
  if (!page.length) return { entries: [] as AdminReviewEntry[], nextAfter: null, total };
  const ids = page.map(row => row.id), repos = page.map(row => row.repo);
  const [documents, scans, latest, latestAutomatic] = await Promise.all([
    db.select().from(crawlDocuments).where(inArray(crawlDocuments.repo, repos)),
    db.selectDistinctOn([agentRepositoryScans.repositoryKey]).from(agentRepositoryScans).where(and(
      inArray(agentRepositoryScans.repositoryKey, repos.map(repo => repo.toLowerCase())), eq(agentRepositoryScans.scope, ''),
    )).orderBy(agentRepositoryScans.repositoryKey, desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)),
    db.selectDistinctOn([crawlReviewAttempts.candidateId]).from(crawlReviewAttempts).where(inArray(crawlReviewAttempts.candidateId, ids))
      .orderBy(crawlReviewAttempts.candidateId, desc(crawlReviewAttempts.id)),
    db.selectDistinctOn([crawlReviewAttempts.candidateId]).from(crawlReviewAttempts).where(and(
      inArray(crawlReviewAttempts.candidateId, ids), eq(crawlReviewAttempts.kind, 'automatic')))
      .orderBy(crawlReviewAttempts.candidateId, desc(crawlReviewAttempts.id)),
  ]);
  const seconds = await secondReviewsFor(ids);
  const observations = scans.length ? await db.select().from(agentRepositoryObservations)
    .where(inArray(agentRepositoryObservations.scanId, scans.map(row => row.id))) : [];
  const inputs = page.map(candidate => {
    const document = documents.find(row => row.repo === candidate.repo);
    if (!document) return null;
    const scan = scans.find(row => row.repositoryKey === candidate.repo.toLowerCase()) ?? null;
    return createReviewInput(candidate, document, settings, { scan,
      observations: observations.filter(row => row.scanId === scan?.id).map(row => ({ id: `observation:${row.id}`, observation: row.facts })) });
  });
  const matching = inputs.flatMap((input, index) => input ? [and(eq(crawlReviewAttempts.candidateId, page[index].id),
    eq(crawlReviewAttempts.inputHash, input.inputHash), or(eq(crawlReviewAttempts.kind, 'evidence_refresh'),
      and(eq(crawlReviewAttempts.kind, 'automatic'), eq(crawlReviewAttempts.sourceRevisionHash, input.sourceRevisionHash))))!] : []);
  const current = matching.length ? await db.select().from(crawlReviewAttempts).where(or(...matching))
    .orderBy(desc(crawlReviewAttempts.id)).limit(500) : [];
  // 개발 근거를 강제할 때만 스캔을 읽는다 — 꺼져 있으면 판정이 쓰지 않는 조회다.
  // 후보마다 helper 를 부르지 않고 한꺼번에 읽는다 (후보당 SELECT 4~5번 → 화면당 2~3번)
  const agentInputs = settings.agentEvidence.enforceEligibility
    ? await loadAgentJudgeInputs(documents, settings, { scanIds: scans.map(row => row.id), observations })
    : null;

  const entries = page.map((candidate, index): AdminReviewEntry => {
    const input = inputs[index];
    const document = documents.find(row => row.repo === candidate.repo);
    const recomputed = document
      ? judge(factsFromRepoMeta(candidate.repo, document.repoMeta), pageFactsFromDocument(document),
          settings, new Date(), agentInputs?.get(candidate.repo))
      : null;
    const attempts = current.filter(row => row.candidateId === candidate.id);
    const last = latest.find(row => row.candidateId === candidate.id);
    const review = latestAutomatic.find(row => row.candidateId === candidate.id);
    return {
      candidate, inputHash: input?.inputHash ?? null, sourceRevisionHash: input?.sourceRevisionHash ?? null,
      candidateRevisionHash: candidateRevisionHash(candidate), name: input?.snapshot.product.name ?? candidate.repo,
      description: input?.snapshot.product.description ?? '', relationship: input?.snapshot.relationship ?? 'unknown',
      scanState: input?.snapshot.scanState ?? 'pending', status: currentReviewStatus(input, [...attempts, ...(review ? [review] : [])]),
      evidence: input?.snapshot.evidence.slice(0, 12).map(item => ({ id: item.id,
        label: [item.observation.kind, item.observation.sourcePath, item.observation.declaredModelId].filter(Boolean).join(' · '),
        url: item.observation.sourceUrl })) ?? [],
      refreshCount: attempts.filter(row => row.kind === 'evidence_refresh').length,
      latest: summarizeAttempt(last), review: summarizeAttempt(review),
      seconds: seconds.filter(item => item.candidateId === candidate.id).map(row => ({ decision: row.secondDecision,
        confidence: row.secondConfidence, reason: row.secondReason, reasonKo: null, model: row.model, provider: row.provider,
        status: row.status, trigger: row.trigger, errorCode: row.errorCode })),
      verdict: recomputed ? {
        trace: recomputed.trace, signals: recomputed.signals, cause: recomputed.cause ?? null,
        state: recomputed.state, reason: recomputed.reason,
        matchesStored: recomputed.state === candidate.state && recomputed.reason === candidate.reason,
      } : null,
    };
  });
  const korean = await translationsFor(entries.flatMap((entry) => [entry.review?.reason, entry.latest?.reason, ...entry.seconds.map((vote) => vote.reason)]));
  for (const entry of entries) {
    for (const part of [entry.review, entry.latest, ...entry.seconds]) if (part?.reason) part.reasonKo = korean.get(part.reason) ?? null;
  }
  return { entries, nextAfter: candidates.length > limit ? page.at(-1)!.id : null, total };
}

export type ReviewAiDecision = 'reject' | 'approve' | 'needs_review' | 'none';

/**
 * 보류 후보를 AI 1차 판단으로 나눈다.
 *
 * 후보마다 마지막으로 성공한 자동 심사의 결론이다. 실패만 있거나 아직 안 돈 것은 'none'.
 * 심사 화면이 "AI가 거부라고 한 것만" 같은 거르기에 쓴다 — 갈래와 같은 방식으로 id 를 넘긴다.
 */
export async function reviewQueueAiDecisions(): Promise<{ counts: Record<ReviewAiDecision, number>; ids: Map<ReviewAiDecision, number[]> }> {
  const candidates = await db.select({ id: crawlCandidates.id }).from(crawlCandidates)
    .where(eq(crawlCandidates.state, 'needs_review')).orderBy(asc(crawlCandidates.id)).limit(REVIEW_QUEUE_SCAN_LIMIT);
  const latest = candidates.length ? await db.selectDistinctOn([crawlReviewAttempts.candidateId], {
    candidateId: crawlReviewAttempts.candidateId, decision: sql<string | null>`${crawlReviewAttempts.outcome}->>'decision'`,
  }).from(crawlReviewAttempts).where(and(
    inArray(crawlReviewAttempts.candidateId, candidates.map(row => row.id)),
    eq(crawlReviewAttempts.kind, 'automatic'), eq(crawlReviewAttempts.state, 'succeeded'),
  )).orderBy(crawlReviewAttempts.candidateId, desc(crawlReviewAttempts.id)) : [];
  const decided = new Map(latest.map(row => [row.candidateId, row.decision]));
  const ids = new Map<ReviewAiDecision, number[]>([['reject', []], ['approve', []], ['needs_review', []], ['none', []]]);
  for (const { id } of candidates) {
    const decision = decided.get(id);
    const key: ReviewAiDecision = decision === 'reject' || decision === 'approve' || decision === 'needs_review' ? decision : 'none';
    ids.get(key)!.push(id);
  }
  const counts = Object.fromEntries([...ids].map(([key, list]) => [key, list.length])) as Record<ReviewAiDecision, number>;
  return { counts, ids };
}

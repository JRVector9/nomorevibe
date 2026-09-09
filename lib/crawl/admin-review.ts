import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, crawlDocuments, crawlFrontier,
  crawlReviewAttempts, crawlSettings, type CrawlCandidate, type CrawlReviewAttempt } from '@/lib/db/schema';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { requestJob } from '@/lib/jobs/control';
import { lockRepositoryAgentEvidence } from '@/lib/domain/evidence/agents/lock';
import { createReviewInput, MAX_REVIEW_ATTEMPTS, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewHash,
  type ReviewInput } from './agent-review-contract';
import { loadReviewInput } from './agent-review-repository';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from './settings-schema';
import { mergeWithDefaults } from './settings';
import { judge, factsFromRepoMeta, pageFactsFromDocument, type AmbiguityCause, type RuleStep } from './rules';
import { loadAgentJudgeInput } from './agent-evidence';

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

/** 한 번에 갈래를 셀 후보 수. 넘으면 세다 만 것을 화면이 밝힌다 */
export const REVIEW_QUEUE_SCAN_LIMIT = 500;
export type ReviewQueueCauses = {
  counts: { cause: AmbiguityCause | 'unknown'; count: number }[];
  ids: Map<AmbiguityCause | 'unknown', number[]>;
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
  const documents = page.length
    ? await db.select().from(crawlDocuments).where(inArray(crawlDocuments.repo, page.map(row => row.repo))) : [];
  const ids = new Map<AmbiguityCause | 'unknown', number[]>();
  for (const candidate of page) {
    const document = documents.find(row => row.repo === candidate.repo);
    const verdict = document
      ? judge(factsFromRepoMeta(candidate.repo, document.repoMeta), pageFactsFromDocument(document), settings)
      : null;
    const key = verdict?.cause ?? 'unknown';
    ids.set(key, [...(ids.get(key) ?? []), candidate.id]);
  }
  return {
    counts: [...ids].map(([cause, list]) => ({ cause, count: list.length })).sort((a, b) => b.count - a.count),
    ids, total: page.length, truncated: candidates.length > REVIEW_QUEUE_SCAN_LIMIT,
  };
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
type AdminReviewAttempt = { kind: string; state: string; decision: string | null; reason: string | null; provider: string | null;
  model: string | null; actor: string | null; error: string | null; retryAfter: string | null; at: string };
function summarizeAttempt(attempt: CrawlReviewAttempt | undefined): AdminReviewAttempt | null {
  return attempt ? { kind: attempt.kind, state: attempt.state, decision: attempt.outcome?.decision ?? null,
    reason: attempt.reason ?? attempt.outcome?.reason ?? null, provider: attempt.provider, model: attempt.model,
    actor: attempt.actor, error: attempt.errorCode, retryAfter: attempt.retryAfter?.toISOString() ?? null,
    at: attempt.startedAt.toISOString() } : null;
}
export type AdminReviewEntry = {
  candidate: CrawlCandidate; inputHash: string | null; sourceRevisionHash: string | null; candidateRevisionHash: string;
  name: string; description: string; relationship: string; scanState: string;
  evidence: { id: string; label: string; url: string }[]; status: AdminReviewStatus; refreshCount: number;
  latest: AdminReviewAttempt | null; review: AdminReviewAttempt | null;
  verdict: AdminReviewVerdict | null;
};

/** Bounded batch reads, with keyset pagination so the rest of the review queue remains reachable. */
export async function listAdminReviewEntries(settings: CrawlSettings, options: {
  state?: 'pending' | 'needs_review' | 'rejected' | 'published'; after?: number; limit?: number;
  /** 갈래로 걸러 볼 때. 계산으로 얻은 값이라 SQL로 거를 수 없어 id 를 받는다 */
  ids?: number[];
} = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 50));
  const states = options.state === 'rejected' ? ['rejected'] as const : options.state === 'published' ? ['published'] as const :
    options.state === 'needs_review' ? ['needs_review'] as const : ['new', 'approved', 'needs_review'] as const;
  if (options.ids?.length === 0) return { entries: [] as AdminReviewEntry[], nextAfter: null };
  const candidates = await db.select().from(crawlCandidates).where(and(inArray(crawlCandidates.state, [...states]),
    options.ids ? inArray(crawlCandidates.id, options.ids) : undefined,
    sql`${crawlCandidates.id} > ${Math.max(0, options.after ?? 0)}`)).orderBy(asc(crawlCandidates.id)).limit(limit + 1);
  const page = candidates.slice(0, limit);
  if (!page.length) return { entries: [] as AdminReviewEntry[], nextAfter: null };
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
  // 개발 근거를 강제할 때만 스캔을 읽는다 — 꺼져 있으면 판정이 쓰지 않는 조회다
  const agentInputs = settings.agentEvidence.enforceEligibility
    ? await Promise.all(page.map(candidate => {
        const document = documents.find(row => row.repo === candidate.repo);
        return document ? loadAgentJudgeInput(document, settings) : Promise.resolve(undefined);
      }))
    : page.map(() => undefined);

  const entries = page.map((candidate, index): AdminReviewEntry => {
    const input = inputs[index];
    const document = documents.find(row => row.repo === candidate.repo);
    const recomputed = document
      ? judge(factsFromRepoMeta(candidate.repo, document.repoMeta), pageFactsFromDocument(document),
          settings, new Date(), agentInputs[index])
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
      verdict: recomputed ? {
        trace: recomputed.trace, signals: recomputed.signals, cause: recomputed.cause ?? null,
        state: recomputed.state, reason: recomputed.reason,
        matchesStored: recomputed.state === candidate.state && recomputed.reason === candidate.reason,
      } : null,
    };
  });
  return { entries, nextAfter: candidates.length > limit ? page.at(-1)!.id : null };
}

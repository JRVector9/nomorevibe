import { emitPipelineEvent } from "@/lib/observability/review-pipeline";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, inArray, not, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { lockModelCapacityCallerControl } from "@/lib/llm/capacity-repository";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, crawlReviewAttempts, secondReviews,
  agentRepositoryScans, agentRepositoryObservations,
  type CrawlCandidate, type CrawlDocument, type CrawlReviewAttempt, type DecisionReason, type ProductStatus } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { lockRepositoryAgentEvidence } from "@/lib/domain/evidence/agents/lock";
import { agentCoverageRevisionSql } from "@/lib/domain/evidence/agents/coverage";
import { assertJobLease, assertJobLeaseAtWallTime, requestJob, type JobLease } from "@/lib/jobs/control";
import { prepareReplayFinalWrite, recordReplayFinalWrite, recordReplayFirstReviewTransition } from "@/lib/operations/pipeline-replay-final";
import { claimItemLease, readItemStage, assertItemLease, releaseItemLease } from "@/lib/jobs/items/repository";
import type { ItemOwner } from "@/lib/jobs/items/types";
import { hasLiveFetchItem } from "./fetch-ownership";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { agentReviewBinding, assertAgentReviewJob, assertAgentReviewOwnership, finishAgentReviewOwnership,
  hasLiveAgentReviewItem, liveAgentReviewItem, type Ai1ItemLease, type Ai1ReviewOrigin, type Ai1ReviewReceipt } from "./agent-review-ownership";
export type { Ai1ItemLease, Ai1ReviewOrigin, Ai1ReviewReceipt } from "./agent-review-ownership";
import { mergeWithDefaults } from "./settings";
import type { CrawlSettings } from "./settings-schema";
import { firstReviewer } from "./agent-review";
import { candidateStarAutoApproval } from "./star-auto-approval";
import { README_SAMPLE_LIMIT, README_SAMPLE_VERSION } from "./readme";
import { reviewSemanticNow, reviewSemanticNowSql, storedReviewEvidenceRequired } from "./review-replay-context";
import { judgeRevision } from "./rules";
import { lockFrontierIdentity } from "./repository";
import {
  createReviewInput, isReviewCandidate, MAX_REVIEW_ATTEMPTS,
  REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewPolicyHash, reviewHash,
  REVIEW_RETRIABLE_REASONS, validateReviewOutcome,
  type ReviewInput, type ReviewOutcome,
} from "./agent-review-contract";

type Executor = typeof db | ProductTransaction;
export async function loadReviewInput(
  candidate: CrawlCandidate, document: CrawlDocument, settings: CrawlSettings, executor: Executor = db,
): Promise<ReviewInput> {
  if (storedReviewEvidenceRequired() && (typeof document.pageMeta?.readmeSample !== "string"
    || document.pageMeta.readmeSampleVersion !== README_SAMPLE_VERSION)) throw new Error("replay_readme_evidence_missing");
  const [scan] = await executor.select().from(agentRepositoryScans).where(and(
    eq(agentRepositoryScans.repositoryKey, candidate.repo.toLowerCase()), eq(agentRepositoryScans.scope, ""),
  )).orderBy(desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)).limit(1);
  const observations = scan ? await executor.select().from(agentRepositoryObservations)
    .where(eq(agentRepositoryObservations.scanId, scan.id)).orderBy(asc(agentRepositoryObservations.id)) : [];
  return createReviewInput(candidate, document, settings, { scan: scan ?? null,
    observations: observations.map(row => ({ id: `observation:${row.id}`, observation: row.facts })) });
}

export type ReviewDomainContext = {
  candidate: CrawlCandidate; document: CrawlDocument; settings: CrawlSettings; input: ReviewInput;
};

/** Stage guards precede this domain-only lock phase. Jobs follow attempts/items. */
async function lockCurrentReviewInput(tx: ProductTransaction, expected: ReviewDomainContext): Promise<ReviewDomainContext | null> {
  const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.id, expected.candidate.id)).for("update");
  const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.id, expected.document.id)).for("share");
  const [settingsRow] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for("share");
  await lockRepositoryAgentEvidence(tx, expected.candidate.repo);
  const [scan] = await tx.select().from(agentRepositoryScans).where(and(
    eq(agentRepositoryScans.repositoryKey, expected.candidate.repo.toLowerCase()), eq(agentRepositoryScans.scope, ""),
  )).orderBy(desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)).limit(1).for("share");
  if (scan) await tx.select({ id: agentRepositoryObservations.id }).from(agentRepositoryObservations)
    .where(eq(agentRepositoryObservations.scanId, scan.id)).for("share");
  const settings = mergeWithDefaults(settingsRow?.values);
  if (!candidate || !document || !isReviewCandidate(candidate)
    || candidate.productUrl !== document.productUrl
    || !isDeepStrictEqual(candidate, expected.candidate) || !isDeepStrictEqual(document, expected.document)
    || !isDeepStrictEqual(settings, expected.settings)) return null;
  const input = await loadReviewInput(candidate, document, settings, tx);
  const now = reviewSemanticNow();
  return input.inputHash === expected.input.inputHash && input.sourceRevisionHash === expected.input.sourceRevisionHash
    && input.validUntil > now && document.fetchedAt <= now
    && (!input.source.scanCompletedAt || new Date(input.source.scanCompletedAt) <= now)
    ? { candidate, document, settings, input } : null;
}

/** Cheap current revision comparison used before LIMIT; final transactions also recompute inputHash. */
/**
 * 지금 설정으로 낸 기록만 재사용한다.
 *
 * 제공자·모델을 박아 두던 때는 1차 심사자를 바꿔도 옛 모델의 승인이 계속 맞아떨어졌다.
 * 갈아 끼운 뒤 첫 회차부터 새 심사자의 답으로만 발행되게 한다.
 */
function activeReviewIdentity(settings: CrawlSettings): SQL {
  const reviewer = firstReviewer(settings);
  return or(and(eq(crawlReviewAttempts.provider, "rules"), eq(crawlReviewAttempts.model, REVIEW_RULES_VERSION)),
    and(eq(crawlReviewAttempts.provider, reviewer?.provider ?? "claude-cli"),
      eq(crawlReviewAttempts.model, reviewer?.model ?? "")))!;
}

function matchingSource(settings: CrawlSettings): SQL {
  return sql`${crawlReviewAttempts.candidateId} = ${crawlCandidates.id}
    AND ${crawlReviewAttempts.kind} = 'automatic'
    AND ${activeReviewIdentity(settings)}
    AND ${crawlReviewAttempts.policyHash} = ${reviewPolicyHash(settings)}
    AND ${crawlReviewAttempts.promptVersion} = ${REVIEW_PROMPT_VERSION}
    AND ${crawlReviewAttempts.rulesVersion} = ${REVIEW_RULES_VERSION}
    AND (${crawlReviewAttempts.source}->>'candidateJudgedAt')::timestamp IS NOT DISTINCT FROM date_trunc('milliseconds', ${crawlCandidates.judgedAt})
    AND EXISTS (SELECT 1 FROM crawl_documents rd
      LEFT JOIN LATERAL (SELECT s.* FROM agent_repository_scans s
        WHERE s.repository_key = lower(${crawlCandidates.repo}) AND s.scope = ''
        ORDER BY s.started_at DESC, s.id DESC LIMIT 1) rs ON true
      WHERE rd.repo = ${crawlCandidates.repo}
        AND rd.id::text = ${crawlReviewAttempts.source}->>'documentId'
        AND date_trunc('milliseconds', rd.fetched_at) = (${crawlReviewAttempts.source}->>'documentFetchedAt')::timestamp
        AND rd.fetched_at <= ${reviewSemanticNowSql()}
        AND rd.product_url IS NOT DISTINCT FROM ${crawlCandidates.productUrl}
        AND rd.product_url IS NOT DISTINCT FROM ${crawlReviewAttempts.source}->>'productUrl'
        AND coalesce(${crawlReviewAttempts.snapshot}->'product'->>'readme', '') = btrim(left(
          CASE WHEN jsonb_typeof(rd.page_meta->'readmeSample') = 'string' THEN rd.page_meta->>'readmeSample' ELSE '' END,
          ${README_SAMPLE_LIMIT}), ${'\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'})
        AND rs.id::text IS NOT DISTINCT FROM ${crawlReviewAttempts.source}->>'scanId'
        AND rs.commit_sha IS NOT DISTINCT FROM ${crawlReviewAttempts.source}->>'scanSha'
        AND date_trunc('milliseconds', rs.started_at) IS NOT DISTINCT FROM (${crawlReviewAttempts.source}->>'scanStartedAt')::timestamp
        AND date_trunc('milliseconds', rs.completed_at) IS NOT DISTINCT FROM (${crawlReviewAttempts.source}->>'scanCompletedAt')::timestamp
        AND rs.state IS NOT DISTINCT FROM ${crawlReviewAttempts.source}->>'scanState'
        AND ${agentCoverageRevisionSql(sql`rs.coverage`, sql`rs.cursor`)} = coalesce(${crawlReviewAttempts.source}->'scanCoverage', '{}'::jsonb)
        AND rs.last_error_code IS NOT DISTINCT FROM ${crawlReviewAttempts.source}->>'scanError')`;
}

/**
 * 두 모델 승인 관문이 걸리는가(2026-09-19, 사용자 결정).
 *
 * enforce 에서 1차 AI 승인만으로는 발행하지 않는다 — 2차 모델도 같은 입력을 승인해야 한다(second-review.ts 의
 * ai_approved 행). 실측(블라인드 159건): 1차 혼자 승인하면 124건 중 오답 9, 둘 다 승인하면 116건 중 5.
 * 2차 심사를 끄면 관문도 꺼진다 — 켜 둔 채 표를 낼 모델이 없으면 발행이 멈추므로, 끌 때는 이 둘을 함께 생각한다.
 */
export function secondGateRequired(settings: CrawlSettings): boolean {
  return settings.reviewMode === "enforce" && settings.secondReview.enabled;
}

/** 모델 이름을 같은 모델로 본다 — "[MLX] x" 와 "x" 는 같다(review-model-identity.ts 와 같은 규칙) */
const sameModelName = (name: SQL) => sql`regexp_replace(lower(trim(${name})), '^\\[mlx\\][[:space:]]*', '', 'i')`;

/**
 * 이 1차 승인에 대해, 지금 세운 2차 모델마다 승인 표가 있는가.
 *
 * 표가 "하나라도" 승인이면 되는 것이 아니다 — 모델을 바꾸거나 더한 직후에는 빠진 모델의 옛 승인만 남아 있어,
 * 새 모델이 한 번도 보지 않은 것이 발행됐다(codex 교차 검토 P1). 지금 설정의 모델 칸마다, 그 모델이나 그 칸을
 * 대신한 대체 모델(fallback_for_id)의 승인을 찾는다. 1차와 같은 모델의 칸은 되풀이라 뺀다. 칸이 하나도 없으면
 * 두 모델 승인을 할 수 없으므로 통과시키지 않는다(그런 후보는 enqueueSecondReviews 가 사람에게 넘긴다).
 * 볼 표·실패·반대가 하나라도 열려 있으면 역시 통과시키지 않는다.
 */
function secondApproved(attempt: { id: SQL; model: SQL }, voters: { provider: string; model: string }[],
  fallbacks: { provider: string; model: string }[] = []): SQL {
  const slots = sql`jsonb_array_elements(${JSON.stringify(voters)}::jsonb) v`;
  // 대체 모델의 표는 그 모델이 지금도 대체 모델일 때만 칸을 채운다 — 설정에서 뺀 직후 정리 전에 옛 승인으로 발행되지 않게(codex 2차 P1)
  const currentFallback = sql`(g.fallback_for_id IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(fallbacks)}::jsonb) f
    WHERE f->>'provider' = g.provider AND ${sameModelName(sql`f->>'model'`)} = ${sameModelName(sql`g.model`)}))`;
  const independent = sql`${sameModelName(sql`v->>'model'`)} <> ${sameModelName(sql`coalesce(${attempt.model}, '')`)}`;
  return sql`(EXISTS (SELECT 1 FROM ${slots} WHERE ${independent})
    AND NOT EXISTS (SELECT 1 FROM ${slots} WHERE ${independent}
      AND NOT EXISTS (SELECT 1 FROM ${secondReviews} g LEFT JOIN ${secondReviews} root ON root.id = g.fallback_for_id
        WHERE g.first_attempt_id = ${attempt.id} AND g.trigger = 'ai_approved' AND g.status = 'agreed' AND g.second_decision = 'approve'
          AND coalesce(root.provider, g.provider) = v->>'provider'
          AND ${sameModelName(sql`coalesce(root.model, g.model)`)} = ${sameModelName(sql`v->>'model'`)} AND ${currentFallback}))
    AND NOT EXISTS (SELECT 1 FROM ${secondReviews} g WHERE g.first_attempt_id = ${attempt.id} AND g.trigger = 'ai_approved'
      AND g.status IN ('pending', 'failed', 'needs_human')))`;
}

/** Read-only measurement projection of the exact publication approval gate. */
export function secondReviewApprovalPredicate(settings: CrawlSettings): SQL {
  return secondApproved({ id: sql`${crawlReviewAttempts.id}`, model: sql`${crawlReviewAttempts.model}` },
    settings.secondReview.voters, settings.secondReview.fallbacks ?? []);
}

export function reviewApprovalPredicate(settings: CrawlSettings): SQL {
  if (settings.reviewMode !== "enforce") return sql`true`;
  return sql`(${crawlCandidates.decidedBy} = 'admin' OR ${starAutoApprovalPredicate(settings)} OR EXISTS (
    SELECT 1 FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
    AND ${crawlReviewAttempts.state} = 'succeeded' AND ${crawlReviewAttempts.outcome}->>'decision' = 'approve'
    AND ${crawlReviewAttempts.validUntil} > ${reviewSemanticNowSql()}
    AND ${secondGateRequired(settings) ? secondApproved({ id: sql`${crawlReviewAttempts.id}`, model: sql`${crawlReviewAttempts.model}` },
      settings.secondReview.voters, settings.secondReview.fallbacks ?? []) : sql`true`}))`;
}

/** SQL prefilter; the publication transaction repeats this check against locked rows. */
export function starAutoApprovalPredicate(settings: CrawlSettings): SQL {
  return sql`(${crawlCandidates.decidedBy} = 'auto'
    AND ${crawlCandidates.signals}->'starAutoApproval' IS NOT NULL
    AND EXISTS (SELECT 1 FROM ${crawlDocuments} popular
      WHERE popular.repo = ${crawlCandidates.repo}
        AND popular.product_url IS NOT DISTINCT FROM ${crawlCandidates.productUrl}
        AND popular.fetched_at <= ${reviewSemanticNowSql()} AND popular.fetched_at > ${reviewSemanticNowSql()} - interval '24 hours'
        AND popular.repo_meta->'private' = 'false'::jsonb
        AND popular.repo_meta->'fork' = 'false'::jsonb
        AND popular.repo_meta->'archived' = 'false'::jsonb
        AND lower(popular.repo_meta->>'full_name') = lower(${crawlCandidates.repo})
        AND CASE WHEN jsonb_typeof(popular.repo_meta->'id') = 'number'
          THEN (popular.repo_meta->>'id')::numeric > 0
            AND (popular.repo_meta->>'id')::numeric = trunc((popular.repo_meta->>'id')::numeric)
          ELSE false END
        AND CASE WHEN jsonb_typeof(popular.repo_meta->'stargazers_count') = 'number'
          THEN (popular.repo_meta->>'stargazers_count')::numeric >= ${settings.judge.autoApproveMinStars}
            AND (popular.repo_meta->>'stargazers_count')::numeric = trunc((popular.repo_meta->>'stargazers_count')::numeric)
          ELSE false END
        AND ${crawlCandidates.signals}->'starAutoApproval'->>'stars' = popular.repo_meta->>'stargazers_count'
        AND ${crawlCandidates.signals}->'starAutoApproval'->>'githubId' = popular.repo_meta->>'id'))`;
}

/** Reopen star approvals whose source expired or no longer satisfies the current threshold. */
export async function requeueInvalidStarApprovals(settings: CrawlSettings, lease: JobLease, limit = 50): Promise<number> {
  if (!settings.enabled) return 0;
  const ids = await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(and(
    eq(crawlCandidates.state, "approved"), eq(crawlCandidates.decidedBy, "auto"),
    sql`${crawlCandidates.signals}->'starAutoApproval' IS NOT NULL`, not(starAutoApprovalPredicate(settings)),
  )).orderBy(asc(crawlCandidates.updatedAt), asc(crawlCandidates.id)).limit(limit);
  let reopened = 0;
  for (const { id } of ids) {
    const changed = await db.transaction(async tx => {
      await lockPipelineInputStages(tx);
      const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.id, id)).for("update");
      if (!candidate || candidate.state !== "approved" || candidate.decidedBy !== "auto"
        || !candidate.signals?.starAutoApproval) return false;
      const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.repo, candidate.repo)).for("share");
      const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for("share");
      if (!isDeepStrictEqual(mergeWithDefaults(saved?.values), settings)) return false;
      const now = reviewSemanticNow();
      if (document && candidateStarAutoApproval(candidate, document, settings, now)) return false;
      const fresh = document && document.fetchedAt <= now
        && now.getTime() - document.fetchedAt.getTime() < 24 * 3600_000;
      let frontierBusy = false;
      if (!fresh) {
        await lockFrontierIdentity(tx, candidate.repo);
        const frontiers = await tx.select().from(crawlFrontier)
          .where(sql`lower(${crawlFrontier.repo}) = ${candidate.repo.toLowerCase()}`).for("update");
        if (frontiers.some(row => row.repo !== candidate.repo)) return false;
        const [frontier] = frontiers;
        if (!frontier) await tx.insert(crawlFrontier).values({ repo: candidate.repo,
          signal: "star-auto-source-refresh", priority: 100 });
        else frontierBusy = await hasLiveFetchItem(tx, frontier.id);
        if (frontier && !frontierBusy && frontier.state !== "pending" && frontier.state !== "fetching") {
          await tx.update(crawlFrontier).set({ state: "pending", attempts: 0,
            nextAttemptAt: frontier.lastError ? sql`greatest(now(), ${crawlFrontier.nextAttemptAt})` : sql`now()`,
            updatedAt: sql`now()` }).where(eq(crawlFrontier.id, frontier.id));
        }
      }
      // Input invalidation preserves every existing owner; it never releases a live item.
      await hasLiveAgentReviewItem(tx, candidate.id);
      const signals = { ...candidate.signals };
      if (fresh) delete signals.reconsiderAfter;
      else if (document) signals.reconsiderAfter = new Date(Math.min(document.fetchedAt.getTime(), now.getTime())).toISOString();
      await tx.update(crawlCandidates).set({ state: "new", reason: "source_changed", updatedAt: new Date(),
        signals }).where(eq(crawlCandidates.id, candidate.id));
      await requestJob(fresh ? "crawl-judge" : "crawl-fetch", tx);
      await assertJobLeaseAtWallTime(tx, lease);
      return true;
    });
    if (changed) reopened++;
  }
  return reopened;
}

/**
 * A review approval expires after its source document. Reopen only terminal frontier rows that
 * have also been idle for a day, so a reviewer outage cannot strand an auto-approved candidate
 * and a deleted repository cannot be retried on every poll.
 */
export async function requeueStaleReviewSources(
  settings: CrawlSettings,
  lease: JobLease,
  limit = 20,
): Promise<number> {
  if (!settings.enabled || settings.reviewMode === "off") return 0;
  return db.transaction(async tx => {
    await lockPipelineInputStages(tx);
    const candidates = await tx.select({ id: crawlCandidates.id, repo: crawlCandidates.repo,
      productUrl: crawlCandidates.productUrl }).from(crawlCandidates).where(and(
      eq(crawlCandidates.decidedBy, "auto"),
      or(eq(crawlCandidates.state, "approved"),
        and(eq(crawlCandidates.state, "needs_review"), inArray(crawlCandidates.reason, [...REVIEW_RETRIABLE_REASONS]))),
      sql`NOT EXISTS (SELECT 1 FROM crawl_documents review_document
        WHERE review_document.repo = ${crawlCandidates.repo}
          AND review_document.product_url IS NOT DISTINCT FROM ${crawlCandidates.productUrl}
          AND review_document.fetched_at <= ${reviewSemanticNowSql()}
          AND review_document.fetched_at > ${reviewSemanticNowSql()} - interval '24 hours')`,
      sql`NOT EXISTS (SELECT 1 FROM crawl_frontier blocked_frontier
        WHERE lower(blocked_frontier.repo) = lower(${crawlCandidates.repo})
          AND (blocked_frontier.repo <> ${crawlCandidates.repo} OR blocked_frontier.state IN ('pending', 'fetching')
            OR blocked_frontier.updated_at > clock_timestamp() - interval '24 hours'))`,
    )).orderBy(asc(crawlCandidates.updatedAt), asc(crawlCandidates.id))
      .limit(Math.max(1, Math.min(100, limit))).for("update", { skipLocked: true });
    const documents = candidates.length ? await tx.select().from(crawlDocuments)
      .where(inArray(crawlDocuments.repo, candidates.map(candidate => candidate.repo))).orderBy(asc(crawlDocuments.id)).for("share") : [];
    const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for("share");
    if (!isDeepStrictEqual(mergeWithDefaults(saved?.values), settings)) return 0;
    for (const repo of [...new Set(candidates.map(row => row.repo.toLowerCase()))].sort()) await lockFrontierIdentity(tx, repo);
    const frontiers = candidates.length ? await tx.select().from(crawlFrontier)
      .where(inArray(sql`lower(${crawlFrontier.repo})`, candidates.map(candidate => candidate.repo.toLowerCase())))
      .orderBy(asc(crawlFrontier.id)).for("update") : [];
    const wallNow = await reviewWallTime(tx), semanticNow = reviewSemanticNow();
    const targets: { candidateId: number; frontier: typeof crawlFrontier.$inferSelect; inserted: boolean }[] = [];
    for (const candidate of candidates) {
      if (documents.some(document => document.repo === candidate.repo && document.productUrl === candidate.productUrl
        && document.fetchedAt <= semanticNow && document.fetchedAt.getTime() > semanticNow.getTime() - 24 * 3600_000)) continue;
      const matching = frontiers.filter(row => row.repo.toLowerCase() === candidate.repo.toLowerCase());
      if (matching.some(row => row.repo !== candidate.repo)) continue;
      let [frontier] = matching;
      if (frontier && (frontier.state === "pending" || frontier.state === "fetching"
        || frontier.updatedAt.getTime() > wallNow.getTime() - 24 * 3600_000)) continue;
      const inserted = !frontier;
      // The already-held repository identity serializes absent-row insertion before item locks.
      if (!frontier) [frontier] = await tx.insert(crawlFrontier).values({ repo: candidate.repo,
        signal: "review-source-refresh", priority: 100 }).returning();
      targets.push({ candidateId: candidate.id, frontier, inserted });
    }
    // Finish every domain lock before inspecting items. Never reset a live fetch claim.
    const busy = new Set<number>();
    for (const target of targets) if (await hasLiveFetchItem(tx, target.frontier.id)) busy.add(target.frontier.id);
    for (const target of targets) await hasLiveAgentReviewItem(tx, target.candidateId);
    let queued = 0;
    for (const target of targets) {
      if (busy.has(target.frontier.id)) continue;
      if (!target.inserted) await tx.update(crawlFrontier).set({ state: "pending", attempts: 0,
        nextAttemptAt: sql`clock_timestamp()`, lastError: null, updatedAt: sql`clock_timestamp()` })
        .where(eq(crawlFrontier.id, target.frontier.id));
      queued++;
    }
    if (queued) await requestJob("crawl-fetch", tx);
    await assertAgentReviewJob(tx, lease);
    return queued;
  });
}

/** Hand current-source first-review failures to a person after the retry limit.
 * Retriable holds need the same exhaustion reason as approved candidates once automatic work stops.
 */
export async function handOffExhaustedFirstReviews(
  settings: CrawlSettings, lease: JobLease, limit = 20,
): Promise<number> {
  if (!settings.enabled || settings.reviewMode !== "enforce") return 0;
  return db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    if ((await readItemStage(tx, stages.ai1)).mode !== "legacy") return 0;
    const rows = await tx.select().from(crawlCandidates).where(and(
      or(eq(crawlCandidates.state, "approved"), and(eq(crawlCandidates.state, "needs_review"),
        inArray(crawlCandidates.reason, [...REVIEW_RETRIABLE_REASONS]))), eq(crawlCandidates.decidedBy, "auto"),
      not(starAutoApprovalPredicate(settings)),
      sql`EXISTS (SELECT 1 FROM ${crawlDocuments} d WHERE d.repo = ${crawlCandidates.repo}
        AND d.product_url IS NOT DISTINCT FROM ${crawlCandidates.productUrl}
        AND d.fetched_at <= ${reviewSemanticNowSql()} AND d.fetched_at > ${reviewSemanticNowSql()} - interval '24 hours')`,
      sql`(SELECT count(*) FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
        AND ${crawlReviewAttempts.state} IN ('failed', 'superseded')
        AND ${crawlReviewAttempts.errorCode} IS DISTINCT FROM 'owner_changed') >= ${MAX_REVIEW_ATTEMPTS}`,
      sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
        AND ${crawlReviewAttempts.state} = 'succeeded' AND ${crawlReviewAttempts.validUntil} > ${reviewSemanticNowSql()})`,
    )).orderBy(asc(crawlCandidates.updatedAt), asc(crawlCandidates.id))
      .limit(Math.max(1, Math.min(100, limit))).for("update", { skipLocked: true });
    if (!rows.length) return 0;
    const documents = await tx.select().from(crawlDocuments).where(inArray(crawlDocuments.repo, rows.map(row => row.repo)))
      .orderBy(asc(crawlDocuments.id)).for("share");
    const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for("share");
    if (!isDeepStrictEqual(mergeWithDefaults(saved?.values), settings)) return 0;
    const exhausted: number[] = [];
    for (const repo of [...new Set(rows.map(row => row.repo))].sort()) await lockRepositoryAgentEvidence(tx, repo);
    for (const candidate of rows) {
      const document = documents.find(row => row.repo === candidate.repo);
      if (!document) continue;
      const input = await loadReviewInput(candidate, document, settings, tx);
      if (input.validUntil <= reviewSemanticNow()) continue;
      const attempts = await tx.select().from(crawlReviewAttempts).where(and(
        eq(crawlReviewAttempts.candidateId, candidate.id), eq(crawlReviewAttempts.kind, "automatic"),
        activeReviewIdentity(settings), eq(crawlReviewAttempts.inputHash, input.inputHash),
        eq(crawlReviewAttempts.sourceRevisionHash, input.sourceRevisionHash),
        eq(crawlReviewAttempts.policyHash, input.policyHash), eq(crawlReviewAttempts.promptVersion, REVIEW_PROMPT_VERSION),
        eq(crawlReviewAttempts.rulesVersion, REVIEW_RULES_VERSION),
      )).for("share");
      if (attempts.some(attempt => attempt.state === "succeeded" && attempt.validUntil > reviewSemanticNow())) continue;
      if (attempts.filter(attempt => ["failed", "superseded"].includes(attempt.state)
        && attempt.errorCode !== "owner_changed").length >= MAX_REVIEW_ATTEMPTS) exhausted.push(candidate.id);
    }
    const unowned: number[] = [];
    for (const candidateId of exhausted) if (!await hasLiveAgentReviewItem(tx, candidateId)) unowned.push(candidateId);
    if (!unowned.length) return 0;
    const updated = await tx.update(crawlCandidates).set({
      state: "needs_review", reason: "ai_review_exhausted", updatedAt: sql`clock_timestamp()`,
      signals: sql`coalesce(${crawlCandidates.signals}, '{}'::jsonb) ||
        jsonb_build_object('firstReviewExhausted', jsonb_build_object('previousReason', ${crawlCandidates.reason}),
          'stoppedAt', jsonb_build_object('rule', 'AI 1차 심사',
          'detail', '자동 심사 재시도 한도에 도달했습니다. 사람이 확인해야 합니다.'))`,
    }).where(inArray(crawlCandidates.id, unowned)).returning({ id: crawlCandidates.id });
    await assertAgentReviewJob(tx, lease);
    return updated.length;
  });
}

/**
 * unreviewedOnly — 한 번도 심사를 통과한 적이 없는 후보만. 발행분 감사가 양보할지 가를 때 쓴다.
 *
 * 없으면 감사가 영영 돌지 않았다. 2026-09-18 프로드에서 이 목록은 여덟 번 모두 상한 100건으로 찼는데,
 * 100건 전부가 이미 심사받은 보류 건이 24시간 유효기간이 지나 다시 도는 것이었고 새 후보는 0건이었다.
 * observe 에서는 그 재심사 결과가 반영되지도 않는다. "새 후보에 양보한다"는 뜻을 지키려면 이 조건을
 * SQL 안(LIMIT 앞)에 넣어야 한다 — 목록을 받아 거르면 오래된 것부터 100건이라 새 후보가 뒤에 가려진다.
 * 기본값은 꺼져 있어 1차 심사 게이트의 동작은 그대로다.
 */
export type ReviewCandidateOptions = {
  unreviewedOnly?: boolean; excludeCandidateIds?: number[]; readyOnly?: boolean;
  /**
   * staleScanOnly — 원본은 신선한데 레포 스캔이 24시간을 넘겨 1차 심사에 들지 못하는 후보만.
   * 다른 조건은 그대로라, 스캔만 새로 하면 심사가 고를 후보와 같은 집합이다(agent-evidence-refresh 가 먼저 스캔한다).
   *
   * 없을 때는 이런 후보가 갈 곳이 없었다. 2026-10-08 프로드에서 614건이 멈춰 있었는데 그중 550건이 이 경우였다 —
   * 원본은 requeueStaleReviewSources 가 매일 다시 받는데, 스캔은 2만4천여 레포를 이름순으로 도는 일반 대기에서
   * 12일에 한 번 차례가 왔다. 그동안 심사도, 발행도, 사람 대기열에도 들지 않았다.
   */
  staleScanOnly?: boolean;
};

/** Shared by worker selection and uncapped operations queue counts. */
export function reviewCandidatePredicate(settings: CrawlSettings, options: ReviewCandidateOptions = {}): SQL {
  if (!settings.enabled || settings.reviewMode === "off") return sql`false`;
  const scanFresh = sql`(fres.completed_at <= ${reviewSemanticNowSql()} AND fres.completed_at > ${reviewSemanticNowSql()} - interval '24 hours')`;
  return and(
    not(liveAgentReviewItem(sql`${crawlCandidates.id}`)),
    options.excludeCandidateIds?.length ? notInArray(crawlCandidates.id, options.excludeCandidateIds) : undefined,
    options.readyOnly ? sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
      AND ${crawlReviewAttempts.state} = 'running' AND EXISTS (SELECT 1 FROM jobs j
        WHERE j.name = 'crawl-agent-review' AND j.lease_token = ${crawlReviewAttempts.leaseToken}
          AND j.locked_at >= clock_timestamp() - interval '90 seconds'))` : undefined,
    options.unreviewedOnly ? sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} ever
      WHERE ever.candidate_id = ${crawlCandidates.id} AND ever.state = 'succeeded')` : undefined,
    eq(crawlCandidates.decidedBy, "auto"),
    sql`NOT ${starAutoApprovalPredicate(settings)}`,
    sql`EXISTS (SELECT 1 FROM crawl_documents fd
      LEFT JOIN LATERAL (SELECT fs.completed_at FROM agent_repository_scans fs
        WHERE fs.repository_key = lower(${crawlCandidates.repo}) AND fs.scope = ''
        ORDER BY fs.started_at DESC, fs.id DESC LIMIT 1) fres ON true
      WHERE fd.repo = ${crawlCandidates.repo}
        AND fd.product_url IS NOT DISTINCT FROM ${crawlCandidates.productUrl}
        AND fd.fetched_at <= ${reviewSemanticNowSql()} AND fd.fetched_at > ${reviewSemanticNowSql()} - interval '24 hours'
        AND ${options.staleScanOnly ? sql`fres.completed_at IS NOT NULL AND NOT ${scanFresh}`
          : sql`(fres.completed_at IS NULL OR ${scanFresh})`})`,
    sql`(${crawlCandidates.state} = 'approved' OR (${crawlCandidates.state} = 'needs_review'
      AND ${inArray(crawlCandidates.reason, [...REVIEW_RETRIABLE_REASONS])}))`,
    sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
      AND ${crawlReviewAttempts.state} = 'succeeded' AND ${crawlReviewAttempts.validUntil} > ${reviewSemanticNowSql()}
      AND (${settings.reviewMode === "observe"}
        OR (${crawlCandidates.state} = 'approved' AND ${crawlReviewAttempts.outcome}->>'decision' = 'approve')
        OR (${crawlCandidates.state} = 'needs_review' AND ${crawlReviewAttempts.outcome}->>'decision' = 'needs_review')))`,
    sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
      AND ${crawlReviewAttempts.state} = 'failed' AND ${crawlReviewAttempts.retryAfter} > clock_timestamp())`,
    sql`(SELECT count(*) FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
      AND ${crawlReviewAttempts.state} IN ('failed','superseded')
      AND ${crawlReviewAttempts.errorCode} IS DISTINCT FROM 'owner_changed') < ${MAX_REVIEW_ATTEMPTS}`,
    sql`(SELECT count(*) FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
      AND ${crawlReviewAttempts.state} = 'superseded'
      AND ${crawlReviewAttempts.errorCode} = 'owner_changed'
      AND ${crawlReviewAttempts.completedAt} > clock_timestamp() - interval '24 hours') < 3`,
  )!;
}

export async function listReviewCandidates(settings: CrawlSettings, limit = 20,
  options: ReviewCandidateOptions = {}): Promise<CrawlCandidate[]> {
  if (!settings.enabled || settings.reviewMode === "off") return [];
  return db.select().from(crawlCandidates).where(reviewCandidatePredicate(settings, options)).orderBy(
    /*
     * 한 번도 심사를 통과한 적이 없는 후보가 먼저다. 그다음이 유효기간이 지나 다시 보는 것.
     *
     * 오래된 순으로만 뽑던 때는 새 후보가 굶었다. observe 에서는 재심사 결과가 후보에 기록되지 않아
     * (recordAgentReview 의 applied=false) 재심사 대상의 updatedAt 이 영영 옛날로 남고, 그래서 늘
     * 줄 맨 앞을 차지한다. 2026-09-18 프로드에서 한 번도 심사받지 못한 후보 55건이 평균 9시간,
     * 가장 오래된 것은 194시간째 기다렸고, 그동안 문은 결과가 반영되지도 않는 재심사만 돌았다.
     * false 가 true 보다 앞에 온다 — 한 번도 안 본 것(false)이 먼저다.
     */
    sql`EXISTS (SELECT 1 FROM ${crawlReviewAttempts} seen
      WHERE seen.candidate_id = ${crawlCandidates.id} AND seen.state = 'succeeded')`,
    asc(crawlCandidates.updatedAt), asc(crawlCandidates.id),
  ).limit(Math.max(1, Math.min(100, limit)));
}

/** Read-only admission, never a substitute for the later claim/result transaction. */
export async function canStartLegacyAgentReview(lease: JobLease, candidateId?: number): Promise<boolean> {
  return db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    const stage = await readItemStage(tx, stages.ai1);
    if (stage.mode !== "legacy") return false;
    if (candidateId !== undefined) {
      if (!Number.isSafeInteger(candidateId) || candidateId < 1) throw new Error("invalid_agent_review_candidate");
      const [candidate] = await tx.select({ id: crawlCandidates.id }).from(crawlCandidates)
        .where(eq(crawlCandidates.id, candidateId)).for("share");
      if (!candidate || await hasLiveAgentReviewItem(tx, candidateId)) return false;
    }
    await assertAgentReviewJob(tx, lease);
    return true;
  });
}

export type ReviewClaim = { kind: "claimed" | "reused"; attempt: CrawlReviewAttempt; receipt: Ai1ReviewReceipt }
  | { kind: "skipped"; reason: string };
type ClaimContext = ReviewDomainContext & { provider: string; model: string; now?: Date };
type ClaimAuthority = { kind: "legacy"; job: JobLease } | { kind: "item"; owner: ItemOwner; ttlMs: number };

/** Caller time is semantic/recording context; operational retry budgets use DB wall time. */
async function reviewWallTime(tx: ProductTransaction): Promise<Date> {
  const [row] = await tx.execute<{ ms: number }>(sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::double precision AS ms`);
  return new Date(row.ms);
}

export function claimAgentReview(input: ClaimContext & { lease: JobLease }): Promise<ReviewClaim> {
  return claimReview(input, { kind: "legacy", job: input.lease });
}

/** Inactive adapter only. Item provenance is not part of the legacy replay certificate. */
export async function claimItemAgentReview(input: ClaimContext & { owner: ItemOwner; ttlMs: number }): Promise<ReviewClaim> {
  if (currentReplayDb()) throw new Error("replay_item_execution_unsupported");
  return claimReview(input, { kind: "item", owner: input.owner, ttlMs: input.ttlMs });
}

async function claimReview(input: ClaimContext, authority: ClaimAuthority): Promise<ReviewClaim> {
  if (!input.settings.enabled || input.settings.reviewMode === "off") return { kind: "skipped", reason: "disabled" };
  return onPrimary(() => db.transaction(async tx => {
    // currentReplayDb revalidates the private active verified handler scope.
    // Fixed replay profiles keep their existing legacy fixture contract/grants;
    // ordinary claims always read the control before the S3/domain prefix.
    const capacity = currentReplayDb() ? null : await lockModelCapacityCallerControl(tx);
    const stages = await lockPipelineInputStages(tx);
    const stage = await readItemStage(tx, stages.ai1);
    if (stage.mode !== (authority.kind === "legacy" ? "legacy" : "items")
      || authority.kind === "item" && stage.writerContractVersion < 1) return { kind: "skipped", reason: "stage_inactive" };
    const locked = await lockCurrentReviewInput(tx, input);
    if (!locked) {
      if (authority.kind === "legacy") await assertAgentReviewJob(tx, authority.job);
      return { kind: "skipped", reason: "input_changed" };
    }
    const current = locked.input;
    const binding = agentReviewBinding(locked.candidate.id, current, { provider: input.provider, model: input.model });
    const rows = await tx.select().from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.candidateId, locked.candidate.id), eq(crawlReviewAttempts.kind, "automatic"),
      or(and(eq(crawlReviewAttempts.inputHash, current.inputHash), eq(crawlReviewAttempts.provider, input.provider),
        eq(crawlReviewAttempts.model, input.model)), eq(crawlReviewAttempts.state, "running")),
    )).orderBy(desc(crawlReviewAttempts.id)).limit(16).for("update");
    let ownership: Ai1ReviewReceipt["ownership"];
    if (authority.kind === "legacy") {
      if (await hasLiveAgentReviewItem(tx, locked.candidate.id)) {
        await assertAgentReviewJob(tx, authority.job);
        return { kind: "skipped", reason: "running" };
      }
      ownership = { kind: "legacy", stageEpoch: stage.epoch, job: authority.job };
    } else {
      const lease = await claimItemLease(tx, stages.ai1, binding, authority.owner, authority.ttlMs);
      if (!lease) return { kind: "skipped", reason: "running" };
      ownership = { kind: "item", lease: lease as Ai1ItemLease };
    }
    const token = ownership.kind === "legacy" ? ownership.job.token : ownership.lease.token;
    const now = input.now ?? new Date();
    const wallNow = await reviewWallTime(tx);
    const semanticNow = reviewSemanticNow(now);
    const claimed = async (): Promise<ReviewClaim> => {
      const running = rows.find(row => row.state === "running");
      if (running) {
        if (running.leaseToken === token) return { kind: "skipped", reason: "running" };
        await tx.update(crawlReviewAttempts).set({ state: "superseded", errorCode: "owner_changed", completedAt: wallNow })
          .where(eq(crawlReviewAttempts.id, running.id));
        running.state = "superseded";
        running.errorCode = "owner_changed";
        running.completedAt = wallNow;
      }
      const same = rows.filter(row => row.inputHash === current.inputHash && row.sourceRevisionHash === current.sourceRevisionHash
        && row.provider === input.provider && row.model === input.model);
      const success = same.find(row => row.state === "succeeded" && row.validUntil > semanticNow && row.outcome
        && row.provider === input.provider);
      const result = (attempt: CrawlReviewAttempt, origin: Ai1ReviewOrigin): ReviewClaim => ({
        kind: origin === "fresh" ? "claimed" : "reused", attempt, receipt: { attemptId: attempt.id, origin, ownership },
      });
      if (success) return result(success, "direct_reuse");
      const modelFailures = same.filter(row => (row.state === "failed" || row.state === "superseded")
        && row.errorCode !== "owner_changed").length;
      const ownerChanges = same.filter(row => row.state === "superseded" && row.errorCode === "owner_changed"
        && row.completedAt !== null && row.completedAt.getTime() > wallNow.getTime() - 24 * 60 * 60_000).length;
      if (ownerChanges >= 3) return { kind: "skipped", reason: "infrastructure_interruptions_exhausted" };
      if (input.provider !== "rules" && modelFailures >= MAX_REVIEW_ATTEMPTS)
        return { kind: "skipped", reason: "attempts_exhausted" };
      if (same.some(row => row.state === "failed" && row.retryAfter && row.retryAfter > wallNow)) {
        return { kind: "skipped", reason: "retry_wait" };
      }
      const reusable = rows.find(row => row.inputHash === current.inputHash && row.state === "succeeded"
        && row.provider === input.provider && row.model === input.model
        && row.promptVersion === REVIEW_PROMPT_VERSION && row.rulesVersion === REVIEW_RULES_VERSION && row.outcome);
      // Fresh scans may replace observation IDs without changing semantic evidence.
      const copiedOutcome = reusable?.outcome ? { ...reusable.outcome,
        evidenceIds: reusable.outcome.evidenceIds.map(id => {
          if (id === "product") return id;
          const old = reusable.snapshot.evidence.find(item => item.id === id);
          return current.snapshot.evidence.find(item => old && reviewHash(item.observation) === reviewHash(old.observation))?.id ?? id;
        }),
      } : undefined;
      if (!reusable && input.provider !== "rules" && capacity && capacity.mode !== "disabled") {
        if (capacity.mode === "draining") throw new ModelCapacityDeferredError("draining");
        const route = capacity.policy?.routes.find(route => route.routeId === "crawl-agent-review"
          && route.provider === input.provider && route.model === input.model);
        if (!route) throw new ModelCapacityDeferredError("unmapped");
        // No serving adapter currently proves actual provider termination.
        // Throw out of this TX, rolling back any preceding supersede/item claim.
        throw new ModelCapacityDeferredError("provider_contract_unavailable");
      }
      const [attempt] = await tx.insert(crawlReviewAttempts).values({
        candidateId: locked.candidate.id, kind: "automatic", state: "running",
        inputHash: current.inputHash, policyHash: current.policyHash, sourceRevisionHash: current.sourceRevisionHash,
        snapshot: current.snapshot, source: current.source,
        promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
        provider: input.provider, model: input.model, attemptNumber: same.length + 1,
        reusedFromAttemptId: reusable?.id ?? null,
        outcome: copiedOutcome ? validateReviewOutcome(current, copiedOutcome) : null,
        leaseToken: token, validUntil: current.validUntil, startedAt: now,
      }).returning();
      return result(attempt, reusable ? "semantic_reuse" : "fresh");
    };
    const result = await claimed();
    if (ownership.kind === "legacy") await assertAgentReviewJob(tx, ownership.job);
    else if (result.kind === "skipped") await releaseItemLease(tx, stages.ai1, ownership.lease);
    else await assertItemLease(tx, stages.ai1, ownership.lease);
    return result;
  }));
}

export async function recordAgentReview(input: ReviewDomainContext & {
  receipt: Ai1ReviewReceipt; outcome?: ReviewOutcome; error?: string; retryAfter?: Date; now?: Date;
  usage?: { inputTokens?: number | null; outputTokens?: number | null; costUsd?: number | null };
  /** Server-side rules only; never populated from the model response. */
  ruleRejection?: { reason: DecisionReason; existingSlug?: string; existingStatus?: ProductStatus };
}): Promise<{ applied: boolean; state: "succeeded" | "failed" | "superseded" }> {
  if (!input.receipt || !input.receipt.ownership) throw new Error("invalid_agent_review_receipt");
  if (input.receipt.ownership.kind === "item" && currentReplayDb()) throw new Error("replay_item_execution_unsupported");
  const requests: Awaited<ReturnType<typeof requestJob>>[] = [];
  const result = await db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    const locked = await lockCurrentReviewInput(tx, input);
    const current = locked?.input;
    const [attempt] = await tx.select().from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.id, input.receipt.attemptId), eq(crawlReviewAttempts.candidateId, input.candidate.id),
      eq(crawlReviewAttempts.kind, "automatic"),
    )).for("update");
    if (!attempt) throw new Error("invalid_agent_review_receipt");
    await assertAgentReviewOwnership(tx, stages.ai1, input.receipt, attempt, input.input);
    if (input.receipt.ownership.kind === "legacy") await assertAgentReviewJob(tx, input.receipt.ownership.job);
    const now = input.now ?? new Date();
    const owns = input.receipt.origin !== "direct_reuse" && attempt.state === "running";
    const reusable = attempt.state === "succeeded";
    if (!locked || !current || attempt.inputHash !== current.inputHash || attempt.sourceRevisionHash !== current.sourceRevisionHash
      || attempt.validUntil <= reviewSemanticNow()) {
      if (owns) {
        await tx.update(crawlReviewAttempts).set({ state: "superseded", errorCode: "input_changed", completedAt: now })
          .where(eq(crawlReviewAttempts.id, attempt.id));
        await recordReplayFirstReviewTransition(tx, { kind: "superseded", candidateId: attempt.candidateId, firstAttemptId: attempt.id });
      }
      await finishAgentReviewOwnership(tx, stages.ai1, input.receipt);
      return { applied: false, state: "superseded" as const };
    }
    if (!owns && !reusable) {
      await finishAgentReviewOwnership(tx, stages.ai1, input.receipt);
      return { applied: false, state: "superseded" as const };
    }
    const finalWrite = await prepareReplayFinalWrite(tx, { stage: "first", candidateId: locked.candidate.id,
      firstAttemptId: attempt.id, input: current, settings: locked.settings });
    if (input.error) {
      if (owns) await tx.update(crawlReviewAttempts).set({ state: "failed", errorCode: input.error.slice(0, 120),
        retryAfter: input.retryAfter ?? new Date((await reviewWallTime(tx)).getTime() + 60_000), completedAt: now })
        .where(eq(crawlReviewAttempts.id, attempt.id));
      await recordReplayFinalWrite(tx, finalWrite, requests);
      await finishAgentReviewOwnership(tx, stages.ai1, input.receipt);
      return { applied: false, state: reusable ? "succeeded" as const : "failed" as const };
    }
    const outcome = validateReviewOutcome(current, reusable ? attempt.outcome : input.outcome ?? attempt.outcome);
    const ruleRejection = attempt.provider === "rules" && outcome.decision === "reject" ? input.ruleRejection : undefined;
    if (owns) await tx.update(crawlReviewAttempts).set({ state: "succeeded", outcome, completedAt: now, errorCode: null,
      inputTokens: input.usage?.inputTokens ?? null, outputTokens: input.usage?.outputTokens ?? null,
      costUsd: input.usage?.costUsd ?? null }).where(eq(crawlReviewAttempts.id, attempt.id));
    const applied = locked.settings.reviewMode === "enforce";
    const kept = Object.fromEntries(Object.entries(locked.candidate.signals ?? {}).filter(([key]) => key !== "stoppedAt"));
    if (applied) await tx.update(crawlCandidates).set({
      state: outcome.decision === "approve" ? "approved" : outcome.decision === "reject" ? "rejected" : "needs_review",
      reason: ruleRejection?.reason ?? (outcome.decision === "approve" ? "passed" : outcome.decision === "reject" ? "not_a_product" : "ambiguous"),
      decidedBy: "auto", updatedAt: now,
      signals: { ...kept, agentReviewAttemptId: attempt.id,
        ...(ruleRejection?.existingSlug ? { existingSlug: ruleRejection.existingSlug, existingStatus: ruleRejection.existingStatus } : {}),
        ...(outcome.decision === "approve" ? {} : { stoppedAt: { rule: "AI 심사", detail: outcome.reason.slice(0, 300) } }) },
    }).where(eq(crawlCandidates.id, locked.candidate.id));
    // Preserve existing observe fanout, and avoid a duplicate handoff for applied history.
    if (owns || applied && locked.candidate.signals?.agentReviewAttemptId !== attempt.id) {
      if (locked.settings.secondReview.enabled && attempt.provider !== "rules")
        requests.push(await requestJob("second-review", tx));
      if (outcome.decision === "approve" && !secondGateRequired(locked.settings))
        requests.push(await requestJob("crawl-publish", tx));
    }
    await recordReplayFinalWrite(tx, finalWrite, requests);
    await finishAgentReviewOwnership(tx, stages.ai1, input.receipt);
    return { applied, state: "succeeded" as const };
  });
  for (const request of requests) emitPipelineEvent("requested", { stage: "first", candidateId: input.candidate.id,
    firstAttemptId: input.receipt.attemptId, nextJob: request.job, requestedVersion: request.requestedVersion });
  return result;
}

export class ReviewApprovalChangedError extends Error {
  constructor() { super("review_approval_changed"); }
}
export async function assertReviewApproval(tx: ProductTransaction, input: {
  candidate: CrawlCandidate; document: CrawlDocument; settings: CrawlSettings;
  input?: ReviewInput; lease: JobLease; approvalId?: number;
}): Promise<CrawlReviewAttempt | null> {
  if (input.settings.reviewMode !== "enforce" || input.candidate.decidedBy === "admin") {
    await assertJobLease(tx, input.lease);
    return null;
  }
  if (input.candidate.signals?.starAutoApproval) {
    const proof = candidateStarAutoApproval(input.candidate, input.document, input.settings, reviewSemanticNow());
    await assertJobLease(tx, input.lease);
    if (!proof || input.candidate.productUrl !== input.document.productUrl
      || input.candidate.signals.judgedRevision !== judgeRevision(input.document)) throw new ReviewApprovalChangedError();
    return null;
  }
  await lockRepositoryAgentEvidence(tx, input.candidate.repo);
  const [scan] = await tx.select().from(agentRepositoryScans).where(and(
    eq(agentRepositoryScans.repositoryKey, input.candidate.repo.toLowerCase()), eq(agentRepositoryScans.scope, ""),
  )).orderBy(desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)).limit(1).for("share");
  if (scan) await tx.select({ id: agentRepositoryObservations.id }).from(agentRepositoryObservations)
    .where(eq(agentRepositoryObservations.scanId, scan.id)).for("share");
  const current = await loadReviewInput(input.candidate, input.document, input.settings, tx);
  const [approval] = await tx.select().from(crawlReviewAttempts).where(and(
    activeReviewIdentity(input.settings),
    eq(crawlReviewAttempts.candidateId, input.candidate.id), eq(crawlReviewAttempts.kind, "automatic"),
    eq(crawlReviewAttempts.state, "succeeded"), eq(crawlReviewAttempts.inputHash, current.inputHash),
    eq(crawlReviewAttempts.sourceRevisionHash, current.sourceRevisionHash),
    eq(crawlReviewAttempts.policyHash, current.policyHash),
    eq(crawlReviewAttempts.promptVersion, REVIEW_PROMPT_VERSION), eq(crawlReviewAttempts.rulesVersion, REVIEW_RULES_VERSION),
    sql`${crawlReviewAttempts.outcome}->>'decision' = 'approve'`, sql`${crawlReviewAttempts.validUntil} > ${reviewSemanticNowSql()}`,
    input.approvalId ? eq(crawlReviewAttempts.id, input.approvalId) : undefined,
  )).orderBy(desc(crawlReviewAttempts.id)).limit(1).for("share");
  await assertJobLease(tx, input.lease);
  const now = reviewSemanticNow();
  if (!approval || current.validUntil <= now || input.document.fetchedAt > now
    || input.input && input.input.inputHash !== current.inputHash) throw new ReviewApprovalChangedError();
  validateReviewOutcome(current, approval.outcome);
  // 발행 직전에 한 번 더 — 목록을 고른 뒤 2차 표가 반대로 바뀌었을 수 있다
  if (secondGateRequired(input.settings)) {
    // 표를 잠근 뒤 같은 조건으로 다시 잰다 — 목록을 고른 뒤 표가 바뀌었을 수 있다
    await tx.select({ id: secondReviews.id }).from(secondReviews).where(eq(secondReviews.firstAttemptId, approval.id)).for("share");
    const [gate] = await tx.execute<{ ok: boolean }>(sql`select ${secondApproved({ id: sql`${approval.id}`, model: sql`${approval.model}` },
      input.settings.secondReview.voters, input.settings.secondReview.fallbacks ?? [])} as ok`);
    if (!gate?.ok) throw new ReviewApprovalChangedError();
  }
  return approval;
}

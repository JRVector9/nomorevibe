import { secondReviewHasWorkloadPool, secondReviewPoolApprovedSql } from "./second-review-workload";
import { modelRequestName } from "@/lib/llm/model-registry";
import { currentHumanModelSelection } from "@/lib/operations/human-model-source";
import { emitPipelineEvent } from "@/lib/observability/review-pipeline";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { and, asc, desc, eq, gt, inArray, lte, ne, not, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { qualifiedColumn } from "@/lib/db/qualified-column";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { lockAi1ModelCapacityDispatch, finishAi1ModelCapacityDispatch, finishAi1ItemModelCapacityDispatch, type Ai1CapacityDispatchLock, lockModelCapacityCallerControl,
  lockCliModelCapacityDispatch, finishCliModelCapacityDispatch, type CliCapacityDispatchLock } from "@/lib/llm/capacity-repository";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { NATIVE_TERMINAL_FAILURE, nativeTerminalFailure, candidateRetryCountedFailure, PROVIDER_FAILURE_CODES } from "@/lib/llm/provider-circuit-breaker";
import { modelCapacityReservationSchema, modelCapacityRequestIdentitySchema, GATEWAY_DISPATCH_PROVIDERS, type Ai1ModelDispatch, type Ai1ItemModelDispatch,
  type CliModelDispatch, type GatewayDispatchProvider, type ModelCapacityReservation, type ModelCapacityRequestIdentity } from "@/lib/llm/capacity";
import { resolveAi1GatewayServingContract, ai1GatewayServingContractHash } from "./agent-review-serving-contract";
import type { PreparedAi1GatewayCall } from "./agent-review-gateway";
import { isReviewCliProvider, reviewCliCallRefSchema, reviewCliContractMatches, reviewCliServingContract, type ReviewCliProvider } from "./review-cli-call";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, crawlReviewAttempts, secondReviews,
  agentRepositoryScans, agentRepositoryObservations, jobs, modelCapacityRequests,
  type CrawlCandidate, type CrawlDocument, type CrawlReviewAttempt, type DecisionReason, type ProductStatus } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { lockRepositoryAgentEvidence } from "@/lib/domain/evidence/agents/lock";
import { agentCoverageRevisionSql } from "@/lib/domain/evidence/agents/coverage";
import { assertJobLease, assertJobLeaseAtWallTime, requestJob, type JobLease } from "@/lib/jobs/control";
import { prepareReplayFinalWrite, recordReplayFinalWrite, recordReplayFirstReviewTransition } from "@/lib/operations/pipeline-replay-final";
import { recordHumanDecisionOverride, recordHumanDecisionRefused, recordLateWriteRefused } from "@/lib/operations/pipeline-evidence-ledger";
import { claimItemLease, readItemStage, assertItemLease, releaseItemLease, renewItemLease } from "@/lib/jobs/items/repository";
import { itemOwnerSchema, type ItemOwner } from "@/lib/jobs/items/types";
import { roleLeaseFromEnv } from "@/lib/jobs/role-leader";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { hasLiveFetchItem } from "./fetch-ownership";
import { FIRST_REVIEW_SKIP_STREAK_LIMIT, firstReviewSkipReasonText } from "./first-review-skips";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { DEEPSEEK_REVIEW_PROVIDER, deepseekActor } from './deepseek-review-policy';
import { appliedHeldQwenAttemptColumn, appliedHeldQwenAttemptSql, heldQwenGateFirstSql } from './held-qwen-retry-policy';
import { agentReviewBinding, assertAgentReviewJob, assertAgentReviewOwnership, finishAgentReviewOwnership,
  hasLiveAgentReviewItem, liveAgentReviewItem, type Ai1ItemLease, type Ai1ReviewOrigin, type Ai1ReviewReceipt } from "./agent-review-ownership";
export type { Ai1ItemLease, Ai1ReviewOrigin, Ai1ReviewReceipt } from "./agent-review-ownership";
import { mergeWithDefaults } from "./settings";
import type { CrawlSettings } from "./settings-schema";
import type { FirstReviewer } from "./agent-review";
import { ai1WithinLiveCallWindowSql } from "./ai1-live-call";
import { firstReviewRankState, firstReviewers, firstReviewerKey, firstReviewIdentitySql, hasFirstReviewer, selectFirstReviewer,
  type FirstReviewPoolPosition } from "./first-reviewers";
import { chooseReviewWorkloadMember, ensureReviewTaskRanks } from "./review-task-ranks";
import { logger } from "@/lib/observability/logger";
import { secondReviewFallbacks, secondReviewVoters } from "./second-review-voters";
import { candidateStarAutoApproval } from "./star-auto-approval";
import { README_SAMPLE_LIMIT, README_SAMPLE_VERSION } from "./readme";
import { reviewSemanticNow, reviewSemanticNowSql, storedReviewEvidenceRequired } from "./review-replay-context";
import { judgeRevision, judgeStoredDocument } from "./rules";
import { lockFrontierIdentity } from "./repository";
import {
  createReviewInput, isReviewCandidate, MAX_REVIEW_ATTEMPTS,
  REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewPolicyHash, reviewHash,
  REVIEW_RETRIABLE_REASONS, validateReviewOutcome,
  type ReviewInput, type ReviewOutcome, type ReviewEvidenceAge,
} from "./agent-review-contract";

type Executor = typeof db | ProductTransaction;

/**
 * Selection is a hint; the existing candidate/item/capacity locks still grant all authority.
 * 1차 고르기는 늘 순위 고르기다(PR C1): 「작업 ↔ 모델」 1차 AI 검수 1·2·3순위(firstReviewers). TX 밖의 첫 고르기(executor = db)는 순위·계약 스냅숏을 새로 받고,
 * 지금 쓸 수 없는 순위(계약 닫힘·CLI 계약 없음 등, firstReviewRankState().unusable)도 비켜 간다. 잠금 아래 재확인은 부르는 쪽이 준 blocked 만 본다.
 */
export async function chooseFirstReviewForCandidate(context: ReviewDomainContext, executor: Executor = db,
  blocked: ReadonlySet<string> = new Set(),
  /** 「동시에」 고르기가 줄에 설 구성원도 찾지 못해 null 을 돌려줬다(모델·장비 사정 — 후보 탓이 아니다) */
  note?: { poolBusy?: boolean }): Promise<FirstReviewer | null> {
  if (executor === db) await ensureReviewTaskRanks();
  const state = firstReviewRankState(context.settings);
  const pool = state.pool;
  if (!pool.length) return null;
  // 격리 replay(설정 행의 1차 하나 — replay 는 추가 1차를 받지 않는다)는 예전 단일 고르기의 질의 그대로다
  if (state.resolution === null && pool.length === 1) return pool[0];
  if (executor === db && state.unusable.size) blocked = new Set([...blocked, ...state.unusable.keys()]);
  // live: 지금 보내진 중일 수 있는 시도(running · 그 공급자의 호출 기한 + 여유 안에 시작) — 이보다 오래된 running 은 주인이 죽은 시도다
  const attempts = await executor.select({ provider: crawlReviewAttempts.provider, model: crawlReviewAttempts.model, state: crawlReviewAttempts.state,
    live: sql<boolean>`(${crawlReviewAttempts.state} = 'running' AND ${ai1WithinLiveCallWindowSql(crawlReviewAttempts.provider, crawlReviewAttempts.startedAt)})` })
    .from(crawlReviewAttempts).where(and(eq(crawlReviewAttempts.candidateId, context.candidate.id),
      eq(crawlReviewAttempts.kind, "automatic"), ne(crawlReviewAttempts.provider, "rules"),
      eq(crawlReviewAttempts.inputHash, context.input.inputHash))).orderBy(desc(crawlReviewAttempts.id)).limit(1);
  // 살아 있는 의도만 후보를 묶는다(2026-11-01): 기한 안의 예약(reserved), 호출 기한 + 여유 안의 보냄(dispatched), 지금 풀 모델의 줄(waiting).
  // 주인이 죽은 오래된 dispatched·미확인(indeterminate)·풀 밖 모델의 waiting 은 묶지 않는다. 장부의 같은 후보 fence 와 점유 유일 색인은 그대로라
  // 그런 행이 남아 있으면 claim 이 work_busy 로 이 후보만 넘긴다(로그·커서는 지나간다) — 두 호출이 함께 보내지지 않는다.
  const logicalKey = `ai1:${context.candidate.id}`;
  const active = currentReplayDb() ? [] : await executor.execute<{ provider: string; model: string }>(sql`
    SELECT DISTINCT provider, model FROM ((SELECT provider, model FROM model_capacity_requests
      WHERE logical_work_key = ${logicalKey} AND state = 'reserved' AND reserved_until > clock_timestamp())
    UNION ALL (SELECT provider, model FROM model_capacity_requests
      WHERE logical_work_key = ${logicalKey} AND state = 'dispatched'
        AND ${ai1WithinLiveCallWindowSql(sql`provider`, sql`coalesce(dispatched_at, updated_at)`)})
    UNION ALL (SELECT provider, model FROM model_capacity_requests
      WHERE logical_work_key = ${logicalKey} AND state = 'waiting' AND queue_until > clock_timestamp()
        AND ${firstReviewIdentitySql(pool, { provider: sql`provider`, model: sql`model` })})) ai1_intents LIMIT 2`);
  // New work only: retain every existing waiting/reserved/dispatched/live binding.
  // The locked recheck below still receives exactly one selected reviewer.
  if (executor === db && state.resolution?.execution?.mode === "workload_pool" && !active.length && !attempts[0]?.live) {
    const chosen = await chooseReviewWorkloadMember(state.resolution, blocked);
    if (!chosen) { if (note) note.poolBusy = true; return null; }
    logger.info("ai_task.workload_hint_selected", { candidateId: context.candidate.id,
      model: chosen.model, provider: chosen.provider, ...chosen.poolSelection });
    return { provider: chosen.provider, model: chosen.model };
  }
  return selectFirstReviewer(pool, context.candidate.id, attempts, Array.from(active), { blocked });
}
export async function loadReviewInput(
  candidate: CrawlCandidate, document: CrawlDocument, settings: CrawlSettings, executor: Executor = db,
  /** any_age 는 사람 몫 위임 검수와 그 승인의 발행 확인만 쓴다(agent-review-contract.ts ReviewEvidenceAge) */
  evidenceAge: ReviewEvidenceAge = "window",
): Promise<ReviewInput> {
  if (storedReviewEvidenceRequired() && (typeof document.pageMeta?.readmeSample !== "string"
    || document.pageMeta.readmeSampleVersion !== README_SAMPLE_VERSION)) throw new Error("replay_readme_evidence_missing");
  const [scan] = await executor.select().from(agentRepositoryScans).where(and(
    eq(agentRepositoryScans.repositoryKey, candidate.repo.toLowerCase()), eq(agentRepositoryScans.scope, ""),
  )).orderBy(desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)).limit(1);
  const observations = scan ? await executor.select().from(agentRepositoryObservations)
    .where(eq(agentRepositoryObservations.scanId, scan.id)).orderBy(asc(agentRepositoryObservations.id)) : [];
  return createReviewInput(candidate, document, settings, { scan: scan ?? null,
    observations: observations.map(row => ({ id: `observation:${row.id}`, observation: row.facts })) }, undefined, evidenceAge);
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

/** Read-only preparation hint. Claim and writer re-read these exact rows under locks. */
export async function loadFirstReviewConsumerContext(candidateId: number): Promise<
  { kind: "current"; context: ReviewDomainContext } | { kind: "skipped"; reason: string }
> {
  if (!Number.isSafeInteger(candidateId) || candidateId < 1) throw new Error("invalid_agent_review_candidate");
  if (currentReplayDb()) throw new Error("replay_item_execution_unsupported");
  return onPrimary(async () => {
    const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidateId));
    const [saved] = await db.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
    const settings = mergeWithDefaults(saved?.values);
    if (!settings.enabled || settings.reviewMode === "off") return { kind: "skipped", reason: "disabled" };
    if (!candidate || !isReviewCandidate(candidate)) return { kind: "skipped", reason: "input_changed" };
    const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, candidate.repo));
    if (!document || typeof document.pageMeta?.readmeSample !== "string"
      || document.pageMeta.readmeSampleVersion !== README_SAMPLE_VERSION)
      return { kind: "skipped", reason: "source_not_prepared" };
    const input = await loadReviewInput(candidate, document, settings);
    if (input.validUntil <= reviewSemanticNow()) return { kind: "skipped", reason: "input_changed" };
    return { kind: "current", context: { candidate, document, settings, input } };
  });
}

/** Original item receipt remains authoritative across renewals and current-source changes. */
export async function observeAgentReviewItemDispatch(context: ReviewDomainContext, receipt: Ai1ReviewReceipt): Promise<
  { kind: "current" } | { kind: "changed" }
> {
  if (currentReplayDb()) throw new Error("replay_item_execution_unsupported");
  if (receipt.ownership.kind !== "item") throw new Error("invalid_agent_review_receipt");
  return onPrimary(() => db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    const current = await lockCurrentReviewInput(tx, context);
    const [attempt] = await tx.select().from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.id, receipt.attemptId), eq(crawlReviewAttempts.candidateId, context.candidate.id),
    )).for("update");
    if (!attempt) throw new Error("invalid_agent_review_receipt");
    await assertAgentReviewOwnership(tx, stages.ai1, receipt, attempt, context.input);
    return { kind: current ? "current" : "changed" };
  }));
}

export async function renewAgentReviewItemOwnership(context: ReviewDomainContext, receipt: Ai1ReviewReceipt,
  ttlMs: number): Promise<Ai1ItemLease | null> {
  if (currentReplayDb()) throw new Error("replay_item_execution_unsupported");
  if (receipt.ownership.kind !== "item") throw new Error("invalid_agent_review_receipt");
  const lease = receipt.ownership.lease;
  return onPrimary(() => db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    await lockCurrentReviewInput(tx, context);
    const [attempt] = await tx.select().from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.id, receipt.attemptId), eq(crawlReviewAttempts.candidateId, context.candidate.id),
    )).for("update");
    if (!attempt) throw new Error("invalid_agent_review_receipt");
    // Generic renewal returns null on actual ownership loss. Validate the original
    // attempt/binding while allowing that operational refusal to stay null.
    try { await assertAgentReviewOwnership(tx, stages.ai1, receipt, attempt, context.input); }
    catch (error) {
      if (error instanceof Error && error.message === "item_lease_lost") return null;
      throw error;
    }
    return await renewItemLease(tx, stages.ai1, lease, ttlMs) as Ai1ItemLease | null;
  }));
}

/** Cheap current revision comparison used before LIMIT; final transactions also recompute inputHash. */
/**
 * 지금 설정으로 낸 기록만 재사용한다.
 *
 * 제공자·모델을 박아 두던 때는 1차 심사자를 바꿔도 옛 모델의 승인이 계속 맞아떨어졌다.
 * 갈아 끼운 뒤 첫 회차부터 새 심사자의 답으로만 발행되게 한다.
 */
function activeReviewIdentity(settings: CrawlSettings): SQL {
  const pool = firstReviewers(settings);
  return or(and(eq(crawlReviewAttempts.provider, "rules"), eq(crawlReviewAttempts.model, REVIEW_RULES_VERSION)),
    firstReviewIdentitySql(pool, crawlReviewAttempts))!;
}

function delegatedReviewIdentity(settings: CrawlSettings, attemptId?: string): SQL {
  const selection = currentHumanModelSelection(settings.stageModelPools?.["human-review"] ?? []);
  if (selection.source === 'unknown' || !selection.effectiveModels.length) return sql`false`;
  return sql`(${settings.humanReview.enabled}
    AND ${crawlReviewAttempts.kind} = 'delegated'
    AND ${crawlReviewAttempts.provider} = ${DEEPSEEK_REVIEW_PROVIDER}
    AND ${inArray(crawlReviewAttempts.model, selection.effectiveModels.map(modelRequestName))}
    AND ${crawlReviewAttempts.actor} = ${deepseekActor(settings.humanReview.generation)}
    AND ${crawlReviewAttempts.id}::text = ${attemptId === undefined ? sql`${crawlCandidates.signals}->>'delegatedReviewAttemptId'` : attemptId})`;
}

/** Retry budgets survive model removal; a different worker is not a fresh attempt budget. */
function retryReviewIdentity(): SQL {
  return and(eq(crawlReviewAttempts.kind, "automatic"), or(ne(crawlReviewAttempts.provider, "rules"),
    and(eq(crawlReviewAttempts.provider, "rules"), eq(crawlReviewAttempts.model, REVIEW_RULES_VERSION))))!;
}

/**
 * 후보의 재시도 예산에 세는 실패인가. 제공자·게이트웨이 장애와 워커 중단은 후보 탓이 아니므로 세지 않는다.
 * 이 규칙이 없으면 모델 장애 몇 분 만에 후보가 ai_review_exhausted 로 사람에게 넘어가고, 모델이 돌아와도
 * 다시 자동 검사 대상이 되지 않는다(2026-11-06 사용자 보고).
 */
export const countedReviewFailure = candidateRetryCountedFailure;
function countedReviewFailureSql(column: SQL | typeof crawlReviewAttempts.errorCode): SQL {
  return sql`(${column} IS NOT NULL AND ${column} <> 'owner_changed' AND ${column} <> ${NATIVE_TERMINAL_FAILURE}
    AND ${column} <> 'cancelled' AND ${column} !~ '^http_5[0-9][0-9]$'
    AND ${column} NOT IN (${sql.join(PROVIDER_FAILURE_CODES.map(code => sql`${code}`), sql`, `)}))`;
}

function matchingSource(settings: CrawlSettings, delegated = false, retry = false): SQL {
  // 보류 Qwen-v2 의 승인(성공·승인 행만)도 지금 1차 심사자의 판단처럼 관문에 선다(held-qwen-retry-policy.ts)
  return sql`${crawlReviewAttempts.candidateId} = ${crawlCandidates.id}
    AND ${delegated ? delegatedReviewIdentity(settings) : retry ? retryReviewIdentity() : sql`((${crawlReviewAttempts.kind} = 'automatic' AND ${activeReviewIdentity(settings)}) OR ${heldQwenGateFirstSql(settings, appliedHeldQwenAttemptColumn(crawlCandidates.signals))})`}
    AND ${currentReviewSource(settings)}`;
}

/**
 * 시도 행(crawl_review_attempts)이 지금 후보의 원본(같은 정책·판정 시각·수집 원본·README·스캔)에서 나왔는가 — 시각 창은 보지 않는다.
 * matchingSource 의 원본 부분이다. 사람 몫 위임 검수의 후보 고르기(human-review-repository.ts humanReviewRepos)가
 * "이 입력에서 이미 끝낸 후보"를 SQL 로 거를 때 같은 대조를 쓴다.
 */
export function currentReviewSource(settings: CrawlSettings): SQL {
  return sql`${crawlReviewAttempts.policyHash} = ${reviewPolicyHash(settings)}
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
const sameModelName = (name: SQL) => sql`regexp_replace(regexp_replace(lower(trim(${name})), '@[0-9a-f]{8}$', ''), '^\\[mlx\\][[:space:]]*', '', 'i')`;

/**
 * 이 1차 승인에 대해, 지금 세운 2차 모델마다 승인 표가 있는가.
 *
 * 표가 "하나라도" 승인이면 되는 것이 아니다 — 모델을 바꾸거나 더한 직후에는 빠진 모델의 옛 승인만 남아 있어,
 * 새 모델이 한 번도 보지 않은 것이 발행됐다(codex 교차 검토 P1). 지금 설정의 모델 칸마다, 그 모델이나 그 칸을
 * 대신한 대체 모델(fallback_for_id)의 승인을 찾는다. 1차와 같은 모델도 별도의 2차 호출과 승인이 필요하다. 칸이 하나도 없으면
 * 2차 승인을 받을 수 없으므로 통과시키지 않는다(그런 후보는 enqueueSecondReviews 가 사람에게 넘긴다).
 * 볼 표·실패·반대가 하나라도 열려 있으면 역시 통과시키지 않는다.
 */
function secondApproved(attempt: { id: SQL; model: SQL }, voters: { provider: string; model: string }[],
  fallbacks: { provider: string; model: string }[] = []): SQL {
  if (secondReviewHasWorkloadPool()) return secondReviewPoolApprovedSql(attempt);
  const slots = sql`jsonb_array_elements(${JSON.stringify(voters)}::jsonb) v`;
  // 대체 모델의 표는 그 모델이 지금도 대체 모델일 때만 칸을 채운다 — 설정에서 뺀 직후 정리 전에 옛 승인으로 발행되지 않게(codex 2차 P1)
  const currentFallback = sql`(g.fallback_for_id IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(fallbacks)}::jsonb) f
    WHERE f->>'provider' = g.provider AND ${sameModelName(sql`f->>'model'`)} = ${sameModelName(sql`g.model`)}))`;
  return sql`(EXISTS (SELECT 1 FROM ${slots})
    AND NOT EXISTS (SELECT 1 FROM ${slots}
      WHERE NOT EXISTS (SELECT 1 FROM ${secondReviews} g LEFT JOIN ${secondReviews} root ON root.id = g.fallback_for_id
        WHERE g.first_attempt_id = ${attempt.id} AND g.trigger = 'ai_approved' AND g.status = 'agreed' AND g.second_decision = 'approve'
          AND coalesce(root.provider, g.provider) = v->>'provider'
          AND ${sameModelName(sql`coalesce(root.model, g.model)`)} = ${sameModelName(sql`v->>'model'`)} AND ${currentFallback}))
    AND NOT EXISTS (SELECT 1 FROM ${secondReviews} g WHERE g.first_attempt_id = ${attempt.id} AND g.trigger = 'ai_approved'
      AND g.status IN ('pending', 'failed', 'needs_human')))`;
}

/** Read-only measurement projection of the exact publication approval gate. */
export function secondReviewApprovalPredicate(settings: CrawlSettings): SQL {
  return secondApproved({ id: sql`${crawlReviewAttempts.id}`, model: sql`${crawlReviewAttempts.model}` },
    secondReviewVoters(settings), secondReviewFallbacks(settings));
}

/**
 * 사람 몫 위임 검수(DeepSeek)가 적용한 결정인가 — 발행 관문이 위임 승인 갈래로 보는 후보.
 * 이 갈래는 근거 나이를 자르지 않는다(ReviewEvidenceAge any_age, 2026-11-09 운영자 결정) — 같은 원본·입력 해시·정책은 그대로 본다.
 */
export function isDelegatedApproval(candidate: Pick<CrawlCandidate, "decidedBy" | "signals">): boolean {
  return candidate.decidedBy === 'deepseek'
    || candidate.decidedBy !== 'admin' && candidate.signals?.delegatedReviewAttemptId !== undefined;
}

export function reviewApprovalPredicate(settings: CrawlSettings): SQL {
  // 위임 승인에는 validUntil 창을 걸지 않는다 — 24시간 지난 근거로 내린 승인도 같은 원본이면 발행한다(any_age).
  // 입력 해시·원본 대조는 발행 트랜잭션의 assertReviewApproval 이 잠근 행으로 다시 잰다.
  const delegated = sql`EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings, true)}
    AND ${crawlReviewAttempts.state} = 'succeeded' AND ${crawlReviewAttempts.outcome}->>'decision' = 'approve')`;
  const ordinary = settings.reviewMode !== 'enforce' ? sql`true` : sql`(${crawlCandidates.decidedBy} = 'admin' OR ${starAutoApprovalPredicate(settings)} OR EXISTS (
    SELECT 1 FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
    AND ${crawlReviewAttempts.state} = 'succeeded' AND ${crawlReviewAttempts.outcome}->>'decision' = 'approve'
    AND ${crawlReviewAttempts.validUntil} > ${reviewSemanticNowSql()}
    AND ${secondGateRequired(settings) ? secondApproved({ id: sql`${crawlReviewAttempts.id}`, model: sql`${crawlReviewAttempts.model}` },
      secondReviewVoters(settings), secondReviewFallbacks(settings)) : sql`true`}))`;
  return sql`CASE WHEN ${crawlCandidates.decidedBy} = 'deepseek' OR (${crawlCandidates.decidedBy} <> 'admin' AND ${crawlCandidates.signals}->'delegatedReviewAttemptId' IS NOT NULL)
    THEN ${delegated} ELSE ${ordinary} END`;
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
    await readItemStage(tx, stages.ai1);
    const rows = await tx.select().from(crawlCandidates).where(and(
      or(eq(crawlCandidates.state, "approved"), and(eq(crawlCandidates.state, "needs_review"),
        inArray(crawlCandidates.reason, [...REVIEW_RETRIABLE_REASONS]))), eq(crawlCandidates.decidedBy, "auto"),
      not(starAutoApprovalPredicate(settings)),
      sql`EXISTS (SELECT 1 FROM ${crawlDocuments} d WHERE d.repo = ${crawlCandidates.repo}
        AND d.product_url IS NOT DISTINCT FROM ${crawlCandidates.productUrl}
        AND d.fetched_at <= ${reviewSemanticNowSql()} AND d.fetched_at > ${reviewSemanticNowSql()} - interval '24 hours')`,
      sql`(SELECT count(*) FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings, false, true)}
        AND ${crawlReviewAttempts.state} IN ('failed', 'superseded')
        AND ${countedReviewFailureSql(crawlReviewAttempts.errorCode)}) >= ${MAX_REVIEW_ATTEMPTS}`,
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
        retryReviewIdentity(), eq(crawlReviewAttempts.inputHash, input.inputHash),
        eq(crawlReviewAttempts.sourceRevisionHash, input.sourceRevisionHash),
        eq(crawlReviewAttempts.policyHash, input.policyHash), eq(crawlReviewAttempts.promptVersion, REVIEW_PROMPT_VERSION),
        eq(crawlReviewAttempts.rulesVersion, REVIEW_RULES_VERSION),
      )).for("share");
      if (attempts.some(attempt => attempt.state === "succeeded" && attempt.validUntil > reviewSemanticNow()
        && (attempt.provider === "rules" || hasFirstReviewer(firstReviewers(settings), attempt)))) continue;
      if (attempts.filter(attempt => ["failed", "superseded"].includes(attempt.state)
        && countedReviewFailure(attempt.errorCode)).length >= MAX_REVIEW_ATTEMPTS) exhausted.push(candidate.id);
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
 * 같은 까닭으로 거듭 건너뛴 1차 후보를 사람 확인으로 넘긴다(first-review-skips.ts 의 상한) — handOffExhaustedFirstReviews 와 같은 꼴로,
 * 사유는 ai_review_skip_exhausted, 멈춘 곳(stoppedAt)에 건너뛴 까닭을 사람 말로 남긴다. 잡의 커서 표는 어림이다 — 여기서 잠근 행으로 다시 잰다.
 * 넘기지 않는 것(false):
 *  - 지금 1차 대상이 아니게 된 후보(reviewCandidatePredicate — 그사이 유효한 심사가 붙었거나 원본이 낡았거나 상태가 바뀐 것). 1차가 그대로
 *    다시 집어 또 건너뛸 후보만 넘긴다.
 *  - 살아 있는 1차 항목, 또는 살아 있는 주인의 진행 중 시도가 있는 후보 — 그 시도가 끝나면 다시 1차 대상이다(주인 있는 시도는 건드리지 않는다).
 *  - 이 후보가 처음 상한에 닿은 뒤(sinceMs 전) 다른 후보의 1차 자동 심사 성공이 하나도 없을 때 — 전역 장애가 후보마다 같은 까닭으로 보일 때
 *    후보를 한꺼번에 사람에게 넘기지 않는다. 쪽에서 빼 두기는 계속된다.
 * 잠금 순서는 handOffExhaustedFirstReviews 와 같다: stage → 후보 → (시도 읽기) → 1차 항목 → 잡.
 */
export async function handOffSkippedFirstReview(settings: CrawlSettings, lease: JobLease, input: {
  candidateId: number; skipReason: string; strikes: number; sinceMs: number;
}): Promise<boolean> {
  if (!settings.enabled || settings.reviewMode !== "enforce") return false;
  if (!Number.isSafeInteger(input.candidateId) || input.candidateId < 1) throw new Error("invalid_agent_review_candidate");
  const detail = `같은 까닭으로 계속 건너뜀 — ${firstReviewSkipReasonText(input.skipReason)}(${input.skipReason}). `
    + `연속 ${FIRST_REVIEW_SKIP_STREAK_LIMIT}회 건너뛰기가 ${input.strikes}번 거듭돼 자동 심사를 멈췄습니다. 사람이 확인해야 합니다.`;
  return db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    await readItemStage(tx, stages.ai1);
    const [candidate] = await tx.select().from(crawlCandidates).where(and(eq(crawlCandidates.id, input.candidateId),
      reviewCandidatePredicate(settings))).for("update");
    const refuse = async () => { await assertAgentReviewJob(tx, lease); return false; };
    if (!candidate) return refuse();
    const [liveAttempt] = await tx.select({ id: crawlReviewAttempts.id }).from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.candidateId, candidate.id), eq(crawlReviewAttempts.state, "running"),
      sql`EXISTS (SELECT 1 FROM ${jobs} owner WHERE owner.lease_token = ${crawlReviewAttempts.leaseToken}
        AND owner.locked_at >= clock_timestamp() - ${STALE_LOCK_MS} * interval '1 millisecond')`)).limit(1);
    if (liveAttempt) return refuse();
    const sinceAgeMs = Math.max(0, Math.trunc(Date.now() - input.sinceMs));
    const [evidence] = await tx.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} ok
        WHERE ok.kind = 'automatic' AND ok.provider <> 'rules' AND ok.state = 'succeeded' AND ok.candidate_id <> ${candidate.id}
          AND ok.completed_at > clock_timestamp() - ${sinceAgeMs} * interval '1 millisecond') AS ok`);
    if (!evidence?.ok) return refuse();
    if (await hasLiveAgentReviewItem(tx, candidate.id)) return refuse();
    const updated = await tx.update(crawlCandidates).set({
      state: "needs_review", reason: "ai_review_skip_exhausted", updatedAt: sql`clock_timestamp()`,
      signals: sql`coalesce(${crawlCandidates.signals}, '{}'::jsonb) ||
        jsonb_build_object('firstReviewSkipExhausted', jsonb_build_object('previousState', ${crawlCandidates.state},
          'previousReason', ${crawlCandidates.reason}, 'skipReason', ${input.skipReason}::text, 'strikes', ${input.strikes}::integer,
          'streakLimit', ${FIRST_REVIEW_SKIP_STREAK_LIMIT}::integer),
          'stoppedAt', jsonb_build_object('rule', 'AI 1차 심사', 'detail', ${detail}::text))`,
    }).where(eq(crawlCandidates.id, candidate.id)).returning({ id: crawlCandidates.id });
    await assertAgentReviewJob(tx, lease);
    return updated.length === 1;
  });
}

/**
 * 모델 장애로 소진된 1차 후보를 회복 증거가 있을 때만 자동 검사 대상으로 되돌린다.
 *
 * - `ai_review_exhausted` + `decided_by='auto'` + `signals.firstReviewExhausted` 만 본다(사람이 닫은 결정은 건드리지 않는다).
 * - 실패 중 후보 탓(판정·입력)이 하나라도 있으면 되돌리지 않는다 — 진짜 콘텐츠 문제는 사람이 봐야 한다.
 * - 최근 2시간 안에 규칙이 아닌 1차 자동 심사 성공이 있어야 한다(모델이 실제로 돌아왔다는 증거).
 * - 장부(model_capacity_requests)는 건드리지 않는다 — 종료 미확정 행은 소유자 결정대로 사람 검토·늦은 종료 근거만 닫는다.
 * - `updated_at` 을 첫 실패 시각으로 되돌려 기존 (미검수 우선, 오래된 순) 순서에서 앞쪽에 서게 한다.
 */
export async function reopenProviderExhaustedFirstReviews(
  settings: CrawlSettings, lease: JobLease, limit = 20,
): Promise<number[]> {
  if (!settings.enabled || settings.reviewMode !== "enforce") return [];
  return db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    await readItemStage(tx, stages.ai1);
    const [evidence] = await tx.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} ok
        WHERE ok.kind = 'automatic' AND ok.provider <> 'rules' AND ok.state = 'succeeded'
          AND ok.completed_at > clock_timestamp() - interval '2 hours'
          AND ok.completed_at <= clock_timestamp()) AS ok`);
    if (!evidence?.ok) return [];
    const previousReasons = ["passed", ...REVIEW_RETRIABLE_REASONS];
    const rows = await tx.select().from(crawlCandidates).where(and(
      eq(crawlCandidates.state, "needs_review"), eq(crawlCandidates.reason, "ai_review_exhausted"),
      eq(crawlCandidates.decidedBy, "auto"),
      sql`${crawlCandidates.signals} ? 'firstReviewExhausted'`,
      sql`${crawlCandidates.signals}->'firstReviewExhausted'->>'previousReason'
        IN (${sql.join(previousReasons.map(reason => sql`${reason}`), sql`, `)})`,
      sql`EXISTS (SELECT 1 FROM ${crawlDocuments} d WHERE d.repo = ${crawlCandidates.repo}
        AND d.product_url IS NOT DISTINCT FROM ${crawlCandidates.productUrl}
        AND d.fetched_at <= ${reviewSemanticNowSql()} AND d.fetched_at > ${reviewSemanticNowSql()} - interval '24 hours')`,
      sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} bad WHERE bad.candidate_id = ${crawlCandidates.id}
        AND bad.kind = 'automatic' AND bad.state IN ('failed', 'superseded')
        AND ${countedReviewFailureSql(sql`bad.error_code`)})`,
      // 회복 증거는 이 후보의 마지막 실패보다 뒤에 있어야 한다 — 장애 전의 옛 성공으로 되돌리지 않는다.
      sql`EXISTS (SELECT 1 FROM ${crawlReviewAttempts} ok
        WHERE ok.kind = 'automatic' AND ok.provider <> 'rules' AND ok.state = 'succeeded'
          AND ok.completed_at > clock_timestamp() - interval '2 hours'
          AND ok.completed_at > coalesce((SELECT max(bad.completed_at) FROM ${crawlReviewAttempts} bad
            WHERE bad.candidate_id = ${crawlCandidates.id} AND bad.kind = 'automatic'
              AND bad.state IN ('failed', 'superseded')), '-infinity'::timestamptz))`,
      sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} ok WHERE ok.candidate_id = ${crawlCandidates.id}
        AND ok.kind = 'automatic' AND ok.state = 'succeeded' AND ok.valid_until > ${reviewSemanticNowSql()})`,
    )).orderBy(asc(crawlCandidates.updatedAt), asc(crawlCandidates.id))
      .limit(Math.max(1, Math.min(50, limit))).for("update", { skipLocked: true });
    if (!rows.length) return [];
    const reopened: number[] = [];
    for (const candidate of rows) {
      const signals = candidate.signals as { firstReviewExhausted?: { previousReason?: unknown }; stoppedAt?: { rule?: unknown } } | null;
      const previous = signals?.firstReviewExhausted?.previousReason;
      if (previous !== "passed" && !REVIEW_RETRIABLE_REASONS.some(reason => reason === previous)) continue;
      const handoffStop = signals?.stoppedAt?.rule === "AI 1차 심사";
      const changed = await tx.update(crawlCandidates).set({
        state: previous === "passed" ? "approved" : "needs_review", reason: previous as CrawlCandidate["reason"],
        updatedAt: sql`coalesce((SELECT min(started_at) FROM ${crawlReviewAttempts} r
          WHERE r.candidate_id = ${candidate.id} AND r.kind = 'automatic'
            AND r.state IN ('failed', 'superseded')), clock_timestamp())`,
        signals: sql`(${handoffStop ? sql`${crawlCandidates.signals} - 'stoppedAt'` : sql`${crawlCandidates.signals}`}
          - 'firstReviewExhausted') || jsonb_build_object('firstReviewRecoveredAt', clock_timestamp(),
            'firstReviewRecoveredFrom', ${crawlCandidates.signals}->'firstReviewExhausted')`,
      }).where(and(eq(crawlCandidates.id, candidate.id), eq(crawlCandidates.state, "needs_review"),
        eq(crawlCandidates.reason, "ai_review_exhausted"))).returning({ id: crawlCandidates.id });
      if (changed.length) reopened.push(candidate.id);
    }
    await assertAgentReviewJob(tx, lease);
    return reopened;
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
/**
 * 지금 입력(matchingSource — 같은 원본·판정 시각·스캔·정책)에 지금 1차 심사자(제공자·모델)의 자동 판단 보류가 있는가 — 성공·needs_review·유효.
 * 1차가 이 입력에서 판단 보류를 낸 것이다. 보류 Qwen-v2 재심사가 '판단 보류(ambiguous)' 후보를 맡는 조건이다(held-qwen-retry.ts):
 * 1차가 잠깐 실패해 기다리는 중(1차 대상에서 잠시 빠진 것)인 후보는 맡지 않는다 — 그 후보는 1차가 다시 본다.
 */
export function firstReviewAbstainedPredicate(settings: CrawlSettings): SQL {
  const pool = firstReviewers(settings);
  if (!pool.length) return sql`false`;
  return sql`EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
    AND ${crawlReviewAttempts.kind} = 'automatic' AND ${firstReviewIdentitySql(pool, crawlReviewAttempts)} AND ${crawlReviewAttempts.state} = 'succeeded'
    AND ${crawlReviewAttempts.outcome}->>'decision' = 'needs_review' AND ${crawlReviewAttempts.validUntil} > ${reviewSemanticNowSql()})`;
}

export function reviewCandidatePredicate(settings: CrawlSettings, options: ReviewCandidateOptions = {}): SQL {
  if (!settings.enabled || settings.reviewMode === "off") return sql`false`;
  const scanFresh = sql`(fres.completed_at <= ${reviewSemanticNowSql()} AND fres.completed_at > ${reviewSemanticNowSql()} - interval '24 hours')`;
  return and(
    not(liveAgentReviewItem(sql`${crawlCandidates.id}`)),
    options.excludeCandidateIds?.length ? notInArray(crawlCandidates.id, options.excludeCandidateIds) : undefined,
    options.readyOnly ? sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings, false, true)}
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
    sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings, false, true)}
      AND ${crawlReviewAttempts.state} = 'failed' AND ${crawlReviewAttempts.retryAfter} > clock_timestamp())`,
    sql`(SELECT count(*) FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings, false, true)}
      AND ${crawlReviewAttempts.state} IN ('failed','superseded')
      AND ${countedReviewFailureSql(crawlReviewAttempts.errorCode)}) < ${MAX_REVIEW_ATTEMPTS}`,
    sql`(SELECT count(*) FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings, false, true)}
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

/**
 * Bounded keyset page, retaining the existing unseen/oldest ordering and a fixed ID ceiling.
 * excludeCandidateIds — 같은 까닭으로 거듭 건너뛰어 잠시 쪽에서 뺀 후보(first-review-skips.ts). 커서·ceiling 은 그대로다.
 */
export async function listFirstReviewPoolCandidates(settings: CrawlSettings, limit: number, after: FirstReviewPoolPosition | null,
  excludeCandidateIds: readonly number[] = []) {
  const rows = await firstReviewPoolQuery(settings, limit, after, excludeCandidateIds);
  return rows.map(({ candidate, ...position }) => ({ candidate, position }));
}

/**
 * 「심사한 적 있음」 — 이 후보에 성공한 시도가 하나라도 있는가. 1차 쪽 커서(잡·consumer)의 첫 열쇠이고, select 목록·where·order by 가 이 한 식을 쓴다.
 * 바깥 후보 id 는 표 이름을 붙여 적는다(qualifiedColumn) — 아래 firstReviewPoolQuery 의 설명.
 */
export function firstReviewSeenSql(): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM ${crawlReviewAttempts} seen
    WHERE seen.candidate_id = ${qualifiedColumn(crawlCandidates.id)} AND seen.state = 'succeeded')`;
}

/**
 * 쪽 쿼리(실행하지 않은 builder — 시험이 toSQL 로 SQL 글자를 본다).
 *
 * 「심사한 적 있음」(reviewed)은 select 목록·where(커서 뒤)·order by 가 같은 식이어야 한다. 바깥 후보 id 는 표 이름을 붙여 적는다
 * (qualifiedColumn): drizzle 은 join 없는 select 의 select 목록에서 칸을 표 이름 없이("id") 그려, 안쪽 seen.id 로 묶여 늘 false 였다
 * (where·order by 는 "crawl_candidates"."id" 로 그려 맞았다). 그래서 커서에 reviewed=false 가 저장돼 심사한 적 있는 후보가 매 틱 「커서 뒤」로
 * 다시 뽑혔고, 그 후보를 처리할 수 없으면(주인 잃은 위임 시도가 running 으로 남은 것) 쪽이 비지 않아 ceiling 이 새로 잡히지 않고
 * ceiling 보다 id 가 큰 새 후보가 영영 굶었다(2026-11-11 16:00Z~, 대기 1,030건).
 */
export function firstReviewPoolQuery(settings: CrawlSettings, limit: number, after: FirstReviewPoolPosition | null,
  excludeCandidateIds: readonly number[] = []) {
  const reviewed = firstReviewSeenSql();
  return db.select({ candidate: crawlCandidates, id: crawlCandidates.id, reviewed,
    updatedAt: sql<string>`${crawlCandidates.updatedAt}::text`,
    ceiling: after ? sql<number>`${after.ceiling}::integer` : sql<number>`(SELECT coalesce(max(id), 0) FROM ${crawlCandidates})` })
    .from(crawlCandidates).where(and(reviewCandidatePredicate(settings, { readyOnly: true, excludeCandidateIds: [...excludeCandidateIds] }),
      after ? lte(crawlCandidates.id, after.ceiling) : undefined,
      after ? or(gt(reviewed, after.reviewed), and(eq(reviewed, after.reviewed), or(
        sql`${crawlCandidates.updatedAt} > (${after.updatedAt}::text)::timestamp`,
        and(sql`${crawlCandidates.updatedAt} = (${after.updatedAt}::text)::timestamp`, gt(crawlCandidates.id, after.id)),
      ))) : undefined)).orderBy(asc(reviewed), asc(crawlCandidates.updatedAt), asc(crawlCandidates.id))
    .limit(Math.max(1, Math.min(32, limit)));
}

export type PendingFirstReviewCandidate = {
  candidate: CrawlCandidate; reviewer: FirstReviewer; workKey: string; state: "reserved" | "waiting";
};

/** Revisit this live legacy owner's unstarted queue before walking a new keyset page.
 * These bounded hints grant no reservation/dispatch authority and never expire or cancel a row. */
export async function listOwnPendingFirstReviewCandidates(settings: CrawlSettings, job: JobLease): Promise<PendingFirstReviewCandidate[]> {
  if (currentReplayDb()) return [];
  const role = roleLeaseFromEnv("reviewer", process.env);
  if (!role) return [];
  const lease = structuredClone(job), pool = firstReviewers(settings).filter(row => isGatewayReviewProvider(row.provider));
  if (!pool.length) return [];
  return onPrimary(() => db.transaction(async tx => {
    const control = await lockModelCapacityCallerControl(tx);
    if (control.mode !== "open") return [];
    const stages = await lockPipelineInputStages(tx);
    if ((await readItemStage(tx, stages.ai1)).mode !== "legacy") return [];
    await assertAgentReviewJob(tx, lease);
    const [currentJob] = await tx.select({ name: jobs.name }).from(jobs).where(and(eq(jobs.name, lease.name),
      eq(jobs.leaseToken, lease.token), sql`${jobs.requestedVersion} >= ${lease.requestedVersion}`,
      sql`${jobs.processedVersion} < ${lease.requestedVersion}`));
    if (!currentJob) return [];
    const byModel: Array<Array<{ id: number; reviewer: FirstReviewer; workKey: string; state: "reserved" | "waiting" }>> = [];
    for (const reviewer of pool) {
      const route = control.policy?.routes.find(row => row.routeId === "crawl-agent-review"
        && row.provider === reviewer.provider && row.model === reviewer.model);
      if (!route) continue;
      const rows = await tx.select({ workKey: modelCapacityRequests.workKey, logicalKey: modelCapacityRequests.logicalWorkKey,
        state: modelCapacityRequests.state }).from(modelCapacityRequests).where(and(
        eq(modelCapacityRequests.ownerInstanceId, role.instanceId), eq(modelCapacityRequests.ownerBootId, role.bootId),
        eq(modelCapacityRequests.class, "first"), eq(modelCapacityRequests.pool, "reviewer"),
        eq(modelCapacityRequests.routeId, "crawl-agent-review"), eq(modelCapacityRequests.provider, reviewer.provider),
        eq(modelCapacityRequests.model, reviewer.model), eq(modelCapacityRequests.epoch, control.epoch),
        eq(modelCapacityRequests.revision, control.revision), eq(modelCapacityRequests.policyHash, control.policyHash!),
        eq(modelCapacityRequests.providerBudgetId, route.providerBudgetId), eq(modelCapacityRequests.groupId, route.groupId),
        sql`((${modelCapacityRequests.state} = 'reserved' AND ${modelCapacityRequests.reservedUntil} > clock_timestamp()
          AND ${modelCapacityRequests.token} IS NOT NULL) OR (${modelCapacityRequests.state} = 'waiting'
          AND ${modelCapacityRequests.queueUntil} > clock_timestamp() AND ${modelCapacityRequests.token} IS NULL))`,
        sql`${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.dispatchBinding} IS NULL
          AND ${modelCapacityRequests.dispatchBindingHash} IS NULL AND ${modelCapacityRequests.dispatchedAt} IS NULL
          AND ${modelCapacityRequests.terminalEvidence} IS NULL AND ${modelCapacityRequests.terminalEvidenceHash} IS NULL
          AND ${modelCapacityRequests.settledAt} IS NULL`,
        sql`EXISTS (SELECT 1 FROM role_leases own_role WHERE own_role.role = 'reviewer'
          AND own_role.owner_instance_id = ${role.instanceId} AND own_role.owner_boot_id = ${role.bootId}
          AND own_role.owner_release = ${role.release} AND own_role.epoch = ${role.epoch}
          AND own_role.lease_until > clock_timestamp())`,
      )).orderBy(sql`CASE WHEN ${modelCapacityRequests.state} = 'reserved' THEN 0 ELSE 1 END`,
        asc(modelCapacityRequests.queueOrdinal)).limit(4);
      byModel.push(rows.flatMap(row => {
        const match = /^ai1:([1-9][0-9]*):[a-f0-9]{64}$/.exec(row.workKey), id = match ? Number(match[1]) : NaN;
        return Number.isSafeInteger(id) && row.logicalKey === `ai1:${id}` && (row.state === "reserved" || row.state === "waiting")
          ? [{ id, reviewer, workKey: row.workKey, state: row.state }] : [];
      }));
    }
    // At most four per model (twelve total); alternate models inside each state.
    const ordered = (["reserved", "waiting"] as const).flatMap(state => Array.from({ length: 4 }, (_, index) =>
      byModel.flatMap(rows => rows.filter(row => row.state === state)[index] ?? [])).flat());
    if (!ordered.length) return [];
    const candidates = await tx.select().from(crawlCandidates).where(and(inArray(crawlCandidates.id, ordered.map(row => row.id)),
      reviewCandidatePredicate(settings, { readyOnly: true })));
    const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
    return ordered.flatMap(row => { const candidate = byId.get(row.id); return candidate ? [{ candidate, reviewer: row.reviewer,
      workKey: row.workKey, state: row.state }] : []; });
  }));
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
export type ModelCapacityReviewClaim = ReviewClaim & { dispatch?: Ai1ModelDispatch };
type CapacityClaim = { reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity;
  call: Pick<PreparedAi1GatewayCall, "model" | "inputHash" | "wireHash" | "servingContractHash" | "totalTokenBound"> };
type ClaimAuthority = { kind: "legacy"; job: JobLease } | { kind: "item"; owner: ItemOwner; ttlMs: number };
/** CLI 호출(05c-4)의 값 사본 — 실행 권한은 prepared 객체에만 있다 */
type CliCapacityClaim = { reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; call: z.infer<typeof reviewCliCallRefSchema> };
export type CliModelCapacityReviewClaim = ReviewClaim & { dispatch?: CliModelDispatch };
const isCliClaim = (value: CapacityClaim | CliCapacityClaim): value is CliCapacityClaim => (value.call as { kind?: unknown }).kind === "prepared_cli";

/** 공통 장부의 게이트웨이 kind 로 가는 1차 심사자(PR 3b-C): abcllm 계약 또는 local-direct 엔진. CLI 는 따로 간다. */
export const isGatewayReviewProvider = (provider: string): provider is GatewayDispatchProvider =>
  (GATEWAY_DISPATCH_PROVIDERS as readonly string[]).includes(provider);
function gatewayDispatchProvider(provider: string): GatewayDispatchProvider {
  if (!isGatewayReviewProvider(provider)) throw new Error("invalid_ai1_model_capacity_claim");
  return provider;
}
export type AgentReviewItemModelIntent = Readonly<{ context: ReviewDomainContext; provider: GatewayDispatchProvider; model: string; owner: ItemOwner }>;
/** Consistency data from a rolled-back fresh claim, never provider authority. */
export class AgentReviewItemModelReservationRequired extends ModelCapacityDeferredError {
  readonly intent: AgentReviewItemModelIntent;
  constructor(value: AgentReviewItemModelIntent) {
    super("reservation_required");
    this.intent = snapshotItemModelIntent(value);
  }
}
export type AgentReviewItemCliModelIntent = Readonly<{ context: ReviewDomainContext; provider: ReviewCliProvider; model: string; owner: ItemOwner }>;
/** CLI 심사자의 같은 되감은 consumer 요청(05c-4). gateway 의도와 다른 고정 class 라 서로의 coordinator 로 넘어가지 않는다. */
export class AgentReviewItemCliModelReservationRequired extends ModelCapacityDeferredError {
  readonly intent: AgentReviewItemCliModelIntent;
  constructor(value: AgentReviewItemCliModelIntent) {
    super("reservation_required");
    this.intent = snapshotItemModelIntent(value, z.enum(["claude-cli", "grok-cli", "opencode-cli"]));
  }
}
function snapshotItemModelIntent(value: AgentReviewItemModelIntent): AgentReviewItemModelIntent;
function snapshotItemModelIntent(value: AgentReviewItemCliModelIntent, provider: z.ZodType<ReviewCliProvider>): AgentReviewItemCliModelIntent;
function snapshotItemModelIntent(value: AgentReviewItemModelIntent | AgentReviewItemCliModelIntent,
  provider: z.ZodType<string> = z.enum(GATEWAY_DISPATCH_PROVIDERS)): AgentReviewItemModelIntent | AgentReviewItemCliModelIntent {
  const snapshot = structuredClone(value);
  const object = (v: unknown): boolean => v !== null && typeof v === "object" && !Array.isArray(v);
  const sha = z.string().regex(/^[a-f0-9]{64}$/);
  const checked = z.object({ context: z.object({ candidate: z.custom<CrawlCandidate>(object), document: z.custom<CrawlDocument>(object),
    settings: z.custom<CrawlSettings>(object), input: z.object({ snapshot: z.custom<ReviewInput["snapshot"]>(object),
      inputHash: sha, policyHash: sha, sourceRevisionHash: sha, source: z.custom<ReviewInput["source"]>(object), validUntil: z.date() }).strict() }).strict(),
    provider, model: z.string().min(1).max(160), owner: itemOwnerSchema }).strict().parse(snapshot);
  z.number().int().positive().safe().parse(checked.context.candidate.id);
  agentReviewBinding(checked.context.candidate.id, checked.context.input, { provider: checked.provider, model: checked.model });
  // Strict validation must preserve the factory's full input JSON wire identity.
  checked.context.input = snapshot.context.input;
  const freeze = (v: object): void => { Object.values(v).forEach(child => {
    if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  }); Object.freeze(v); };
  freeze(checked);
  return checked as AgentReviewItemModelIntent | AgentReviewItemCliModelIntent;
}

export type ItemModelCapacityReviewClaim = ReviewClaim & { dispatch?: Ai1ItemModelDispatch };
type ItemCapacityClaim = CapacityClaim & { expected: AgentReviewItemModelIntent };
/** Fixed consumer re-entry; control/request UPDATE precedes the shared S3/domain locks. */
export async function claimConsumerItemAgentReviewWithModelReservation(input: {
  expected: AgentReviewItemModelIntent; reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; call: PreparedAi1GatewayCall;
}): Promise<ItemModelCapacityReviewClaim> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const expected = snapshotItemModelIntent(input.expected);
  const reservation = modelCapacityReservationSchema.parse(input.reservation), identity = modelCapacityRequestIdentitySchema.parse(input.identity);
  const sha = z.string().regex(/^[a-f0-9]{64}$/);
  const call = z.object({ kind: z.literal("prepared"), model: z.string().min(1).max(160), inputHash: sha,
    wireHash: sha, servingContractHash: sha, totalTokenBound: z.number().int().positive().safe() }).strict().parse(input.call);
  if (!isDeepStrictEqual(expected.owner, reservation.owner) || !isDeepStrictEqual(expected.owner, identity.owner))
    throw new Error("invalid_agent_review_item_model_intent");
  try { return await claimReview({ ...expected.context, provider: expected.provider, model: expected.model },
    { kind: "item", owner: expected.owner, ttlMs: STALE_LOCK_MS }, { reservation, identity, call, expected }, true); }
  catch (error) {
    if (error instanceof HealthyLegacyReviewOwner) return { kind: "skipped", reason: "running" };
    if (error instanceof Error && error.message === "ai1_model_reservation_lost") throw new ModelCapacityDeferredError("reservation_lost");
    throw error;
  }
}
type CliItemCapacityClaim = CliCapacityClaim & { expected: AgentReviewItemCliModelIntent };
/** CLI consumer re-entry(05c-4) — gateway 와 같은 순서: control/request UPDATE 가 S3/domain 잠금보다 앞선다. */
export async function claimConsumerItemAgentReviewWithCliModelReservation(input: {
  expected: AgentReviewItemCliModelIntent; reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity;
  call: z.infer<typeof reviewCliCallRefSchema>;
}): Promise<CliModelCapacityReviewClaim> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const expected = snapshotItemModelIntent(input.expected, z.enum(["claude-cli", "grok-cli", "opencode-cli"]));
  const reservation = modelCapacityReservationSchema.parse(input.reservation), identity = modelCapacityRequestIdentitySchema.parse(input.identity);
  const call = reviewCliCallRefSchema.parse(input.call);
  if (!isDeepStrictEqual(expected.owner, reservation.owner) || !isDeepStrictEqual(expected.owner, identity.owner))
    throw new Error("invalid_agent_review_item_model_intent");
  try { return await claimReview({ ...expected.context, provider: expected.provider, model: expected.model },
    { kind: "item", owner: expected.owner, ttlMs: STALE_LOCK_MS }, { reservation, identity, call, expected }, true); }
  catch (error) {
    if (error instanceof HealthyLegacyReviewOwner) return { kind: "skipped", reason: "running" };
    if (error instanceof Error && error.message === "cli_model_reservation_lost") throw new ModelCapacityDeferredError("reservation_lost");
    throw error;
  }
}

/** Caller time is semantic/recording context; operational retry budgets use DB wall time. */
async function reviewWallTime(tx: ProductTransaction): Promise<Date> {
  const [row] = await tx.execute<{ ms: number }>(sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::double precision AS ms`);
  return new Date(row.ms);
}

export function claimAgentReview(input: ClaimContext & { lease: JobLease }): Promise<ReviewClaim> {
  return claimReview(input, { kind: "legacy", job: input.lease });
}

/** Fixed legacy route only. The opaque capacity lock belongs to this same TX;
 * no SHARE-to-UPDATE upgrade or standalone dispatch transaction is used. */
export function claimAgentReviewWithModelReservation(input: ClaimContext & { lease: JobLease } & CapacityClaim): Promise<ModelCapacityReviewClaim> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const reservation = modelCapacityReservationSchema.parse(input.reservation);
  const identity = modelCapacityRequestIdentitySchema.parse(input.identity);
  const call = Object.freeze({ model: input.call.model, inputHash: input.call.inputHash, wireHash: input.call.wireHash,
    servingContractHash: input.call.servingContractHash, totalTokenBound: input.call.totalTokenBound });
  const context = structuredClone({ candidate: input.candidate, document: input.document, settings: input.settings,
    input: input.input, provider: input.provider, model: input.model, now: input.now });
  const job = Object.freeze({ name: input.lease.name, token: input.lease.token, requestedVersion: input.lease.requestedVersion });
  return claimReview(context, { kind: "legacy", job }, { reservation, identity, call }).catch(error => {
    // Only this fixed final-CAS refusal is expected waiting. The outer domain
    // transaction has already rolled back; SQL/binding/authority errors stay raw.
    if (error instanceof Error && error.message === "ai1_model_reservation_lost")
      throw new ModelCapacityDeferredError("reservation_lost");
    throw error;
  });
}

/** CLI 심사자의 고정 legacy 경로(05c-4). 같은 TX 가 CLI 잠금·attempt·dispatch 를 함께 commit 한다. */
export function claimAgentReviewWithCliModelReservation(input: ClaimContext & { lease: JobLease } & CliCapacityClaim): Promise<CliModelCapacityReviewClaim> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const reservation = modelCapacityReservationSchema.parse(input.reservation);
  const identity = modelCapacityRequestIdentitySchema.parse(input.identity);
  const call = reviewCliCallRefSchema.parse(input.call);
  const context = structuredClone({ candidate: input.candidate, document: input.document, settings: input.settings,
    input: input.input, provider: input.provider, model: input.model, now: input.now });
  const job = Object.freeze({ name: input.lease.name, token: input.lease.token, requestedVersion: input.lease.requestedVersion });
  return claimReview(context, { kind: "legacy", job }, { reservation, identity, call }).catch(error => {
    if (error instanceof Error && error.message === "cli_model_reservation_lost") throw new ModelCapacityDeferredError("reservation_lost");
    throw error;
  });
}

/** Inactive adapter only. Item provenance is not part of the legacy replay certificate. */
export async function claimItemAgentReview(input: ClaimContext & { owner: ItemOwner; ttlMs: number }): Promise<ReviewClaim> {
  if (currentReplayDb()) throw new Error("replay_item_execution_unsupported");
  return claimReview(input, { kind: "item", owner: input.owner, ttlMs: input.ttlMs });
}

class HealthyLegacyReviewOwner extends Error {}

/** Fixed ordinary consumer entry; fresh model work never falls through to legacy transport. */
export async function claimConsumerItemAgentReview(input: ClaimContext & { owner: ItemOwner; ttlMs: number }): Promise<ReviewClaim> {
  if (currentReplayDb()) throw new Error("replay_item_execution_unsupported");
  const owner = itemOwnerSchema.parse(input.owner);
  const context = structuredClone({ candidate: input.candidate, document: input.document, settings: input.settings,
    input: input.input, provider: input.provider, model: input.model, now: input.now });
  try { return await claimReview(context, { kind: "item", owner, ttlMs: input.ttlMs }, undefined, true); }
  catch (error) {
    if (error instanceof HealthyLegacyReviewOwner) return { kind: "skipped", reason: "running" };
    throw error;
  }
}

function claimReview(input: ClaimContext, authority: ClaimAuthority, reserved: ItemCapacityClaim, consumer: true): Promise<ItemModelCapacityReviewClaim>;
function claimReview(input: ClaimContext, authority: ClaimAuthority, reserved: CliCapacityClaim | CliItemCapacityClaim, consumer?: boolean): Promise<CliModelCapacityReviewClaim>;
function claimReview(input: ClaimContext, authority: ClaimAuthority, reserved?: CapacityClaim, consumer?: boolean): Promise<ModelCapacityReviewClaim>;
async function claimReview(input: ClaimContext, authority: ClaimAuthority, reserved?: CapacityClaim | ItemCapacityClaim | CliCapacityClaim | CliItemCapacityClaim,
  consumer = false): Promise<ReviewClaim & { dispatch?: Ai1ModelDispatch | Ai1ItemModelDispatch | CliModelDispatch }> {
  if (!input.settings.enabled || input.settings.reviewMode === "off") return { kind: "skipped", reason: "disabled" };
  return onPrimary(() => db.transaction(async tx => {
    // currentReplayDb revalidates the private active verified handler scope.
    // Fixed replay profiles keep their existing legacy fixture contract/grants;
    // ordinary claims always read the control before the S3/domain prefix.
    let dispatchLock: Ai1CapacityDispatchLock | null = null, cliLock: CliCapacityDispatchLock | null = null;
    const cli = reserved && isCliClaim(reserved) ? reserved : null;
    if (cli) {
      // CLI 는 gateway 와 같은 논리 키(ai1:<후보>)다 — 장부가 transport 를 넘어 한 후보에 활성 호출 하나만 둔다
      cliLock = await lockCliModelCapacityDispatch(tx, { reservation: cli.reservation, identity: cli.identity,
        target: { kind: "ai1", candidateId: input.candidate.id } });
      if (!cliLock) return { kind: "skipped", reason: "reservation_lost" };
    } else if (reserved) {
      dispatchLock = await lockAi1ModelCapacityDispatch(tx, { reservation: reserved.reservation,
        identity: reserved.identity, candidateId: input.candidate.id });
      if (!dispatchLock) return { kind: "skipped", reason: "reservation_lost" };
    }
    const capacity = dispatchLock ? dispatchLock.control : cliLock ? cliLock.control : currentReplayDb() ? null : await lockModelCapacityCallerControl(tx);
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
    const configuredPool = firstReviewers(locked.settings);
    if (reserved && "expected" in reserved && (!isDeepStrictEqual(current, reserved.expected.context.input)
      || !isDeepStrictEqual(locked, reserved.expected.context) || authority.kind !== "item"
      || !isDeepStrictEqual(authority.owner, reserved.expected.owner)
      || !hasFirstReviewer(configuredPool, input))) return { kind: "skipped", reason: "input_changed" };
    if (input.provider !== "rules") {
      // Under the candidate lock: pinned work must keep its model; a never-sent candidate may keep the
      // reviewer it was rerouted to (every other pool model is treated as "avoid" for this re-check only).
      const others = new Set(configuredPool.filter(row => row.provider !== input.provider || row.model !== input.model).map(firstReviewerKey));
      const selected = await chooseFirstReviewForCandidate(locked, tx, others);
      if (!selected || selected.provider !== input.provider || selected.model !== input.model) return { kind: "skipped", reason: "input_changed" };
    }
    const binding = agentReviewBinding(locked.candidate.id, current, { provider: input.provider, model: input.model });
    const rows = await tx.select().from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.candidateId, locked.candidate.id), eq(crawlReviewAttempts.kind, "automatic"),
      or(eq(crawlReviewAttempts.inputHash, current.inputHash), eq(crawlReviewAttempts.state, "running")),
    )).orderBy(desc(crawlReviewAttempts.id)).limit(16).for("update");
    // 위임(DeepSeek·보류 Qwen-v2)이 이 후보를 보는 중이면 비킨다 — 한 후보에 진행 중 시도는 하나다(crawl_review_one_active_idx).
    // 위 rows 는 1차의 행만 읽어 그 행을 보지 못한다. 그 시도가 끝나면 다음 틱에 다시 본다
    const [delegated] = await tx.select({ id: crawlReviewAttempts.id }).from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.candidateId, locked.candidate.id), eq(crawlReviewAttempts.state, "running"),
      ne(crawlReviewAttempts.kind, "automatic"))).limit(1).for("share");
    if (delegated) {
      if (authority.kind === "legacy") await assertAgentReviewJob(tx, authority.job);
      return { kind: "skipped", reason: "running" };
    }
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
    if (consumer) {
      // Jobs follow attempts/items. Check every running attempt, not only the
      // bounded reuse history. Roll back the tentative item CAS for a healthy
      // legacy owner even after an operator changed the stage mode.
      await tx.select({ name: jobs.name }).from(jobs).where(eq(jobs.name, "crawl-agent-review")).for("share");
      const [live] = await tx.select({ name: jobs.name }).from(jobs).where(and(eq(jobs.name, "crawl-agent-review"),
        sql`${jobs.leaseToken} IS NOT NULL AND ${jobs.lockedAt} >= clock_timestamp() - interval '90 seconds'`,
        sql`EXISTS (SELECT 1 FROM ${crawlReviewAttempts} active WHERE active.candidate_id = ${locked.candidate.id}
          AND active.kind = 'automatic' AND active.state = 'running' AND active.lease_token = ${jobs.leaseToken})`));
      if (live) throw new HealthyLegacyReviewOwner();
    }
    const token = ownership.kind === "legacy" ? ownership.job.token : ownership.lease.token;
    const now = input.now ?? new Date();
    const wallNow = await reviewWallTime(tx);
    const semanticNow = reviewSemanticNow(now);
    const claimed = async (): Promise<ReviewClaim & { dispatch?: Ai1ModelDispatch | Ai1ItemModelDispatch | CliModelDispatch }> => {
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
      const result = (attempt: CrawlReviewAttempt, origin: Ai1ReviewOrigin): Exclude<ReviewClaim, { kind: "skipped" }> => ({
        kind: origin === "fresh" ? "claimed" : "reused", attempt, receipt: { attemptId: attempt.id, origin, ownership },
      });
      if (success) return result(success, "direct_reuse");
      // native 게이트웨이 계약 위반은 모델 실패가 아니다 — 기록·재시도 대기는 그대로 두고 시도 수로만 세지 않는다
      const [retryState] = await tx.select({ attemptCount: sql<number>`count(*)::integer`,
        failures: sql<number>`count(*) FILTER (WHERE ${crawlReviewAttempts.state} IN ('failed','superseded')
        AND ${countedReviewFailureSql(crawlReviewAttempts.errorCode)})::integer`,
        ownerChanges: sql<number>`count(*) FILTER (WHERE ${crawlReviewAttempts.state} = 'superseded' AND ${crawlReviewAttempts.errorCode} = 'owner_changed'
          AND ${gt(crawlReviewAttempts.completedAt, new Date(wallNow.getTime() - 24 * 60 * 60_000))})::integer`,
        waiting: sql<boolean>`coalesce(bool_or(${crawlReviewAttempts.state} = 'failed' AND ${gt(crawlReviewAttempts.retryAfter, wallNow)}), false)` })
        .from(crawlReviewAttempts).where(and(eq(crawlReviewAttempts.candidateId, locked.candidate.id), retryReviewIdentity(),
          eq(crawlReviewAttempts.inputHash, current.inputHash), eq(crawlReviewAttempts.sourceRevisionHash, current.sourceRevisionHash),
          eq(crawlReviewAttempts.policyHash, current.policyHash), eq(crawlReviewAttempts.promptVersion, REVIEW_PROMPT_VERSION),
          eq(crawlReviewAttempts.rulesVersion, REVIEW_RULES_VERSION)));
      const modelFailures = retryState.failures, ownerChanges = retryState.ownerChanges;
      if (ownerChanges >= 3) return { kind: "skipped", reason: "infrastructure_interruptions_exhausted" };
      if (input.provider !== "rules" && modelFailures >= MAX_REVIEW_ATTEMPTS)
        return { kind: "skipped", reason: "attempts_exhausted" };
      if (retryState.waiting) {
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
      if (consumer && !reusable && input.provider !== "rules" && capacity?.mode === "disabled")
        throw new ModelCapacityDeferredError("disabled");
      if (!reusable && input.provider !== "rules" && capacity && capacity.mode !== "disabled") {
        if (capacity.mode === "draining") throw new ModelCapacityDeferredError("draining");
        const route = capacity.policy?.routes.find(route => route.routeId === "crawl-agent-review"
          && route.provider === input.provider && route.model === input.model);
        if (!route) throw new ModelCapacityDeferredError("unmapped");
        const serving = (authority.kind === "legacy" || consumer) && isGatewayReviewProvider(input.provider)
          ? resolveAi1GatewayServingContract(input.model, input.provider) : null;
        // CLI 심사자는 계약이 있을 때만 slot 으로 간다. 운영 resolver 는 null 이라 지금은 그대로 미룬다(05c-1 과 같은 결과).
        const cliServing = (authority.kind === "legacy" || consumer) && isReviewCliProvider(input.provider)
          ? reviewCliServingContract("crawl-agent-review", input.provider, input.model) : null;
        if (!serving && !cliServing) throw new ModelCapacityDeferredError("provider_contract_unavailable");
        if (consumer && authority.kind === "item" && isGatewayReviewProvider(input.provider) && !reserved)
          throw new AgentReviewItemModelReservationRequired({ context: locked, provider: input.provider, model: input.model, owner: authority.owner });
        if (consumer && authority.kind === "item" && cliServing && isReviewCliProvider(input.provider) && !reserved)
          throw new AgentReviewItemCliModelReservationRequired({ context: locked, provider: input.provider, model: input.model, owner: authority.owner });
        // Roll back any preceding supersede/item mutation before requesting a slot.
        if (!reserved) throw new ModelCapacityDeferredError("reservation_required");
        if (cli ? !cliServing || cli.call.provider !== input.provider || cli.call.model !== input.model || cli.call.routeId !== "crawl-agent-review"
          || cli.call.inputHash !== current.inputHash || !reviewCliContractMatches(cli.call, cliServing)
          : !serving || isCliClaim(reserved) || reserved.call.model !== input.model || reserved.call.inputHash !== current.inputHash
          || reserved.call.servingContractHash !== ai1GatewayServingContractHash(serving)
          || reserved.call.totalTokenBound !== serving.totalTokenBound) throw new ModelCapacityDeferredError("provider_contract_unavailable");
      }
      if (reserved && !reusable) {
        if ((cli ? !cliLock || cli.call.provider !== input.provider : !isGatewayReviewProvider(input.provider) || !dispatchLock)
          || authority.kind === "item" && (!consumer || !("expected" in reserved)))
          throw new Error("invalid_ai1_model_capacity_claim");
        // Jobs follow all domain/attempt/item waits. Finish rechecks reservation
        // DB wall time; the final held-job wall check below follows its event.
        if (authority.kind === "legacy") await assertAgentReviewJob(tx, authority.job);
        else if (ownership.kind === "item") await assertItemLease(tx, stages.ai1, ownership.lease);
      }
      const [attempt] = await tx.insert(crawlReviewAttempts).values({
        candidateId: locked.candidate.id, kind: "automatic", state: "running",
        inputHash: current.inputHash, policyHash: current.policyHash, sourceRevisionHash: current.sourceRevisionHash,
        snapshot: current.snapshot, source: current.source,
        promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
        provider: input.provider, model: input.model, attemptNumber: retryState.attemptCount + 1,
        reusedFromAttemptId: reusable?.id ?? null,
        outcome: copiedOutcome ? validateReviewOutcome(current, copiedOutcome) : null,
        leaseToken: token, validUntil: current.validUntil, startedAt: now,
      }).returning();
      const claim = result(attempt, reusable ? "semantic_reuse" : "fresh");
      if (cli && !reusable) {
        if (!cliLock) throw new Error("invalid_ai1_model_capacity_claim");
        const charge = { routeId: "crawl-agent-review" as const, provider: cli.call.provider, model: input.model, transport: cli.call.transport,
          totalTokenBound: cli.call.totalTokenBound, chargedTokens: cli.call.totalTokenBound };
        if (ownership.kind === "item") {
          if (!consumer || !("expected" in cli) || attempt.state !== "running" || attempt.provider !== cli.call.provider
            || attempt.model !== input.model) throw new Error("invalid_ai1_model_capacity_claim");
          await assertAgentReviewOwnership(tx, stages.ai1, claim.receipt, attempt, current);
          const lease = ownership.lease;
          const dispatch = await finishCliModelCapacityDispatch(tx, cliLock, {
            kind: "ai1_item_cli", version: 1, logicalWorkKey: `ai1:${locked.candidate.id}`, attemptId: attempt.id, review: binding,
            item: { workKey: lease.workKey, owner: lease.owner, token: lease.token, stageEpoch: lease.stageEpoch,
              itemEpoch: lease.itemEpoch, bindingHash: lease.bindingHash }, ...charge,
          });
          return { ...claim, dispatch };
        }
        const dispatch = await finishCliModelCapacityDispatch(tx, cliLock, {
          kind: "ai1_legacy_cli", version: 1, logicalWorkKey: `ai1:${locked.candidate.id}`,
          candidateId: locked.candidate.id, attemptId: attempt.id, inputHash: current.inputHash,
          sourceRevisionHash: current.sourceRevisionHash, reviewPolicyHash: current.policyHash,
          promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, stageEpoch: stage.epoch, ...charge,
          job: { name: "crawl-agent-review", token: ownership.job.token, requestedVersion: ownership.job.requestedVersion },
        });
        return { ...claim, dispatch };
      }
      if (reserved && !isCliClaim(reserved) && !reusable) {
        if (!dispatchLock) throw new Error("invalid_ai1_model_capacity_claim");
        if (ownership.kind === "item") {
          if (!consumer || !("expected" in reserved) || attempt.state !== "running" || !isGatewayReviewProvider(attempt.provider ?? "")
            || attempt.provider !== input.provider || attempt.model !== input.model) throw new Error("invalid_ai1_model_capacity_claim");
          await assertAgentReviewOwnership(tx, stages.ai1, claim.receipt, attempt, current);
          const lease = ownership.lease;
          const dispatch = await finishAi1ItemModelCapacityDispatch(tx, dispatchLock, {
            kind: "ai1_item_gateway", version: 1, logicalWorkKey: `ai1:${locked.candidate.id}`, attemptId: attempt.id, review: binding,
            item: { workKey: lease.workKey, owner: lease.owner, token: lease.token, stageEpoch: lease.stageEpoch,
              itemEpoch: lease.itemEpoch, bindingHash: lease.bindingHash },
            provider: gatewayDispatchProvider(attempt.provider ?? ""), model: input.model, routeId: "crawl-agent-review", wireHash: reserved.call.wireHash,
            servingContractHash: reserved.call.servingContractHash, totalTokenBound: reserved.call.totalTokenBound,
            chargedTokens: reserved.call.totalTokenBound,
          });
          return { ...claim, dispatch };
        }
        const dispatch = await finishAi1ModelCapacityDispatch(tx, dispatchLock, {
          kind: "ai1_legacy_gateway", version: 1, logicalWorkKey: `ai1:${locked.candidate.id}`,
          candidateId: locked.candidate.id, attemptId: attempt.id, inputHash: current.inputHash,
          sourceRevisionHash: current.sourceRevisionHash, reviewPolicyHash: current.policyHash,
          promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: gatewayDispatchProvider(input.provider), model: input.model,
          routeId: "crawl-agent-review", stageEpoch: stage.epoch, wireHash: reserved.call.wireHash,
          servingContractHash: reserved.call.servingContractHash, totalTokenBound: reserved.call.totalTokenBound,
          chargedTokens: reserved.call.totalTokenBound, job: { name: "crawl-agent-review", token: ownership.job.token,
            requestedVersion: ownership.job.requestedVersion },
        });
        return { ...claim, dispatch };
      }
      return claim;
    };
    const result = await claimed();
    if (ownership.kind === "legacy") await assertAgentReviewJob(tx, ownership.job);
    else if (result.kind === "skipped") await releaseItemLease(tx, stages.ai1, ownership.lease);
    else await assertItemLease(tx, stages.ai1, ownership.lease);
    return result;
  }));
}

type RecordAgentReviewInput = ReviewDomainContext & {
  receipt: Ai1ReviewReceipt; outcome?: ReviewOutcome; error?: string; retryAfter?: Date; now?: Date;
  /** 실패 결과의 고정 진단 코드. native 게이트웨이 계약 위반(NATIVE_TERMINAL_FAILURE)만 별도 errorCode 로 적는다 */
  detail?: string;
  usage?: { inputTokens?: number | null; outputTokens?: number | null; costUsd?: number | null };
  /** Server-side rules only; never populated from the model response. */
  ruleRejection?: { reason: DecisionReason; existingSlug?: string; existingStatus?: ProductStatus };
};
export function recordAgentReview(input: RecordAgentReviewInput): Promise<{ applied: boolean; state: "succeeded" | "failed" | "superseded" }> {
  return recordReview(input, false);
}

/** Server-only hold: recomputed under the same current-domain/item writer locks. */
export function recordConsumerSuspectedSpam(input: ReviewDomainContext & { receipt: Ai1ReviewReceipt }): Promise<{ applied: boolean; state: "succeeded" | "failed" | "superseded" }> {
  if (input.receipt.ownership.kind !== "item") throw new Error("invalid_agent_review_receipt");
  return recordReview(input, true);
}

async function recordReview(input: RecordAgentReviewInput, spamHold: boolean): Promise<{ applied: boolean; state: "succeeded" | "failed" | "superseded" }> {
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
      await recordHumanDecisionRefused(tx, { stage: "ai1", candidateId: attempt.candidateId, firstAttemptId: attempt.id });
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
      const errorCode = nativeTerminalFailure({ ok: false, error: input.error, detail: input.detail }) ? NATIVE_TERMINAL_FAILURE : input.error;
      if (owns) await tx.update(crawlReviewAttempts).set({ state: "failed", errorCode: errorCode.slice(0, 120),
        retryAfter: input.retryAfter ?? new Date((await reviewWallTime(tx)).getTime() + 60_000), completedAt: now })
        .where(eq(crawlReviewAttempts.id, attempt.id));
      await recordReplayFinalWrite(tx, finalWrite, requests);
      await finishAgentReviewOwnership(tx, stages.ai1, input.receipt);
      return { applied: false, state: reusable ? "succeeded" as const : "failed" as const };
    }
    const applied = spamHold || locked.settings.reviewMode === "enforce";
    // 1차 AI 직전 재확인과 같은 규칙 판정 — 스팸 보류, 그리고 빈 화면 본문 규칙의 shadow(판정은 그대로, 걸렸을 규칙만 남긴다)가 쓴다
    const recheck = spamHold || applied && locked.settings.judge.stubTextRules === "shadow"
      ? judgeStoredDocument(locked.document, locked.settings, reviewSemanticNow(),
        locked.settings.agentEvidence.enforceEligibility ? { relationship: current.snapshot.relationship,
          scanState: current.snapshot.scanState, observations: current.snapshot.evidence.map(evidence => evidence.observation) } : undefined) : null;
    const spam = spamHold ? recheck : null;
    if (spamHold && (attempt.provider !== "rules" || spam?.reason !== "suspected_spam"))
      throw new Error("agent_review_spam_hold_changed");
    const outcome = validateReviewOutcome(current, reusable ? attempt.outcome : spamHold ? { decision: "needs_review", reason: "스팸·악성 의심은 사람이 확인해야 합니다.", evidenceIds: ["product"] } : input.outcome ?? attempt.outcome);
    const ruleRejection = attempt.provider === "rules" && outcome.decision === "reject" ? input.ruleRejection : undefined;
    if (owns) await tx.update(crawlReviewAttempts).set({ state: "succeeded", outcome, completedAt: now, errorCode: null,
      inputTokens: input.usage?.inputTokens ?? null, outputTokens: input.usage?.outputTokens ?? null,
      costUsd: input.usage?.costUsd ?? null }).where(eq(crawlReviewAttempts.id, attempt.id));
    // 판정 잡이 남긴 shadow 는 이 재확인으로 바꾼다 — 판정 뒤 바뀐 설정·이 칸이 생기기 전에 판정된 후보도 AI 결정과 같은 본문으로 견준다
    const kept = Object.fromEntries(Object.entries(locked.candidate.signals ?? {}).filter(([key]) => key !== "stoppedAt" && key !== "stubTextShadow"));
    const stubTextShadow = recheck?.signals.stubTextShadow;
    if (applied) await recordHumanDecisionOverride(tx, { stage: "ai1", candidateId: locked.candidate.id, firstAttemptId: attempt.id });
    if (applied) await tx.update(crawlCandidates).set({
      state: outcome.decision === "approve" ? "approved" : outcome.decision === "reject" ? "rejected" : "needs_review",
      reason: spamHold ? "suspected_spam" : ruleRejection?.reason ?? (outcome.decision === "approve" ? "passed" : outcome.decision === "reject" ? "not_a_product" : "ambiguous"),
      decidedBy: "auto", updatedAt: now,
      signals: { ...kept, agentReviewAttemptId: attempt.id,
        ...(stubTextShadow ? { stubTextShadow } : {}),
        ...(spamHold && spam ? { suspectedSpam: spam.signals.suspectedSpam } : {}),
        ...(ruleRejection?.existingSlug ? { existingSlug: ruleRejection.existingSlug, existingStatus: ruleRejection.existingStatus } : {}),
        ...(spamHold && spam ? { stoppedAt: spam.signals.stoppedAt } : outcome.decision === "approve" ? {} : { stoppedAt: { rule: "AI 심사", detail: outcome.reason.slice(0, 300) } }) },
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
  }).catch(async (error: unknown) => {
    await recordLateWriteRefused({ stage: "ai1", candidateId: input.candidate.id, firstAttemptId: input.receipt.attemptId }, error);
    throw error;
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
  const delegated = isDelegatedApproval(input.candidate);
  if (!delegated && (input.settings.reviewMode !== "enforce" || input.candidate.decidedBy === "admin")) {
    await assertJobLease(tx, input.lease);
    return null;
  }
  if (!delegated && input.candidate.signals?.starAutoApproval) {
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
  // 위임 승인은 근거 나이를 자르지 않은 입력(any_age)으로 내렸다 — 같은 기준으로 다시 짓고 대조한다
  const current = await loadReviewInput(input.candidate, input.document, input.settings, tx, delegated ? "any_age" : "window");
  const [approval] = await tx.select().from(crawlReviewAttempts).where(and(
    delegated ? delegatedReviewIdentity(input.settings, String(input.candidate.signals?.delegatedReviewAttemptId))
      : or(and(activeReviewIdentity(input.settings), eq(crawlReviewAttempts.kind, "automatic")),
        heldQwenGateFirstSql(input.settings, appliedHeldQwenAttemptSql(input.candidate))),
    eq(crawlReviewAttempts.candidateId, input.candidate.id),
    eq(crawlReviewAttempts.state, "succeeded"), eq(crawlReviewAttempts.inputHash, current.inputHash),
    eq(crawlReviewAttempts.sourceRevisionHash, current.sourceRevisionHash),
    eq(crawlReviewAttempts.policyHash, current.policyHash),
    eq(crawlReviewAttempts.promptVersion, REVIEW_PROMPT_VERSION), eq(crawlReviewAttempts.rulesVersion, REVIEW_RULES_VERSION),
    sql`${crawlReviewAttempts.outcome}->>'decision' = 'approve'`,
    delegated ? undefined : sql`${crawlReviewAttempts.validUntil} > ${reviewSemanticNowSql()}`,
    input.approvalId ? eq(crawlReviewAttempts.id, input.approvalId) : undefined,
  )).orderBy(desc(crawlReviewAttempts.id)).limit(1).for("share");
  await assertJobLease(tx, input.lease);
  const now = reviewSemanticNow();
  if (!approval || !delegated && current.validUntil <= now || input.document.fetchedAt > now
    || input.input && input.input.inputHash !== current.inputHash) throw new ReviewApprovalChangedError();
  validateReviewOutcome(current, approval.outcome);
  // 발행 직전에 한 번 더 — 목록을 고른 뒤 2차 표가 반대로 바뀌었을 수 있다
  if (!delegated && secondGateRequired(input.settings)) {
    // 표를 잠근 뒤 같은 조건으로 다시 잰다 — 목록을 고른 뒤 표가 바뀌었을 수 있다
    await tx.select({ id: secondReviews.id }).from(secondReviews).where(eq(secondReviews.firstAttemptId, approval.id)).for("share");
    const [gate] = await tx.execute<{ ok: boolean }>(sql`select ${secondApproved({ id: sql`${approval.id}`, model: sql`${approval.model}` },
      secondReviewVoters(input.settings), secondReviewFallbacks(input.settings))} as ok`);
    if (!gate?.ok) throw new ReviewApprovalChangedError();
  }
  return approval;
}

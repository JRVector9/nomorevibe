import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, operationsAudit, secondReviews,
  type CrawlReviewAttempt } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { assertJobLeaseAtWallTime, requestJob, type JobLease } from "@/lib/jobs/control";
import { readItemStage } from "@/lib/jobs/items/repository";
import type { JobContext } from "@/lib/jobs/runner";
import { recordHumanDecisionOverride } from "@/lib/operations/pipeline-evidence-ledger";
import { candidateRevisionHash, lockedInput } from "./admin-review";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, validateReviewOutcome, type ReviewInput, type ReviewOutcome } from "./agent-review-contract";
import { reviewCandidatePredicate } from "./agent-review-repository";
import { hasLiveAgentReviewItem } from "./agent-review-ownership";
import { hasLiveFetchItem } from "./fetch-ownership";
import { lockFrontierIdentity } from "./repository";
import { mergeWithDefaults } from "./settings";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { noteQwenEndpointFailure, noteQwenEndpointSuccess, qwenBackoffMs, qwenEndpointBackingOff, qwenEndpointBackoff,
  withQwenSecondarySlot } from "./qwen-endpoint-backoff";
import { QWEN_V2_PROMPT_VERSION, QwenDirectError, qwenDirectConfig, qwenEndpointFailure, reviewWithQwenDirect,
  type QwenDirectErrorCode, type QwenDirectReview } from "./qwen-direct-review";
import { reviewSemanticNow, reviewSemanticNowSql } from "./review-replay-context";
import { HELD_QWEN_ACTOR, HELD_QWEN_DECIDED_BY, HELD_QWEN_MIN_CONFIDENCE, HELD_QWEN_PROVIDER, heldQwenActor, heldQwenGateable,
  heldQwenGateFirstSql, heldQwenRetry } from "./held-qwen-retry-policy";
import type { CrawlSettings, HeldQwenReason } from "./settings-schema";

/**
 * 사람 대기 보류를 Qwen-v2(gpu3090 직접, qwen-direct-review.ts)가 다시 본다 — 소개 없음·1차 재시도 소진·규칙/1차 판단 보류.
 *
 * 2026-10-21 프로드 보류: 소개 없음 100(자동 86·DeepSeek 승인 14)·재시도 소진 51·판단 보류 12. DeepSeek 위임(한 번에 하나, 확신 0.9)은
 * 많은 수를 판단 보류로 남겼다. 같은 입력(1차 심사·DeepSeek 가 보는 그 입력, loadReviewInput)을 Qwen-v2 에게 묻고:
 *  - 거부: DeepSeek 위임과 같은 길로 끝낸다 — 시도 행(kind delegated)·운영 감사(모델)·증거 장부 pre-image. decided_by 'qwen-v2'.
 *  - 승인: 1차 AI 승인처럼 자동 경로로 되돌린다(approved·passed·decided_by auto). 발행은 두 모델 승인 관문을 그대로 지난다 —
 *    관문이 이 시도 행을 1차 승인으로 받고(held-qwen-retry-policy.ts) 지금 투표자 중 Qwen 과 다른 모델의 승인을 요구한다.
 *    독립 투표자가 없거나 관문이 꺼져 있으면 되돌리지 않고 사람에게 둔다. 소개 없음은 승인해도 발행에서 같은 자리로 돌아오므로
 *    (publish.ts no_description) 되돌리지 않고 "승인 의견"으로 사람에게 둔다 — 사람은 소개만 적으면 된다.
 *  - 판단 보류·오류: 사람 큐에 그대로 둔다(심사 큐의 «Qwen-v2: 판단 보류» 배지).
 *
 * DeepSeek 위임과 나누는 법: 스위치가 켜져 있으면 이 세 사유는 Qwen-v2 만 맡는다(heldQwenOwns — DeepSeek claim 이 같은 잠긴
 * 설정 행으로 재고 건너뛴다). 한 후보에 진행 중 시도는 하나뿐이라(crawl_review_one_active_idx) 바꾸는 순간에도 겹치지 않는다.
 *
 * 같은 잡(human-deepseek-review)의 앞부분에서 돈다 — 새 카탈로그 잡이 없다. 한 틱에 perTick 개·budgetSeconds 초까지.
 * claim·기록은 각각 짧은 트랜잭션이고 모델 호출은 그 사이(트랜잭션 밖)다. 같은 입력 세대(입력·원본 해시, 덧붙임 판, 모델)마다
 * 판단은 한 번, 실패는 15분 뒤 세 번까지. 부르는 곳의 탈(닿지 않음·시간 초과·5xx 등)이면 이 틱을 멈추고, gpu3090 을 부르는 모두와 함께
 * 물러난다(qwen-endpoint-backoff.ts — 1분부터 두 배씩 15분까지, 누가 탈을 만나든 감사·두 번째 의견·공개분 거르기·갈림 판가름도 함께 쉰다).
 * 동시 호출: 감사 Qwen 직접 심사가 아닌 쪽(이 재심사·두 번째 의견·공개분 거르기·갈림 판가름)은 프로세스의 두 번째 자리 하나를 나눠
 * 한 번에 한 호출만 띄운다(withQwenSecondarySlot) — 잡들이 겹쳐 돌아도 gpu3090 동시 호출은 감사 자리(2~4) + 1 이다.
 */
const JOB = "human-deepseek-review";
/** 한 번 부를 때의 제한 시간 — 실측 2.2~4.7초(qwen-direct-review.ts). 넘는 것은 탈로 본다 */
export const HELD_QWEN_CALL_TIMEOUT_MS = 15_000;
const MAX_FAILURES = 3;
const RETRY_MS = 15 * 60_000;
const STALE_RUNNING_MS = 120_000;

export type HeldQwenClaim = {
  attemptId: number; candidateId: number; repo: string; reason: HeldQwenReason; candidateRevision: string;
  input: ReviewInput; model: string; actor: string; lease: JobLease;
};
type ClaimResult = { kind: "claimed"; claim: HeldQwenClaim } | { kind: "reapplied" } | { kind: "skipped"; reason: string };
export type HeldQwenCallResult = { ok: true; review: QwenDirectReview } | { ok: false; code: string; detail?: string | null };
export type HeldQwenRecordState = "rejected" | "pipeline" | "held" | "failed" | "superseded";
export type HeldQwenTick = {
  started: number; rejected: number; pipeline: number; held: number; failed: number; reapplied: number;
  /** 원본을 다시 받게 한 수(requestHeldQwenSourceRefresh) */
  refreshed?: number;
  skipped?: "disabled" | "not_configured" | "backoff"; backoffUntil?: string;
};

/**
 * 이 재심사의 시도 행만 — actor 'qwen-v2:<판>' 으로 가른다. 같은 provider(qwen-direct)·kind(delegated)를 쓰는 다른 Qwen-v2 일
 * (예: 2차 갈림 판가름의 'qwen-v2-auto')의 진행 중 행을 주인 없음으로 닫거나 물러남·상태·배지에 섞지 않는다.
 */
const qwenRows = and(eq(crawlReviewAttempts.kind, "delegated"), eq(crawlReviewAttempts.provider, HELD_QWEN_PROVIDER),
  sql`${crawlReviewAttempts.actor} LIKE ${`${HELD_QWEN_ACTOR}:%`}`)!;

/** 실패 코드가 부르는 곳의 탈인가 — 제공자의 코드만 견준다(owner_lost 같은 우리 쪽 코드는 탈이 아니다) */
export function heldQwenEndpointFailure(code: string | null | undefined): boolean {
  return typeof code === "string" && code.startsWith("qwen_") && qwenEndpointFailure(code as QwenDirectErrorCode);
}
/**
 * 후보의 세 번에 드는 실패 — 그 입력 때문에 난 것(형식·입력 초과·요청 거절)만. 부르는 곳의 탈은 후보 탓이 아니라 세지 않는다 —
 * 그동안은 heldQwenBackoffUntil 이 부르는 빈도를 줄이고, 후보마다 15분을 기다린다. 제공자의 고정 코드 목록이라 SQL 도 같은 목록을 쓴다
 */
const COUNTED_FAILURES = ["qwen_invalid_json", "qwen_input_too_large", "qwen_http_400", "qwen_http_413", "qwen_http_422"] as const;
const countedFailure = (row: Pick<CrawlReviewAttempt, "state" | "errorCode">) =>
  row.state === "failed" && (COUNTED_FAILURES as readonly string[]).includes(row.errorCode ?? "");

/**
 * 같은 입력 세대의 시도 — 원본(문서 id·수집 시각)·판정 시각·스캔이 같은 것. SQL 이 고를 때 쓰는 어림이고, claim 이 입력·원본 해시로 다시 잰다.
 * c·fd·fres 는 고르는 SQL 의 별칭이다.
 */
function sameGeneration(actor: string, model: string): SQL {
  return sql`q.candidate_id = c.id AND q.kind = 'delegated' AND q.provider = ${HELD_QWEN_PROVIDER} AND q.actor = ${actor} AND q.model = ${model}
    AND q.source->>'documentId' = fd.id::text
    AND (q.source->>'documentFetchedAt')::timestamp = date_trunc('milliseconds', fd.fetched_at)
    AND (q.source->>'candidateJudgedAt')::timestamp IS NOT DISTINCT FROM date_trunc('milliseconds', c.judged_at)
    AND q.source->>'scanId' IS NOT DISTINCT FROM fres.id::text`;
}

/**
 * 이번 틱에 볼 후보 — 오래 기다린 것부터. 지금 입력이 유효하고(원본·스캔이 24시간 안), 이 세대의 판단이 없고, 기다리거나 보는 중이 아니며,
 * 실패를 다 쓰지 않은 것. 독립 투표자가 생겨 다시 관문에 넣을 수 있게 된 "승인 의견"은 모델을 다시 부르지 않고 넣으려고 고른다.
 * 판단 보류(ambiguous)는 AI 1차가 지금 볼 것이 아닐 때만 — 1차가 이 입력에서 판단 보류를 냈거나 다른 까닭으로 1차 대상이 아닐 때다.
 */
export async function heldQwenCandidates(settings: CrawlSettings, model: string, limit: number): Promise<{ id: number; repo: string }[]> {
  const policy = heldQwenRetry(settings);
  if (!policy.reasons.length) return [];
  const actor = heldQwenActor(QWEN_V2_PROMPT_VERSION);
  const now = reviewSemanticNowSql();
  const q = { kind: sql`q.kind`, provider: sql`q.provider`, actor: sql`q.actor`, state: sql`q.state`, outcome: sql`q.outcome`, model: sql`q.model` };
  const rows = await db.execute<{ id: number; repo: string }>(sql`
    SELECT c.id, c.repo FROM crawl_candidates c
    WHERE c.state = 'needs_review' AND c.decided_by = 'auto' AND c.published_slug IS NULL
      AND c.reason IN (${sql.join(policy.reasons.map((reason) => sql`${reason}`), sql`, `)})
      AND (c.reason <> 'ambiguous' OR NOT EXISTS (SELECT 1 FROM ${crawlCandidates}
        WHERE ${crawlCandidates.id} = c.id AND ${reviewCandidatePredicate(settings)}))
      AND EXISTS (SELECT 1 FROM crawl_documents fd
        LEFT JOIN LATERAL (SELECT fs.id, fs.completed_at FROM agent_repository_scans fs
          WHERE fs.repository_key = lower(c.repo) AND fs.scope = '' ORDER BY fs.started_at DESC, fs.id DESC LIMIT 1) fres ON true
        WHERE fd.repo = c.repo AND fd.product_url IS NOT DISTINCT FROM c.product_url
          AND fd.fetched_at <= ${now} AND fd.fetched_at > ${now} - interval '24 hours'
          AND (fres.completed_at IS NULL OR (fres.completed_at <= ${now} AND fres.completed_at > ${now} - interval '24 hours'))
          AND NOT EXISTS (SELECT 1 FROM crawl_review_attempts q WHERE ${sameGeneration(actor, model)}
            AND (q.state = 'running' OR q.state = 'failed' AND q.retry_after > clock_timestamp()
              OR q.state = 'succeeded' AND NOT (c.reason <> 'no_description' AND ${heldQwenGateFirstSql(settings, q)})))
          AND (SELECT count(*) FROM crawl_review_attempts q WHERE ${sameGeneration(actor, model)} AND q.state = 'failed'
            AND q.error_code IN (${sql.join(COUNTED_FAILURES.map((code) => sql`${code}`), sql`, `)})) < ${MAX_FAILURES})
    ORDER BY coalesce(c.judged_at, c.updated_at) ASC, c.id ASC
    LIMIT ${Math.max(1, Math.min(100, limit))}`);
  return rows.map((row) => ({ id: Number(row.id), repo: row.repo }));
}

/** 다른 일꾼이 남긴 진행 중 행 — 잡 lease 는 하나뿐이라 지금 lease 가 아닌 행의 주인은 이미 없다. 스위치와 상관없이 정리한다(1차 claim 을 막지 않게) */
export async function releaseLostHeldQwenAttempts(lease: JobLease): Promise<number> {
  if (lease.name !== JOB) throw new Error("held_qwen_job_required");
  return db.transaction(async (tx) => {
    const rows = await tx.update(crawlReviewAttempts).set({ state: "failed", errorCode: "owner_lost", completedAt: new Date(), retryAfter: new Date() })
      .where(and(qwenRows, eq(crawlReviewAttempts.state, "running"), sql`${crawlReviewAttempts.leaseToken} IS DISTINCT FROM ${lease.token}`,
        sql`${crawlReviewAttempts.startedAt} < now() - ${STALE_RUNNING_MS} * interval '1 millisecond'`))
      .returning({ id: crawlReviewAttempts.id });
    await assertJobLeaseAtWallTime(tx, lease);
    return rows.length;
  });
}

/**
 * 원본이 24시간을 넘겨 입력이 만료된 맡은 보류를 다시 받게 한다 — 1차 재시도 사유의 requeueStaleReviewSources 와 같은 잠금 순서·같은 조건
 * (하루 쉰 끝난 프론티어만 되돌리고, 살아 있는 수집 항목은 건드리지 않는다). 이 원본으로 Qwen-v2 가 이미 판단했으면 다시 받지 않는다 —
 * 사람에게 남은 것을 날마다 다시 받아 같은 것을 다시 묻지 않게. 스캔의 24시간은 후보의 일일 스캔(agent-evidence-refresh)이 맡는다.
 * 다시 받은 원본의 판정 대상이 바뀌었으면 수집이 후보를 판정으로 되돌린다(saveFetchedDocument) — 그것도 보류를 푸는 길이다.
 */
export async function requestHeldQwenSourceRefresh(settings: CrawlSettings, lease: JobLease, limit: number): Promise<number> {
  if (lease.name !== JOB) throw new Error("held_qwen_job_required");
  const policy = heldQwenRetry(settings);
  if (!settings.enabled || settings.reviewMode !== "enforce" || !policy.enabled || !policy.reasons.length) return 0;
  const actor = heldQwenActor(QWEN_V2_PROMPT_VERSION);
  const now = reviewSemanticNowSql();
  return db.transaction(async (tx) => {
    await lockPipelineInputStages(tx);
    const candidates = await tx.select({ id: crawlCandidates.id, repo: crawlCandidates.repo, productUrl: crawlCandidates.productUrl })
      .from(crawlCandidates).where(and(
        eq(crawlCandidates.decidedBy, "auto"), eq(crawlCandidates.state, "needs_review"), isNull(crawlCandidates.publishedSlug),
        inArray(crawlCandidates.reason, [...policy.reasons]),
        sql`NOT EXISTS (SELECT 1 FROM crawl_documents review_document
          WHERE review_document.repo = ${crawlCandidates.repo}
            AND review_document.product_url IS NOT DISTINCT FROM ${crawlCandidates.productUrl}
            AND review_document.fetched_at <= ${now} AND review_document.fetched_at > ${now} - interval '24 hours')`,
        sql`NOT EXISTS (SELECT 1 FROM crawl_frontier blocked_frontier
          WHERE lower(blocked_frontier.repo) = lower(${crawlCandidates.repo})
            AND (blocked_frontier.repo <> ${crawlCandidates.repo} OR blocked_frontier.state IN ('pending', 'fetching')
              OR blocked_frontier.updated_at > clock_timestamp() - interval '24 hours'))`,
        sql`NOT EXISTS (SELECT 1 FROM crawl_review_attempts judged JOIN crawl_documents judged_document ON judged_document.repo = ${crawlCandidates.repo}
          WHERE judged.candidate_id = ${crawlCandidates.id} AND judged.kind = 'delegated' AND judged.provider = ${HELD_QWEN_PROVIDER}
            AND judged.actor = ${actor} AND judged.state = 'succeeded' AND judged.source->>'documentId' = judged_document.id::text
            AND (judged.source->>'documentFetchedAt')::timestamp = date_trunc('milliseconds', judged_document.fetched_at))`,
      )).orderBy(asc(crawlCandidates.updatedAt), asc(crawlCandidates.id))
      .limit(Math.max(1, Math.min(50, limit))).for("update", { skipLocked: true });
    const documents = candidates.length ? await tx.select().from(crawlDocuments)
      .where(inArray(crawlDocuments.repo, candidates.map((row) => row.repo))).orderBy(asc(crawlDocuments.id)).for("share") : [];
    const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for("share");
    if (!candidates.length || !isDeepStrictEqual(mergeWithDefaults(saved?.values), settings)) {
      await assertJobLeaseAtWallTime(tx, lease);
      return 0;
    }
    for (const repo of [...new Set(candidates.map((row) => row.repo.toLowerCase()))].sort()) await lockFrontierIdentity(tx, repo);
    const frontiers = await tx.select().from(crawlFrontier)
      .where(inArray(sql`lower(${crawlFrontier.repo})`, candidates.map((row) => row.repo.toLowerCase())))
      .orderBy(asc(crawlFrontier.id)).for("update");
    const [clock] = await tx.execute<{ ms: number }>(sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::double precision AS ms`);
    const wallNow = Number(clock.ms), semanticNow = reviewSemanticNow().getTime();
    const targets: { candidateId: number; frontier: typeof crawlFrontier.$inferSelect; inserted: boolean }[] = [];
    for (const candidate of candidates) {
      if (documents.some((document) => document.repo === candidate.repo && document.productUrl === candidate.productUrl
        && document.fetchedAt.getTime() <= semanticNow && document.fetchedAt.getTime() > semanticNow - 24 * 3600_000)) continue;
      const matching = frontiers.filter((row) => row.repo.toLowerCase() === candidate.repo.toLowerCase());
      if (matching.some((row) => row.repo !== candidate.repo)) continue;
      let [frontier] = matching;
      if (frontier && (frontier.state === "pending" || frontier.state === "fetching" || frontier.updatedAt.getTime() > wallNow - 24 * 3600_000)) continue;
      const inserted = !frontier;
      // 잡아 둔 저장소 이름 잠금이 없는 행의 삽입을 줄 세운다 — 1차의 원본 재수집과 같은 신호를 쓴다(발견 수로 세지 않는다)
      if (!frontier) [frontier] = await tx.insert(crawlFrontier).values({ repo: candidate.repo, signal: "review-source-refresh", priority: 100 }).returning();
      targets.push({ candidateId: candidate.id, frontier, inserted });
    }
    // 도메인 잠금을 다 잡은 뒤 항목을 본다. 살아 있는 수집 claim 은 되돌리지 않는다
    const busy = new Set<number>();
    for (const target of targets) if (await hasLiveFetchItem(tx, target.frontier.id)) busy.add(target.frontier.id);
    for (const target of targets) await hasLiveAgentReviewItem(tx, target.candidateId);
    let queued = 0;
    for (const target of targets) {
      if (busy.has(target.frontier.id)) continue;
      if (!target.inserted) await tx.update(crawlFrontier).set({ state: "pending", attempts: 0, nextAttemptAt: sql`clock_timestamp()`,
        lastError: null, updatedAt: sql`clock_timestamp()` }).where(eq(crawlFrontier.id, target.frontier.id));
      queued++;
    }
    if (queued) await requestJob("crawl-fetch", tx);
    await assertJobLeaseAtWallTime(tx, lease);
    return queued;
  });
}

/**
 * 심사 큐 화면이 보이는 물러남 — 이 재심사의 마지막 판단·실패 행들로 어림한다(함께 쓰는 물러나기와 같은 곡선). 화면은 웹 프로세스라
 * 워커의 함께 쓰는 물러나기(qwen-endpoint-backoff.ts, 프로세스 안의 값)를 읽을 수 없어 행으로 잰다. 실제로 부르지 않게 막는 것은 워커의
 * 함께 쓰는 물러나기다(runHeldQwenRetry) — 다른 쪽이 만난 탈로 쉬는 것은 여기 보이지 않는다.
 */
export async function heldQwenBackoffUntil(now = new Date()): Promise<Date | null> {
  const recent = await db.select({ state: crawlReviewAttempts.state, errorCode: crawlReviewAttempts.errorCode, completedAt: crawlReviewAttempts.completedAt })
    .from(crawlReviewAttempts).where(and(qwenRows, inArray(crawlReviewAttempts.state, ["failed", "succeeded"]), isNotNull(crawlReviewAttempts.completedAt)))
    .orderBy(desc(crawlReviewAttempts.completedAt), desc(crawlReviewAttempts.id)).limit(8);
  let streak = 0;
  for (const row of recent) {
    if (row.state === "failed" && heldQwenEndpointFailure(row.errorCode)) streak++;
    else if (row.state === "failed" && row.errorCode === "owner_lost") continue;
    else break;
  }
  if (!streak || !recent[0]?.completedAt) return null;
  const until = new Date(recent[0].completedAt.getTime() + qwenBackoffMs(streak));
  return until > now ? until : null;
}

/** 지금 입력의 이 세대에 맞는 Qwen-v2 시도 행 */
function generationAttempts(tx: ProductTransaction, candidateId: number, input: ReviewInput, actor: string, model: string) {
  return tx.select().from(crawlReviewAttempts).where(and(qwenRows, eq(crawlReviewAttempts.candidateId, candidateId),
    eq(crawlReviewAttempts.inputHash, input.inputHash), eq(crawlReviewAttempts.sourceRevisionHash, input.sourceRevisionHash),
    eq(crawlReviewAttempts.actor, actor), eq(crawlReviewAttempts.model, model)))
    .orderBy(desc(crawlReviewAttempts.id)).for("update");
}

type Locked = NonNullable<Awaited<ReturnType<typeof lockedInput>>>;
const reasonOf = (settings: CrawlSettings, reason: string | null): HeldQwenReason | null =>
  heldQwenRetry(settings).reasons.find((value) => value === reason) ?? null;

/** claim 과 기록이 함께 보는 조건 — 스위치·적용 모드·사유·상태·원본·유효기간 */
function eligible(current: Locked | null): current is Locked {
  if (!current) return false;
  const { candidate, document, settings, input } = current;
  return settings.enabled && settings.reviewMode === "enforce" && heldQwenRetry(settings).enabled
    && reasonOf(settings, candidate.reason) !== null && candidate.state === "needs_review" && candidate.decidedBy === "auto"
    && !candidate.publishedSlug && document.productUrl === candidate.productUrl && input.validUntil > new Date();
}

/**
 * 한 후보를 잡는다 — 1차·DeepSeek 와 같은 잠금 순서(stage → 후보·원본·설정·근거 → 2차 표·시도 → 1차 항목 → 잡). 모델은 부르지 않는다.
 * 이 세대에 "승인 의견"이 이미 있고 이제 관문에 넣을 수 있으면 모델을 다시 부르지 않고 여기서 넣는다(reapplied).
 */
export async function claimHeldQwen(repo: string, lease: JobLease, model: string): Promise<ClaimResult> {
  if (lease.name !== JOB) throw new Error("held_qwen_job_required");
  const actor = heldQwenActor(QWEN_V2_PROMPT_VERSION);
  const requests: Awaited<ReturnType<typeof requestJob>>[] = [];
  const result = await db.transaction(async (tx): Promise<ClaimResult> => {
    const stages = await lockPipelineInputStages(tx);
    const [ai1, ai2] = await Promise.all([readItemStage(tx, stages.ai1), readItemStage(tx, stages.ai2)]);
    if (ai1.mode === "draining" || ai2.mode === "draining") return { kind: "skipped", reason: "draining" };
    const current = await lockedInput(tx, repo);
    if (!eligible(current)) {
      await assertJobLeaseAtWallTime(tx, lease);
      return { kind: "skipped", reason: "not_eligible" };
    }
    const { candidate, input, settings } = current;
    const reason = reasonOf(settings, candidate.reason)!;
    const pending = await tx.select({ id: secondReviews.id }).from(secondReviews).where(and(
      eq(secondReviews.candidateId, candidate.id), eq(secondReviews.status, "pending"))).for("share");
    if (pending.length) { await assertJobLeaseAtWallTime(tx, lease); return { kind: "skipped", reason: "second_review_pending" }; }
    // 한 후보에 진행 중 시도는 하나 — 1차·DeepSeek 의 것이면 비킨다. 우리 것이 다른 lease 면 주인이 없다(잡 lease 는 하나)
    const [active] = await tx.select().from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.candidateId, candidate.id), eq(crawlReviewAttempts.state, "running"))).for("update");
    if (active) {
      if (active.kind !== "delegated" || active.provider !== HELD_QWEN_PROVIDER || !active.actor?.startsWith(`${HELD_QWEN_ACTOR}:`)
        || active.leaseToken === lease.token) {
        await assertJobLeaseAtWallTime(tx, lease);
        return { kind: "skipped", reason: "running" };
      }
      await tx.update(crawlReviewAttempts).set({ state: "failed", errorCode: "owner_lost", completedAt: new Date(), retryAfter: new Date() })
        .where(eq(crawlReviewAttempts.id, active.id));
    }
    // 판단 보류는 1차가 지금 볼 것이 아닐 때만 — 1차가 이 입력을 다시 보거나 1차 항목이 살아 있으면 비킨다
    if (reason === "ambiguous") {
      const [ai1Due] = await tx.select({ id: crawlCandidates.id }).from(crawlCandidates)
        .where(and(eq(crawlCandidates.id, candidate.id), reviewCandidatePredicate(settings)));
      if (ai1Due || await hasLiveAgentReviewItem(tx, candidate.id)) {
        await assertJobLeaseAtWallTime(tx, lease);
        return { kind: "skipped", reason: "first_review_due" };
      }
    }
    const attempts = await generationAttempts(tx, candidate.id, input, actor, model);
    const decided = attempts.find((row) => row.state === "succeeded");
    if (decided) {
      // 이 세대의 판단은 한 번이다. 관문에 못 넣었던 승인 의견만, 이제 넣을 수 있으면 다시 부르지 않고 넣는다
      if (decided.outcome?.decision === "approve" && reason !== "no_description" && heldQwenGateable(settings, decided.model)) {
        const applied = await applyOutcome(tx, current, decided, decided.outcome, reason, requests, { reapplied: true });
        await assertJobLeaseAtWallTime(tx, lease);
        return applied.result === "pipeline" ? { kind: "reapplied" } : { kind: "skipped", reason: "decided" };
      }
      await assertJobLeaseAtWallTime(tx, lease);
      return { kind: "skipped", reason: "decided" };
    }
    // 세 번에 드는 것은 입력 때문에 난 실패뿐이다(countedFailure). 기다림은 모든 실패에 건다
    const lastFailure = attempts.find((row) => row.state === "failed");
    if (attempts.filter(countedFailure).length >= MAX_FAILURES || lastFailure?.retryAfter && lastFailure.retryAfter > new Date()) {
      await assertJobLeaseAtWallTime(tx, lease);
      return { kind: "skipped", reason: "retry_wait" };
    }
    const [attempt] = await tx.insert(crawlReviewAttempts).values({
      candidateId: candidate.id, kind: "delegated", state: "running", inputHash: input.inputHash,
      sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash, source: input.source, snapshot: input.snapshot,
      promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: HELD_QWEN_PROVIDER, model, actor,
      attemptNumber: attempts.length + 1, leaseToken: lease.token, validUntil: input.validUntil,
    }).returning({ id: crawlReviewAttempts.id });
    await assertJobLeaseAtWallTime(tx, lease);
    return { kind: "claimed", claim: { attemptId: attempt.id, candidateId: candidate.id, repo, reason,
      candidateRevision: candidateRevisionHash(candidate), input, model, actor, lease } };
  });
  return result;
}

/**
 * 판단을 적용한다 — 기록 트랜잭션(또는 다시 넣는 claim)이 잠근 행 위에서만. 운영 감사 한 줄을 늘 남긴다(처리·복귀·거부·보류 수의 바탕).
 *  reject → 거부(decided_by qwen-v2) · approve → 관문에 넣을 수 있으면 승인(decided_by auto, 2차 요청), 아니면 보류 · needs_review → 보류
 */
async function applyOutcome(tx: ProductTransaction, current: Locked, attempt: CrawlReviewAttempt, outcome: ReviewOutcome,
  reason: HeldQwenReason, requests: Awaited<ReturnType<typeof requestJob>>[], options: { raw?: ReviewOutcome; latencyMs?: number; reapplied?: boolean } = {},
): Promise<{ result: "rejected" | "pipeline" | "held"; cause: string | null }> {
  const { candidate, settings } = current;
  const now = new Date();
  const kept = Object.fromEntries(Object.entries(candidate.signals ?? {}).filter(([key]) => key !== "stoppedAt"));
  let result: "rejected" | "pipeline" | "held" = "held", cause: string | null = null;
  if (outcome.decision === "reject") {
    await recordHumanDecisionOverride(tx, { stage: "ai1", candidateId: candidate.id, firstAttemptId: attempt.id });
    await tx.update(crawlCandidates).set({ state: "rejected", reason: "not_a_product", decidedBy: HELD_QWEN_DECIDED_BY, decidedAt: now, updatedAt: now,
      // judgedAt 은 그대로 — 이 판단의 입력 해시에 묶인 원본이다
      signals: { ...kept, heldQwenAttemptId: attempt.id, heldQwenPreviousReason: candidate.reason,
        stoppedAt: { rule: "Qwen-v2 심사", detail: outcome.reason.slice(0, 300) } },
    }).where(eq(crawlCandidates.id, candidate.id));
    result = "rejected";
  } else if (outcome.decision === "approve") {
    if (reason === "no_description") cause = "no_description";
    else if (!heldQwenGateable(settings, attempt.model)) cause = settings.secondReview.enabled ? "no_independent_voter" : "gate_off";
    else {
      await recordHumanDecisionOverride(tx, { stage: "ai1", candidateId: candidate.id, firstAttemptId: attempt.id });
      await tx.update(crawlCandidates).set({ state: "approved", reason: "passed", decidedBy: "auto", updatedAt: now,
        signals: { ...kept, heldQwenAttemptId: attempt.id, heldQwenPreviousReason: candidate.reason },
      }).where(eq(crawlCandidates.id, candidate.id));
      // 1차 AI 승인과 같이 2차 관문을 부른다 — 발행 잡은 두 모델이 승인한 뒤 2차가 부른다
      requests.push(await requestJob("second-review", tx));
      result = "pipeline";
    }
  } else cause = "needs_review";
  await tx.insert(operationsAudit).values({
    actor: HELD_QWEN_ACTOR, actorKind: "model", ok: true, action: "candidate-qwen-held-review", target: candidate.repo,
    detail: { attemptId: attempt.id, result, cause, heldReason: reason, model: attempt.model, promptVersion: QWEN_V2_PROMPT_VERSION,
      outcome, ...(options.raw && options.raw.decision !== outcome.decision ? { modelDecision: options.raw.decision } : {}),
      ...(options.latencyMs !== undefined ? { latencyMs: options.latencyMs } : {}), ...(options.reapplied ? { reapplied: true } : {}) },
  });
  return { result, cause };
}

/** 마지막 쓰기 — 스위치·사람 결정·입력·lease 를 다시 잰다. 바뀌었으면 적용하지 않는다(superseded) */
export async function recordHeldQwen(claim: HeldQwenClaim, call: HeldQwenCallResult): Promise<HeldQwenRecordState> {
  if (claim.lease.name !== JOB) throw new Error("held_qwen_job_required");
  const requests: Awaited<ReturnType<typeof requestJob>>[] = [];
  return db.transaction(async (tx) => {
    const stages = await lockPipelineInputStages(tx);
    const [ai1, ai2] = await Promise.all([readItemStage(tx, stages.ai1), readItemStage(tx, stages.ai2)]);
    const current = await lockedInput(tx, claim.repo);
    const [attempt] = await tx.select().from(crawlReviewAttempts).where(and(eq(crawlReviewAttempts.id, claim.attemptId), qwenRows,
      eq(crawlReviewAttempts.leaseToken, claim.lease.token))).for("update");
    if (!attempt || attempt.state !== "running") { await assertJobLeaseAtWallTime(tx, claim.lease); return "superseded"; }
    const now = new Date();
    const supersede = async (code: string) => {
      await tx.update(crawlReviewAttempts).set({ state: "superseded", errorCode: code, completedAt: now }).where(eq(crawlReviewAttempts.id, attempt.id));
      await assertJobLeaseAtWallTime(tx, claim.lease);
      return "superseded" as const;
    };
    if (ai1.mode === "draining" || ai2.mode === "draining" || !eligible(current) || current.candidate.id !== claim.candidateId
      || reasonOf(current.settings, current.candidate.reason) !== claim.reason
      || candidateRevisionHash(current.candidate) !== claim.candidateRevision
      || current.input.inputHash !== attempt.inputHash || current.input.sourceRevisionHash !== attempt.sourceRevisionHash
      || current.input.policyHash !== attempt.policyHash) return supersede("input_or_switch_changed");
    if (!call.ok) {
      // 바깥 신호·예산으로 끊은 것은 모델의 실패가 아니다 — 셈에 넣지 않고 다음 틱에 다시 본다
      if (call.code === "qwen_cancelled") return supersede("qwen_cancelled");
      await tx.update(crawlReviewAttempts).set({ state: "failed", errorCode: call.code.slice(0, 120), completedAt: now,
        reason: call.detail ? call.detail.slice(0, 2000) : null, retryAfter: new Date(now.getTime() + RETRY_MS) })
        .where(eq(crawlReviewAttempts.id, attempt.id));
      await assertJobLeaseAtWallTime(tx, claim.lease);
      return "failed";
    }
    let outcome: ReviewOutcome;
    try {
      if (call.review.model !== attempt.model) throw new Error("model_mismatch");
      outcome = validateReviewOutcome(current.input, call.review.outcome);
    } catch (error) {
      await tx.update(crawlReviewAttempts).set({ state: "failed", errorCode: error instanceof Error && error.message === "model_mismatch" ? "qwen_model_mismatch" : "qwen_invalid_json",
        completedAt: now, retryAfter: new Date(now.getTime() + RETRY_MS) }).where(eq(crawlReviewAttempts.id, attempt.id));
      await assertJobLeaseAtWallTime(tx, claim.lease);
      return "failed";
    }
    const raw = outcome;
    // 확신이 낮으면 정하지 않는다 — DeepSeek 위임과 같은 문턱. 모델의 원래 답은 운영 감사에 남는다
    if (outcome.decision !== "needs_review" && (outcome.confidence ?? 0) < HELD_QWEN_MIN_CONFIDENCE) outcome = { ...outcome, decision: "needs_review" };
    await tx.update(crawlReviewAttempts).set({ state: "succeeded", outcome, reason: outcome.reason, completedAt: now, errorCode: null })
      .where(eq(crawlReviewAttempts.id, attempt.id));
    const applied = await applyOutcome(tx, current, { ...attempt, state: "succeeded", outcome }, outcome, claim.reason, requests,
      { raw, latencyMs: call.review.latencyMs });
    await assertJobLeaseAtWallTime(tx, claim.lease);
    return applied.result;
  });
}

/** 한 번 부른다 — 트랜잭션 밖. 실패는 제공자의 고정 코드로만 돌려준다 */
async function callQwen(input: ReviewInput, options: { timeoutMs: number; signal?: AbortSignal; request?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>> }): Promise<HeldQwenCallResult> {
  try { return { ok: true, review: await reviewWithQwenDirect(input, options) }; }
  catch (error) {
    if (error instanceof QwenDirectError) return { ok: false, code: error.code, detail: error.detail };
    return { ok: false, code: "qwen_invalid_json", detail: error instanceof Error ? error.message.slice(0, 120) : null };
  }
}

/**
 * human-deepseek-review 잡의 앞부분 — 보류 Qwen-v2 재심사 한 틱. 시간은 budgetSeconds 와 잡의 남은 예산 중 짧은 쪽,
 * 수는 perTick 까지. 한 번 부를 시간(HELD_QWEN_CALL_TIMEOUT_MS)이 남지 않으면 새로 부르지 않는다.
 */
export async function runHeldQwenRetry(ctx: Pick<JobContext<null>, "lease" | "hasBudget" | "deadlineAt" | "signal" | "log">, settings: CrawlSettings,
  options: { request?: typeof fetch; env?: Readonly<Record<string, string | undefined>> } = {}): Promise<HeldQwenTick> {
  const tick: HeldQwenTick = { started: 0, rejected: 0, pipeline: 0, held: 0, failed: 0, reapplied: 0 };
  const lease = ctx.lease;
  if (!lease) throw new Error("held_qwen_job_required");
  const released = await releaseLostHeldQwenAttempts(lease);
  if (released) ctx.log("crawl.held_qwen_owner_lost", { released });
  const policy = heldQwenRetry(settings);
  if (!settings.enabled || settings.reviewMode !== "enforce" || !policy.enabled || !policy.reasons.length) return { ...tick, skipped: "disabled" };
  // 입력이 만료된 맡은 보류의 원본을 다시 받게 한다 — 모델 호출과 상관없이(물러나는 중에도) 한 틱 perTick 건까지
  tick.refreshed = await requestHeldQwenSourceRefresh(settings, lease, policy.perTick);
  const config = qwenDirectConfig(options.env ?? process.env);
  if (!config) return { ...tick, skipped: "not_configured" };
  // gpu3090 을 부르는 누군가가 탈을 만나 물러나는 중이면 부르지 않는다(qwen-endpoint-backoff.ts)
  if (qwenEndpointBackingOff()) return { ...tick, skipped: "backoff", backoffUntil: new Date(qwenEndpointBackoff.retryAt).toISOString() };
  const sliceEnd = Date.now() + policy.budgetSeconds * 1000;
  const room = () => !ctx.signal?.aborted && ctx.hasBudget() && sliceEnd - Date.now() >= HELD_QWEN_CALL_TIMEOUT_MS
    && (ctx.deadlineAt === undefined || ctx.deadlineAt - Date.now() >= HELD_QWEN_CALL_TIMEOUT_MS + 2_000);
  const candidates = await heldQwenCandidates(settings, config.model, policy.perTick * 3);
  for (const candidate of candidates) {
    if (tick.started >= policy.perTick || !room()) break;
    const claimed = await claimHeldQwen(candidate.repo, lease, config.model);
    if (claimed.kind === "reapplied") { tick.reapplied++; tick.pipeline++; continue; }
    if (claimed.kind !== "claimed") continue;
    tick.started++;
    const controller = new AbortController();
    const poll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
    poll.unref?.();
    let call: HeldQwenCallResult;
    try {
      // 두 번째 자리(두 번째 의견·공개분 거르기·갈림 판가름과 나눠 쓴다)를 얻은 뒤 남은 시간·물러나기를 다시 본다 — 못 부르면 멈춤으로 적는다
      call = await withQwenSecondarySlot(async () => !room() || qwenEndpointBackingOff()
        ? { ok: false as const, code: "qwen_cancelled", detail: "secondary_slot" }
        : callQwen(claimed.claim.input, { timeoutMs: HELD_QWEN_CALL_TIMEOUT_MS, request: options.request, env: options.env,
          signal: ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal }));
    } finally { clearInterval(poll); }
    if (call.ok) noteQwenEndpointSuccess();
    else if (heldQwenEndpointFailure(call.code)) noteQwenEndpointFailure(call.code as QwenDirectErrorCode);
    const state = await recordHeldQwen(claimed.claim, call);
    if (state === "rejected") tick.rejected++;
    if (state === "pipeline") tick.pipeline++;
    if (state === "held") tick.held++;
    if (state === "failed") tick.failed++;
    // 부르는 곳의 탈이면 이 틱의 나머지를 부르지 않는다 — 다음 틱부터는 함께 쓰는 물러나기가 물린다
    if (!call.ok && (heldQwenEndpointFailure(call.code) || call.code === "qwen_cancelled")) break;
  }
  return tick;
}

export type HeldQwenStatus = {
  enabled: boolean; perTick: number; budgetSeconds: number; reasons: HeldQwenReason[];
  model: string | null; configured: boolean;
  /** 최근 24시간 — 판단 수(처리), 자동 경로 복귀(승인), 거부, 사람에게 남김, 실패 */
  day: { processed: number; pipeline: number; rejected: number; held: number; failed: number };
  lastError: { code: string; at: string } | null;
  backoffUntil: string | null;
  /** 지금 맡은 보류 — 그중 입력(원본·스캔 24시간)이 만료돼 원본·스캔 갱신을 기다리는 것 */
  waiting: number; expired: number;
};

/** 심사 큐의 상태 칸 — 운영 감사와 시도 행에서 센다. 못 읽으면 부르는 쪽이 비운다 */
export async function heldQwenRetryStatus(settings: CrawlSettings, now = new Date()): Promise<HeldQwenStatus> {
  const policy = heldQwenRetry(settings);
  const config = qwenDirectConfig(process.env);
  const since = new Date(now.getTime() - 24 * 3600_000);
  const [audit] = await db.select({
    processed: sql<number>`count(*)::int`,
    pipeline: sql<number>`count(*) filter (where ${operationsAudit.detail}->>'result' = 'pipeline')::int`,
    rejected: sql<number>`count(*) filter (where ${operationsAudit.detail}->>'result' = 'rejected')::int`,
    held: sql<number>`count(*) filter (where ${operationsAudit.detail}->>'result' = 'held')::int`,
  }).from(operationsAudit).where(and(eq(operationsAudit.action, "candidate-qwen-held-review"), gt(operationsAudit.createdAt, since)));
  const [failures] = await db.select({ count: sql<number>`count(*)::int` }).from(crawlReviewAttempts)
    .where(and(qwenRows, eq(crawlReviewAttempts.state, "failed"), ne(crawlReviewAttempts.errorCode, "owner_lost"), gt(crawlReviewAttempts.completedAt, since)));
  const [last] = await db.select({ code: crawlReviewAttempts.errorCode, at: crawlReviewAttempts.completedAt }).from(crawlReviewAttempts)
    .where(and(qwenRows, eq(crawlReviewAttempts.state, "failed"), isNotNull(crawlReviewAttempts.completedAt)))
    .orderBy(desc(crawlReviewAttempts.completedAt), desc(crawlReviewAttempts.id)).limit(1);
  const [queue] = policy.reasons.length ? await db.execute<{ waiting: number; expired: number }>(sql`
    SELECT count(*)::int AS waiting, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM crawl_documents fd
      LEFT JOIN LATERAL (SELECT fs.completed_at FROM agent_repository_scans fs WHERE fs.repository_key = lower(c.repo) AND fs.scope = ''
        ORDER BY fs.started_at DESC, fs.id DESC LIMIT 1) fres ON true
      WHERE fd.repo = c.repo AND fd.fetched_at > now() - interval '24 hours'
        AND (fres.completed_at IS NULL OR fres.completed_at > now() - interval '24 hours')))::int AS expired
    FROM crawl_candidates c WHERE c.state = 'needs_review' AND c.decided_by = 'auto' AND c.published_slug IS NULL
      AND c.reason IN (${sql.join(policy.reasons.map((reason) => sql`${reason}`), sql`, `)})`) : [{ waiting: 0, expired: 0 }];
  const backoff = await heldQwenBackoffUntil(now);
  return { enabled: policy.enabled, perTick: policy.perTick, budgetSeconds: policy.budgetSeconds, reasons: [...policy.reasons],
    model: config?.model ?? null, configured: config !== null,
    day: { processed: audit?.processed ?? 0, pipeline: audit?.pipeline ?? 0, rejected: audit?.rejected ?? 0, held: audit?.held ?? 0, failed: failures?.count ?? 0 },
    lastError: last?.code && last.at ? { code: last.code, at: last.at.toISOString() } : null,
    backoffUntil: backoff?.toISOString() ?? null, waiting: Number(queue?.waiting ?? 0), expired: Number(queue?.expired ?? 0) };
}

export type HeldQwenBadge = { label: string; title: string; tone: "soft" | "ok" | "warn" };

/**
 * 심사 큐 줄의 Qwen-v2 배지 — 그 줄의 지금 입력(입력·원본 해시)에 맞는 마지막 시도로 그린다. 보류 후보에만 단다.
 * 판단 보류·오류는 «Qwen-v2: 판단 보류», 관문에 못 넣은 승인은 «Qwen-v2: 승인 의견»이다.
 */
export async function heldQwenBadges(entries: { candidateId: number; reason: string | null; inputHash: string | null; sourceRevisionHash: string | null }[]):
  Promise<Record<number, HeldQwenBadge>> {
  const wanted = entries.filter((entry) => entry.inputHash && entry.sourceRevisionHash);
  if (!wanted.length) return {};
  const rows = await db.select().from(crawlReviewAttempts)
    .where(and(qwenRows, inArray(crawlReviewAttempts.candidateId, wanted.map((entry) => entry.candidateId))))
    .orderBy(asc(crawlReviewAttempts.candidateId), desc(crawlReviewAttempts.id));
  const badges: Record<number, HeldQwenBadge> = {};
  // 보류 재심사의 배지 — 갈림 판가름(gate-split-tiebreak.ts)의 «Qwen-v2 승인 — 발행 후보»와 갈래가 다르다는 것을 마우스를 올리면 밝힌다
  const source = "보류 재심사(소개 없음·재시도 소진·판단 보류) · ";
  for (const entry of wanted) {
    const mine = rows.filter((row) => row.candidateId === entry.candidateId && row.inputHash === entry.inputHash
      && row.sourceRevisionHash === entry.sourceRevisionHash);
    const latest = mine.find((row) => row.state !== "superseded" && !(row.state === "failed" && row.errorCode === "owner_lost"));
    if (!latest) continue;
    const confidence = typeof latest.outcome?.confidence === "number" ? ` · 확신 ${latest.outcome.confidence.toFixed(2)}` : "";
    if (latest.state === "running") badges[entry.candidateId] = { label: "Qwen-v2: 보는 중", title: `${source}Qwen-v2 가 지금 이 입력을 보고 있습니다`, tone: "soft" };
    else if (latest.state === "failed") {
      const failed = mine.filter(countedFailure).length;
      badges[entry.candidateId] = { label: "Qwen-v2: 판단 보류", tone: "warn",
        title: `${source}Qwen-v2 호출 실패 ${latest.errorCode ?? "unknown"}${countedFailure(latest) ? ` · ${failed}/${MAX_FAILURES}회` : ""}${failed < MAX_FAILURES ? " — 15분 뒤 다시 봅니다" : " — 사람이 정합니다"}` };
    } else if (latest.outcome?.decision === "approve") {
      badges[entry.candidateId] = { label: "Qwen-v2: 승인 의견", tone: "ok", title: `${source}Qwen-v2 는 승인했지만 ${entry.reason === "no_description"
        ? "소개가 없어 발행할 수 없습니다 — 소개를 적고 승인하세요" : "2차 관문에 Qwen 과 다른 투표 모델이 없어 사람에게 남겼습니다"}${confidence} · ${latest.outcome.reason.slice(0, 200)}` };
    } else if (latest.outcome) {
      badges[entry.candidateId] = { label: "Qwen-v2: 판단 보류", tone: "soft", title: `${source}Qwen-v2 판단 보류${confidence} · ${latest.outcome.reason.slice(0, 200)}` };
    }
  }
  return badges;
}

/** 지금 맡은 사유의 후보 id — 테스트·화면 보조 */
export async function heldQwenOwnedCandidateIds(settings: CrawlSettings): Promise<number[]> {
  const policy = heldQwenRetry(settings);
  if (!policy.reasons.length) return [];
  const rows = await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(and(eq(crawlCandidates.state, "needs_review"),
    eq(crawlCandidates.decidedBy, "auto"), isNull(crawlCandidates.publishedSlug), inArray(crawlCandidates.reason, [...policy.reasons])));
  return rows.map((row) => row.id);
}

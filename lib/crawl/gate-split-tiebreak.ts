import { and, eq, isNull, not, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlReviewAttempts, gateSplitTiebreaks, operationsAudit, secondReviews,
  type CrawlReviewAttempt, type GateSplitTiebreak, type SecondReview } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { assertJobLeaseAtWallTime, JobLeaseLostError, type JobLease } from "@/lib/jobs/control";
import { readItemStage } from "@/lib/jobs/items/repository";
import type { JobContext } from "@/lib/jobs/runner";
import { recordHumanDecisionOverride } from "@/lib/operations/pipeline-evidence-ledger";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewHash, type ReviewInput, type ReviewOutcome } from "./agent-review-contract";
import { candidateRevisionHash, lockedInput } from "./admin-review";
import { SPLIT_QWEN_REJECT_REASON, SPLIT_TIEBREAK_MAX_FAILURES, SPLIT_TIEBREAK_PROVIDER } from "./gate-split-tiebreak-read";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { QWEN_V2_AUTO_SOURCE, QWEN_V2_PROMPT_VERSION, QwenDirectError, qwenDirectConfig, qwenEndpointFailure, reviewWithQwenDirect,
  type QwenDirectErrorCode, type QwenDirectReview } from "./qwen-direct-review";
import { assertLiveReviewAdapterAllowed } from "./review-fixture-transport";
import { sameReviewModel } from "./review-model-identity";
import { qwenConfident, sameOpinionModel, secondRejectHolds } from "./second-opinion-rules";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import { secondReviewGeneration } from "./second-review-input";
import { getSettings } from "./settings";
import { noteQwenEndpointFailure, noteQwenEndpointSuccess, qwenEndpointBackingOff, qwenEndpointBackoff, withQwenSecondarySlot } from "./qwen-endpoint-backoff";
import type { CrawlSettings } from "./settings-schema";

/**
 * 2차 갈림 판가름 — 두 모델 승인 관문에서 갈린 보류를 세 번째 모델(gpu3090 Qwen-v2)에 한 번 더 묻는다(2026-10-21, 사용자 결정).
 *
 * 관문은 1차 AI 가 승인한 후보를 2차 모델(지금은 abcllm Qwen3.8-27B)도 승인해야 발행한다(second-review.ts). 2차가 반대하면 후보는
 * second_review_split 으로 사람에게 넘어가는데, 아무도 보지 않아 2026-10-21 프로드에 310건(하루 170건씩 늘어남, 최장 10일)이 쌓였다.
 *
 *  - 묻는 입력: 관문 표가 본 바로 그 입력 — 관문이 붙은 1차 판단(crawl_review_attempts)에 저장된 스냅숏을 쓴다. 해시로 손상을 확인하고
 *    관문 세대(secondReviewGeneration)가 같은지 본다. 원본(sourceRevisionHash)이나 판정 정책(policyHash)이 그 뒤 바뀌었으면 묻지 않는다 —
 *    새 원본을 보지 않은 답으로 닫지 않는다(ineligible, 사람에게 남김). 24시간 신선도는 보지 않는다 — 갈림 보류는 원본을 다시 받지 않아
 *    신선도를 걸면 하루 지난 것은 영영 대상이 되지 않는다.
 *  - Qwen-v2 거부: 관문 표 중 독립 모델의 거부가 있고 승인이 없을 때만(1차 승인 1 : 거부 2) 거부로 닫는다. 사람·DeepSeek 결정과 같은 길로
 *    쓴다 — 결정 기록(crawl_review_attempts kind=delegated, actor qwen-v2-auto), 작업 로그(operations_audit, actorKind model,
 *    { promptVersion, model }), 사람 결정 위 쓰기 검사(pipeline_evidence_events). 사유는 second_review_split_qwen_reject.
 *    카탈로그·디렉터리 같은 거부는 Qwen-v2 가 진짜 둘러보기 카탈로그를 가끔 거부해 세지 않는다(second-opinion-rules.ts) — 사람에게 남긴다.
 *  - Qwen-v2 승인: 발행하지 않는다. 답을 남기고 사람 큐 맨 앞에 «Qwen-v2 승인 — 발행 후보»로 세운다(gate-split-tiebreak-read.ts).
 *  - 보류·실패: 그대로 사람 몫이다.
 *
 * 2차 잡(second-review) 틱 안에서 표 심사와 나란히 돈다 — 부르는 곳이 게이트웨이가 아니라 몫이 겹치지 않는다. 한 틱에 perTick 번까지,
 * 따로 잡은 시간 안에서만 부른다. gpu3090 은 감사 Qwen 직접 심사·감사 두 번째 의견·공개분 거르기와 같은 서버다 — 감사가 아닌 쪽은
 * 이 프로세스의 두 번째 자리 하나(withQwenSecondarySlot)를 나눠 한 번에 한 호출만 띄우고, 누가 서버 탈을 만나든 모두 함께 물러난다
 * (qwen-endpoint-backoff.ts — 동시 호출은 감사 자리 + 1, 기본 3·최대 5). 관문 표나 1차가 같은 Qwen 모델이면 세 번째 표가 독립이 아니라
 * 묻지 않고 사람에게 남긴다(ineligible same_model). 모델 호출은 DB 트랜잭션 밖이다: 짧은 트랜잭션으로 잡고(running), 부르고, 쓰는 순간 후보·관문·스위치·
 * 잡 lease 를 모두 다시 확인한다. 같은 관문 세대·같은 덧붙임 판은 한 번만 묻는다(gate_split_tiebreaks 유일 색인).
 */

export { SPLIT_QWEN_REJECT_REASON, SPLIT_TIEBREAK_MAX_FAILURES } from "./gate-split-tiebreak-read";

/**
 * 한 번 부르는 제한 시간 — 실측 2.2~4.7초(qwen-direct-review.ts). 이 시간과 기록 여유가 다 남을 때만 새로 부른다 — 줄인 제한 시간으로
 * 부르지 않으니 틱 끝 때문에 난 시간 초과가 서버 탈로 셈되지 않는다(틱 끝에 끊긴 호출은 멈춤 qwen_cancelled 이다)
 */
const CALL_TIMEOUT_MS = 20_000;
const WRITE_MARGIN_MS = 2_000;
/**
 * 이 틱에서 판가름이 쓰는 시간 — 2차 잡 틱(108초) 안이다. 표 심사와 나란히 돌지만 표 심사가 일찍 끝나면 틱이 이만큼 길어지고,
 * reviewer 의 다른 잡은 그 뒤에 돈다. 실측 속도면 perTick 10 건이 이 안에 끝난다
 */
const LANE_MS = 45_000;
const ITEM_RETRY_MS = 15 * 60_000;
/**
 * 단계 전환(draining) 중에 받은 답은 버리고 이만큼 뒤에 다시 묻는다. 부르는 곳의 탈(시간 초과·연결·5xx·404·429)은 gpu3090 을 부르는
 * 모두와 함께 물러나고(qwen-endpoint-backoff.ts — 1분부터 두 배씩 15분까지), 그 항목은 물러남이 끝날 때 다시 묻는다
 */
export const SPLIT_TIEBREAK_ENDPOINT_BACKOFF_MS = 5 * 60_000;
/** 관문 입력을 다시 만들 수 없던 것은 이만큼 뒤에 다시 본다(정책을 되돌렸을 수 있다) */
const INELIGIBLE_RECHECK_MS = 6 * 3600_000;
/** 한 틱에 훑는 후보 — 잡지 못하는 것(바쁨·대상 아님)을 건너뛰어도 perTick 을 채울 만큼 */
const HINT_FACTOR = 3;
const ACTIVE_GATE = ["pending", "failed", "agreed", "needs_human"] as const;

type Hint = { candidateId: number; repo: string; generationKey: string };
/** 부를 곳의 환경변수(AUDIT_SECOND_OPINION_*) — 시험이 가짜 서버로 바꾼다 */
type QwenEnv = Readonly<Record<string, string | undefined>> | undefined;
type Claim = {
  tiebreakId: number; candidateId: number; repo: string; generationKey: string; firstAttemptId: number;
  input: ReviewInput; candidateRevision: string; gateIds: number[]; startedAt: Date;
};
type ClaimResult = { kind: "claimed"; claim: Claim } | { kind: "skipped" } | { kind: "stop"; reason: string };
type CallResult = { ok: true; review: QwenDirectReview } | { ok: false; code: string; detail: string | null; latencyMs: number };
export type SplitTiebreakTick = { calls: number; rejected: number; kept: number; held: number; failed: number; superseded: number; skipped: number;
  stopped: string | null };

/** 같은 조건으로 실제 모델 어댑터도 막힌다 — replay·고정 응답 범위에서는 판가름을 아예 돌리지 않는다(읽기·쓰기도 없다) */
function liveCallsAllowed(): boolean {
  try { assertLiveReviewAdapterAllowed(); return true; } catch { return false; }
}

/** 칸이 없는 설정 객체(부분 설정)는 꺼진 것으로 — 저장된 행은 mergeWithDefaults 가 qwenAuto 를 늘 채운다(기본 꺼짐) */
const switchOn = (settings: CrawlSettings) => settings.enabled && settings.secondReview.enabled
  && Boolean((settings.qwenAuto as CrawlSettings["qwenAuto"] | undefined)?.splitTiebreak.enabled);

/** 부르는 곳의 탈인가 — 저장된 오류 코드로 가른다. 멈춤(qwen_cancelled)과 우리 쪽 코드는 아니다 */
function endpointCode(code: string | null): boolean {
  return Boolean(code?.startsWith("qwen_")) && qwenEndpointFailure(code as QwenDirectErrorCode);
}

/**
 * 관문 표 중 Qwen-v2 거부가 다수를 만드는가.
 *
 * 1차는 늘 승인이다(관문은 1차 승인에만 붙는다). 독립 모델의 거부가 하나라도 있고 승인은 없어야 1 : 2 가 된다. 1차 확신이 낮아 2차가
 * 승인했는데도 사람에게 넘어온 것(승인 2)이나, 2차가 보류·3회 실패로 넘어온 것(거부 1 : 승인 1)은 다수가 아니다.
 * 1차와 같은 모델(대체 표의 메아리)·Qwen-v2 와 같은 모델의 표는 독립 표가 아니라 세지 않는다.
 * 카탈로그·디렉터리 같은 거부(어느 쪽 사유든)는 Qwen 의 거부를 세지 않는 예외(second-opinion-rules.ts)라 사람에게 남긴다.
 */
export function splitRejectVerdict(gates: Pick<SecondReview, "status" | "secondDecision" | "secondReason" | "model" | "firstModel">[],
  qwen: { decision: string; reason: string | null }, model: string): "apply" | "minority" | "catalog" | "not_reject" {
  if (qwen.decision !== "reject") return "not_reject";
  const independent = gates.filter(row => (row.status === "needs_human" || row.status === "agreed")
    && !sameReviewModel(row.firstModel, row.model) && !sameOpinionModel(row.model, model));
  const rejects = independent.filter(row => row.secondDecision === "reject");
  if (!rejects.length || independent.some(row => row.secondDecision === "approve")) return "minority";
  if (![qwen.reason, ...rejects.map(row => row.secondReason)].every(reason => secondRejectHolds(model, reason))) return "catalog";
  return "apply";
}

/** 1차 판단에 저장된 관문 입력 — 해시가 맞을 때만. 관문 표가 받은 입력과 같은 inputHash 다 */
function storedGateInput(first: CrawlReviewAttempt): ReviewInput | null {
  const semantic = { ...first.snapshot, evidence: first.snapshot.evidence.map(item => item.observation) };
  if (reviewHash({ snapshot: semantic, policyHash: first.policyHash }) !== first.inputHash
    || reviewHash(first.source) !== first.sourceRevisionHash) return null;
  return { snapshot: first.snapshot, inputHash: first.inputHash, policyHash: first.policyHash,
    sourceRevisionHash: first.sourceRevisionHash, source: first.source, validUntil: first.validUntil };
}

/** 잠금 없이 고르는 힌트 — 실제 조건은 잡는 트랜잭션이 다시 읽는다. 오래 갈린 것부터 */
async function splitHints(limit: number, now: Date): Promise<Hint[]> {
  const t = gateSplitTiebreaks;
  const settled = sql`exists (select 1 from ${t} where ${t.candidateId} = ${crawlCandidates.id} and ${t.generationKey} = ${secondReviews.generationKey}
    and ${t.promptVersion} = ${QWEN_V2_PROMPT_VERSION} and (${t.state} = 'succeeded' or ${t.failureCount} >= ${SPLIT_TIEBREAK_MAX_FAILURES}
      or ${t.retryAfter} > ${now.toISOString()}::timestamp))`;
  const splitAt = sql`min(coalesce(${secondReviews.reviewedAt}, ${secondReviews.createdAt}))`;
  return db.select({ candidateId: crawlCandidates.id, repo: crawlCandidates.repo, generationKey: secondReviews.generationKey })
    .from(crawlCandidates).innerJoin(secondReviews, and(eq(secondReviews.candidateId, crawlCandidates.id),
      eq(secondReviews.trigger, "ai_approved"), eq(secondReviews.status, "needs_human"), isNull(secondReviews.publishedSlug)))
    .where(and(eq(crawlCandidates.state, "needs_review"), eq(crawlCandidates.reason, "second_review_split"),
      eq(crawlCandidates.decidedBy, "auto"), isNull(crawlCandidates.publishedSlug), not(settled)))
    .groupBy(crawlCandidates.id, crawlCandidates.repo, secondReviews.generationKey)
    .orderBy(splitAt, crawlCandidates.id).limit(limit);
}

/** 이 세대의 판가름 행 — 있으면 잠근다 */
async function lockedRow(tx: ProductTransaction, candidateId: number, generationKey: string): Promise<GateSplitTiebreak | undefined> {
  const [row] = await tx.select().from(gateSplitTiebreaks).where(and(eq(gateSplitTiebreaks.candidateId, candidateId),
    eq(gateSplitTiebreaks.generationKey, generationKey), eq(gateSplitTiebreaks.promptVersion, QWEN_V2_PROMPT_VERSION))).for("update");
  return row;
}

/** 관문 입력을 다시 만들 수 없다 — 묻지 않고 사람에게 남긴다. 몇 시간 뒤 다시 본다 */
async function markIneligible(tx: ProductTransaction, hint: Hint, code: string, now: Date, existing: GateSplitTiebreak | undefined,
  model: string): Promise<void> {
  const values = { state: "ineligible" as const, errorCode: code.slice(0, 60), errorDetail: null, completedAt: now,
    retryAfter: new Date(now.getTime() + INELIGIBLE_RECHECK_MS), leaseToken: null };
  if (existing) {
    await tx.update(gateSplitTiebreaks).set(values).where(eq(gateSplitTiebreaks.id, existing.id));
    return;
  }
  await tx.insert(gateSplitTiebreaks).values({ ...values, candidateId: hint.candidateId, repo: hint.repo, generationKey: hint.generationKey,
    promptVersion: QWEN_V2_PROMPT_VERSION, model }).onConflictDoNothing();
}

type Domain = NonNullable<Awaited<ReturnType<typeof lockedInput>>>;
type Gate = { rows: SecondReview[]; first: CrawlReviewAttempt; input: ReviewInput } | { ineligible: string } | { busy: true } | { gone: true };

/**
 * 잠근 후보의 지금 관문 — 이 세대의 열린 관문 행, 그 1차 판단, 저장된 관문 입력. 쓰는 트랜잭션도 같은 검사를 다시 한다.
 * 잠금 차례는 후보 → 원본 → 설정 → 개발 근거(lockedInput) → 1차 판단 → 관문 행 → 판가름 행이다(2차 기록과 같은 앞부분).
 */
async function currentGate(tx: ProductTransaction, domain: Domain, hint: Hint): Promise<Gate> {
  const { candidate, document, input: live } = domain;
  if (candidate.id !== hint.candidateId || candidate.state !== "needs_review" || candidate.reason !== "second_review_split"
    || candidate.decidedBy !== "auto" || candidate.publishedSlug) return { gone: true };
  // 다른 심사자(1차·DeepSeek)가 이 후보를 보고 있으면 기다린다 — 같은 후보를 두 모델에 동시에 묻지 않는다
  const [running] = await tx.select({ id: crawlReviewAttempts.id }).from(crawlReviewAttempts)
    .where(and(eq(crawlReviewAttempts.candidateId, candidate.id), eq(crawlReviewAttempts.state, "running"))).for("share");
  if (running) return { busy: true };
  const gates = await tx.select().from(secondReviews).where(and(eq(secondReviews.candidateId, candidate.id),
    eq(secondReviews.trigger, "ai_approved"), isNull(secondReviews.publishedSlug))).orderBy(secondReviews.id).for("update");
  const open = gates.filter(row => (ACTIVE_GATE as readonly string[]).includes(row.status));
  const rows = open.filter(row => row.generationKey === hint.generationKey);
  if (!rows.some(row => row.status === "needs_human")) return { gone: true };
  if (open.length !== rows.length) return { ineligible: "mixed_generation" };
  // 아직 볼 표가 남았다 — 다 모인 뒤에 묻는다
  if (rows.some(row => row.status === "pending" || row.status === "failed")) return { busy: true };
  const root = rows[0];
  if (!root.firstAttemptId || rows.some(row => row.firstAttemptId !== root.firstAttemptId || row.inputHash !== root.inputHash
    || row.firstModel !== root.firstModel)) return { ineligible: "mixed_binding" };
  const [first] = await tx.select().from(crawlReviewAttempts).where(and(eq(crawlReviewAttempts.id, root.firstAttemptId),
    eq(crawlReviewAttempts.candidateId, candidate.id))).for("share");
  if (!first || first.kind !== "automatic" || first.state !== "succeeded" || first.outcome?.decision !== "approve"
    || first.inputHash !== root.inputHash || first.model !== root.firstModel) return { ineligible: "first_review_mismatch" };
  if (first.promptVersion !== REVIEW_PROMPT_VERSION || first.rulesVersion !== REVIEW_RULES_VERSION) return { ineligible: "policy_version_changed" };
  if (secondReviewGeneration(first.id, first, "ai_approved") !== hint.generationKey) return { ineligible: "generation_mismatch" };
  const input = storedGateInput(first);
  if (!input) return { ineligible: "snapshot_mismatch" };
  if (document.productUrl !== candidate.productUrl || live.sourceRevisionHash !== first.sourceRevisionHash) return { ineligible: "source_changed" };
  if (live.policyHash !== first.policyHash) return { ineligible: "policy_changed" };
  return { rows, first, input };
}

async function claimSplitTiebreak(hint: Hint, lease: JobLease, now: Date, env: QwenEnv): Promise<ClaimResult> {
  return db.transaction<ClaimResult>(async tx => {
    // DR writer fence 가 첫 잠금이다 — fence 된 DB 에는 판가름 행도 후보도 쓰지 않는다
    if (!currentReplayDb() && !await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    const stages = await lockPipelineInputStages(tx);
    const [ai1, ai2] = await Promise.all([readItemStage(tx, stages.ai1), readItemStage(tx, stages.ai2)]);
    if (ai1.mode === "draining" || ai2.mode === "draining") return { kind: "stop", reason: "stage_draining" };
    const config = qwenDirectConfig(env);
    if (!config) return { kind: "stop", reason: "qwen_not_configured" };
    const domain = await lockedInput(tx, hint.repo);
    if (domain && !switchOn(domain.settings)) return { kind: "stop", reason: "switch_off" };
    const found: Gate = domain ? await currentGate(tx, domain, hint) : { ineligible: "no_source" };
    // 같은 모델 규칙 — 관문 표나 관문이 붙은 1차가 같은 Qwen 모델이면 세 번째 표가 독립이 아니다. 묻지 않고 사람에게 남긴다
    const gate: Gate = "rows" in found && found.rows.some(row => sameOpinionModel(row.model, config.model) || sameOpinionModel(row.firstModel, config.model))
      ? { ineligible: "same_model" } : found;
    if ("gone" in gate || "busy" in gate) return { kind: "skipped" };
    const existing = await lockedRow(tx, hint.candidateId, hint.generationKey);
    if ("ineligible" in gate) {
      await markIneligible(tx, hint, gate.ineligible, now, existing, config.model);
      await assertJobLeaseAtWallTime(tx, lease);
      return { kind: "skipped" };
    }
    if (existing?.state === "succeeded" || (existing?.retryAfter && existing.retryAfter > now)
      || (existing?.state === "failed" && existing.failureCount >= SPLIT_TIEBREAK_MAX_FAILURES)) return { kind: "skipped" };
    // 틱은 겹치지 않고(잡 lease) 한 틱은 한 후보를 한 번만 잡는다 — 남은 running 은 끝내지 못한 앞 틱의 것이라 한 번의 실패로 센다
    const stale = existing?.state === "running";
    const failureCount = (existing?.failureCount ?? 0) + (stale ? 1 : 0);
    if (stale && failureCount >= SPLIT_TIEBREAK_MAX_FAILURES) {
      await tx.update(gateSplitTiebreaks).set({ state: "failed", errorCode: "owner_lost", failureCount, completedAt: now, leaseToken: null })
        .where(eq(gateSplitTiebreaks.id, existing!.id));
      await assertJobLeaseAtWallTime(tx, lease);
      return { kind: "skipped" };
    }
    const values = { state: "running" as const, model: config.model, firstAttemptId: gate.first.id, inputHash: gate.input.inputHash,
      sourceRevisionHash: gate.input.sourceRevisionHash, decision: null, confidence: null, reason: null, applied: null, decisionAttemptId: null,
      errorCode: null, errorDetail: null, failureCount, latencyMs: null, leaseToken: lease.token, startedAt: now, completedAt: null, retryAfter: null };
    const [row] = existing
      ? await tx.update(gateSplitTiebreaks).set(values).where(eq(gateSplitTiebreaks.id, existing.id)).returning({ id: gateSplitTiebreaks.id })
      : await tx.insert(gateSplitTiebreaks).values({ ...values, candidateId: hint.candidateId, repo: hint.repo,
        generationKey: hint.generationKey, promptVersion: QWEN_V2_PROMPT_VERSION }).returning({ id: gateSplitTiebreaks.id });
    await assertJobLeaseAtWallTime(tx, lease);
    return { kind: "claimed", claim: { tiebreakId: row.id, candidateId: hint.candidateId, repo: hint.repo, generationKey: hint.generationKey,
      firstAttemptId: gate.first.id, input: gate.input, candidateRevision: candidateRevisionHash(domain!.candidate),
      gateIds: gate.rows.map(item => item.id), startedAt: now } };
  });
}

async function callQwen(input: ReviewInput, options: { timeoutMs: number; signal: AbortSignal; request?: typeof fetch;
  env: QwenEnv }): Promise<CallResult> {
  const startedAt = Date.now();
  try {
    return { ok: true, review: await reviewWithQwenDirect(input, options) };
  } catch (error) {
    if (!(error instanceof QwenDirectError)) throw error;
    return { ok: false, code: error.code, detail: error.detail?.slice(0, 80) ?? null, latencyMs: Date.now() - startedAt };
  }
}

type Settled = "rejected" | "kept" | "held" | "failed" | "superseded";

/** 받은 답을 쓴다 — 잡을 때 본 것이 하나라도 바뀌었으면 답만 남기고 후보는 건드리지 않는다 */
async function settleSplitTiebreak(claim: Claim, result: CallResult, lease: JobLease): Promise<Settled> {
  return db.transaction(async tx => {
    if (!currentReplayDb() && !await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    const now = new Date();
    const stages = await lockPipelineInputStages(tx);
    const [ai1, ai2] = await Promise.all([readItemStage(tx, stages.ai1), readItemStage(tx, stages.ai2)]);
    const domain = await lockedInput(tx, claim.repo);
    const hint = { candidateId: claim.candidateId, repo: claim.repo, generationKey: claim.generationKey };
    const gate = domain ? await currentGate(tx, domain, hint) : { gone: true as const };
    const row = await lockedRow(tx, claim.candidateId, claim.generationKey);
    if (!row || row.id !== claim.tiebreakId || row.state !== "running" || row.leaseToken !== lease.token) {
      await assertJobLeaseAtWallTime(tx, lease);
      return "superseded";
    }
    const finish = async (patch: Partial<typeof gateSplitTiebreaks.$inferInsert>, settled: Settled) => {
      await tx.update(gateSplitTiebreaks).set({ completedAt: now, leaseToken: null, ...patch }).where(eq(gateSplitTiebreaks.id, row.id));
      await assertJobLeaseAtWallTime(tx, lease);
      return settled;
    };
    if (!result.ok) {
      // 멈춤은 다음 틱에 바로, 부르는 곳의 탈은 잠깐 뒤에 — 둘 다 이 항목의 실패로 세지 않는다
      const cancelled = result.code === "qwen_cancelled", endpoint = endpointCode(result.code);
      const failureCount = cancelled || endpoint ? row.failureCount : row.failureCount + 1;
      // 부르는 곳의 탈은 함께 쓰는 물러나기가 끝날 때(부르는 쪽이 이미 걸었다) 다시 묻는다
      const retryAt = cancelled ? now.getTime() : endpoint ? Math.max(now.getTime(), qwenEndpointBackoff.retryAt) : now.getTime() + ITEM_RETRY_MS;
      return finish({ state: "failed", errorCode: result.code.slice(0, 60), errorDetail: result.detail, latencyMs: result.latencyMs,
        failureCount, retryAfter: new Date(retryAt) }, "failed");
    }
    const { outcome, model, latencyMs } = result.review;
    const answer = { state: "succeeded" as const, model, decision: outcome.decision, confidence: outcome.confidence ?? null,
      reason: outcome.reason.slice(0, 2000), latencyMs, errorCode: null, errorDetail: null, retryAfter: null };
    // 단계 전환 중에는 후보를 바꾸지 않는다 — 답은 버리고 잠깐 뒤 다시 묻는다(세지 않는다)
    if (ai1.mode === "draining" || ai2.mode === "draining") return finish({ state: "failed", errorCode: "stage_draining", latencyMs,
      retryAfter: new Date(now.getTime() + SPLIT_TIEBREAK_ENDPOINT_BACKOFF_MS) }, "failed");
    if (!domain || !("rows" in gate) || candidateRevisionHash(domain.candidate) !== claim.candidateRevision
      || gate.first.id !== claim.firstAttemptId || gate.input.inputHash !== claim.input.inputHash
      || gate.rows.map(item => item.id).join() !== claim.gateIds.join()) return finish({ ...answer, applied: "superseded" }, "superseded");
    if (outcome.decision !== "reject") return finish({ ...answer, applied: "kept_human" }, "kept");
    if (!switchOn(domain.settings)) return finish({ ...answer, applied: "switch_off" }, "held");
    // 사람 없이 거부로 닫는 것은 적용 모드에서만(reopenOrphanedGateHolds 와 같다)이고 확신이 0.90 이상일 때만이다 — 아니면 답만 남긴다
    if (domain.settings.reviewMode !== "enforce") return finish({ ...answer, applied: "held_not_enforce" }, "held");
    if (!qwenConfident(outcome.confidence)) return finish({ ...answer, applied: "held_low_confidence" }, "held");
    const verdict = splitRejectVerdict(gate.rows, outcome, model);
    if (verdict !== "apply") return finish({ ...answer, applied: verdict === "catalog" ? "held_catalog" : "held_minority" }, "held");
    const attemptId = await applySplitReject(tx, { claim, domain, gate, outcome, model, tiebreakId: row.id, now });
    return finish({ ...answer, applied: "rejected", decisionAttemptId: attemptId }, "rejected");
  });
}

/**
 * 거부로 닫는다 — DeepSeek 위임 판단(human-review-repository.ts recordHumanReview)과 같은 기록을 같은 트랜잭션에 남긴다:
 * 결정 기록(kind=delegated) · 후보 상태 · 작업 로그. 사람 결정 위 쓰기 검사는 관문이 후보를 바꾸기 직전에 남기는 것과 같다.
 * 관문 행은 다음 2차 틱이 decided_elsewhere 로 닫는다(사람이 거부했을 때와 같다).
 */
async function applySplitReject(tx: ProductTransaction, input: { claim: Claim; domain: Domain; gate: Extract<Gate, { rows: SecondReview[] }>;
  outcome: ReviewOutcome; model: string; tiebreakId: number; now: Date }): Promise<number> {
  const { claim, domain: { candidate }, gate, outcome, model, tiebreakId, now } = input;
  await recordHumanDecisionOverride(tx, { stage: "ai2", candidateId: candidate.id, firstAttemptId: claim.firstAttemptId, secondReviewId: gate.rows[0].id });
  const [count] = await tx.select({ count: sql<number>`count(*)::int` }).from(crawlReviewAttempts).where(and(
    eq(crawlReviewAttempts.candidateId, candidate.id), eq(crawlReviewAttempts.kind, "delegated"), eq(crawlReviewAttempts.actor, QWEN_V2_AUTO_SOURCE)));
  const [attempt] = await tx.insert(crawlReviewAttempts).values({
    candidateId: candidate.id, kind: "delegated", state: "succeeded", inputHash: claim.input.inputHash, policyHash: claim.input.policyHash,
    sourceRevisionHash: claim.input.sourceRevisionHash, snapshot: claim.input.snapshot, source: claim.input.source,
    // 정책 글은 1차와 같고(스냅숏의 policy 에 그 판이 있다) 덧붙임 판이 이 판단의 판이다
    promptVersion: QWEN_V2_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: SPLIT_TIEBREAK_PROVIDER, model,
    attemptNumber: (count?.count ?? 0) + 1, outcome, reason: outcome.reason.slice(0, 2000), actor: QWEN_V2_AUTO_SOURCE,
    startedAt: claim.startedAt, completedAt: now, validUntil: claim.input.validUntil,
  }).returning({ id: crawlReviewAttempts.id });
  const previousStop = (candidate.signals ?? {}).stoppedAt ?? null;
  const detail = `${model} reject: ${outcome.reason}`.slice(0, 300);
  const updated = await tx.update(crawlCandidates).set({ state: "rejected", reason: SPLIT_QWEN_REJECT_REASON, decidedBy: "auto", decidedAt: now, updatedAt: now,
    signals: { ...(candidate.signals ?? {}), stoppedAt: { rule: "2차 갈림 판가름", detail },
      splitTiebreak: { id: tiebreakId, attemptId: attempt.id, model, promptVersion: QWEN_V2_PROMPT_VERSION, decision: outcome.decision,
        confidence: outcome.confidence ?? null, generationKey: claim.generationKey, previousStop } },
  }).where(and(eq(crawlCandidates.id, candidate.id), eq(crawlCandidates.state, "needs_review"),
    eq(crawlCandidates.reason, "second_review_split"), eq(crawlCandidates.decidedBy, "auto"))).returning({ id: crawlCandidates.id });
  // 후보는 이 트랜잭션이 잠그고 다시 확인했다 — 여기서 바뀌었다면 기록을 함께 되감는다
  if (!updated.length) throw new Error("split_tiebreak_candidate_changed");
  await tx.insert(operationsAudit).values({ actor: QWEN_V2_AUTO_SOURCE, actorKind: "model", ok: true,
    action: "candidate-split-tiebreak-reject", target: candidate.repo,
    detail: { candidateId: candidate.id, tiebreakId, attemptId: attempt.id, firstAttemptId: claim.firstAttemptId, generationKey: claim.generationKey,
      secondReviewIds: gate.rows.map(row => row.id), metadata: { promptVersion: QWEN_V2_PROMPT_VERSION, model }, outcome } });
  return attempt.id;
}

/**
 * 한 틱의 판가름. 2차 잡이 표 심사와 나란히 부른다(lib/crawl/jobs/second-review.ts). 던지는 것은 잡 lease 를 잃었거나 DB 가 실패했을 때뿐이다.
 * request·env 는 시험의 가짜 서버다.
 */
export async function runGateSplitTiebreak(ctx: JobContext<null>, lease: JobLease, options: {
  deadlineAt: number; request?: typeof fetch; env?: QwenEnv;
}): Promise<SplitTiebreakTick> {
  const tick: SplitTiebreakTick = { calls: 0, rejected: 0, kept: 0, held: 0, failed: 0, superseded: 0, skipped: 0, stopped: null };
  if (!liveCallsAllowed()) return { ...tick, stopped: "replay" };
  if (lease.name !== "second-review") throw new JobLeaseLostError();
  const deadlineAt = Math.min(options.deadlineAt, ctx.deadlineAt ?? Infinity, Date.now() + LANE_MS);
  const settings = await getSettings();
  if (!switchOn(settings)) return { ...tick, stopped: "switch_off" };
  // gpu3090 을 부르는 누군가가 서버 탈을 만나 물러나는 중이면 부르지 않는다(qwen-endpoint-backoff.ts)
  if (qwenEndpointBackingOff()) {
    const backoff = qwenEndpointBackoff.lastError ?? "qwen_unreachable";
    ctx.log("crawl.split_tiebreak_backoff", { error: backoff });
    return { ...tick, stopped: `backoff:${backoff}` };
  }
  const perTick = settings.qwenAuto.splitTiebreak.perTick;
  const hints = await splitHints(perTick * HINT_FACTOR, new Date());
  for (const hint of hints) {
    const left = () => deadlineAt - Date.now() - WRITE_MARGIN_MS;
    if (tick.calls >= perTick || ctx.signal?.aborted || !ctx.hasBudget() || left() < CALL_TIMEOUT_MS || qwenEndpointBackingOff()) break;
    let claimed: ClaimResult;
    try { claimed = await claimSplitTiebreak(hint, lease, new Date(), options.env); }
    catch (error) {
      // 지금 입력을 만들다 상한을 넘은 후보(createReviewInput)가 매 틱 맨 앞을 막지 않게 그 후보만 대상에서 뺀다. 나머지 오류는 그대로 던진다
      if (!(error instanceof Error) || error.message !== "review_input_too_large") throw error;
      ctx.log("crawl.split_tiebreak_claim_failed", { candidateId: hint.candidateId, error: error.message });
      await db.transaction(async tx => {
        if (!currentReplayDb() && !await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
        await markIneligible(tx, hint, error.message, new Date(), await lockedRow(tx, hint.candidateId, hint.generationKey),
          qwenDirectConfig(options.env)?.model ?? "unconfigured");
        await assertJobLeaseAtWallTime(tx, lease);
      });
      tick.skipped++;
      continue;
    }
    if (claimed.kind === "stop") { tick.stopped = claimed.reason; break; }
    if (claimed.kind === "skipped") { tick.skipped++; continue; }
    tick.calls++;
    // 남은 시간을 넘겨 기다리지 않는다 — 잡의 예산이 끝나거나 멈추라는 신호가 오면 끊는다(qwen_cancelled 로 적고 다음 틱에 다시)
    const controller = new AbortController();
    const poll = setInterval(() => { if (!ctx.hasBudget() || Date.now() >= deadlineAt) controller.abort(); }, 250);
    poll.unref?.();
    let result: CallResult;
    let callStartedAt = 0;
    try {
      // 두 번째 자리(감사 두 번째 의견·공개분 거르기와 나눠 쓴다)를 얻은 뒤 남은 시간·물러나기를 다시 본다 — 못 부르면 멈춤으로 적는다
      result = await withQwenSecondarySlot(async () => {
        if (left() < CALL_TIMEOUT_MS || qwenEndpointBackingOff()) return { ok: false as const, code: "qwen_cancelled", detail: "secondary_slot", latencyMs: 0 };
        callStartedAt = Date.now();
        return callQwen(claimed.claim.input, { timeoutMs: CALL_TIMEOUT_MS,
          signal: ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal, request: options.request, env: options.env });
      });
    } finally { clearInterval(poll); }
    // 다른 쪽이 탈을 적기 전에 띄운 호출의 답은 그 물러나기를 풀지 않는다(qwen-endpoint-backoff.ts)
    if (result.ok) await noteQwenEndpointSuccess(callStartedAt);
    else if (endpointCode(result.code)) await noteQwenEndpointFailure(result.code as QwenDirectErrorCode);
    tick[await settleSplitTiebreak(claimed.claim, result, lease)]++;
    if (!result.ok) {
      ctx.log("crawl.split_tiebreak_failed", { candidateId: hint.candidateId, error: result.code, detail: result.detail });
      // 부르는 곳의 탈이거나 멈추라는 신호면 이 틱은 더 부르지 않는다
      if (result.code === "qwen_cancelled" || endpointCode(result.code)) { tick.stopped = result.code; break; }
    }
  }
  if (hints.length) ctx.log("crawl.split_tiebreak", { ...tick, hinted: hints.length });
  return tick;
}

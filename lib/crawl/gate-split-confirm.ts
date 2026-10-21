import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gateSplitTiebreaks, type GateSplitTiebreak } from "@/lib/db/schema";
import { currentReplayDb } from "@/lib/db/replay-scope";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { assertJobLeaseAtWallTime, JobLeaseLostError, type JobLease } from "@/lib/jobs/control";
import { readItemStage } from "@/lib/jobs/items/repository";
import type { JobContext } from "@/lib/jobs/runner";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import { kstDayStart } from "@/lib/operations/windows";
import type { ReviewOutcome } from "./agent-review-contract";
import { candidateRevisionHash, lockedInput } from "./admin-review";
import { reviewWithDeepSeekRaw, type DeepSeekReviewResult } from "./deepseek-review";
import { DEEPSEEK_REVIEW_MODEL } from "./deepseek-review-policy";
import { applySplitReject, currentGate, liveCallsAllowed, lockedRow, splitRejectVerdict, switchOn, type SplitTiebreakClaim,
  type SplitTiebreakGate, type SplitTiebreakHint } from "./gate-split-tiebreak";
import { SPLIT_TIEBREAK_MAX_FAILURES } from "./gate-split-tiebreak-read";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { QWEN_V2_PROMPT_VERSION } from "./qwen-direct-review";
import { qwenConfident } from "./second-opinion-rules";
import { getSettings } from "./settings";

/**
 * 2차 갈림 판가름의 둘째 단계 — DeepSeek 확인(사용자 결정 2안, 2026-10-21).
 *
 * 첫 단계(gate-split-tiebreak.ts, 2차 잡)가 Qwen-v2 거부(확신 0.90 이상·독립 거부 다수·카탈로그 아님·적용 모드)를 applied = awaiting_deepseek
 * 로 둔다. 이 단계가 M3 DeepSeek(reviewWithDeepSeekRaw — 위임과 같은 클라이언트·같은 프롬프트)에 관문이 본 바로 그 입력을 따로 묻고, DeepSeek
 * 도 거부해야(원래 확신 SPLIT_CONFIRM_DEEPSEEK_MIN_CONFIDENCE 이상) 거부로 닫는다. 아니면 두 판단을 남기고 사람에게 둔다
 * («Qwen 거부 · DeepSeek 확인 안 됨»). 하루(KST 0시부터) 닫는 수는 qwenAuto.splitTiebreak.dailyRejectCap 까지 — 넘으면 «하루 상한»으로 사람에게.
 *
 * 어디서 도나: 사람 검토 잡(human-deepseek-review) 틱 안, DeepSeek 위임 뒤에 차례로. M3 DeepSeek 은 그 잡만 쓰고(한 번에 한 호출) 잡 lease 가
 * 틱을 하나로 줄 세우니 위임과 이 확인이 M3 에 동시에 부르지 않는다. 한 틱에 SPLIT_CONFIRM_PER_TICK 건, SPLIT_CONFIRM_LANE_MS 안에서만 —
 * 잡의 전체 예산(110초)은 그대로다. 한 호출의 제한 시간(45초)과 기록 여유가 다 남지 않으면 새로 부르지 않는다(줄인 제한 시간으로 부르지 않는다).
 * 모델 호출은 DB 트랜잭션 밖이다: 짧은 트랜잭션으로 잡고(deepseek_state running), 부르고, 쓰는 순간 DR fence(첫 잠금)·단계 전환·후보 판·관문 행·
 * 스위치·적용 모드·잡 lease 를 모두 다시 확인한다. 같은 관문 세대·같은 덧붙임 판의 판가름 행 하나에 확인도 하나다.
 * 실패: 부르는 곳의 탈(시간 초과·연결·5xx·429·404·모델 없음)은 항목의 실패로 세지 않고 이 단계만 물러난다(1분에서 두 배씩 15분까지).
 * 예산 끝·멈춤으로 끊긴 호출은 실패가 아니다(다음 틱에 다시). 형식 오류 같은 항목 탓 실패는 세 번이면 그만 묻고 사람에게 둔다.
 */

/**
 * DeepSeek 확인의 확신 문턱 — 원래 답(위임의 0.90 문턱 전)에 건다. 실측(2026-10-21, 실제 갈림 30건): DeepSeek 의 거부 확신은 대개 0.72~0.85 라
 * 0.90 을 걸면 거의 모두 판단 보류가 되고, 원래 답의 거부 15건은 모두 맞았으며(27B 의 오답과 겹친 것 0) Qwen-v2 와 함께 건 거부 11건도 0건 틀렸다.
 * 이 길만의 값이다 — 사람 검토 위임(deepseek-review-policy.ts DEEPSEEK_MIN_CONFIDENCE 0.90)은 그대로다.
 */
export const SPLIT_CONFIRM_DEEPSEEK_MIN_CONFIDENCE = 0.7;
/** 한 호출의 제한 시간 — 실측 7~31초(평균 13초). 위임(60초)보다 짧게 잡아 위임의 차례를 남긴다 */
export const SPLIT_CONFIRM_TIMEOUT_MS = 45_000;
/** 한 틱에 묻는 수와 쓰는 시간 — 하루 갈림 거부는 수십 건이라 틱(60초 간격)마다 둘이면 넉넉하다 */
export const SPLIT_CONFIRM_PER_TICK = 2;
export const SPLIT_CONFIRM_LANE_MS = 60_000;
const WRITE_MARGIN_MS = 2_000;
const ITEM_RETRY_MS = 15 * 60_000;
const DRAINING_RETRY_MS = 5 * 60_000;
const JOB = "human-deepseek-review";
const t = gateSplitTiebreaks;

/** 이 단계의 물러나기 — 이 프로세스 안의 값(사람 검토 잡은 reviewer 하나에서만 돈다). 1분부터 두 배씩 15분까지 */
export const deepseekConfirmBackoff = { failures: 0, retryAt: 0, lastError: null as string | null, failedAt: 0 };
export function resetDeepseekConfirmBackoff(): void {
  Object.assign(deepseekConfirmBackoff, { failures: 0, retryAt: 0, lastError: null, failedAt: 0 });
}
function noteConfirmFailure(code: string, now = Date.now()): void {
  deepseekConfirmBackoff.failures += 1;
  deepseekConfirmBackoff.retryAt = now + Math.min(15 * 60_000, 60_000 * 2 ** (deepseekConfirmBackoff.failures - 1));
  deepseekConfirmBackoff.lastError = code;
  deepseekConfirmBackoff.failedAt = now;
}
/** 마지막 탈보다 늦게 띄운 호출의 답만 물러나기를 푼다(qwen-endpoint-backoff.ts 와 같은 규칙) */
function noteConfirmSuccess(startedAt: number): void {
  if (startedAt > deepseekConfirmBackoff.failedAt) resetDeepseekConfirmBackoff();
}

/** 부르는 곳의 탈인가 — 항목 탓일 수 없는 것(연결·시간 초과·서버 오류·과부하·모델 없음) */
export function deepseekEndpointError(code: string): boolean {
  return code === "timeout" || code === "unreachable" || code === "model_mismatch" || /^http_(404|408|429|5\d\d)$/.test(code);
}

type ConfirmClaimResult = { kind: "claimed"; claim: SplitTiebreakClaim } | { kind: "skipped" } | { kind: "stop"; reason: string };
type ConfirmSettled = "rejected" | "held" | "capped" | "failed" | "cancelled" | "superseded";
export type SplitConfirmTick = { calls: number; rejected: number; held: number; capped: number; failed: number; cancelled: number;
  superseded: number; skipped: number; stopped: string | null };

/** 확인을 기다리는 판가름 — 오래 기다린 것부터. 실제 조건은 잡는 트랜잭션이 다시 읽는다 */
async function confirmHints(limit: number, now: Date): Promise<SplitTiebreakHint[]> {
  return db.select({ candidateId: t.candidateId, repo: t.repo, generationKey: t.generationKey }).from(t)
    .where(and(eq(t.promptVersion, QWEN_V2_PROMPT_VERSION), eq(t.state, "succeeded"), eq(t.applied, "awaiting_deepseek"),
      inArray(t.deepseekState, ["waiting", "failed", "running"]), lt(t.deepseekFailureCount, SPLIT_TIEBREAK_MAX_FAILURES),
      or(isNull(t.deepseekRetryAfter), lte(t.deepseekRetryAfter, sql`${now.toISOString()}::timestamp`))))
    .orderBy(asc(t.completedAt), asc(t.id)).limit(limit);
}

/** 오늘(KST 0시부터) 이 길로 닫은 수 — 쓰는 트랜잭션 안에서 센다(사람 검토 잡은 한 번에 하나라 겹치지 않는다) */
async function rejectedToday(tx: ProductTransaction, now: Date): Promise<number> {
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(t).where(and(eq(t.applied, "rejected"),
    sql`${t.deepseekCompletedAt} >= ${kstDayStart(sql`${now.toISOString()}::timestamp`)}`));
  return row?.count ?? 0;
}

/** 지금 관문이 판가름이 본 그 관문인가 — 아니면 그 Qwen-v2 거부는 지금 후보의 답이 아니다 */
function sameGate(gate: SplitTiebreakGate, row: GateSplitTiebreak): gate is Extract<SplitTiebreakGate, { rows: unknown[] }> {
  return "rows" in gate && gate.first.id === row.firstAttemptId && gate.input.inputHash === row.inputHash;
}

async function claimConfirmation(hint: SplitTiebreakHint, lease: JobLease, now: Date): Promise<ConfirmClaimResult> {
  return db.transaction<ConfirmClaimResult>(async tx => {
    // DR writer fence 가 첫 잠금이다 — fence 된 DB 에는 판가름 행도 후보도 쓰지 않는다
    if (!currentReplayDb() && !await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    const stages = await lockPipelineInputStages(tx);
    const [ai1, ai2] = await Promise.all([readItemStage(tx, stages.ai1), readItemStage(tx, stages.ai2)]);
    if (ai1.mode === "draining" || ai2.mode === "draining") return { kind: "stop", reason: "stage_draining" };
    const domain = await lockedInput(tx, hint.repo);
    if (domain && !switchOn(domain.settings)) return { kind: "stop", reason: "switch_off" };
    if (domain && domain.settings.reviewMode !== "enforce") return { kind: "stop", reason: "not_enforce" };
    const gate: SplitTiebreakGate = domain ? await currentGate(tx, domain, hint) : { gone: true };
    const row = await lockedRow(tx, hint.candidateId, hint.generationKey);
    if (!row || row.state !== "succeeded" || row.applied !== "awaiting_deepseek" || row.decision !== "reject") return { kind: "skipped" };
    if ("busy" in gate) return { kind: "skipped" };
    const done = async (patch: Partial<typeof t.$inferInsert>) => {
      await tx.update(t).set({ deepseekLeaseToken: null, deepseekCompletedAt: now, ...patch }).where(eq(t.id, row.id));
      await assertJobLeaseAtWallTime(tx, lease);
      return { kind: "skipped" as const };
    };
    // 그 사이 사람이 정했거나 관문·입력이 바뀌었다 — 묻지 않는다
    if (!domain || !sameGate(gate, row)) return done({ applied: "superseded", deepseekState: null });
    if (row.deepseekRetryAfter && row.deepseekRetryAfter > now) return { kind: "skipped" };
    // 틱은 겹치지 않고(잡 lease) 한 틱은 한 행을 한 번만 잡는다 — 남은 running 은 끝내지 못한 앞 틱의 것이라 한 번의 실패로 센다
    const failureCount = row.deepseekFailureCount + (row.deepseekState === "running" ? 1 : 0);
    if (failureCount >= SPLIT_TIEBREAK_MAX_FAILURES) {
      return done({ applied: "held_deepseek_error", deepseekState: "failed", deepseekErrorCode: row.deepseekErrorCode ?? "owner_lost", deepseekFailureCount: failureCount });
    }
    await tx.update(t).set({ deepseekState: "running", deepseekLeaseToken: lease.token, deepseekStartedAt: now, deepseekFailureCount: failureCount })
      .where(eq(t.id, row.id));
    await assertJobLeaseAtWallTime(tx, lease);
    return { kind: "claimed", claim: { tiebreakId: row.id, candidateId: hint.candidateId, repo: hint.repo, generationKey: hint.generationKey,
      firstAttemptId: gate.first.id, input: gate.input, candidateRevision: candidateRevisionHash(domain.candidate),
      gateIds: gate.rows.map(item => item.id), startedAt: now } };
  });
}

/** 받은 답을 쓴다 — 잡을 때 본 것이 하나라도 바뀌었으면 답만 남기고 후보는 건드리지 않는다 */
async function settleConfirmation(claim: SplitTiebreakClaim, result: DeepSeekReviewResult, lease: JobLease, latencyMs: number): Promise<ConfirmSettled> {
  return db.transaction(async tx => {
    if (!currentReplayDb() && !await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    const now = new Date();
    const stages = await lockPipelineInputStages(tx);
    const [ai1, ai2] = await Promise.all([readItemStage(tx, stages.ai1), readItemStage(tx, stages.ai2)]);
    const domain = await lockedInput(tx, claim.repo);
    const hint = { candidateId: claim.candidateId, repo: claim.repo, generationKey: claim.generationKey };
    const gate: SplitTiebreakGate = domain ? await currentGate(tx, domain, hint) : { gone: true };
    const row = await lockedRow(tx, claim.candidateId, claim.generationKey);
    if (!row || row.id !== claim.tiebreakId || row.deepseekState !== "running" || row.deepseekLeaseToken !== lease.token) {
      await assertJobLeaseAtWallTime(tx, lease);
      return "superseded";
    }
    const finish = async (patch: Partial<typeof t.$inferInsert>, settled: ConfirmSettled) => {
      await tx.update(t).set({ deepseekLeaseToken: null, deepseekCompletedAt: now, deepseekLatencyMs: latencyMs, ...patch }).where(eq(t.id, row.id));
      await assertJobLeaseAtWallTime(tx, lease);
      return settled;
    };
    if (!result.ok) {
      // 예산 끝·멈춤으로 끊긴 것은 실패가 아니다 — 다음 틱에 다시. 부르는 곳의 탈은 세지 않고 이 단계의 물러나기가 끝날 때 다시 묻는다
      if (result.error === "cancelled") return finish({ deepseekState: "waiting", deepseekCompletedAt: row.deepseekCompletedAt }, "cancelled");
      const error = { deepseekErrorCode: result.error.slice(0, 60), deepseekErrorDetail: null };
      if (deepseekEndpointError(result.error)) {
        return finish({ ...error, deepseekState: "failed", deepseekRetryAfter: new Date(Math.max(now.getTime(), deepseekConfirmBackoff.retryAt)) }, "failed");
      }
      const failureCount = row.deepseekFailureCount + 1;
      return finish({ ...error, deepseekState: "failed", deepseekFailureCount: failureCount, deepseekRetryAfter: new Date(now.getTime() + ITEM_RETRY_MS),
        ...(failureCount >= SPLIT_TIEBREAK_MAX_FAILURES ? { applied: "held_deepseek_error" } : {}) }, "failed");
    }
    const outcome: ReviewOutcome = result.outcome;
    // 단계 전환 중에는 후보를 바꾸지 않는다 — 답은 버리고 잠깐 뒤 다시 묻는다(세지 않는다)
    if (ai1.mode === "draining" || ai2.mode === "draining") {
      return finish({ deepseekState: "failed", deepseekErrorCode: "stage_draining", deepseekRetryAfter: new Date(now.getTime() + DRAINING_RETRY_MS) }, "failed");
    }
    const answered = { deepseekState: "succeeded" as const, deepseekModel: DEEPSEEK_REVIEW_MODEL, deepseekOutcome: outcome,
      deepseekErrorCode: null, deepseekErrorDetail: null, deepseekRetryAfter: null };
    if (!domain || !sameGate(gate, row) || candidateRevisionHash(domain.candidate) !== claim.candidateRevision
      || gate.first.id !== claim.firstAttemptId || gate.input.inputHash !== claim.input.inputHash
      || gate.rows.map(item => item.id).join() !== claim.gateIds.join()) return finish({ ...answered, applied: "superseded" }, "superseded");
    if (!switchOn(domain.settings)) return finish({ ...answered, applied: "switch_off" }, "held");
    if (domain.settings.reviewMode !== "enforce") return finish({ ...answered, applied: "held_not_enforce" }, "held");
    // 첫 단계가 건 조건을 같은 잠금 안에서 다시 잰다 — Qwen-v2 의 답이 없거나 문턱 아래면 닫지 않는다
    const qwen = row.qwenOutcome;
    if (!qwen || qwen.decision !== "reject" || !qwenConfident(qwen.confidence)) return finish({ ...answered, applied: "held_low_confidence" }, "held");
    const verdict = splitRejectVerdict(gate.rows, qwen, row.model);
    if (verdict !== "apply") return finish({ ...answered, applied: verdict === "catalog" ? "held_catalog" : "held_minority" }, "held");
    // DeepSeek 이 거부로 확인하지 않았다(승인·판단 보류·문턱 아래) — 두 판단을 남기고 사람에게
    if (outcome.decision !== "reject" || (outcome.confidence ?? 0) < SPLIT_CONFIRM_DEEPSEEK_MIN_CONFIDENCE) {
      return finish({ ...answered, applied: "held_deepseek" }, "held");
    }
    if (await rejectedToday(tx, now) >= domain.settings.qwenAuto.splitTiebreak.dailyRejectCap) {
      return finish({ ...answered, applied: "held_daily_cap" }, "capped");
    }
    const attemptId = await applySplitReject(tx, { claim, domain, gate, outcome: qwen, model: row.model, tiebreakId: row.id, now,
      confirmation: { model: DEEPSEEK_REVIEW_MODEL, outcome } });
    return finish({ ...answered, applied: "rejected", decisionAttemptId: attemptId }, "rejected");
  });
}

/**
 * 한 틱의 DeepSeek 확인 — 사람 검토 잡이 위임 뒤에 부른다(lib/crawl/jobs/human-review.ts). 던지는 것은 잡 lease 를 잃었거나 DB 가 실패했을 때뿐이다.
 * request 는 시험의 가짜 M3 다.
 */
export async function runSplitTiebreakConfirmations(ctx: Pick<JobContext<null>, "hasBudget" | "deadlineAt" | "signal" | "log">, lease: JobLease,
  options: { request?: typeof fetch } = {}): Promise<SplitConfirmTick> {
  const tick: SplitConfirmTick = { calls: 0, rejected: 0, held: 0, capped: 0, failed: 0, cancelled: 0, superseded: 0, skipped: 0, stopped: null };
  if (!liveCallsAllowed()) return { ...tick, stopped: "replay" };
  if (lease.name !== JOB) throw new JobLeaseLostError();
  const settings = await getSettings();
  if (!switchOn(settings)) return { ...tick, stopped: "switch_off" };
  if (settings.reviewMode !== "enforce") return { ...tick, stopped: "not_enforce" };
  if (deepseekConfirmBackoff.retryAt > Date.now()) return { ...tick, stopped: `backoff:${deepseekConfirmBackoff.lastError ?? "unreachable"}` };
  const laneEnd = Date.now() + SPLIT_CONFIRM_LANE_MS;
  const left = () => Math.min(laneEnd, ctx.deadlineAt ?? Infinity) - Date.now() - WRITE_MARGIN_MS;
  const room = () => tick.calls < SPLIT_CONFIRM_PER_TICK && !ctx.signal?.aborted && ctx.hasBudget() && left() >= SPLIT_CONFIRM_TIMEOUT_MS
    && deepseekConfirmBackoff.retryAt <= Date.now();
  if (!room()) return { ...tick, stopped: "no_budget" };
  const hints = await confirmHints(SPLIT_CONFIRM_PER_TICK * 3, new Date());
  for (const hint of hints) {
    if (!room()) break;
    let claimed: ConfirmClaimResult;
    try { claimed = await claimConfirmation(hint, lease, new Date()); }
    catch (error) {
      // 지금 입력을 만들다 상한을 넘은 후보가 매 틱 맨 앞을 막지 않게 그 행만 사람에게 둔다. 나머지 오류는 그대로 던진다
      if (!(error instanceof Error) || error.message !== "review_input_too_large") throw error;
      await db.transaction(async tx => {
        if (!currentReplayDb() && !await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
        const row = await lockedRow(tx, hint.candidateId, hint.generationKey);
        if (row?.applied === "awaiting_deepseek") {
          await tx.update(t).set({ applied: "held_deepseek_error", deepseekState: "failed", deepseekErrorCode: error.message, deepseekCompletedAt: new Date(),
            deepseekLeaseToken: null }).where(eq(t.id, row.id));
        }
        await assertJobLeaseAtWallTime(tx, lease);
      });
      tick.skipped++;
      continue;
    }
    if (claimed.kind === "stop") { tick.stopped = claimed.reason; break; }
    if (claimed.kind === "skipped") { tick.skipped++; continue; }
    tick.calls++;
    // 잡의 예산이 끝나거나 멈추라는 신호가 오면 끊는다 — 실패가 아니다(cancelled, 다음 틱에 다시)
    const deadlineAt = Math.min(laneEnd, ctx.deadlineAt ?? Infinity);
    const controller = new AbortController();
    const poll = setInterval(() => { if (!ctx.hasBudget() || Date.now() >= deadlineAt) controller.abort(); }, 250);
    poll.unref?.();
    const callStartedAt = Date.now();
    let result: DeepSeekReviewResult;
    try {
      result = await reviewWithDeepSeekRaw(claimed.claim.input, { timeoutMs: SPLIT_CONFIRM_TIMEOUT_MS, request: options.request,
        signal: ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal });
    } finally { clearInterval(poll); }
    const latencyMs = Date.now() - callStartedAt;
    if (result.ok) noteConfirmSuccess(callStartedAt);
    else if (deepseekEndpointError(result.error)) noteConfirmFailure(result.error);
    tick[await settleConfirmation(claimed.claim, result, lease, latencyMs)]++;
    if (!result.ok) {
      ctx.log("crawl.split_tiebreak_confirm_failed", { candidateId: hint.candidateId, error: result.error });
      if (result.error === "cancelled" || deepseekEndpointError(result.error)) { tick.stopped = result.error; break; }
    }
  }
  if (hints.length) ctx.log("crawl.split_tiebreak_confirm", { ...tick, hinted: hints.length });
  return tick;
}

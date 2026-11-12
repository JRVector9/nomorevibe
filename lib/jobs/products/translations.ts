import { translateProductFieldsWithModelCapacity } from "@/lib/domain/products/product-translation-model-capacity";
import { checkProductTranslation, packProductTranslationBatch, productTranslationPolicy, productTranslationSourceHash,
  productTranslationTaskKey, translationSourceText } from "@/lib/domain/products/translation-policy";
import { pendingProductTranslations, recordProductTranslations, type ProductTranslationResult, type ProductTranslationTask } from "@/lib/domain/products/translations";
import { deferredJob, type JobContext, type JobOutcome } from "@/lib/jobs/runner";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { productTranslationClientTimeoutMs } from "@/lib/llm/deadline-ladder";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";
import { TextTaskRanks, type TextRankRun } from "@/lib/llm/ai-task-resolver";
import { pendingTextPoolModel } from "@/lib/llm/text-task-pool-resume";
import { modelRequestBudget } from "@/lib/llm/model-registry";
import { readModelCapacityCallerControl } from "@/lib/llm/capacity-repository";
import { PRODUCT_TRANSLATION_SELECTION_ROUNDS } from "./translation-rounds";

const JOB = "product-translate";

/** 한 틱에 호출 없이 넘길 수 있는 묶음 수 상한 — 고르기·장부 요청이 틱마다 끝없이 돌지 않게 한다(관리 화면 설명과 같은 값). */
const MAX_SELECTION_ROUNDS = PRODUCT_TRANSLATION_SELECTION_ROUNDS;

/**
 * One demanded batch per lane/tick, bounded by the route concurrency (default 1). Each call still contains at most four fields.
 * Budget: productTranslationJobBudgetMs — client timeout + jobMarginMs. No catalog backfill.
 * Source cap and batch packing come from the tick's runtime_settings translation.product (productTranslationPolicy), so an admin save applies on the next tick.
 *
 * 2026-10-30 소유자 결정("미확인이 되어도 절대 멈추지 않는다"): 호출 없이 끝난 묶음 — 같은 작업이 다른 요청에 묶인 미룸(dispatched·work_busy)과
 * 원문이 바뀐 skipped — 은 그 멤버만 이 틱에서 넘기고 다음 수요로 다시 고른다. 맨 앞 한 묶음이 경로 전체를 세우지 않는다.
 * 호출한 묶음의 실패·미확인은 기존처럼 attempts·retry_at 으로 적혀 다음 틱이 뒤의 수요를 고른다. 포화·정책·owner 미룸은 틱 전체를 미룬다.
 */
export async function translateDemandedProductFields(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  // 「작업 ↔ 모델」 순위(PR B)만 부른다 — 순위가 없거나 모두 쓸 수 없으면 기본값으로 부르지 않고 제 일 못 한 틱으로 남긴다
  const ranks = await TextTaskRanks.open(JOB);
  try { return await translateWithRanks(ctx, ranks); }
  finally { ctx.log("ai_task.ranks", ranks.summary()); }
}

type Flow = { kind: "skipped" } | { kind: "stopped" } | { kind: "recorded"; stored: number };

async function translateWithRanks(ctx: JobContext<null>, ranks: TextTaskRanks): Promise<JobOutcome<null>> {
  const early = ranks.earlyDegraded();
  if (early) {
    ctx.log("product_translation.deferred", { reason: early.code });
    return { done: true, degraded: early };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("Product translation worker requires a job lease");
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const ownershipPoll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
  ownershipPoll.unref?.();
  try {
    const policy = productTranslationPolicy();
    const passed = new Set<string>(), scheduled = new Map<string, symbol>();
    const pendingRequestIds = new Set<string>();
    const control = await readModelCapacityCallerControl();
    if (control.mode !== "disabled" && control.mode !== "open") throw new ModelCapacityDeferredError("draining");
    // 「동시에」(칸 수를 적은 묶음)면 칸 수의 합만큼 함께 돈다 — 그 밖은 예전처럼 단계 동시 수(TextTaskRanks.lanes)
    const base = Math.min(modelRequestBudget(JOB).concurrency, MAX_SELECTION_ROUNDS);
    const concurrency = control.mode === "disabled" ? 1 : ranks.lanes(base);
    const maxRounds = concurrency > base ? Math.max(MAX_SELECTION_ROUNDS, concurrency * 2) : MAX_SELECTION_ROUNDS;
    let recorded = 0, rounds = 0, stopClaims = false;
    let selection: Promise<void> = Promise.resolve();
    // Queue selection is serial even when HTTP is parallel. Reserve these task keys
    // locally before releasing the next lane; durable admission remains in the existing capacity adapter.
    const takeBatch = (lane: symbol): Promise<ProductTranslationTask[] | null> => {
      const next = selection.then(async () => {
        while (!stopClaims && rounds++ < maxRounds && ctx.hasBudget() && !signal.aborted && !ranks.exhausted) {
          const tasks = (await pendingProductTranslations(policy.batchMax, { exclude: [...passed, ...scheduled.keys()] }))
            .filter(task => !passed.has(productTranslationTaskKey(task)) && !scheduled.has(productTranslationTaskKey(task)));
          if (!tasks.length || !ctx.hasBudget() || signal.aborted || stopClaims) return null;
          const retired = tasks.filter((task) => !task.eligible || productTranslationSourceHash(task.source, task.field) !== task.sourceHash
            || translationSourceText(task.source, task.field).length > policy.maxSourceChars);
          if (retired.length) {
            const retiredStored = await recordProductTranslations(retired.map((task) => ({ task,
              result: { ok: false, error: translationSourceText(task.source, task.field).length > policy.maxSourceChars ? "source_too_long" : "stale_source", model: "" } as ProductTranslationResult,
            })), lease);
            recorded += retiredStored;
          }
          for (const task of retired) passed.add(productTranslationTaskKey(task));
          // Long descriptions remain single calls; short fields keep the existing batch bound.
          const batch = packProductTranslationBatch(tasks.filter((task) => !retired.includes(task)
            && !scheduled.has(productTranslationTaskKey(task)) && !passed.has(productTranslationTaskKey(task))), policy);
          for (const task of batch) scheduled.set(productTranslationTaskKey(task), lane);
          if (batch.length) return batch;
        }
        return null;
      });
      selection = next.then(() => {}, () => { stopClaims = true; });
      return next;
    };
    const runLane = async () => {
      const lane = Symbol("translation-lane");
      const pendingClaims = { requestIds: pendingRequestIds, claimBatch: (tasks: readonly ProductTranslationTask[]) => {
        const keys = tasks.map(productTranslationTaskKey);
        if (keys.some(key => passed.has(key) || scheduled.has(key) && scheduled.get(key) !== lane)) return false;
        keys.forEach(key => scheduled.set(key, lane));
        return true;
      } };
      while (!stopClaims && ctx.hasBudget() && !signal.aborted) {
        const batch = await takeBatch(lane);
        if (!batch || stopClaims || !ctx.hasBudget() || signal.aborted) return;
        let attempt: TextRankRun<Flow>;
        try {
          const prefer = await pendingTextPoolModel(ranks, pendingRequestIds);
          // 순위 차례로 부른다 — 이 모델만의 까닭(경로 없음·장비 행 없음·계약 닫힘·포화)이면 같은 묶음을 다음 순위로(TextTaskRanks.run)
          attempt = await ranks.run(async (): Promise<Flow> => {
            // Outermost HTTP deadline (routes.limits.product-translate.timeoutMs, read per tick) fits the job budget; inner M1 bounds still require measurement and enforcement.
            const outcome = await translateProductFieldsWithModelCapacity(batch, lease, { timeoutMs: productTranslationClientTimeoutMs(), signal, deadlineAt: ctx.deadlineAt, pendingClaims, requireAdmission: concurrency > 1 });
            if (outcome.kind === "skipped") return { kind: "skipped" };
            const response = outcome.result;
            const completedBatch = outcome.batch ?? batch;
            if (ctx.signal?.aborted) return { kind: "stopped" };
            // Account for calls aborted by the tick budget. The final lease check in
            // recordProductTranslations rolls back writes if ownership was actually lost.
            const model = textTaskModel(JOB);
            const entries = completedBatch.map((task, index): { task: typeof task; result: ProductTranslationResult } => {
              if (!response.ok) return { task, result: { ok: false, error: response.error, model } };
              const checked = checkProductTranslation(response.outputs[index], task.source, task.locale, task.field);
              return { task, result: checked.ok ? { ok: true, text: checked.text, model } : { ok: false, error: `rejected:${checked.reason}`, model } };
            });
            const stored = await (outcome.expectation ? recordProductTranslations(entries, lease, outcome.expectation)
              : recordProductTranslations(entries, lease));
            ctx.log("product_translation.tick", { model: textTaskModel(JOB), demanded: completedBatch.length, stored,
              accepted: entries.filter(({ result }) => result.ok).length, gatewayError: response.ok ? null : response.error, passed: passed.size });
            return { kind: "recorded", stored };
          }, { prefer });
        } catch (error) {
          // 이 묶음만의 미룸, 또는 「동시에」에서 고른 구성원만의 미룸(그 구성원은 이 틱 동안 쉬고 다음 묶음은 남은 구성원이 받는다)
          if (!ranks.skipsWork(error)) {
            stopClaims = true;
            throw error;
          }
          // 호출은 없었다. 이 멤버만 이 틱에서 넘기고(시도·실패 기록 없음) 뒤의 수요로 다시 고른다.
          for (const task of batch) passed.add(productTranslationTaskKey(task));
          ctx.log("product_translation.passed", { reason: error.reason, demanded: batch.length, passed: passed.size });
          continue;
        }
        if (attempt.kind === "unusable") {
          stopClaims = true;
          return;
        }
        // 「동시에」: 이 줄에 내줄 빈 칸이 없다 — 집은 묶음을 놓고(다른 줄이 집는다) 이 줄만 끝낸다
        if (attempt.kind === "idle") {
          for (const task of batch) if (scheduled.get(productTranslationTaskKey(task)) === lane) scheduled.delete(productTranslationTaskKey(task));
          return;
        }
        if (attempt.value.kind === "skipped") {
          for (const task of batch) passed.add(productTranslationTaskKey(task));
          continue;
        }
        if (attempt.value.kind === "stopped") { stopClaims = true; return; }
        recorded += attempt.value.stored;
        return;
      }
    };
    // A failed lane stops new claims. Already-dispatched siblings finish their
    // existing terminal reconciliation and fenced writer before this tick returns.
    const outcomes = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
      try { await runLane(); }
      catch (error) { stopClaims = true; throw error; }
    }));
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    const failure = failures.find(outcome => !(outcome.reason instanceof ModelCapacityDeferredError)) ?? failures[0];
    if (failure) {
      if (failure.reason instanceof ModelCapacityDeferredError && recorded >= 1) return deferredJob("model_capacity", recorded);
      throw failure.reason;
    }
    if (signal.aborted || !ctx.hasBudget()) return { done: false };
    if (!recorded && ranks.poolIdle() && !ranks.exhausted) return deferredJob("model_capacity", 0);
    if (ranks.exhausted) {
      ctx.log("product_translation.all_ranks_unusable", { recorded, passed: passed.size });
      if (ranks.saturated()) return deferredJob("model_capacity", recorded);
      return recorded ? { done: true } : { done: true, degraded: ranks.degraded() };
    }
    return { done: true };
  } finally {
    clearInterval(ownershipPoll);
  }
}

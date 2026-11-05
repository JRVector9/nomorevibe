import { translateProductFieldsWithModelCapacity } from "@/lib/domain/products/product-translation-model-capacity";
import { checkProductTranslation, packProductTranslationBatch, productTranslationPolicy, productTranslationSourceHash,
  productTranslationTaskKey, translationSourceText } from "@/lib/domain/products/translation-policy";
import { pendingProductTranslations, recordProductTranslations, type ProductTranslationResult } from "@/lib/domain/products/translations";
import { deferredJob, type JobContext, type JobOutcome } from "@/lib/jobs/runner";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerWork } from "@/lib/llm/capacity-deferred";
import { productTranslationClientTimeoutMs } from "@/lib/llm/deadline-ladder";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";
import { TextTaskRanks, type TextRankRun } from "@/lib/llm/ai-task-resolver";
import { pendingTextPoolModel } from "@/lib/llm/text-task-pool-resume";

const JOB = "product-translate";

/** 한 틱에 호출 없이 넘길 수 있는 묶음 수 상한 — 고르기·장부 요청이 틱마다 끝없이 돌지 않게 한다. */
const MAX_SELECTION_ROUNDS = 8;

/**
 * One call / at most four demanded fields per text-role tick (budget: productTranslationJobBudgetMs — client timeout + jobMarginMs). No catalog backfill.
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

type Flow = { kind: "skipped" } | { kind: "stopped" } | { kind: "recorded" };

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
    const passed = new Set<string>();
    let recorded = 0;
    for (let round = 0; round < MAX_SELECTION_ROUNDS; round++) {
      const tasks = (await pendingProductTranslations(policy.batchMax, { exclude: [...passed] }))
        .filter(task => !passed.has(productTranslationTaskKey(task)));
      if (!tasks.length || !ctx.hasBudget() || signal.aborted) break;
      const retired = tasks.filter((task) => !task.eligible || productTranslationSourceHash(task.source, task.field) !== task.sourceHash
        || translationSourceText(task.source, task.field).length > policy.maxSourceChars);
      if (retired.length) {
        await recordProductTranslations(retired.map((task) => ({ task,
          result: { ok: false, error: translationSourceText(task.source, task.field).length > policy.maxSourceChars ? "source_too_long" : "stale_source", model: "" } as ProductTranslationResult,
        })), lease);
        recorded += retired.length;
      }
      for (const task of retired) passed.add(productTranslationTaskKey(task));
      // 긴 설명은 단독, 짧은 것만 묶인다(translation.product.batchChars) — 300초 상한 안에 끝나게.
      const batch = packProductTranslationBatch(tasks.filter((task) => !retired.includes(task)), policy);
      if (!batch.length) continue;
      if (!ctx.hasBudget() || signal.aborted) break;
      let attempt: TextRankRun<Flow>;
      try {
        const prefer = await pendingTextPoolModel(ranks);
        // 순위 차례로 부른다 — 이 모델만의 까닭(경로 없음·장비 행 없음·계약 닫힘·포화)이면 같은 묶음을 다음 순위로(TextTaskRanks.run)
        attempt = await ranks.run(async (): Promise<Flow> => {
          // Outermost HTTP deadline (routes.limits.product-translate.timeoutMs, read per tick) fits the job budget; inner M1 bounds still require measurement and enforcement.
          const outcome = await translateProductFieldsWithModelCapacity(batch, lease, { timeoutMs: productTranslationClientTimeoutMs(), signal, deadlineAt: ctx.deadlineAt });
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
          return { kind: "recorded" };
        }, { prefer });
      } catch (error) {
        if (!(error instanceof ModelCapacityDeferredError) || !modelCapacityDeferralIsPerWork(error.reason)) {
          if (error instanceof ModelCapacityDeferredError && recorded >= 1) return deferredJob("model_capacity", recorded);
          throw error;
        }
        // 호출은 없었다. 이 멤버만 이 틱에서 넘기고(시도·실패 기록 없음) 뒤의 수요로 다시 고른다.
        for (const task of batch) passed.add(productTranslationTaskKey(task));
        ctx.log("product_translation.passed", { reason: error.reason, demanded: batch.length, passed: passed.size });
        continue;
      }
      if (attempt.kind === "unusable") {
        // 모든 순위가 이 틱에 쉰다. 포화면 예전처럼 미루고, 아니면 일을 했을 때만 보통 틱 — 한 건도 못 했으면 까닭을 남긴다
        ctx.log("product_translation.all_ranks_unusable", { recorded, passed: passed.size });
        if (ranks.saturated()) return deferredJob("model_capacity", recorded);
        return recorded ? { done: true } : { done: true, degraded: ranks.degraded() };
      }
      if (attempt.value.kind === "skipped") {
        for (const task of batch) passed.add(productTranslationTaskKey(task));
        continue;
      }
      if (attempt.value.kind === "stopped") return { done: false };
      return { done: true };
    }
    return { done: true };
  } finally {
    clearInterval(ownershipPoll);
  }
}

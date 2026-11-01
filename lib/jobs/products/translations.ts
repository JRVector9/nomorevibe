import { scopedModel } from "@/lib/llm/model-registry";
import { PRODUCT_TRANSLATE_MODEL } from "@/lib/crawl/translate";
import { translateProductFieldsWithModelCapacity } from "@/lib/domain/products/product-translation-model-capacity";
import { checkProductTranslation, packProductTranslationBatch, productTranslationPolicy, productTranslationSourceHash,
  productTranslationTaskKey, translationSourceText } from "@/lib/domain/products/translation-policy";
import { pendingProductTranslations, recordProductTranslations, type ProductTranslationResult } from "@/lib/domain/products/translations";
import { deferredJob, type JobContext, type JobOutcome } from "@/lib/jobs/runner";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerWork } from "@/lib/llm/capacity-deferred";
import { productTranslationClientTimeoutMs } from "@/lib/llm/deadline-ladder";
import { TEXT_ROUTE_BLOCK_DETAIL, textRouteAccess } from "@/lib/llm/serving-contract-store";
import { productTranslationServingProvider } from "@/lib/llm/product-translation-serving-contract";

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
  const model = scopedModel("product-translate", PRODUCT_TRANSLATE_MODEL);
  const blocked = textRouteAccess("product-translate", model, productTranslationServingProvider(model)).block;
  if (blocked) {
    ctx.log("product_translation.deferred", { reason: blocked });
    return { done: true, degraded: { code: blocked, detail: TEXT_ROUTE_BLOCK_DETAIL[blocked] } };
  }
  if (!ctx.lease) throw new Error("Product translation worker requires a job lease");
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
        })), ctx.lease);
        recorded += retired.length;
      }
      for (const task of retired) passed.add(productTranslationTaskKey(task));
      // 긴 설명은 단독, 짧은 것만 묶인다(translation.product.batchChars) — 300초 상한 안에 끝나게.
      const batch = packProductTranslationBatch(tasks.filter((task) => !retired.includes(task)), policy);
      if (!batch.length) continue;
      if (!ctx.hasBudget() || signal.aborted) break;
      // Outermost HTTP deadline (routes.limits.product-translate.timeoutMs, read per tick) fits the job budget; inner M1 bounds still require measurement and enforcement.
      let outcome: Awaited<ReturnType<typeof translateProductFieldsWithModelCapacity>>;
      try {
        outcome = await translateProductFieldsWithModelCapacity(batch, ctx.lease, { timeoutMs: productTranslationClientTimeoutMs(), signal, deadlineAt: ctx.deadlineAt });
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
      if (outcome.kind === "skipped") {
        for (const task of batch) passed.add(productTranslationTaskKey(task));
        continue;
      }
      const response = outcome.result;
      const completedBatch = outcome.batch ?? batch;
      if (ctx.signal?.aborted) return { done: false };
      // Account for calls aborted by the tick budget. The final lease check in
      // recordProductTranslations rolls back writes if ownership was actually lost.
      const entries = completedBatch.map((task, index): { task: typeof task; result: ProductTranslationResult } => {
        if (!response.ok) return { task, result: { ok: false, error: response.error, model: scopedModel("product-translate", PRODUCT_TRANSLATE_MODEL) } };
        const checked = checkProductTranslation(response.outputs[index], task.source, task.locale, task.field);
        return { task, result: checked.ok ? { ok: true, text: checked.text, model: scopedModel("product-translate", PRODUCT_TRANSLATE_MODEL) }
          : { ok: false, error: `rejected:${checked.reason}`, model: scopedModel("product-translate", PRODUCT_TRANSLATE_MODEL) } };
      });
      const stored = await (outcome.expectation ? recordProductTranslations(entries, ctx.lease, outcome.expectation)
        : recordProductTranslations(entries, ctx.lease));
      ctx.log("product_translation.tick", { model: scopedModel("product-translate", PRODUCT_TRANSLATE_MODEL), demanded: completedBatch.length, stored,
        accepted: entries.filter(({ result }) => result.ok).length, gatewayError: response.ok ? null : response.error, passed: passed.size });
      return { done: true };
    }
    return { done: true };
  } finally {
    clearInterval(ownershipPoll);
  }
}

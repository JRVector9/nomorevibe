import { scopedModel } from "@/lib/llm/model-registry";
import { PRODUCT_TRANSLATION_MODEL } from "@/lib/crawl/translate";
import { translateProductFieldsWithModelCapacity } from "@/lib/domain/products/product-translation-model-capacity";
import { checkProductTranslation, packProductTranslationBatch, productTranslationPolicy, productTranslationSourceHash,
  translationSourceText } from "@/lib/domain/products/translation-policy";
import { pendingProductTranslations, recordProductTranslations, type ProductTranslationResult } from "@/lib/domain/products/translations";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { productTranslationClientTimeoutMs } from "@/lib/llm/deadline-ladder";
import { textRouteCallable } from "@/lib/llm/serving-contract-store";

/**
 * One call / at most four demanded fields per text-role tick (budget: productTranslationJobBudgetMs — client timeout + jobMarginMs). No catalog backfill.
 * Source cap and batch packing come from the tick's runtime_settings translation.product (productTranslationPolicy), so an admin save applies on the next tick.
 */
export async function translateDemandedProductFields(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  if (!textRouteCallable("product-translate", scopedModel("product-translate", PRODUCT_TRANSLATION_MODEL))) {
    ctx.log("product_translation.deferred", { reason: "no_key" });
    return { done: true, degraded: { code: "no_key", detail: "이 경로의 직접 연결 계약도 text 워커의 ABCLLM_API_KEY 도 없습니다" } };
  }
  if (!ctx.lease) throw new Error("Product translation worker requires a job lease");
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const ownershipPoll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
  ownershipPoll.unref?.();
  try {
    const policy = productTranslationPolicy();
    const tasks = await pendingProductTranslations(policy.batchMax);
    if (!tasks.length || !ctx.hasBudget() || signal.aborted) return { done: true };
    const retired = tasks.filter((task) => !task.eligible || productTranslationSourceHash(task.source, task.field) !== task.sourceHash
      || translationSourceText(task.source, task.field).length > policy.maxSourceChars);
    if (retired.length) await recordProductTranslations(retired.map((task) => ({ task,
      result: { ok: false, error: translationSourceText(task.source, task.field).length > policy.maxSourceChars ? "source_too_long" : "stale_source", model: "" } as ProductTranslationResult,
    })), ctx.lease);
    // 긴 설명은 단독, 짧은 것만 묶인다(translation.product.batchChars) — 300초 상한 안에 끝나게.
    const batch = packProductTranslationBatch(tasks.filter((task) => !retired.includes(task)), policy);
    if (!batch.length || !ctx.hasBudget() || signal.aborted) return { done: true };
    // Outermost HTTP deadline (routes.limits.product-translate.timeoutMs, read per tick) fits the job budget; inner M1 bounds still require measurement and enforcement.
    const outcome = await translateProductFieldsWithModelCapacity(batch, ctx.lease, { timeoutMs: productTranslationClientTimeoutMs(), signal, deadlineAt: ctx.deadlineAt });
    if (outcome.kind === "skipped") return { done: true };
    const response = outcome.result;
    const completedBatch = outcome.batch ?? batch;
    if (ctx.signal?.aborted) return { done: false };
    // Account for calls aborted by the tick budget. The final lease check in
    // recordProductTranslations rolls back writes if ownership was actually lost.
    const entries = completedBatch.map((task, index): { task: typeof task; result: ProductTranslationResult } => {
      if (!response.ok) return { task, result: { ok: false, error: response.error, model: scopedModel("product-translate", PRODUCT_TRANSLATION_MODEL) } };
      const checked = checkProductTranslation(response.outputs[index], task.source, task.locale, task.field);
      return { task, result: checked.ok ? { ok: true, text: checked.text, model: scopedModel("product-translate", PRODUCT_TRANSLATION_MODEL) }
        : { ok: false, error: `rejected:${checked.reason}`, model: scopedModel("product-translate", PRODUCT_TRANSLATION_MODEL) } };
    });
    const stored = await (outcome.expectation ? recordProductTranslations(entries, ctx.lease, outcome.expectation)
      : recordProductTranslations(entries, ctx.lease));
    ctx.log("product_translation.tick", { model: scopedModel("product-translate", PRODUCT_TRANSLATION_MODEL), demanded: completedBatch.length, stored,
      accepted: entries.filter(({ result }) => result.ok).length, gatewayError: response.ok ? null : response.error });
    return { done: true };
  } finally {
    clearInterval(ownershipPoll);
  }
}

import { scopedModel } from "@/lib/llm/model-registry";
import { PRODUCT_TRANSLATION_MODEL } from "@/lib/crawl/translate";
import { translateProductFieldsWithModelCapacity } from "@/lib/domain/products/product-translation-model-capacity";
import { checkProductTranslation, packProductTranslationBatch, productTranslationSourceHash, translationSourceText,
  PRODUCT_TRANSLATION_MAX_SOURCE_CHARS } from "@/lib/domain/products/translation-policy";
import { pendingProductTranslations, recordProductTranslations, type ProductTranslationResult } from "@/lib/domain/products/translations";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { PRODUCT_TRANSLATION_CLIENT_TIMEOUT_MS } from "@/lib/llm/deadline-ladder";
import { textRouteCallable } from "@/lib/llm/serving-contract-store";

/** One call / at most four demanded fields per text-role tick (PRODUCT_TRANSLATION_JOB_BUDGET_MS). No catalog backfill. */
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
    const tasks = await pendingProductTranslations(4);
    if (!tasks.length || !ctx.hasBudget() || signal.aborted) return { done: true };
    const retired = tasks.filter((task) => !task.eligible || productTranslationSourceHash(task.source, task.field) !== task.sourceHash
      || translationSourceText(task.source, task.field).length > PRODUCT_TRANSLATION_MAX_SOURCE_CHARS);
    if (retired.length) await recordProductTranslations(retired.map((task) => ({ task,
      result: { ok: false, error: translationSourceText(task.source, task.field).length > PRODUCT_TRANSLATION_MAX_SOURCE_CHARS ? "source_too_long" : "stale_source", model: "" } as ProductTranslationResult,
    })), ctx.lease);
    // 긴 설명은 단독, 짧은 것만 묶인다(PRODUCT_TRANSLATION_BATCH_CHARS) — 300초 상한 안에 끝나게.
    const batch = packProductTranslationBatch(tasks.filter((task) => !retired.includes(task)));
    if (!batch.length || !ctx.hasBudget() || signal.aborted) return { done: true };
    // Outermost HTTP deadline fits the job budget (PRODUCT_TRANSLATION_JOB_BUDGET_MS); inner M1 bounds still require measurement and enforcement.
    const outcome = await translateProductFieldsWithModelCapacity(batch, ctx.lease, { timeoutMs: PRODUCT_TRANSLATION_CLIENT_TIMEOUT_MS, signal, deadlineAt: ctx.deadlineAt });
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

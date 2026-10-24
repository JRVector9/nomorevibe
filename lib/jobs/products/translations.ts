import { PRODUCT_TRANSLATION_MODEL } from "@/lib/crawl/translate";
import { translateProductFieldsWithModelCapacity } from "@/lib/domain/products/product-translation-model-capacity";
import { checkProductTranslation, productTranslationSourceHash, translationSourceText } from "@/lib/domain/products/translation-policy";
import { pendingProductTranslations, recordProductTranslations, type ProductTranslationResult } from "@/lib/domain/products/translations";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";

/** One call / at most four demanded fields per 25-second text-role tick. No catalog backfill. */
export async function translateDemandedProductFields(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  if (!process.env.ABCLLM_API_KEY?.trim()) {
    ctx.log("product_translation.deferred", { reason: "no_key" });
    return { done: true, degraded: { code: "no_key", detail: "text 워커에 ABCLLM_API_KEY 가 없습니다" } };
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
      || translationSourceText(task.source, task.field).length > 4_000);
    if (retired.length) await recordProductTranslations(retired.map((task) => ({ task,
      result: { ok: false, error: translationSourceText(task.source, task.field).length > 4_000 ? "source_too_long" : "stale_source", model: "" } as ProductTranslationResult,
    })), ctx.lease);
    const batch = [];
    let chars = 0;
    for (const task of tasks.filter((task) => !retired.includes(task))) {
      const text = translationSourceText(task.source, task.field);
      if (batch.length && chars + text.length > 4_000) break;
      batch.push(task);
      chars += text.length;
    }
    if (!batch.length || !ctx.hasBudget() || signal.aborted) return { done: true };
    const outcome = await translateProductFieldsWithModelCapacity(batch, ctx.lease, { timeoutMs: 20_000, signal });
    if (outcome.kind === "skipped") return { done: true };
    const response = outcome.result;
    if (ctx.signal?.aborted) return { done: false };
    // Account for calls aborted by the tick budget. The final lease check in
    // recordProductTranslations rolls back writes if ownership was actually lost.
    const entries = batch.map((task, index): { task: typeof task; result: ProductTranslationResult } => {
      if (!response.ok) return { task, result: { ok: false, error: response.error, model: PRODUCT_TRANSLATION_MODEL } };
      const checked = checkProductTranslation(response.outputs[index], task.source, task.locale, task.field);
      return { task, result: checked.ok ? { ok: true, text: checked.text, model: PRODUCT_TRANSLATION_MODEL }
        : { ok: false, error: `rejected:${checked.reason}`, model: PRODUCT_TRANSLATION_MODEL } };
    });
    const stored = await (outcome.expectation ? recordProductTranslations(entries, ctx.lease, outcome.expectation)
      : recordProductTranslations(entries, ctx.lease));
    ctx.log("product_translation.tick", { model: PRODUCT_TRANSLATION_MODEL, demanded: batch.length, stored,
      accepted: entries.filter(({ result }) => result.ok).length, gatewayError: response.ok ? null : response.error });
    return { done: true };
  } finally {
    clearInterval(ownershipPoll);
  }
}

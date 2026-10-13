import { TRANSLATE_MODEL, translateProductFields } from "@/lib/crawl/translate";
import { checkProductTranslation, productTranslationSourceHash, translationSourceText } from "@/lib/domain/products/translation-policy";
import { pendingProductTranslations, recordProductTranslations, type ProductTranslationResult } from "@/lib/domain/products/translations";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";

/** One call / at most four demanded fields per 25-second text-role tick. No catalog backfill. */
export async function translateDemandedProductFields(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  if (!process.env.ABCLLM_API_KEY?.trim()) {
    ctx.log("product_translation.deferred", { reason: "no_key" });
    return { done: true };
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
    const response = await translateProductFields(batch.map((task) => ({ name: task.source.name, locale: task.locale,
      field: task.field, text: translationSourceText(task.source, task.field) })), 20_000, fetch, signal);
    if (signal.aborted || !ctx.hasBudget()) return { done: false };
    const entries = batch.map((task, index): { task: typeof task; result: ProductTranslationResult } => {
      if (!response.ok) return { task, result: { ok: false, error: response.error, model: TRANSLATE_MODEL } };
      const checked = checkProductTranslation(response.outputs[index], task.source, task.locale, task.field);
      return { task, result: checked.ok ? { ok: true, text: checked.text, model: TRANSLATE_MODEL }
        : { ok: false, error: `rejected:${checked.reason}`, model: TRANSLATE_MODEL } };
    });
    const stored = await recordProductTranslations(entries, ctx.lease);
    ctx.log("product_translation.tick", { demanded: batch.length, stored,
      accepted: entries.filter(({ result }) => result.ok).length, gatewayError: response.ok ? null : response.error });
    return { done: true };
  } finally {
    clearInterval(ownershipPoll);
  }
}

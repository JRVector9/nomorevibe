import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { readModelCapacityCallerControl } from "@/lib/llm/capacity-repository";
import { parseKoreanTaglines, type KoreanTaglineBatch } from "@/lib/domain/products/korean-tagline";
import { productTaglineKoLegacyWire, type ProductTaglineKoGatewayItem } from "./translate";
import { KOREAN_TRANSLATION_LEGACY_MAX_CHARS, KOREAN_TRANSLATION_MAX_ITEMS,
  KOREAN_TRANSLATION_QWEN_BASE_URL, KOREAN_TRANSLATION_QWEN_MODEL, koreanTranslationQwenEnabled } from "./korean-translation-config";

/** Dedicated translation transport. The review adapter's policy/schema is never applied to translations. */
export async function translateKoreanTaglinesWithQwen(items: readonly ProductTaglineKoGatewayItem[], options: {
  timeoutMs: number; signal?: AbortSignal; request?: typeof fetch;
}): Promise<KoreanTaglineBatch> {
  if (!koreanTranslationQwenEnabled()) return { ok: false, error: "qwen_disabled" };
  if (!items.length || items.length > KOREAN_TRANSLATION_MAX_ITEMS ||
    items.reduce((count, item) => count + item.tagline.length, 0) > KOREAN_TRANSLATION_LEGACY_MAX_CHARS)
    return { ok: false, error: "input_too_large" };
  // This legacy transport cannot borrow the reviewer-only local capacity permit.
  const control = await readModelCapacityCallerControl();
  if (control.mode !== "disabled") throw new ModelCapacityDeferredError(control.mode === "draining" ? "draining" : "provider_contract_unavailable");
  if (options.signal?.aborted) return { ok: false, error: "cancelled" };
  const wire = JSON.parse(productTaglineKoLegacyWire(items, KOREAN_TRANSLATION_QWEN_MODEL));
  delete wire.reasoning_effort;
  wire.chat_template_kwargs = { enable_thinking: false };
  const key = process.env.AUDIT_SECOND_OPINION_API_KEY?.trim();
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    const response = await (options.request ?? fetch)(`${KOREAN_TRANSLATION_QWEN_BASE_URL}/chat/completions`, {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(wire), signal,
    });
    if (!response.ok) return { ok: false, error: response.status === 429 ? "rate_limit" : `http_${response.status}` };
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, error: "invalid_output" };
    const decoder = new TextDecoder(); let bytes = 0, body = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 100_000) { await reader.cancel(); return { ok: false, error: "output_too_large" }; }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } finally { reader.releaseLock(); }
    let data: { model?: unknown; choices?: { finish_reason?: unknown; message?: { content?: unknown } }[] };
    try { data = JSON.parse(body); } catch { return { ok: false, error: "invalid_output" }; }
    if (data.model !== KOREAN_TRANSLATION_QWEN_MODEL) return { ok: false, error: "model_mismatch" };
    const choice = data.choices?.[0];
    if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string") return { ok: false, error: "invalid_output" };
    return parseKoreanTaglines(choice.message.content, items.length);
  } catch {
    return { ok: false, error: options.signal?.aborted ? "cancelled" : deadline.aborted ? "timeout" : "network" };
  }
}

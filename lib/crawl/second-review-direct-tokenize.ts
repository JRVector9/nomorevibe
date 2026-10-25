import { fetch as undiciFetch } from "undici";
import type { Ai2DirectServingContract } from "./second-review-serving-contract";

const MAX_TOKENIZER_RESPONSE_BYTES = 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

type TokenBudgetContract = Pick<Ai2DirectServingContract, "model" | "tokenizerEndpoint" | "totalTokenBound" | "requestTokenBound" | "maxOutputTokens">
  & { tokenizerModel?: string };

/** Tokenize the exact chat messages/template controls against the approved actual engine, including an explicitly mapped raw gateway alias. */
export async function verifyAi2TokenBudget(contract: TokenBudgetContract, wire: string,
  options: { timeoutMs: number; signal?: AbortSignal }): Promise<boolean> {
  const chat: unknown = JSON.parse(wire);
  if (!object(chat) || chat.model !== contract.model || chat.max_tokens !== contract.maxOutputTokens
    || chat.stream !== false || !Array.isArray(chat.messages) || !object(chat.chat_template_kwargs)
    || chat.chat_template_kwargs.enable_thinking !== false) return false;
  const deadline = AbortSignal.timeout(Math.min(options.timeoutMs, 10_000));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  if (signal.aborted) return false;
  try {
    const response = await undiciFetch(contract.tokenizerEndpoint, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ model: contract.tokenizerModel ?? contract.model, messages: chat.messages, add_generation_prompt: true,
        chat_template_kwargs: chat.chat_template_kwargs }),
    });
    if (response.status !== 200) { await response.body?.cancel(); return false; }
    const reader = response.body?.getReader();
    if (!reader) return false;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > MAX_TOKENIZER_RESPONSE_BYTES) { await reader.cancel(); return false; }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!object(result) || !Number.isSafeInteger(result.count) || (result.count as number) < 1
      || result.max_model_len !== contract.totalTokenBound || !Array.isArray(result.tokens)
      || result.tokens.length !== result.count || result.tokens.some(token => !Number.isSafeInteger(token) || token < 0)) return false;
    return (result.count as number) + contract.maxOutputTokens <= contract.requestTokenBound;
  } catch { return false; }
}

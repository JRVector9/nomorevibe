import { fetch as undiciFetch } from "undici";
import type { Ai2DirectServingContract } from "./second-review-serving-contract";

const MAX_TOKENIZER_RESPONSE_BYTES = 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

type TokenBudgetContract = Pick<Ai2DirectServingContract, "model" | "tokenizerEndpoint" | "totalTokenBound" | "requestTokenBound" | "maxOutputTokens">
  & { tokenizerModel?: string };

export type TokenBudgetCheck = { kind: "within_budget" } | { kind: "too_large" } | { kind: "cancelled" }
  | { kind: "unavailable"; reason: "request_mismatch" | "contract_mismatch" | "network" | "timeout" | "http_error"
    | "invalid_response" | "response_too_large" };
const unavailable = (reason: Extract<TokenBudgetCheck, { kind: "unavailable" }>["reason"]): TokenBudgetCheck => ({ kind: "unavailable", reason });
const interrupted = (signal: AbortSignal, deadline?: AbortSignal): TokenBudgetCheck =>
  deadline?.aborted || signal.reason instanceof Error && signal.reason.name === "TimeoutError"
    ? unavailable("timeout") : { kind: "cancelled" };

/** Only a complete, matching tokenizer response can prove overflow. Unavailable evidence never becomes a product failure. */
export async function checkAi2TokenBudget(contract: TokenBudgetContract, wire: string,
  options: { timeoutMs: number; signal?: AbortSignal }): Promise<TokenBudgetCheck> {
  if (options.signal?.aborted) return interrupted(options.signal);
  if (![contract.totalTokenBound, contract.requestTokenBound, contract.maxOutputTokens, options.timeoutMs]
    .every(value => Number.isSafeInteger(value) && value > 0)
    || contract.totalTokenBound < contract.requestTokenBound || contract.maxOutputTokens > contract.requestTokenBound)
    return unavailable("contract_mismatch");
  let chat: unknown;
  try { chat = JSON.parse(wire); } catch { return unavailable("request_mismatch"); }
  if (!object(chat) || chat.model !== contract.model || chat.max_tokens !== contract.maxOutputTokens
    || chat.stream !== false || !Array.isArray(chat.messages) || !object(chat.chat_template_kwargs)
    || chat.chat_template_kwargs.enable_thinking !== false) return unavailable("request_mismatch");
  const deadline = AbortSignal.timeout(Math.min(options.timeoutMs, 10_000));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  if (signal.aborted) return interrupted(signal, deadline);
  try {
    const response = await undiciFetch(contract.tokenizerEndpoint, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ model: contract.tokenizerModel ?? contract.model, messages: chat.messages, add_generation_prompt: true,
        chat_template_kwargs: chat.chat_template_kwargs }),
    });
    if (response.status !== 200) { await response.body?.cancel().catch(() => {}); return unavailable("http_error"); }
    const reader = response.body?.getReader();
    if (!reader) return unavailable("invalid_response");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > MAX_TOKENIZER_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); return unavailable("response_too_large"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    let result: unknown;
    try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return unavailable("invalid_response"); }
    if (!object(result) || !Number.isSafeInteger(result.count) || (result.count as number) < 1
      || !Array.isArray(result.tokens) || result.tokens.length !== result.count
      || result.tokens.some(token => !Number.isSafeInteger(token) || token < 0)) return unavailable("invalid_response");
    if (result.max_model_len !== contract.totalTokenBound) return unavailable("contract_mismatch");
    if (signal.aborted) return interrupted(signal, deadline);
    return { kind: (result.count as number) <= contract.requestTokenBound - contract.maxOutputTokens ? "within_budget" : "too_large" };
  } catch { return signal.aborted ? interrupted(signal, deadline) : unavailable("network"); }
}

/** Compatibility helper: unknown/cancelled evidence remains false; callers needing the cause use the typed check above. */
export async function verifyAi2TokenBudget(contract: TokenBudgetContract, wire: string,
  options: { timeoutMs: number; signal?: AbortSignal }): Promise<boolean> {
  return (await checkAi2TokenBudget(contract, wire, options)).kind === "within_budget";
}

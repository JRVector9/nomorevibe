import { createHash } from "node:crypto";
import { consumeLocalModelDispatch } from "./capacity-repository";
import { gatewayFetch } from "./gateway-local-end-fetch";
import { localModelContractHash, localModelServingContractSchema, type LocalModelServingContract } from "./local-model-serving-contract";
import { localModelTerminalEvidenceSchema, type LocalModelDispatch, type LocalModelTerminalEvidence } from "./local-model-capacity-contract";

export type LocalModelTerminal = Readonly<{ kind: "local_model_terminal" }>;
const terminals = new WeakMap<LocalModelTerminal, LocalModelTerminalEvidence>();
const MAX_RESPONSE_BYTES = 128 * 1024;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** 순수 해석 결과는 종료 권한이 아니다. 원래 adapter가 실제 HTTP 응답을 끝까지 받은 뒤에만 증인을 만든다. */
export function localModelResponseFacts(body: string, contract: Pick<LocalModelServingContract, "responseModel" | "totalTokenBound">):
  Pick<LocalModelTerminalEvidence, "finishReason" | "actualUsage" | "provenance"> | null {
  let data: unknown;
  try { data = JSON.parse(body); } catch { return null; }
  if (!object(data) || data.model !== contract.responseModel || !Array.isArray(data.choices) || data.choices.length !== 1) return null;
  const choice = data.choices[0];
  if (!object(choice) || !["stop", "length", "tool_calls", "function_call", "content_filter"].includes(String(choice.finish_reason))) return null;
  let actualUsage: LocalModelTerminalEvidence["actualUsage"] = null;
  if (object(data.usage)) {
    const { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens } = data.usage;
    const safe = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (safe(inputTokens) && safe(outputTokens) && safe(totalTokens)
      && Number.isSafeInteger(inputTokens + outputTokens) && inputTokens + outputTokens === totalTokens) {
      if (totalTokens > contract.totalTokenBound) return null;
      actualUsage = { inputTokens, outputTokens, totalTokens };
    }
  }
  return { finishReason: choice.finish_reason as LocalModelTerminalEvidence["finishReason"], actualUsage,
    provenance: actualUsage ? "upstream_reported" : "unknown" };
}

/** 원래 불투명 증인만 조회한다. JSON 복사나 모양이 같은 객체는 권한을 얻지 않는다. */
export function readLocalModelTerminal(value: unknown): LocalModelTerminalEvidence | null {
  return value && typeof value === "object" ? terminals.get(value as LocalModelTerminal) ?? null : null;
}

export async function requestReservedLocalModel(value: LocalModelDispatch, contractValue: LocalModelServingContract,
  url: string, init: RequestInit, request?: typeof fetch): Promise<{ response: Response; terminal: LocalModelTerminal | null }> {
  const contract = localModelServingContractSchema.parse(contractValue);
  const dispatch = consumeLocalModelDispatch(value);
  if (!dispatch) throw new Error("invalid_local_model_dispatch_capability");
  if (url !== contract.endpoint || init.method !== "POST" || typeof init.body !== "string"
    || digest(init.body) !== dispatch.binding.wireHash || localModelContractHash(contract) !== dispatch.binding.servingContractHash
    || dispatch.binding.model !== contract.model || dispatch.binding.backendId !== contract.backendId
    || dispatch.binding.physicalGroup !== contract.physicalGroup || dispatch.binding.deploymentRevision !== contract.deploymentRevision)
    throw new Error("local_model_transport_contract_mismatch");
  if (init.signal?.aborted) throw new DOMException("local_model_cancelled", "AbortError");
  const response = request ? await request(url, { ...init, redirect: "error" }) : await gatewayFetch(dispatch.requestId, url,
    { method: "POST", headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body, signal: init.signal, redirect: "error" });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (!reader) return { response: new Response(null, { status: response.status, headers: Object.fromEntries(response.headers.entries()) }), terminal: null };
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("local_model_response_too_large"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks);
  const headers = new Headers(Object.fromEntries(response.headers.entries()));
  headers.delete("content-encoding"); headers.delete("content-length");
  const copied = new Response(body, { status: response.status, statusText: response.statusText, headers });
  const facts = response.ok ? localModelResponseFacts(body.toString("utf8"), contract) : null;
  if (!facts) return { response: copied, terminal: null };
  const terminal: LocalModelTerminal = Object.freeze({ kind: "local_model_terminal" });
  terminals.set(terminal, freeze(localModelTerminalEvidenceSchema.parse({ kind: "local_model_terminal", version: 1,
    dispatch, responseHash: digest(body), ...facts })));
  return { response: copied, terminal };
}

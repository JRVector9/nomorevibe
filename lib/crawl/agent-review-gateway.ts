import { createHash } from "node:crypto";
import { fetch as nativeFetch } from "undici";
import { ai1ModelDispatchSchema, ai1GatewayTerminalEvidenceSchema,
  ai2ModelDispatchSchema, ai2GatewayTerminalEvidenceSchema,
  type Ai2ModelDispatch, type Ai2GatewayTerminalEvidence,
  type Ai1ModelDispatch, type Ai1GatewayTerminalEvidence } from "@/lib/llm/capacity";
import { ai1GatewayServingContractHash, ai1GatewayServingContractSchema, resolveAi1GatewayServingContract,
  type Ai1GatewayServingContract } from "./agent-review-serving-contract";
import { ai2GatewayServingContractHash, ai2GatewayServingContractSchema, resolveAi2GatewayServingContract,
  type Ai2GatewayServingContract } from "./second-review-serving-contract";
import { MAX_REVIEW_INPUT_BYTES, validateReviewOutcome, type ReviewInput } from "./agent-review-contract";
import { assertLiveReviewAdapterAllowed } from "./review-fixture-transport";
import { REVIEW_SYSTEM_PROMPT, type AgentReviewResult, type ReviewFailure, type ReviewUsage } from "./agent-review";

/**
 * 사내 게이트웨이(abcllm)로 보는 심사.
 *
 * CLI 제공자와 같은 입력·같은 정책 글(REVIEW_SYSTEM_PROMPT)·같은 검증(validateReviewOutcome)을 쓴다.
 * 다른 것은 부르는 방법뿐이라, 어느 쪽으로 봐도 같은 질문에 답한 기록이 된다.
 *
 * 제한 시간 60초: 답이 길어지면(464~646 토큰) 붐빌 때 45초를 넘긴다. 틱 예산이 110초라
 * t=48초까지 새 호출을 시작할 수 있어 자리는 있다.
 *
 * 게이트웨이는 스트리밍이 기본이라 stream:false 를 꼭 보낸다. 모델 목록이 예고 없이 바뀌므로
 * (2026-09-12 실측: gemma4-26b 가 사라졌다 돌아왔고 그 사이 gpt-oss 가 502) 없는 모델은
 * model_unavailable 로 남겨 운영 화면에 드러낸다 — 조용히 넘기면 심사가 통째로 멈춘 줄 모른다.
 */
export const REVIEW_GATEWAY_TIMEOUT_MS = 60_000;
/**
 * 받을 답의 상한.
 *
 * 판단 한 건은 70~82 토큰이지만(2026-09-12 실측) 가끔 길게 쓰는 모델이 있다. 400 으로 조였더니
 * gemma4-26b 가 20분에 5건 잘렸고, 잘린 답은 판단으로 받지 않으므로 그대로 실패가 된다.
 * 넉넉히 둔다 — 길이로 조이는 것은 붐비는 서버에 도움이 되지 않았다(같은 요청이 4.7초에서
 * 29초까지 흔들렸고 상한과는 무관했다).
 */
const MAX_OUTPUT_TOKENS = 3_000;
const BASE_URL = process.env.ABCLLM_BASE_URL?.trim() || "https://abcllm-api.brut.bot";
const MAX_BODY_BYTES = 128 * 1024;

/**
 * 받을 모양. CLI 쪽(OUTPUT_SCHEMA)과 달리 confidence·evidenceIds 까지 요구한다 —
 * 2차 합의는 확신이 있어야 셈이 되고, 평가(2026-09-12, 130건)를 이 스키마로 돌렸다.
 */
const GATEWAY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "reason", "evidenceIds", "confidence"],
  properties: {
    decision: { type: "string", enum: ["approve", "reject", "needs_review"] },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
    evidenceIds: { type: "array", maxItems: 40, items: { type: "string", minLength: 1, maxLength: 100 } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

/** 게이트웨이 모델 이름은 "[MLX] gpt-oss-120b" 처럼 공백·대괄호가 들어간다 */
export function gatewayModel(value: string): string | null {
  const model = value.trim();
  return model && model.length <= 160 && !/[\p{Cc}\n\r]/u.test(model) ? model : null;
}

/** 심사에 쓸 수 없는 모델 — 임베딩·음성·비전 전용 */
const NON_CHAT_MODEL = /(bge|embed|whisper|-vl-|vl-\d|rerank)/i;

/**
 * 게이트웨이에 지금 올라와 있는 대화 모델. 목록은 예고 없이 바뀐다 — 관리자가 2차 표를 고를 때 그때그때 읽는다.
 * 키가 없거나 닿지 않으면 null.
 */
export async function listGatewayModels(options: { timeoutMs?: number; request?: typeof fetch } = {}): Promise<string[] | null> {
  assertLiveReviewAdapterAllowed();
  const key = process.env.ABCLLM_API_KEY?.trim();
  if (!key) return null;
  try {
    const response = await (options.request ?? fetch)(`${BASE_URL}/v1/models`, {
      headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(options.timeoutMs ?? 5_000), cache: "no-store",
    });
    if (!response.ok) return null;
    const body = await response.json() as { data?: { id?: unknown }[] };
    return (body.data ?? []).flatMap((item) => typeof item.id === "string" && gatewayModel(item.id) && !NON_CHAT_MODEL.test(item.id) ? [item.id] : []);
  } catch {
    return null;
  }
}

function httpFailure(status: number): ReviewFailure {
  if (status === 404) return "model_unavailable";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  return "gateway_error";
}

/**
 * <think>…</think> 를 걷어내고 첫 JSON 덩이만 — 추론을 끄라고 해도 남기는 모델이 있다.
 *
 * 닫히지 않은 <think> 는 통째로 버린다. 답이 잘려 생각이 끝나지 않았을 때 그 안의 초안 JSON 을
 * 판단으로 읽으면, 모델이 아직 고민 중이던 결론이 표가 된다.
 */
export function parseGatewayContent(content: string): unknown {
  const closed = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const unclosed = closed.indexOf("<think>");
  const body = (unclosed >= 0 ? closed.slice(0, unclosed) : closed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function usageFrom(value: Record<string, unknown>): ReviewUsage {
  const usage = value.usage && typeof value.usage === "object" ? value.usage as Record<string, unknown> : {};
  const tokens = (count: unknown) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  return { inputTokens: tokens(usage.prompt_tokens), outputTokens: tokens(usage.completion_tokens) };
}

function gatewayWire(model: string, serialized: string): string {
  // 꺾쇠를 막아 두어야 증거 안의 글이 구분자를 끝내지 못한다 — CLI 쪽과 같은 처리다
  const prompt = `<untrusted_evidence_json>\n${serialized.replace(/</g, "\\u003c").replace(/>/g, "\\u003e")}\n</untrusted_evidence_json>`;

  return JSON.stringify({
    // The gateway's default Gemma adapter summarizes and clips evidence/policy.
    // Review decisions must use the exact snapshot whose hash we record.
    context_strategy: "raw",
    model, stream: false, temperature: 0, max_tokens: MAX_OUTPUT_TOKENS, reasoning_effort: "low",
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: "json_schema", json_schema: { name: "review", schema: GATEWAY_SCHEMA } },
    messages: [
      { role: "system", content: `${REVIEW_SYSTEM_PROMPT}\nReturn one JSON object with decision, reason, evidenceIds, confidence.` },
      { role: "user", content: prompt },
    ],
  });
}

export async function reviewWithGateway(input: ReviewInput, options: {
  model: string; timeoutMs?: number; request?: typeof fetch; signal?: AbortSignal;
}): Promise<AgentReviewResult> {
  assertLiveReviewAdapterAllowed();
  const key = process.env.ABCLLM_API_KEY?.trim();
  const model = gatewayModel(options.model);
  if (!key || !model) return { ok: false, error: "not_configured" };
  const serialized = JSON.stringify(input.snapshot);
  if (Buffer.byteLength(serialized, "utf8") > MAX_REVIEW_INPUT_BYTES) return { ok: false, error: "input_too_large" };

  const deadline = AbortSignal.timeout(Math.max(1, options.timeoutMs ?? REVIEW_GATEWAY_TIMEOUT_MS));
  const timeout = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const failure = (error: unknown): ReviewFailure => {
    const name = error instanceof Error ? error.name : "";
    if (deadline.aborted) return "timeout";
    return name === "TimeoutError" ? "timeout" : name === "AbortError" ? "cancelled" : "gateway_error";
  };
  let response: Response;
  try {
    response = await (options.request ?? fetch)(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: gatewayWire(model, serialized),
      // 바깥 신호가 와도 제한 시간은 살아 있어야 한다 — 둘 중 먼저 오는 것으로 끊는다
      signal: timeout,
    });
  } catch (error) {
    return { ok: false, error: failure(error) };
  }
  if (!response.ok) return { ok: false, error: httpFailure(response.status) };

  let body: string;
  try {
    body = await response.text();
  } catch (error) { return { ok: false, error: failure(error) }; }
  return gatewayResult(input, body);
}

function gatewayResult(input: ReviewInput, body: string): AgentReviewResult {
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return { ok: false, error: "output_too_large" };
  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_envelope");
    envelope = parsed as Record<string, unknown>;
  } catch { return { ok: false, error: "invalid_output", detail: "invalid_envelope" }; }
  const usage = usageFrom(envelope);
  const choices = Array.isArray(envelope.choices) ? envelope.choices : [];
  const choice = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : null;
  // 길이에 걸려 잘린 답은 판단이 아니다 — 초안이 표가 되지 않게 여기서 끊는다
  if (choice?.finish_reason === "length") return { ok: false, error: "output_too_large", usage };
  const message = choice ? choice.message : null;
  const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : null;
  if (typeof content !== "string") return { ok: false, error: "invalid_output", detail: "missing_content", usage };
  const value = parseGatewayContent(content);
  if (!value) return { ok: false, error: "invalid_output", detail: "invalid_json", usage };
  try {
    return { ok: true, outcome: validateReviewOutcome(input, value), usage };
  } catch (error) {
    // Only fixed diagnostic codes leave this boundary, never model/source text.
    const code = error instanceof Error ? error.message : "";
    const detail = ["review_unknown_evidence", "review_missing_evidence", "review_evidence_policy_failed"].includes(code)
      ? code : "schema_validation";
    return { ok: false, error: "invalid_output", detail, usage };
  }
}
export type PreparedAi1GatewayCall = Readonly<{ kind: "prepared"; wireHash: string; servingContractHash: string;
  totalTokenBound: number; model: string; inputHash: string }>;
export type Ai1GatewayTerminal = Readonly<{ kind: "ai1_gateway_terminal" }>;
type Prepared = { wire: string; inputIdentity: string; contract: Ai1GatewayServingContract; timeoutMs: number; used: boolean };
const preparedCalls = new WeakMap<PreparedAi1GatewayCall, Prepared>();
const terminals = new WeakMap<Ai1GatewayTerminal, Ai1GatewayTerminalEvidence>();
const dispatchedRequests = new Set<string>();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** No caller descriptor or injected request can enable a serving deployment. */
export function prepareAi1GatewayCall(input: ReviewInput, options: { model: string; timeoutMs?: number }):
  PreparedAi1GatewayCall | { kind: "unsupported"; reason: "provider_contract_unavailable" } {
  assertLiveReviewAdapterAllowed();
  const snapshot = structuredClone(input), model = gatewayModel(options.model), timeoutMs = options.timeoutMs ?? REVIEW_GATEWAY_TIMEOUT_MS;
  const unsupported = { kind: "unsupported", reason: "provider_contract_unavailable" } as const;
  if (!model || !process.env.ABCLLM_API_KEY?.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return unsupported;
  const resolved = resolveAi1GatewayServingContract(model);
  if (!resolved) return unsupported;
  const contract = ai1GatewayServingContractSchema.parse(structuredClone(resolved));
  const serialized = JSON.stringify(snapshot.snapshot);
  if (contract.model !== model || Buffer.byteLength(serialized, "utf8") > MAX_REVIEW_INPUT_BYTES) return unsupported;
  const wire = gatewayWire(model, serialized);
  const call = Object.freeze({ kind: "prepared" as const, wireHash: sha(wire),
    servingContractHash: ai1GatewayServingContractHash(contract), totalTokenBound: contract.totalTokenBound,
    model, inputHash: snapshot.inputHash });
  preparedCalls.set(call, { wire, inputIdentity: sha(JSON.stringify(snapshot)), contract: freeze(contract), timeoutMs, used: false });
  return call;
}

/** Only the original native capability has evidence; JSON, copies and legacy results do not. */
export function readAi1GatewayTerminal(value: unknown): Ai1GatewayTerminalEvidence | null {
  return value && typeof value === "object" ? terminals.get(value as Ai1GatewayTerminal) ?? null : null;
}

function nativeTerminal(body: string, contract: Pick<Ai1GatewayServingContract, "responseModel" | "totalTokenBound">):
  Pick<Ai1GatewayTerminalEvidence, "finishReason" | "actualUsage" | "provenance"> | null {
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!object(parsed) || Object.hasOwn(parsed, "error") || parsed.object !== "chat.completion"
    || typeof parsed.id !== "string" || !parsed.id || !Number.isSafeInteger(parsed.created) || (parsed.created as number) < 0
    || parsed.model !== contract.responseModel || !Array.isArray(parsed.choices) || parsed.choices.length !== 1) return null;
  const choice = parsed.choices[0];
  if (!object(choice) || choice.index !== 0 || !object(choice.message) || choice.message.role !== "assistant"
    || (typeof choice.message.content !== "string" && choice.message.content !== null)) return null;
  const finishReason = choice.finish_reason;
  if (finishReason !== "stop" && finishReason !== "length" && finishReason !== "tool_calls"
    && finishReason !== "function_call" && finishReason !== "content_filter") return null;
  let actualUsage: Ai1GatewayTerminalEvidence["actualUsage"] = null;
  if (parsed.usage_provenance === "upstream_reported" && object(parsed.usage)) {
    const { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens } = parsed.usage;
    const safe = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (safe(inputTokens) && safe(outputTokens) && safe(totalTokens)
      && Number.isSafeInteger(inputTokens + outputTokens) && inputTokens + outputTokens === totalTokens) {
      // A valid upstream counter beyond C contradicts the serving contract, rather than proving a cheap completion.
      if (totalTokens > contract.totalTokenBound) return null;
      actualUsage = { inputTokens, outputTokens, totalTokens };
    }
  }
  return { finishReason, actualUsage, provenance: actualUsage ? "upstream_reported" : "unknown" };
}

export async function reviewWithReservedAi1Gateway(input: ReviewInput, dispatch: Ai1ModelDispatch,
  call: PreparedAi1GatewayCall, options: { signal?: AbortSignal; timeoutMs?: number } = {}):
  Promise<{ result: AgentReviewResult; terminal: Ai1GatewayTerminal | null }> {
  assertLiveReviewAdapterAllowed();
  // Capture all caller-owned values before the first await. Schema brands alone are not DB authority.
  const state = preparedCalls.get(call), snapshot = structuredClone(input);
  const checked = ai1ModelDispatchSchema.safeParse(structuredClone(dispatch));
  const timeoutMs = options.timeoutMs ?? state?.timeoutMs ?? REVIEW_GATEWAY_TIMEOUT_MS, signal = options.signal;
  if (!state || state.used || !checked.success || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("ai1_gateway_call_mismatch");
  const owned = checked.data, binding = owned.binding;
  if (sha(JSON.stringify(snapshot)) !== state.inputIdentity || binding.inputHash !== call.inputHash
    || binding.sourceRevisionHash !== snapshot.sourceRevisionHash || binding.reviewPolicyHash !== snapshot.policyHash
    || binding.promptVersion !== snapshot.snapshot.policy.promptVersion || binding.rulesVersion !== snapshot.snapshot.policy.rulesVersion
    || binding.model !== call.model || binding.wireHash !== call.wireHash || binding.servingContractHash !== call.servingContractHash
    || binding.totalTokenBound !== call.totalTokenBound || binding.provider !== state.contract.provider
    || binding.routeId !== state.contract.routeId || dispatchedRequests.has(owned.requestId)) throw new Error("ai1_gateway_call_mismatch");
  state.used = true;
  dispatchedRequests.add(owned.requestId);
  const key = process.env.ABCLLM_API_KEY?.trim();
  if (!key) return { result: { ok: false, error: "not_configured" }, terminal: null };
  const deadline = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const failure = (error: unknown): ReviewFailure => {
    const name = error instanceof Error ? error.name : "";
    if (deadline.aborted) return "timeout";
    return name === "TimeoutError" ? "timeout" : name === "AbortError" ? "cancelled" : "gateway_error";
  };
  let body: string;
  try {
    const response = await nativeFetch(state.contract.endpoint, { method: "POST", redirect: "manual",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: state.wire, signal: combined });
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch { /* A nonterminal response never releases its charge. */ }
      return { result: { ok: false, error: httpFailure(response.status) }, terminal: null };
    }
    body = await response.text();
  } catch (error) { return { result: { ok: false, error: failure(error) }, terminal: null }; }
  // This deployment contract requires raw gateway finish+DONE validation before its JSON response.
  // A generic HTTP200/EOF or a legacy callback is not that authority.
  const completed = nativeTerminal(body, state.contract);
  if (!completed) return { result: { ok: false, error: "invalid_output", detail: "invalid_native_terminal" }, terminal: null };
  const terminal: Ai1GatewayTerminal = Object.freeze({ kind: "ai1_gateway_terminal" });
  const evidence = ai1GatewayTerminalEvidenceSchema.parse({ version: 1, kind: "ai1_gateway_terminal",
    dispatch: owned, responseHash: sha(body), ...completed });
  terminals.set(terminal, freeze(evidence));
  return { result: gatewayResult(snapshot, body), terminal };
}


export type PreparedAi2GatewayCall = Readonly<{ kind: "prepared"; wireHash: string; servingContractHash: string;
  totalTokenBound: number; model: string; inputHash: string }>;
export type Ai2GatewayTerminal = Readonly<{ kind: "ai2_gateway_terminal" }>;
type PreparedAi2 = { wire: string; inputIdentity: string; contract: Ai2GatewayServingContract; timeoutMs: number; used: boolean };
const preparedAi2Calls = new WeakMap<PreparedAi2GatewayCall, PreparedAi2>();
const ai2Terminals = new WeakMap<Ai2GatewayTerminal, Ai2GatewayTerminalEvidence>();
const dispatchedAi2Requests = new Set<string>();

/** No caller descriptor or callback can approve an AI2 serving deployment. */
export function prepareAi2GatewayCall(input: ReviewInput, options: { model: string; timeoutMs?: number }):
  PreparedAi2GatewayCall | { kind: "unsupported"; reason: "provider_contract_unavailable" } {
  assertLiveReviewAdapterAllowed();
  const snapshot = structuredClone(input), model = gatewayModel(options.model), timeoutMs = options.timeoutMs ?? REVIEW_GATEWAY_TIMEOUT_MS;
  const unsupported = { kind: "unsupported", reason: "provider_contract_unavailable" } as const;
  if (!model || !process.env.ABCLLM_API_KEY?.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return unsupported;
  const resolved = resolveAi2GatewayServingContract(model);
  if (!resolved) return unsupported;
  const contract = ai2GatewayServingContractSchema.parse(structuredClone(resolved));
  const serialized = JSON.stringify(snapshot.snapshot);
  if (contract.model !== model || Buffer.byteLength(serialized, "utf8") > MAX_REVIEW_INPUT_BYTES) return unsupported;
  const wire = gatewayWire(model, serialized);
  const call = Object.freeze({ kind: "prepared" as const, wireHash: sha(wire),
    servingContractHash: ai2GatewayServingContractHash(contract), totalTokenBound: contract.totalTokenBound,
    model, inputHash: snapshot.inputHash });
  preparedAi2Calls.set(call, { wire, inputIdentity: sha(JSON.stringify(snapshot)), contract: freeze(contract), timeoutMs, used: false });
  return call;
}

/** Only the original native AI2 capability has historical evidence. */
export function readAi2GatewayTerminal(value: unknown): Ai2GatewayTerminalEvidence | null {
  return value && typeof value === "object" ? ai2Terminals.get(value as Ai2GatewayTerminal) ?? null : null;
}

export async function reviewWithReservedAi2Gateway(input: ReviewInput, dispatch: Ai2ModelDispatch,
  call: PreparedAi2GatewayCall, options: { signal?: AbortSignal; timeoutMs?: number } = {}):
  Promise<{ result: AgentReviewResult; terminal: Ai2GatewayTerminal | null }> {
  assertLiveReviewAdapterAllowed();
  const state = preparedAi2Calls.get(call), snapshot = structuredClone(input);
  const checked = ai2ModelDispatchSchema.safeParse(structuredClone(dispatch));
  const timeoutMs = options.timeoutMs ?? state?.timeoutMs ?? REVIEW_GATEWAY_TIMEOUT_MS, signal = options.signal;
  if (!state || state.used || !checked.success || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("ai2_gateway_call_mismatch");
  const owned = checked.data, binding = owned.binding, review = binding.review;
  if (sha(JSON.stringify(snapshot)) !== state.inputIdentity || review.inputHash !== call.inputHash
    || review.sourceRevisionHash !== snapshot.sourceRevisionHash || binding.inputPolicyHash !== snapshot.policyHash
    || review.promptVersion !== snapshot.snapshot.policy.promptVersion || review.rulesVersion !== snapshot.snapshot.policy.rulesVersion
    || review.reviewer.model !== call.model || review.reviewer.provider !== state.contract.provider
    || binding.model !== call.model || binding.wireHash !== call.wireHash || binding.servingContractHash !== call.servingContractHash
    || binding.totalTokenBound !== call.totalTokenBound || binding.provider !== state.contract.provider
    || binding.routeId !== state.contract.routeId || dispatchedAi2Requests.has(owned.requestId)) throw new Error("ai2_gateway_call_mismatch");
  state.used = true;
  dispatchedAi2Requests.add(owned.requestId);
  const key = process.env.ABCLLM_API_KEY?.trim();
  if (!key) return { result: { ok: false, error: "not_configured" }, terminal: null };
  const deadline = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const failure = (error: unknown): ReviewFailure => {
    const name = error instanceof Error ? error.name : "";
    if (deadline.aborted) return "timeout";
    return name === "TimeoutError" ? "timeout" : name === "AbortError" ? "cancelled" : "gateway_error";
  };
  let body: string;
  try {
    const response = await nativeFetch(state.contract.endpoint, { method: "POST", redirect: "manual",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: state.wire, signal: combined });
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch { /* Unknown native completion keeps its original charge. */ }
      return { result: { ok: false, error: httpFailure(response.status) }, terminal: null };
    }
    body = await response.text();
  } catch (error) { return { result: { ok: false, error: failure(error) }, terminal: null }; }
  const completed = nativeTerminal(body, state.contract);
  if (!completed) return { result: { ok: false, error: "invalid_output", detail: "invalid_native_terminal" }, terminal: null };
  const terminal: Ai2GatewayTerminal = Object.freeze({ kind: "ai2_gateway_terminal" });
  const evidence = ai2GatewayTerminalEvidenceSchema.parse({ version: 1, kind: "ai2_gateway_terminal",
    dispatch: owned, responseHash: sha(body), ...completed });
  ai2Terminals.set(terminal, freeze(evidence));
  return { result: gatewayResult(snapshot, body), terminal };
}


import { ai1ItemModelDispatchSchema, ai1ItemGatewayTerminalEvidenceSchema,
  type Ai1ItemModelDispatch, type Ai1ItemGatewayTerminalEvidence } from "@/lib/llm/capacity";
export type Ai1ItemGatewayTerminal = Readonly<{ kind: "ai1_item_gateway_terminal" }>;
const ai1ItemTerminals = new WeakMap<Ai1ItemGatewayTerminal, Ai1ItemGatewayTerminalEvidence>();

/** Only this original native item terminal proves its historical dispatch. */
export function readAi1ItemGatewayTerminal(value: unknown): Ai1ItemGatewayTerminalEvidence | null {
  return value && typeof value === "object" ? ai1ItemTerminals.get(value as Ai1ItemGatewayTerminal) ?? null : null;
}

/** AI1 legacy and item entries consume the same private preparation exactly once. */
export async function reviewWithReservedAi1ItemGateway(input: ReviewInput, dispatch: Ai1ItemModelDispatch,
  call: PreparedAi1GatewayCall, options: { signal?: AbortSignal; timeoutMs?: number } = {}):
  Promise<{ result: AgentReviewResult; terminal: Ai1ItemGatewayTerminal | null }> {
  assertLiveReviewAdapterAllowed();
  const state = preparedCalls.get(call), snapshot = structuredClone(input);
  const checked = ai1ItemModelDispatchSchema.safeParse(structuredClone(dispatch));
  const timeoutMs = options.timeoutMs ?? state?.timeoutMs ?? REVIEW_GATEWAY_TIMEOUT_MS, signal = options.signal;
  if (!state || state.used || !checked.success || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("ai1_item_gateway_call_mismatch");
  const owned = checked.data, binding = owned.binding, review = binding.review;
  if (sha(JSON.stringify(snapshot)) !== state.inputIdentity || review.inputHash !== call.inputHash
    || review.sourceRevisionHash !== snapshot.sourceRevisionHash || review.policyHash !== snapshot.policyHash
    || review.promptVersion !== snapshot.snapshot.policy.promptVersion || review.rulesVersion !== snapshot.snapshot.policy.rulesVersion
    || review.reviewer.model !== call.model || review.reviewer.provider !== state.contract.provider
    || binding.model !== call.model || binding.wireHash !== call.wireHash || binding.servingContractHash !== call.servingContractHash
    || binding.totalTokenBound !== call.totalTokenBound || binding.provider !== state.contract.provider
    || binding.routeId !== state.contract.routeId || dispatchedRequests.has(owned.requestId)) throw new Error("ai1_item_gateway_call_mismatch");
  state.used = true;
  dispatchedRequests.add(owned.requestId);
  const key = process.env.ABCLLM_API_KEY?.trim();
  if (!key) return { result: { ok: false, error: "not_configured" }, terminal: null };
  const deadline = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const failure = (error: unknown): ReviewFailure => {
    const name = error instanceof Error ? error.name : "";
    if (deadline.aborted) return "timeout";
    return name === "TimeoutError" ? "timeout" : name === "AbortError" ? "cancelled" : "gateway_error";
  };
  let body: string;
  try {
    const response = await nativeFetch(state.contract.endpoint, { method: "POST", redirect: "manual",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: state.wire, signal: combined });
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch { /* Unknown physical completion retains the original full charge. */ }
      return { result: { ok: false, error: httpFailure(response.status) }, terminal: null };
    }
    body = await response.text();
  } catch (error) { return { result: { ok: false, error: failure(error) }, terminal: null }; }
  const completed = nativeTerminal(body, state.contract);
  if (!completed) return { result: { ok: false, error: "invalid_output", detail: "invalid_native_terminal" }, terminal: null };
  const terminal: Ai1ItemGatewayTerminal = Object.freeze({ kind: "ai1_item_gateway_terminal" });
  const evidence = ai1ItemGatewayTerminalEvidenceSchema.parse({ version: 1, kind: "ai1_item_gateway_terminal",
    dispatch: owned, responseHash: sha(body), ...completed });
  ai1ItemTerminals.set(terminal, freeze(evidence));
  return { result: gatewayResult(snapshot, body), terminal };
}


import { textProfileModelDispatchSchema, textProfileGatewayTerminalEvidenceSchema,
  type TextProfileModelDispatch, type TextProfileGatewayTerminalEvidence } from "@/lib/llm/capacity";
import { textProfileServingContractHash, textProfileServingContractSchema, resolveTextProfileServingContract,
  type TextProfileServingContract } from "@/lib/llm/text-profile-serving-contract";
import { profileGatewayWire, parseProfileGatewayBody, profileHash,
  type ProfileEvidence, type KeywordResult } from "@/lib/domain/products/search-profile";

export type PreparedTextProfileGatewayCall = Readonly<{ kind: "prepared"; wireHash: string;
  servingContractHash: string; totalTokenBound: number; model: string; evidenceHash: string }>;
export type TextProfileGatewayTerminal = Readonly<{ kind: "text_profile_gateway_terminal" }>;
const textProfileCalls = new WeakMap<PreparedTextProfileGatewayCall, { wire: string; evidenceIdentity: string;
  contract: TextProfileServingContract; timeoutMs: number; used: boolean }>();
const textProfileTerminals = new WeakMap<TextProfileGatewayTerminal, TextProfileGatewayTerminalEvidence>();
function validProfileEvidence(value: ProfileEvidence): boolean {
  const required = ["name", "url", "category", "topics", "tagline", "pageText", "readme"];
  return !!value && typeof value === "object" && !Array.isArray(value)
    && required.every(key => typeof (value as unknown as Record<string, unknown>)[key] === "string")
    && Object.keys(value).every(key => [...required, "description", "reviewerNote", "evidenceLevel"].includes(key))
    && (value.description === undefined || typeof value.description === "string")
    && (value.reviewerNote === undefined || typeof value.reviewerNote === "string")
    && (value.evidenceLevel === "thin" || value.evidenceLevel === "rich");
}
/** A caller flag, descriptor or injected request never enables a serving deployment. */
export function prepareTextProfileGatewayCall(evidence: ProfileEvidence, options: { model: string; timeoutMs: number }):
  PreparedTextProfileGatewayCall | { kind: "unsupported"; reason: "provider_contract_unavailable" } {
  assertLiveReviewAdapterAllowed();
  const snapshot = structuredClone(evidence), model = gatewayModel(options.model), timeoutMs = options.timeoutMs;
  const unsupported = { kind: "unsupported", reason: "provider_contract_unavailable" } as const;
  if (!validProfileEvidence(snapshot) || !model || !process.env.ABCLLM_API_KEY?.trim()
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return unsupported;
  const resolved = resolveTextProfileServingContract(model);
  if (!resolved) return unsupported;
  const contract = textProfileServingContractSchema.parse(structuredClone(resolved));
  if (contract.model !== model) return unsupported;
  const wire = profileGatewayWire(snapshot, model), evidenceIdentity = profileHash(snapshot);
  const call = Object.freeze({ kind: "prepared" as const, wireHash: sha(wire),
    servingContractHash: textProfileServingContractHash(contract), totalTokenBound: contract.totalTokenBound,
    model, evidenceHash: evidenceIdentity });
  textProfileCalls.set(call, { wire, evidenceIdentity, contract: freeze(contract), timeoutMs, used: false });
  return call;
}
export function readTextProfileGatewayTerminal(value: unknown): TextProfileGatewayTerminalEvidence | null {
  return value && typeof value === "object" ? textProfileTerminals.get(value as TextProfileGatewayTerminal) ?? null : null;
}
export async function writeKeywordsWithReservedGateway(evidence: ProfileEvidence, dispatch: TextProfileModelDispatch,
  call: PreparedTextProfileGatewayCall, options: { signal?: AbortSignal; timeoutMs?: number } = {}):
  Promise<{ result: KeywordResult; terminal: TextProfileGatewayTerminal | null }> {
  assertLiveReviewAdapterAllowed();
  const snapshot = structuredClone(evidence), state = textProfileCalls.get(call);
  const checked = textProfileModelDispatchSchema.safeParse(structuredClone(dispatch));
  const timeoutMs = options.timeoutMs ?? state?.timeoutMs ?? 45_000, signal = options.signal;
  if (!state || state.used || !checked.success || !validProfileEvidence(snapshot)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("text_profile_gateway_call_mismatch");
  const owned = checked.data, binding = owned.binding;
  if (profileHash(snapshot) !== state.evidenceIdentity || binding.evidenceHash !== call.evidenceHash
    || binding.model !== call.model || binding.wireHash !== call.wireHash
    || binding.servingContractHash !== call.servingContractHash || binding.totalTokenBound !== call.totalTokenBound
    || binding.provider !== state.contract.provider || binding.routeId !== state.contract.routeId
    || dispatchedRequests.has(owned.requestId)) throw new Error("text_profile_gateway_call_mismatch");
  state.used = true; dispatchedRequests.add(owned.requestId);
  const key = process.env.ABCLLM_API_KEY?.trim();
  if (!key) return { result: { ok: false, error: "no_key" }, terminal: null };
  const deadline = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let body: string;
  try {
    const response = await nativeFetch(state.contract.endpoint, { method: "POST", redirect: "manual",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: state.wire, signal: combined });
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch { /* Nonterminal failure retains full C. */ }
      return { result: { ok: false, error: response.status === 404 ? "model_unavailable"
        : response.status === 429 ? "rate_limit" : `http_${response.status}` }, terminal: null };
    }
    body = await response.text();
  } catch (error) {
    return { result: { ok: false, error: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network" }, terminal: null };
  }
  const completed = nativeTerminal(body, state.contract);
  if (!completed) return { result: { ok: false, error: "invalid_output" }, terminal: null };
  const terminal: TextProfileGatewayTerminal = Object.freeze({ kind: "text_profile_gateway_terminal" });
  textProfileTerminals.set(terminal, freeze(textProfileGatewayTerminalEvidenceSchema.parse({ version: 1,
    kind: "text_profile_gateway_terminal", dispatch: owned, responseHash: sha(body), ...completed })));
  return { result: parseProfileGatewayBody(body, snapshot.name), terminal };
}


import { reasonTranslationModelDispatchSchema, reasonTranslationGatewayTerminalEvidenceSchema,
  type ReasonTranslationModelDispatch, type ReasonTranslationGatewayTerminalEvidence } from "@/lib/llm/capacity";
import { reasonTranslationServingContractHash, reasonTranslationServingContractSchema, resolveReasonTranslationServingContract,
  type ReasonTranslationServingContract } from "@/lib/llm/reason-translation-serving-contract";
import { reasonTranslationGatewayWire, parseTranslations, textHash, type TranslateResult } from "./translate";
export type PreparedReasonTranslationGatewayCall = Readonly<{ kind: "prepared"; wireHash: string;
  servingContractHash: string; totalTokenBound: number; model: string; sourceHashes: readonly string[] }>;
export type ReasonTranslationGatewayTerminal = Readonly<{ kind: "reason_translation_gateway_terminal" }>;
const reasonTranslationCalls = new WeakMap<PreparedReasonTranslationGatewayCall, { wire: string;
  sourceHashes: string[]; contract: ReasonTranslationServingContract; timeoutMs: number; used: boolean }>();
const reasonTranslationTerminals = new WeakMap<ReasonTranslationGatewayTerminal, ReasonTranslationGatewayTerminalEvidence>();
function validReasonTexts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 4 && Array.from(value).every(text => typeof text === "string")
    && new Set(value.map(textHash)).size === value.length;
}
/** No caller flag or descriptor enables a reason serving deployment. */
export function prepareReasonTranslationGatewayCall(texts: readonly string[], options: { model: string; timeoutMs: number }):
  PreparedReasonTranslationGatewayCall | { kind: "unsupported"; reason: "provider_contract_unavailable" } {
  assertLiveReviewAdapterAllowed();
  const snapshot = structuredClone(texts), model = options.model, timeoutMs = options.timeoutMs;
  const unsupported = { kind: "unsupported", reason: "provider_contract_unavailable" } as const;
  if (!validReasonTexts(snapshot) || !reasonTranslationServingContractSchema.shape.model.safeParse(model).success
    || !process.env.ABCLLM_API_KEY?.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return unsupported;
  const resolved = resolveReasonTranslationServingContract(model);
  if (!resolved) return unsupported;
  const contract = reasonTranslationServingContractSchema.parse(structuredClone(resolved));
  if (contract.model !== model) return unsupported;
  const wire = reasonTranslationGatewayWire(snapshot, model), sourceHashes = snapshot.map(textHash);
  const call = freeze({ kind: "prepared" as const, wireHash: sha(wire),
    servingContractHash: reasonTranslationServingContractHash(contract), totalTokenBound: contract.totalTokenBound,
    model, sourceHashes: [...sourceHashes] });
  reasonTranslationCalls.set(call, { wire, sourceHashes, contract: freeze(contract), timeoutMs, used: false });
  return call;
}
export function readReasonTranslationGatewayTerminal(value: unknown): ReasonTranslationGatewayTerminalEvidence | null {
  return value && typeof value === "object" ? reasonTranslationTerminals.get(value as ReasonTranslationGatewayTerminal) ?? null : null;
}
export async function translateWithReservedReasonGateway(texts: readonly string[], dispatch: ReasonTranslationModelDispatch,
  call: PreparedReasonTranslationGatewayCall, options: { signal?: AbortSignal; timeoutMs?: number } = {}):
  Promise<{ result: TranslateResult; terminal: ReasonTranslationGatewayTerminal | null }> {
  assertLiveReviewAdapterAllowed();
  const snapshot = structuredClone(texts), state = reasonTranslationCalls.get(call);
  const checked = reasonTranslationModelDispatchSchema.safeParse(structuredClone(dispatch));
  const timeoutMs = options.timeoutMs ?? state?.timeoutMs ?? 45_000, signal = options.signal;
  if (!state || state.used || !checked.success || !validReasonTexts(snapshot)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("reason_translation_gateway_call_mismatch");
  const owned = checked.data, binding = owned.binding, sourceHashes = snapshot.map(textHash);
  if (JSON.stringify(sourceHashes) !== JSON.stringify(state.sourceHashes)
    || JSON.stringify(binding.members.map(member => member.sourceHash)) !== JSON.stringify(state.sourceHashes)
    || binding.model !== call.model || binding.wireHash !== call.wireHash
    || binding.servingContractHash !== call.servingContractHash || binding.totalTokenBound !== call.totalTokenBound
    || binding.provider !== state.contract.provider || binding.routeId !== state.contract.routeId
    || dispatchedRequests.has(owned.requestId)) throw new Error("reason_translation_gateway_call_mismatch");
  state.used = true; dispatchedRequests.add(owned.requestId);
  const key = process.env.ABCLLM_API_KEY?.trim();
  if (!key) return { result: { ok: false, error: "no_key" }, terminal: null };
  const deadline = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let body: string;
  try {
    const response = await nativeFetch(state.contract.endpoint, { method: "POST", redirect: "manual",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: state.wire, signal: combined });
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch { /* Unknown completion retains full C. */ }
      return { result: { ok: false, error: response.status === 429 ? "rate_limit" : `http_${response.status}` }, terminal: null };
    }
    body = await response.text();
  } catch (error) {
    return { result: { ok: false, error: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network" }, terminal: null };
  }
  const completed = nativeTerminal(body, state.contract);
  if (!completed) return { result: { ok: false, error: "invalid_output" }, terminal: null };
  const terminal: ReasonTranslationGatewayTerminal = Object.freeze({ kind: "reason_translation_gateway_terminal" });
  reasonTranslationTerminals.set(terminal, freeze(reasonTranslationGatewayTerminalEvidenceSchema.parse({ version: 1,
    kind: "reason_translation_gateway_terminal", dispatch: owned, responseHash: sha(body), ...completed })));
  const content = (JSON.parse(body) as { choices: { message: { content: string | null } }[] }).choices[0].message.content;
  return { result: parseTranslations(content ?? "", snapshot), terminal };
}

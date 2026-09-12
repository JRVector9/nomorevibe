import { MAX_REVIEW_INPUT_BYTES, validateReviewOutcome, type ReviewInput } from "./agent-review-contract";
import { REVIEW_SYSTEM_PROMPT, type AgentReviewResult, type ReviewFailure, type ReviewUsage } from "./agent-review";

/**
 * 사내 게이트웨이(abcllm)로 보는 심사.
 *
 * CLI 제공자와 같은 입력·같은 정책 글(REVIEW_SYSTEM_PROMPT)·같은 검증(validateReviewOutcome)을 쓴다.
 * 다른 것은 부르는 방법뿐이라, 어느 쪽으로 봐도 같은 질문에 답한 기록이 된다.
 *
 * 게이트웨이는 스트리밍이 기본이라 stream:false 를 꼭 보낸다. 모델 목록이 예고 없이 바뀌므로
 * (2026-09-12 실측: gemma4-26b 가 사라졌다 돌아왔고 그 사이 gpt-oss 가 502) 없는 모델은
 * model_unavailable 로 남겨 운영 화면에 드러낸다 — 조용히 넘기면 심사가 통째로 멈춘 줄 모른다.
 */
export const REVIEW_GATEWAY_TIMEOUT_MS = 30_000;
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

export async function reviewWithGateway(input: ReviewInput, options: {
  model: string; timeoutMs?: number; request?: typeof fetch; signal?: AbortSignal;
}): Promise<AgentReviewResult> {
  const key = process.env.ABCLLM_API_KEY?.trim();
  const model = gatewayModel(options.model);
  if (!key || !model) return { ok: false, error: "not_configured" };
  const serialized = JSON.stringify(input.snapshot);
  if (Buffer.byteLength(serialized, "utf8") > MAX_REVIEW_INPUT_BYTES) return { ok: false, error: "input_too_large" };
  // 꺾쇠를 막아 두어야 증거 안의 글이 구분자를 끝내지 못한다 — CLI 쪽과 같은 처리다
  const prompt = `<untrusted_evidence_json>\n${serialized.replace(/</g, "\\u003c").replace(/>/g, "\\u003e")}\n</untrusted_evidence_json>`;

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
      body: JSON.stringify({
        model, stream: false, temperature: 0, max_tokens: 1_500, reasoning_effort: "low",
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_schema", json_schema: { name: "review", schema: GATEWAY_SCHEMA } },
        messages: [
          { role: "system", content: `${REVIEW_SYSTEM_PROMPT}\nReturn one JSON object with decision, reason, evidenceIds, confidence.` },
          { role: "user", content: prompt },
        ],
      }),
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
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return { ok: false, error: "output_too_large" };
  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_envelope");
    envelope = parsed as Record<string, unknown>;
  } catch { return { ok: false, error: "invalid_output" }; }
  const usage = usageFrom(envelope);
  const choices = Array.isArray(envelope.choices) ? envelope.choices : [];
  const choice = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : null;
  // 길이에 걸려 잘린 답은 판단이 아니다 — 초안이 표가 되지 않게 여기서 끊는다
  if (choice?.finish_reason === "length") return { ok: false, error: "output_too_large", usage };
  const message = choice ? choice.message : null;
  const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : null;
  if (typeof content !== "string") return { ok: false, error: "invalid_output", usage };
  const value = parseGatewayContent(content);
  if (!value) return { ok: false, error: "invalid_output", usage };
  try {
    return { ok: true, outcome: validateReviewOutcome(input, value), usage };
  } catch { return { ok: false, error: "invalid_output", usage }; }
}

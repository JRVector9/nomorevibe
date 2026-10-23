import { assistHash, assistInputSchema, assistJsonSchema, validateAssistOutcome, type AssistInput, type AssistOutcome } from "./contracts";
import { buildAssistMessages, assistPromptHash } from "./prompts";
import { localModelThinkingFields, validateLocalModelRequest, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";

export function buildAssistModelRequest(value: AssistInput, contract: LocalModelServingContract) {
  const input = assistInputSchema.parse(value), messages = buildAssistMessages(input);
  if (!contract.capabilities.jsonSchema) throw new Error("assist_json_schema_required");
  const body = { model: contract.model, messages, temperature: 0, stream: false, max_tokens: Math.min(2048, contract.maxOutputTokens),
    response_format: { type: "json_schema", json_schema: { name: `assist_${input.task}`, strict: true, schema: assistJsonSchema(input.task) } },
    ...localModelThinkingFields(contract) };
  const wire = JSON.stringify(body);
  const inputBytes = Buffer.byteLength(wire);
  // byte 수는 거절용 보수적 추정일 뿐이며 실제 예약은 검증된 전체 server context 상한을 사용한다.
  const preflight = validateLocalModelRequest(contract, { model: contract.model, inputBytes, estimatedInputTokens: inputBytes,
    maxOutputTokens: body.max_tokens, vision: false, jsonSchema: true });
  if (!preflight.ok) throw new Error(`assist_request_${preflight.error}`);
  return { wire, promptHash: assistPromptHash(input.task), inputHash: assistHash(input) };
}

/** 물리 종료·수용량 정산은 native adapter 권한이다. 여기서는 업무 JSON만 검증한다. */
export function parseAssistModelResponse(input: AssistInput, response: unknown):
  { ok: true; outcome: AssistOutcome } | { ok: false; error: string } {
  if (!response || typeof response !== "object") return { ok: false, error: "invalid_model_response" };
  const data = response as { choices?: { finish_reason?: unknown; message?: { content?: unknown } }[] };
  if (data.choices?.length !== 1 || data.choices[0].finish_reason !== "stop"
    || typeof data.choices[0].message?.content !== "string") return { ok: false, error: "incomplete_model_output" };
  let value: unknown;
  try { value = JSON.parse(data.choices[0].message.content); } catch { return { ok: false, error: "invalid_model_json" }; }
  return validateAssistOutcome(input, value);
}

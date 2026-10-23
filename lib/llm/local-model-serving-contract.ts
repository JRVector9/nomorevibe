import { createHash } from "node:crypto";
import { z } from "zod";

const identity = (max = 200) => z.string().min(1).max(max)
  .refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value), "invalid_identity");
const positive = z.number().int().positive().safe();

/** 선언의 모양만 검사한다. 운영 준비 여부와 호출 권한은 native admission이 따로 확인한다. */
export const localModelServingContractSchema = z.object({
  version: z.literal(1), protocol: z.literal("local-openai-chat-v1"),
  backendId: identity(120), provider: z.literal("local-direct"), physicalGroup: identity(120),
  endpoint: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === "/v1/chat/completions";
  }, "invalid_chat_endpoint"),
  model: identity(), responseModel: identity(),
  modelFamily: z.enum(["qwen3.8-flash-next", "deepseek-v4.1-flash-1017", "gpt-oss-120b"]),
  deploymentRevision: identity(),
  contextWindowTokens: positive.max(1_048_576), totalTokenBound: positive.max(1_048_576),
  maxOutputTokens: positive.max(262_144), maxInputBytes: positive.max(16 * 1024 * 1024),
  capabilities: z.object({ vision: z.boolean(), jsonSchema: z.boolean() }).strict(),
  thinking: z.object({
    mode: z.enum(["disabled", "low"]),
    parameter: z.enum(["chat_template_kwargs.enable_thinking", "enable_thinking", "reasoning_effort", "none"]),
  }).strict(),
  termination: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("response_only") }).strict(),
    z.object({ kind: z.literal("provider_hard_deadline"), maxDurationMs: positive.max(3_600_000) }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  // 로컬 OpenAI 호환 서버는 gateway의 요청별 C를 구현하지 않는다. 검증된 전체 문맥 상한을 계량한다.
  if (value.maxOutputTokens > value.totalTokenBound || value.totalTokenBound !== value.contextWindowTokens) {
    context.addIssue({ code: "custom", message: "invalid_total_token_bound", path: ["totalTokenBound"] });
  }
  if (value.thinking.mode === "low" && value.thinking.parameter !== "reasoning_effort"
    || value.thinking.mode === "disabled" && value.thinking.parameter === "reasoning_effort") {
    context.addIssue({ code: "custom", message: "incompatible_thinking_control", path: ["thinking"] });
  }
});
export type LocalModelServingContract = Readonly<z.infer<typeof localModelServingContractSchema>>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function localModelContractHash(value: LocalModelServingContract): string {
  return createHash("sha256").update(JSON.stringify(canonical(localModelServingContractSchema.parse(value)))).digest("hex");
}

export const localModelServingContractsSchema = z.array(localModelServingContractSchema).max(32)
  .superRefine((values, context) => {
    const ids = new Set<string>(), groups = new Map<string, string>();
    for (const [index, value] of values.entries()) {
      if (ids.has(value.backendId)) context.addIssue({ code: "custom", message: "duplicate_backend", path: [index, "backendId"] });
      ids.add(value.backendId);
      const previous = groups.get(value.endpoint);
      if (previous && previous !== value.physicalGroup) context.addIssue({
        code: "custom", message: "endpoint_group_conflict", path: [index, "physicalGroup"],
      });
      groups.set(value.endpoint, value.physicalGroup);
    }
  });

/** 없거나 잘못된 설정은 기본 모델을 추측하지 않고 닫는다. 비밀값은 계약에 넣지 않는다. */
export function resolveLocalModelServingContract(backendId: string,
  env: Readonly<Record<string, string | undefined>> = process.env): LocalModelServingContract | null {
  const raw = env.LOCAL_MODEL_SERVING_CONTRACTS;
  if (!raw) return null;
  try { return localModelServingContractsSchema.parse(JSON.parse(raw)).find(value => value.backendId === backendId) ?? null; }
  catch { return null; }
}

export function localModelThinkingFields(contract: LocalModelServingContract): Record<string, unknown> {
  const { thinking } = localModelServingContractSchema.parse(contract);
  switch (thinking.parameter) {
    case "chat_template_kwargs.enable_thinking": return { chat_template_kwargs: { enable_thinking: false } };
    case "enable_thinking": return { enable_thinking: false };
    case "reasoning_effort": return { reasoning_effort: "low" };
    case "none": return {};
  }
}

/** 추정은 조기 거절용이며 tokenizer 증명이나 원격 C 보증을 발급하지 않는다. */
export function validateLocalModelRequest(contract: LocalModelServingContract, request: {
  model: string; inputBytes: number; estimatedInputTokens: number; maxOutputTokens: number; vision?: boolean; jsonSchema?: boolean;
}): { ok: true } | { ok: false; error: string } {
  const parsed = localModelServingContractSchema.safeParse(contract);
  if (!parsed.success) return { ok: false, error: "invalid_contract" };
  const c = parsed.data;
  if (request.model !== c.model) return { ok: false, error: "model_mismatch" };
  for (const value of [request.inputBytes, request.estimatedInputTokens, request.maxOutputTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) return { ok: false, error: "invalid_request_bound" };
  }
  if (request.maxOutputTokens < 1 || request.maxOutputTokens > c.maxOutputTokens
    || request.estimatedInputTokens + request.maxOutputTokens > c.totalTokenBound
    || request.inputBytes > c.maxInputBytes) return { ok: false, error: "input_too_large" };
  if (request.vision && !c.capabilities.vision || request.jsonSchema && !c.capabilities.jsonSchema) {
    return { ok: false, error: "unsupported_capability" };
  }
  return { ok: true };
}

export function sameLocalModelFamily(a: LocalModelServingContract, b: LocalModelServingContract): boolean {
  return a.modelFamily === b.modelFamily;
}

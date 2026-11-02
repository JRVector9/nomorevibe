import { createHash } from "node:crypto";
import { z } from "zod";
import { startupGatewayServingContracts } from "@/lib/llm/gateway-serving-contract-config";
import { AI2_DIRECT_OPENAI_CHAT_PROTOCOL, DIRECT_OPENAI_CHAT_PROTOCOL, directServingContractSchema, selectServingContract,
  servingContractMatchesSelection } from "@/lib/llm/direct-serving-contract";

const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
const tokenizerEndpoint = z.url().refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === "/tokenize";
});
const requestBudgetSchema = z.object({ requestTokenBound: z.literal(32_000), maxOutputTokens: z.number().int().positive().max(32_000),
  tokenizerEndpoint, tokenizerModel: identity }).strict();
const legacyAi2GatewayServingContractSchema = z.object({
  version: z.literal(1), protocol: z.literal("abcllm-raw-total-bound-v1"),
  routeId: z.literal("second-review"), provider: z.literal("abcllm"),
  model: identity, responseModel: identity, deploymentRevision: identity,
  endpoint: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === "/v1/chat/completions";
  }),
  totalTokenBound: z.number().int().positive().safe(),
  // Explicit read-back mapping from this raw gateway alias to its actual engine/tokenizer.
  // Absence preserves the historical contract hash and wire exactly.
  requestBudget: requestBudgetSchema.optional(),
  /** 엔진에 보내는 모델 이름 — model 이 연결로 가른 장부 이름(`<모델>@<연결 8자>`)일 때만(PR C1). 없으면 예전 계약과 hash·wire 가 같다 */
  engineModel: identity.optional(),
}).strict().superRefine((value, context) => {
  if (value.requestBudget && value.totalTokenBound < value.requestBudget.requestTokenBound)
    context.addIssue({ code: "custom", message: "invalid_request_token_bound" });
});
/**
 * AI2 직접 계약 — 공통 direct-openai-chat-v1 모양(lib/llm/direct-serving-contract.ts)의 얇은 별칭이다. 저장된 계약의 옛 protocol 이름
 * "ai2-direct-openai-chat-v1" 이 첫 값이라 그대로 파싱되고, 칸 순서가 같아 hash 도 바뀌지 않는다. 공통 이름도 받는다.
 */
export const ai2DirectServingContractSchema = directServingContractSchema("second-review",
  [AI2_DIRECT_OPENAI_CHAT_PROTOCOL, DIRECT_OPENAI_CHAT_PROTOCOL] as const);
export const ai2GatewayServingContractSchema = z.discriminatedUnion("protocol", [
  legacyAi2GatewayServingContractSchema, ai2DirectServingContractSchema,
]);
export type Ai2GatewayServingContract = Readonly<z.infer<typeof ai2GatewayServingContractSchema>>;
export type Ai2DirectServingContract = Readonly<z.infer<typeof ai2DirectServingContractSchema>>;

/** Shape/hash validation does not approve a deployment or issue transport authority. */
export function ai2GatewayServingContractHash(value: Ai2GatewayServingContract): string {
  return createHash("sha256").update(JSON.stringify(ai2GatewayServingContractSchema.parse(value))).digest("hex");
}

/**
 * 관리 화면(model_serving_contracts)의 2차 계약 — abcllm 형(total-bound, transport direct 면 엔진에 바로)과 직접 계약(direct-openai-chat-v1, local-direct) 둘 다 받는다.
 * 2026-11-02 PR C1: 예전 env AI2_DIRECT_SERVING_CONTRACTS 는 읽지 않는다 — 2차 계약은 「작업 ↔ 모델」 순위 저장이 만든 행(또는 모델 연결 화면이 저장한 행)뿐이다.
 * 엔진 연결이 채우는 칸은 abcllm 형이다(gatewayShape).
 */
const configured = startupGatewayServingContracts("second-review", ai2GatewayServingContractSchema,
  { gatewayShape: legacyAi2GatewayServingContractSchema });
/** A key binds the exact configured device endpoint and actual wire name; it never rewrites the verified contract. */
export function ai2ServingContractMatches(contract: Ai2GatewayServingContract, selection: string): boolean {
  return servingContractMatchesSelection(contract, selection);
}
export function selectAi2ServingContract(contracts: readonly Ai2GatewayServingContract[], selection: string, provider: string): Ai2GatewayServingContract | null {
  return selectServingContract(contracts, selection, provider);
}
/** Read-back approved contracts only. Ambiguous bare models close; an equipment key chooses an exact contract. */
export function resolveAi2GatewayServingContract(model: string, provider: string = "abcllm"): Ai2GatewayServingContract | null {
  if (provider !== "abcllm" && provider !== "local-direct") return null;
  return selectAi2ServingContract([...configured.values()], model, provider);
}

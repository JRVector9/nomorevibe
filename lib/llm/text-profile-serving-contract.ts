import { createHash } from "node:crypto";
import { z } from "zod";
import { startupGatewayServingContracts } from "./gateway-serving-contract-config";
import { DIRECT_OPENAI_CHAT_PROTOCOL, directServingContractSchema, resolveProviderServingContract, servingContractProvider,
  type GatewayContractProvider } from "./direct-serving-contract";

const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
/** abcLLM 총량 상한 계약 — 칸 순서·값 그대로(저장된 계약의 hash 가 바뀌지 않는다). */
export const textProfileServingContractSchema = z.object({
  version: z.literal(1), protocol: z.literal("abcllm-raw-total-bound-v1"),
  routeId: z.literal("product-search-profile"), provider: z.literal("abcllm"),
  model: identity, responseModel: identity, deploymentRevision: identity,
  endpoint: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === "/v1/chat/completions";
  }), totalTokenBound: z.number().int().positive().safe(),
  // 같은 모델 이름을 다른 연결에도 둔 순위(PR B)의 계약은 model 이 연결로 가른 장부 이름이고, 엔진에는 이 이름이 나간다. 없으면 model 이 나간다
  // (없는 칸은 parse 결과에 들지 않아 지금 계약의 hash 는 그대로다).
  engineModel: identity.optional(),
}).strict();
export type TextProfileGatewayServingContract = Readonly<z.infer<typeof textProfileServingContractSchema>>;
/** 엔진 직접 계약(PR 3b-E) — AI1·AI2 와 같은 direct-openai-chat-v1 모양, provider local-direct. 같은 route_id 아래 관리 화면(model_serving_contracts)에 둔다. */
export const textProfileDirectServingContractSchema = directServingContractSchema("product-search-profile", [DIRECT_OPENAI_CHAT_PROTOCOL] as const);
export const textProfileRouteServingContractSchema = z.discriminatedUnion("protocol", [textProfileServingContractSchema, textProfileDirectServingContractSchema]);
export type TextProfileServingContract = Readonly<z.infer<typeof textProfileRouteServingContractSchema>>;
/** 모양·hash 검사는 배포를 승인하지 않는다. raw 계약의 hash 는 합 스키마로 파싱해도 같다(같은 칸 순서). */
export function textProfileServingContractHash(value: TextProfileServingContract): string {
  return createHash("sha256").update(JSON.stringify(textProfileRouteServingContractSchema.parse(value))).digest("hex");
}
const configured = startupGatewayServingContracts("product-search-profile", textProfileRouteServingContractSchema, { gatewayShape: textProfileServingContractSchema });
/**
 * 운영자가 readback 으로 검증해 관리 화면(model_serving_contracts)에 저장한 계약만 연다. 없거나 틀리면 null(=deferred)이다.
 * abcllm 은 model 이 정확히 같은 계약 하나, local-direct 는 선택이 가리키는 직접 계약이 정확히 하나일 때(AI1 과 같은 규칙).
 */
export function resolveTextProfileServingContract(model: string, provider: GatewayContractProvider = "abcllm"): TextProfileServingContract | null {
  return resolveProviderServingContract(configured, model, provider);
}
/** 이 선택이 가리키는 계약의 provider — 조정자가 identity·binding 의 provider 로 쓴다(abcllm 계약이 있으면 abcllm). */
export function textProfileServingProvider(model: string): GatewayContractProvider { return servingContractProvider(configured, model); }

import { createHash } from "node:crypto";
import { z } from "zod";
import { ABCLLM_STRICT_TERMINAL_OPT_IN, startupGatewayServingContracts } from "./gateway-serving-contract-config";
import { DIRECT_OPENAI_CHAT_PROTOCOL, directServingContractSchema, resolveProviderServingContract, servingContractProvider,
  type GatewayContractProvider } from "./direct-serving-contract";

const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
/** abcLLM 총량 상한 계약 — 칸 순서·값 그대로(저장된 계약의 hash 가 바뀌지 않는다). */
export const productTaglineKoServingContractSchema = z.object({
  version: z.literal(1), protocol: z.literal("abcllm-product-tagline-ko-total-bound-v1"),
  routeId: z.literal("product-tagline-ko"), provider: z.literal("abcllm"),
  model: identity, responseModel: identity, deploymentRevision: identity,
  endpoint: z.url().refine(value => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
        && !url.search && !url.hash && url.pathname === "/v1/chat/completions";
    } catch { return false; }
  }), totalTokenBound: z.number().int().positive().safe(),
  // PR3 엄격 terminal opt-in 표시. 설정 resolver 는 이 표시가 있어야만 연다(gateway-serving-contract-config.ts)
  strictTerminalOptIn: z.literal(ABCLLM_STRICT_TERMINAL_OPT_IN).optional(),
  // 같은 모델 이름을 다른 연결에도 둔 순위(PR B)의 계약은 model 이 연결로 가른 장부 이름이고, 엔진에는 이 이름이 나간다. 없으면 model 이 나간다
  // (없는 칸은 parse 결과에 들지 않아 지금 계약의 hash 는 그대로다).
  engineModel: identity.optional(),
  // 추론 토큰이 max_tokens 에 포함되는 모델(예: LG EXAONE K-EXAONE — 추론이 늘 켜져 있다)의 여유(2026-11-11, 사유 번역 #894 와 같은 칸). 있으면 요청의
  // max_tokens 에 이만큼 더한다(productTaglineKoGatewayWire). 연결의 「추론 토큰 여유」로 계약을 만들 때만 생긴다 — 없는 계약의 hash·wire 는 그대로다.
  reasoningTokenReserve: z.number().int().min(1).max(32_768).optional(),
}).strict();
export type ProductTaglineKoGatewayServingContract = Readonly<z.infer<typeof productTaglineKoServingContractSchema>>;
/** 엔진 직접 계약(PR 3b-E) — direct-openai-chat-v1, provider local-direct. 게이트웨이가 없어 엄격 terminal opt-in 표시가 없다(엔진 완결 응답이 terminal). */
export const productTaglineKoDirectServingContractSchema = directServingContractSchema("product-tagline-ko", [DIRECT_OPENAI_CHAT_PROTOCOL] as const);
export const productTaglineKoRouteServingContractSchema = z.discriminatedUnion("protocol", [productTaglineKoServingContractSchema, productTaglineKoDirectServingContractSchema]);
export type ProductTaglineKoServingContract = Readonly<z.infer<typeof productTaglineKoRouteServingContractSchema>>;
/** 모양·hash 검사는 배포를 승인하지 않는다. raw 계약의 hash 는 합 스키마로 파싱해도 같다(같은 칸 순서). */
export function productTaglineKoServingContractHash(value: ProductTaglineKoServingContract): string {
  return createHash("sha256").update(JSON.stringify(productTaglineKoRouteServingContractSchema.parse(value))).digest("hex");
}
const configured = startupGatewayServingContracts("product-tagline-ko", productTaglineKoRouteServingContractSchema, { gatewayShape: productTaglineKoServingContractSchema });
/**
 * 운영자가 readback 으로 검증해 관리 화면(model_serving_contracts)에 저장한 계약만 연다. 없거나 틀리면 null(=deferred)이다.
 * abcllm 은 model 이 정확히 같은 계약 하나, local-direct 는 선택이 가리키는 직접 계약이 정확히 하나일 때(AI1 과 같은 규칙).
 */
export function resolveProductTaglineKoServingContract(model: string, provider: GatewayContractProvider = "abcllm"): ProductTaglineKoServingContract | null {
  return resolveProviderServingContract(configured, model, provider);
}
/** 이 선택이 가리키는 계약의 provider — 조정자가 identity·binding 의 provider 로 쓴다(abcllm 계약이 있으면 abcllm). */
export function productTaglineKoServingProvider(model: string): GatewayContractProvider { return servingContractProvider(configured, model); }

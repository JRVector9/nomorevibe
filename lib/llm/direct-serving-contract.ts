import { z } from "zod";
import { modelRequestName, resolveRegistryModel } from "./model-registry";
import { providerRateLimitBackoffSchema } from "./provider-rate-limit-policy";

/**
 * 엔진에 직접 보내는 OpenAI 호환 chat 계약(PR 3b-C 전송 통합) — AI1·AI2 가 같은 모양을 쓴다. routeId 로만 갈린다.
 *
 * - endpoint 는 엔진의 /v1/chat/completions, tokenizerEndpoint 는 같은 origin 의 /tokenize 다(vLLM). 요청은 tokenizer 로 센 프롬프트 +
 *   maxOutputTokens 가 requestTokenBound(32k) 안에 들 때만 보낸다. totalTokenBound(C)는 readback 한 엔진 문맥 상한이고, 작은 요청 정책이
 *   C 를 바꾸지 않는다 — 장부는 C 를 계량한다.
 * - provider 는 local-direct 하나다. 게이트웨이 라벨([MLX] 등)이 없는 엔진 모델 이름이 그대로 선(wire)에 나가고, 게이트웨이 전용 칸
 *   (context_strategy·reasoning_effort)과 엄격 terminal 헤더는 보내지 않는다. 엔진의 완결 응답 자체가 terminal 증거다.
 * - protocol 은 공통 "direct-openai-chat-v1". AI2 의 옛 이름 "ai2-direct-openai-chat-v1" 은 저장된 계약이 그대로 파싱·해시되도록 AI2 에서만
 *   두 번째 값으로 받는다(second-review-serving-contract.ts).
 * 모양·해시 검사는 배포를 승인하지 않는다 — 운영자가 readback 으로 확인한 계약만 설정·관리 화면에 들어간다.
 */
export const DIRECT_OPENAI_CHAT_PROTOCOL = "direct-openai-chat-v1";
export const AI2_DIRECT_OPENAI_CHAT_PROTOCOL = "ai2-direct-openai-chat-v1";
export const DIRECT_REQUEST_TOKEN_BOUND = 32_000;

const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
const endpointAt = (pathname: string) => z.url().refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === pathname;
});
export const directChatEndpointSchema = endpointAt("/v1/chat/completions");
export const directTokenizerEndpointSchema = endpointAt("/tokenize");

/**
 * 한 route 의 직접 계약 스키마. 칸 순서는 hash(JSON.stringify(parse 결과))의 일부라 바꾸지 않는다 — AI2 의 저장된 계약과 같은 순서다.
 * protocols 의 첫 값이 기본이고, 나머지는 그 route 가 예전부터 받던 이름이다.
 */
export function directServingContractSchema<R extends string, P extends readonly [string, ...string[]]>(routeId: R, protocols: P) {
  return z.object({
    version: z.literal(1), protocol: z.enum(protocols),
    routeId: z.literal(routeId), provider: z.literal("local-direct"),
    model: identity, responseModel: identity, deploymentRevision: identity,
    endpoint: directChatEndpointSchema,
    tokenizerEndpoint: directTokenizerEndpointSchema, backendId: identity, physicalGroup: identity,
    // C is the read-back engine context limit. The smaller request policy never rewrites C.
    totalTokenBound: z.number().int().positive().safe(),
    requestTokenBound: z.literal(DIRECT_REQUEST_TOKEN_BOUND), maxOutputTokens: z.number().int().positive().max(DIRECT_REQUEST_TOKEN_BOUND),
  }).strict().superRefine((value, context) => {
    const chat = new URL(value.endpoint), tokenizer = new URL(value.tokenizerEndpoint);
    if (tokenizer.origin !== chat.origin || tokenizer.pathname !== "/tokenize" || tokenizer.username
      || tokenizer.password || tokenizer.search || tokenizer.hash || value.totalTokenBound < value.requestTokenBound)
      context.addIssue({ code: "custom", message: "invalid_direct_tokenizer_contract" });
  });
}
export type DirectServingContract = Readonly<z.infer<ReturnType<typeof directServingContractSchema<string, readonly [string, ...string[]]>>>>;

/**
 * 엔진에 바로 보내는 총량 상한 계약(2026-11-21 abcllm 이름표 정리 1단계) — provider 는 local-direct, 열 경로가 같은 모양을 쓴다.
 *
 * - 「API 주소 + 모델」만 적는다: 장비 이름 칸(backendId·physicalGroup)과 게이트웨이 표지(strictTerminalOptIn)가 없다.
 * - wire 는 그 경로가 abcllm 총량 상한 계약으로 보내는 바이트 그대로다(경로의 wire + engineModel). 엄격 terminal 헤더만 나가지 않는다.
 *   장부는 abcllm 계약처럼 totalTokenBound(C) 전부를 계량한다.
 * - tokenizer 묶음이 있을 때만 보내기 전에 엔진 tokenizer(같은 origin 의 /tokenize)로 입력 + 출력 상한 ≤ requestTokenBound 를 확인한다.
 *   묶음이 없으면 확인하지 않는다(tokenizer 가 없는 서버).
 * - maxOutputTokens 가 있으면 요청의 max_tokens 를 그 값으로 묶는다: text 경로는 경로의 값과 견줘 작은 쪽, 심사 두 경로는 그 값 그대로
 *   (각각 지금 direct-openai-chat-v1·2차 requestBudget 이 하는 것과 같다). 없으면 경로의 max_tokens 그대로다.
 * - reasoningTokenReserve·rateLimitBackoff 는 그 칸을 abcllm 계약에서 받는 경로만 받는다(받지 않는 경로는 모양 검사에서 거절).
 * 칸 순서는 hash(JSON.stringify(parse 결과))의 일부라 바꾸지 않는다. 모양·해시 검사는 배포를 승인하지 않는다.
 */
export const OPENAI_CHAT_TOTAL_BOUND_PROTOCOL = "openai-chat-total-bound-v1";
type TotalBoundDirectOptions = Readonly<{ reasoningTokenReserve?: boolean; rateLimitBackoff?: boolean }>;
const totalBoundTokenizerSchema = z.object({ endpoint: directTokenizerEndpointSchema, requestTokenBound: z.number().int().positive().safe() }).strict();
export function totalBoundDirectServingContractSchema<R extends string>(routeId: R, options: TotalBoundDirectOptions = {}) {
  return z.object({
    version: z.literal(1), protocol: z.literal(OPENAI_CHAT_TOTAL_BOUND_PROTOCOL),
    routeId: z.literal(routeId), provider: z.literal("local-direct"),
    model: identity, responseModel: identity, deploymentRevision: identity,
    endpoint: directChatEndpointSchema,
    totalTokenBound: z.number().int().positive().safe(),
    // 같은 모델 이름을 다른 연결에도 둔 순위의 계약은 model 이 연결로 가른 장부 이름이고 엔진에는 이 이름이 나간다(abcllm 계약의 같은 칸)
    engineModel: identity.optional(),
    reasoningTokenReserve: (options.reasoningTokenReserve ? z.number().int().min(1).max(32_768) : z.never()).optional(),
    rateLimitBackoff: (options.rateLimitBackoff ? providerRateLimitBackoffSchema : z.never()).optional(),
    maxOutputTokens: z.number().int().positive().safe().optional(),
    tokenizer: totalBoundTokenizerSchema.optional(),
  }).strict().superRefine((value, context) => {
    if (value.maxOutputTokens !== undefined && value.maxOutputTokens > (value.tokenizer?.requestTokenBound ?? value.totalTokenBound))
      context.addIssue({ code: "custom", message: "invalid_max_output_tokens" });
    if (value.tokenizer && (new URL(value.tokenizer.endpoint).origin !== new URL(value.endpoint).origin
      || value.totalTokenBound < value.tokenizer.requestTokenBound))
      context.addIssue({ code: "custom", message: "invalid_direct_tokenizer_contract" });
  });
}
export type TotalBoundDirectServingContract = Readonly<z.infer<ReturnType<typeof totalBoundDirectServingContractSchema<string>>>>;
/** openai-chat-total-bound-v1 계약인가(모양을 아는 호출자용 — protocol 글자 하나로 가른다). */
export const isTotalBoundDirectContract = (contract: { protocol?: unknown }): boolean => contract.protocol === OPENAI_CHAT_TOTAL_BOUND_PROTOCOL;
/**
 * 계약이 엔진에 보내는 모델 이름. abcllm 형과 openai-chat-total-bound-v1 은 engineModel 이 있으면 그것(없으면 model), 그 밖의 local-direct
 * 계약(direct-openai-chat-v1, 1차의 raw local-direct)은 예전처럼 model 뿐이다 — 순위 묶기·키 찾기가 같은 규칙을 쓴다.
 */
export function servingContractWireModel(contract: { provider?: unknown; protocol?: unknown; model: string; engineModel?: unknown }): string {
  const engine = typeof contract.engineModel === "string" && contract.engineModel ? contract.engineModel : null;
  return contract.provider === "local-direct" && !isTotalBoundDirectContract(contract) ? contract.model : engine ?? contract.model;
}
/**
 * openai-chat-total-bound-v1 계약의 보내기 전 tokenizer 확인 조건 — tokenizer 묶음이 없으면 null(확인하지 않는다). 이 모양은 wire 를 바꾸지
 * 않으므로 확인은 보낸 그대로(chat_template_kwargs 가 있으면 그것까지)를 tokenizer 에 넘긴다. 다른 모양은 각자의 예전 확인을 쓴다.
 */
export function totalBoundTokenizer(contract: { protocol?: unknown; tokenizer?: { endpoint: string; requestTokenBound: number } }):
  { tokenizerEndpoint: string; requestTokenBound: number } | null {
  return isTotalBoundDirectContract(contract) && contract.tokenizer
    ? { tokenizerEndpoint: contract.tokenizer.endpoint, requestTokenBound: contract.tokenizer.requestTokenBound } : null;
}

/** 계약의 공통 칸만 본다(게이트웨이 계약·직접 계약 모두). */
type MatchableContract = Readonly<{ provider: string; model: string; endpoint: string; maxOutputTokens?: number }>;
/**
 * 선택(설정에 적힌 모델)이 이 계약을 가리키는가. 계약의 model 과 같거나, 등록부 키가 같은 provider·실제 요청 이름·장비 주소로 이 계약에
 * 닿을 때다. 키는 계약을 다시 쓰지 않는다 — 확인된 계약의 endpoint 와 이름에 묶일 뿐이다. 직접 계약은 등록부의 출력 상한도 넘지 않아야 한다.
 */
export function servingContractMatchesSelection(contract: MatchableContract, selection: string): boolean {
  if (selection === contract.model) return true;
  try {
    const definition = resolveRegistryModel(selection);
    return Boolean(definition && selection === definition.key && definition.provider === contract.provider
      && modelRequestName(definition) === contract.model
      && (contract.maxOutputTokens === undefined || contract.maxOutputTokens <= definition.maxTokens)
      && `${definition.baseUrl?.replace(/\/+$/, "")}/chat/completions` === contract.endpoint);
  } catch { return false; }
}
/** 그 provider 의 계약 중 선택이 가리키는 것이 정확히 하나일 때만 연다. 이름만으로 둘 이상이면 닫는다. */
export function selectServingContract<T extends MatchableContract>(contracts: readonly T[], selection: string, provider: string): T | null {
  const matches = contracts.filter(contract => contract.provider === provider && servingContractMatchesSelection(contract, selection));
  return matches.length === 1 ? matches[0] : null;
}

/** 게이트웨이 kind 계약이 가질 수 있는 provider(장부의 GATEWAY_DISPATCH_PROVIDERS 와 같은 둘). */
export const GATEWAY_CONTRACT_PROVIDERS = ["abcllm", "local-direct"] as const;
export type GatewayContractProvider = typeof GATEWAY_CONTRACT_PROVIDERS[number];
/**
 * 한 route 의 계약 묶음(model → 계약)에서 provider 별로 고른다 — AI1(resolveAi1GatewayServingContract)·text 7경로(PR 3b-E)가 같은 규칙을 쓴다.
 * abcllm 은 예전처럼 model 이 정확히 같은 abcllm 계약 하나, local-direct 는 선택(엔진 이름 또는 등록부 키)이 가리키는 local-direct 계약이
 * 정확히 하나일 때다. 그 밖의 provider 는 null 이다.
 */
export function resolveProviderServingContract<T extends MatchableContract>(contracts: ReadonlyMap<string, T>, selection: string, provider: string): T | null {
  if (provider === "abcllm") {
    const contract = contracts.get(selection);
    return contract?.provider === "abcllm" ? contract : null;
  }
  return provider === "local-direct" ? selectServingContract([...contracts.values()], selection, provider) : null;
}
/**
 * 선택(설정·배정 표의 모델)이 어느 provider 의 계약을 가리키는가 — text 경로가 identity·binding 의 provider 를 정하는 한 곳(PR 3b-E).
 * abcllm 계약이 있으면 abcllm(예전 그대로), 없고 local-direct 계약 하나가 닿으면 local-direct, 둘 다 없으면 abcllm — 그 뒤 준비가 예전처럼
 * provider_contract_unavailable 로 미룬다(계약 없는 선택이 새 provider 로 기록되지 않는다).
 */
export function servingContractProvider<T extends MatchableContract>(contracts: ReadonlyMap<string, T>, selection: string): GatewayContractProvider {
  if (resolveProviderServingContract(contracts, selection, "abcllm")) return "abcllm";
  return resolveProviderServingContract(contracts, selection, "local-direct") ? "local-direct" : "abcllm";
}

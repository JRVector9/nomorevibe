import { createHash } from "node:crypto";
import { z } from "zod";
import { startupGatewayServingContracts } from "@/lib/llm/gateway-serving-contract-config";
import { DIRECT_OPENAI_CHAT_PROTOCOL, directServingContractSchema, selectServingContract } from "@/lib/llm/direct-serving-contract";

const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
/**
 * AI1 의 총량 상한(raw) 계약. provider 는 abcllm(게이트웨이, 또는 관리 화면의 직접 연결 transport direct)이거나 local-direct(라벨 없는
 * 엔진 이름으로 엔진에 바로)다 — PR 3b-C 에서 넓혔다. 칸 순서·값이 그대로라 저장된 abcllm 계약의 hash 는 바뀌지 않는다.
 */
export const ai1RawGatewayServingContractSchema = z.object({
  version: z.literal(1), protocol: z.literal("abcllm-raw-total-bound-v1"),
  routeId: z.literal("crawl-agent-review"), provider: z.enum(["abcllm", "local-direct"]),
  model: identity, responseModel: identity, deploymentRevision: identity,
  endpoint: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === "/v1/chat/completions";
  }),
  totalTokenBound: z.number().int().positive().safe(),
  /**
   * 엔진에 보내는 모델 이름 — model 이 같은 모델을 다른 연결에도 둔 순위의 장부 이름(`<모델>@<연결 8자>`)일 때만 있다(PR C1, text 경로의 PR B 와 같은 규칙).
   * 없으면 칸이 없는 예전 계약과 parse 결과·hash 가 같다.
   */
  engineModel: identity.optional(),
}).strict();
/** AI1 의 직접 계약 — AI2 와 같은 공통 direct-openai-chat-v1 모양(tokenizer 로 요청 상한을 확인한다). */
export const ai1DirectServingContractSchema = directServingContractSchema("crawl-agent-review", [DIRECT_OPENAI_CHAT_PROTOCOL] as const);
export const ai1GatewayServingContractSchema = z.discriminatedUnion("protocol", [
  ai1RawGatewayServingContractSchema, ai1DirectServingContractSchema,
]);
export type Ai1GatewayServingContract = Readonly<z.infer<typeof ai1GatewayServingContractSchema>>;
export type Ai1DirectServingContract = Readonly<z.infer<typeof ai1DirectServingContractSchema>>;

/** Shape/hash validation does not approve a deployment or issue transport authority. */
export function ai1GatewayServingContractHash(value: Ai1GatewayServingContract): string {
  return createHash("sha256").update(JSON.stringify(ai1GatewayServingContractSchema.parse(value))).digest("hex");
}

// 관리 화면(model_serving_contracts)은 두 모양을 모두 받는다. 엔진 연결(admin-engine-connect)이 채우는 칸은 raw 모양이다.
const configured = startupGatewayServingContracts("crawl-agent-review", ai1GatewayServingContractSchema,
  { gatewayShape: ai1RawGatewayServingContractSchema });
/**
 * 운영자가 readback 으로 검증해 관리 화면(model_serving_contracts)에 저장한 계약만 연다. 없거나 틀리면 null(=deferred)이다.
 * abcllm 은 예전처럼 model 이 정확히 같은 계약 하나다. local-direct 는 그 provider 의 계약 중 선택(엔진 이름 또는 등록부 키)이 가리키는
 * 것이 정확히 하나일 때다(AI2 와 같은 규칙).
 */
export function resolveAi1GatewayServingContract(model: string, provider: string = "abcllm"): Ai1GatewayServingContract | null {
  if (provider === "abcllm") {
    const contract = configured.get(model);
    return contract?.provider === "abcllm" ? contract : null;
  }
  return provider === "local-direct" ? selectServingContract([...configured.values()], model, provider) : null;
}

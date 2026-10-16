import { createHash } from "node:crypto";
import { z } from "zod";
import { startupGatewayServingContracts } from "@/lib/llm/gateway-serving-contract-config";

const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
export const ai1GatewayServingContractSchema = z.object({
  version: z.literal(1), protocol: z.literal("abcllm-raw-total-bound-v1"),
  routeId: z.literal("crawl-agent-review"), provider: z.literal("abcllm"),
  model: identity, responseModel: identity, deploymentRevision: identity,
  endpoint: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === "/v1/chat/completions";
  }),
  totalTokenBound: z.number().int().positive().safe(),
}).strict();
export type Ai1GatewayServingContract = Readonly<z.infer<typeof ai1GatewayServingContractSchema>>;

/** Shape/hash validation does not approve a deployment or issue transport authority. */
export function ai1GatewayServingContractHash(value: Ai1GatewayServingContract): string {
  return createHash("sha256").update(JSON.stringify(ai1GatewayServingContractSchema.parse(value))).digest("hex");
}

const configured = startupGatewayServingContracts("crawl-agent-review", ai1GatewayServingContractSchema);
/** 운영자가 readback 으로 검증해 ABCLLM_SERVING_CONTRACTS 에 넣은 계약만 연다. 없거나 틀리면 null(=deferred)이다. */
export function resolveAi1GatewayServingContract(model: string): Ai1GatewayServingContract | null { return configured.get(model) ?? null; }

import { createHash } from "node:crypto";
import { z } from "zod";
import { ABCLLM_STRICT_TERMINAL_OPT_IN, startupGatewayServingContracts } from "./gateway-serving-contract-config";

const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
export const productTranslationServingContractSchema = z.object({
  version: z.literal(1), protocol: z.literal("abcllm-product-translation-total-bound-v1"),
  routeId: z.literal("product-translate"), provider: z.literal("abcllm"),
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
}).strict();
export type ProductTranslationServingContract = Readonly<z.infer<typeof productTranslationServingContractSchema>>;
export function productTranslationServingContractHash(value: ProductTranslationServingContract): string {
  return createHash("sha256").update(JSON.stringify(productTranslationServingContractSchema.parse(value))).digest("hex");
}
const configured = startupGatewayServingContracts("product-translate", productTranslationServingContractSchema);
/** 운영자가 readback 으로 검증해 ABCLLM_SERVING_CONTRACTS 에 넣은 계약만 연다. 없거나 틀리면 null(=deferred)이다. */
export function resolveProductTranslationServingContract(model: string): ProductTranslationServingContract | null { return configured.get(model) ?? null; }

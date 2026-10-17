import { createHash } from "node:crypto";
import { z } from "zod";

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
}).strict();
export type ProductTranslationServingContract = Readonly<z.infer<typeof productTranslationServingContractSchema>>;
export function productTranslationServingContractHash(value: ProductTranslationServingContract): string {
  return createHash("sha256").update(JSON.stringify(productTranslationServingContractSchema.parse(value))).digest("hex");
}
/** No bounded product-translation serving deployment is enabled. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- No deployment is enabled.
export function resolveProductTranslationServingContract(_model: string): ProductTranslationServingContract | null { return null; }

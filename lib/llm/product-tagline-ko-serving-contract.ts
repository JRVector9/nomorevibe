import { createHash } from "node:crypto";
import { z } from "zod";

const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
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
}).strict();
export type ProductTaglineKoServingContract = Readonly<z.infer<typeof productTaglineKoServingContractSchema>>;
export function productTaglineKoServingContractHash(value: ProductTaglineKoServingContract): string {
  return createHash("sha256").update(JSON.stringify(productTaglineKoServingContractSchema.parse(value))).digest("hex");
}
/** No bounded product-tagline-ko serving deployment is enabled. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- No deployment is enabled.
export function resolveProductTaglineKoServingContract(_model: string): ProductTaglineKoServingContract | null { return null; }

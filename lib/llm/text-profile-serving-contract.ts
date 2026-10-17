import { createHash } from "node:crypto";
import { z } from "zod";

const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
export const textProfileServingContractSchema = z.object({
  version: z.literal(1), protocol: z.literal("abcllm-raw-total-bound-v1"),
  routeId: z.literal("product-search-profile"), provider: z.literal("abcllm"),
  model: identity, responseModel: identity, deploymentRevision: identity,
  endpoint: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === "/v1/chat/completions";
  }), totalTokenBound: z.number().int().positive().safe(),
}).strict();
export type TextProfileServingContract = Readonly<z.infer<typeof textProfileServingContractSchema>>;
export function textProfileServingContractHash(value: TextProfileServingContract): string {
  return createHash("sha256").update(JSON.stringify(textProfileServingContractSchema.parse(value))).digest("hex");
}
/** Local code support is not evidence of a deployed bounded serving route. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- No deployment is enabled.
export function resolveTextProfileServingContract(_model: string): TextProfileServingContract | null { return null; }

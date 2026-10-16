import { createHash } from "node:crypto";
import { z } from "zod";

const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
export const reasonTranslationServingContractSchema = z.object({
  version: z.literal(1), protocol: z.literal("abcllm-reason-total-bound-v1"),
  routeId: z.literal("reason-translate"), provider: z.literal("abcllm"),
  model: identity, responseModel: identity, deploymentRevision: identity,
  endpoint: z.url().refine(value => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
        && !url.search && !url.hash && url.pathname === "/v1/chat/completions";
    } catch { return false; }
  }), totalTokenBound: z.number().int().positive().safe(),
}).strict();
export type ReasonTranslationServingContract = Readonly<z.infer<typeof reasonTranslationServingContractSchema>>;
export function reasonTranslationServingContractHash(value: ReasonTranslationServingContract): string {
  return createHash("sha256").update(JSON.stringify(reasonTranslationServingContractSchema.parse(value))).digest("hex");
}
/** The original non-raw wire has no enabled bounded serving deployment. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- No deployment is enabled.
export function resolveReasonTranslationServingContract(_model: string): ReasonTranslationServingContract | null { return null; }

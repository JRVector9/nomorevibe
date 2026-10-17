import { createHash } from "node:crypto";
import { z } from "zod";

const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
export const ai2GatewayServingContractSchema = z.object({
  version: z.literal(1), protocol: z.literal("abcllm-raw-total-bound-v1"),
  routeId: z.literal("second-review"), provider: z.literal("abcllm"),
  model: identity, responseModel: identity, deploymentRevision: identity,
  endpoint: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === "/v1/chat/completions";
  }),
  totalTokenBound: z.number().int().positive().safe(),
}).strict();
export type Ai2GatewayServingContract = Readonly<z.infer<typeof ai2GatewayServingContractSchema>>;

/** Shape/hash validation does not approve a deployment or issue transport authority. */
export function ai2GatewayServingContractHash(value: Ai2GatewayServingContract): string {
  return createHash("sha256").update(JSON.stringify(ai2GatewayServingContractSchema.parse(value))).digest("hex");
}

/** No serving deployment has yet supplied the required total-bound/terminal evidence. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- No model can enable the empty deployment allowlist.
export function resolveAi2GatewayServingContract(_model: string): Ai2GatewayServingContract | null {
  return null;
}

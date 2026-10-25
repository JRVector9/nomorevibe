import { createHash } from "node:crypto";
import { z } from "zod";
import { startupGatewayServingContracts } from "@/lib/llm/gateway-serving-contract-config";

const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
const tokenizerEndpoint = z.url().refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === "/tokenize";
});
const requestBudgetSchema = z.object({ requestTokenBound: z.literal(32_000), maxOutputTokens: z.literal(10_000),
  tokenizerEndpoint, tokenizerModel: identity }).strict();
const legacyAi2GatewayServingContractSchema = z.object({
  version: z.literal(1), protocol: z.literal("abcllm-raw-total-bound-v1"),
  routeId: z.literal("second-review"), provider: z.literal("abcllm"),
  model: identity, responseModel: identity, deploymentRevision: identity,
  endpoint: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === "/v1/chat/completions";
  }),
  totalTokenBound: z.number().int().positive().safe(),
  // Explicit read-back mapping from this raw gateway alias to its actual engine/tokenizer.
  // Absence preserves the historical contract hash and wire exactly.
  requestBudget: requestBudgetSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.requestBudget && value.totalTokenBound < value.requestBudget.requestTokenBound)
    context.addIssue({ code: "custom", message: "invalid_request_token_bound" });
});
const chatEndpoint = z.url().refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === "/v1/chat/completions";
});
export const ai2DirectServingContractSchema = z.object({
  version: z.literal(1), protocol: z.literal("ai2-direct-openai-chat-v1"),
  routeId: z.literal("second-review"), provider: z.literal("local-direct"),
  model: identity, responseModel: identity, deploymentRevision: identity,
  endpoint: chatEndpoint,
  tokenizerEndpoint, backendId: identity, physicalGroup: identity,
  // C is the read-back engine context limit. The smaller request policy never rewrites C.
  totalTokenBound: z.number().int().positive().safe(),
  requestTokenBound: z.literal(32_000), maxOutputTokens: z.literal(10_000),
}).strict().superRefine((value, context) => {
  const chat = new URL(value.endpoint), tokenizer = new URL(value.tokenizerEndpoint);
  if (tokenizer.origin !== chat.origin || tokenizer.pathname !== "/tokenize" || tokenizer.username
    || tokenizer.password || tokenizer.search || tokenizer.hash || value.totalTokenBound < value.requestTokenBound)
    context.addIssue({ code: "custom", message: "invalid_direct_tokenizer_contract" });
});
export const ai2GatewayServingContractSchema = z.discriminatedUnion("protocol", [
  legacyAi2GatewayServingContractSchema, ai2DirectServingContractSchema,
]);
export type Ai2GatewayServingContract = Readonly<z.infer<typeof ai2GatewayServingContractSchema>>;
export type Ai2DirectServingContract = Readonly<z.infer<typeof ai2DirectServingContractSchema>>;

/** Shape/hash validation does not approve a deployment or issue transport authority. */
export function ai2GatewayServingContractHash(value: Ai2GatewayServingContract): string {
  return createHash("sha256").update(JSON.stringify(ai2GatewayServingContractSchema.parse(value))).digest("hex");
}

const configured = startupGatewayServingContracts("second-review", legacyAi2GatewayServingContractSchema);
export function ai2DirectServingContractsFromConfig(raw: string | undefined): ReadonlyMap<string, Ai2DirectServingContract> {
  const none = new Map<string, Ai2DirectServingContract>();
  if (raw === undefined || Buffer.byteLength(raw, "utf8") > 16 * 1024) return none;
  try {
    const config = z.object({ version: z.literal(1), contracts: z.array(ai2DirectServingContractSchema).max(8) }).strict().parse(JSON.parse(raw));
    const contracts = new Map<string, Ai2DirectServingContract>();
    for (const contract of config.contracts) {
      if (contracts.has(contract.model)) return none;
      contracts.set(contract.model, Object.freeze(contract));
    }
    return contracts;
  } catch { return none; }
}
const directConfigured = ai2DirectServingContractsFromConfig(process.env.AI2_DIRECT_SERVING_CONTRACTS);
/** Read-back approved provider-specific startup contracts only; missing contracts defer without inference. */
export function resolveAi2GatewayServingContract(model: string, provider: string = "abcllm"): Ai2GatewayServingContract | null {
  if (provider !== "abcllm" && provider !== "local-direct") return null;
  return (provider === "local-direct" ? directConfigured : configured).get(model) ?? null;
}

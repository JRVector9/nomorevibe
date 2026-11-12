import { z } from "zod";
import { cliModelDispatchSchema } from "@/lib/llm/capacity";
import { cliTransportSchema } from "@/lib/llm/cli-serving-contract";
import { reviewOutcomeSchema, type ReviewInput, type ReviewSnapshot, type ReviewSource } from "@/lib/crawl/agent-review-contract";
import { cliHostHandleSchema, cliHostNotStartedResponseSchema } from "./cli-rpc-common";

export { CLI_HOST_RPC_DOMAIN, CLI_HOST_BODY_LIMIT, cliHostHandleSchema, cliHostNotStartedResponseSchema } from "./cli-rpc-common";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/);
const text = z.string().min(1).max(160).refine(value => !/[\p{Cc}]/u.test(value));
export const cliHostModelSchema = z.object({ id: model, label: z.string().min(1).max(240),
  variants: z.array(text).max(32), maxModelLen: z.number().int().positive().safe().nullable(), vision: z.boolean().optional() }).strict();
export const cliHostCatalogSchema = z.object({ version: z.literal(1), bootId: z.uuid(), cliVersion: z.string().min(1).max(80),
  observedAt: z.iso.datetime(), models: z.array(cliHostModelSchema).max(512) }).strict();
export type CliHostCatalog = z.infer<typeof cliHostCatalogSchema>;
export type CliHostHandle = z.infer<typeof cliHostHandleSchema>;
const object = (value: unknown): boolean => !!value && typeof value === "object" && !Array.isArray(value);
export const cliHostInputSchema = z.object({ snapshot: z.custom<ReviewSnapshot>(object), source: z.custom<ReviewSource>(object),
  inputHash: sha, policyHash: sha, sourceRevisionHash: sha, validUntil: z.iso.datetime() }).strict();
export const cliHostPrepareOptionsSchema = z.object({ connectionId: z.uuid(), routeId: z.enum(["crawl-agent-review", "second-review"]),
  provider: z.literal("opencode-cli"), model, timeoutMs: z.number().int().positive().safe().max(300_000), reasoningEffort: text.optional() }).strict();
export type CliHostPrepareOptions = z.infer<typeof cliHostPrepareOptionsSchema>;
export const cliHostResponseProbeDataSchema = z.object({ connectionId: z.uuid(), model: model,
  reasoningEffort: text.optional() }).strict();
export type CliHostResponseProbeData = z.infer<typeof cliHostResponseProbeDataSchema>;
export const cliHostResponseProbeErrorSchema = z.enum(['unavailable', 'busy', 'reasoning_effort_unsupported', 'model_unavailable', 'timeout', 'output_too_large', 'cli_error', 'invalid_output']);
export type CliHostResponseProbeError = z.infer<typeof cliHostResponseProbeErrorSchema>;
export const cliHostResponseProbeResponseSchema = z.object({ ok: z.boolean(), ms: z.number().int().nonnegative().safe(),
  error: cliHostResponseProbeErrorSchema.optional() }).strict()
  .refine(value => value.ok ? value.error === undefined : value.error !== undefined, { message: 'cli_host_response_probe_error_mismatch' });
export type CliHostResponseProbeResponse = z.infer<typeof cliHostResponseProbeResponseSchema>;
export const cliHostPreparedCallSchema = z.object({ kind: z.literal("prepared_cli"), routeId: z.enum(["crawl-agent-review", "second-review"]),
  provider: z.literal("opencode-cli"), model, inputHash: sha, transport: z.lazy(() => cliTransportSchema),
  totalTokenBound: z.number().int().positive().safe() }).strict();
export const cliHostPrepareResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepared"), handle: cliHostHandleSchema, call: cliHostPreparedCallSchema }).strict(),
  z.object({ kind: z.literal("unsupported"), reason: z.literal("provider_contract_unavailable") }).strict(),
]);
const identity = { handle: cliHostHandleSchema, requestId: z.uuid(), bindingHash: sha };
const usage = z.object({ inputTokens: z.number().int().nonnegative().safe().optional(), outputTokens: z.number().int().nonnegative().safe().optional(),
  costUsd: z.number().nonnegative().finite().optional() }).strict();
export const cliHostReviewResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), outcome: z.lazy(() => reviewOutcomeSchema), usage }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(["not_configured", "input_too_large", "timeout", "cancelled", "output_too_large", "missing_cli",
    "auth", "cli_error", "invalid_output", "max_turns", "budget", "rate_limited", "model_unavailable", "gateway_error"]),
  detail: z.string().max(2000).optional(), usage: usage.optional() }).strict(),
]);
const unknownResult = z.object({ ...identity, kind: z.literal("indeterminate"), reason: z.enum(["process_exit", "transport_unknown"]) }).strict();
export const cliHostRunResponseSchema = z.discriminatedUnion("kind", [
  z.object({ ...identity, kind: z.literal("settled"), terminalEvidenceHash: sha, result: cliHostReviewResultSchema }).strict(), unknownResult,
]);
export type CliHostSettlement = z.infer<typeof cliHostNotStartedResponseSchema> & { kind: "settled" };
export const cliHostReleaseResponseSchema = z.object({ released: z.boolean() }).strict();
// Ledger/domain modules also import the RPC adapter; resolve their schemas after module initialization.
const bound = z.object({ handle: cliHostHandleSchema, dispatch: z.lazy(() => cliModelDispatchSchema) }).strict();
export const cliHostRequestSchema = z.discriminatedUnion("action", [
  z.object({ version: z.literal(1), action: z.literal("catalog"), data: z.object({}).strict() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("prepare"), data: z.object({ input: cliHostInputSchema, options: cliHostPrepareOptionsSchema }).strict() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("run"), data: bound }).strict(),
  z.object({ version: z.literal(1), action: z.literal("notStarted"), data: bound }).strict(),
  z.object({ version: z.literal(1), action: z.literal("responseProbe"), data: cliHostResponseProbeDataSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("release"), data: z.object({ handle: cliHostHandleSchema }).strict() }).strict(),
]);
export type CliHostRequest = z.infer<typeof cliHostRequestSchema>;
export function encodeCliHostInput(input: ReviewInput): z.infer<typeof cliHostInputSchema> {
  return cliHostInputSchema.parse({ ...input, validUntil: input.validUntil.toISOString() });
}
export function decodeCliHostInput(input: z.infer<typeof cliHostInputSchema>): ReviewInput {
  const parsed = cliHostInputSchema.parse(input);
  return { ...parsed, validUntil: new Date(parsed.validUntil) };
}

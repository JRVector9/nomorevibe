import { createHash } from "node:crypto";
import { z } from "zod";
import { itemBindingSchema, itemBindingHash, itemOwnerSchema, type Ai2ItemBinding, type Ai1ItemBinding, type ItemOwner } from "@/lib/jobs/items/types";

const identity = (max: number) => z.string().min(1).max(max)
  .refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), "invalid_identity");
const positive = z.number().int().positive().safe();
const limit = positive.max(256);
const ttl = positive.max(3_600_000);
const sha64 = z.string().regex(/^[a-f0-9]{64}$/);
const capacityClass = z.enum(["first", "second", "background"]);
const capacityPool = z.enum(["reviewer", "text"]);
const limits = z.record(identity(120), limit).refine(value => {
  const count = Object.keys(value).length;
  return count >= 1 && count <= 64;
}, "invalid_limit_map_size");

export type ModelCapacityClass = z.infer<typeof capacityClass>;
export type ModelCapacityPool = z.infer<typeof capacityPool>;
export type ModelCapacityMode = "disabled" | "open" | "draining";
export type ModelCapacityState = "waiting" | "reserved" | "dispatched" | "indeterminate" | "withdrawn" | "settled";
export type ModelCapacityEventKind = "queued" | "reserved" | "dispatch_started" | "reservation_cancelled"
  | "reservation_expired" | "wait_expired" | "policy_changed" | "dispatch_indeterminate" | "dispatch_settled";
export type ModelCapacityIndeterminateReason = "transport_unknown" | "local_abort" | "process_exit" | "commit_unknown";
export type ModelCapacityEventReason = ModelCapacityIndeterminateReason;

export const modelCapacityOwnerSchema = z.object({ instanceId: identity(120), bootId: z.uuid() }).strict();
export type ModelCapacityOwner = Readonly<z.infer<typeof modelCapacityOwnerSchema>>;

export const modelCapacityRequestSchema = z.object({
  requestId: z.uuid(), workKey: identity(160), owner: modelCapacityOwnerSchema,
  class: capacityClass, pool: capacityPool, routeId: identity(120), provider: identity(60), model: identity(200),
}).strict().refine(value => value.class === "background" || value.pool === "reviewer", "invalid_class_pool");
export type ModelCapacityRequest = Readonly<z.infer<typeof modelCapacityRequestSchema>>;

export const modelCapacityRequestIdentitySchema = z.object(modelCapacityRequestSchema.shape)
  .omit({ requestId: true }).strict()
  .refine(value => value.class === "background" || value.pool === "reviewer", "invalid_class_pool");
export type ModelCapacityRequestIdentity = Readonly<z.infer<typeof modelCapacityRequestIdentitySchema>>;

export const modelCapacityPolicySchema = z.object({
  version: z.literal(1), globalLimit: limit, providerLimits: limits, groupLimits: limits,
  poolLimits: z.object({ reviewer: limit, text: limit }).strict(),
  weights: z.object({ first: positive.max(32), second: positive.max(32), background: positive.max(32) }).strict(),
  maxWaiting: positive.max(4096), queueTtlMs: ttl, reservationTtlMs: ttl,
  routes: z.array(z.object({ routeId: identity(120), provider: identity(60), model: identity(200),
    providerBudgetId: identity(120), groupId: identity(120) }).strict()).min(1).max(128),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, route] of value.routes.entries()) {
    const key = JSON.stringify([route.routeId, route.provider, route.model]);
    if (seen.has(key)) context.addIssue({ code: "custom", message: "duplicate_route", path: ["routes", index] });
    seen.add(key);
    if (!Object.hasOwn(value.providerLimits, route.providerBudgetId)) context.addIssue({
      code: "custom", message: "unknown_provider_budget", path: ["routes", index, "providerBudgetId"],
    });
    if (!Object.hasOwn(value.groupLimits, route.groupId)) context.addIssue({
      code: "custom", message: "unknown_capacity_group", path: ["routes", index, "groupId"],
    });
  }
});
type ParsedPolicy = z.infer<typeof modelCapacityPolicySchema>;
export type ModelCapacityPolicy = Readonly<Omit<ParsedPolicy, "routes"> & { routes: readonly ParsedPolicy["routes"][number][] }>;

const handleSchema = z.object({ requestId: z.uuid(), owner: modelCapacityOwnerSchema, token: z.uuid(),
  epoch: positive, revision: positive, policyHash: sha64 }).strict();
declare const reservationBrand: unique symbol;
declare const dispatchBrand: unique symbol;
type ModelCapacityHandle = Readonly<Omit<z.infer<typeof handleSchema>, "owner"> & { owner: ModelCapacityOwner }>;
export type ModelCapacityReservation = ModelCapacityHandle & { readonly [reservationBrand]: true };
export type ModelCapacityDispatch = ModelCapacityHandle & { readonly [dispatchBrand]: true };
/** These brands validate shape only. Every authority decision must compare the actual locked DB row. */
export const modelCapacityReservationSchema = handleSchema.transform(value => value as ModelCapacityReservation);
export const modelCapacityDispatchSchema = handleSchema.transform(value => value as ModelCapacityDispatch);

/** Shape validation only; locked rows and the native private terminal verifier supply authority. */
export const ai1DispatchBindingSchema = z.object({
  kind: z.literal("ai1_legacy_gateway"), version: z.literal(1), logicalWorkKey: identity(160),
  candidateId: positive, attemptId: positive, inputHash: sha64, sourceRevisionHash: sha64, reviewPolicyHash: sha64,
  promptVersion: identity(120), rulesVersion: identity(120), provider: z.literal("abcllm"), model: identity(200),
  routeId: z.literal("crawl-agent-review"), stageEpoch: positive, wireHash: sha64, servingContractHash: sha64,
  totalTokenBound: positive, chargedTokens: positive,
  job: z.object({ name: z.literal("crawl-agent-review"), token: z.uuid(), requestedVersion: z.number().int().nonnegative().safe() }).strict(),
}).strict().refine(value => value.logicalWorkKey === `ai1:${value.candidateId}`, "invalid_ai1_logical_work")
  .refine(value => value.chargedTokens === value.totalTokenBound, "invalid_ai1_charge");
type ParsedAi1Binding = z.infer<typeof ai1DispatchBindingSchema>;
export type Ai1DispatchBinding = Readonly<Omit<ParsedAi1Binding, "job"> & { job: Readonly<ParsedAi1Binding["job"]> }>;
export function ai1DispatchBindingHash(value: Ai1DispatchBinding): string {
  return createHash("sha256").update(JSON.stringify(canonical(ai1DispatchBindingSchema.parse(value)))).digest("hex");
}
export const ai1ModelDispatchSchema = handleSchema.extend({ binding: ai1DispatchBindingSchema, bindingHash: sha64 }).strict()
  .refine(value => value.bindingHash === createHash("sha256").update(JSON.stringify(canonical(value.binding))).digest("hex"),
    "invalid_ai1_binding_hash")
  .transform(value => value as Ai1ModelDispatch);
export type Ai1ModelDispatch = ModelCapacityDispatch & Readonly<{ binding: Ai1DispatchBinding; bindingHash: string }>;
export const ai1GatewayTerminalEvidenceSchema = z.object({
  version: z.literal(1), kind: z.literal("ai1_gateway_terminal"), dispatch: ai1ModelDispatchSchema,
  finishReason: z.enum(["stop", "length", "tool_calls", "function_call", "content_filter"]), responseHash: sha64,
  actualUsage: z.object({ inputTokens: z.number().int().nonnegative().safe(), outputTokens: z.number().int().nonnegative().safe(),
    totalTokens: z.number().int().nonnegative().safe() }).strict().nullable(),
  provenance: z.enum(["upstream_reported", "unknown"]),
}).strict().refine(value => value.actualUsage === null ? value.provenance === "unknown"
  : value.provenance === "upstream_reported"
    && Number.isSafeInteger(value.actualUsage.inputTokens + value.actualUsage.outputTokens)
    && value.actualUsage.inputTokens + value.actualUsage.outputTokens === value.actualUsage.totalTokens
    && value.actualUsage.totalTokens <= value.dispatch.binding.totalTokenBound, "invalid_ai1_terminal_usage");
export type Ai1GatewayTerminalEvidence = Readonly<z.infer<typeof ai1GatewayTerminalEvidenceSchema>>;
/** Fixed AI2 item shape only. Actual locked rows and the native verifier supply authority. */
export const ai2DispatchBindingSchema = z.object({
  kind: z.literal("ai2_item_gateway"), version: z.literal(1), logicalWorkKey: identity(160),
  review: itemBindingSchema.refine((value): value is Ai2ItemBinding => value.stage === "ai2", "invalid_ai2_review")
    .transform(value => value as Ai2ItemBinding),
  rowIdentityHash: sha64, failureCount: z.number().int().nonnegative().safe(), inputPolicyHash: sha64,
  item: z.object({ workKey: identity(160), owner: itemOwnerSchema, token: z.uuid(),
    stageEpoch: positive, itemEpoch: positive, bindingHash: sha64 }).strict(),
  routeId: z.literal("second-review"), provider: z.literal("abcllm"), model: identity(200),
  wireHash: sha64, servingContractHash: sha64, totalTokenBound: positive, chargedTokens: positive,
}).strict()
  .refine(value => value.logicalWorkKey === `ai2:${value.review.candidateId}:${value.review.vote}`, "invalid_ai2_logical_work")
  .refine(value => {
    const review = itemBindingSchema.safeParse(value.review);
    return review.success && review.data.stage === "ai2" && value.item.workKey === `ai2:${review.data.secondReviewId}`
      && value.item.bindingHash === itemBindingHash(review.data);
  }, "invalid_ai2_item_binding")
  .refine(value => value.review.reviewer.provider === value.provider && value.review.reviewer.model === value.model,
    "invalid_ai2_reviewer")
  .refine(value => value.chargedTokens === value.totalTokenBound, "invalid_ai2_charge");
type ParsedAi2Binding = z.infer<typeof ai2DispatchBindingSchema>;
export type Ai2DispatchBinding = Readonly<Omit<ParsedAi2Binding, "review" | "item"> & {
  review: Ai2ItemBinding; item: Readonly<Omit<ParsedAi2Binding["item"], "owner"> & { owner: ItemOwner }>;
}>;
export function ai2DispatchBindingHash(value: Ai2DispatchBinding): string {
  return createHash("sha256").update(JSON.stringify(canonical(ai2DispatchBindingSchema.parse(value)))).digest("hex");
}
export type Ai2ModelDispatch = ModelCapacityDispatch & Readonly<{ binding: Ai2DispatchBinding; bindingHash: string }>;
export const ai2ModelDispatchSchema = handleSchema.extend({ binding: ai2DispatchBindingSchema, bindingHash: sha64 }).strict()
  .refine(value => value.bindingHash === createHash("sha256").update(JSON.stringify(canonical(value.binding))).digest("hex"),
    "invalid_ai2_binding_hash")
  .refine(value => value.owner.instanceId === value.binding.item.owner.instanceId
    && value.owner.bootId === value.binding.item.owner.bootId, "invalid_ai2_dispatch_owner")
  .transform(value => value as Ai2ModelDispatch);
export const ai2GatewayTerminalEvidenceSchema = z.object({
  version: z.literal(1), kind: z.literal("ai2_gateway_terminal"), dispatch: ai2ModelDispatchSchema,
  finishReason: z.enum(["stop", "length", "tool_calls", "function_call", "content_filter"]), responseHash: sha64,
  actualUsage: z.object({ inputTokens: z.number().int().nonnegative().safe(), outputTokens: z.number().int().nonnegative().safe(),
    totalTokens: z.number().int().nonnegative().safe() }).strict().nullable(),
  provenance: z.enum(["upstream_reported", "unknown"]),
}).strict().refine(value => value.actualUsage === null ? value.provenance === "unknown"
  : value.provenance === "upstream_reported"
    && Number.isSafeInteger(value.actualUsage.inputTokens + value.actualUsage.outputTokens)
    && value.actualUsage.inputTokens + value.actualUsage.outputTokens === value.actualUsage.totalTokens
    && value.actualUsage.totalTokens <= value.dispatch.binding.totalTokenBound, "invalid_ai2_terminal_usage");
export type Ai2GatewayTerminalEvidence = Readonly<z.infer<typeof ai2GatewayTerminalEvidenceSchema>>;

/** Fixed AI1 item shape; only actual locked rows and the native verifier supply authority. */
export const ai1ItemDispatchBindingSchema = z.object({
  kind: z.literal("ai1_item_gateway"), version: z.literal(1), logicalWorkKey: identity(160), attemptId: positive,
  review: itemBindingSchema.refine((value): value is Ai1ItemBinding => value.stage === "ai1", "invalid_ai1_item_review")
    .transform(value => value as Ai1ItemBinding),
  item: z.object({ workKey: identity(160), owner: itemOwnerSchema, token: z.uuid(),
    stageEpoch: positive, itemEpoch: positive, bindingHash: sha64 }).strict(),
  routeId: z.literal("crawl-agent-review"), provider: z.literal("abcllm"), model: identity(200),
  wireHash: sha64, servingContractHash: sha64, totalTokenBound: positive, chargedTokens: positive,
}).strict()
  .refine(value => value.logicalWorkKey === `ai1:${value.review.candidateId}`, "invalid_ai1_item_logical_work")
  .refine(value => {
    const review = itemBindingSchema.safeParse(value.review);
    return review.success && review.data.stage === "ai1" && value.item.workKey === `ai1:${review.data.candidateId}`
      && value.item.bindingHash === itemBindingHash(review.data);
  }, "invalid_ai1_item_binding")
  .refine(value => value.review.reviewer.provider === value.provider && value.review.reviewer.model === value.model,
    "invalid_ai1_item_reviewer")
  .refine(value => value.chargedTokens === value.totalTokenBound, "invalid_ai1_item_charge");
type ParsedAi1ItemBinding = z.infer<typeof ai1ItemDispatchBindingSchema>;
export type Ai1ItemDispatchBinding = Readonly<Omit<ParsedAi1ItemBinding, "review" | "item"> & {
  review: Ai1ItemBinding; item: Readonly<Omit<ParsedAi1ItemBinding["item"], "owner"> & { owner: ItemOwner }>;
}>;
export function ai1ItemDispatchBindingHash(value: Ai1ItemDispatchBinding): string {
  return createHash("sha256").update(JSON.stringify(canonical(ai1ItemDispatchBindingSchema.parse(value)))).digest("hex");
}
export type Ai1ItemModelDispatch = ModelCapacityDispatch & Readonly<{ binding: Ai1ItemDispatchBinding; bindingHash: string }>;
export const ai1ItemModelDispatchSchema = handleSchema.extend({ binding: ai1ItemDispatchBindingSchema, bindingHash: sha64 }).strict()
  .refine(value => value.bindingHash === createHash("sha256").update(JSON.stringify(canonical(value.binding))).digest("hex"),
    "invalid_ai1_item_binding_hash")
  .refine(value => value.owner.instanceId === value.binding.item.owner.instanceId
    && value.owner.bootId === value.binding.item.owner.bootId, "invalid_ai1_item_dispatch_owner")
  .transform(value => value as Ai1ItemModelDispatch);
export const ai1ItemGatewayTerminalEvidenceSchema = z.object({
  version: z.literal(1), kind: z.literal("ai1_item_gateway_terminal"), dispatch: ai1ItemModelDispatchSchema,
  finishReason: z.enum(["stop", "length", "tool_calls", "function_call", "content_filter"]), responseHash: sha64,
  actualUsage: z.object({ inputTokens: z.number().int().nonnegative().safe(), outputTokens: z.number().int().nonnegative().safe(),
    totalTokens: z.number().int().nonnegative().safe() }).strict().nullable(),
  provenance: z.enum(["upstream_reported", "unknown"]),
}).strict().refine(value => value.actualUsage === null ? value.provenance === "unknown"
  : value.provenance === "upstream_reported"
    && Number.isSafeInteger(value.actualUsage.inputTokens + value.actualUsage.outputTokens)
    && value.actualUsage.inputTokens + value.actualUsage.outputTokens === value.actualUsage.totalTokens
    && value.actualUsage.totalTokens <= value.dispatch.binding.totalTokenBound, "invalid_ai1_item_terminal_usage");
export type Ai1ItemGatewayTerminalEvidence = Readonly<z.infer<typeof ai1ItemGatewayTerminalEvidenceSchema>>;

export type ModelSlotResult = { kind: "granted"; reservation: ModelCapacityReservation }
  | { kind: "deferred"; reason: "disabled" | "draining" | "unmapped" | "capacity" | "queue_full"
    | "policy_changed" | "withdrawn" | "dispatched" };

export function parseModelCapacityPolicy(value: unknown): ModelCapacityPolicy {
  return modelCapacityPolicySchema.parse(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

export function modelCapacityPolicyHash(policy: ModelCapacityPolicy): string {
  const parsed = parseModelCapacityPolicy(policy);
  const routes = parsed.routes.toSorted((a, b) => {
    for (const key of ["routeId", "provider", "model"] as const) {
      if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
    }
    return 0;
  });
  return createHash("sha256").update(JSON.stringify(canonical({ ...parsed, routes }))).digest("hex");
}

export function modelCapacityClassCycle(policy: ModelCapacityPolicy): ModelCapacityClass[] {
  const parsed = parseModelCapacityPolicy(policy);
  return capacityClass.options.flatMap(kind => Array<ModelCapacityClass>(parsed.weights[kind]).fill(kind));
}

/** Fixed search-profile snapshot; raw row hash includes every column and timestamp microsecond. */
export const textProfileInputSchema = z.object({ productId: positive, slug: identity(80), evidenceHash: sha64,
  profile: z.discriminatedUnion("kind", [z.object({ kind: z.literal("absent") }).strict(),
    z.object({ kind: z.literal("present"), rowIdentityHash: sha64,
      sourceRevision: z.number().int().nonnegative().safe(), attempts: z.number().int().nonnegative().safe() }).strict()]),
  model: identity(200),
}).strict();
export type TextProfileInput = Readonly<z.infer<typeof textProfileInputSchema>>;
export function textProfileInputHash(value: TextProfileInput): string {
  return createHash("sha256").update(JSON.stringify(canonical(textProfileInputSchema.parse(value)))).digest("hex");
}
export const textProfileDispatchBindingSchema = textProfileInputSchema.extend({
  kind: z.literal("text_profile_gateway"), version: z.literal(1), logicalWorkKey: identity(160), inputHash: sha64,
  provider: z.literal("abcllm"), routeId: z.literal("product-search-profile"), wireHash: sha64,
  servingContractHash: sha64, totalTokenBound: positive, chargedTokens: positive,
  job: z.object({ name: z.literal("product-search-profile"), token: z.uuid(), requestedVersion: z.number().int().nonnegative().safe() }).strict(),
  role: z.object({ role: z.literal("text"), instanceId: identity(120), bootId: z.uuid(), release: identity(120),
    kind: z.enum(["primary", "standby"]), epoch: positive,
    batch: z.discriminatedUnion("mode", [z.object({ mode: z.literal("legacy") }).strict(),
      z.object({ mode: z.literal("versioned"), host: z.enum(["m3", "mini", "oracle-osaka-smoke"]), batchEpoch: positive }).strict()]),
  }).strict(),
}).strict()
  .refine(value => value.logicalWorkKey === `text:profile:${value.productId}`, "invalid_text_profile_logical_work")
  .refine(value => {
    const input = textProfileInputSchema.safeParse({ productId: value.productId, slug: value.slug,
      evidenceHash: value.evidenceHash, profile: value.profile, model: value.model });
    return input.success && value.inputHash === textProfileInputHash(input.data);
  }, "invalid_text_profile_input_hash")
  .refine(value => value.chargedTokens === value.totalTokenBound, "invalid_text_profile_charge");
export type TextProfileDispatchBinding = Readonly<z.infer<typeof textProfileDispatchBindingSchema>>;
export function textProfileDispatchBindingHash(value: TextProfileDispatchBinding): string {
  return createHash("sha256").update(JSON.stringify(canonical(textProfileDispatchBindingSchema.parse(value)))).digest("hex");
}
export type TextProfileModelDispatch = ModelCapacityDispatch & Readonly<{ binding: TextProfileDispatchBinding; bindingHash: string }>;
export const textProfileModelDispatchSchema = handleSchema.extend({ binding: textProfileDispatchBindingSchema, bindingHash: sha64 }).strict()
  .refine(value => value.bindingHash === createHash("sha256").update(JSON.stringify(canonical(value.binding))).digest("hex"),
    "invalid_text_profile_binding_hash")
  .refine(value => value.owner.instanceId === value.binding.role.instanceId
    && value.owner.bootId === value.binding.role.bootId, "invalid_text_profile_dispatch_owner")
  .transform(value => value as TextProfileModelDispatch);
export const textProfileGatewayTerminalEvidenceSchema = z.object({
  version: z.literal(1), kind: z.literal("text_profile_gateway_terminal"), dispatch: textProfileModelDispatchSchema,
  finishReason: z.enum(["stop", "length", "tool_calls", "function_call", "content_filter"]), responseHash: sha64,
  actualUsage: z.object({ inputTokens: z.number().int().nonnegative().safe(), outputTokens: z.number().int().nonnegative().safe(),
    totalTokens: z.number().int().nonnegative().safe() }).strict().nullable(),
  provenance: z.enum(["upstream_reported", "unknown"]),
}).strict().refine(value => value.actualUsage === null ? value.provenance === "unknown"
  : value.provenance === "upstream_reported"
    && Number.isSafeInteger(value.actualUsage.inputTokens + value.actualUsage.outputTokens)
    && value.actualUsage.inputTokens + value.actualUsage.outputTokens === value.actualUsage.totalTokens
    && value.actualUsage.totalTokens <= value.dispatch.binding.totalTokenBound, "invalid_text_profile_terminal_usage");
export type TextProfileGatewayTerminalEvidence = Readonly<z.infer<typeof textProfileGatewayTerminalEvidenceSchema>>;

/** Fixed ordered reason members. Hash helpers validate shape, never DB ownership. */
export const reasonTranslationMemberSchema = z.object({ sourceHash: sha64,
  cache: z.discriminatedUnion("kind", [z.object({ kind: z.literal("absent") }).strict(),
    z.object({ kind: z.literal("present"), rowIdentityHash: sha64,
      attempts: z.number().int().nonnegative().safe() }).strict()]),
}).strict();
export type ReasonTranslationMember = Readonly<z.infer<typeof reasonTranslationMemberSchema>>;
const reasonMembersSchema = z.array(reasonTranslationMemberSchema).min(1).max(4)
  .refine(value => new Set(value.map(member => member.sourceHash)).size === value.length, "duplicate_reason_translation_member");
export const reasonTranslationInputSchema = z.object({ members: reasonMembersSchema,
  model: identity(200) }).strict();
export type ReasonTranslationInput = Readonly<Omit<z.infer<typeof reasonTranslationInputSchema>, "members"> & {
  members: readonly ReasonTranslationMember[] }>;
export function reasonTranslationMemberKeys(members: readonly ReasonTranslationMember[]): string[] {
  return reasonTranslationInputSchema.shape.members.parse(members).map(member => `ko:${member.sourceHash}`).sort();
}
export function reasonTranslationLogicalWorkKey(members: readonly ReasonTranslationMember[]): string {
  return `text:reason:ko:${createHash("sha256").update(JSON.stringify(reasonTranslationMemberKeys(members))).digest("hex")}`;
}
export function reasonTranslationInputHash(value: ReasonTranslationInput): string {
  const checked = reasonTranslationInputSchema.parse(value);
  return createHash("sha256").update(JSON.stringify(canonical({ ...checked,
    members: [...checked.members].sort((a, b) => a.sourceHash < b.sourceHash ? -1 : a.sourceHash > b.sourceHash ? 1 : 0) }))).digest("hex");
}
const reasonRoleIdentity = { instanceId: identity(120), bootId: z.uuid(), release: identity(120),
  kind: z.enum(["primary", "standby"]), epoch: positive };
export const reasonTranslationDispatchBindingSchema = reasonTranslationInputSchema.extend({
  kind: z.literal("reason_translation_gateway"), version: z.literal(1), logicalWorkKey: identity(160), inputHash: sha64,
  provider: z.literal("abcllm"), routeId: z.literal("reason-translate"), wireHash: sha64, servingContractHash: sha64,
  totalTokenBound: positive, chargedTokens: positive,
  job: z.object({ name: z.literal("reason-translate"), token: z.uuid(), requestedVersion: z.number().int().nonnegative().safe() }).strict(),
  role: z.discriminatedUnion("role", [z.object({ ...reasonRoleIdentity, role: z.literal("text"),
    batch: z.object({ mode: z.literal("legacy") }).strict() }).strict(),
    z.object({ ...reasonRoleIdentity, role: z.literal("translation"), batch: z.object({ mode: z.literal("versioned"),
      host: z.enum(["m3", "mini", "oracle-osaka-smoke"]), batchEpoch: positive }).strict() }).strict()]),
}).strict().refine(value => {
  const checked = reasonTranslationInputSchema.safeParse({ members: value.members, model: value.model });
  return checked.success && value.logicalWorkKey === reasonTranslationLogicalWorkKey(checked.data.members)
    && value.inputHash === reasonTranslationInputHash(checked.data) && value.chargedTokens === value.totalTokenBound;
}, "invalid_reason_translation_binding");
export type ReasonTranslationDispatchBinding = Readonly<Omit<z.infer<typeof reasonTranslationDispatchBindingSchema>, "members"> & {
  members: readonly ReasonTranslationMember[] }>;
export function reasonTranslationDispatchBindingHash(value: ReasonTranslationDispatchBinding): string {
  return createHash("sha256").update(JSON.stringify(canonical(reasonTranslationDispatchBindingSchema.parse(value)))).digest("hex");
}
export type ReasonTranslationModelDispatch = ModelCapacityDispatch & Readonly<{ binding: ReasonTranslationDispatchBinding; bindingHash: string }>;
export const reasonTranslationModelDispatchSchema = handleSchema.extend({ binding: reasonTranslationDispatchBindingSchema,
  bindingHash: sha64 }).strict()
  .refine(value => value.bindingHash === createHash("sha256").update(JSON.stringify(canonical(value.binding))).digest("hex"),
    "invalid_reason_translation_binding_hash")
  .refine(value => value.owner.instanceId === value.binding.role.instanceId && value.owner.bootId === value.binding.role.bootId,
    "invalid_reason_translation_dispatch_owner")
  .transform(value => value as unknown as ReasonTranslationModelDispatch);
export const reasonTranslationGatewayTerminalEvidenceSchema = z.object({ version: z.literal(1),
  kind: z.literal("reason_translation_gateway_terminal"), dispatch: reasonTranslationModelDispatchSchema,
  finishReason: z.enum(["stop", "length", "tool_calls", "function_call", "content_filter"]), responseHash: sha64,
  actualUsage: z.object({ inputTokens: z.number().int().nonnegative().safe(), outputTokens: z.number().int().nonnegative().safe(),
    totalTokens: z.number().int().nonnegative().safe() }).strict().nullable(),
  provenance: z.enum(["upstream_reported", "unknown"]),
}).strict().refine(value => value.actualUsage === null ? value.provenance === "unknown"
  : value.provenance === "upstream_reported"
    && Number.isSafeInteger(value.actualUsage.inputTokens + value.actualUsage.outputTokens)
    && value.actualUsage.inputTokens + value.actualUsage.outputTokens === value.actualUsage.totalTokens
    && value.actualUsage.totalTokens <= value.dispatch.binding.totalTokenBound, "invalid_reason_translation_terminal_usage");
export type ReasonTranslationGatewayTerminalEvidence = Readonly<z.infer<typeof reasonTranslationGatewayTerminalEvidenceSchema>>;

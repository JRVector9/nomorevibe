import { createHash } from "node:crypto";
import { z } from "zod";

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
export type ModelCapacityState = "waiting" | "reserved" | "dispatched" | "indeterminate" | "withdrawn";
export type ModelCapacityEventKind = "queued" | "reserved" | "dispatch_started" | "reservation_cancelled"
  | "reservation_expired" | "wait_expired" | "policy_changed" | "dispatch_indeterminate";
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

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { providerBoundaryCanonicalHash, providerBoundaryPlanV1Schema } from "./provider-boundary-contract";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/);
const at = providerBoundaryPlanV1Schema.shape.createdAt;
const positive = z.number().int().positive().safe();

const roles = ["owner", "gateway-m3", "gateway-mini", "relay", "provider"] as const, kinds = ["container", "systemd", "launchd", "listener"] as const;
type Hop = Readonly<{ role: typeof roles[number]; host: string; kind: typeof kinds[number]; service: string }>;
/**
 * Every process that could still hold an abandoned call: the owner, both gateways and the provider processes behind its budget.
 * A request is released only when each of them is a single instance that started after the dispatch.
 * The SQL copy in drizzle/0145 is the authority; a topology change needs a new migration, never a runtime value.
 */
export const REPLACED_PATH_OWNERS: Readonly<Record<string, Hop>> = {
  "m3-reviewer": { role: "owner", host: "m3ultra", kind: "container", service: "app-copy-primary-hard-drive-b5fhzd" },
  "m3-text": { role: "owner", host: "m3ultra", kind: "container", service: "nomorevibe-text-m3-ebmybu" },
};
const gateways: readonly Hop[] = [
  { role: "gateway-m3", host: "m3ultra", kind: "container", service: "app-reboot-optical-matrix-3bl2a4" },
  { role: "gateway-mini", host: "9mini", kind: "container", service: "app-hack-optical-monitor-v1ioak" },
];
export const REPLACED_PATH_PROVIDERS: Readonly<Record<string, readonly Hop[]>> = {
  "abcllm-supa": [...gateways, { role: "provider", host: "supa", kind: "systemd", service: "vllm.service" }],
  "abcllm-m3-mlx": [...gateways, { role: "provider", host: "m3ultra", kind: "launchd", service: "gui/501/com.jr.deepseek" }],
  "abcllm-m1-qwen": [...gateways, { role: "relay", host: "m1studio", kind: "launchd", service: "system/bot.brut.nmv-llm-relay" },
    { role: "provider", host: "m1studio", kind: "listener", service: "tcp:127.0.0.1:8000" }],
};
export function replacedPathRequiredHops(ownerInstanceId: string, providerBudgetId: string): readonly Hop[] | null {
  const owner = REPLACED_PATH_OWNERS[ownerInstanceId], rest = REPLACED_PATH_PROVIDERS[providerBudgetId];
  return Object.hasOwn(REPLACED_PATH_OWNERS, ownerInstanceId) && Object.hasOwn(REPLACED_PATH_PROVIDERS, providerBudgetId) ? [owner, ...rest] : null;
}

export const replacedPathPlanSchema = z.object({ version: z.literal(1), kind: z.literal("replaced_path_boundary_plan"),
  createdAt: at, reviewReference: z.string().min(1).max(400),
  request: providerBoundaryPlanV1Schema.shape.request.extend({ rowHash: sha, routeId: id, provider: id, model: z.string().min(1).max(200) }),
  control: providerBoundaryPlanV1Schema.shape.control,
  writer: z.object({ lineageId: z.uuid(), writerEpoch: positive }).strict(),
}).strict();
/** One operator readback per process: the current incarnation, when it started, and that no second instance exists. */
export const replacedPathHopSchema = z.object({ role: z.enum(roles), host: id, kind: z.enum(kinds), service: id, incarnationId: id, startedAt: at, observedAt: at,
  singleInstance: z.literal(true), artifactHash: sha }).strict();
export const replacedPathReceiptSchema = z.object({ version: z.literal(1), kind: z.literal("replaced_path_boundary_receipt"),
  planHash: sha, observedAt: at, hops: z.array(replacedPathHopSchema).min(2).max(8) }).strict();
export const replacedPathEvidenceShape = z.object({ version: z.literal(1), kind: z.literal("replaced_path_boundary_exit"),
  requestId: z.uuid(), owner: providerBoundaryPlanV1Schema.shape.request.shape.owner,
  fromState: z.literal("indeterminate"), dispatchAt: at, bindingHash: sha, notBefore: at, evaluatedAt: at,
  operator: z.string().min(1).max(120), reference: z.string().min(1).max(400),
  plan: replacedPathPlanSchema, receipt: replacedPathReceiptSchema,
}).strict();
export type ReplacedPathPlan = z.infer<typeof replacedPathPlanSchema>;
export type ReplacedPathReceipt = z.infer<typeof replacedPathReceiptSchema>;
export type ReplacedPathHop = z.infer<typeof replacedPathHopSchema>;
/** The plan pins the live row and DRAIN, so it is short-lived. A replacement, once observed, stays true; its readback may precede the plan. */
export const REPLACED_PATH_PLAN_MAX_AGE_MS = 60 * 60_000;
export const REPLACED_PATH_RECEIPT_MAX_AGE_MS = 24 * 60 * 60_000;
export function replacedPathPlanHash(plan: ReplacedPathPlan) { return providerBoundaryCanonicalHash(plan); }

/** Hops must be exactly the registered path, in order, each a single instance that started after the dispatch. */
export function validReplacedPathHops(plan: ReplacedPathPlan, receipt: ReplacedPathReceipt): boolean {
  const q = plan.request, required = replacedPathRequiredHops(q.owner.instanceId, q.providerBudgetId), ms = Date.parse;
  return !!required && receipt.hops.length === required.length
    && receipt.hops.every((hop, i) => isDeepStrictEqual({ role: hop.role, host: hop.host, kind: hop.kind, service: hop.service }, required[i])
      && ms(hop.startedAt) > ms(q.dispatchAt) && ms(hop.startedAt) <= ms(hop.observedAt) && ms(hop.observedAt) <= ms(receipt.observedAt))
    && new Set(receipt.hops.map(hop => `${hop.host}\n${hop.incarnationId}`)).size === receipt.hops.length;
}
export function validReplacedPathEvidence(e: z.infer<typeof replacedPathEvidenceShape>): boolean {
  const p = e.plan, q = p.request, r = e.receipt, ms = Date.parse, now = ms(e.evaluatedAt);
  return e.requestId === q.requestId && isDeepStrictEqual(e.owner, q.owner) && e.dispatchAt === q.dispatchAt && e.bindingHash === q.bindingHash
    && e.reference === p.reviewReference && e.notBefore === r.observedAt && r.planHash === replacedPathPlanHash(p)
    && ms(p.control.updatedAt) <= ms(p.createdAt) && ms(q.dispatchAt) <= ms(p.createdAt) && ms(p.createdAt) <= now && ms(r.observedAt) <= now
    && now - ms(p.createdAt) <= REPLACED_PATH_PLAN_MAX_AGE_MS && now - ms(r.observedAt) <= REPLACED_PATH_RECEIPT_MAX_AGE_MS
    && validReplacedPathHops(p, r);
}
export const replacedPathEvidenceSchema = replacedPathEvidenceShape.refine(validReplacedPathEvidence, "invalid_replaced_path_boundary");
export const replacedPathArtifactHashes = (receipt: ReplacedPathReceipt) => [...new Set(receipt.hops.map(hop => hop.artifactHash))];
export const replacedPathDigest = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");

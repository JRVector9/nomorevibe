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
 * - owner: replaced (a single instance started after the dispatch). Only it holds the token and could dispatch again.
 * - gateway/relay: replaced, or absent (no process). A pass-through could otherwise retry the old call.
 * - provider: replaced, or idle (zero running and waiting requests) observed after every hop above it was replaced or absent:
 *   nothing upstream can resend, so an idle engine is not running the old call.
 * The SQL copies are the authority — drizzle/0145 (owners and the first providers) and drizzle/0150 (current providers); a topology
 * change needs a new migration, never a runtime value.
 */
export const REPLACED_PATH_OWNERS: Readonly<Record<string, Hop>> = {
  "m3-reviewer": { role: "owner", host: "m3ultra", kind: "container", service: "app-copy-primary-hard-drive-b5fhzd" },
  "m3-text": { role: "owner", host: "m3ultra", kind: "container", service: "nomorevibe-text-m3-ebmybu" },
};
const gateways: readonly Hop[] = [
  { role: "gateway-m3", host: "m3ultra", kind: "container", service: "app-reboot-optical-matrix-3bl2a4" },
  { role: "gateway-mini", host: "9mini", kind: "container", service: "app-hack-optical-monitor-v1ioak" },
];
const providers0145: Readonly<Record<string, readonly Hop[]>> = {
  "abcllm-supa": [...gateways, { role: "provider", host: "supa", kind: "systemd", service: "vllm.service" }],
  "abcllm-m3-mlx": [...gateways, { role: "provider", host: "m3ultra", kind: "launchd", service: "gui/501/com.jr.deepseek" }],
  "abcllm-m1-qwen": [...gateways, { role: "relay", host: "m1studio", kind: "launchd", service: "system/bot.brut.nmv-llm-relay" },
    { role: "provider", host: "m1studio", kind: "listener", service: "tcp:127.0.0.1:8000" }],
};
/** The providers drizzle/0145 applied — frozen, since that migration stays byte-identical. */
export const REPLACED_PATH_PROVIDERS_0145 = providers0145;
/** Current providers (drizzle/0150): 'supa-direct' is the capacity rev12 alias budget (2026-10-30) of the same Supa vLLM path. */
export const REPLACED_PATH_PROVIDERS: Readonly<Record<string, readonly Hop[]>> = { ...providers0145, "supa-direct": providers0145["abcllm-supa"] };
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
export const replacedPathHopSchema = z.object({ role: z.enum(roles), host: id, kind: z.enum(kinds), service: id,
  mode: z.enum(["replaced", "idle", "absent"]), incarnationId: id, startedAt: at.nullable(), observedAt: at,
  singleInstance: z.literal(true), artifactHash: sha }).strict();
/** Per-hop readback options that are not part of the topology authority: how to read an engine's idle counters, and who may be absent. */
export const REPLACED_PATH_PROBES: Readonly<Record<string, { idle?: { type: "vllm-metrics"; port: number } | { type: "omlx-status"; settings: string }; allowAbsent?: true }>> = {
  "supa\nvllm.service": { idle: { type: "vllm-metrics", port: 8000 } },
  "m3ultra\ngui/501/com.jr.deepseek": { idle: { type: "omlx-status", settings: "/Users/jr/deepseek-serve/state/settings.json" } },
  "m3ultra\napp-reboot-optical-matrix-3bl2a4": { allowAbsent: true }, "9mini\napp-hack-optical-monitor-v1ioak": { allowAbsent: true },
  "m1studio\nsystem/bot.brut.nmv-llm-relay": { allowAbsent: true },
};
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

/** When the upstream hops last could have held the call: a replacement's start, or an absence's observation. */
export function replacedPathUpstreamCutoff(hops: readonly ReplacedPathHop[]): number {
  return Math.max(...hops.filter(hop => hop.role !== "provider").map(hop => Date.parse(hop.mode === "absent" ? hop.observedAt : hop.startedAt ?? "")));
}
/** Hops must be exactly the registered path, in order, each in a mode its role allows (see the registry comment). */
export function validReplacedPathHops(plan: ReplacedPathPlan, receipt: ReplacedPathReceipt): boolean {
  const q = plan.request, required = replacedPathRequiredHops(q.owner.instanceId, q.providerBudgetId), ms = Date.parse;
  const cutoff = replacedPathUpstreamCutoff(receipt.hops);
  const modeValid = (hop: ReplacedPathHop) => hop.mode === "replaced" ? hop.startedAt !== null && ms(hop.startedAt) > ms(q.dispatchAt) && ms(hop.startedAt) <= ms(hop.observedAt)
    : hop.mode === "idle" ? hop.role === "provider" && hop.startedAt !== null && ms(hop.startedAt) <= ms(hop.observedAt) && ms(hop.observedAt) > cutoff
      // An absence proves nothing about a call dispatched after it was observed.
      : hop.role !== "owner" && hop.role !== "provider" && hop.startedAt === null && hop.incarnationId === "absent" && ms(hop.observedAt) > ms(q.dispatchAt);
  const present = receipt.hops.filter(hop => hop.mode !== "absent");
  return !!required && receipt.hops.length === required.length && Number.isFinite(cutoff)
    && receipt.hops.every((hop, i) => isDeepStrictEqual({ role: hop.role, host: hop.host, kind: hop.kind, service: hop.service }, required[i])
      && modeValid(hop) && ms(hop.observedAt) <= ms(receipt.observedAt))
    && new Set(present.map(hop => `${hop.host}\n${hop.incarnationId}`)).size === present.length;
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

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const id = (max = 200) => z.string().min(1).max(max).refine(v => v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v));
const sha = z.string().regex(/^[a-f0-9]{64}$/), positive = z.number().int().positive().safe();
const at = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  .refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const databaseAt = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/)
  .refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === `${v.slice(0, 23)}Z`);
const linuxBoundaryProcessIdentitySchema = z.object({ host: id(120), hostBootId: z.uuid(), kind: z.enum(["container", "systemd"]),
  service: id(), serviceRevision: id(), incarnationId: id(), startedAt: at, pid: positive.min(2),
  startTicks: z.string().regex(/^[1-9][0-9]*$/), pidNamespace: z.string().regex(/^[1-9][0-9]*$/), cgroup: id(500) }).strict();
const launchdBootId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const launchdIdentitySchema = z.object({ host: id(120), hostBootId: launchdBootId, kind: z.literal("launchd"),
  service: id(), serviceRevision: id(), incarnationId: id(), startedAt: at, pid: positive.min(2),
  startSec: z.string().regex(/^[1-9][0-9]*$/), startUsec: z.number().int().min(0).max(999999),
  uid: z.number().int().nonnegative().safe(), ppid: positive, pgid: positive.min(2), sid: positive,
  domain: z.string().regex(/^(?:system|(?:gui|user)\/[0-9]+)$/), label: id(), servingRevision: id(),
  plistSha256: sha, entrySha256: sha, topologyProofSha256: sha, inferenceScope: z.literal("in_process_threads_only"),
  knownDescendantPids: z.array(positive.min(2)).max(4096), listenerPort: positive.max(65535),
}).strict().refine(p => p.service === `${p.domain}/${p.label}` && (p.domain === "system" || p.domain === `gui/${p.uid}` || p.domain === `user/${p.uid}`)
  && Number.isSafeInteger(Number(p.startSec)) && Date.parse(p.startedAt) === Number(p.startSec) * 1000 + Math.floor(p.startUsec / 1000)
  && p.pgid === p.pid && new Set(p.knownDescendantPids).size === p.knownDescendantPids.length && !p.knownDescendantPids.includes(p.pid), "launchd_process_identity");
export const boundaryProcessIdentitySchema = z.union([linuxBoundaryProcessIdentitySchema, launchdIdentitySchema]);
export const providerBoundaryPlanSchema = z.object({ version: z.literal(1), kind: z.literal("provider_boundary_plan"), createdAt: at,
  request: z.object({ requestId: z.uuid(), owner: z.object({ instanceId: id(120), bootId: z.uuid() }).strict(), state: z.literal("indeterminate"),
    tokenHash: sha, epoch: positive, revision: positive, policyHash: sha, bindingHash: sha, dispatchAt: at,
    providerBudgetId: id(120), groupId: id(120), servingContractHash: sha }).strict(),
  control: z.object({ mode: z.literal("draining"), epoch: positive, revision: positive, policyHash: sha, updatedAt: databaseAt }).strict(),
  owner: linuxBoundaryProcessIdentitySchema, gateways: z.array(linuxBoundaryProcessIdentitySchema).length(2), provider: boundaryProcessIdentitySchema,
  beforeArtifactHash: sha,
}).strict().refine(p => p.owner.kind === "container" && p.gateways.every(g => g.kind === "container") && ["systemd", "launchd"].includes(p.provider.kind)
  && p.gateways[0].host !== p.gateways[1].host && new Set([p.owner, ...p.gateways, p.provider].map(x => `${x.host}:${x.incarnationId}`)).size === 4
  && p.createdAt >= p.request.dispatchAt && p.control.updatedAt <= p.createdAt
  && [p.owner, ...p.gateways, p.provider].every(x => x.startedAt <= p.request.dispatchAt), "boundary_plan_identity");
export type ProviderBoundaryPlan = z.infer<typeof providerBoundaryPlanSchema>;
/** New boundary-only ASCII key order. Never changes historical reviewHash identities. */
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`
    : JSON.stringify(value);
/** Only strict boundary plan/evidence JSON callers use this hash. A hash binds bytes, not physical authority. */
export const providerBoundaryCanonicalHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const providerBoundaryPlanHash = (value: unknown) => providerBoundaryCanonicalHash(providerBoundaryPlanSchema.parse(value));
const exitBase = { identity: linuxBoundaryProcessIdentitySchema, observedAt: at, mainPid: z.literal(0), oldPidAbsent: z.literal(true),
  serviceStopped: z.literal(true), replacements: z.literal(0), autoRestartBlocked: z.literal(true), artifactHash: sha };
const linuxExitObservationSchema = z.discriminatedUnion("method", [
  z.object({ ...exitBase, method: z.enum(["container_and_cgroup_empty", "systemd_and_cgroup_empty"]),
    cgroupPopulated: z.literal(false), cgroupPids: z.array(z.never()).length(0) }).strict(),
  // Linux pid_namespaces(7): when namespace PID1 exits, all processes are killed and no new process can enter it.
  // This is a separate observed proof. It never fabricates a cgroup inspection on Docker Desktop/OrbStack.
  z.object({ ...exitBase, method: z.literal("private_pid_namespace_end"), pidMode: z.enum(["", "private"]), initPid: z.literal(1),
    initNamespace: id(), selfNamespace: id(), waitExitCode: z.number().int().min(0).max(255), containerStatus: z.enum(["exited", "removed"]), running: z.literal(false) }).strict(),
]).refine(o => o.observedAt >= o.identity.startedAt && (o.method === "private_pid_namespace_end"
  ? o.identity.kind === "container" && o.initNamespace === o.identity.pidNamespace && o.selfNamespace === o.identity.pidNamespace
  : (o.identity.kind === "container") === (o.method === "container_and_cgroup_empty")), "boundary_exit_method");
// These are privileged observed facts, not a claim that JSON or a SHA proves exit.
const launchdExitObservationSchema = z.object({ ...exitBase, identity: launchdIdentitySchema, method: z.literal("launchd_process_group_empty"), observedHostBootId: launchdBootId,
  launchdDisabled: z.literal(true), launchdUnloaded: z.literal(true), oldPidESRCH: z.literal(true), processGroupESRCH: z.literal(true),
  allKnownDescendantsESRCH: z.literal(true), replacementPids: z.array(z.never()).length(0), ownedListeners: z.array(z.never()).length(0),
}).strict().refine(o => o.observedAt >= o.identity.startedAt && o.observedHostBootId === o.identity.hostBootId, "launchd_exit_identity");
export const boundaryExitObservationSchema = z.union([linuxExitObservationSchema, launchdExitObservationSchema]);
export const providerBoundaryReceiptSchema = z.object({ version: z.literal(1), kind: z.literal("provider_boundary_receipt"), planHash: sha,
  owner: linuxExitObservationSchema, gateways: z.array(linuxExitObservationSchema).length(2), provider: boundaryExitObservationSchema }).strict();
export type ProviderBoundaryReceipt = z.infer<typeof providerBoundaryReceiptSchema>;

/** Privileged operator observations: hashes bind reviewed raw artifacts; they do not prove physical exit by themselves. */
export function validateProviderBoundary(plan: ProviderBoundaryPlan, receipt: ProviderBoundaryReceipt, evaluatedAt: string): boolean {
  const now = Date.parse(evaluatedAt);
  if (!at.safeParse(evaluatedAt).success || receipt.planHash !== providerBoundaryPlanHash(plan)
    || now - Date.parse(plan.createdAt) > 30 * 60_000 || now < Date.parse(plan.createdAt)
    || !isDeepStrictEqual(receipt.owner.identity, plan.owner) || !isDeepStrictEqual(receipt.provider.identity, plan.provider)
    || receipt.gateways.some((x, i) => !isDeepStrictEqual(x.identity, plan.gateways[i]))) return false;
  return receipt.owner.observedAt >= plan.createdAt && receipt.gateways.every(x => x.observedAt >= receipt.owner.observedAt)
    && receipt.gateways.every(x => x.observedAt <= receipt.provider.observedAt) && receipt.provider.observedAt <= evaluatedAt
    && now - Date.parse(receipt.provider.observedAt) <= 5 * 60_000;
}

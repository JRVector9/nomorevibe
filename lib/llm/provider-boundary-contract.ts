import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { localModelContractHash, localModelServingContractSchema } from "./local-model-serving-contract";
import { bootInterval, bootMicroseconds, bootProviderIdentitySchema, bootWitnessSchema, bootLocalEndSchema, bootOwnerAssociationSchema, bootTransportSchema, validBootWitness } from "./provider-boot-boundary";

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
export const providerBoundaryPlanV1Schema = z.object({ version: z.literal(1), kind: z.literal("provider_boundary_plan"), createdAt: at,
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
export const originalBoundaryOwnerSchema = z.object({ kind: z.literal("durable_process_group_exit"), instanceId: id(120), bootId: z.uuid().regex(/^[a-f0-9-]+$/),
  openedEventId: positive, groups: z.array(z.object({ seq: positive.max(2147483647), pid: positive.min(2).max(2147483647), runIdHash: sha,
    spawnIntentEventId: positive, spawnedEventId: positive, exitEventId: positive }).strict()).min(1).max(128),
  localEndEventId: positive, localEndEvidenceHash: sha, artifactHash: sha }).strict()
  .refine(o => new Set(o.groups.map(g => g.seq)).size === o.groups.length
    && new Set([o.openedEventId, ...o.groups.flatMap(g => [g.spawnIntentEventId, g.spawnedEventId, g.exitEventId])]).size === 1 + 3 * o.groups.length, "historical_owner_event_identity");
export const providerBoundaryPlanV2Schema = z.object({ version: z.literal(2), kind: z.literal("provider_boundary_plan"), createdAt: at,
  request: providerBoundaryPlanV1Schema.shape.request, control: providerBoundaryPlanV1Schema.shape.control,
  originalOwner: originalBoundaryOwnerSchema, currentIngressOwner: linuxBoundaryProcessIdentitySchema,
  gateways: z.array(linuxBoundaryProcessIdentitySchema).length(2), provider: launchdIdentitySchema, beforeArtifactHash: sha,
}).strict().refine(p => p.originalOwner.instanceId === p.request.owner.instanceId && p.originalOwner.bootId === p.request.owner.bootId
  && p.currentIngressOwner.kind === "container" && p.currentIngressOwner.startedAt <= p.createdAt && p.gateways.every(g => g.kind === "container" && g.startedAt <= p.request.dispatchAt)
  && p.provider.startedAt <= p.request.dispatchAt && p.gateways[0].host !== p.gateways[1].host
  && new Set([p.currentIngressOwner, ...p.gateways, p.provider].map(x => `${x.host}:${x.incarnationId}`)).size === 4
  && p.createdAt >= p.request.dispatchAt && p.control.updatedAt <= p.createdAt, "historical_boundary_plan_identity");
const providerBoundaryPlanV3Base = z.object({ version:z.literal(3),kind:z.literal("provider_boundary_plan"),createdAt:at,
  request:providerBoundaryPlanV1Schema.shape.request,control:providerBoundaryPlanV1Schema.shape.control,owner:linuxBoundaryProcessIdentitySchema,
  gateways:z.array(z.never()).length(0),provider:bootProviderIdentitySchema,servingContract:localModelServingContractSchema,
  transport:bootTransportSchema,ownerAssociation:bootOwnerAssociationSchema,localEnd:bootLocalEndSchema,bootWitness:bootWitnessSchema,beforeArtifactHash:sha,
}).strict();
export const providerBoundaryPlanV3Schema=providerBoundaryPlanV3Base.refine(p=>{
  if(!providerBoundaryPlanV3Base.safeParse(p).success)return false;
  const b=bootInterval(p.bootWitness),provider=p.provider,contract=p.servingContract;
  return p.owner.kind==="container"&&p.owner.startedAt<=p.request.dispatchAt&&p.createdAt>=p.request.dispatchAt&&bootMicroseconds(p.control.updatedAt)<=bootMicroseconds(p.createdAt)
    &&p.ownerAssociation.instanceId===p.request.owner.instanceId&&p.ownerAssociation.bootId===p.request.owner.bootId
    &&contract.endpoint===`http://${provider.endpointAddress}:${provider.endpointPort}/v1/chat/completions`
    &&contract.physicalGroup===p.request.groupId&&contract.backendId===p.request.providerBudgetId&&localModelContractHash(contract)===p.request.servingContractHash
    &&validBootWitness(p.bootWitness,provider.currentBootId,p.createdAt)
    &&bootMicroseconds(p.request.dispatchAt)<b.lower&&bootMicroseconds(p.localEnd.endedAt)<b.lower
    &&bootMicroseconds(p.localEnd.endedAt)>=bootMicroseconds(p.request.dispatchAt)
    &&bootMicroseconds(provider.oldJournal.firstAt)<=bootMicroseconds(p.request.dispatchAt)
    &&bootMicroseconds(provider.oldJournal.lastAt)<b.upper&&bootMicroseconds(provider.currentJournal.firstAt)>=b.lower
    &&bootMicroseconds(provider.currentJournal.firstAt)<=bootMicroseconds(p.createdAt);
},"direct_provider_boot_boundary");
export const providerBoundaryPlanSchema = z.discriminatedUnion("version", [providerBoundaryPlanV1Schema, providerBoundaryPlanV2Schema,providerBoundaryPlanV3Schema]);
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
export const providerBoundaryReceiptV1Schema = z.object({ version: z.literal(1), kind: z.literal("provider_boundary_receipt"), planHash: sha,
  owner: linuxExitObservationSchema, gateways: z.array(linuxExitObservationSchema).length(2), provider: boundaryExitObservationSchema }).strict();
export const providerBoundaryReceiptV2Schema = z.object({ version: z.literal(2), kind: z.literal("provider_boundary_receipt"), planHash: sha,
  originalOwnerProofHash: sha, currentIngressOwner: linuxExitObservationSchema,
  gateways: z.array(linuxExitObservationSchema).length(2), provider: launchdExitObservationSchema }).strict();
export const providerBoundaryReceiptV3Schema=z.object({version:z.literal(3),kind:z.literal("provider_boundary_receipt"),planHash:sha,
 owner:linuxExitObservationSchema,gateways:z.array(z.never()).length(0),provider:z.object({identity:bootProviderIdentitySchema,observedAt:at,
 bootWitness:bootWitnessSchema,artifactHash:sha}).strict()}).strict();
export const providerBoundaryReceiptSchema = z.discriminatedUnion("version", [providerBoundaryReceiptV1Schema, providerBoundaryReceiptV2Schema,providerBoundaryReceiptV3Schema]);
export type ProviderBoundaryReceipt = z.infer<typeof providerBoundaryReceiptSchema>;

/** Privileged operator observations: hashes bind reviewed raw artifacts; they do not prove physical exit by themselves. */
function validateProviderBoundaryV1(plan: z.infer<typeof providerBoundaryPlanV1Schema>, receipt: z.infer<typeof providerBoundaryReceiptV1Schema>, evaluatedAt: string): boolean {
  const now = Date.parse(evaluatedAt);
  if (!at.safeParse(evaluatedAt).success || receipt.planHash !== providerBoundaryPlanHash(plan)
    || now - Date.parse(plan.createdAt) > 30 * 60_000 || now < Date.parse(plan.createdAt)
    || !isDeepStrictEqual(receipt.owner.identity, plan.owner) || !isDeepStrictEqual(receipt.provider.identity, plan.provider)
    || receipt.gateways.some((x, i) => !isDeepStrictEqual(x.identity, plan.gateways[i]))) return false;
  return receipt.owner.observedAt >= plan.createdAt && receipt.gateways.every(x => x.observedAt >= receipt.owner.observedAt)
    && receipt.gateways.every(x => x.observedAt <= receipt.provider.observedAt) && receipt.provider.observedAt <= evaluatedAt
    && now - Date.parse(receipt.provider.observedAt) <= 5 * 60_000;
}

/** v2 original owner authority is re-read from durable DB facts under the existing locked release transaction. */
export function validateProviderBoundary(plan: ProviderBoundaryPlan, receipt: ProviderBoundaryReceipt, evaluatedAt: string): boolean {
  if (plan.version === 1 && receipt.version === 1) return validateProviderBoundaryV1(plan, receipt, evaluatedAt);
  if(plan.version===3&&receipt.version===3){
    if(!providerBoundaryPlanV3Schema.safeParse(plan).success||!providerBoundaryReceiptV3Schema.safeParse(receipt).success)return false;
    const now=Date.parse(evaluatedAt),a=bootInterval(plan.bootWitness),b=bootInterval(receipt.provider.bootWitness);
    return at.safeParse(evaluatedAt).success&&receipt.planHash===providerBoundaryPlanHash(plan)
      &&now>=Date.parse(plan.createdAt)&&now-Date.parse(plan.createdAt)<=30*60_000
      &&isDeepStrictEqual(receipt.owner.identity,plan.owner)&&isDeepStrictEqual(receipt.provider.identity,plan.provider)
      &&receipt.owner.observedAt>=plan.createdAt&&receipt.provider.observedAt>=receipt.owner.observedAt
      &&receipt.provider.observedAt<=evaluatedAt&&now-Date.parse(receipt.provider.observedAt)<=5*60_000
      &&validBootWitness(receipt.provider.bootWitness,plan.provider.currentBootId,receipt.provider.observedAt)
      &&receipt.provider.bootWitness.dbBefore>=`${receipt.owner.observedAt.slice(0,23)}000Z`
      &&a.lower<=b.upper&&b.lower<=a.upper&&bootMicroseconds(plan.localEnd.endedAt)<b.lower&&bootMicroseconds(plan.request.dispatchAt)<b.lower;
  }
  if (plan.version !== 2 || receipt.version !== 2) return false;
  const now = Date.parse(evaluatedAt);
  if (!at.safeParse(evaluatedAt).success || receipt.planHash !== providerBoundaryPlanHash(plan)
    || receipt.originalOwnerProofHash !== providerBoundaryCanonicalHash(plan.originalOwner)
    || now - Date.parse(plan.createdAt) > 30 * 60_000 || now < Date.parse(plan.createdAt)
    || !isDeepStrictEqual(receipt.currentIngressOwner.identity, plan.currentIngressOwner) || !isDeepStrictEqual(receipt.provider.identity, plan.provider)
    || receipt.gateways.some((x, i) => !isDeepStrictEqual(x.identity, plan.gateways[i]))) return false;
  return receipt.currentIngressOwner.observedAt >= plan.createdAt && receipt.gateways.every(x => x.observedAt >= receipt.currentIngressOwner.observedAt)
    && receipt.gateways.every(x => x.observedAt <= receipt.provider.observedAt) && receipt.provider.observedAt <= evaluatedAt
    && now - Date.parse(receipt.provider.observedAt) <= 5 * 60_000;
}

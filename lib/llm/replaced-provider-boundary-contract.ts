import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { originalBoundaryOwnerSchema, providerBoundaryPlanV1Schema, providerBoundaryCanonicalHash } from "./provider-boundary-contract";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/);
const at = providerBoundaryPlanV1Schema.shape.createdAt;
const positive = z.number().int().positive().safe();
export const replacedProviderPlanSchema = z.object({ version: z.literal(1), kind: z.literal("replaced_provider_boundary_plan"),
  createdAt: at, reviewReference: z.string().min(1).max(400),
  request: providerBoundaryPlanV1Schema.shape.request.extend({ rowHash: sha, wireHash: sha, chargedTokens: positive }),
  control: providerBoundaryPlanV1Schema.shape.control,
  writer: z.object({ lineageId: z.uuid(), writerEpoch: positive }).strict(),
  originalOwner: originalBoundaryOwnerSchema,
}).strict();
const container = z.object({ role: z.enum(["owner", "gateway-m3", "gateway-mini"]), host: z.enum(["m3ultra", "9mini"]),
  serviceName: id, serviceId: id, taskId: id, containerId: sha, startedAt: at, observedAt: at,
  replicas: z.literal(1), privatePidNamespace: z.literal(true), noPreDispatchActiveTask: z.literal(true),
  noAlternativeIngress: z.literal(true), artifactHash: sha, topologyArtifactHash: sha,
}).strict();
export const replacedProviderReceiptSchema = z.object({ version: z.literal(1), kind: z.literal("replaced_provider_boundary_receipt"),
  planHash: sha, observedAt: at, containers: z.tuple([container, container, container]),
  relay: z.object({ requestId: z.uuid(), requestModel: z.literal("qwen3.8-flash-next"), requestHash: sha,
    relayGeneration: z.uuid(), startedAt: at, endedAt: at, state: z.literal("indeterminate"), error: z.literal("upstream_timeout"),
    receiptArtifactHash: sha, recoveryArtifactHash: sha,
    currentGeneration: z.uuid(), currentStartedAt: at, currentPid: positive, currentArtifactHash: sha,
    oldRelayGroupEnded: z.literal(true), oldModelGroupEnded: z.literal(true),
    originalModelPid: positive, originalModelStartedAt: at, currentModelPid: positive, currentModelStartedAt: at, currentModel: z.string().min(1).max(200),
    originalWireArtifactHash: sha, gatewaySourceArtifactHash: sha,
    originalWire: z.string().min(1).max(1_048_576), relayWire: z.string().min(1).max(1_048_576),
    transform: z.literal("abcllm-qwen-nonstream-httpx-0.27.2"),
  }).strict(),
}).strict();
export const replacedProviderEvidenceShape = z.object({ version: z.literal(1), kind: z.literal("replaced_provider_boundary_exit"),
  requestId: z.uuid(), owner: providerBoundaryPlanV1Schema.shape.request.shape.owner,
  fromState: z.literal("indeterminate"), dispatchAt: at, bindingHash: sha, notBefore: at, evaluatedAt: at,
  operator: z.string().min(1).max(120), reference: z.string().min(1).max(400),
  plan: replacedProviderPlanSchema, receipt: replacedProviderReceiptSchema,
}).strict();
export type ReplacedProviderPlan = z.infer<typeof replacedProviderPlanSchema>;
export type ReplacedProviderReceipt = z.infer<typeof replacedProviderReceiptSchema>;
export function replacedProviderPlanHash(plan: ReplacedProviderPlan) { return providerBoundaryCanonicalHash(plan); }
/** Both byte hashes must match, and gateway transformations must preserve the complete messages and generation bounds. */
export function validReplacedProviderWire(r: ReplacedProviderReceipt["relay"], wireHash: string): boolean {
  try {
    const original = JSON.parse(r.originalWire), forwarded = JSON.parse(r.relayWire);
    const message = z.object({ role: z.enum(["system", "user"]), content: z.string() }).strict();
    const input = z.object({ model: z.literal("[m1] qwen3.8-flash-next"), stream: z.literal(false), temperature: z.literal(0),
      reasoning_effort: z.literal("low"), max_tokens: positive.max(8000), messages: z.tuple([message, message]) }).strict().parse(original);
    return input.messages[0].role === "system" && input.messages[1].role === "user"
      && replacedProviderDigest(r.originalWire) === wireHash && r.originalWireArtifactHash === wireHash
      && replacedProviderDigest(r.relayWire) === r.requestHash
      && isDeepStrictEqual(forwarded, { model: r.requestModel, messages: input.messages, stream: true,
        stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: false },
        max_tokens: input.max_tokens, temperature: 0 });
  } catch { return false; }
}
export function validReplacedProviderEvidence(e: z.infer<typeof replacedProviderEvidenceShape>): boolean {
  const p = e.plan, q = p.request, r = e.receipt, relay = r.relay, now = Date.parse(e.evaluatedAt);
  return e.requestId === q.requestId && isDeepStrictEqual(e.owner, q.owner) && e.dispatchAt === q.dispatchAt && e.bindingHash === q.bindingHash
    && e.reference === p.reviewReference && e.notBefore === r.observedAt && r.planHash === replacedProviderPlanHash(p)
    && p.originalOwner.instanceId === q.owner.instanceId && p.originalOwner.bootId === q.owner.bootId
    && p.control.updatedAt <= p.createdAt && q.dispatchAt <= p.createdAt && p.createdAt <= r.observedAt && r.observedAt <= e.evaluatedAt
    && now - Date.parse(p.createdAt) <= 30 * 60_000 && now - Date.parse(r.observedAt) <= 5 * 60_000
    && r.containers.every((c, i) => c.role === ["owner", "gateway-m3", "gateway-mini"][i]
      && c.host === (i === 2 ? "9mini" : "m3ultra") && c.serviceName === ["nomorevibe-text-m3-ebmybu", "app-reboot-optical-matrix-3bl2a4", "app-hack-optical-monitor-v1ioak"][i]
      && c.startedAt > q.dispatchAt && c.startedAt <= c.observedAt && c.observedAt >= p.createdAt && c.observedAt <= r.observedAt)
    && new Set(r.containers.map(c => c.containerId)).size === 3
    && relay.startedAt >= q.dispatchAt && relay.startedAt <= relay.endedAt && relay.endedAt < relay.currentStartedAt
    && relay.currentStartedAt <= r.observedAt && relay.relayGeneration !== relay.currentGeneration
    && relay.originalModelStartedAt <= q.dispatchAt && relay.currentModel !== relay.requestModel
    && relay.currentModelPid !== relay.originalModelPid && relay.currentModelStartedAt > relay.endedAt && relay.currentModelStartedAt <= r.observedAt
    && validReplacedProviderWire(relay, q.wireHash);
}
export const replacedProviderEvidenceSchema = replacedProviderEvidenceShape.refine(validReplacedProviderEvidence, "invalid_replaced_provider_boundary");
export function replacedProviderArtifactHashes(plan: ReplacedProviderPlan, receipt: ReplacedProviderReceipt): string[] {
  const r = receipt.relay;
  return [...new Set([plan.originalOwner.artifactHash, ...receipt.containers.flatMap(c => [c.artifactHash, c.topologyArtifactHash]),
    r.receiptArtifactHash, r.recoveryArtifactHash, r.currentArtifactHash, r.originalWireArtifactHash, r.gatewaySourceArtifactHash])];
}
export const replacedProviderDigest = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");

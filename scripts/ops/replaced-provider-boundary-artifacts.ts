import { isDeepStrictEqual } from "node:util";
import { replacedProviderDigest, validReplacedProviderWire, type ReplacedProviderPlan, type ReplacedProviderReceipt } from "../../lib/llm/replaced-provider-boundary-contract";

/** Operator independently reviews the source and topology artifacts; hashes authenticate bytes, not their origin. */
export function verifyReplacedProviderArtifacts(plan: ReplacedProviderPlan, receipt: ReplacedProviderReceipt, read: (hash: string) => Buffer): void {
  const fail = (part: string): never => { throw new Error(`replaced_provider_${part}_evidence_mismatch`); };
  const artifact = (hash: string) => { const bytes = read(hash); if (replacedProviderDigest(bytes) !== hash) fail("artifact_hash"); return bytes; };
  const json = (hash: string) => JSON.parse(artifact(hash).toString("utf8"));
  const relay = receipt.relay;
  if (!validReplacedProviderWire(relay, plan.request.wireHash)
    || artifact(relay.originalWireArtifactHash).toString("utf8") !== relay.originalWire) fail("wire_hash");
  const original = json(relay.receiptArtifactHash);
  for (const key of ["requestId", "requestModel", "requestHash", "relayGeneration", "startedAt", "endedAt", "state", "error"] as const)
    if (original[key] !== relay[key]) fail("relay_receipt");
  const recovery = json(relay.recoveryArtifactHash);
  if (recovery.kind !== "m1-original-request-relay-recovery" || recovery.relayRequestId !== relay.requestId
    || recovery.originalReceiptSha256 !== relay.receiptArtifactHash
    || recovery.originalRelayGeneration !== relay.relayGeneration || recovery.restored?.relayGeneration !== relay.currentGeneration
    || recovery.newRelayPid !== relay.currentPid || recovery.nativeExit?.oldPidESRCH !== true || recovery.nativeExit?.processGroupESRCH !== true
    || recovery.relayExit?.oldPidESRCH !== true || recovery.relayExit?.processGroupESRCH !== true || recovery.relayExit?.allKnownDescendantsESRCH !== true
    || recovery.originalNativeIdentity?.pid !== relay.originalModelPid || recovery.originalNativeIdentity?.startedAt !== relay.originalModelStartedAt
    || recovery.nativeRestarted !== false || Date.parse(recovery.completedAt) < Date.parse(relay.currentStartedAt)) fail("recovery");
  const current = json(relay.currentArtifactHash);
  if (current.pid !== relay.currentPid || current.startedAt !== relay.currentStartedAt || current.relayGeneration !== relay.currentGeneration
    || current.model !== relay.currentModel || current.modelPid !== relay.currentModelPid || current.modelStartedAt !== relay.currentModelStartedAt
    || current.oldModelPidAbsent !== true || current.oldModelGroupAbsent !== true) fail("current_relay");
  for (const c of receipt.containers) {
    const capture = json(c.artifactHash), topology = json(c.topologyArtifactHash);
    const active = capture.containers;
    if (capture.serviceId !== c.serviceId || capture.serviceName !== c.serviceName || capture.replicas !== 1
      || new Date(capture.observedAt).toISOString() !== c.observedAt || !Array.isArray(active) || active.length !== 1
      || active[0].id !== c.containerId || active[0].taskId !== c.taskId || active[0].running !== true
      || new Date(active[0].startedAt).toISOString() !== c.startedAt || active[0].privileged !== false || active[0].pidMode !== ""
      || !Array.isArray(capture.tasks) || !capture.tasks.length
      || capture.tasks.filter((t: { DesiredState: string }) => t.DesiredState === "Running").length !== 1
      || !capture.tasks.some((t: { ID: string; DesiredState: string }) => t.ID === c.taskId && t.DesiredState === "Running")
      || capture.tasks.some((t: { ID: string; CurrentState: string }) => t.ID !== c.taskId && !/^(?:Shutdown|Failed|Complete|Rejected|Remove)\b/.test(t.CurrentState))
      || topology.serviceName !== c.serviceName || topology.serviceId !== c.serviceId || topology.noAlternativeIngress !== true
      || topology.privatePidNamespace !== true || topology.reviewed !== true) fail(c.role.replaceAll("-", "_"));
  }
  const { artifactHash, ...owner } = plan.originalOwner;
  if (!isDeepStrictEqual(json(artifactHash).originalOwner, owner)) fail("original_owner");
  // The source is a reviewed immutable snapshot, never executed and never used to widen access.
  if (!artifact(relay.gatewaySourceArtifactHash).length) fail("gateway_source");
}

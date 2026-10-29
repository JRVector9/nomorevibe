import { expect, it } from "vitest";
import { replacedProviderDigest as sha, replacedProviderPlanHash } from "@/lib/llm/replaced-provider-boundary-contract";
import { verifyReplacedProviderArtifacts } from "@/scripts/ops/replaced-provider-boundary-artifacts";
import { readReplacedProviderBoundaryReleaseFiles } from "@/scripts/ops/model-replaced-provider-boundary-release";
import { replacedProviderFixture } from "./fixtures/replaced-provider-boundary";
function material() {
  const fx = replacedProviderFixture(), files = new Map<string, Buffer>(), put = (v: unknown) => {
    const b = Buffer.from(typeof v === "string" ? v : JSON.stringify(v)); const h = sha(b); files.set(h, b); return h;
  };
  const r = fx.receipt.relay;
  const { artifactHash: _artifact, ...originalOwner } = fx.plan.originalOwner;
  fx.plan.originalOwner.artifactHash = put({ originalOwner });
  r.originalWireArtifactHash = put(r.originalWire);
  r.receiptArtifactHash = put(Object.fromEntries(["requestId", "requestModel", "requestHash", "relayGeneration", "startedAt", "endedAt", "state", "error"].map(k => [k, r[k as keyof typeof r]])));
  r.recoveryArtifactHash = put({ kind: "m1-original-request-relay-recovery", relayRequestId: r.requestId, originalReceiptSha256: r.receiptArtifactHash, originalRelayGeneration: r.relayGeneration,
    restored: { relayGeneration: r.currentGeneration }, newRelayPid: r.currentPid, nativeExit: { oldPidESRCH: true, processGroupESRCH: true },
    relayExit: { oldPidESRCH: true, processGroupESRCH: true, allKnownDescendantsESRCH: true },
    originalNativeIdentity: { pid: r.originalModelPid, startedAt: r.originalModelStartedAt }, nativeRestarted: false, completedAt: fx.receipt.observedAt });
  r.currentArtifactHash = put({ pid: r.currentPid, startedAt: r.currentStartedAt, relayGeneration: r.currentGeneration,
    model: r.currentModel, modelPid: r.currentModelPid, modelStartedAt: r.currentModelStartedAt, oldModelPidAbsent: true, oldModelGroupAbsent: true });
  r.gatewaySourceArtifactHash = put("synthetic source only");
  for (const c of fx.receipt.containers) {
    c.artifactHash = put({ serviceId: c.serviceId, serviceName: c.serviceName, replicas: 1, observedAt: c.observedAt,
      containers: [{ id: c.containerId, taskId: c.taskId, running: true, startedAt: c.startedAt, privileged: false, pidMode: "" }],
      tasks: [{ ID: c.taskId, DesiredState: "Running", CurrentState: "Running 1 hour ago" }] });
    c.topologyArtifactHash = put({ serviceName: c.serviceName, serviceId: c.serviceId, noAlternativeIngress: true, privatePidNamespace: true, reviewed: true });
  }
  fx.receipt.planHash = replacedProviderPlanHash(fx.plan);
  return { ...fx, files, read: (h: string) => { const b = files.get(h); if (!b) throw Error("missing artifact"); return b; } };
}
it("verifies every byte and relay/process/container association", () => {
  const fx = material(); expect(() => verifyReplacedProviderArtifacts(fx.plan, fx.receipt, fx.read)).not.toThrow();
});
it("rejects substituted raw artifacts", () => {
  const fx = material(); fx.files.set(fx.receipt.relay.receiptArtifactHash, Buffer.from("{}"));
  expect(() => verifyReplacedProviderArtifacts(fx.plan, fx.receipt, fx.read)).toThrow("artifact_hash");
});
it("rejects receipt from another request even with a correct file hash", () => {
  const fx = material(), r = fx.receipt.relay, b = JSON.parse(fx.read(r.receiptArtifactHash).toString()); b.requestHash = "b".repeat(64);
  const raw = Buffer.from(JSON.stringify(b)); r.receiptArtifactHash = sha(raw); fx.files.set(r.receiptArtifactHash, raw);
  expect(() => verifyReplacedProviderArtifacts(fx.plan, fx.receipt, fx.read)).toThrow("relay_receipt");
});
it("rejects absent model/group exit and active predecessor tasks", () => {
  for (const key of ["oldModelPidAbsent", "oldModelGroupAbsent"]) {
    const fx = material(), r = fx.receipt.relay, b = JSON.parse(fx.read(r.currentArtifactHash).toString()); delete b[key];
    const raw = Buffer.from(JSON.stringify(b)); r.currentArtifactHash = sha(raw); fx.files.set(r.currentArtifactHash, raw);
    expect(() => verifyReplacedProviderArtifacts(fx.plan, fx.receipt, fx.read)).toThrow("current_relay");
  }
  const fx = material(), c = fx.receipt.containers[1], b = JSON.parse(fx.read(c.artifactHash).toString());
  b.tasks.push({ ID: "previous", DesiredState: "Shutdown", CurrentState: "Running 1 day ago" });
  const raw = Buffer.from(JSON.stringify(b)); c.artifactHash = sha(raw); fx.files.set(c.artifactHash, raw);
  expect(() => verifyReplacedProviderArtifacts(fx.plan, fx.receipt, fx.read)).toThrow("gateway_m3");
});
it("CLI refuses multiple requests, apply repetition, URL arguments and missing required evidence", () => {
  for (const args of [["--request=a", "--request=b"], ["--apply", "--apply"], ["--database-url=postgres://example"], ["--database-url-stdin"]])
    expect(() => readReplacedProviderBoundaryReleaseFiles(args)).toThrow();
});

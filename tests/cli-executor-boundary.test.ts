import { expect, it } from "vitest";
import { modelDispatchReleaseEvidenceSchema } from "@/lib/llm/capacity";
import { cliExecutorFixture } from "./fixtures/cli-executor-boundary";
import { cliExecutorPlanHash } from "@/lib/llm/cli-executor-boundary-contract";

it("accepts an independently reviewed complete singleton-service fence without fabricating a native terminal", () => {
  expect(modelDispatchReleaseEvidenceSchema.safeParse(cliExecutorFixture().evidence).success).toBe(true);
});

it("accepts a trusted Desktop forwarder with no backend and removed trusted init without historical PID namespace", () => {
  const x = cliExecutorFixture().evidence;
  Object.assign(x.receipt.wholeService, { endpointClosed: { kind: "trusted_forwarder_no_backend", forwarderIdentity: "docker-desktop",
    forwarderHash: "c".repeat(64), backendServiceId: x.plan.executor.serviceId, backendCount: 0, noAlternativeExecutor: true, RPCUnavailable: true } });
  Object.assign(x.receipt.exits[0], { initClosure: { kind: "removed_after_trusted_init_exit", containerRemoved: true, trustedInitExited: true } });
  expect(modelDispatchReleaseEvidenceSchema.safeParse(x).success).toBe(true);
});

const mutations: [string, (x: ReturnType<typeof cliExecutorFixture>["evidence"]) => void][] = [
  ["missing candidate closure", x => { x.receipt.exits.pop(); }],
  ["duplicate task", x => { x.plan.candidates[1].taskId = x.plan.candidates[0].taskId; }],
  ["duplicate full CID", x => { x.plan.candidates[1].containerId = x.plan.candidates[0].containerId; }],
  ["foreign node", x => { x.plan.candidates[1].nodeId = "foreign"; }],
  ["missing baseline task", x => { x.plan.interval.singleTaskId = "unknown"; }],
  ["no before-native proof", x => { x.plan.interval.beforeNativeAt = x.plan.request.dispatchAt; }],
  ["changed daemon", x => { x.receipt.executor = { ...x.receipt.executor, daemonBootId: "00000000-0000-0000-0000-000000000000" }; }],
  ["transport changed", x => { x.plan.request.transport.model = "other"; }],
  ["C reduced", x => { x.plan.request.chargedTokens--; }],
  ["wrong endpoint hash", x => { x.plan.executor.baseUrlHash = "0".repeat(64); }],
  ["wrong reference", x => { x.reference = "other"; }],
  ["wrong owner", x => { x.owner = { ...x.owner, instanceId: "other" }; }],
  ["wrong binding", x => { x.bindingHash = "0".repeat(64); }],
  ["expired plan", x => { x.plan.createdAt = new Date(Date.parse(x.evaluatedAt)-31*60_000).toISOString(); }],
  ["expired receipt", x => { x.receipt.observedAt = new Date(Date.parse(x.evaluatedAt)-6*60_000).toISOString(); x.notBefore=x.receipt.observedAt; }],
  ["future receipt", x => { x.receipt.observedAt = new Date(Date.parse(x.evaluatedAt)+1000).toISOString(); x.notBefore=x.receipt.observedAt; }],
];
for (const [name, mutate] of mutations) it(`rejects ${name}`, () => {
  const x = structuredClone(cliExecutorFixture().evidence); mutate(x);
  x.receipt.planHash = cliExecutorPlanHash(x.plan);
  expect(modelDispatchReleaseEvidenceSchema.safeParse(x).success).toBe(false);
});

it("rejects every required proof field when null and false whole-service or isolation assertions", () => {
  const x = cliExecutorFixture().evidence;
  for (const layer of [x, x.plan, x.plan.request, x.plan.writer, x.plan.control, x.plan.executor, x.plan.interval, x.receipt,
    x.receipt.wholeService, x.receipt.noReplay, x.plan.topology, x.receipt.exits[0], x.receipt.exits[0].initClosure]) {
    for (const key of Object.keys(layer)) {
      const copy = structuredClone(x), target = layer === x ? copy : findSameLayer(x, copy, layer);
      Object.assign(target, { [key]: null });
      expect(modelDispatchReleaseEvidenceSchema.safeParse(copy).success, key).toBe(false);
    }
  }
});
function findSameLayer(original: object, copy: object, target: object): object {
  for (const key of Object.keys(original)) {
    const a = (original as Record<string, unknown>)[key], b = (copy as Record<string, unknown>)[key];
    if (a === target) return b as object;
    if (a && typeof a === "object") { try { return findSameLayer(a, b as object, target); } catch { /* next branch */ } }
  }
  throw new Error("fixture_layer_not_found");
}

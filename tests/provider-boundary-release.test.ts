import { expect, it } from "vitest";
import { modelDispatchReleaseEvidenceSchema } from "@/lib/llm/capacity";
import { boundaryFixture } from "./fixtures/provider-boundary-release";
import { boundaryExitObservationSchema } from "@/lib/llm/provider-boundary-contract";
import { providerBoundaryPlanHash, providerBoundaryPlanSchema, providerBoundaryReceiptSchema, validateProviderBoundary } from "@/lib/llm/provider-boundary-contract";

it("새 plan hash는 startedAt/startTicks 경계를 포함해 Python ASCII key canonical fixture와 같다", () => {
  // Independently computed with Python json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False).
  expect(providerBoundaryPlanHash(boundaryFixture().plan)).toBe("d6984a8aeacca0da1b575aeecd047d1707cf36edcf12547abd607b1f7c9ca487");
});

it("Docker private PID namespace init 종료는 관측하지 않은 cgroup empty를 요구하거나 발명하지 않는다", () => {
  const { receipt } = boundaryFixture();
  const { cgroupPopulated: _populated, cgroupPids: _pids, ...base } = receipt.owner;
  void _populated; void _pids;
  const proof = { ...base, method: "private_pid_namespace_end", pidMode: "", initPid: 1,
    initNamespace: base.identity.pidNamespace, selfNamespace: base.identity.pidNamespace,
    waitExitCode: 137, containerStatus: "exited", running: false };
  expect(boundaryExitObservationSchema.safeParse(proof).success).toBe(true);
  expect(boundaryExitObservationSchema.safeParse({ ...proof, containerStatus: "removed" }).success).toBe(true);
  for (const change of [{ pidMode: "host" }, { pidMode: "container:other" }, { initPid: 38 }, { running: true },
    { initNamespace: "123" }, { selfNamespace: "123" }, { mainPid: 123 }, { waitExitCode: null }])
    expect(boundaryExitObservationSchema.safeParse({ ...proof, ...change }).success).toBe(false);
});

it("미완료·누락·오래된·다른 incarnation·종료 순서 역전은 어떤 idle/시간경과로도 승인하지 않는다", () => {
  const { plan, receipt } = boundaryFixture();
  const p = providerBoundaryPlanSchema.parse(plan), r = providerBoundaryReceiptSchema.parse(receipt), now = "2026-10-24T18:13:00.000Z";
  expect(validateProviderBoundary(p, r, now)).toBe(true);
  for (const change of [
    { owner: { ...r.owner, observedAt: "2026-10-24T18:11:30.000Z" } },
    { provider: { ...r.provider, observedAt: "2026-10-24T18:10:30.000Z" } },
    { provider: { ...r.provider, observedAt: "2026-10-24T18:14:00.000Z" } },
    { owner: { ...r.owner, identity: { ...r.owner.identity, incarnationId: "other" } } },
    { planHash: "0".repeat(64) },
  ]) expect(validateProviderBoundary(p, { ...r, ...change }, now)).toBe(false);
  expect(validateProviderBoundary(p, r, "2026-10-24T18:18:00.000Z")).toBe(false);
  for (const change of [{ gateways: [r.gateways[0]] }, { owner: { ...r.owner, cgroupPids: [1] } },
    { owner: { ...r.owner, autoRestartBlocked: false } }, { provider: { ...r.provider, replacements: 1 } },
    { provider: { ...r.provider, oldPidAbsent: false } }, { extra: true }])
    expect(providerBoundaryReceiptSchema.safeParse({ ...r, ...change }).success).toBe(false);
  const duplicate = { ...p, gateways: [p.gateways[0], p.gateways[0]] };
  expect(providerBoundaryPlanSchema.safeParse(duplicate).success).toBe(false);
  expect(providerBoundaryPlanHash(Object.fromEntries(Object.entries(p).reverse()))).toBe(providerBoundaryPlanHash(p));
});

it("실제 provider 경계 종료는 settled terminal을 만들지 않는 독립 release 종류다", () => {
  const { plan, receipt } = boundaryFixture();
  const evidence = { version: 1, kind: "provider_boundary_exit", requestId: plan.request.requestId, owner: plan.request.owner,
    fromState: "indeterminate", dispatchAt: plan.request.dispatchAt, bindingHash: plan.request.bindingHash,
    notBefore: receipt.provider.observedAt, evaluatedAt: "2026-10-24T18:13:00.000Z", operator: "fixture-operator",
    reference: "fixture only: observed owner, both gateways and old engine exited", plan, receipt };
  expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence).success).toBe(true);
});

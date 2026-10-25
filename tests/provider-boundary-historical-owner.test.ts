import { expect, it } from "vitest";
import { providerBoundaryCanonicalHash, providerBoundaryPlanHash, providerBoundaryPlanSchema, providerBoundaryReceiptSchema, validateProviderBoundary } from "@/lib/llm/provider-boundary-contract";
import { historicalOwnerFixture, historicalSystemdOwnerFixture } from "./fixtures/provider-boundary-historical-owner";
import { boundaryFixture } from "./fixtures/provider-boundary-release";
it("v2는 원 durable owner와 dispatch 뒤 생긴 현재 ingress를 분리하며 v1 birth guard는 보존한다", () => {
  const { plan, receipt } = historicalOwnerFixture();
  receipt.originalOwnerProofHash = providerBoundaryCanonicalHash(plan.originalOwner); receipt.planHash = providerBoundaryPlanHash(plan);
  expect(validateProviderBoundary(providerBoundaryPlanSchema.parse(plan), providerBoundaryReceiptSchema.parse(receipt), "2026-10-24T18:13:00.000Z")).toBe(true);
  const old = boundaryFixture(); old.plan.owner.startedAt = plan.currentIngressOwner.startedAt;
  expect(providerBoundaryPlanSchema.safeParse(old.plan).success).toBe(false);
  expect(providerBoundaryPlanHash(boundaryFixture().plan)).toBe("d6984a8aeacca0da1b575aeecd047d1707cf36edcf12547abd607b1f7c9ca487");
});
it("원 owner·누락 group·현재 ingress 미종료와 gateway/provider birth 완화는 거절한다", () => {
  const { plan, receipt } = historicalOwnerFixture();
  for (const originalOwner of [{ ...plan.originalOwner, bootId: "11111111-1111-4111-8111-111111111111" }, { ...plan.originalOwner, groups: [] }, { ...plan.originalOwner, extra: true }])
    expect(providerBoundaryPlanSchema.safeParse({ ...plan, originalOwner }).success).toBe(false);
  expect(providerBoundaryPlanSchema.safeParse({ ...plan, gateways: [{ ...plan.gateways[0], startedAt: plan.currentIngressOwner.startedAt }, plan.gateways[1]] }).success).toBe(false);
  expect(providerBoundaryReceiptSchema.safeParse({ ...receipt, currentIngressOwner: { ...receipt.currentIngressOwner, oldPidAbsent: false } }).success).toBe(false);
});
it("v2 historical owner는 strict systemd 전체 cgroup 종료를 허용한다", () => {
  const { plan, receipt } = historicalSystemdOwnerFixture();
  receipt.originalOwnerProofHash = providerBoundaryCanonicalHash(plan.originalOwner);
  receipt.planHash = providerBoundaryPlanHash(plan);
  expect(validateProviderBoundary(providerBoundaryPlanSchema.parse(plan), providerBoundaryReceiptSchema.parse(receipt), "2026-10-24T18:13:00.000Z")).toBe(true);
});
it("v2 systemd는 container 위장·불완전 종료·잘못된 원 owner와 경계 순서를 거절한다", () => {
  const { plan, receipt } = historicalSystemdOwnerFixture();
  for (const provider of [{ ...plan.provider, kind: "container" }, { ...plan.provider, startedAt: plan.currentIngressOwner.startedAt }])
    expect(providerBoundaryPlanSchema.safeParse({ ...plan, provider }).success).toBe(false);
  for (const change of [{ method: "container_and_cgroup_empty" }, { method: "private_pid_namespace_end" }, { cgroupPopulated: true },
    { cgroupPids: [1] }, { oldPidAbsent: false }, { replacements: 1 }, { autoRestartBlocked: false }])
    expect(providerBoundaryReceiptSchema.safeParse({ ...receipt, provider: { ...receipt.provider, ...change } }).success).toBe(false);
  receipt.originalOwnerProofHash = providerBoundaryCanonicalHash(plan.originalOwner); receipt.planHash = providerBoundaryPlanHash(plan);
  expect(validateProviderBoundary(providerBoundaryPlanSchema.parse(plan), providerBoundaryReceiptSchema.parse({ ...receipt, originalOwnerProofHash: "0".repeat(64) }), "2026-10-24T18:13:00.000Z")).toBe(false);
  expect(validateProviderBoundary(providerBoundaryPlanSchema.parse(plan), providerBoundaryReceiptSchema.parse({ ...receipt, provider: { ...receipt.provider, observedAt: plan.createdAt } }), "2026-10-24T18:13:00.000Z")).toBe(false);
});

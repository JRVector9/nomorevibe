import { expect, it } from "vitest";
import { providerBoundaryCanonicalHash, providerBoundaryPlanHash, providerBoundaryPlanSchema, providerBoundaryReceiptSchema, validateProviderBoundary } from "@/lib/llm/provider-boundary-contract";
import { historicalOwnerFixture } from "./fixtures/provider-boundary-historical-owner";
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

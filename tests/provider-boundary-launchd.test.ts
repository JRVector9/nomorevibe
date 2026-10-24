import { expect, it } from "vitest";
import { providerBoundaryPlanHash, providerBoundaryPlanSchema, providerBoundaryReceiptSchema, validateProviderBoundary } from "@/lib/llm/provider-boundary-contract";
import { launchdBoundaryFixture } from "./fixtures/provider-boundary-launchd";
import { boundaryFixture } from "./fixtures/provider-boundary-release";

it("launchd provider는 Linux 필드를 발명하지 않고 same-boot의 실제 단일 process 경계를 표현한다", () => {
  const f = launchdBoundaryFixture(); f.receipt.planHash = providerBoundaryPlanHash(f.plan);
  const plan = providerBoundaryPlanSchema.parse(f.plan), receipt = providerBoundaryReceiptSchema.parse(f.receipt);
  expect(validateProviderBoundary(plan, receipt, "2026-10-24T18:13:00.000Z")).toBe(true);
  expect(providerBoundaryPlanHash(boundaryFixture().plan)).toBe("d6984a8aeacca0da1b575aeecd047d1707cf36edcf12547abd607b1f7c9ca487");
});

it("Mac boot UUID는 identity와 관측 모두 같은 kernel UUID 형식으로 검증한다", () => {
  const f = launchdBoundaryFixture();
  f.plan.provider.hostBootId = "11111111-1111-1111-1111-111111111111";
  f.receipt.provider.identity = f.plan.provider;
  f.receipt.provider.observedHostBootId = f.plan.provider.hostBootId;
  f.receipt.planHash = providerBoundaryPlanHash(f.plan);
  const plan = providerBoundaryPlanSchema.parse(f.plan), receipt = providerBoundaryReceiptSchema.parse(f.receipt);
  expect(validateProviderBoundary(plan, receipt, "2026-10-24T18:13:00.000Z")).toBe(true);
});

it("launchd는 provider에만 허용하고 Linux identity/종료 method와 섞지 않는다", () => {
  const f = launchdBoundaryFixture();
  for (const key of ["startTicks", "pidNamespace", "cgroup"])
    expect(providerBoundaryPlanSchema.safeParse({ ...f.plan, provider: { ...f.plan.provider, [key]: "invented" } }).success).toBe(false);
  for (const field of ["owner", "gateways"] as const) {
    const changed = field === "owner" ? { ...f.plan, owner: f.plan.provider } : { ...f.plan, gateways: [f.plan.provider, f.plan.gateways[1]] };
    expect(providerBoundaryPlanSchema.safeParse(changed).success).toBe(false);
  }
  for (const method of ["systemd_and_cgroup_empty", "container_and_cgroup_empty", "private_pid_namespace_end"])
    expect(providerBoundaryReceiptSchema.safeParse({ ...f.receipt, provider: { ...f.receipt.provider, method, cgroupPopulated: false, cgroupPids: [] } }).success).toBe(false);
  expect(providerBoundaryReceiptSchema.safeParse({ ...f.receipt, provider: { ...f.receipt.provider, identity: boundaryFixture().plan.provider } }).success).toBe(false);
  expect(providerBoundaryReceiptSchema.safeParse({ ...boundaryFixture().receipt, provider: f.receipt.provider }).success).toBe(true);
});

it("PID 시작시각·boot 불일치와 미종료·교체·listener·누락·추가 필드를 엄격하게 거절한다", () => {
  const f = launchdBoundaryFixture();
  expect(providerBoundaryPlanSchema.safeParse({ ...f.plan, provider: { ...f.plan.provider, startUsec: 1000 } }).success).toBe(false);
  expect(providerBoundaryPlanSchema.safeParse({ ...f.plan, provider: { ...f.plan.provider, pgid: 99 } }).success).toBe(false);
  for (const change of [{ observedHostBootId: "22222222-2222-4222-8222-222222222222" }, { launchdDisabled: false }, { launchdUnloaded: false },
    { oldPidESRCH: false }, { processGroupESRCH: false }, { allKnownDescendantsESRCH: false }, { replacementPids: [101] }, { ownedListeners: [100] }, { extra: true }])
    expect(providerBoundaryReceiptSchema.safeParse({ ...f.receipt, provider: { ...f.receipt.provider, ...change } }).success).toBe(false);
  for (const key of Object.keys(f.plan.provider)) {
    const provider = { ...f.plan.provider, [key]: null };
    expect(providerBoundaryPlanSchema.safeParse({ ...f.plan, provider }).success).toBe(false);
  }
});

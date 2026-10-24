import { providerBoundaryPlanHash } from "@/lib/llm/provider-boundary-contract";
export const boundaryFixture = () => {
  const hash = (n: string) => n.repeat(64);
  const identity = (host: string, n: string, kind: "container" | "systemd" = "container") => ({
    host, hostBootId: "11111111-1111-4111-8111-111111111111", kind, service: `${host}-service`, serviceRevision: "1",
    incarnationId: n.repeat(64), startedAt: "2026-10-24T16:00:00.000Z", pid: 100, startTicks: "12345", pidNamespace: "4026531836", cgroup: `/service/${host}`,
  });
  const plan = {
    version: 1, kind: "provider_boundary_plan", createdAt: "2026-10-24T18:00:00.000Z",
    request: { requestId: "22222222-2222-4222-8222-222222222222", owner: { instanceId: "ai2-fixture", bootId: "33333333-3333-4333-8333-333333333333" },
      state: "indeterminate", tokenHash: hash("a"), epoch: 1, revision: 2, policyHash: hash("b"), bindingHash: hash("c"),
      dispatchAt: "2026-10-24T17:49:27.596Z", providerBudgetId: "abcllm-supa", groupId: "supa", servingContractHash: hash("d") },
    control: { mode: "draining", epoch: 1, revision: 2, policyHash: hash("b"), updatedAt: "2026-10-24T17:59:00.000000Z" },
    owner: identity("owner", "1"), gateways: [identity("m3", "2"), identity("mini", "3")], provider: identity("supa", "4", "systemd"),
    beforeArtifactHash: hash("e"),
  };
  const observation = (process: ReturnType<typeof identity>, observedAt: string, n: string) => ({
    identity: process, observedAt, method: process.kind === "container" ? "container_and_cgroup_empty" : "systemd_and_cgroup_empty",
    mainPid: 0, oldPidAbsent: true, cgroupPopulated: false, cgroupPids: [], serviceStopped: true, replacements: 0, autoRestartBlocked: true,
    artifactHash: hash(n),
  });
  const receipt = { version: 1, kind: "provider_boundary_receipt", planHash: providerBoundaryPlanHash(plan),
    owner: observation(plan.owner, "2026-10-24T18:10:00.000Z", "5"),
    gateways: plan.gateways.map((p, i) => observation(p, `2026-10-24T18:11:0${i}.000Z`, String(6 + i))),
    provider: observation(plan.provider, "2026-10-24T18:12:00.000Z", "8") };
  return { plan, receipt, hash };
};

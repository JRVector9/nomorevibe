import { boundaryFixture } from "./provider-boundary-release";

/** Synthetic contract fixture only. It is never an operator exit observation. */
export function launchdBoundaryFixture() {
  const old = boundaryFixture();
  const provider = { host: "m3", hostBootId: old.plan.provider.hostBootId, kind: "launchd" as const,
    service: "gui/501/com.fixture.model", serviceRevision: "fixture-launchd-1", incarnationId: "fixture-mac-incarnation",
    startedAt: old.plan.provider.startedAt, pid: 100, startSec: String(Date.parse(old.plan.provider.startedAt) / 1000), startUsec: 0,
    uid: 501, ppid: 1, pgid: 100, sid: 100, domain: "gui/501", label: "com.fixture.model", servingRevision: "fixture-runtime-1",
    plistSha256: old.hash("a"), entrySha256: old.hash("b"), topologyProofSha256: old.hash("c"),
    inferenceScope: "in_process_threads_only" as const, knownDescendantPids: [] as number[], listenerPort: 8010 };
  const plan = { ...old.plan, provider };
  const receipt = { ...old.receipt, provider: { identity: provider, observedAt: old.receipt.provider.observedAt,
    method: "launchd_process_group_empty" as const, mainPid: 0 as const, oldPidAbsent: true as const, serviceStopped: true as const,
    replacements: 0 as const, autoRestartBlocked: true as const, artifactHash: old.hash("d"), observedHostBootId: provider.hostBootId,
    launchdDisabled: true as const, launchdUnloaded: true as const, oldPidESRCH: true as const, processGroupESRCH: true as const,
    allKnownDescendantsESRCH: true as const, replacementPids: [] as never[], ownedListeners: [] as never[] } };
  return { plan, receipt };
}

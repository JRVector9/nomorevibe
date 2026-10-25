import { createHash } from "node:crypto";
import { launchdBoundaryFixture } from "./provider-boundary-launchd";
import { boundaryFixture } from "./provider-boundary-release";
export function historicalOwnerFixture() {
  const old = launchdBoundaryFixture(), { owner, ...base } = old.plan, { owner: ownerExit, ...receiptBase } = old.receipt;
  const originalOwner = { kind: "durable_process_group_exit", ...old.plan.request.owner, openedEventId: 7,
    groups: [{ seq: 1, pid: 41, runIdHash: createHash("sha256").update("44444444-4444-4444-8444-444444444444").digest("hex"), spawnIntentEventId: 8, spawnedEventId: 9, exitEventId: 23 }],
    localEndEventId: 2616, localEndEvidenceHash: "b".repeat(64), artifactHash: "a".repeat(64) };
  const currentIngressOwner = { ...owner, startedAt: "2026-10-24T17:55:00.000Z" };
  const plan = { ...base, version: 2, originalOwner, currentIngressOwner };
  const receipt = { ...receiptBase, version: 2, originalOwnerProofHash: "a".repeat(64), currentIngressOwner: { ...ownerExit, identity: currentIngressOwner } };
  return { plan, receipt };
}
/** Synthetic historical owner with the unchanged strict Linux systemd physical boundary. */
export function historicalSystemdOwnerFixture() {
  const historical = historicalOwnerFixture(), linux = boundaryFixture();
  return { plan: { ...historical.plan, provider: linux.plan.provider },
    receipt: { ...historical.receipt, provider: linux.receipt.provider } };
}

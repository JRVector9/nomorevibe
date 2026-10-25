import { bootInterval } from '@/lib/llm/provider-boot-boundary';
import { providerBoundaryCanonicalHash } from '@/lib/llm/provider-boundary-contract';
import { bootBoundaryFixture, invalidBootBoundaries } from './provider-boot-boundary';
import { historicalOwnerFixture } from './provider-boundary-historical-owner';

export function historicalBootBoundaryFixture() {
  const boot = bootBoundaryFixture(), historical = historicalOwnerFixture();
  const { owner, ...base } = boot.plan;
  const { owner: ownerExit, ...receiptBase } = boot.receipt;
  const originalOwner = { ...historical.plan.originalOwner, localEndEventId: boot.plan.localEnd.eventId };
  const group = originalOwner.groups[0];
  const plan = { ...base, version: 4, originalOwner, currentIngressOwner: { ...owner, startedAt: historical.plan.currentIngressOwner.startedAt },
    ownerAssociation: { ...boot.plan.ownerAssociation, spawnedEventId: group.spawnedEventId, pid: group.pid, runIdHash: group.runIdHash } };
  const receipt = { ...receiptBase, version: 4, planHash: providerBoundaryCanonicalHash(plan),
    originalOwnerProofHash: providerBoundaryCanonicalHash(originalOwner), currentIngressOwner: { ...ownerExit, identity: plan.currentIngressOwner } };
  return { plan, receipt };
}

/** Shared full V4 malformed matrix, including the historical group's array element. */
export function invalidHistoricalBootBoundaries(seed: ReturnType<typeof historicalBootBoundaryFixture>) {
  const cases = invalidBootBoundaries(seed), original = seed.plan.originalOwner, group = original.groups[0];
  const groups: unknown[] = [[], [group, group], [{ ...group, extra: true }], [{ ...group, seq: 2147483648 }], [{ ...group, pid: 2147483648 }]];
  for (const key of Object.keys(group)) groups.push([{ ...group, [key]: null }], [Object.fromEntries(Object.entries(group).filter(([k]) => k !== key))]);
  for (const value of groups) {
    const x = structuredClone(seed); Object.assign(x.plan.originalOwner, { groups: value }); cases.push(x);
  }
  const lower = bootInterval(seed.plan.bootWitness).lower;
  for (const delta of [0, 1]) {
    const x = structuredClone(seed), us = lower + BigInt(delta);
    x.plan.localEnd.endedAt = new Date(Number(us / BigInt(1000))).toISOString().slice(0, 23) + (us % BigInt(1000)).toString().padStart(3, '0') + 'Z';
    cases.push(x);
  }
  return cases;
}

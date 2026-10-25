import { expect, it } from 'vitest';
import { bootInterval } from '@/lib/llm/provider-boot-boundary';
import { modelDispatchReleaseEvidenceSchema } from '@/lib/llm/capacity';
import { providerBoundaryCanonicalHash, providerBoundaryPlanSchema, providerBoundaryReceiptSchema, validateProviderBoundary } from '@/lib/llm/provider-boundary-contract';
import { historicalBootBoundaryFixture, invalidHistoricalBootBoundaries } from './fixtures/provider-boot-historical-owner';

function evidence(value = historicalBootBoundaryFixture()) {
  const baseline = historicalBootBoundaryFixture();
  return { version: 1, kind: 'provider_boundary_exit', requestId: baseline.plan.request.requestId, owner: baseline.plan.request.owner,
    fromState: 'indeterminate', dispatchAt: baseline.plan.request.dispatchAt, bindingHash: baseline.plan.request.bindingHash,
    notBefore: baseline.receipt.provider.observedAt, evaluatedAt: '2026-10-24T18:13:00.000Z', operator: 'fixture', reference: 'synthetic historical native reboot', ...value };
}
it('combines a closed historical owner with a later current ingress and direct native boot', () => {
  const x = historicalBootBoundaryFixture();
  expect(x.plan.currentIngressOwner.startedAt > x.plan.request.dispatchAt).toBe(true);
  expect(x.plan.originalOwner.localEndEvidenceHash).not.toBe(x.plan.localEnd.evidenceHash);
  expect(providerBoundaryPlanSchema.safeParse(x.plan).success).toBe(true);
  expect(providerBoundaryReceiptSchema.safeParse(x.receipt).success).toBe(true);
  expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence(x)).success).toBe(true);
});
it('requires the exact original owner, group association and same local-end event without an owner projection', () => {
  for (const mutate of [
    (x: ReturnType<typeof historicalBootBoundaryFixture>) => { x.plan.originalOwner.instanceId = 'another-owner'; },
    (x: ReturnType<typeof historicalBootBoundaryFixture>) => { x.plan.ownerAssociation.spawnedEventId++; },
    (x: ReturnType<typeof historicalBootBoundaryFixture>) => { x.plan.ownerAssociation.pid++; },
    (x: ReturnType<typeof historicalBootBoundaryFixture>) => { x.plan.ownerAssociation.runIdHash = '0'.repeat(64); },
    (x: ReturnType<typeof historicalBootBoundaryFixture>) => { x.plan.localEnd.eventId++; },
    (x: ReturnType<typeof historicalBootBoundaryFixture>) => { x.plan.currentIngressOwner.startedAt = '2026-10-24T18:00:00.001Z'; },
    (x: ReturnType<typeof historicalBootBoundaryFixture>) => { Object.assign(x.plan, { owner: x.plan.currentIngressOwner }); },
  ]) { const x = historicalBootBoundaryFixture(); mutate(x); expect(providerBoundaryPlanSchema.safeParse(x.plan).success).toBe(false); }
});
it('requires original proof hash, actual current ingress exit and a later fresh overlapping boot observation', () => {
  const x = historicalBootBoundaryFixture();
  expect(providerBoundaryPlanSchema.safeParse(x.plan).success).toBe(true);
  for (const mutate of [
    (v: typeof x) => { v.receipt.originalOwnerProofHash = '0'.repeat(64); },
    (v: typeof x) => { v.receipt.currentIngressOwner.identity.incarnationId = 'other-container'; },
    (v: typeof x) => { v.receipt.currentIngressOwner.observedAt = '2026-10-24T17:59:59.999Z'; },
    (v: typeof x) => { v.receipt.provider.bootWitness.dbBefore = '2026-10-24T18:09:59.999999Z'; },
    (v: typeof x) => { v.receipt.provider.bootWitness.uptimeNs = '1200000000000'; },
    (v: typeof x) => { v.receipt.version = 3; },
  ]) { const v = structuredClone(x); mutate(v); expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence(v)).success).toBe(false); }
  expect(validateProviderBoundary(providerBoundaryPlanSchema.parse(x.plan), providerBoundaryReceiptSchema.parse(x.receipt), '2026-10-24T18:18:00.000Z')).toBe(false);
});
it('retains strict native topology, canonical proof and microsecond boundary negatives in V4', () => {
  const x = historicalBootBoundaryFixture();
  for (const v of invalidHistoricalBootBoundaries(x)) {
    const p = v.plan as typeof x.plan, r = v.receipt as typeof x.receipt;
    if (r.planHash === x.receipt.planHash) r.planHash = providerBoundaryCanonicalHash(p);
    expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence({ plan: p, receipt: r })).success).toBe(false);
  }
});

it('accepts only the microsecond strictly before the boot lower bound for the historical local-end', () => {
  const x = historicalBootBoundaryFixture(), us = bootInterval(x.plan.bootWitness).lower - BigInt(1);
  x.plan.localEnd.endedAt = new Date(Number(us / BigInt(1000))).toISOString().slice(0, 23) + (us % BigInt(1000)).toString().padStart(3, '0') + 'Z';
  x.receipt.planHash = providerBoundaryCanonicalHash(x.plan);
  expect(providerBoundaryPlanSchema.safeParse(x.plan).success).toBe(true);
});

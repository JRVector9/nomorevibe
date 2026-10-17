import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { batchCanaryAnchorKey, batchPolicyHash, classifyBatchCandidateEvidence, classifyBatchReadiness } from '@/lib/jobs/batches';

const at = Date.parse('2026-10-17T12:00:00Z');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const input = () => ({
  candidate: { role: 'translation' as const, instanceId: 'anchor-oracle', host: 'oracle-osaka-smoke' as const,
    bootId: 'boot-one', release: 'release-one', policyHash: 'a'.repeat(64),
    capability: { host: 'oracle-osaka-smoke', release: 'release-one', instanceId: 'anchor-oracle',
      dbPrivileges: 'verified', dbRole: 'fixture-only', effectivePrivilegeHash: 'b'.repeat(64), http: 'verified',
      model: 'verified', modelBoundEvidenceHash: 'c'.repeat(64), observedAt: '2026-10-17T11:59:00Z' },
    resultEvidence: { job: 'product-tagline-ko', instanceId: 'anchor-oracle', host: 'oracle-osaka-smoke',
      release: 'release-one', requestedVersion: 7, domainReadbackHash: 'd'.repeat(64), observedAt: '2026-10-17T11:59:30Z' } },
  controlEpoch: 2, at, anchor: undefined as unknown,
  latest: [{ key: 'batch-result:anchor-oracle:product-tagline-ko', result: { role: 'text', batchEpoch: 1,
    job: 'product-tagline-ko', instanceId: 'anchor-oracle', host: 'oracle-osaka-smoke', release: 'release-one', bootId: 'boot-one',
    recordedAt: '2026-10-17T11:59:20Z', count: 1, requestedVersion: 7 } }],
});
function anchored() {
  const value = input(), { role, instanceId, host, bootId, release, policyHash } = value.candidate;
  value.anchor = { batchCanary: { version: 1, kind: 'verified_batch_canary',
    candidateIdentityHash: digest({ role, instanceId, host, bootId, release, policyHash, controlEpoch: value.controlEpoch }),
    readbackHash: digest(value.candidate.resultEvidence), result: structuredClone(value.latest[0].result) } };
  return value;
}

it('uses one bounded 77-character key per candidate, independent of ACK version', () => {
  expect(batchCanaryAnchorKey('translation', 'anchor-oracle')).toHaveLength(77);
  expect(batchCanaryAnchorKey('translation', 'anchor-oracle')).not.toBe(batchCanaryAnchorKey('text', 'anchor-oracle'));
});
it('keeps strict latest-only bootstrap and proposes the exact independently verified snapshot', () => {
  const value = input(), result = classifyBatchCandidateEvidence(value);
  expect(result.report).toEqual({ ready: true, reason: 'ready' });
  expect(result.selectedResult).toEqual(value.latest[0].result);
  expect(result.anchorToPin).toEqual(anchored().anchor);
});
it('keeps the verified historical ACK after the same canary job stores a newer ACK', () => {
  const value = anchored(); value.latest[0].result.requestedVersion = 8;
  value.latest[0].result.recordedAt = '2026-10-17T11:59:40Z';
  expect(classifyBatchReadiness({ ...value.candidate, evidence: value.candidate.capability,
    result: value.latest[0].result, readback: value.candidate.resultEvidence, at }).ready).toBe(false);
  const snapshot = structuredClone(value.anchor), result = classifyBatchCandidateEvidence(value);
  expect(result.report).toEqual({ ready: true, reason: 'ready' });
  expect(result.selectedResult?.requestedVersion).toBe(7); expect(result.anchorToPin).toBeUndefined();
  expect(value.anchor).toEqual(snapshot);
});
it.each([null, {}, { batchCanary: null }, { batchCanary: { version: 1 } }])('never falls back from malformed existing anchor %#', anchor => {
  const value = input(); value.anchor = anchor;
  expect(classifyBatchCandidateEvidence(value).report.ready).toBe(false);
});
it.each(['bootId', 'release', 'instanceId', 'host', 'policyHash'] as const)('rejects changed candidate %s even when latest otherwise matches', key => {
  const value = anchored(); Object.assign(value.candidate, { [key]: 'changed' });
  expect(classifyBatchCandidateEvidence(value).report.ready).toBe(false);
});
it('rejects a changed control epoch without replacing the anchor', () => {
  const value = anchored(); value.controlEpoch += 1;
  const result = classifyBatchCandidateEvidence(value); expect(result.report.ready).toBe(false); expect(result.anchorToPin).toBeUndefined();
});
it.each(['requestedVersion', 'domainReadbackHash', 'observedAt'] as const)('binds every operator readback field: %s', key => {
  const value = anchored(); Object.assign(value.candidate.resultEvidence, { [key]: key === 'requestedVersion' ? 8 : 'changed' });
  expect(classifyBatchCandidateEvidence(value).report.ready).toBe(false);
});
it('keeps the original 24-hour ACK age and never recertifies using a fresh latest result', () => {
  const value = anchored(); value.at += 24 * 60 * 60_000;
  value.candidate.capability.observedAt = new Date(value.at - 1000).toISOString();
  value.latest[0].result.recordedAt = new Date(value.at - 2000).toISOString();
  expect(classifyBatchCandidateEvidence(value).report).toEqual({ ready: false, reason: 'result_stale' });
});
it('keeps the original 15-minute capability age even while anchor ACK remains recent', () => {
  const value = anchored(); value.at += 16 * 60_000;
  expect(classifyBatchCandidateEvidence(value).report).toEqual({ ready: false, reason: 'capability_stale' });
});
it('allows an actual current capability refresh without rewriting the original ACK or readback', () => {
  const value = anchored(); value.at += 16 * 60_000; value.candidate.capability.observedAt = new Date(value.at - 1000).toISOString();
  expect(classifyBatchCandidateEvidence(value).report.ready).toBe(true);
});
it('refuses unknown capability and missing operator readback rather than minting a canary', () => {
  const value = input(); value.candidate.capability.model = 'unknown';
  expect(classifyBatchCandidateEvidence(value).report.ready).toBe(false);
  Object.assign(value.candidate, { resultEvidence: null });
  expect(classifyBatchCandidateEvidence(value).anchorToPin).toBeUndefined();
});
it('keeps historical role/boot/epoch fields unchanged for the stricter Oracle caller', () => {
  const result = classifyBatchCandidateEvidence(anchored());
  expect(result.selectedResult).toMatchObject({ role: 'text', bootId: 'boot-one', batchEpoch: 1 });
});
it('does not accept a result under a different latest observation key', () => {
  const value = input(); value.latest[0].key = 'batch-result:other:product-tagline-ko';
  expect(classifyBatchCandidateEvidence(value).report.ready).toBe(false);
});


it.each(['bootId', 'controlEpoch', 'readback'] as const)('requires operator anchor removal and a newly verified readback after %s changes', key => {
  const value = anchored(), original = structuredClone(value.anchor);
  value.latest[0].result.requestedVersion = 8; value.latest[0].result.recordedAt = '2026-10-17T11:59:40Z';
  if (key === 'bootId') value.candidate.bootId = 'boot-two';
  if (key === 'controlEpoch') value.controlEpoch += 1;
  if (key === 'readback') value.candidate.resultEvidence.domainReadbackHash = 'e'.repeat(64);
  expect(classifyBatchCandidateEvidence(value).report.ready).toBe(false);
  expect(value.anchor).toEqual(original);
  value.anchor = undefined;
  expect(classifyBatchCandidateEvidence(value).report).toEqual({ ready: false, reason: 'result_unverified' });
  value.candidate.resultEvidence = { ...value.candidate.resultEvidence, requestedVersion: 8,
    domainReadbackHash: 'f'.repeat(64), observedAt: '2026-10-17T11:59:50Z' };
  const repin = classifyBatchCandidateEvidence(value);
  expect(repin.report).toEqual({ ready: true, reason: 'ready' }); expect(repin.anchorToPin).toBeDefined();
  value.anchor = repin.anchorToPin;
  expect(classifyBatchCandidateEvidence(value)).toMatchObject({ report: { ready: true }, selectedResult: { requestedVersion: 8 } });
  expect(classifyBatchCandidateEvidence(value).anchorToPin).toBeUndefined();
});

const acquisition = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { transaction: acquisition.transaction }, onPrimary: <T>(load: () => T) => load() }));
it.each([0, 2000])('returns the same owner only while its original lease is still live after a pin wait of %i ms', async waitMs => {
  const value = input(), policy = { version: 1 as const, release: value.candidate.release,
    instances: [{ instanceId: value.candidate.instanceId, host: value.candidate.host }] };
  value.candidate.policyHash = batchPolicyHash(policy);
  const candidate = { ...value.candidate, kind: 'primary' as const, batchVersion: 1 as const };
  const anchor = classifyBatchCandidateEvidence(value).anchorToPin;
  const owner = { ownerInstanceId: candidate.instanceId, ownerBootId: candidate.bootId, ownerRelease: candidate.release,
    epoch: 3, leaseUntil: new Date(at + 1000) };
  const selections = [[{ mode: 'versioned', epoch: value.controlEpoch, writerContractVersion: 1, policy, policyHash: candidate.policyHash }],
    [owner], [{ now: new Date(at).toISOString() }], [candidate],
    [{ key: value.latest[0].key, value: { batchResult: value.latest[0].result } }],
    [{ key: batchCanaryAnchorKey(candidate.role, candidate.instanceId), value: anchor }]];
  const select = vi.fn(() => {
    const promise = Promise.resolve(selections.shift());
    return Object.assign(promise, { from: () => promise, where: () => promise, for: () => promise });
  });
  const tx = { select, insert: vi.fn(() => ({ values: () => ({ onConflictDoNothing: async () => {}, onConflictDoUpdate: async () => {} }) })),
    update: vi.fn(), execute: vi.fn().mockResolvedValueOnce([{ at: new Date(at).toISOString() }])
      .mockResolvedValueOnce([{ at: new Date(at + waitMs).toISOString() }]) };
  acquisition.transaction.mockImplementationOnce((body: (tx: unknown) => Promise<unknown>) => body(tx));
  const { acquireBatchRole } = await import('@/lib/jobs/batch-repository');
  const result = await acquireBatchRole({ role: candidate.role, instanceId: candidate.instanceId, bootId: candidate.bootId,
    release: candidate.release, kind: candidate.kind, batchVersion: candidate.batchVersion, host: candidate.host });
  if (waitMs === 0) expect(result).toMatchObject({ epoch: owner.epoch, batchEpoch: value.controlEpoch });
  else expect(result).toBeNull();
  expect(tx.update).not.toHaveBeenCalled(); expect(owner.leaseUntil).toEqual(new Date(at + 1000));
});

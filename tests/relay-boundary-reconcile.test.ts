import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { fileRelayReceiptStore } from '@/scripts/local-model-relay/store';
import { checkRelayBoundaryPending, reconcileRelayBoundary, type RelayBoundaryProof } from '@/scripts/local-model-relay/boundary-reconcile';
import type { RelayReceipt } from '@/scripts/local-model-relay/protocol';
import { providerBoundaryPlanSchema, providerBoundaryReceiptSchema } from '@/lib/llm/provider-boundary-contract';
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-recovery-')); directories.push(dir);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const receipt: RelayReceipt = { protocol: 1, requestId: randomUUID(), relayGeneration: randomUUID(), relayRevision: 'r1', deploymentRevision: 'd1',
    requestModel: 'Fixture Model', requestHash: hash('fixture wire'), startedAt: '2026-10-28T14:00:00.000Z', state: 'in_flight', endedAt: null,
    upstreamStatus: null, responseHash: null, responseBytes: 0, terminal: null, error: null };
  const store = fileRelayReceiptStore(dir); store.begin(receipt);
  store.finish({ ...receipt, state: 'indeterminate', endedAt: '2026-10-28T14:01:30.000Z', upstreamStatus: 200,
    responseHash: hash('partial fixture'), responseBytes: 1844, error: 'upstream_timeout' });
  const proof: RelayBoundaryProof = { requestId: receipt.requestId, model: receipt.requestModel, wireHash: receipt.requestHash,
    planHash: hash('plan'), bindingHash: hash('binding'), releaseEvidenceHash: hash('evidence') };
  const bytes = readFileSync(join(dir, `${receipt.requestId}.json`));
  return { dir, receipt, proof, store, bytes };
}
it('clears only the exact marker after DB proof, preserves the original timeout bytes, archives first, and survives an exact retry', () => {
  const f = fixture(); checkRelayBoundaryPending(f.dir, f.receipt.requestId);
  expect(reconcileRelayBoundary(f.dir, f.proof)).toEqual({ kind: 'cleared', requestId: f.receipt.requestId });
  expect(f.store.hasUnsettled()).toBe(false);
  expect(readFileSync(join(f.dir, `${f.receipt.requestId}.json`))).toEqual(f.bytes);
  expect(JSON.parse(readFileSync(join(f.dir, `${f.receipt.requestId}.boundary-release.json`), 'utf8'))).toMatchObject({
    kind: 'provider_boundary_reconciled', proof: f.proof });
  expect(reconcileRelayBoundary(f.dir, f.proof).kind).toBe('already_cleared');
  expect(() => reconcileRelayBoundary(f.dir, { ...f.proof, planHash: '0'.repeat(64) })).toThrow('relay_recovery_archive_mismatch');
});
it.each(['wireHash', 'model', 'requestId'] as const)('refuses a different %s and leaves the slot blocked', key => {
  const f = fixture(), patch = { [key]: key === 'requestId' ? randomUUID() : key === 'wireHash' ? '0'.repeat(64) : 'Other Model' };
  expect(() => reconcileRelayBoundary(f.dir, { ...f.proof, ...patch })).toThrow();
  expect(f.store.hasUnsettled()).toBe(true);
  expect(readFileSync(join(f.dir, `${f.receipt.requestId}.json`))).toEqual(f.bytes);
});
it.each(['in_flight', 'response_complete'] as const)('never repairs a %s receipt through the unknown path', state => {
  const f = fixture(); writeFileSync(join(f.dir, `${f.receipt.requestId}.json`), JSON.stringify({ ...f.receipt, state }));
  expect(() => reconcileRelayBoundary(f.dir, f.proof)).toThrow('relay_recovery_request_mismatch');
  expect(f.store.hasUnsettled()).toBe(true);
});
it('refuses another relay generation or a competing request and never overwrites a conflicting archive', () => {
  const f = fixture(), active = join(f.dir, 'active.json');
  const original = readFileSync(active);
  writeFileSync(active, JSON.stringify({ requestId: f.receipt.requestId, relayGeneration: randomUUID() }));
  expect(() => checkRelayBoundaryPending(f.dir, f.receipt.requestId)).toThrow();
  writeFileSync(active, original);
  const archive = join(f.dir, `${f.receipt.requestId}.boundary-release.json`);
  writeFileSync(archive, 'keep this conflicting record');
  expect(() => reconcileRelayBoundary(f.dir, f.proof)).toThrow('relay_recovery_archive_mismatch');
  expect(readFileSync(archive, 'utf8')).toBe('keep this conflicting record');
  expect(existsSync(active)).toBe(true);
});
it('resumes after the archive fsync but before marker removal without losing either original', () => {
  const f = fixture(), active = readFileSync(join(f.dir, 'active.json'));
  reconcileRelayBoundary(f.dir, f.proof);
  writeFileSync(join(f.dir, 'active.json'), active);
  expect(reconcileRelayBoundary(f.dir, f.proof).kind).toBe('cleared');
  expect(readFileSync(join(f.dir, `${f.receipt.requestId}.json`))).toEqual(f.bytes);
});

it('dry run never clears the marker; apply waits for committed readback; a failed post-commit repair remains explicit and retryable', async () => {
  const { runBoundaryRelease } = await import('@/scripts/ops/model-provider-boundary-release');
  const { boundaryFixture } = await import('./fixtures/provider-boundary-release');
  const { providerBoundaryPlanHash } = await import('@/lib/llm/provider-boundary-contract');
  const { vi } = await import('vitest');
  const f = fixture(), boundary = boundaryFixture(); boundary.plan.request.requestId = f.receipt.requestId;
  const input = { plan: providerBoundaryPlanSchema.parse(boundary.plan), receipt: providerBoundaryReceiptSchema.parse(boundary.receipt),
    apply: false, expectedPlanHash: providerBoundaryPlanHash(boundary.plan), operator: 'fixture',
    reference: 'synthetic boundary', relayStateDirectory: f.dir };
  const release = vi.fn().mockResolvedValue({ kind: 'released', requestId: f.receipt.requestId });
  const readProof = vi.fn().mockResolvedValue(f.proof);
  const dry = await runBoundaryRelease(input, { release, readProof });
  expect(dry).toMatchObject({ dryRun: true, relay: { kind: 'dry_run_unchanged' } });
  expect(readProof).not.toHaveBeenCalled(); expect(f.store.hasUnsettled()).toBe(true);
  readProof.mockRejectedValueOnce(new Error('private DB error must not be printed'));
  const failed = await runBoundaryRelease({ ...input, apply: true }, { release, readProof });
  expect(failed).toMatchObject({ dryRun: false, result: { kind: 'released' }, relay: { kind: 'blocked', reason: 'relay_recovery_postcommit_failed' } });
  expect(f.store.hasUnsettled()).toBe(true);
  release.mockResolvedValueOnce({ kind: 'already_released', requestId: f.receipt.requestId });
  const retry = await runBoundaryRelease({ ...input, apply: true }, { release, readProof });
  expect(retry).toMatchObject({ result: { kind: 'already_released' }, relay: { kind: 'cleared' } });
  expect(f.store.hasUnsettled()).toBe(false);
  expect(readFileSync(join(f.dir, `${f.receipt.requestId}.json`))).toEqual(f.bytes);
});
it('a rejected DB release cannot clear the local marker or call the proof reader', async () => {
  const { runBoundaryRelease } = await import('@/scripts/ops/model-provider-boundary-release');
  const { boundaryFixture } = await import('./fixtures/provider-boundary-release');
  const { providerBoundaryPlanHash } = await import('@/lib/llm/provider-boundary-contract');
  const { vi } = await import('vitest');
  const f = fixture(), boundary = boundaryFixture(); boundary.plan.request.requestId = f.receipt.requestId;
  const input = { plan: providerBoundaryPlanSchema.parse(boundary.plan), receipt: providerBoundaryReceiptSchema.parse(boundary.receipt),
    apply: true, expectedPlanHash: providerBoundaryPlanHash(boundary.plan), operator: 'fixture',
    reference: 'synthetic boundary', relayStateDirectory: f.dir };
  const release = vi.fn().mockRejectedValue(new Error('provider_boundary_request_conflict')), readProof = vi.fn();
  await expect(runBoundaryRelease(input, { release, readProof })).rejects.toThrow('provider_boundary_request_conflict');
  expect(readProof).not.toHaveBeenCalled(); expect(f.store.hasUnsettled()).toBe(true);
});

it('a concurrent repair excludes both another repair and a new upstream dispatch, without stealing a stale lock', async () => {
  const { LOCAL_MODEL_RELAY_RECOVERY_LOCK } = await import('@/scripts/local-model-relay/protocol');
  const f = fixture(), lockPath = join(f.dir, LOCAL_MODEL_RELAY_RECOVERY_LOCK);
  writeFileSync(lockPath, 'original recovery owner');
  expect(() => reconcileRelayBoundary(f.dir, f.proof)).toThrow('relay_recovery_locked');
  expect(() => f.store.begin({ ...f.receipt, requestId: randomUUID() })).toThrow('relay_recovery_locked');
  expect(readFileSync(lockPath, 'utf8')).toBe('original recovery owner');
  expect(f.store.hasUnsettled()).toBe(true);
});

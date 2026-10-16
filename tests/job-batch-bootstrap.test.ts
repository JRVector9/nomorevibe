import { expect, it } from 'vitest';
import { BATCH_BOOTSTRAP_TTL_MS, BATCH_ROLES, batchBootstrapEligible, classifyBatchBootstrap, classifyBatchCandidateEvidence,
  type BatchCanaryCandidate } from '@/lib/jobs/batches';

const at = Date.parse('2026-10-17T00:05:00.000Z'), release = 'a'.repeat(40), policyHash = 'b'.repeat(64);
const capability = { host: 'oracle-osaka-smoke', release, instanceId: 'oracle-site', dbPrivileges: 'verified', dbRole: 'nomorevibe_oracle_site_evidence',
  effectivePrivilegeHash: 'c'.repeat(64), http: 'verified', model: 'unknown', observedAt: '2026-10-17T00:04:00.000Z' };
const grant = (change: Record<string, unknown> = {}) => ({ batchBootstrap: { version: 1, kind: 'first_ack_bootstrap', role: 'site-evidence',
  instanceId: 'oracle-site', host: 'oracle-osaka-smoke', bootId: 'boot-1', release, policyHash, controlEpoch: 4, job: 'product-site-evidence-refresh',
  issuedAt: '2026-10-17T00:04:00.000Z', expiresAt: '2026-10-17T00:14:00.000Z', ...change } });
const candidate = (change: Partial<BatchCanaryCandidate> = {}): BatchCanaryCandidate => ({ role: 'site-evidence', instanceId: 'oracle-site',
  host: 'oracle-osaka-smoke', bootId: 'boot-1', release, policyHash, capability, resultEvidence: grant(), ...change });
const input = (change: Partial<BatchCanaryCandidate> = {}, prior = false, now = at) => ({ candidate: candidate(change), controlEpoch: 4, at: now, prior });

it('limits bootstrap to roles whose versioned jobs have no legacy parent', () => {
  expect(BATCH_ROLES.filter(batchBootstrapEligible)).toEqual(['site-evidence']);
});

it('accepts only an exact, unexpired, first-ever operator grant with an attested capability', () => {
  expect(classifyBatchBootstrap(input())).toEqual({ ready: true, reason: 'bootstrap_granted' });
  // The normal readiness path never treats a grant as result evidence.
  expect(classifyBatchCandidateEvidence({ candidate: candidate(), controlEpoch: 4, at, anchor: undefined, latest: [] }).report)
    .toEqual({ ready: false, reason: 'result_unknown' });
});

it.each([
  ['no grant', { resultEvidence: null }, 'bootstrap_grant_absent'],
  ['a normal readback', { resultEvidence: { job: 'product-site-evidence-refresh', instanceId: 'oracle-site', host: 'oracle-osaka-smoke', release,
    requestedVersion: 1, domainReadbackHash: 'd'.repeat(64), observedAt: '2026-10-17T00:04:00.000Z' } }, 'bootstrap_grant_absent'],
  ['an extra grant field', { resultEvidence: { batchBootstrap: { ...grant().batchBootstrap, ready: true } } }, 'bootstrap_grant_absent'],
  ['another boot', { bootId: 'boot-2' }, 'bootstrap_grant_mismatch'],
  ['another release', { release: 'e'.repeat(40) }, 'bootstrap_grant_mismatch'],
  ['another policy', { policyHash: 'f'.repeat(64) }, 'bootstrap_grant_mismatch'],
  ['another host', { host: 'm3' }, 'bootstrap_grant_mismatch'],
  ['a legacy-parent role', { role: 'product-health', resultEvidence: grant({ role: 'product-health', job: 'uptime-ping' }) }, 'bootstrap_grant_mismatch'],
  ['another job', { resultEvidence: grant({ job: 'uptime-ping' }) }, 'bootstrap_grant_mismatch'],
  ['another batch epoch', { resultEvidence: grant({ controlEpoch: 3 }) }, 'bootstrap_grant_mismatch'],
  ['an over-long grant', { resultEvidence: grant({ expiresAt: new Date(Date.parse('2026-10-17T00:04:00.000Z') + BATCH_BOOTSTRAP_TTL_MS + 1).toISOString() }) }, 'bootstrap_grant_expired'],
  ['a future grant', { resultEvidence: grant({ issuedAt: '2026-10-17T00:05:01.000Z' }) }, 'bootstrap_grant_expired'],
  ['an unverified capability', { capability: { ...capability, http: 'unknown' } }, 'capability_unknown'],
  ['a stale capability', { capability: { ...capability, observedAt: '2026-10-16T23:49:00.000Z' } }, 'capability_stale'],
] as const)('refuses %s', (_name, change, reason) => {
  expect(classifyBatchBootstrap(input(change as Partial<BatchCanaryCandidate>))).toEqual({ ready: false, reason });
});

it('ends at expiry and as soon as any ACK or anchor exists for the role instance', () => {
  expect(classifyBatchBootstrap(input({}, false, Date.parse('2026-10-17T00:14:00.000Z')))).toEqual({ ready: false, reason: 'bootstrap_grant_expired' });
  expect(classifyBatchBootstrap(input({}, true))).toEqual({ ready: false, reason: 'bootstrap_prior_evidence' });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it, vi } from 'vitest';
import { modelCapacityRequests } from '@/lib/db/schema';
import { BATCH_BOOTSTRAP_TTL_MS, BATCH_RESULT_MAX_AGE_MS, batchCanaryAnchorKey, batchPolicyHash, classifyBatchCandidateEvidence, classifyBatchRecanary,
  type BatchCanaryCandidate } from '@/lib/jobs/batches';
import { oracleCanaryMain } from '@/lib/runtime/oracle-canary-cli';

// PR11e: Oracle 활성화의 남은 공백. 실제 DB 경로는 tests/integration/oracle-db-roles.test.ts · dr-followups.test.ts 가 본다.
const io = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('@/lib/db', async original => ({ ...await original<typeof import('@/lib/db')>(), db: { transaction: io.transaction },
  onPrimary: <T>(load: () => T) => load() }));

// ---- 1. versioned admission(=claim·domain writer 관문)도 DR writer fence 를 본다 ----
const lineage = '6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11', boot = '0a6bd6a3-6c2a-4f6e-9a39-2d6f7b0e5c21';
const fenceRow = (state: 'active' | 'fenced') => ({ lineage_id: lineage, writer_epoch: 3, state, promotion_id: null,
  reason: state === 'fenced' ? 'operator_fence' : null,
  fenced_db: state === 'fenced' ? { systemIdentifier: '7000000000000000001', databaseOid: '16384', databaseName: 'nomorevibe' } : null });
const batchPolicy = { version: 1 as const, release: 'r1', instances: [{ instanceId: 'oracle-1', host: 'oracle-osaka-smoke' as const }] };
const lease = { role: 'translation' as const, instanceId: 'oracle-1', bootId: boot, release: 'r1', kind: 'primary' as const,
  batchVersion: 1 as const, host: 'oracle-osaka-smoke' as const, epoch: 4, batchEpoch: 2 };
function admissionTx(mode: 'legacy' | 'versioned', fence: 'active' | 'fenced') {
  const order: string[] = [];
  const control = { id: 1, mode, drainingFrom: null, epoch: 2, writerContractVersion: 1, policy: batchPolicy, policyHash: batchPolicyHash(batchPolicy) };
  const tx = {
    select: vi.fn(() => ({ from: (table: object) => {
      const name = String(Reflect.get(table, Symbol.for('drizzle:Name')));
      const chain = { where: () => chain, for: async (lock: string) => {
        order.push(`${name}:${lock}`);
        if (name === 'job_batch_control') return [control];
        throw new Error(`${name}_reached`);
      } };
      return chain;
    } })),
    execute: vi.fn(async (query: { queryChunks?: unknown[] }) => { order.push(`execute:${JSON.stringify(query.queryChunks ?? query)}`); return [fenceRow(fence)]; }),
  };
  return { tx, order };
}

it('blocks a versioned claim on a fenced writer site after the batch lock and before any role or candidate row', async () => {
  const { assertJobBatchAdmission, JobBatchBlockedError } = await import('@/lib/jobs/batch-repository');
  const { tx, order } = admissionTx('versioned', 'fenced');
  await expect(assertJobBatchAdmission(tx as never, 'reason-translate', lease)).rejects.toBeInstanceOf(JobBatchBlockedError);
  expect(order).toHaveLength(2);
  expect(order[0]).toBe('job_batch_control:share');
  expect(order[1]).toContain('dr_writer_fence'); expect(order[1]).toContain('FOR SHARE');
});

it('lets an active site continue to the existing role admission unchanged', async () => {
  const { assertJobBatchAdmission } = await import('@/lib/jobs/batch-repository');
  const { tx, order } = admissionTx('versioned', 'active');
  await expect(assertJobBatchAdmission(tx as never, 'reason-translate', lease)).rejects.toThrow('role_leases_reached');
  expect(order.map(entry => entry.split(':')[0])).toEqual(['job_batch_control', 'execute', 'role_leases']);
});

it('keeps legacy admission free of the fence read (legacy roles are fenced at acquire/renew)', async () => {
  const { assertJobBatchAdmission } = await import('@/lib/jobs/batch-repository');
  const { tx } = admissionTx('legacy', 'fenced');
  await expect(assertJobBatchAdmission(tx as never, 'product-evidence-refresh')).resolves.toBeNull();
  expect(tx.execute).not.toHaveBeenCalled();
});

// ---- 3. 24h stale 결과의 재선출: operator re-canary grant 만, strict 검증은 그대로 ----
const at = Date.parse('2026-10-17T00:05:00.000Z'), release = 'a'.repeat(40), policyHash = 'b'.repeat(64), instanceId = 'oracle-health';
const iso = (ms: number) => new Date(ms).toISOString(), DAY = BATCH_RESULT_MAX_AGE_MS;
const capability = { host: 'oracle-osaka-smoke', release, instanceId, dbPrivileges: 'verified', dbRole: 'nomorevibe_oracle_product_health',
  effectivePrivilegeHash: 'c'.repeat(64), http: 'verified', model: 'unknown', observedAt: iso(at - 60_000) };
const grant = (change: Record<string, unknown> = {}) => ({ batchRecanary: { version: 1, kind: 'stale_result_recanary', role: 'product-health',
  instanceId, host: 'oracle-osaka-smoke', bootId: 'boot-new', release, policyHash, controlEpoch: 4, job: 'uptime-ping',
  issuedAt: iso(at - 60_000), expiresAt: iso(at - 60_000 + BATCH_BOOTSTRAP_TTL_MS), ...change } });
const result = (recordedAt: number, change: Record<string, unknown> = {}) => ({ role: 'product-health', batchEpoch: 4, job: 'uptime-ping', instanceId,
  host: 'oracle-osaka-smoke', release, bootId: 'boot-old', recordedAt: iso(recordedAt), count: 1, requestedVersion: 9, ...change });
const row = (recordedAt: number, change: Record<string, unknown> = {}) => ({ key: `batch-result:${instanceId}:uptime-ping`, result: result(recordedAt, change) });
const anchorOf = (recordedAt: number) => ({ batchCanary: { version: 1, kind: 'verified_batch_canary', candidateIdentityHash: 'd'.repeat(64),
  readbackHash: 'e'.repeat(64), result: result(recordedAt) } });
const candidate = (change: Partial<BatchCanaryCandidate> = {}): BatchCanaryCandidate => ({ role: 'product-health', instanceId, host: 'oracle-osaka-smoke',
  bootId: 'boot-new', release, policyHash, capability, resultEvidence: grant(), ...change });
const recanary = (change: Partial<BatchCanaryCandidate> = {}, prior: { anchor?: unknown; latest?: { key: string; result: unknown }[] } = { latest: [row(at - DAY - 1)] }, now = at) =>
  classifyBatchRecanary({ candidate: candidate(change), controlEpoch: 4, at: now, anchor: prior.anchor, latest: prior.latest ?? [] });

it('reopens exactly one granted boot only while every stored result of the instance is older than the readiness limit', () => {
  expect(recanary()).toEqual({ ready: true, reason: 'recanary_granted' });
  expect(recanary({}, { anchor: anchorOf(at - 3 * DAY), latest: [row(at - DAY - 5_000)] })).toEqual({ ready: true, reason: 'recanary_granted' });
  // Exactly the readiness boundary: a result that classifyBatchReadiness still accepts is not stale.
  expect(recanary({}, { latest: [row(at - DAY)] })).toEqual({ ready: false, reason: 'recanary_prior_fresh' });
  // The first new ACK (or any fresh anchor) ends the grant; the normal attest/canary path takes over.
  expect(recanary({}, { latest: [row(at - DAY - 1), { key: `batch-result:${instanceId}:uptime-ping`, result: result(at - 1_000) }] }))
    .toEqual({ ready: false, reason: 'recanary_prior_fresh' });
  expect(recanary({}, { anchor: anchorOf(at - 60_000), latest: [row(at - DAY - 1)] })).toEqual({ ready: false, reason: 'recanary_prior_fresh' });
  expect(recanary({}, { latest: [row(at + 1_000)] })).toEqual({ ready: false, reason: 'recanary_prior_fresh' });
  // A first-ever instance has nothing to re-canary (seed / bootstrap remain the only first-ACK paths).
  expect(recanary({}, { latest: [] })).toEqual({ ready: false, reason: 'recanary_prior_absent' });
});

it('never treats a re-canary grant as result evidence on the normal readiness path', () => {
  expect(classifyBatchCandidateEvidence({ candidate: candidate(), controlEpoch: 4, at, anchor: undefined, latest: [row(at - 1_000)] }).report)
    .toEqual({ ready: false, reason: 'result_unverified' });
  const { role, host, bootId } = candidate(), anchor = anchorOf(at - 1_000);
  anchor.batchCanary.candidateIdentityHash = createHash('sha256').update(JSON.stringify({ role, instanceId, host, bootId, release, policyHash, controlEpoch: 4 })).digest('hex');
  expect(classifyBatchCandidateEvidence({ candidate: candidate(), controlEpoch: 4, at, anchor, latest: [] }).report)
    .toEqual({ ready: false, reason: 'anchor_readback_mismatch' });
});

it.each([
  ['no grant', { resultEvidence: null }, 'recanary_grant_absent'],
  ['a first-ACK bootstrap grant', { resultEvidence: { batchBootstrap: { ...grant().batchRecanary, kind: 'first_ack_bootstrap' } } }, 'recanary_grant_absent'],
  ['an extra grant field', { resultEvidence: { batchRecanary: { ...grant().batchRecanary, ready: true } } }, 'recanary_grant_absent'],
  ['another boot', { bootId: 'boot-other' }, 'recanary_grant_mismatch'],
  ['another release', { release: 'f'.repeat(40) }, 'recanary_grant_mismatch'],
  ['another policy', { policyHash: 'f'.repeat(64) }, 'recanary_grant_mismatch'],
  ['another host', { host: 'm3' }, 'recanary_grant_mismatch'],
  ['another role', { role: 'official-news' }, 'recanary_grant_mismatch'],
  ['a job of another role', { resultEvidence: grant({ job: 'news-refresh' }) }, 'recanary_grant_mismatch'],
  ['another batch epoch', { resultEvidence: grant({ controlEpoch: 3 }) }, 'recanary_grant_mismatch'],
  ['an over-long grant', { resultEvidence: grant({ expiresAt: iso(at - 60_000 + BATCH_BOOTSTRAP_TTL_MS + 1) }) }, 'recanary_grant_expired'],
  ['a future grant', { resultEvidence: grant({ issuedAt: iso(at + 1), expiresAt: iso(at + 1 + BATCH_BOOTSTRAP_TTL_MS) }) }, 'recanary_grant_expired'],
  ['an expired grant', { resultEvidence: grant({ issuedAt: iso(at - BATCH_BOOTSTRAP_TTL_MS), expiresAt: iso(at) }) }, 'recanary_grant_expired'],
  ['an unverified capability', { capability: { ...capability, http: 'unknown' } }, 'capability_unknown'],
  ['a stale capability', { capability: { ...capability, observedAt: iso(at - 16 * 60_000) } }, 'capability_stale'],
] as const)('refuses %s', (_name, change, reason) => {
  expect(recanary(change as Partial<BatchCanaryCandidate>)).toEqual({ ready: false, reason });
});

it.each([
  ['a malformed stored result', { latest: [{ key: `batch-result:${instanceId}:uptime-ping`, result: { job: 'uptime-ping' } }] }],
  ['a result of another instance', { latest: [row(at - DAY - 1, { instanceId: 'oracle-other' })] }],
  ['a result under another key', { latest: [{ key: `batch-result:${instanceId}:news-refresh`, result: result(at - DAY - 1) }] }],
  ['a malformed anchor', { anchor: { batchCanary: null }, latest: [row(at - DAY - 1)] }],
])('fails closed on %s', (_name, prior) => {
  expect(recanary({}, prior)).toEqual({ ready: false, reason: 'recanary_prior_unknown' });
});

it('keeps the translation model proof requirement for a re-canary', () => {
  const translation = (model: Record<string, unknown>) => recanary({ role: 'translation', capability: { ...capability, ...model },
    resultEvidence: grant({ role: 'translation', job: 'product-translate' }) }, { latest: [{ key: `batch-result:${instanceId}:product-translate`,
    result: result(at - DAY - 1, { role: 'translation', job: 'product-translate' }) }] });
  expect(translation({})).toEqual({ ready: false, reason: 'capability_unknown' });
  expect(translation({ model: 'verified', modelBoundEvidenceHash: 'f'.repeat(64) })).toEqual({ ready: true, reason: 'recanary_granted' });
  expect(batchCanaryAnchorKey('translation', instanceId)).not.toBe(batchCanaryAnchorKey('product-health', instanceId));
});

it('accepts recanary only with an explicit role and job and still refuses before any database connection', async () => {
  const env = { JOB_BATCH_VERSION: '1', PHYSICAL_HOST: 'oracle-osaka-smoke', SERVICE_INSTANCE_ID: 'oracle-health', RELEASE_TAG: release,
    DATABASE_URL: 'postgres://worker@db/x', ORACLE_ATTEST_DATABASE_URL: 'postgres://attest@db/x' };
  for (const [args, values, identity, code] of [
    [['recanary', '--role=product-health'], env, true, 'oracle_canary_arguments_invalid'],
    [['recanary', '--role=product-health', '--job=uptime-ping', '--force'], env, true, 'oracle_canary_arguments_invalid'],
    [['recanary', '--role=product-health', '--job=uptime-ping'], { ...env, ORACLE_ATTEST_DATABASE_URL: undefined }, true, 'oracle_canary_arguments_invalid'],
    [['recanary', '--role=product-health', '--job=uptime-ping'], { ...env, PHYSICAL_HOST: 'm3' }, true, 'oracle_canary_identity_invalid'],
    [['recanary', '--role=product-health', '--job=uptime-ping'], env, false, 'oracle_identity_unverified'],
  ] as Array<[string[], Record<string, string | undefined>, boolean, string]>) {
    const lines: string[] = [], connect = vi.fn(() => { throw new Error('no database in this unit'); });
    expect(await oracleCanaryMain(args, values, { identity: () => identity, connect, write: line => lines.push(line) })).toBe(78);
    expect(lines).toEqual([JSON.stringify({ code })]); expect(connect).not.toHaveBeenCalled();
  }
});

// ---- 2·4. migration 0098: 새 trigger·index 만(기존 CHECK·grant·열 불변) ----
it('adds 0098 as the next journal entry with only an insert-evidence guard trigger and the model readback index', () => {
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
  expect(journal.entries.find(entry => entry.tag === '0098_oracle_activation_gaps'))
    .toEqual({ idx: 98, version: '7', when: 1794086400010, tag: '0098_oracle_activation_gaps', breakpoints: true });
  const text = readFileSync('drizzle/0098_oracle_activation_gaps.sql', 'utf8');
  const statements = text.split('--> statement-breakpoint').map(part => part.replace(/^--.*$/gm, '').trim()).filter(Boolean);
  expect(statements.map(statement => statement.split(/\s+/).slice(0, 3).join(' '))).toEqual(['CREATE FUNCTION job_batch_candidates_evidence_insert_guard()',
    'CREATE TRIGGER job_batch_candidates_evidence_insert_guard', 'CREATE INDEX model_capacity_requests_job_readback_idx']);
  expect(statements.join('\n')).not.toMatch(/\b(DROP|ALTER|GRANT|REVOKE|DELETE|TRUNCATE|UPDATE\s+\w+\s+SET)\b/i);
  expect(getTableConfig(modelCapacityRequests).indexes.map(index => index.config.name)).toContain('model_capacity_requests_job_readback_idx');
});

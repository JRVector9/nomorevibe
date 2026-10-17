import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { batchCanaryAnchorKey, batchPolicyHash } from '@/lib/jobs/batches';
import { acquireBatchRole, batchLeaseAdmission, releaseBatchRole, renewBatchRole } from '@/lib/jobs/batch-repository';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

// 실제 DB: 선출된 versioned lease 는 결과가 24시간을 넘으면 claim 이 모두 막히는데 갱신은 계속 성공한다(readiness 를 보지 않음).
// role-worker 가 그 상태를 찾는 batchLeaseAdmission 술어를 본다. 시간 경과는 저장된 결과 시각을 옮겨 재현한다.
const prefix = `f4adm-${randomUUID().slice(0, 8)}`, job = 'uptime-ping', role = 'product-health' as const, boot = randomUUID();
const policy = { version: 1 as const, release: prefix, instances: [{ instanceId: prefix, host: 'oracle-osaka-smoke' as const }] };
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
let control: Record<string, unknown> | undefined;
const resultKey = `batch-result:${prefix}:${job}`, anchorKey = batchCanaryAnchorKey(role, prefix);

beforeAll(async () => {
  ensureSchema();
  [control] = await admin`SELECT mode, draining_from, writer_contract_version, policy, policy_hash, epoch FROM job_batch_control WHERE id = 1`;
  const [busy] = await admin`SELECT count(*)::int AS n FROM role_leases WHERE role = ${role} AND owner_instance_id IS NOT NULL AND lease_until > clock_timestamp()`;
  expect(busy.n).toBe(0);
  await admin`UPDATE job_batch_control SET mode = 'versioned', draining_from = NULL, writer_contract_version = 1,
    policy = ${admin.json(policy)}, policy_hash = ${batchPolicyHash(policy)} WHERE id = 1`;
  const [{ epoch, at }] = await admin`SELECT epoch, to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM job_batch_control WHERE id = 1`;
  // FIXTURE 선출 seed(운영자 attest 증거가 아니다). 이 boot 의 후보 행·결과·readback.
  const capability = { host: 'oracle-osaka-smoke', release: prefix, instanceId: prefix, dbPrivileges: 'verified', dbRole: 'fixture-only',
    effectivePrivilegeHash: 'a'.repeat(64), http: 'verified', model: 'unknown', observedAt: at };
  const result = { role, batchEpoch: Number(epoch), job, instanceId: prefix, host: 'oracle-osaka-smoke', release: prefix, bootId: 'fixture',
    recordedAt: at, count: 1, requestedVersion: 1 };
  const readback = { job, instanceId: prefix, host: 'oracle-osaka-smoke', release: prefix, requestedVersion: 1, domainReadbackHash: 'c'.repeat(64), observedAt: at };
  await admin`INSERT INTO operations_observations(key, value) VALUES (${resultKey}, ${admin.json({ batchResult: result })})`;
  await admin`INSERT INTO job_batch_candidates(role, instance_id, host, boot_id, release, policy_hash, capability, result_evidence)
    VALUES (${role}, ${prefix}, 'oracle-osaka-smoke', ${boot}, ${prefix}, ${batchPolicyHash(policy)}, ${admin.json(capability)}, ${admin.json(readback)})`;
}, 60_000);

afterAll(async () => {
  await admin`DELETE FROM job_batch_candidates WHERE instance_id = ${prefix}`;
  await admin`DELETE FROM operations_observations WHERE key IN (${resultKey}, ${anchorKey})`;
  await admin`UPDATE role_leases SET owner_instance_id = NULL, owner_boot_id = NULL, owner_kind = NULL, lease_until = clock_timestamp() WHERE role = ${role} AND owner_instance_id = ${prefix}`;
  if (control) await admin`UPDATE job_batch_control SET mode = ${control.mode as string}, draining_from = ${control.draining_from as string | null},
    writer_contract_version = ${control.writer_contract_version as number}, policy = ${control.policy === null ? null : admin.json(control.policy as postgres.JSONValue)},
    policy_hash = ${control.policy_hash as string | null} WHERE id = 1`;
  await admin.end({ timeout: 5 });
});

it('reports ready while the pinned result is fresh, result_stale after 24 hours while renewal still succeeds, and null outside versioned mode', async () => {
  const lease = await acquireBatchRole({ role, instanceId: prefix, bootId: boot, release: prefix, kind: 'primary', batchVersion: 1, host: 'oracle-osaka-smoke' });
  expect(lease).toMatchObject({ role, instanceId: prefix, bootId: boot });
  expect(await batchLeaseAdmission(lease!)).toEqual({ ready: true, reason: 'ready' });
  // 선출이 고정한 anchor 결과와 원래 결과를 25시간 전으로 옮긴다(readback 은 그보다 뒤라 모양은 그대로 맞다).
  const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
  const [anchor] = await admin`SELECT value FROM operations_observations WHERE key = ${anchorKey}`;
  expect(anchor).toBeDefined();
  const value = anchor.value as { batchCanary: { result: Record<string, unknown> } };
  await admin`UPDATE operations_observations SET value = ${admin.json({ ...value, batchCanary: { ...value.batchCanary, result: { ...value.batchCanary.result, recordedAt: old } } })} WHERE key = ${anchorKey}`;
  expect(await batchLeaseAdmission(lease!)).toEqual({ ready: false, reason: 'result_stale' });
  // 결함: 갱신은 readiness 를 보지 않아 lease 가 계속 남는다 — role-worker 가 위 판정으로 놓아야 다른 host 가 선출된다
  expect(await renewBatchRole(lease!)).toBe(true);
  // 같은 boot 의 재선출은 readiness 를 다시 보므로 놓은 뒤에는 돌아오지 않는다
  expect(await releaseBatchRole(lease!)).toBe(true);
  expect(await acquireBatchRole({ role, instanceId: prefix, bootId: boot, release: prefix, kind: 'primary', batchVersion: 1, host: 'oracle-osaka-smoke' })).toBeNull();
  expect(await batchLeaseAdmission({ ...lease!, batchEpoch: lease!.batchEpoch! + 1 })).toBeNull();
  expect(await batchLeaseAdmission({ ...lease!, bootId: randomUUID() })).toEqual({ ready: false, reason: 'candidate_missing' });
  await admin`UPDATE job_batch_control SET mode = 'legacy' WHERE id = 1`;
  expect(await batchLeaseAdmission(lease!)).toBeNull();
}, 60_000);

import { randomUUID, createHash } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { batchCanaryAnchorKey, batchPolicyHash, classifyBatchCandidateEvidence, type BatchCanaryCandidate } from '@/lib/jobs/batches';
import { tryAcquireRole, releaseRole, type RoleLease } from '@/lib/jobs/role-leader';
import { runJob } from '@/lib/jobs/runner';
import { jobsForRole } from '@/lib/jobs/catalog';
import { readJobBatchReadiness } from '@/lib/operations/job-batch-readiness';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

// This proves cursor/ACK storage and admission, not translation quality or physical host capability.
const prefix = `canary-${randomUUID().slice(0, 12)}`, job = 'reason-translate', boot = randomUUID();
const anchorKey = batchCanaryAnchorKey('translation', prefix), resultKey = `batch-result:${prefix}:${job}`;
const observationKeys = [`job:${job}`, resultKey, anchorKey], managedJobs = [...new Set(jobsForRole('text'))].sort();
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const policy = { version: 1 as const, release: prefix, instances: [{ instanceId: prefix, host: 'oracle-osaka-smoke' as const }] };
const identity = { role: 'translation' as const, instanceId: prefix, bootId: boot, release: prefix,
  kind: 'primary' as const, batchVersion: 1 as const, host: 'oracle-osaka-smoke' as const };
type Raw = Record<string, unknown>;
const work = new Set<Promise<unknown>>(), exercises = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>(), setups = new Set<Promise<unknown>>();
let initial: Record<string, Raw[]>, initialized = false, candidateInserted = false, serial = 0, cleaning: Promise<void> | undefined;
const track = <T>(pending: PromiseLike<T>, set = work): Promise<T> => { const actual = Promise.resolve(pending); set.add(actual); void actual.catch(() => {}); return actual; };
const exercise = (body: () => Promise<void>) => () => track(Promise.resolve().then(body), exercises);
async function drain(set: Set<Promise<unknown>>) {
  while (set.size) { const pending = [...set]; await Promise.allSettled(pending); for (const promise of pending) set.delete(promise); }
}
async function steps(loads: readonly (() => Promise<unknown>)[], prior: readonly unknown[] = []) {
  const errors = [...prior]; for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'canary_fixture_cleanup_failed', { cause: errors[0] });
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const result: Record<string, Raw[]> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    result[tablename] = row.value;
  } return result;
}
async function restore(tx: postgres.TransactionSql, table: 'job_batch_control' | 'jobs' | 'role_leases' | 'operations_observations', key: string, value: string | number) {
  const original = initial[table].find(row => row[key] === value);
  const [current] = await tx.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE "${key}"=$1 FOR UPDATE`, [value]);
  if (!current) { expect(original).toBeUndefined(); return; }
  if (!original) {
    expect(await tx.unsafe(`DELETE FROM ${table} t WHERE "${key}"=$1 AND to_jsonb(t)=$2::text::jsonb RETURNING "${key}"`, [value, JSON.stringify(current.row)])).toHaveLength(1); return;
  }
  const columns = Object.keys(original).map(name => '"' + name.replaceAll('"', '""') + '"').join(',');
  expect(await tx.unsafe(`UPDATE ${table} t SET (${columns})=(SELECT ${columns} FROM jsonb_populate_record(NULL::${table},$1::text::jsonb)) WHERE "${key}"=$2 AND to_jsonb(t)=$3::text::jsonb RETURNING "${key}"`,
    [JSON.stringify(original), value, JSON.stringify(current.row)])).toHaveLength(1);
}
async function performCleanup() {
  if (!initialized) return;
  await admin.begin(async tx => {
    await tx`SELECT id FROM job_batch_control WHERE id=1 FOR UPDATE`;
    const roles = await tx`SELECT * FROM role_leases WHERE role IN ('text','translation') ORDER BY role FOR UPDATE`;
    for (const role of roles.filter(row => row.owner_instance_id !== null)) {
      expect(role.owner_instance_id).toBe(prefix); expect(role.owner_boot_id).toBe(boot); expect(role.owner_release).toBe(prefix);
    }
    expect((await tx`SELECT name,lease_token FROM jobs WHERE name=ANY(${managedJobs}::text[]) ORDER BY name FOR UPDATE`).every(row => row.lease_token === null)).toBe(true);
    const [candidate] = await tx`SELECT to_jsonb(c) AS row FROM job_batch_candidates c WHERE role='translation' AND instance_id=${prefix} FOR UPDATE`;
    if (candidate) {
      expect(candidateInserted).toBe(true); expect(candidate.row).toMatchObject({ boot_id: boot, release: prefix, policy_hash: batchPolicyHash(policy) });
      expect(await tx`DELETE FROM job_batch_candidates c WHERE role='translation' AND instance_id=${prefix} AND to_jsonb(c)=${JSON.stringify(candidate.row)}::text::jsonb RETURNING role`).toHaveLength(1);
    }
    for (const key of observationKeys) await restore(tx, 'operations_observations', 'key', key);
    for (const name of managedJobs) await restore(tx, 'jobs', 'name', name);
    for (const name of ['text', 'translation']) await restore(tx, 'role_leases', 'role', name);
    await restore(tx, 'job_batch_control', 'id', 1);
    expect(await whole(tx)).toEqual(initial);
  }); candidateInserted = false;
}
function cleanup() {
  if (cleaning) return cleaning; const pending = performCleanup(); cleaning = pending;
  void pending.then(() => { if (cleaning === pending) cleaning = undefined; }, () => {}); return pending;
}
async function configure(mode: 'legacy' | 'versioned') {
  await track(admin`UPDATE job_batch_control SET mode=${mode},draining_from=NULL,writer_contract_version=1,
    policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${batchPolicyHash(policy)} WHERE id=1`);
}
async function tick(lease: RoleLease) {
  return track(runJob(job, async ctx => {
    await ctx.save({ fixture: prefix, actualStoredCursor: ++serial });
    ctx.log('translate.done', { translated: 1 }); return { done: false };
  }, { roleLease: lease }));
}
async function seedCanary() {
  await configure('legacy');
  const lease = await track(tryAcquireRole({ role: 'text', instanceId: prefix, bootId: boot, release: prefix, kind: 'primary' }));
  expect(lease).not.toBeNull(); if (!lease) throw new Error('fixture_legacy_role_required');
  let primary: unknown;
  try { expect(await tick(lease)).toMatchObject({ status: 'completed' }); } catch (error) { primary = error; }
  await steps([async () => { expect(await track(releaseRole(lease))).toBe(true); }], primary === undefined ? [] : [primary]);
  const [clock] = await admin`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
  const [stored] = await admin`SELECT cursor,requested_version FROM jobs WHERE name=${job}`;
  const capability = { host: identity.host, release: prefix, instanceId: prefix, dbPrivileges: 'verified', dbRole: 'local-fixture-only',
    effectivePrivilegeHash: 'a'.repeat(64), http: 'verified', model: 'verified', modelBoundEvidenceHash: 'b'.repeat(64), observedAt: clock.at };
  const readback = { job, instanceId: prefix, host: identity.host, release: prefix, requestedVersion: Number(stored.requested_version),
    domainReadbackHash: createHash('sha256').update(JSON.stringify(stored.cursor)).digest('hex'), observedAt: clock.at };
  expect(await admin`SELECT role FROM job_batch_candidates WHERE role='translation' AND instance_id=${prefix}`).toHaveLength(0);
  await admin`INSERT INTO job_batch_candidates(role,instance_id,host,boot_id,release,policy_hash,capability,result_evidence)
    VALUES('translation',${prefix},${identity.host},${boot},${prefix},${batchPolicyHash(policy)},${JSON.stringify(capability)}::text::jsonb,${JSON.stringify(readback)}::text::jsonb)`;
  candidateInserted = true; await configure('versioned');
}
async function snapshotCandidate() {
  const [candidate] = await admin`SELECT role,instance_id AS "instanceId",host,boot_id AS "bootId",release,policy_hash AS "policyHash",
    capability,result_evidence AS "resultEvidence" FROM job_batch_candidates WHERE role='translation' AND instance_id=${prefix}`;
  return candidate as BatchCanaryCandidate;
}
async function anchorRow() { return (await admin`SELECT to_jsonb(o) AS row FROM operations_observations o WHERE key=${anchorKey}`)[0]?.row; }
async function until(load: () => Promise<boolean>) {
  const end = Date.now() + 5000; while (!await load()) { if (Date.now() >= end) throw new Error('fixture_barrier_not_observed'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function hasCause(value: unknown, message: string): boolean {
  for (let depth = 0; value && depth < 8; depth++) {
    if (value instanceof Error && value.message === message) return true;
    value = value instanceof Error ? value.cause : undefined;
  } return false;
}
beforeAll(() => track((async () => {
  ensureSchema(); initial = await whole();
  expect(initial.job_batch_control[0]).toMatchObject({ mode: 'legacy', writer_contract_version: 0 });
  expect(initial.job_batch_candidates.some(row => row.role === 'translation' && row.instance_id === prefix)).toBe(false);
  expect(initial.operations_observations.some(row => [resultKey, anchorKey].includes(String(row.key)))).toBe(false);
  expect(initial.role_leases.filter(row => ['text', 'translation'].includes(String(row.role))).every(row => row.owner_instance_id === null)).toBe(true);
  expect(initial.jobs.filter(row => managedJobs.includes(String(row.name))).every(row => row.lease_token === null)).toBe(true);
  initialized = true;
})(), setups));
afterEach(() => track(steps([() => drain(setups), () => drain(exercises), () => drain(work), cleanup]), hooks));
afterAll(async () => { await steps([() => drain(setups), () => drain(exercises), () => drain(work), () => drain(hooks), cleanup,
  () => admin.end({ timeout: 5 }), async () => { await (globalThis as { pgClient?: ReturnType<typeof postgres> }).pgClient?.end({ timeout: 5 }); }]); });

it('pins one verified actual ACK at acquisition and keeps continuous admissions after later stored ACKs', exercise(async () => {
  await seedCanary(); const candidate = await snapshotCandidate();
  expect((await readJobBatchReadiness()).candidates.find(row => row.instanceId === prefix)?.ready).toBe(true);
  expect(await anchorRow()).toBeUndefined(); // Read-only report cannot mint an anchor.
  const lease = await track(tryAcquireRole(identity)); expect(lease).not.toBeNull(); if (!lease) throw new Error('fixture_role_required');
  const anchor = await anchorRow(); expect(anchor.value.batchCanary.result.role).toBe('text');
  const version = anchor.value.batchCanary.result.requestedVersion;
  expect(await tick(lease)).toMatchObject({ status: 'completed' });
  expect(await tick(lease)).toMatchObject({ status: 'completed' });
  expect((await admin`SELECT value->'batchResult' AS result FROM operations_observations WHERE key=${resultKey}`)[0].result.requestedVersion).toBeGreaterThan(version);
  expect(await snapshotCandidate()).toEqual(candidate); expect(await anchorRow()).toEqual(anchor);
  expect((await admin`SELECT key FROM operations_observations WHERE key=${anchorKey}`)).toHaveLength(1);
  expect((await readJobBatchReadiness()).candidates.find(row => row.instanceId === prefix)?.ready).toBe(true);
}), 20_000);

it('fails closed on changed operator readback and malformed anchor without overwriting or latest fallback', exercise(async () => {
  await seedCanary(); const lease = await track(tryAcquireRole(identity)); expect(lease).not.toBeNull(); if (!lease) throw new Error('fixture_role_required');
  const original = await snapshotCandidate(), anchor = await anchorRow();
  await admin`UPDATE job_batch_candidates SET result_evidence=jsonb_set(result_evidence,'{domainReadbackHash}',to_jsonb(${'c'.repeat(64)}::text)) WHERE role='translation' AND instance_id=${prefix}`;
  expect(await tick(lease)).toMatchObject({ status: 'skipped', reason: 'stopping' }); expect(await anchorRow()).toEqual(anchor);
  expect(await track(tryAcquireRole(identity))).toBeNull();
  await admin`UPDATE job_batch_candidates SET result_evidence=${JSON.stringify(original.resultEvidence)}::text::jsonb WHERE role='translation' AND instance_id=${prefix}`;
  await admin`UPDATE operations_observations SET value='{}'::jsonb WHERE key=${anchorKey}`;
  const malformed = await anchorRow();
  expect(await tick(lease)).toMatchObject({ status: 'skipped', reason: 'stopping' });
  expect(await track(tryAcquireRole(identity))).toBeNull(); expect(await anchorRow()).toEqual(malformed);
  expect((await readJobBatchReadiness()).candidates.find(row => row.instanceId === prefix)?.ready).toBe(false);
}), 20_000);

it('rolls an actual anchor INSERT fault back with the complete owner acquisition and preserves its SQL cause', exercise(async () => {
  await seedCanary();
  const before = await admin`SELECT to_jsonb(r) AS row FROM role_leases r WHERE role='translation'`;
  const candidate = await snapshotCandidate(); const fn = `pr10d_${prefix.replaceAll('-', '_')}`;
  expect(await admin`SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=${fn}`).toHaveLength(0);
  let created = false, primary: unknown;
  try {
    await admin.begin(async tx => {
      await tx.unsafe(`CREATE FUNCTION public."${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key = '${anchorKey}' THEN RAISE EXCEPTION 'pr10d_anchor_fault'; END IF; RETURN NEW; END $$`);
      await tx.unsafe(`CREATE TRIGGER "${fn}" BEFORE INSERT ON operations_observations FOR EACH ROW EXECUTE FUNCTION public."${fn}"()`);
    }); created = true;
    const error = await track(tryAcquireRole(identity)).catch(error => error);
    expect(hasCause(error, 'pr10d_anchor_fault')).toBe(true);
    expect(await anchorRow()).toBeUndefined(); expect(await admin`SELECT to_jsonb(r) AS row FROM role_leases r WHERE role='translation'`).toEqual(before);
    expect(await snapshotCandidate()).toEqual(candidate);
  } catch (error) { primary = error; }
  await steps([async () => { if (created) await admin.begin(async tx => {
    await tx.unsafe(`DROP TRIGGER "${fn}" ON operations_observations`); await tx.unsafe(`DROP FUNCTION public."${fn}"()`);
  }); }], primary === undefined ? [] : [primary]);
}), 20_000);

it('rechecks the actual capability DBwall after a two-backend unique-key wait and rolls the owner back', exercise(async () => {
  await seedCanary();
  await admin`UPDATE job_batch_candidates SET capability=jsonb_set(capability,'{observedAt}',to_jsonb(to_char(clock_timestamp()-interval '15 minutes'+interval '2 seconds' AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE role='translation' AND instance_id=${prefix}`;
  const candidate = await snapshotCandidate();
  const [clock] = await admin`SELECT clock_timestamp()::text AS at`;
  const [latest] = await admin`SELECT value->'batchResult' AS result FROM operations_observations WHERE key=${resultKey}`;
  const derived = classifyBatchCandidateEvidence({ candidate, controlEpoch: 1, at: Date.parse(clock.at), anchor: undefined, latest: [{ key: resultKey, result: latest.result }] });
  expect(derived.anchorToPin).toBeDefined(); // Collision row only: not an issued canary capability.
  const holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: `${prefix}-holder` } });
  const ready = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
  let acquiring: Promise<unknown> | undefined, primary: unknown;
  const holding = track(holder.begin(async tx => {
    const [pid] = await tx`SELECT pg_backend_pid() AS pid`;
    await tx`INSERT INTO operations_observations(key,value) VALUES(${anchorKey},${JSON.stringify(derived.anchorToPin)}::text::jsonb)`;
    ready.resolve(pid.pid); await release.promise;
  }));
  try {
    const holderPid = await Promise.race([ready.promise, holding.then(() => { throw new Error('fixture_holder_ended_before_ready'); })]);
    acquiring = track(tryAcquireRole(identity)); let settled = false; void acquiring.then(() => { settled = true; }, () => { settled = true; });
    let waiterPid = 0;
    await until(async () => {
      if (settled) throw new Error('fixture_acquisition_ended_before_wait');
      const rows = await admin`SELECT pid FROM pg_stat_activity WHERE ${holderPid}=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`;
      if (rows.length) { expect(rows).toHaveLength(1); waiterPid = rows[0].pid; return true; } return false;
    }); expect(waiterPid).not.toBe(holderPid); expect(waiterPid).toBeGreaterThan(0);
    expect((await admin`SELECT clock_timestamp()-(capability->>'observedAt')::timestamptz<interval '15 minutes' AS healthy FROM job_batch_candidates WHERE role='translation' AND instance_id=${prefix}`)[0].healthy).toBe(true);
    await until(async () => (await admin`SELECT clock_timestamp()-(capability->>'observedAt')::timestamptz>interval '15 minutes' AS expired FROM job_batch_candidates WHERE role='translation' AND instance_id=${prefix}`)[0].expired);
    release.resolve(); await holding; expect(await acquiring).toBeNull();
    expect((await admin`SELECT owner_instance_id FROM role_leases WHERE role='translation'`)[0]?.owner_instance_id ?? null).toBeNull();
    expect((await anchorRow()).value).toEqual(derived.anchorToPin);
  } catch (error) { primary = error; }
  release.resolve(); await steps([async () => {
    const results = await Promise.allSettled(acquiring ? [holding, acquiring] : [holding]);
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'canary_barrier_operations_failed');
  }, () => holder.end({ timeout: 5 })], primary === undefined ? [] : [primary]);
}), 20_000);

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import * as schema from '@/lib/db/schema';
import { helperGateStatesSql, ROLE_DEMAND_BEACONS, SUPERVISOR_PRINCIPAL, type HelperGateStateRow } from '@/lib/llm/capacity-helpers';
import { planSupervisorSignals, runCapacitySupervisor, type CapacitySupervisorDeps } from '@/lib/operations/capacity-supervisor/loop';
import { acquireSupervisorLeaseIn, writeSupervisorSignalsIn, type SupervisorOwner } from '@/lib/operations/capacity-supervisor/repository';
import { readSupervisorSnapshotIn } from '@/lib/operations/capacity-supervisor/snapshot';
import { publishRoleDemand } from '@/lib/operations/role-demand';
import { ORACLE_CONSUMER_DB_PROFILES, oracleConsumerGrantStatements } from '@/lib/runtime/oracle-db-profile';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

// pr2-plan §3.3 / §6: 감시자 SQL 을 실제 PostgreSQL 에서, least-privilege.sql 과 같은 문장으로 만든 감시자 계정으로 돌린다.
// lease 얻기·갱신·만료 뒤 빼앗기(epoch +1), standby 는 쓰지 않음, lease 를 잃은 TX-B 는 아무것도 쓰지 않음, 꺼지면 쓰지 않음, 쓴 신호의
// written_by·DB 시계 TTL, 연속 미확인 정지(한 번만), 거절되는 쓰기(42501), main 역할로는 시작하지 않음. 0154 의 stamp 트리거는 WP-2a-A 몫이라
// 여기서는 쓰는 쪽이 직접 current_user·clock_timestamp() 를 넣은 값을 본다.
const PROFILE = ORACLE_CONSUMER_DB_PROFILES['capacity-supervisor']!;
const password = randomUUID();
const admin = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, onnotice: () => {} });
const principalUrl = (() => { const url = new URL(TEST_DATABASE_URL); url.username = PROFILE.principal; url.password = password; return url.toString(); })();
let principalClient: ReturnType<typeof postgres>;
let sup: ReturnType<typeof drizzle<typeof schema>>;
const owner = (suffix: string): SupervisorOwner => ({ instanceId: `capacity-supervisor-consumer-${suffix}`, bootId: randomUUID(), release: 'd'.repeat(40) });
const EVIDENCE = 'e'.repeat(64);

const lease = (who: SupervisorOwner) => sup.transaction(tx => acquireSupervisorLeaseIn(tx, who));
const snapshot = () => sup.transaction(tx => readSupervisorSnapshotIn(tx), { isolationLevel: 'repeatable read', accessMode: 'read only' });
const write = (who: SupervisorOwner, epoch: number, plan: Parameters<typeof writeSupervisorSignalsIn>[3]) =>
  sup.transaction(tx => writeSupervisorSignalsIn(tx, who, epoch, plan));
const control = async () => (await admin`SELECT enabled, epoch::int, owner_instance_id, owner_boot_id::text, loop_seq::int,
  lease_until > clock_timestamp() AS live FROM model_supervisor_control WHERE id = 1`)[0];
const signals = () => admin`SELECT assignment_id, assignment_version::int, supervisor_epoch::int, verdict, reason, streak, written_by,
  extract(epoch FROM valid_until - observed_at) * 1000 AS ttl_ms, valid_until > clock_timestamp() AS fresh FROM model_helper_signals ORDER BY assignment_id`;
/** valid_until − observed_at. 0154 stamp 트리거가 observed_at 을 조금 뒤의 clock_timestamp() 로 다시 쓰므로 TTL 보다 몇 ms 짧을 수 있다(초로 반올림). */
const ttlOf = (value: unknown) => Math.round(Number(value) / 1000) * 1000;
const failure = async (statement: string) => {
  try { await principalClient.unsafe(statement); return 'allowed'; } catch (error) { return (error as { code?: string }).code ?? 'error'; }
};
function principalDeps(): Partial<CapacitySupervisorDeps> {
  return {
    readPrincipal: async () => { const [row] = await principalClient`SELECT current_user::text AS cu, session_user::text AS su`; return { currentUser: row.cu, sessionUser: row.su }; },
    acquireLease: lease, readSnapshot: snapshot, writeSignals: write,
    observe: async (key, value) => { await sup.insert(schema.operationsObservations).values({ key, value, observedAt: new Date() })
      .onConflictDoUpdate({ target: schema.operationsObservations.key, set: { value, observedAt: new Date() } }); },
    sleep: async () => {},
  };
}
async function seedShadowRuns(states: string[]) {
  for (const [index, state] of states.entries()) await admin`INSERT INTO model_helper_shadow_runs (assignment_id, evidence_key, stage, candidate_id,
    primary_ref, primary_model, primary_decision, input_hash, source_revision_hash, policy_hash, prompt_version, rules_version, state, job_token, created_at)
    VALUES ('m3-deepseek:ai1', ${EVIDENCE}, 'ai1', ${1000 + index}, ${index + 1}, 'qwen', 'approve', ${'1'.repeat(64)}, ${'2'.repeat(64)}, ${'3'.repeat(64)},
      'p1', 'r1', ${state}, ${randomUUID()}, clock_timestamp() - ${(states.length - index) * 1000} * interval '1 millisecond')`;
}

/** 도우미 표를 비운다. model_helper_stops 는 append-only(0154 트리거: UPDATE·DELETE·TRUNCATE·배정 cascade 가 42501)라 그 TX 안에서만 USER 트리거를 끈다. */
async function resetHelperTables() {
  await admin.begin(async tx => {
    await tx`ALTER TABLE model_helper_stops DISABLE TRIGGER USER`;
    await tx`DELETE FROM model_helper_stops`;
    await tx`ALTER TABLE model_helper_stops ENABLE TRIGGER USER`;
    for (const table of ['model_helper_signals', 'model_device_signals', 'model_role_demand', 'model_helper_shadow_runs', 'model_helper_live_outputs',
      'model_helper_assignments']) await tx.unsafe(`DELETE FROM ${table}`);
  });
}

beforeAll(async () => {
  ensureSchema();
  expect((await admin`SELECT 1 FROM pg_roles WHERE rolname = ${PROFILE.principal}`).length).toBe(0);
  for (const statement of oracleConsumerGrantStatements(PROFILE, { connectionLimit: 4 })) await admin.unsafe(statement);
  await admin.unsafe(`ALTER ROLE ${PROFILE.principal} PASSWORD '${password}'`);
  principalClient = postgres(principalUrl, { max: 2, prepare: false, onnotice: () => {} });
  sup = drizzle(principalClient, { schema });
}, 120_000);

afterAll(async () => {
  try {
    await principalClient?.end({ timeout: 5 });
    await resetHelperTables();
    await admin`DELETE FROM model_capacity_devices WHERE device_id IN ('m3-deepseek', 'supa')`;
    await admin`DELETE FROM operations_observations WHERE key LIKE 'capacity-supervisor:%'`;
    await admin`UPDATE model_supervisor_control SET enabled = false, owner_instance_id = NULL, owner_boot_id = NULL, lease_until = NULL, epoch = 0, loop_seq = 0`;
    if ((await admin`SELECT 1 FROM pg_roles WHERE rolname = ${PROFILE.principal}`).length) {
      await admin.unsafe(`DROP OWNED BY ${PROFILE.principal}`); await admin.unsafe(`DROP ROLE ${PROFILE.principal}`);
    }
  } finally { await admin.end({ timeout: 5 }); }
}, 60_000);

beforeEach(async () => {
  await resetHelperTables();
  await admin`DELETE FROM operations_observations WHERE key LIKE 'capacity-supervisor:%'`;
  await admin`UPDATE model_supervisor_control SET enabled = true, owner_instance_id = NULL, owner_boot_id = NULL, lease_until = NULL, epoch = 0, loop_seq = 0`;
  for (const device of ['m3-deepseek', 'supa']) await admin`INSERT INTO model_capacity_devices (device_id, limit_slots, secondary_cap, updated_by)
    VALUES (${device}, 1, 0, 'test') ON CONFLICT (device_id) DO NOTHING`;
  await admin`INSERT INTO model_helper_assignments (assignment_id, stage, device_id, model, shadow_route_id, live_route_id, live_provider, mode,
    evidence_key, version, updated_by, updated_at) VALUES ('m3-deepseek:ai1', 'ai1', 'm3-deepseek', 'deepseek', 'local-helper-shadow-ai1', 'local-ai1-helper',
    'local-direct', 'shadow', ${EVIDENCE}, 2, 'test', clock_timestamp() - interval '1 hour')`;
  // 집 쪽 beacon 은 main 역할(테스트 DB 의 nomorevibe)로 쓴다
  expect(await publishRoleDemand({ roleId: 'human-review', deviceId: 'm3-deepseek', backlog: 0 }, ROLE_DEMAND_BEACONS.humanReview.ttlMs)).toBe(true);
  expect(await publishRoleDemand({ roleId: 'ai1', deviceId: ROLE_DEMAND_BEACONS.ai1.deviceId, backlog: 3, metrics: { devices: ['supa'], pausedAll: false } },
    ROLE_DEMAND_BEACONS.ai1.ttlMs)).toBe(true);
});

describe('home beacon writer (main role)', () => {
  it('stamps written_by and a DB-clock TTL, upserts in place and the table refuses a TTL over five minutes', async () => {
    const rows = await admin`SELECT role_id, device_id, backlog, written_by, extract(epoch FROM valid_until - observed_at) * 1000 AS ttl_ms, metrics
      FROM model_role_demand ORDER BY role_id`;
    expect(rows.map(row => [row.role_id, row.device_id, row.backlog, row.written_by, ttlOf(row.ttl_ms)])).toEqual([
      ['ai1', 'ai1-pool', 3, 'nomorevibe', 45_000], ['human-review', 'm3-deepseek', 0, 'nomorevibe', 150_000]]);
    expect(rows[0].metrics).toEqual({ devices: ['supa'], pausedAll: false });
    expect(await publishRoleDemand({ roleId: 'human-review', deviceId: 'm3-deepseek', backlog: 7, oldestAgeMs: 900 }, 150_000)).toBe(true);
    expect((await admin`SELECT backlog, oldest_age_ms::int FROM model_role_demand WHERE role_id = 'human-review'`)[0]).toEqual({ backlog: 7, oldest_age_ms: 900 });
    await expect(admin`UPDATE model_role_demand SET valid_until = observed_at + interval '6 minutes' WHERE role_id = 'ai1'`).rejects.toMatchObject({ code: '23514' });
    // 감시자 계정은 beacon 을 위조할 수 없다(읽기만)
    expect(await failure(`UPDATE model_role_demand SET backlog = 0`)).toBe('42501');
    expect(await failure(`INSERT INTO model_role_demand (role_id, device_id, backlog, observed_at, valid_until, written_by)
      VALUES ('x', 'y', 0, now(), now() + interval '1 minute', 'z')`)).toBe('42501');
  });
});

describe('lease (TX-A) and write (TX-B) as the supervisor principal', () => {
  it('acquires with an epoch bump, renews in place, keeps a second owner on standby and lets it steal only after expiry', async () => {
    const a = owner('a'), b = owner('b');
    expect(await lease(a)).toMatchObject({ kind: 'owner', epoch: 1, enabled: true, signalTtlMs: 45_000, loopMs: 15_000, principalOk: true, loopSeq: 1 });
    expect(await lease(a)).toMatchObject({ kind: 'owner', epoch: 1, loopSeq: 2 });
    const before = await control();
    expect(await lease(b)).toMatchObject({ kind: 'standby', ownerInstanceId: a.instanceId, epoch: 1 });
    expect(await control()).toEqual(before);
    // 같은 인스턴스라도 boot 가 바뀌면 새 owner 다(epoch +1)
    await admin`UPDATE model_supervisor_control SET lease_until = clock_timestamp() - interval '1 second'`;
    expect(await lease(b)).toMatchObject({ kind: 'owner', epoch: 2 });
    expect(await control()).toMatchObject({ owner_instance_id: b.instanceId, owner_boot_id: b.bootId, epoch: 2, live: true });
    expect(await lease(a)).toMatchObject({ kind: 'standby', epoch: 2 });
    await admin`UPDATE model_supervisor_control SET lease_until = clock_timestamp() - interval '1 second'`;
    expect(await lease({ ...a, bootId: randomUUID() })).toMatchObject({ kind: 'owner', epoch: 3 });
  });
  it('writes signals with the principal stamp and a DB-clock TTL, and the admission gate opens only for that fresh signal', async () => {
    const a = owner('a');
    const held = await lease(a);
    if (held.kind !== 'owner') throw new Error('owner_expected');
    const plan = planSupervisorSignals(await snapshot(), held.epoch);
    expect(plan.helpers.map(decision => [decision.assignmentId, decision.verdict, decision.reason])).toEqual([['m3-deepseek:ai1', 'shadow_only', 'primary_not_full']]);
    expect(await write(a, held.epoch, plan)).toEqual({ kind: 'written', helpers: 1, devices: 1, stops: 0, skipped: 0, signalTtlMs: 45_000 });
    expect((await signals()).map(row => ({ ...row, ttl_ms: ttlOf(row.ttl_ms) }))).toEqual([{ assignment_id: 'm3-deepseek:ai1', assignment_version: 2,
      supervisor_epoch: held.epoch, verdict: 'shadow_only', reason: 'primary_not_full', streak: 0, written_by: SUPERVISOR_PRINCIPAL, ttl_ms: 45_000, fresh: true }]);
    expect((await admin`SELECT device_id, primary_demand, backlog, written_by, metrics FROM model_device_signals`)).toEqual([
      { device_id: 'm3-deepseek', primary_demand: false, backlog: 0, written_by: SUPERVISOR_PRINCIPAL, metrics: { reason: 'fresh', roles: 1, freshRoles: 1 } }]);
    const gate = async () => (await db.execute<HelperGateStateRow>(helperGateStatesSql('m3-deepseek', 0))).map(row => [row.kind, row.ok]);
    expect(await gate()).toEqual([['live', false], ['shadow', true]]);
    // fail-closed: 신호 만료 · 다른 계정 · 다른 판 · 감시자 꺼짐 · lease 만료 ⇒ 닫힘
    for (const change of [sql`UPDATE model_helper_signals SET valid_until = clock_timestamp() - interval '1 millisecond', observed_at = clock_timestamp() - interval '1 second'`,
      sql`UPDATE model_helper_signals SET written_by = 'nomorevibe'`, sql`UPDATE model_helper_assignments SET version = 3`,
      sql`UPDATE model_supervisor_control SET enabled = false`, sql`UPDATE model_supervisor_control SET lease_until = clock_timestamp() - interval '1 second'`]) {
      await db.transaction(async tx => {
        // stamp 트리거(0154)는 observed_at 을 앞당기지 못하게 한다 — 만료를 흉내 내려고 이 되돌릴 TX 에서만 끈다
        await tx.execute(sql`ALTER TABLE model_helper_signals DISABLE TRIGGER USER`);
        await tx.execute(change);
        expect((await tx.execute<HelperGateStateRow>(helperGateStatesSql('m3-deepseek', 0))).map(row => row.ok)).toEqual([false, false]);
        tx.rollback();
      }).catch(error => { if (!String(error).includes('Rollback')) throw error; });
    }
    expect(await gate()).toEqual([['live', false], ['shadow', true]]);
  });
  it('writes nothing after losing the lease, when disabled or when the assignment version moved', async () => {
    const a = owner('a'), b = owner('b');
    const held = await lease(a);
    if (held.kind !== 'owner') throw new Error('owner_expected');
    const plan = planSupervisorSignals(await snapshot(), held.epoch);
    await admin`UPDATE model_supervisor_control SET lease_until = clock_timestamp() - interval '1 second'`;
    expect(await write(a, held.epoch, plan)).toEqual({ kind: 'lease_lost' });
    expect(await lease(b)).toMatchObject({ kind: 'owner', epoch: held.epoch + 1 });
    expect(await write(a, held.epoch, plan)).toEqual({ kind: 'lease_lost' });
    expect(await write(b, held.epoch, plan)).toEqual({ kind: 'lease_lost' });
    expect(await signals()).toEqual([]);
    await admin`UPDATE model_supervisor_control SET enabled = false`;
    expect(await write(b, held.epoch + 1, plan)).toEqual({ kind: 'disabled' });
    await admin`UPDATE model_supervisor_control SET enabled = true`;
    await admin`UPDATE model_helper_assignments SET version = 5`;
    expect(await write(b, held.epoch + 1, plan)).toMatchObject({ kind: 'written', helpers: 0, skipped: 1 });
    expect(await signals()).toEqual([]);
  });
  it('stops on three consecutive unknown shadow runs exactly once per version and the stop closes the shadow route', async () => {
    await seedShadowRuns(['succeeded', 'unknown', 'unknown', 'unknown']);
    const a = owner('a');
    for (let round = 0; round < 3; round++) {
      const held = await lease(a);
      if (held.kind !== 'owner') throw new Error('owner_expected');
      const plan = planSupervisorSignals(await snapshot(), held.epoch);
      const expected = round === 0 ? { verdict: 'hold', reason: 'unknown_rate' } : { verdict: 'hold', reason: 'auto_stopped' };
      expect(plan.helpers[0]).toMatchObject(expected);
      expect(await write(a, held.epoch, plan)).toMatchObject({ kind: 'written', stops: round === 0 ? 1 : 0 });
    }
    const stops = await admin`SELECT assignment_id, assignment_version::int, effect, reason, written_by, evidence FROM model_helper_stops`;
    expect(stops).toEqual([{ assignment_id: 'm3-deepseek:ai1', assignment_version: 2, effect: 'stop', reason: 'unknown_rate', written_by: SUPERVISOR_PRINCIPAL,
      evidence: expect.objectContaining({ rule: 'consecutive_unknowns', consecutiveUnknowns: 3 }) }]);
    expect((await db.execute<HelperGateStateRow>(helperGateStatesSql('m3-deepseek', 0))).map(row => row.ok)).toEqual([false, false]);
    // 관리자가 다시 저장하면(version +1) 새 건강 창이 열려 그 판에는 정지가 없다
    await admin`UPDATE model_helper_assignments SET version = 3, updated_at = clock_timestamp()`;
    const held = await lease(a);
    if (held.kind !== 'owner') throw new Error('owner_expected');
    expect(planSupervisorSignals(await snapshot(), held.epoch).helpers[0]).toMatchObject({ verdict: 'shadow_only', stop: null });
  });
  it('refuses every write outside the profile (42501)', async () => {
    for (const statement of ['UPDATE model_supervisor_control SET enabled = true', "UPDATE model_supervisor_control SET signal_principal = 'x'",
      'UPDATE model_supervisor_control SET signal_ttl_ms = 300000', "UPDATE model_helper_assignments SET mode = 'live'",
      "UPDATE model_helper_stops SET effect = 'stop'", 'DELETE FROM model_helper_stops', 'DELETE FROM model_helper_signals',
      'SELECT helper_outcome FROM model_helper_shadow_runs', 'SELECT job_token FROM model_helper_shadow_runs',
      'SELECT dispatch_binding FROM model_capacity_requests', 'SELECT owner_instance_id FROM model_capacity_requests',
      "UPDATE model_capacity_requests SET state = 'settled' WHERE false", 'SELECT 1 FROM crawl_settings', 'SELECT 1 FROM jobs',
      'SELECT 1 FROM role_leases', "UPDATE runtime_settings SET updated_by = 'x' WHERE false", 'DELETE FROM runtime_settings WHERE false',
      'UPDATE operations_observations SET key = key WHERE false', 'CREATE TABLE public.supervisor_negative_probe(id integer)'])
      expect(await failure(statement), statement).toBe('42501');
  });
  it('reads runtime_settings (2026-11-10: unknown hold window) but cannot write it', async () => {
    expect(await failure('SELECT 1 FROM runtime_settings')).toBe('allowed');
    expect(await failure("UPDATE runtime_settings SET updated_by = 'x' WHERE false")).toBe('42501');
  });
});

describe('runCapacitySupervisor end to end', () => {
  it('runs one round as the principal: lease, snapshot, signals and its own observation', async () => {
    const a = owner('e2e');
    const summary = await runCapacitySupervisor({ owner: a, once: true, deps: principalDeps() });
    expect(summary).toMatchObject({ loops: 1, written: 1, failures: 0 });
    expect((await signals()).map(row => [row.verdict, row.written_by])).toEqual([['shadow_only', SUPERVISOR_PRINCIPAL]]);
    const [observation] = await admin`SELECT value FROM operations_observations WHERE key = ${`capacity-supervisor:${a.instanceId}`}`;
    expect(observation.value).toMatchObject({ state: 'stopped', epoch: 1, verdicts: { 'm3-deepseek:ai1': 'shadow_only:primary_not_full' } });
  });
  it('writes no signal while disabled and refuses to start as the main role', async () => {
    await admin`UPDATE model_supervisor_control SET enabled = false`;
    const summary = await runCapacitySupervisor({ owner: owner('off'), once: true, deps: principalDeps() });
    expect(summary).toMatchObject({ disabled: 1, written: 0 });
    expect(await signals()).toEqual([]);
    await admin`UPDATE model_supervisor_control SET enabled = true`;
    // 기본 의존성의 계정 확인은 lib/db(테스트 DB 의 main 역할 nomorevibe)로 묻는다 → 아무것도 쓰기 전에 끝난다
    const main = owner('main'), before = await control();
    expect(before).toMatchObject({ owner_instance_id: 'capacity-supervisor-consumer-off', epoch: 1 });
    await expect(runCapacitySupervisor({ owner: main, once: true })).rejects.toThrow('supervisor_principal_mismatch');
    expect(await control()).toEqual(before);
    expect(await admin`SELECT 1 FROM operations_observations WHERE key = ${`capacity-supervisor:${main.instanceId}`}`).toHaveLength(0);
    expect(await signals()).toEqual([]);
  });
});

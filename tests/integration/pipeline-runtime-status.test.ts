import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readPipelineControlStatus } from '@/lib/operations/pipeline-control-status';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

// PR13b 실제 PostgreSQL: 관리자 상태 조회가 운영 관리 행·장부·권한을 바꾸지 않고, 잠금 없이 같은 문장으로 읽는지 본다.
const work = new Set<Promise<unknown>>();
const admin = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, onnotice: () => {}, connection: { application_name: 'pr13b-runtime-status' } });
const track = <T>(body: () => Promise<T>) => { const pending = body(); work.add(pending); return pending; };
beforeAll(() => { ensureSchema(); });
afterAll(async () => {
  const pending = [...work];
  const results = await Promise.allSettled(pending);
  pending.forEach(promise => work.delete(promise));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  for (const close of [() => admin.end(), async () => {
    const client = (globalThis as unknown as { pgClient?: postgres.Sql }).pgClient;
    await client?.end();
  }]) try { await close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'runtime_status_cleanup_failed');
});

async function snapshot() {
  const [row] = await admin`SELECT jsonb_build_object(
    'fence',(SELECT jsonb_agg(to_jsonb(t)) FROM dr_writer_fence t),
    'promotions',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY promotion_id),'[]'::jsonb) FROM dr_promotions t),
    'drEvents',(SELECT jsonb_build_array((SELECT count(*) FROM dr_fence_events),(SELECT count(*) FROM dr_promotion_evidence),(SELECT count(*) FROM dr_process_group_events))),
    'observations',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY key),'[]'::jsonb) FROM operations_observations t),
    'requests',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY request_id),'[]'::jsonb) FROM model_capacity_requests t),
    'events',(SELECT count(*) FROM model_capacity_events),
    'controls',(SELECT jsonb_build_array((SELECT to_jsonb(t) FROM job_batch_control t),(SELECT to_jsonb(t) FROM model_capacity_control t),
      (SELECT to_jsonb(t) FROM http_origin_control t))),
    'candidates',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY role,instance_id),'[]'::jsonb) FROM job_batch_candidates t),
    'roles',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY role),'[]'::jsonb) FROM role_leases t),
    'relationAcl',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'acl',relacl) ORDER BY oid) FROM pg_class WHERE relnamespace='public'::regnamespace),
    'databaseAcl',(SELECT datacl FROM pg_database WHERE datname=current_database())
  ) AS state`;
  return row.state as Record<string, unknown>;
}

it('reads the migrated runtime sections without locks, writes or ACL changes', () => track(async () => {
  const journal = JSON.parse(readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  expect(journal.entries.map(entry => entry.tag)).toContain('0095_dr_writer_fence');
  const [applied] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  const before = await snapshot();
  // 관리 행을 다른 세션이 FOR UPDATE 로 쥐고 있어도 조회가 끝나야 한다 — 조회가 행 잠금을 요구하지 않는다는 실제 근거
  const status = await admin.begin(async tx => {
    await tx`SELECT id FROM dr_writer_fence WHERE id=1 FOR UPDATE`;
    await tx`SELECT id FROM job_batch_control WHERE id=1 FOR UPDATE`;
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    await tx`SELECT id FROM http_origin_control WHERE id=1 FOR UPDATE`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([readPipelineControlStatus(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('reader_blocked_by_row_lock')), 8_000); })]);
    } finally { clearTimeout(timer); }
  });
  expect(status.observedAt).not.toBeNull();
  const [fence] = await admin`SELECT state, writer_epoch::int AS epoch, reason FROM dr_writer_fence WHERE id=1`;
  expect(status.runtime.dr).toMatchObject({ state: fence.state, epoch: fence.epoch, reason: fence.reason });
  const [counts] = await admin`SELECT (SELECT count(*)::int FROM dr_promotions WHERE state='promoted') AS promoted,
    (SELECT count(*)::int FROM dr_promotions WHERE state='sealed') AS sealed,
    (SELECT count(*)::int FROM job_batch_candidates WHERE host='oracle-osaka-smoke') AS oracle`;
  expect(status.runtime.dr.promoted).toBe(counts.promoted);
  expect(status.runtime.dr.sealed).toHaveLength(counts.sealed);
  for (const { host, ledger } of status.runtime.ledgers) {
    const [rows] = await admin`SELECT count(*)::int AS count FROM operations_observations WHERE key LIKE ${`host-slot:${host}:%`}`;
    if (rows.count === 0) expect(ledger.state).toBe('absent');
    else expect(ledger.state).not.toBe('unknown');
  }
  const budgets = await admin`SELECT provider_budget_id AS budget, count(*)::int AS live FROM model_capacity_requests
    WHERE state IN ('waiting','reserved','dispatched','indeterminate') GROUP BY provider_budget_id ORDER BY 1`;
  for (const row of budgets) {
    const seen = status.runtime.models?.find(model => model.budget === row.budget);
    expect(seen && seen.waiting + seen.reserved + seen.dispatched + seen.indeterminate).toBe(row.live);
  }
  expect(status.runtime.models).not.toBeNull();
  expect(status.runtime.oracle.roles.filter(row => row.candidate).length).toBeLessThanOrEqual(counts.oracle);
  expect(status.runtime.oracle.checks.map(row => row.key)).toEqual(['batch', 'http', 'ledger', 'dr']);
  expect(JSON.stringify(status)).not.toMatch(/owner_boot_id|lease_token|policyHash|bindingHash|bootId|effectivePrivilegeHash|fenced_db|lineage/);
  expect(await snapshot()).toEqual(before);
}));

it('aggregates seeded host-slot, model slot and sealed promotion rows from the real driver and restores them exactly', () => track(async () => {
  const before = await snapshot();
  const prefix = 'host-slot:oracle-osaka-smoke', budget = `pr13b-${randomUUID().slice(0, 8)}`, owner = `pr13b-${randomUUID().slice(0, 8)}`;
  const bootId = randomUUID(), promotion = randomUUID(), lineage = randomUUID();
  const [existing] = await admin`SELECT count(*)::int AS count FROM operations_observations WHERE key LIKE ${`${prefix}:%`}`;
  expect(existing.count).toBe(0);
  const keys: string[] = [], requests: string[] = [];
  let sealed = false, primary: unknown;
  try {
    const [clock] = await admin`SELECT (extract(epoch FROM clock_timestamp())*1000)::float8 AS now`;
    const now = Number(clock.now), shape = 'e'.repeat(64);
    const proc = (identity: string, leaseUntilMs: number) => ({ type: 'process', bootId, shape, identity, pid: 4242, release: 'pr13b', primaryMax: 3, readMax: 0,
      leaseUntilMs, renewedAtMs: now - 1_000, rssBytes: 1024 * 1024, eventLoopDelayMs: 10, heartbeatGapMs: 5_000, loadPerCpu: 0.25 });
    const rows: [string, Record<string, unknown>][] = [
      [`${prefix}:p:worker:official-news:-:1:1`, proc('worker:official-news:-:1:1', now + 600_000)],
      [`${prefix}:p:role-parent:official-news:-:1:1`, proc('role-parent:official-news:-:1:1', now + 600_000)],
      [`${prefix}:p:worker:translation:-:1:1`, proc('worker:translation:-:1:1', now - 1)],
      [`${prefix}:t:1`, { type: 'translation', bootId, shape, leaseUntilMs: now + 600_000, token: randomUUID(), job: 'reason-translate', owner: 'worker:translation:-:1:1', holdMs: 30_000 }],
    ];
    for (const [key, value] of rows) { keys.push(key); await admin`INSERT INTO operations_observations (key, value) VALUES (${key}, ${admin.json(value as postgres.JSONValue)})`; }
    const request = async (state: string, extra: string) => {
      const id = randomUUID(); requests.push(id);
      await admin.unsafe(`INSERT INTO model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
        provider_budget_id, group_id, epoch, revision, policy_hash, state, token, reserved_until, queued_at, queue_until)
        VALUES ($1, $2, $3, $4, 'background', 'text', 'pr13b-route', 'pr13b-provider', 'pr13b-model', $5, 'pr13b-group', 1, 1, $6, $7, ${extra})`,
      [id, `work-${id}`, owner, bootId, budget, 'f'.repeat(64), state]);
    };
    await request('waiting', `NULL, NULL, clock_timestamp() - interval '5 minutes', clock_timestamp() + interval '1 hour'`);
    await request('reserved', `gen_random_uuid(), clock_timestamp() - interval '1 second', clock_timestamp(), clock_timestamp() + interval '1 hour'`);
    await request('dispatched', `gen_random_uuid(), clock_timestamp() + interval '1 hour', clock_timestamp(), clock_timestamp() + interval '1 hour'`);
    await request('indeterminate', `gen_random_uuid(), clock_timestamp() + interval '1 hour', clock_timestamp(), clock_timestamp() + interval '1 hour'`);
    await admin`INSERT INTO dr_promotions (promotion_id, lineage_id, from_epoch, to_epoch, state, plan, plan_hash, db_identity, seal_snapshot, operator)
      VALUES (${promotion}, ${lineage}, 1, 2, 'sealed', '{}'::jsonb, ${'0'.repeat(64)}, '{}'::jsonb, '{}'::jsonb, 'pr13b-fixture')`;
    sealed = true;

    const status = await readPipelineControlStatus();
    const oracle = status.runtime.ledgers.find(row => row.host === 'oracle-osaka-smoke')!.ledger;
    expect(oracle).toMatchObject({ state: 'ok', processes: 2, expired: 1, primaryClients: 6, replicaClients: 0, shapes: 1, translationHeld: 1, translationCap: 1 });
    expect(oracle.heartbeatGapMs).toBeGreaterThanOrEqual(5_000);
    expect(status.runtime.oracle.checks.find(row => row.key === 'ledger')).toEqual({ key: 'ledger', status: 'verified', reason: 'ledger_participating' });
    const slot = status.runtime.models?.find(row => row.budget === budget);
    expect(slot).toMatchObject({ limit: null, waiting: 1, reserved: 1, expiredReserved: 1, dispatched: 1, indeterminate: 1, oldestUnsettledMin: null });
    expect(slot?.oldestWaitingMin).toBeGreaterThanOrEqual(5);
    expect(slot?.oldestWaitingMin).toBeLessThan(10);
    expect(status.runtime.dr.sealed).toContainEqual({ id: promotion, fromEpoch: 1, toEpoch: 2, sealedAt: expect.any(String), evidence: [] });
    expect(JSON.stringify(status)).not.toContain(bootId);
  } catch (error) { primary = error; }
  // 넣은 행만 정확히 지운다. 다른 행은 건드리지 않고, 원 실패는 덮지 않는다
  const removed = await admin`DELETE FROM operations_observations WHERE key = ANY(${keys}::text[]) AND value->>'bootId' = ${bootId} RETURNING key`;
  const cancelled = await admin`DELETE FROM model_capacity_requests WHERE request_id = ANY(${requests}::uuid[]) AND owner_instance_id = ${owner} RETURNING request_id`;
  const dropped = await admin`DELETE FROM dr_promotions WHERE promotion_id = ${promotion} AND operator = 'pr13b-fixture' RETURNING promotion_id`;
  if (primary !== undefined) throw primary;
  expect([removed.length, cancelled.length, dropped.length]).toEqual([keys.length, requests.length, sealed ? 1 : 0]);
  expect(await snapshot()).toEqual(before);
}));

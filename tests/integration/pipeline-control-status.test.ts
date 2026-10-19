import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import { readFile, writeFile } from 'node:fs/promises';
import { db } from '@/lib/db';
import { readPipelineControlStatus } from '@/lib/operations/pipeline-control-status';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

const work = new Set<Promise<unknown>>();
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'pr13-control-conformance' } });
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
  if (errors.length) throw new AggregateError(errors, 'control_status_cleanup_failed');
});

it('reads actual migrated controls without changing management rows, privileges or granting readiness', () => {
  const exercise = (async () => {
    const snapshot = async () => {
      const [row] = await admin`SELECT jsonb_build_object(
        'stage',(SELECT jsonb_agg(to_jsonb(t) ORDER BY stage) FROM pipeline_stage_modes t),
        'batch',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM job_batch_control t),
        'source',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM evidence_source_control t),
        'model',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM model_capacity_control t),
        'http',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM http_origin_control t),
        'uptime',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM uptime_control t),
        'uptimeSplit',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM uptime_split_control t),
        'observations',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY key),'[]'::jsonb) FROM operations_observations t),
        'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY name),'[]'::jsonb) FROM jobs t),
        'unsettledModel',(SELECT count(*)::int FROM model_capacity_requests WHERE state IN ('dispatched','indeterminate')),
        'oracleCharges',(SELECT count(*)::int FROM http_origin_hops WHERE host_id='oracle-osaka-smoke' AND state IN ('reserved','dispatched','indeterminate')),
        'relationAcl',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'acl',relacl) ORDER BY oid) FROM pg_class WHERE relnamespace='public'::regnamespace),
        'schemaAcl',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'acl',nspacl) ORDER BY oid) FROM pg_namespace WHERE nspname NOT LIKE 'pg_temp%'),
        'databaseAcl',(SELECT datacl FROM pg_database WHERE datname=current_database()),
        'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY rolname) FROM (SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolbypassrls,rolconfig FROM pg_roles) r)
      ) AS state`;
      return row.state;
    };
    const before = await snapshot();
    const result = await readPipelineControlStatus();
    expect(result.observedAt).not.toBeNull();
    expect(Number.isFinite(Date.parse(result.observedAt!))).toBe(true);
    expect(result.controls.map(row => row.key)).toEqual(['batch', 'source', 'model', 'http', 'uptime', 'uptimeSplit']);
    const split = (before.uptimeSplit as { mode: string; epoch: number }[])[0];
    expect(result.controls.find(row => row.key === 'uptimeSplit')).toMatchObject({ mode: split.mode, epoch: split.epoch });
    expect(result.stages).toHaveLength(3);
    const stages = before.stage as { stage: string; epoch: number; writer_contract_version: number; mode: string }[];
    for (const row of stages) expect(result.stages.find(stage => stage.stage === row.stage)).toMatchObject({
      mode: row.mode, epoch: row.epoch, contract: row.writer_contract_version,
    });
    expect(result.controls.find(row => row.key === 'model')?.metrics).toContainEqual({ label: '미정산', value: before.unsettledModel });
    expect(result.controls.find(row => row.key === 'http')?.metrics).toContainEqual({ label: 'Oracle 점유', value: before.oracleCharges });
    expect(result.backlog.every(row => row.value === null || Number.isSafeInteger(row.value) && row.value >= 0)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/owner_boot_id|lease_token|policyHash|bindingHash/);
    expect(await snapshot()).toEqual(before);
    // Keep the actual result as local evidence only; no credentials or private row material.
    if (process.env.PR13_CONFORMANCE_OUTPUT) {
      const { hostname, port } = new URL(TEST_DATABASE_URL);
      if (hostname !== '127.0.0.1' || port !== '55538') throw new Error('unexpected_conformance_database');
      await writeFile(process.env.PR13_CONFORMANCE_OUTPUT, JSON.stringify(result, null, 2));
      expect(JSON.parse(await readFile(process.env.PR13_CONFORMANCE_OUTPUT, 'utf8'))).toEqual(result);
    }
    // Reads stay on the ordinary primary client and do not enter the runtime claim APIs.
    expect(db).toBeDefined();
  })();
  work.add(exercise);
  return exercise;
});

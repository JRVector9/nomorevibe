import { spawn } from 'node:child_process';
import { afterAll, expect, it } from 'vitest';
import { hostDbChildEnvironment } from '@/lib/db/host-budget';
import { TEST_DATABASE_URL } from './setup';

const policy = { version: 1, host: 'oracle-osaka-smoke', release: 'host-budget-fixture', roles: ['translation'],
  schedulerReplicas: 0, webReplicas: 0, webReadReplica: false, monitor: false, connectAgent: false,
  preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 1 };
function parentEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, DATABASE_URL: TEST_DATABASE_URL, NODE_OPTIONS: undefined,
    WORKER_ROLE: 'translation', PHYSICAL_HOST: policy.host, RELEASE_TAG: policy.release,
    DB_POOL_MAX: undefined, READ_DB_POOL_MAX: undefined, DB_POOLER_MODE: 'direct',
    DB_POOL_WAIT_MS: '100', DB_CONNECT_TIMEOUT_SECONDS: '3', DB_STATEMENT_TIMEOUT_MS: '1000', DB_LOCK_TIMEOUT_MS: '500',
    HOST_DB_BUDGET: JSON.stringify({ mode: 'enabled', policy,
      process: { kind: 'role-parent', role: 'translation', host: policy.host, release: policy.release, replica: 1, copy: 1 } }) };
}

// This child uses the actual production factory and postgres adapter. Only session-local TEMP DML is used.
const nativeProbe = `
const { createDbClient, dbPoolConfig } = require('./lib/db/pool.ts');
(async () => {
  const mode = process.argv[1];
  const sql = mode === 'legacy'
    ? createDbClient(process.env.DATABASE_URL, dbPoolConfig({ ...process.env, DB_POOL_MAX: '1' }))
    : createDbClient(process.env.DATABASE_URL);
  let release;
  let entered;
  let held;
  const pending = [];
  try {
    const pid = Number((await sql.unsafe('select pg_backend_pid() as pid'))[0].pid);
    if (mode === 'child') {
      console.log(JSON.stringify({ max: sql.options.max, pid, value: (await sql.unsafe('select 7 as value'))[0].value }));
      return;
    }
    await sql.unsafe('create temporary table host_db_budget_probe (value integer)');
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    held = sql.begin(async () => { entered(); await gate; });
    await Promise.race([ready, held.then(() => { throw new Error('holder_finished_before_ready'); })]);
    let callbackRan = false;
    const write = Promise.resolve(sql.unsafe('insert into host_db_budget_probe values (1)'));
    const begin = sql.begin(async () => { callbackRan = true; });
    pending.push(write, begin);
    const [writeResult, beginResult] = await Promise.allSettled(pending);
    release();
    await held;
    const rows = await sql.unsafe('select count(*)::int as count from host_db_budget_probe');
    console.log(JSON.stringify({ max: sql.options.max, pid, callbackRan, rows: rows[0].count,
      writeCode: writeResult.status === 'rejected' ? writeResult.reason.code : null,
      beginCode: beginResult.status === 'rejected' ? beginResult.reason.code : null,
      reusable: (await sql.begin(async tx => (await tx.unsafe('select 9 as value'))[0].value)) }));
  } finally {
    release?.();
    await Promise.allSettled([...(held ? [held] : []), ...pending]);
    await sql.end({ timeout: 2 });
  }
})().catch(() => { console.error('host_db_native_probe_failed'); process.exitCode = 1; });
`;
const active = new Set<Promise<unknown>>();

function probe(mode: 'parent' | 'legacy' | 'child', env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', nativeProbe, mode], {
    cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout = (stdout + String(data)).slice(-4096); });
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-4096); });
  let closed = false;
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  const actualClose = new Promise<void>(resolve => { child.once('close', () => { closed = true; resolve(); }); });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 15000);
  const killTimeout = setTimeout(() => child.kill('SIGKILL'), 16000);
  const promise = (async () => {
    try { return await result; }
    finally {
      if (!closed) child.kill('SIGTERM');
      await actualClose;
      clearTimeout(timeout);
      clearTimeout(killTimeout);
    }
  })();
  active.add(promise);
  void promise.then(() => active.delete(promise), () => active.delete(promise));
  return promise;
}

afterAll(async () => { await Promise.allSettled([...active]); });

it.each(['parent', 'legacy'] as const)('enforces quota1 at the actual %s native factory and cancels unsent write/BEGIN before reuse', async mode => {
  const env = parentEnvironment();
  if (mode === 'legacy') env.HOST_DB_BUDGET = '{"mode":"disabled"}';
  const result = await probe(mode, env);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ max: 1, pid: expect.any(Number), callbackRan: false, rows: 0,
    writeCode: 'DB_POOL_WAIT_TIMEOUT', beginCode: 'DB_POOL_WAIT_TIMEOUT', reusable: 9 });
});

it('passes the derived child declaration into a separate native process using its actual default factory', async () => {
  const result = await probe('child', hostDbChildEnvironment(parentEnvironment(), 'translation'));
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ max: 3, pid: expect.any(Number), value: 7 });
});

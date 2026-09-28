import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { jobs, operationsObservations, roleLeases } from '@/lib/db/schema';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

beforeAll(() => ensureSchema());

async function until<T>(read: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('role process did not reach expected state');
}

it('starts the real supervisor only after election and releases the role after SIGTERM drain', async () => {
  await db.delete(jobs);
  await db.delete(roleLeases);
  const healthPath = join('/tmp', `nomorevibe-role-process-${process.pid}.json`);
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/role-worker.ts',
    '--role=crawler', '--kind=primary'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, DB_POOL_MAX: '2',
      SERVICE_INSTANCE_ID: 'test-crawler-primary', RELEASE_TAG: 'process-test',
      WORKER_HEALTH_PATH: healthPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { output += String(data); });
  try {
    await until(async () => {
      const [row] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
      return row?.ownerInstanceId === 'test-crawler-primary' ? row : null;
    });
    await until(async () => {
      try {
        const health = JSON.parse(await readFile(healthPath, 'utf8')) as { status: string; childPid: number | null };
        return health.status === 'running' && health.childPid ? health : null;
      } catch { return null; }
    });
    const finished = new Promise<number | null>((resolve, reject) => {
      child.once('exit', code => resolve(code));
      child.once('error', reject);
    });
    child.kill('SIGTERM');
    const code = await Promise.race([finished, new Promise<never>((_, reject) =>
      setTimeout(async () => {
        const health = await readFile(healthPath, 'utf8').catch(() => 'missing');
        reject(new Error(`role process did not drain; health=${health}; output=${output}`));
      }, 15_000))]);
    expect(code, output).toBe(0);
    const [row] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
    expect(row.ownerInstanceId).toBeNull();
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}, 35_000);

it('keeps the standby passive until the primary drains, then starts its own supervisor', async () => {
  await db.delete(jobs);
  await db.delete(roleLeases);
  const primaryHealth = join('/tmp', `nomorevibe-role-primary-${process.pid}.json`);
  const standbyHealth = join('/tmp', `nomorevibe-role-standby-${process.pid}.json`);
  const primaryRoleHealth = join('/tmp', `nomorevibe-role-candidate-primary-${process.pid}.json`);
  const standbyRoleHealth = join('/tmp', `nomorevibe-role-candidate-${process.pid}.json`);
  const start = (kind: 'primary' | 'standby', path: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/role-worker.ts',
      '--role=crawler', `--kind=${kind}`], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, DB_POOL_MAX: '2',
        SERVICE_INSTANCE_ID: `test-crawler-${kind}`, RELEASE_TAG: 'process-test',
        WORKER_HEALTH_PATH: path, ROLE_HEALTH_PATH: kind === 'primary' ? primaryRoleHealth : standbyRoleHealth },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += String(data); });
    child.stderr.on('data', data => { output += String(data); });
    return { child, output: () => output };
  };
  const primary = start('primary', primaryHealth);
  let standby: ReturnType<typeof start> | null = null;
  try {
    await until(async () => {
      const [row] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
      return row?.ownerInstanceId === 'test-crawler-primary' ? row : null;
    }, 30_000);
    await until(async () => {
      try {
        const health = JSON.parse(await readFile(primaryHealth, 'utf8')) as { status: string };
        return health.status === 'running' ? health : null;
      } catch { return null; }
    }, 30_000);
    standby = start('standby', standbyHealth);
    await until(async () => {
      const [row] = await db.select().from(operationsObservations)
        .where(eq(operationsObservations.key, 'candidate:crawler:test-crawler-standby'));
      return row?.value.phase === 'standby' ? row : null;
    }, 30_000);
    const [stillPrimary] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
    expect(stillPrimary.ownerInstanceId).toBe('test-crawler-primary');
    expect(await readFile(standbyHealth, 'utf8').catch(() => null)).toBeNull();
    const checkStandby = () => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/worker-healthcheck.ts'], {
      cwd: process.cwd(), env: { ...process.env, WORKER_ROLE: 'crawler',
        WORKER_HEALTH_PATH: standbyHealth, ROLE_HEALTH_PATH: standbyRoleHealth },
    });
    expect(checkStandby().status).toBe(0);
    const primaryExit = new Promise<number | null>(resolve => primary.child.once('exit', resolve));
    primary.child.kill('SIGTERM');
    expect(await primaryExit, primary.output()).toBe(0);
    await until(async () => {
      const [row] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
      return row?.ownerInstanceId === 'test-crawler-standby' ? row : null;
    }, 30_000);
    expect(checkStandby().status).toBe(0);
    await until(async () => {
      try {
        const health = JSON.parse(await readFile(standbyHealth, 'utf8')) as { status: string };
        return health.status === 'running' ? health : null;
      } catch { return null; }
    }, 30_000);
    const standbyExit = new Promise<number | null>(resolve => standby!.child.once('exit', resolve));
    standby.child.kill('SIGTERM');
    expect(await standbyExit, standby.output()).toBe(0);
  } finally {
    if (primary.child.exitCode === null) primary.child.kill('SIGTERM');
    if (standby?.child.exitCode === null) standby.child.kill('SIGTERM');
  }
}, 90_000);

it('promotes standby after the primary supervisor crashes and its DB lease expires', async () => {
  await db.delete(jobs);
  await db.delete(roleLeases);
  const start = (kind: 'primary' | 'standby') => {
    const healthPath = join('/tmp', `nomorevibe-role-crash-${kind}-${process.pid}.json`);
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/role-worker.ts',
      '--role=crawler', `--kind=${kind}`], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, DB_POOL_MAX: '2',
        SERVICE_INSTANCE_ID: `test-crash-${kind}`, RELEASE_TAG: 'process-test',
        WORKER_HEALTH_PATH: healthPath,
        ROLE_HEALTH_PATH: join('/tmp', `nomorevibe-role-crash-candidate-${kind}-${process.pid}.json`) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += String(data); });
    child.stderr.on('data', data => { output += String(data); });
    return { child, healthPath, output: () => output };
  };
  const primary = start('primary');
  let standby: ReturnType<typeof start> | null = null;
  try {
    const primaryHealth = await until(async () => {
      try {
        const health = JSON.parse(await readFile(primary.healthPath, 'utf8')) as { status: string; childPid: number };
        return health.status === 'running' && health.childPid ? health : null;
      } catch { return null; }
    }, 30_000);
    standby = start('standby');
    await until(async () => {
      const [row] = await db.select().from(operationsObservations)
        .where(eq(operationsObservations.key, 'candidate:crawler:test-crash-standby'));
      return row?.value.phase === 'standby' ? row : null;
    }, 30_000);
    const crashed = new Promise<number | null>(resolve => primary.child.once('exit', resolve));
    process.kill(-primaryHealth.childPid, 'SIGKILL');
    expect(await crashed, primary.output()).toBe(1);
    const [old] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
    expect(old.ownerInstanceId).toBe('test-crash-primary');
    await db.update(roleLeases).set({ leaseUntil: sql`now() - interval '21 seconds'` })
      .where(eq(roleLeases.role, 'crawler'));
    await until(async () => {
      const [row] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
      return row?.ownerInstanceId === 'test-crash-standby' ? row : null;
    }, 30_000);
    const standbyExit = new Promise<number | null>(resolve => standby!.child.once('exit', resolve));
    standby.child.kill('SIGTERM');
    expect(await standbyExit, standby.output()).toBe(0);
  } finally {
    if (primary.child.exitCode === null) primary.child.kill('SIGTERM');
    if (standby?.child.exitCode === null) standby.child.kill('SIGTERM');
  }
}, 90_000);

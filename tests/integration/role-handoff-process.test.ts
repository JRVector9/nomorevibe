import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { db } from '@/lib/db';
import { jobs, operationsObservations, roleLeases } from '@/lib/db/schema';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

beforeAll(() => ensureSchema());

async function until<T>(read: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('role process did not reach expected state');
}

type Started = { child: ReturnType<typeof spawn>; output: () => string; health: string; role: string };
function start(name: string, kind: 'primary' | 'standby', instanceId: string, env: Record<string, string> = {}): Started {
  const health = join('/tmp', `nomorevibe-handoff-${name}-${process.pid}.json`);
  const role = join('/tmp', `nomorevibe-handoff-candidate-${name}-${process.pid}.json`);
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/role-worker.ts', '--role=crawler', `--kind=${kind}`], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, DB_POOL_MAX: '2', SERVICE_INSTANCE_ID: instanceId,
      RELEASE_TAG: 'handoff-test', WORKER_HEALTH_PATH: health, ROLE_HEALTH_PATH: role, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', data => { output += String(data); });
  child.stderr!.on('data', data => { output += String(data); });
  return { child, output: () => output, health, role };
}

const events = (worker: Started, event: string) => worker.output().split('\n').filter(line => line.startsWith('{'))
  .map(line => { try { return JSON.parse(line) as { event?: string; at?: string } & Record<string, unknown>; } catch { return {}; } })
  .filter(line => line.event === event);

const owner = (instanceId: string) => until(async () => {
  const [row] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
  return row?.ownerInstanceId === instanceId ? row : null;
});

async function stop(worker: Started | null) {
  if (!worker || worker.child.exitCode !== null) return null;
  const exited = new Promise<number | null>(resolve => worker.child.once('exit', resolve));
  worker.child.kill('SIGTERM');
  return exited;
}

// 2026-10-22 #597 을 실제 프로세스로: 같은 릴리스로 재시작하는 주가 정상 반납한 역할을 예비가 넘겨받은 뒤,
// 다시 뜬 주가 기다리면 예비가 자식을 drain 하고 넘긴다. 예비 자식이 멈춘 뒤에야 주가 선출된다.
it('a same-release standby hands the role back to the restarted primary after draining its own supervisor', async () => {
  await db.delete(jobs);
  await db.delete(roleLeases);
  await db.delete(operationsObservations).where(like(operationsObservations.key, 'candidate:%'));
  const handoff = { ROLE_HANDOFF_STABLE_SECONDS: '2', ROLE_HANDOFF_POLL_SECONDS: '1' };
  const primary: Started = start('primary-1', 'primary', 'test-handoff-primary');
  let standby: Started | null = null, restarted: Started | null = null;
  try {
    await owner('test-handoff-primary');
    standby = start('standby', 'standby', 'test-handoff-standby', handoff);
    await until(async () => {
      try { return JSON.parse(await readFile(standby!.role, 'utf8')).phase === 'standby' || null; } catch { return null; }
    });
    // 주가 같은 릴리스로 재시작한다: 정상 반납 → 같은 릴리스 예비가 넘겨받는다
    expect(await stop(primary), primary.output()).toBe(0);
    const taken = await owner('test-handoff-standby');
    restarted = start('primary-2', 'primary', 'test-handoff-primary');
    const back = await owner('test-handoff-primary');
    expect(back.epoch).toBe(taken.epoch + 1);
    expect(back.ownerKind).toBe('primary');
    const [handed] = events(standby, 'role.primary_handoff');
    expect(handed).toMatchObject({ role: 'crawler', epoch: taken.epoch, primaryInstanceId: 'test-handoff-primary' });
    const [yielded] = events(standby, 'role.primary_handoff_yielded');
    expect(yielded).toMatchObject({ yielded: true, epoch: taken.epoch });
    const [stopped] = events(standby, 'role.supervisor_stopped').filter(line => line.handoffRelease === true);
    expect(stopped).toMatchObject({ exitCode: 0 });
    const [acquired] = await until(async () => {
      const lines = events(restarted!, 'role.acquired');
      return lines.length ? lines : null;
    });
    // 겹치지 않는다: 예비 자식이 멈추고 넘긴 뒤에 주가 선출됐다
    expect(Date.parse(String(stopped.at))).toBeLessThanOrEqual(Date.parse(String(yielded.at)));
    expect(Date.parse(String(yielded.at))).toBeLessThanOrEqual(Date.parse(String(acquired.at)));
    // 넘긴 예비는 다시 기다리는 후보다
    await until(async () => {
      try { return JSON.parse(await readFile(standby!.role, 'utf8')).phase === 'standby' || null; } catch { return null; }
    });
    const [row] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
    expect(row.ownerInstanceId).toBe('test-handoff-primary');
    expect(await stop(standby), standby.output()).toBe(0);
    expect(await stop(restarted), restarted.output()).toBe(0);
  } finally {
    for (const worker of [primary, standby, restarted]) if (worker?.child.exitCode === null) worker.child.kill('SIGKILL');
  }
}, 120_000);

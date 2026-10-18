import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThroughputSnapshot } from '@/lib/operations/throughput-model';
import type { ConsumerName } from '@/lib/runtime/consumer-registry';

// B0: 등록부에 시험용 consumer 하나(fixture-scan, 부모 crawler)를 더해 일반화한 경로를 본다. 실제 등록부는 ai1·ai2·agent-scan(E5)을 갖는다.
vi.mock('@/lib/runtime/consumer-registry', async load => {
  const actual = await load<typeof import('@/lib/runtime/consumer-registry')>();
  const CONSUMERS = { ...actual.CONSUMERS, 'fixture-scan': { role: 'crawler', command: ['scripts/fixture-scan-consumer.ts'], workerMax: 2 } };
  const consumerNames = () => Object.keys(CONSUMERS);
  return { ...actual, CONSUMERS, consumerNames,
    consumerSpec: (name: string) => Object.hasOwn(CONSUMERS, name) ? CONSUMERS[name as keyof typeof CONSUMERS] : undefined,
    consumerOfInstance: (id: string | null | undefined) => id ? consumerNames().find(name => id.startsWith(actual.consumerInstancePrefix(name))) ?? null : null };
});
const boundary = vi.hoisted(() => ({ spawn: vi.fn(), observe: vi.fn() }));
vi.mock('@/lib/operations/observations', () => ({ observeService: boundary.observe }));
vi.mock('node:child_process', async load => ({ ...await load<typeof import('node:child_process')>(), spawn: boundary.spawn }));

const { assertHostDbEntry, HostDbBudgetSchema, hostDbBudgetCatalog, hostDbChildEnvironment } = await import('@/lib/db/host-budget');
const { dbPoolConfig } = await import('@/lib/db/pool');
const { superviseWorker, supervisorCommand, supervisorHealthPath, consumerHealthPath } = await import('@/scripts/worker-supervisor');
const { latestServiceInstance, serviceInstancesFromObservations, supersededServiceInstanceKeys } = await import('@/lib/operations/instance');
const { buildWorkerProgress } = await import('@/lib/operations/worker-progress-query');
const FIXTURE = 'fixture-scan' as ConsumerName;

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => vi.unstubAllEnvs());

const policy = { version: 1 as const, host: 'oracle-osaka-smoke' as const, release: 'a'.repeat(40), roles: [] as string[],
  schedulerReplicas: 0, webReplicas: 0, webReadReplica: false, monitor: false, connectAgent: false,
  preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 1 as const };
function environment(kind: 'role-parent' | 'worker' = 'role-parent', process: Record<string, unknown> = {}, policyChanges: Record<string, unknown> = {}) {
  return { WORKER_ROLE: 'crawler', PHYSICAL_HOST: 'oracle-osaka-smoke', RELEASE_TAG: policy.release,
    HOST_DB_BUDGET: JSON.stringify({ mode: 'enabled', policy: { ...policy, consumers: ['fixture-scan'], ...policyChanges },
      process: { kind, role: 'crawler', host: 'oracle-osaka-smoke', release: policy.release, replica: 1, copy: 1, consumer: 'fixture-scan', ...process } }) };
}

it('declares a registered consumer pair under its parent role with the registry pool limit', () => {
  const declared = { ...policy, consumers: ['fixture-scan'] };
  expect(HostDbBudgetSchema.safeParse(declared).success).toBe(true);
  expect(hostDbBudgetCatalog(declared)).toMatchObject({ totalClients: 3, processes: [
    { kind: 'role-parent', role: 'crawler', count: 1, primaryMax: 1, readMax: 0, consumer: 'fixture-scan' },
    { kind: 'worker', role: 'crawler', count: 1, primaryMax: 2, readMax: 0, consumer: 'fixture-scan' }] });
  expect(hostDbBudgetCatalog({ ...declared, roles: ['crawler'], rolloutCopies: 2 }).totalClients).toBe(2 * (1 + 4) + 2 * (1 + 2));
  expect(hostDbBudgetCatalog({ ...policy, consumers: [] })).toEqual(hostDbBudgetCatalog(policy));
});
it('rejects unknown, duplicated or AI rosters in the general consumer field', () => {
  // ai1·ai2 는 옛 칸(reviewerConsumers)에만 선언한다 — 두 칸으로 같은 자리를 두 번 세지 않는다
  for (const consumers of [['unregistered-scan'], ['fixture-scan', 'fixture-scan'], ['ai1'], ['legacy'], ['crawler'], [null], 'fixture-scan'])
    expect(HostDbBudgetSchema.safeParse({ ...policy, consumers }).success).toBe(false);
  // E5 가 등록한 실제 consumer 는 일반 칸에 선언한다(부모 crawler, 자식 pool 3)
  expect(hostDbBudgetCatalog({ ...policy, consumers: ['agent-scan'] }).processes).toEqual([
    { kind: 'role-parent', role: 'crawler', count: 1, primaryMax: 1, readMax: 0, consumer: 'agent-scan' },
    { kind: 'worker', role: 'crawler', count: 1, primaryMax: 3, readMax: 0, consumer: 'agent-scan' }]);
});
it('matches parent and child entries only for the exact consumer and derives the child kind', () => {
  const env = environment();
  expect(() => assertHostDbEntry(env, { kind: 'role-parent', role: 'crawler', consumer: FIXTURE })).not.toThrow();
  expect(dbPoolConfig(env).max).toBe(1);
  const child = hostDbChildEnvironment(env, 'crawler', FIXTURE);
  expect(JSON.parse(child.HOST_DB_BUDGET!).process).toMatchObject({ kind: 'worker', consumer: 'fixture-scan' });
  assertHostDbEntry(child, { kind: 'worker', role: 'crawler', consumer: FIXTURE });
  expect(dbPoolConfig(child).max).toBe(2);
  expect(() => dbPoolConfig({ ...child, DB_POOL_MAX: '3' })).toThrow('host_db_pool_quota_exceeded');
  // 역할 워커가 consumer 자리를, consumer 가 역할 자리를 빌리지 못한다
  expect(() => assertHostDbEntry(env, { kind: 'role-parent', role: 'crawler' })).toThrow('host_db_entry_mismatch');
  const role = environment('role-parent', { consumer: undefined }, { roles: ['crawler'] });
  expect(() => assertHostDbEntry(role, { kind: 'role-parent', role: 'crawler', consumer: FIXTURE })).toThrow('host_db_entry_mismatch');
  expect(() => assertHostDbEntry(env, { kind: 'role-parent', role: 'reviewer', consumer: FIXTURE })).toThrow('host_db_entry_mismatch');
});
it('refuses a consumer declared under another role or left out of the roster', () => {
  for (const [process, changes] of [[{ role: 'reviewer' }, {}], [{ consumer: 'legacy' }, {}], [{ consumer: 'ai1' }, {}], [{}, { consumers: [] }]] as const) {
    const env = { ...environment('role-parent', process, changes), WORKER_ROLE: (process as { role?: string }).role ?? 'crawler' };
    expect(() => assertHostDbEntry(env, { kind: 'role-parent', role: env.WORKER_ROLE, consumer: FIXTURE }))
      .toThrow(/host_db_budget_invalid|host_db_entry_mismatch|host_db_process_not_declared/);
  }
});

it('runs only the registry command under the registry parent role and routes its health file', () => {
  expect(supervisorCommand('crawler', { consumer: FIXTURE, once: true })).toEqual(['scripts/fixture-scan-consumer.ts', '--once']);
  expect(supervisorCommand('crawler', { consumer: FIXTURE })).toEqual(['scripts/fixture-scan-consumer.ts']);
  expect(() => supervisorCommand('reviewer', { consumer: FIXTURE })).toThrow('invalid_item_consumer_role');
  expect(() => supervisorCommand('crawler', { consumer: 'unregistered-scan' as ConsumerName })).toThrow('invalid_item_consumer_role');
  expect(supervisorCommand('crawler', { consumer: 'agent-scan' })).toEqual(['scripts/agent-scan-consumer.ts']);
  expect(() => supervisorCommand('reviewer', { consumer: 'agent-scan' })).toThrow('invalid_item_consumer_role');
  const env = { SERVICE_INSTANCE_ID: 'fixture-scan-consumer-oracle' };
  expect(consumerHealthPath(env)).toBe('/tmp/nomorevibe-fixture-scan-consumer-health.json');
  expect(supervisorHealthPath({ consumer: FIXTURE }, env)).toBe('/tmp/nomorevibe-fixture-scan-consumer-health.json');
  for (const path of ['/tmp/nomorevibe-worker-health.json', '/tmp/./nomorevibe-ai1-consumer-health.json', '/tmp/nomorevibe-ai2-consumer-health.json'])
    expect(() => supervisorHealthPath({ consumer: FIXTURE, healthPath: path }, env)).toThrow('invalid_item_consumer_health_path');
  for (const id of ['fixture-scan-consumer-', 'ai1-consumer-oracle', 'crawler-oracle'])
    expect(() => supervisorHealthPath({ consumer: FIXTURE }, { SERVICE_INSTANCE_ID: id })).toThrow('invalid_item_consumer_service_instance');
  // 다른 consumer 도 이 consumer 의 기본 파일을 쓰지 못한다
  expect(() => consumerHealthPath({ SERVICE_INSTANCE_ID: 'ai2-consumer-m3', WORKER_HEALTH_PATH: '/tmp/nomorevibe-fixture-scan-consumer-health.json' }))
    .toThrow('invalid_item_consumer_health_path');
});
it('transfers the consumer declaration to the fixed child before any observation', async () => {
  const env = environment();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv('SERVICE_INSTANCE_ID', 'fixture-scan-consumer-oracle');
  const stop = new Error('stop_at_spawn'); boundary.spawn.mockImplementation(() => { throw stop; });
  await expect(superviseWorker('crawler', { consumer: FIXTURE, once: true })).rejects.toBe(stop);
  const [, args, options] = boundary.spawn.mock.calls[0];
  expect(args).toEqual(['--import', 'tsx', 'scripts/fixture-scan-consumer.ts', '--once']);
  expect(JSON.parse(options.env.HOST_DB_BUDGET).process).toMatchObject({ kind: 'worker', role: 'crawler', consumer: 'fixture-scan' });
  expect(options.env.WORKER_ROLE).toBe('crawler');
  expect(boundary.observe).not.toHaveBeenCalled();
  boundary.spawn.mockClear();
  vi.stubEnv('SERVICE_INSTANCE_ID', 'crawler-oracle');
  await expect(superviseWorker('crawler', { consumer: FIXTURE, once: true })).rejects.toThrow('invalid_item_consumer_service_instance');
  expect(boundary.spawn).not.toHaveBeenCalled();
});

it('never lets a live consumer observation stand in for its dead parent role (R5)', () => {
  const now = new Date('2026-10-19T00:10:00Z');
  const rows = serviceInstancesFromObservations([
    { key: 'service:crawler:crawler-m3', value: { status: 'running', bootedAt: 1, release: 'old' }, observedAt: '2026-10-19T00:00:00Z' },
    { key: 'service:crawler:fixture-scan-consumer-oracle', value: { status: 'running', bootedAt: 2, release: 'new' }, observedAt: '2026-10-19T00:09:55Z' },
  ]);
  expect(latestServiceInstance(rows, 'crawler')?.instanceId).toBe('crawler-m3');
  expect(supersededServiceInstanceKeys(rows, now.getTime())).toEqual(new Set());
  const stage = (key: string) => ({ key, enabled: true, waiting: 0, oldestMinutes: null, completed5m: 0, progress5m: 0, errors5m: 0 });
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [] } as unknown as ThroughputSnapshot, [],
    rows, now, { mode: 'legacy', writerContractVersion: 0 }, [stage('agent-evidence')] as never);
  expect(report.liveness.find(row => row.role === 'crawler')).toMatchObject({ reason: 'worker_missing', alarm: true });
  expect(report.overall).toBe('alarm');
});

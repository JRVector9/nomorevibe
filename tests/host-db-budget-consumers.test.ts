import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { assertHostDbEntry, HostDbBudgetSchema, hostDbBudgetCatalog, hostDbChildEnvironment, resolveHostDbPoolConfig } from '@/lib/db/host-budget';
import { dbPoolConfig } from '@/lib/db/pool';
import { runPipelineFirstConsumer } from '@/scripts/pipeline-first-consumer';
import { runPipelineConsumer } from '@/scripts/pipeline-consumer';
import { superviseWorker } from '@/scripts/worker-supervisor';

const boundary = vi.hoisted(() => ({ runtime: vi.fn(), first: vi.fn(), second: vi.fn(), spawn: vi.fn(), observe: vi.fn() }));
vi.mock('@/scripts/worker', () => ({ withRuntimeProcess: boundary.runtime }));
vi.mock('@/lib/crawl/consumers/first', () => ({ runFirstReviewConsumer: boundary.first }));
vi.mock('@/lib/crawl/consumers/second', () => ({ runSecondReviewConsumer: boundary.second }));
vi.mock('@/lib/operations/observations', () => ({ observeService: boundary.observe }));
vi.mock('node:child_process', async load => ({ ...await load<typeof import('node:child_process')>(), spawn: boundary.spawn }));
beforeEach(() => {
  vi.resetAllMocks();
  boundary.first.mockResolvedValue({ attempted: 0, recorded: 0, skipped: 0, deferred: 0 });
  boundary.second.mockResolvedValue({ attempted: 0, recorded: 0, skipped: 0, deferred: 0 });
  boundary.runtime.mockImplementation(async (_role, load) => load(new AbortController().signal, () => {}));
});
afterEach(() => vi.unstubAllEnvs());

const policy = { version: 1 as const, host: 'm3' as const, release: 'roster-test', roles: ['reviewer'],
  schedulerReplicas: 0, webReplicas: 0, webReadReplica: false, monitor: false, connectAgent: false,
  preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 1 as const };
function environment(kind: 'role-parent' | 'worker' = 'role-parent') {
  return { WORKER_ROLE: 'reviewer', PHYSICAL_HOST: 'm3', RELEASE_TAG: 'roster-test',
    HOST_DB_BUDGET: JSON.stringify({ mode: 'enabled', policy,
      process: { kind, role: 'reviewer', host: 'm3', release: 'roster-test', replica: 1, copy: 1 } }) };
}

it('refuses an AI1 expected entry borrowing a valid legacy reviewer slot', () => {
  expect(() => assertHostDbEntry(environment(), { kind: 'role-parent', role: 'reviewer', consumer: 'ai1' }))
    .toThrow('host_db_entry_mismatch');
});
it('refuses deriving an AI2 child from a valid legacy reviewer parent', () => {
  expect(() => hostDbChildEnvironment(environment(), 'reviewer', 'ai2')).toThrow('host_db_entry_mismatch');
});
it('keeps old reviewer catalog rows and their absent consumer keys exact', () => {
  expect(hostDbBudgetCatalog(policy)).toEqual({ host: 'm3', release: 'roster-test',
    processes: [
      { kind: 'role-parent', role: 'reviewer', count: 1, primaryMax: 1, readMax: 0 },
      { kind: 'worker', role: 'reviewer', count: 1, primaryMax: 3, readMax: 0 },
    ], primaryClients: 4, replicaClients: 0, totalClients: 4,
    enforcement: 'unknown', ready: false, activationAllowed: false });
});
it('preserves the disabled original config identity and no-env child environment', () => {
  const original = { role: 'reviewer', max: 7, unrelated: 'unchanged' };
  expect(resolveHostDbPoolConfig(original).config).toBe(original);
  const env = { WORKER_ROLE: 'web', DB_POOL_MAX: '7', CUSTOM: 'unchanged' };
  expect(hostDbChildEnvironment(env, 'reviewer')).toEqual({ ...env, WORKER_ROLE: 'reviewer' });
});
it('keeps legacy parent and child identity while changing only the kind', () => {
  const env = environment(), before = structuredClone(env);
  assertHostDbEntry(env, { kind: 'role-parent', role: 'reviewer' });
  expect(dbPoolConfig(env).max).toBe(1);
  const child = hostDbChildEnvironment(env, 'reviewer');
  expect(JSON.parse(child.HOST_DB_BUDGET!)).toEqual({ mode: 'enabled', policy,
    process: { kind: 'worker', role: 'reviewer', host: 'm3', release: 'roster-test', replica: 1, copy: 1 } });
  expect(dbPoolConfig(child).max).toBe(3); expect(env).toEqual(before);
});

function consumerEnvironment(consumer: 'legacy' | 'ai1' | 'ai2', kind: 'role-parent' | 'worker' = 'role-parent') {
  const env = environment(kind), options = JSON.parse(env.HOST_DB_BUDGET);
  options.policy.reviewerConsumers = ['ai1', 'ai2'];
  if (consumer !== 'legacy') options.process.consumer = consumer;
  return { ...env, HOST_DB_BUDGET: JSON.stringify(options) };
}
it('counts the three fixed reviewer pairs separately and keeps their rolling copies', () => {
  const selected = { ...policy, reviewerConsumers: ['ai2', 'ai1'] };
  expect(HostDbBudgetSchema.safeParse(selected).success).toBe(true);
  const result = hostDbBudgetCatalog(selected), original = hostDbBudgetCatalog(policy);
  expect(result.processes).toEqual([...original.processes,
    { kind: 'role-parent', role: 'reviewer', count: 1, primaryMax: 1, readMax: 0, consumer: 'ai1' },
    { kind: 'worker', role: 'reviewer', count: 1, primaryMax: 3, readMax: 0, consumer: 'ai1' },
    { kind: 'role-parent', role: 'reviewer', count: 1, primaryMax: 1, readMax: 0, consumer: 'ai2' },
    { kind: 'worker', role: 'reviewer', count: 1, primaryMax: 3, readMax: 0, consumer: 'ai2' }]);
  expect(result).toMatchObject({ totalClients: 12, enforcement: 'unknown', ready: false, activationAllowed: false });
  const rolling = hostDbBudgetCatalog({ ...selected, rolloutCopies: 2 });
  expect(rolling.totalClients).toBe(24); expect(rolling.processes.every(row => row.count === 2)).toBe(true);
});
it('allows a consumer-only roster without implicitly adding a legacy reviewer pair', () => {
  const selected = { ...policy, roles: [], reviewerConsumers: ['ai1'] };
  expect(HostDbBudgetSchema.safeParse(selected).success).toBe(true);
  const result = hostDbBudgetCatalog(selected);
  expect(result.totalClients).toBe(4); expect(result.processes).toHaveLength(2);
  expect(result.processes.every(row => row.consumer === 'ai1')).toBe(true);
  expect(hostDbBudgetCatalog({ ...selected, rolloutCopies: 2 }).totalClients).toBe(8);
  expect(hostDbBudgetCatalog({ ...policy, reviewerConsumers: [] })).toEqual(hostDbBudgetCatalog(policy));
});
it('rejects malformed consumer rosters and never defaults a missing policy field into old input', () => {
  for (const reviewerConsumers of [['ai1', 'ai1'], ['legacy'], ['crawler'], ['ai1', 'ai2', 'ai1'], [null], new Array(1)])
    expect(HostDbBudgetSchema.safeParse({ ...policy, reviewerConsumers }).success).toBe(false);
  expect(HostDbBudgetSchema.parse(policy)).toEqual(policy);
});
it('matches each declared consumer parent and child to its own fixed entry and pool quota', () => {
  for (const consumer of ['legacy', 'ai1', 'ai2'] as const) {
    const env = consumerEnvironment(consumer);
    expect(() => assertHostDbEntry(env, { kind: 'role-parent', role: 'reviewer', consumer })).not.toThrow();
    expect(dbPoolConfig(env).max).toBe(1);
    const child = hostDbChildEnvironment(env, 'reviewer', consumer);
    assertHostDbEntry(child, { kind: 'worker', role: 'reviewer', consumer });
    expect(dbPoolConfig(child).max).toBe(3);
    expect(() => dbPoolConfig(child, 'read')).toThrow('host_db_read_pool_not_declared');
    expect(() => dbPoolConfig({ ...child, DB_POOL_MAX: '4' })).toThrow('host_db_pool_quota_exceeded');
  }
});
it('refuses every cross-consumer entry including implicit legacy expectations', () => {
  for (const actual of ['legacy', 'ai1', 'ai2'] as const) {
    const env = consumerEnvironment(actual);
    for (const expected of ['legacy', 'ai1', 'ai2'] as const) if (expected !== actual)
      expect(() => assertHostDbEntry(env, { kind: 'role-parent', role: 'reviewer', consumer: expected })).toThrow('host_db_entry_mismatch');
    if (actual !== 'legacy') expect(() => assertHostDbEntry(env, { kind: 'role-parent', role: 'reviewer' })).toThrow('host_db_entry_mismatch');
  }
});
it('refuses consumer impersonation by another role or an undeclared consumer', () => {
  for (const consumer of ['legacy', 'ai1', 'ai2'] as const) {
    const options = JSON.parse(consumerEnvironment('ai1').HOST_DB_BUDGET);
    options.process.role = 'translation'; options.process.consumer = consumer; options.policy.roles = ['translation'];
    const env = { ...environment(), WORKER_ROLE: 'translation', HOST_DB_BUDGET: JSON.stringify(options) };
    expect(() => assertHostDbEntry(env, { kind: 'role-parent', role: 'translation' })).toThrow('host_db_budget_invalid');
  }
  const env = consumerEnvironment('ai2'), options = JSON.parse(env.HOST_DB_BUDGET);
  options.policy.reviewerConsumers = ['ai1'];
  expect(() => assertHostDbEntry({ ...env, HOST_DB_BUDGET: JSON.stringify(options) },
    { kind: 'role-parent', role: 'reviewer', consumer: 'ai2' })).toThrow('host_db_process_not_declared');
});
it('preserves a consumer rolling identity and all unrelated environment while deriving only the child kind', () => {
  const env = consumerEnvironment('ai1'), options = JSON.parse(env.HOST_DB_BUDGET);
  options.policy.rolloutCopies = 2; options.process.copy = 2;
  const input = { ...env, HOST_DB_BUDGET: JSON.stringify(options), UNRELATED: 'retained' }, before = structuredClone(input);
  expect(() => hostDbChildEnvironment(input, 'reviewer', 'ai1')).not.toThrow();
  const child = hostDbChildEnvironment(input, 'reviewer', 'ai1');
  expect(JSON.parse(child.HOST_DB_BUDGET!)).toEqual({ ...options, process: { ...options.process, kind: 'worker' } });
  expect({ ...child, HOST_DB_BUDGET: input.HOST_DB_BUDGET }).toEqual(input); expect(input).toEqual(before);
  expect(() => hostDbChildEnvironment(child, 'reviewer', 'ai1')).toThrow('host_db_entry_mismatch');
});

function cliEnvironment(consumer: 'ai1' | 'ai2', selected: 'legacy' | 'ai1' | 'ai2' = consumer) {
  return { ...consumerEnvironment(selected, 'worker'), PIPELINE_ITEM_CONSUMER_VERSION: '1',
    PIPELINE_ITEM_CONSUMER_INSTANCE_ID: `${consumer}-consumer-roster`, SERVICE_INSTANCE_ID: `${consumer}-consumer-roster` };
}
function cli(consumer: 'ai1' | 'ai2', env: Readonly<Record<string, string | undefined>>) {
  return consumer === 'ai1' ? runPipelineFirstConsumer(['--once'], env) : runPipelineConsumer(['--stage=ai2', '--once'], env);
}
it.each(['ai1', 'ai2'] as const)('refuses the actual %s CLI borrowing legacy before runtime or queue work', async consumer => {
  await expect(cli(consumer, cliEnvironment(consumer, 'legacy'))).rejects.toThrow('host_db_entry_mismatch');
  expect(boundary.runtime).not.toHaveBeenCalled(); expect(boundary.first).not.toHaveBeenCalled();
  expect(boundary.second).not.toHaveBeenCalled(); expect(boundary.observe).not.toHaveBeenCalled();
});
it.each(['ai1', 'ai2'] as const)('keeps the actual %s CLI runtime and owner contract when the declaration matches', async consumer => {
  const env = cliEnvironment(consumer), loop = consumer === 'ai1' ? boundary.first : boundary.second;
  expect(await cli(consumer, env)).toEqual({ state: 'stopped', attempted: 0, recorded: 0, skipped: 0, deferred: 0 });
  expect(boundary.runtime).toHaveBeenCalledExactlyOnceWith('reviewer', expect.any(Function));
  expect(loop).toHaveBeenCalledExactlyOnceWith({ owner: { instanceId: `${consumer}-consumer-roster`, bootId: expect.any(String) },
    signal: expect.any(AbortSignal), report: expect.any(Function), once: true });
  expect(loop.mock.calls[0][0].owner.bootId).toMatch(/^[0-9a-f-]{36}$/);
});
it.each(['ai1', 'ai2'] as const)('preserves default opt-out before the %s CLI reads malformed budget or starts observations', async consumer => {
  expect(await cli(consumer, { HOST_DB_BUDGET: 'invalid' })).toEqual({ state: 'disabled' });
  expect(boundary.runtime).not.toHaveBeenCalled(); expect(boundary.first).not.toHaveBeenCalled();
  expect(boundary.second).not.toHaveBeenCalled(); expect(boundary.observe).not.toHaveBeenCalled();
});
it.each(['ai1', 'ai2'] as const)('preserves invalid-version precedence over the %s CLI budget validation', async consumer => {
  await expect(cli(consumer, { PIPELINE_ITEM_CONSUMER_VERSION: '2', HOST_DB_BUDGET: 'invalid' }))
    .rejects.toThrow('invalid_pipeline_item_consumer_version');
  expect(boundary.runtime).not.toHaveBeenCalled();
});
it.each(['ai1', 'ai2'] as const)('refuses the actual %s supervisor borrowing legacy before spawn or observation', async consumer => {
  for (const [key, value] of Object.entries(environment())) vi.stubEnv(key, value);
  vi.stubEnv('SERVICE_INSTANCE_ID', `${consumer}-consumer-roster`);
  boundary.spawn.mockImplementation(() => { throw new Error('unexpected_spawn'); });
  await expect(superviseWorker('reviewer', { consumer, once: true })).rejects.toThrow('host_db_entry_mismatch');
  expect(boundary.spawn).not.toHaveBeenCalled(); expect(boundary.observe).not.toHaveBeenCalled();
});
it.each(['ai1', 'ai2'] as const)('transfers the actual %s supervisor declaration to its fixed child command', async consumer => {
  const env = consumerEnvironment(consumer);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv('SERVICE_INSTANCE_ID', `${consumer}-consumer-roster`);
  const stop = new Error('stop_at_spawn'); boundary.spawn.mockImplementation(() => { throw stop; });
  await expect(superviseWorker('reviewer', { consumer, once: true })).rejects.toBe(stop);
  expect(boundary.spawn).toHaveBeenCalledOnce();
  const [executable, args, options] = boundary.spawn.mock.calls[0];
  expect(executable).toBe(process.execPath);
  expect(args).toEqual(['--import', 'tsx', ...(consumer === 'ai1' ? ['scripts/pipeline-first-consumer.ts']
    : ['scripts/pipeline-consumer.ts', '--stage=ai2']), '--once']);
  const original = JSON.parse(env.HOST_DB_BUDGET);
  expect(JSON.parse(options.env.HOST_DB_BUDGET)).toEqual({ ...original, process: { ...original.process, kind: 'worker' } });
  expect(JSON.parse(process.env.HOST_DB_BUDGET!)).toEqual(original);
  expect(boundary.observe).not.toHaveBeenCalled();
});

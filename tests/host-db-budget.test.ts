import { expect, it } from 'vitest';
import { dbPoolConfig } from '@/lib/db/pool';
import { HostDbBudgetSchema, hostDbBudgetCatalog, resolveHostDbPoolConfig } from '@/lib/db/host-budget';

const policy = {
  version: 1 as const, host: 'oracle-osaka-smoke' as const, release: 'release-1',
  roles: ['translation', 'product-health', 'site-evidence', 'official-news'],
  schedulerReplicas: 1, webReplicas: 0, webReadReplica: false, monitor: true, connectAgent: false,
  preflightProcesses: 1, migrationProcesses: 0, rolloutCopies: 1 as const,
};
const parent = { host: policy.host, release: policy.release, role: 'translation', kind: 'role-parent', replica: 1, copy: 1 };
const enabled = (process = parent, overrides?: { max?: number; readMax?: number }) => ({ mode: 'enabled', policy, process, overrides });
const config = { role: 'translation', max: 3, waitMs: 5000, poolerMode: 'pgbouncer', statementMs: 60000 };

it('strictly parses fixed hosts and all declared process categories without accepting evidence booleans', () => {
  for (const host of ['m3', 'mini', 'oracle-osaka-smoke']) expect(HostDbBudgetSchema.parse({ ...policy, host }).host).toBe(host);
  for (const patch of [{ version: 2 }, { host: 'onetwoday' }, { ready: true }, { enforced: true },
    { roles: ['translation', 'translation'] }, { roles: ['custom'] }, { schedulerReplicas: 3 },
    { preflightProcesses: 2 }, { rolloutCopies: 3 }, { webReadReplica: true }]) {
    expect(HostDbBudgetSchema.safeParse({ ...policy, ...patch }).success).toBe(false);
  }
});

it('counts role parents including their supervisors once, separate worker pools, scheduler and preflight', () => {
  const result = hostDbBudgetCatalog(policy);
  expect(result.primaryClients).toBe(21);
  expect(result.replicaClients).toBe(0);
  expect(result.totalClients).toBe(21);
  expect(result.processes.filter(row => row.kind === 'role-parent')).toHaveLength(4);
  expect(result.processes.find(row => row.role === 'translation' && row.kind === 'role-parent')).toMatchObject({ count: 1, primaryMax: 1 });
  expect(result.processes.find(row => row.role === 'translation' && row.kind === 'worker')).toMatchObject({ count: 1, primaryMax: 3 });
  expect(result.processes.filter(row => row.role === 'scheduler').map(row => [row.kind, row.primaryMax])).toEqual([['scheduler-parent', 1], ['scheduler-worker', 2]]);
  expect(result.processes.find(row => row.kind === 'preflight')).toMatchObject({ count: 1, primaryMax: 1 });
});

it('includes web primary plus READ, all nine role children, monitor, connect agent and migration', () => {
  const result = hostDbBudgetCatalog({ ...policy, host: 'm3', roles: ['crawler', 'reviewer', 'publisher', 'text', 'maintenance', ...policy.roles],
    schedulerReplicas: 2, webReplicas: 1, webReadReplica: true, connectAgent: true, migrationProcesses: 1 });
  expect(result.primaryClients).toBe(55);
  expect(result.replicaClients).toBe(4);
  expect(result.totalClients).toBe(59);
  expect(result.processes.find(row => row.kind === 'worker' && row.role === 'crawler')).toMatchObject({ primaryMax: 4 });
  expect(result.processes.find(row => row.kind === 'web')).toMatchObject({ primaryMax: 8, readMax: 4 });
  expect(result.processes.find(row => row.kind === 'migration')).toMatchObject({ count: 1, primaryMax: 1 });
});

it('counts rolling old/new overlap for persistent processes and keeps explicit CLI counts separate', () => {
  const result = hostDbBudgetCatalog({ ...policy, host: 'm3', roles: ['crawler', 'reviewer', 'publisher', 'text', 'maintenance', ...policy.roles],
    schedulerReplicas: 2, webReplicas: 1, webReadReplica: true, connectAgent: true, migrationProcesses: 1, rolloutCopies: 2 });
  expect(result.primaryClients).toBe(108);
  expect(result.replicaClients).toBe(8);
  expect(result.totalClients).toBe(116);
  expect(result.processes.find(row => row.kind === 'scheduler-parent')).toMatchObject({ count: 4 });
  expect(result.processes.find(row => row.kind === 'monitor')).toMatchObject({ count: 2 });
  expect(result.processes.find(row => row.kind === 'preflight')).toMatchObject({ count: 1 });
  expect(result.processes.find(row => row.kind === 'migration')).toMatchObject({ count: 1 });
});

it('never turns declared quotas or a zero-work roster into readiness or enforcement', () => {
  for (const input of [policy, { ...policy, roles: [], schedulerReplicas: 0, monitor: false, preflightProcesses: 0 }]) {
    expect(hostDbBudgetCatalog(input)).toMatchObject({ enforcement: 'unknown', ready: false, activationAllowed: false });
  }
  expect(hostDbBudgetCatalog({ ...policy, roles: [], schedulerReplicas: 0, monitor: false, preflightProcesses: 0 }).totalClients).toBe(0);
});

it('returns the original legacy configuration unchanged in default and explicitly disabled mode', () => {
  const legacy = dbPoolConfig({ WORKER_ROLE: 'crawler', DB_POOL_MAX: '7', DB_POOL_WAIT_MS: '40' });
  for (const options of [undefined, { mode: 'disabled' }]) {
    const result = resolveHostDbPoolConfig(legacy, options);
    expect(result.config).toBe(legacy);
    expect(result.config).toEqual(legacy);
    expect(result).toMatchObject({ enforcement: 'unknown', ready: false, activationAllowed: false });
  }
});

it('applies the fixed parent quota and preserves every unrelated original config field', () => {
  const result = resolveHostDbPoolConfig(config, enabled());
  expect(result.config).toEqual({ ...config, max: 1 });
  expect(result.config).not.toBe(config);
  expect(result.readMax).toBe(0);
  expect(result).toMatchObject({ enforcement: 'unknown', ready: false, activationAllowed: false });
  expect(config.max).toBe(3);
});

it('accepts a lower explicit worker override and uses fixed child quota when absent', () => {
  expect(resolveHostDbPoolConfig(config, enabled({ ...parent, kind: 'worker' })).config.max).toBe(3);
  expect(resolveHostDbPoolConfig(config, enabled({ ...parent, kind: 'worker' }, { max: 2 })).config.max).toBe(2);
  const crawlerPolicy = { ...policy, roles: ['crawler'] };
  expect(resolveHostDbPoolConfig({ ...config, role: 'crawler' }, { mode: 'enabled', policy: crawlerPolicy,
    process: { ...parent, role: 'crawler', kind: 'worker' } }).config.max).toBe(4);
});

it('resolves web READ separately and allows only smaller declared primary/READ overrides', () => {
  const webPolicy = { ...policy, webReplicas: 1, webReadReplica: true };
  const process = { ...parent, role: 'web', kind: 'web' };
  const input = { ...config, role: 'web' };
  expect(resolveHostDbPoolConfig(input, { mode: 'enabled', policy: webPolicy, process })).toMatchObject({ config: { max: 8 }, readMax: 4 });
  expect(resolveHostDbPoolConfig(input, { mode: 'enabled', policy: webPolicy, process, overrides: { max: 3, readMax: 2 } })).toMatchObject({ config: { max: 3 }, readMax: 2 });
});

it('rejects excess, malformed or non-finite explicit quotas and READ outside a declared web pool', () => {
  for (const max of [2, 0, -1, 1.5, Infinity, NaN, '1']) expect(() => resolveHostDbPoolConfig(config, { ...enabled(), overrides: { max } })).toThrow();
  expect(() => resolveHostDbPoolConfig(config, enabled(parent, { readMax: 1 }))).toThrow();
  const process = { ...parent, role: 'web', kind: 'web' };
  for (const readMax of [5, 0, NaN]) expect(() => resolveHostDbPoolConfig({ ...config, role: 'web' }, {
    mode: 'enabled', policy: { ...policy, webReplicas: 1, webReadReplica: true }, process, overrides: { readMax },
  })).toThrow();
});

it('rejects missing, unknown, mismatched or undeclared process identity before yielding a configuration', () => {
  for (const process of [undefined, { ...parent, role: undefined }, { ...parent, role: 'typo' },
    { ...parent, kind: 'supervisor' }, { ...parent, role: 'crawler' }, { ...parent, host: 'm3' },
    { ...parent, release: 'release-2' }, { ...parent, replica: 2 }, { ...parent, copy: 2 }, { ...parent, kind: 'web' },
    { ...parent, kind: 'migration', role: 'migration' }]) {
    expect(() => resolveHostDbPoolConfig(config, { mode: 'enabled', policy, process })).toThrow();
  }
  expect(() => resolveHostDbPoolConfig({ ...config, role: 'web' }, enabled())).toThrow();
  expect(() => resolveHostDbPoolConfig(config, { ...enabled(), mode: 'typo' })).toThrow();
  expect(() => resolveHostDbPoolConfig(config, { ...enabled(), ready: true })).toThrow();
});

it('admits declared second scheduler/rolling copies without accepting an extra process slot', () => {
  const expanded = { ...policy, schedulerReplicas: 2, rolloutCopies: 2 };
  const process = { ...parent, role: 'scheduler', kind: 'scheduler-worker', replica: 2, copy: 2 };
  expect(resolveHostDbPoolConfig({ ...config, role: 'scheduler' }, { mode: 'enabled', policy: expanded, process }).config.max).toBe(2);
  expect(() => resolveHostDbPoolConfig({ ...config, role: 'scheduler' }, { mode: 'enabled', policy: expanded, process: { ...process, replica: 3 } })).toThrow();
});

it('keeps caller policy/config objects intact and does not expose shared mutable catalog rows', () => {
  const before = structuredClone(policy);
  const result = hostDbBudgetCatalog(policy);
  result.processes.length = 0;
  resolveHostDbPoolConfig(config, enabled());
  expect(policy).toEqual(before);
  expect(hostDbBudgetCatalog(policy).processes.length).toBeGreaterThan(0);
});

it('leaves a disabled caller READ configuration alone instead of returning a zero-pool override', () => {
  const legacy = { ...dbPoolConfig({ WORKER_ROLE: 'web' }), readMax: 6 };
  const result = resolveHostDbPoolConfig(legacy);
  expect(result.config).toBe(legacy);
  expect(result.config.readMax).toBe(6);
  expect(result.readMax).toBeUndefined();
});

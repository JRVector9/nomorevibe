import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { hostDbBudgetCatalog, type HostDbBudget } from '@/lib/db/host-budget';
import { assertHostBudgetEntrySupported, hostBudgetEnforcement, hostBudgetShape, hostPressureDecision, hostProcessDecision,
  hostProcessIdentity, hostTranslationCap, readHostLedger, type HostLedgerRow, type HostProcessRow } from '@/lib/operations/host-budget';
import { startHostBudget } from '@/lib/operations/host-budget-runtime';
import { runWorker } from '@/scripts/worker';

const pressure = { maxLoadPerCpu: 4, maxHostRssBytes: 8_000, maxEventLoopDelayMs: 500, maxHeartbeatGapMs: 20_000 };
const policy: HostDbBudget = { version: 1, host: 'oracle-osaka-smoke', release: 'r1', roles: ['translation', 'text'],
  schedulerReplicas: 1, webReplicas: 0, webReadReplica: false, monitor: false, connectAgent: false,
  preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 1 };
const shape = hostBudgetShape(policy, pressure);
const prefix = 'host-slot:oracle-osaka-smoke';
function processRow(identity: string, overrides: Partial<HostProcessRow> = {}): HostLedgerRow {
  return { key: `${prefix}:p:${identity}`, type: 'process', bootId: randomUUID(), shape, identity, pid: 1, release: 'r1', primaryMax: 3, readMax: 0,
    leaseUntilMs: 2_000, renewedAtMs: 1_000, rssBytes: 1_000, eventLoopDelayMs: 0, heartbeatGapMs: 0, loadPerCpu: 0, ...overrides } as HostLedgerRow;
}
const enabled = JSON.stringify({ mode: 'enabled', pressure });

it('keeps enforcement disabled by default and rejects partial or unknown limits without defaults', () => {
  expect(hostBudgetEnforcement({})).toEqual({ mode: 'disabled' });
  expect(hostBudgetEnforcement({ HOST_BUDGET_ENFORCEMENT: '{"mode":"disabled"}' })).toEqual({ mode: 'disabled' });
  expect(hostBudgetEnforcement({ HOST_BUDGET_ENFORCEMENT: enabled })).toEqual({ mode: 'enabled', pressure });
  const { maxHeartbeatGapMs: _omitted, ...partial } = pressure;
  for (const raw of ['', 'null', '{"mode":"enabled"}', JSON.stringify({ mode: 'enabled', pressure: partial }),
    JSON.stringify({ mode: 'enabled', pressure: { ...pressure, extra: 1 } }), JSON.stringify({ mode: 'enabled', pressure: { ...pressure, maxHostRssBytes: 0 } }),
    JSON.stringify({ mode: 'enabled', pressure, pad: 'x'.repeat(5_000) })]) {
    expect(() => hostBudgetEnforcement({ HOST_BUDGET_ENFORCEMENT: raw }), raw.slice(0, 40)).toThrow('host_budget_invalid');
  }
  expect(_omitted).toBe(20_000);
  expect(() => assertHostBudgetEntrySupported({})).not.toThrow();
  expect(() => assertHostBudgetEntrySupported({ HOST_BUDGET_ENFORCEMENT: enabled })).toThrow('host_budget_entry_unsupported');
});

it('counts the declared Oracle translation call budget only for the three translation jobs', () => {
  for (const job of ['reason-translate', 'product-tagline-ko', 'product-translate']) {
    expect(hostTranslationCap('oracle-osaka-smoke', job)).toBe(1);
    expect(hostTranslationCap('m3', job)).toBeNull();
  }
  expect(hostTranslationCap('oracle-osaka-smoke', 'crawl-tagline')).toBeNull();
  expect(hostTranslationCap('oracle-osaka-smoke', 'news-refresh')).toBeNull();
});

it('binds the host shape to roster and limits but not to the rolling release or role order', () => {
  expect(hostBudgetShape({ ...policy, release: 'r2', roles: ['text', 'translation'] }, pressure)).toBe(shape);
  expect(hostBudgetShape({ ...policy, rolloutCopies: 2 }, pressure)).not.toBe(shape);
  expect(hostBudgetShape(policy, { ...pressure, maxEventLoopDelayMs: 501 })).not.toBe(shape);
  expect(hostBudgetShape({ ...policy, host: 'm3' }, pressure)).not.toBe(shape);
  expect(hostProcessIdentity({ kind: 'worker', role: 'reviewer', replica: 1, copy: 2 })).toBe('worker:reviewer:legacy:1:2');
  expect(hostProcessIdentity({ kind: 'worker', role: 'reviewer', consumer: 'ai2', replica: 1, copy: 1 })).toBe('worker:reviewer:ai2:1:1');
  expect(hostProcessIdentity({ kind: 'role-parent', role: 'text', replica: 1, copy: 1 })).toBe('role-parent:text:-:1:1');
});

it('expires rows only by the database clock and fails closed on malformed or misplaced rows', () => {
  const live = processRow('worker:text:-:1:1', { leaseUntilMs: 1_001 });
  const expired = processRow('worker:translation:-:1:1', { leaseUntilMs: 1_000 });
  const entries = [live, expired].map(({ key, ...value }) => ({ key, value }));
  expect(readHostLedger('oracle-osaka-smoke', entries, 1_000)).toEqual({ ok: true, live: [live], expired: [expired.key] });
  const translation = { type: 'translation', bootId: randomUUID(), shape, token: randomUUID(), job: 'product-translate', owner: 'x', holdMs: 1, leaseUntilMs: 5 };
  expect(readHostLedger('oracle-osaka-smoke', [{ key: `${prefix}:t:1`, value: translation }], 0)).toMatchObject({ ok: true });
  for (const row of [{ key: `${prefix}:t:0`, value: translation }, { key: `${prefix}:t:x`, value: translation },
    { key: `${prefix}:p:other`, value: entries[0].value }, { key: entries[0].key, value: { ...entries[0].value, primaryMax: -1 } },
    { key: `${prefix}:junk`, value: { type: 'other' } }, { key: 'host-slot:m3:t:1', value: translation }]) {
    expect(readHostLedger('oracle-osaka-smoke', [row], 0), row.key).toEqual({ ok: false });
  }
});

it('admits only unique declared identities of one shape within the declared host client total', () => {
  const catalog = hostDbBudgetCatalog(policy);
  const self = { key: `${prefix}:p:worker:text:-:1:1`, bootId: randomUUID(), shape, primaryMax: 3, readMax: 0 };
  const others = [processRow('worker:translation:-:1:1'), processRow('role-parent:text:-:1:1', { primaryMax: 1 })];
  expect(hostProcessDecision(others, self, policy)).toBeNull();
  expect(hostProcessDecision([...others, processRow('worker:text:-:1:1', { bootId: self.bootId })], self, policy)).toBeNull();
  expect(hostProcessDecision([...others, processRow('worker:text:-:1:1')], self, policy)).toBe('host_process_duplicate');
  expect(hostProcessDecision([processRow('worker:translation:-:1:1', { shape: 'f'.repeat(64) })], self, policy)).toBe('host_policy_mismatch');
  const full = processRow('worker:translation:-:1:1', { primaryMax: catalog.primaryClients - self.primaryMax + 1 });
  expect(hostProcessDecision([full], self, policy)).toBe('host_db_clients_exhausted');
  expect(hostProcessDecision([processRow('worker:translation:-:1:1', { primaryMax: catalog.primaryClients - self.primaryMax })], self, policy)).toBeNull();
  expect(hostProcessDecision([processRow('worker:translation:-:1:1', { readMax: 1 })], self, policy)).toBe('host_db_clients_exhausted');
});

it('gates on any process heartbeat lag, event-loop delay, load, or summed RSS', () => {
  const at = (overrides: Partial<HostProcessRow>) => [processRow('worker:text:-:1:1', overrides) as HostProcessRow];
  expect(hostPressureDecision(at({}), 1_000, pressure)).toBeNull();
  expect(hostPressureDecision(at({ heartbeatGapMs: 20_001 }), 1_000, pressure)).toBe('host_pressure_heartbeat');
  expect(hostPressureDecision(at({ renewedAtMs: 1_000 }), 21_001, pressure)).toBe('host_pressure_heartbeat');
  expect(hostPressureDecision(at({ eventLoopDelayMs: 501 }), 1_000, pressure)).toBe('host_pressure_event_loop');
  expect(hostPressureDecision(at({ loadPerCpu: 4.01 }), 1_000, pressure)).toBe('host_pressure_cpu');
  const pair = [processRow('worker:text:-:1:1', { rssBytes: 4_000 }), processRow('worker:translation:-:1:1', { rssBytes: 4_001 })] as HostProcessRow[];
  expect(hostPressureDecision(pair, 1_000, pressure)).toBe('host_pressure_rss');
  expect(hostPressureDecision(pair.slice(0, 1), 1_000, pressure)).toBeNull();
});

it('starts nothing when disabled and rejects incomplete enabled bindings before any database use', async () => {
  const disabled = startHostBudget({});
  expect(disabled.enabled).toBe(false);
  expect(disabled.ready()).toBe(true);
  await expect(disabled.admit('product-translate')).resolves.toMatchObject({ admitted: true });
  const process = { kind: 'worker', role: 'translation', host: policy.host, release: policy.release, replica: 1, copy: 1 };
  const env = { HOST_BUDGET_ENFORCEMENT: enabled, HOST_DB_BUDGET: JSON.stringify({ mode: 'enabled', policy, process }),
    WORKER_ROLE: 'translation', PHYSICAL_HOST: policy.host, RELEASE_TAG: policy.release, SERVICE_INSTANCE_ID: 'oracle-translation', HTTP_ORIGIN_PERMITS: '1' };
  for (const invalid of [{ ...env, HOST_DB_BUDGET: undefined }, { ...env, HTTP_ORIGIN_PERMITS: '0' }, { ...env, SERVICE_INSTANCE_ID: undefined },
    { ...env, HOST_BUDGET_ENFORCEMENT: JSON.stringify({ mode: 'enabled', pressure: { ...pressure, maxHeartbeatGapMs: 10_000 } }) }]) {
    expect(() => startHostBudget(invalid)).toThrow('host_budget_invalid');
  }
  expect(() => startHostBudget(env, { holdMs: 0 })).toThrow('host_budget_invalid');
  expect(() => startHostBudget(env, { leaseMs: 1_000, renewMs: 1_000 })).toThrow('host_budget_invalid');
});

it('defers an over-budget job before its claim, releases an admitted slot after the run, and treats gate failure as deferral', async () => {
  const events: string[] = [];
  const logs: unknown[] = [];
  const result = await runWorker({ role: 'text', once: true }, {
    names: ['reason-translate', 'product-translate', 'product-tagline-ko'], seen: async () => {},
    pending: async () => ['reason-translate', 'product-translate', 'product-tagline-ko'],
    admit: async name => {
      events.push(`admit:${name}`);
      if (name === 'reason-translate') return { admitted: false, reason: 'host_translation_busy' };
      if (name === 'product-tagline-ko') throw new Error('gate_unavailable');
      return { admitted: true, release: async () => { events.push(`release:${name}`); } };
    },
    run: async name => { events.push(`run:${name}`); return { status: 'completed' }; },
    log: (event, fields) => { logs.push({ event, ...fields }); },
  });
  expect(events).toEqual(['admit:reason-translate', 'admit:product-translate', 'run:product-translate', 'release:product-translate', 'admit:product-tagline-ko']);
  expect(result).toEqual({ ticks: 1, failures: 0 });
  expect(logs).toEqual([
    { event: 'worker.job', role: 'text', name: 'reason-translate', status: 'deferred', reason: 'host_translation_busy' },
    { event: 'worker.job', role: 'text', name: 'product-translate', status: 'completed' },
    { event: 'worker.job', role: 'text', name: 'product-tagline-ko', status: 'deferred', reason: 'host_budget_unavailable' },
  ]);
});

it('releases the admitted slot even when the job run throws', async () => {
  const events: string[] = [];
  const result = await runWorker({ role: 'text', once: true }, {
    names: ['product-translate'], seen: async () => {}, pending: async () => ['product-translate'],
    admit: async () => ({ admitted: true, release: async () => { events.push('release'); } }),
    run: async () => { events.push('run'); throw new Error('job_failed'); },
  });
  expect(events).toEqual(['run', 'release']);
  expect(result).toEqual({ ticks: 1, failures: 1 });
});

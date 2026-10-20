import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { assertHostDbEntry, hostDbBudgetCatalog, hostDbChildEnvironment } from '@/lib/db/host-budget';
import { dbPoolConfig } from '@/lib/db/pool';
import { CONSUMERS, consumerSpec } from '@/lib/runtime/consumer-registry';
import { ORACLE_CONSUMER_DB_PROFILES } from '@/lib/runtime/oracle-db-profile';
import { ORACLE_CONSUMER_READINESS } from '@/lib/runtime/oracle-consumer-preflight';
import { consumerHealthPath, supervisorCommand } from '@/scripts/worker-supervisor';

/*
 * U2: uptime consumer 를 B0 등록부 네 자리(등록부·launch.py·DB 프로필·준비 확인)에 같은 이름·부모 역할로 올렸는지 본다.
 * host DB 장부·감독 명령·health 경로는 등록부에서 자동으로 따라온다. 실제 계정 권한은 tests/integration/uptime-consumer.test.ts.
 */
afterEach(() => vi.unstubAllEnvs());
const release = 'b'.repeat(40);
const policy = { version: 1 as const, host: 'oracle-osaka-smoke' as const, release, roles: [] as string[], schedulerReplicas: 0, webReplicas: 0,
  webReadReplica: false, monitor: false, connectAgent: false, preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 1 as const, consumers: ['uptime'] };
const budget = (kind: 'role-parent' | 'worker') => ({ WORKER_ROLE: 'maintenance', PHYSICAL_HOST: 'oracle-osaka-smoke', RELEASE_TAG: release,
  HOST_DB_BUDGET: JSON.stringify({ mode: 'enabled', policy, process: { kind, role: 'maintenance', consumer: 'uptime', host: 'oracle-osaka-smoke',
    release, replica: 1, copy: 1 } }) });

it('registers uptime under the maintenance parent with a fixed child and its own health file', () => {
  expect(consumerSpec('uptime')).toEqual({ role: 'maintenance', command: ['scripts/uptime-consumer.ts'], workerMax: 2 });
  expect(supervisorCommand('maintenance', { consumer: 'uptime' })).toEqual(['scripts/uptime-consumer.ts']);
  expect(supervisorCommand('maintenance', { consumer: 'uptime', once: true })).toEqual(['scripts/uptime-consumer.ts', '--once']);
  for (const role of ['product-health', 'reviewer'] as const) expect(() => supervisorCommand(role, { consumer: 'uptime' })).toThrow('invalid_item_consumer_role');
  expect(consumerHealthPath({ SERVICE_INSTANCE_ID: 'uptime-consumer-oracle' })).toBe('/tmp/nomorevibe-uptime-consumer-health.json');
  // 설계 예시 oracle-uptime-1 은 consumer 인스턴스가 아니다(역할 인스턴스로 보인다)
  expect(consumerHealthPath({ SERVICE_INSTANCE_ID: 'oracle-uptime-1' })).toBeNull();
});

it('declares the supervisor parent (1) and the consumer child (2) in the host DB budget', () => {
  expect(hostDbBudgetCatalog(policy)).toMatchObject({ totalClients: 3, processes: [
    { kind: 'role-parent', role: 'maintenance', count: 1, primaryMax: 1, readMax: 0, consumer: 'uptime' },
    { kind: 'worker', role: 'maintenance', count: 1, primaryMax: 2, readMax: 0, consumer: 'uptime' }] });
  const parent = budget('role-parent');
  expect(() => assertHostDbEntry(parent, { kind: 'role-parent', role: 'maintenance', consumer: 'uptime' })).not.toThrow();
  const child = hostDbChildEnvironment(parent, 'maintenance', 'uptime');
  expect(() => assertHostDbEntry(child, { kind: 'worker', role: 'maintenance', consumer: 'uptime' })).not.toThrow();
  expect(dbPoolConfig(child).max).toBe(2);
  expect(() => dbPoolConfig({ ...child, DB_POOL_MAX: '3' })).toThrow('host_db_pool_quota_exceeded');
  // maintenance 역할 워커는 uptime 자리를 빌리지 못하고, uptime 은 다른 부모로 선언할 수 없다
  expect(() => assertHostDbEntry(parent, { kind: 'role-parent', role: 'maintenance' })).toThrow('host_db_entry_mismatch');
  expect(() => assertHostDbEntry({ ...budget('worker'), WORKER_ROLE: 'product-health',
    HOST_DB_BUDGET: budget('worker').HOST_DB_BUDGET.replace('"role":"maintenance"', '"role":"product-health"') },
  { kind: 'worker', role: 'product-health', consumer: 'uptime' })).toThrow();
});

it('lists every Oracle consumer under the same parent role in launch.py, the registry, the DB profile and the readiness hook', () => {
  const source = readFileSync('deploy/oracle/launch.py', 'utf8');
  const block = /^CONSUMERS = \{([^}]*)\}$/m.exec(source)?.[1] ?? null;
  expect(block).not.toBeNull();
  const launch = Object.fromEntries([...block!.matchAll(/'([a-z-]+)': '([a-z-]+)'/g)].map(match => [match[1], match[2]]));
  expect(launch.uptime).toBe('maintenance');
  const oracle = Object.keys(ORACLE_CONSUMER_DB_PROFILES).sort();
  expect(Object.keys(launch).sort()).toEqual(oracle);
  expect(Object.keys(ORACLE_CONSUMER_READINESS).sort()).toEqual(oracle);
  for (const name of oracle) expect(launch[name], name).toBe(consumerSpec(name)?.role);
  expect(Object.keys(CONSUMERS)).toContain('uptime');
});

it('gives the uptime principal claim/submit columns and reads only — no authoritative health, daily, raw or due writes', () => {
  const profile = ORACLE_CONSUMER_DB_PROFILES.uptime!;
  expect(profile.principal).toBe('nomorevibe_oracle_uptime');
  expect(profile.profile.statementTimeout).toBe('10s');
  const { tables } = profile.profile;
  expect(Object.keys(tables).sort()).toEqual(['dr_writer_fence', 'operations_observations', 'product_health', 'products', 'uptime_claims',
    'uptime_host_breakers', 'uptime_split_control']);
  for (const table of ['product_health', 'uptime_host_breakers']) expect(tables[table], table).toEqual({ select: true });
  // products 는 claim 이 읽는 열만 — verify_token·edit_token_hash 같은 비밀 열은 읽지 못한다(review F11)
  expect(tables.products).toEqual({ select: ['id', 'slug', 'url', 'status', 'access_mode'] });
  for (const table of ['dr_writer_fence', 'uptime_split_control']) expect(tables[table], table).toEqual({ select: true, update: ['id'] });
  const claims = tables.uptime_claims;
  expect(claims.insert).toBeUndefined(); expect(claims.delete).toBeUndefined();
  // 판정 열(due·재확인·지역 고정·충돌·적용 기록)은 home 적용기만 쓴다
  for (const column of ['product_id', 'due_at', 'confirm_class', 'confirm_reason', 'confirm_requested_at', 'affinity_home_until', 'conflict_count',
    'last_applied_at', 'last_applied_host', 'last_outcome']) expect(claims.update, column).not.toContain(column);
  expect(profile.profile.sequences).toEqual([]);
});

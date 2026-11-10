import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertHostDbEntry, hostDbBudgetCatalog, hostDbChildEnvironment } from '@/lib/db/host-budget';
import { dbPoolConfig } from '@/lib/db/pool';
import { SUPERVISOR_PRINCIPAL } from '@/lib/llm/capacity-helpers';
import { capacitySupervisorOracleReadiness } from '@/lib/operations/capacity-supervisor/repository';
import { consumerSpec } from '@/lib/runtime/consumer-registry';
import { ORACLE_CONSUMER_READINESS, type OracleConsumerTx } from '@/lib/runtime/oracle-consumer-preflight';
import { ORACLE_CONSUMER_DB_PROFILES, ORACLE_CONSUMER_FORBIDDEN_TABLES, oracleConsumerGrantStatements, renderOracleDbGrantSql } from '@/lib/runtime/oracle-db-profile';
import { parseCapacitySupervisorArgs, runCapacitySupervisorProcess } from '@/scripts/capacity-supervisor-consumer';
import { consumerHealthPath, supervisorCommand } from '@/scripts/worker-supervisor';

// pr2-plan §3.1–3.2: 감시자 consumer 를 다섯 자리(등록부·launch.py·DB 프로필·준비 확인·host 장부)에 같은 이름·부모 역할로 올렸고, 계정은 계획의
// 정확한 GRANT 만 가진다. 실제 계정으로 도는 SQL 은 tests/integration/capacity-supervisor.test.ts.
afterEach(() => vi.unstubAllEnvs());
const release = 'c'.repeat(40);
const policy = { version: 1 as const, host: 'oracle-osaka-smoke' as const, release, roles: [] as string[], schedulerReplicas: 0, webReplicas: 0,
  webReadReplica: false, monitor: false, connectAgent: false, preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 1 as const,
  consumers: ['capacity-supervisor'] };
const budget = (kind: 'role-parent' | 'worker') => ({ WORKER_ROLE: 'maintenance', PHYSICAL_HOST: 'oracle-osaka-smoke', RELEASE_TAG: release,
  SERVICE_INSTANCE_ID: 'capacity-supervisor-consumer-oracle',
  HOST_DB_BUDGET: JSON.stringify({ mode: 'enabled', policy, process: { kind, role: 'maintenance', consumer: 'capacity-supervisor', host: 'oracle-osaka-smoke',
    release, replica: 1, copy: 1 } }) });
const profile = ORACLE_CONSUMER_DB_PROFILES['capacity-supervisor']!;

describe('registration', () => {
  it('runs the fixed child under the maintenance parent with a pool of one and its own health file', () => {
    expect(consumerSpec('capacity-supervisor')).toEqual({ role: 'maintenance', command: ['scripts/capacity-supervisor-consumer.ts'], workerMax: 1 });
    expect(supervisorCommand('maintenance', { consumer: 'capacity-supervisor' })).toEqual(['scripts/capacity-supervisor-consumer.ts']);
    expect(supervisorCommand('maintenance', { consumer: 'capacity-supervisor', once: true })).toEqual(['scripts/capacity-supervisor-consumer.ts', '--once']);
    for (const role of ['reviewer', 'crawler'] as const) expect(() => supervisorCommand(role, { consumer: 'capacity-supervisor' })).toThrow('invalid_item_consumer_role');
    expect(consumerHealthPath({ SERVICE_INSTANCE_ID: 'capacity-supervisor-consumer-oracle' })).toBe('/tmp/nomorevibe-capacity-supervisor-consumer-health.json');
  });
  it('declares parent (1) and child (1) in the host DB budget and refuses other slots', () => {
    expect(hostDbBudgetCatalog(policy)).toMatchObject({ totalClients: 2, processes: [
      { kind: 'role-parent', role: 'maintenance', count: 1, primaryMax: 1, readMax: 0, consumer: 'capacity-supervisor' },
      { kind: 'worker', role: 'maintenance', count: 1, primaryMax: 1, readMax: 0, consumer: 'capacity-supervisor' }] });
    const parent = budget('role-parent');
    expect(() => assertHostDbEntry(parent, { kind: 'role-parent', role: 'maintenance', consumer: 'capacity-supervisor' })).not.toThrow();
    const child = hostDbChildEnvironment(parent, 'maintenance', 'capacity-supervisor');
    expect(dbPoolConfig(child).max).toBe(1);
    expect(() => dbPoolConfig({ ...child, DB_POOL_MAX: '2' })).toThrow('host_db_pool_quota_exceeded');
    expect(() => assertHostDbEntry(parent, { kind: 'role-parent', role: 'maintenance' })).toThrow('host_db_entry_mismatch');
  });
  it('lists the same name and parent role in launch.py, the DB profiles and the readiness hooks', () => {
    const block = /^CONSUMERS = \{([^}]*)\}$/m.exec(readFileSync('deploy/oracle/launch.py', 'utf8'))?.[1] ?? '';
    const launch = Object.fromEntries([...block.matchAll(/'([a-z-]+)': '([a-z-]+)'/g)].map(match => [match[1], match[2]]));
    expect(launch['capacity-supervisor']).toBe('maintenance');
    expect(ORACLE_CONSUMER_READINESS['capacity-supervisor']).toBe(capacitySupervisorOracleReadiness);
    expect(profile.principal).toBe(SUPERVISOR_PRINCIPAL);
  });
});

describe('least-privilege profile (pr2-plan §3.2)', () => {
  it('grants exactly the plan tables and columns', () => {
    expect(profile.profile.statementTimeout).toBe('10s');
    expect(profile.profile.sequences).toEqual(['model_helper_stops_id_seq']);
    expect(profile.profile.tables).toEqual({
      dr_writer_fence: { select: true, update: ['id'] },
      model_supervisor_control: { select: true, update: ['owner_instance_id', 'owner_boot_id', 'epoch', 'lease_until', 'heartbeat_at', 'loop_seq', 'release'] },
      model_helper_assignments: { select: true },
      model_helper_signals: { select: true, insert: true, update: ['assignment_version', 'supervisor_epoch', 'verdict', 'reason', 'streak', 'state_since',
        'last_exit_at', 'metrics', 'observed_at', 'valid_until', 'written_by'] },
      model_device_signals: { select: true, insert: true, update: ['supervisor_epoch', 'primary_demand', 'backlog', 'metrics', 'observed_at', 'valid_until', 'written_by'] },
      model_helper_stops: { select: true, insert: true },
      model_role_demand: { select: true },
      model_helper_shadow_runs: { select: ['id', 'assignment_id', 'evidence_key', 'stage', 'state', 'primary_decision', 'helper_decision', 'agreement',
        'error_code', 'latency_ms', 'created_at', 'completed_at'] },
      model_helper_live_outputs: { select: ['id', 'assignment_id', 'assignment_version', 'evidence_key', 'stage', 'helper_decision', 'downstream',
        'created_at', 'downstream_at'] },
      model_capacity_control: { select: ['id', 'mode', 'epoch', 'revision', 'policy', 'policy_hash', 'updated_at'] },
      model_capacity_requests: { select: ['request_id', 'state', 'class', 'pool', 'route_id', 'provider', 'model', 'group_id', 'epoch', 'revision',
        'policy_hash', 'queued_at', 'queue_until', 'reserved_until', 'dispatched_at', 'settled_at', 'updated_at'] },
      model_capacity_devices: { select: true }, model_capacity_device_roles: { select: true }, runtime_settings: { select: true },
      operations_observations: { select: true, insert: true, update: ['value', 'observed_at'] },
    });
  });
  it('holds no domain, runtime-write, admin-switch, ledger-write or secret authority', () => {
    const tables = profile.profile.tables;
    for (const table of [...ORACLE_CONSUMER_FORBIDDEN_TABLES, 'crawl_settings', 'crawl_candidates', 'crawl_review_attempts', 'second_reviews', 'products',
      'model_serving_contracts', 'model_capacity_events', 'operations_audit']) expect(tables[table], table).toBeUndefined();
    // 2026-11-10: 결과 미확정 유지 시간을 입장과 같은 값으로 세려고 runtime_settings 는 읽기만 — 쓰기·삭제는 없다
    expect(tables.runtime_settings).toEqual({ select: true });
    expect(tables.model_supervisor_control.update).not.toEqual(expect.arrayContaining(['enabled']));
    for (const column of ['enabled', 'signal_principal', 'signal_ttl_ms', 'loop_ms', 'updated_by', 'updated_at'])
      expect(tables.model_supervisor_control.update, column).not.toContain(column);
    for (const column of ['dispatch_binding', 'terminal_evidence', 'owner_instance_id', 'work_key', 'logical_work_key'])
      expect(tables.model_capacity_requests.select, column).not.toContain(column);
    for (const column of ['helper_outcome', 'job_token', 'input_hash', 'candidate_id']) expect(tables.model_helper_shadow_runs.select, column).not.toContain(column);
    for (const table of ['model_helper_assignments', 'model_role_demand', 'model_capacity_devices', 'model_capacity_device_roles', 'model_capacity_requests',
      'model_capacity_control', 'model_helper_shadow_runs', 'model_helper_live_outputs']) {
      expect(tables[table].insert, table).toBeUndefined(); expect(tables[table].update, table).toBeUndefined();
    }
    expect(Object.values(tables).some(grant => grant.delete)).toBe(false);
    expect(tables.model_helper_stops.update).toBeUndefined();
  });
  it('renders the consumer section into the checked-in operator SQL', () => {
    const rendered = renderOracleDbGrantSql();
    const section = ['', '-- consumer capacity-supervisor', ...oracleConsumerGrantStatements(profile, { connectionLimit: ':capacity_supervisor_connections' })
      .map(statement => `${statement};`)].join('\n');
    expect(rendered).toContain(section);
    expect(readFileSync('deploy/oracle/least-privilege.sql', 'utf8')).toBe(rendered);
    // 운영자 문서의 계정 만들기 SQL 도 같은 문장이다
    expect(readFileSync('docs/operations/capacity-supervisor.md', 'utf8')).toContain(section.split('\n').slice(2).join('\n'));
  });
});

describe('preflight readiness', () => {
  const tx = (rows: unknown[]) => ({ execute: vi.fn(async () => rows) }) as unknown as OracleConsumerTx;
  const context = { consumer: 'capacity-supervisor', instanceId: 'capacity-supervisor-consumer-oracle', principal: SUPERVISOR_PRINCIPAL };
  it('is verified with the control row naming this principal, even while disabled', async () => {
    await expect(capacitySupervisorOracleReadiness(tx([{ signal_principal: SUPERVISOR_PRINCIPAL, enabled: false }]), context))
      .resolves.toEqual({ status: 'verified', reason: 'supervisor_ready_disabled' });
    await expect(capacitySupervisorOracleReadiness(tx([{ signal_principal: SUPERVISOR_PRINCIPAL, enabled: true }]), context))
      .resolves.toEqual({ status: 'verified', reason: 'supervisor_ready' });
  });
  it('is unknown without the control row and rejected for another principal', async () => {
    await expect(capacitySupervisorOracleReadiness(tx([]), context)).resolves.toEqual({ status: 'unknown', reason: 'supervisor_control_missing' });
    await expect(capacitySupervisorOracleReadiness(tx([{ signal_principal: 'someone_else', enabled: true }]), context))
      .resolves.toEqual({ status: 'rejected', reason: 'supervisor_principal_mismatch' });
    await expect(capacitySupervisorOracleReadiness(tx([{ signal_principal: 'nomorevibe', enabled: true }]), { ...context, principal: 'nomorevibe' }))
      .resolves.toEqual({ status: 'rejected', reason: 'supervisor_principal_mismatch' });
  });
});

describe('entry script', () => {
  it('stays off without CAPACITY_SUPERVISOR_VERSION and refuses bad versions, args and slots before any DB work', async () => {
    await expect(runCapacitySupervisorProcess([], {})).resolves.toEqual({ state: 'disabled' });
    await expect(runCapacitySupervisorProcess([], { CAPACITY_SUPERVISOR_VERSION: '2' })).rejects.toThrow('invalid_capacity_supervisor_version');
    expect(() => parseCapacitySupervisorArgs(['--once', '--once'])).toThrow('Usage');
    expect(() => parseCapacitySupervisorArgs(['--role=maintenance'])).toThrow('Usage');
    expect(parseCapacitySupervisorArgs(['--once'])).toEqual({ once: true });
    const env = { ...budget('worker'), CAPACITY_SUPERVISOR_VERSION: '1' };
    await expect(runCapacitySupervisorProcess([], { ...env, HOST_DB_BUDGET: env.HOST_DB_BUDGET.replace('"capacity-supervisor","host"', '"uptime","host"') }))
      .rejects.toThrow(/host_db_/);
    await expect(runCapacitySupervisorProcess([], { ...env, SERVICE_INSTANCE_ID: 'uptime-consumer-oracle' })).rejects.toThrow('invalid_item_consumer_service_instance');
    await expect(runCapacitySupervisorProcess([], { ...env, HOST_BUDGET_ENFORCEMENT: JSON.stringify({ mode: 'enabled' }) }))
      .rejects.toThrow(/host_budget_(invalid|entry_unsupported)/);
  });
});

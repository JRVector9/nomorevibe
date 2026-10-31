import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DEFAULT_SIGNAL_TTL_MS, DEFAULT_SUPERVISOR_LOOP_MS, HELPER_REASONS, HELPER_ROUTE_DEFAULTS, SUPERVISOR_PRINCIPAL,
  deviceSignalUsable, helperActor, helperAssignmentSchema, helperCandidateExclusionSql, helperDemandOnSql, helperEvidenceKey, helperGateCte,
  helperGateOk, helperGateStateFromRow, helperGateStatesSql, helperSignalStaleness, helperSignalUsable, helperStopBlocks, parseHelperAssignment,
  roleDemandFresh, supervisorControlPatchSchema, supervisorControlTimingValid, type HelperFreshnessInput } from '@/lib/llm/capacity-helpers';
import { listHelperAssignments, readHelperGateStates, readHelperStatusSnapshot, saveHelperAssignment, setHelperMode, setSupervisorControl }
  from '@/lib/llm/capacity-helpers-repository';
import type { ProductTransaction } from '@/lib/domain/products/generation';

const render = (query: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(query);
const minimal = { assignmentId: 'm3-deepseek:ai1', stage: 'ai1', deviceId: 'm3-deepseek', model: 'DeepSeek', ...HELPER_ROUTE_DEFAULTS.ai1 } as const;

describe('helper assignment schema', () => {
  it('defaults every switch to off and the thresholds to the plan defaults', () => {
    expect(parseHelperAssignment(minimal)).toEqual({ ...minimal, mode: 'off', maxSlots: 1, perTick: 2, shadowPerHour: 30, minShadowSamples: 200,
      minAgreement: 0.95, maxWrongApproval: 0.01, maxWrongRejection: 0.02, maxUnknownRate: 0.02, maxFailureRate: 0.1, maxLiveDisagreement: 0.1,
      enterSamples: 2, exitSamples: 4, minHelpMs: 120_000, reenterCooldownMs: 60_000, note: null });
    expect(Object.isFrozen(parseHelperAssignment(minimal))).toBe(true);
  });

  it('refuses what the table CHECKs refuse, naming the field', () => {
    const refuse = (input: unknown, path: string) => expect(() => parseHelperAssignment(input)).toThrow(`model_helper_invalid:${path}`);
    refuse({ ...minimal, assignmentId: 'M3:ai1' }, 'assignmentId');
    refuse({ ...minimal, stage: 'ai3' }, 'stage');
    refuse({ ...minimal, mode: 'on' }, 'mode');
    refuse({ ...minimal, maxSlots: 0 }, 'maxSlots');
    refuse({ ...minimal, perTick: 17 }, 'perTick');
    refuse({ ...minimal, minShadowSamples: 19 }, 'minShadowSamples');
    refuse({ ...minimal, minAgreement: 0.49 }, 'minAgreement');
    refuse({ ...minimal, maxWrongApproval: 0.0105 }, 'maxWrongApproval');   // numeric(4,3)
    refuse({ ...minimal, maxFailureRate: 0.91 }, 'maxFailureRate');
    refuse({ ...minimal, model: ' DeepSeek' }, 'model');
    refuse({ ...minimal, shadowRouteId: minimal.liveRouteId }, 'shadowRouteId');
    refuse({ ...minimal, evidenceKey: 'a'.repeat(64) }, 'root');             // strict: the save computes it
    expect(helperAssignmentSchema.safeParse({ ...minimal, mode: 'live', minAgreement: 0.975 }).success).toBe(true);
  });

  it('keeps supervisor control timing inside the table CHECK', () => {
    expect(supervisorControlPatchSchema.parse({})).toEqual({});
    expect(supervisorControlPatchSchema.safeParse({ signalTtlMs: 14_999 }).success).toBe(false);
    expect(supervisorControlPatchSchema.safeParse({ loopMs: 60_001 }).success).toBe(false);
    expect(supervisorControlPatchSchema.safeParse({ epoch: 3 }).success).toBe(false);          // lease columns are the supervisor's
    expect(supervisorControlTimingValid({ signalTtlMs: DEFAULT_SIGNAL_TTL_MS, loopMs: DEFAULT_SUPERVISOR_LOOP_MS })).toBe(true);
    expect(supervisorControlTimingValid({ signalTtlMs: 20_000, loopMs: 15_000 })).toBe(false);  // loop × 2 ≤ ttl
  });

  it('lists the reasons the admin labels', () => {
    expect(HELPER_REASONS).toEqual(['primary_full', 'primary_not_full', 'helper_own_work', 'stale_inputs', 'auto_stopped', 'unknown_rate',
      'failure_rate', 'quality_regression', 'mode_off', 'supervisor_off']);
    for (const reason of HELPER_REASONS) expect(reason).toMatch(/^[a-z_]{1,40}$/);
  });
});

describe('signal freshness (§1.3)', () => {
  const now = Date.parse('2026-10-31T00:00:00.000Z');
  const at = (ms: number) => new Date(now + ms).toISOString();
  const fresh: HelperFreshnessInput = {
    nowMs: now,
    control: { enabled: true, epoch: 7, signalPrincipal: SUPERVISOR_PRINCIPAL, leaseUntil: at(30_000) },
    assignment: { assignmentId: 'm3-deepseek:ai1', version: 3, mode: 'live' },
    signal: { assignmentId: 'm3-deepseek:ai1', assignmentVersion: 3, supervisorEpoch: 7, writtenBy: SUPERVISOR_PRINCIPAL, validUntil: at(10_000), verdict: 'help' },
  };
  const gate = (input: HelperFreshnessInput, kind: 'live' | 'shadow', stops: { assignmentId: string; assignmentVersion: number; effect: 'stop' | 'demote_to_shadow' }[] = []) =>
    helperGateOk({ ...input, kind, stops });

  it('opens only for a fresh signal of the current epoch, principal and version', () => {
    expect(helperSignalStaleness(fresh)).toBeNull();
    expect(helperSignalUsable(fresh)).toBe(true);
    expect(gate(fresh, 'live')).toBe(true);
    expect(gate(fresh, 'shadow')).toBe(true);
  });

  it('closes on every stale or foreign input', () => {
    const cases: [HelperFreshnessInput, string][] = [
      [{ ...fresh, control: null }, 'supervisor_missing'],
      [{ ...fresh, control: { ...fresh.control!, enabled: false } }, 'supervisor_disabled'],
      [{ ...fresh, control: { ...fresh.control!, leaseUntil: at(0) } }, 'lease_expired'],
      [{ ...fresh, control: { ...fresh.control!, leaseUntil: null } }, 'lease_expired'],
      [{ ...fresh, assignment: null }, 'assignment_missing'],
      [{ ...fresh, signal: null }, 'signal_missing'],
      [{ ...fresh, signal: { ...fresh.signal!, assignmentId: 'other:ai1' } }, 'signal_missing'],
      [{ ...fresh, signal: { ...fresh.signal!, supervisorEpoch: 6 } }, 'epoch_mismatch'],
      [{ ...fresh, signal: { ...fresh.signal!, writtenBy: 'nomorevibe' } }, 'principal_mismatch'],
      [{ ...fresh, signal: { ...fresh.signal!, assignmentVersion: 2 } }, 'version_mismatch'],
      [{ ...fresh, signal: { ...fresh.signal!, validUntil: at(0) } }, 'signal_expired'],
      [{ ...fresh, signal: { ...fresh.signal!, validUntil: 'not-a-time' } }, 'signal_expired'],
    ];
    for (const [input, reason] of cases) {
      expect(helperSignalStaleness(input), reason).toBe(reason);
      expect(gate(input, 'live'), reason).toBe(false);
      expect(gate(input, 'shadow'), reason).toBe(false);
    }
  });

  it('applies stops, mode and verdict per route kind', () => {
    const stop = { assignmentId: 'm3-deepseek:ai1', assignmentVersion: 3 };
    expect(helperStopBlocks('stop', 'shadow')).toBe(true);
    expect(helperStopBlocks('demote_to_shadow', 'shadow')).toBe(false);
    expect(gate(fresh, 'live', [{ ...stop, effect: 'stop' }])).toBe(false);
    expect(gate(fresh, 'shadow', [{ ...stop, effect: 'stop' }])).toBe(false);
    expect(gate(fresh, 'live', [{ ...stop, effect: 'demote_to_shadow' }])).toBe(false);
    expect(gate(fresh, 'shadow', [{ ...stop, effect: 'demote_to_shadow' }])).toBe(true);
    expect(gate(fresh, 'live', [{ ...stop, assignmentVersion: 2, effect: 'stop' }])).toBe(true);   // an old version's stop no longer applies
    const shadowOnly = { ...fresh, signal: { ...fresh.signal!, verdict: 'shadow_only' as const } };
    expect(gate(shadowOnly, 'live')).toBe(false);
    expect(gate(shadowOnly, 'shadow')).toBe(true);
    expect(gate({ ...fresh, signal: { ...fresh.signal!, verdict: 'hold' } }, 'shadow')).toBe(false);
    const shadowMode = { ...fresh, assignment: { ...fresh.assignment!, mode: 'shadow' as const } };
    expect(gate(shadowMode, 'live')).toBe(false);
    expect(gate(shadowMode, 'shadow')).toBe(true);
    expect(gate({ ...fresh, assignment: { ...fresh.assignment!, mode: 'off' } }, 'shadow')).toBe(false);
  });

  it('ignores a stale lending restriction and treats a stale beacon as busy', () => {
    const signal = { supervisorEpoch: 7, writtenBy: SUPERVISOR_PRINCIPAL, validUntil: at(10_000) };
    expect(deviceSignalUsable({ nowMs: now, control: fresh.control, signal })).toBe(true);
    expect(deviceSignalUsable({ nowMs: now, control: fresh.control, signal: { ...signal, validUntil: at(-1) } })).toBe(false);
    expect(deviceSignalUsable({ nowMs: now, control: fresh.control, signal: { ...signal, supervisorEpoch: 8 } })).toBe(false);
    expect(deviceSignalUsable({ nowMs: now, control: fresh.control, signal: { ...signal, writtenBy: 'nomorevibe' } })).toBe(false);
    expect(deviceSignalUsable({ nowMs: now, control: { ...fresh.control!, enabled: false }, signal })).toBe(false);
    expect(deviceSignalUsable({ nowMs: now, control: fresh.control, signal: null })).toBe(false);
    expect(roleDemandFresh({ nowMs: now, beacon: { validUntil: at(1) } })).toBe(true);
    expect(roleDemandFresh({ nowMs: now, beacon: { validUntil: at(0) } })).toBe(false);
    expect(roleDemandFresh({ nowMs: now, beacon: null })).toBe(false);
  });
});

describe('evidence key and actor', () => {
  const parts = { stage: 'ai1', model: 'DeepSeek', promptVersion: 'p9', rulesVersion: 'r4', wireVariant: 'json_schema', contractHash: 'c'.repeat(64) } as const;
  it('is a deterministic sha256 that changes with every part', () => {
    const key = helperEvidenceKey(parts);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(helperEvidenceKey({ ...parts })).toBe(key);
    for (const changed of [{ stage: 'ai2' }, { model: 'Qwen' }, { promptVersion: 'p10' }, { rulesVersion: 'r5' }, { wireVariant: 'no_response_format' },
      { contractHash: 'd'.repeat(64) }] as const) expect(helperEvidenceKey({ ...parts, ...changed })).not.toBe(key);
    expect(() => helperEvidenceKey({ ...parts, model: '' })).toThrow('model_helper_invalid:evidence');
    expect(helperActor('m3-deepseek:ai1', key)).toBe(`helper:m3-deepseek:ai1:${key.slice(0, 8)}`);
  });
});

describe('helper gate SQL (§2.1)', () => {
  it('renders the four CTEs with every fail-closed predicate', () => {
    const { sql: text, params } = render(sql`WITH ${helperGateCte('m3-deepseek')} SELECT 1`);
    for (const name of ['sup AS MATERIALIZED', 'helper_gate AS MATERIALIZED', 'helper_active AS MATERIALIZED', 'demand AS MATERIALIZED']) expect(text).toContain(name);
    expect(text).not.toMatch(/^\s*WITH\s+WITH/);
    for (const fragment of ['coalesce(sup.enabled AND sup.live', 'hs.supervisor_epoch = sup.epoch', 'hs.written_by = sup.signal_principal',
      'hs.assignment_version = ha.version', 'hs.valid_until > clock_timestamp()', "(st.effect = 'stop' OR g.kind = 'live')",
      "WHEN 'live' THEN ha.mode = 'live' AND hs.verdict = 'help'", "ELSE ha.mode IN ('shadow','live') AND hs.verdict IN ('help','shadow_only') END, false) AS ok",
      "('shadow'::text, ha.shadow_route_id, 'local-direct'::text, ha.model)", "r.state IN ('reserved','dispatched')",
      'ds.supervisor_epoch = sup.epoch AND ds.written_by = sup.signal_principal', 'ds.valid_until > clock_timestamp()) AS on_',
      'c.lease_until > clock_timestamp() AS live']) expect(text).toContain(fragment);
    expect(text).not.toContain('indeterminate');
    expect(params).toEqual(['m3-deepseek', 'm3-deepseek', 'm3-deepseek']);
  });

  it('takes an outer column reference for LATERAL use', () => {
    const { sql: text, params } = render(sql`WITH ${helperGateCte(sql`d.device_id`)} SELECT 1`);
    expect(text).toContain('WHERE ha.device_id = d.device_id');
    expect(params).toEqual([]);
  });

  it('renders the candidate exclusion, the demand OR and the state select', () => {
    const exclusion = render(sql`${helperCandidateExclusionSql()}`).sql;
    expect(exclusion).toContain('NOT EXISTS (SELECT 1 FROM helper_gate g');
    expect(exclusion).toContain('g.route_id = q.route_id AND g.provider = q.provider AND g.model = q.model');
    expect(exclusion).toContain('coalesce((SELECT a.n FROM helper_active a WHERE a.assignment_id = g.assignment_id), 0) >= g.max_slots');
    expect(render(sql`${helperCandidateExclusionSql('r2')}`).sql).toContain('= r2.route_id');
    expect(() => helperCandidateExclusionSql('q; DROP')).toThrow('model_helper_invalid:alias');
    expect(render(sql`${helperDemandOnSql()}`).sql).toBe('coalesce((SELECT d.on_ FROM demand d), false)');

    const all = render(helperGateStatesSql('m3-deepseek'));
    expect(all.sql).toMatch(/^WITH sup AS MATERIALIZED/);
    expect(all.sql).toContain('coalesce(a.n, 0)::int AS active, g.max_slots');
    expect(all.sql).toContain('ORDER BY g.assignment_id, g.kind');
    const one = render(helperGateStatesSql('m3-deepseek', { routeId: 'local-ai1-helper', provider: 'local-direct', model: 'DeepSeek' }));
    expect(one.sql).toContain('WHERE g.route_id = $4 AND g.provider = $5 AND g.model = $6');
    expect(one.params.slice(3)).toEqual(['local-ai1-helper', 'local-direct', 'DeepSeek']);
    expect(helperGateStateFromRow({ assignment_id: 'm3-deepseek:ai1', kind: 'live', route_id: 'local-ai1-helper', provider: 'local-direct',
      model: 'DeepSeek', ok: false, active: '1' as unknown as number, max_slots: 1 }))
      .toEqual({ assignmentId: 'm3-deepseek:ai1', kind: 'live', routeId: 'local-ai1-helper', provider: 'local-direct', model: 'DeepSeek', ok: false, active: 1, maxSlots: 1 });
  });
});

describe('repository input refusals (before any DB access)', () => {
  it('refuses a bad actor, version, mode or assignment id with the contract error strings', async () => {
    const tx = {} as ProductTransaction;   // no DB: every refusal below happens before the first statement
    await expect(saveHelperAssignment(tx, minimal, null, ' ')).rejects.toThrow('model_helper_invalid:actor');
    await expect(saveHelperAssignment(tx, minimal, 0, 'admin')).rejects.toThrow('model_helper_version_mismatch:invalid');
    await expect(saveHelperAssignment(tx, minimal, 1.5, 'admin')).rejects.toThrow('model_helper_version_mismatch:invalid');
    await expect(setHelperMode(tx, 'm3-deepseek:ai1', 'live' as 'shadow', 1, 'admin')).rejects.toThrow('model_helper_invalid:mode');
    await expect(setHelperMode(tx, 'M3', 'shadow', 1, 'admin')).rejects.toThrow('model_helper_invalid:assignmentId');
    await expect(setHelperMode(tx, 'm3-deepseek:ai1', 'off', 0, 'admin')).rejects.toThrow('model_helper_version_mismatch:invalid');
    await expect(setSupervisorControl(tx, { enabled: false }, 'x'.repeat(121))).rejects.toThrow('model_supervisor_invalid:actor');
    await expect(readHelperGateStates('')).rejects.toThrow('model_helper_invalid:deviceId');
    expect(typeof listHelperAssignments).toBe('function');
    expect(typeof readHelperStatusSnapshot).toBe('function');
  });
});

describe('migration 0154', () => {
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries: { idx: number; when: number; tag: string; version: string }[] };
  const migration = readFileSync('drizzle/0154_capacity_helpers.sql', 'utf8');

  it('registers the helper tables as 0154 right after the device tables', () => {
    expect(journal.entries.find(entry => entry.tag === '0154_capacity_helpers')).toMatchObject({ idx: 154, when: 1794086401065, version: '7' });
    for (const table of ['model_supervisor_control', 'model_helper_assignments', 'model_helper_signals', 'model_device_signals', 'model_role_demand',
      'model_helper_stops', 'model_helper_shadow_runs', 'model_helper_live_outputs']) expect(migration).toContain(`CREATE TABLE ${table} (`);
  });

  it('seeds the supervisor switched off and adds no helper assignment', () => {
    expect(migration).toContain('enabled boolean NOT NULL DEFAULT false');
    expect(migration).toContain("mode varchar(8) NOT NULL DEFAULT 'off'");
    expect(migration).toContain(`signal_principal varchar(63) NOT NULL DEFAULT '${SUPERVISOR_PRINCIPAL}'`);
    expect(migration).toContain('INSERT INTO model_supervisor_control (id) VALUES (1) ON CONFLICT (id) DO NOTHING;');
    expect(migration).not.toContain('INSERT INTO model_helper_assignments');
    expect(migration).toContain("CONSTRAINT model_helper_assignments_live_check CHECK (mode <> 'live' OR (promoted_at IS NOT NULL AND promoted_evidence IS NOT NULL))");
    for (const table of ['model_helper_signals', 'model_device_signals', 'model_role_demand'])
      expect(migration).toContain(`CONSTRAINT ${table}_ttl_check CHECK (valid_until > observed_at AND valid_until <= observed_at + interval '5 minutes')`);
    expect(migration).toContain('REFERENCES model_capacity_devices (device_id)');
    expect(migration).not.toMatch(/ALTER TABLE|DROP |UPDATE model_|GRANT |REVOKE |SECURITY DEFINER|ROW LEVEL SECURITY/);
  });

  const code = migration.replace(/--(?!> statement-breakpoint).*$/gm, '');
  it('stamps written_by/observed_at on the three signal tables with one invoker trigger function', () => {
    expect(code).toContain('CREATE FUNCTION model_signal_stamp() RETURNS trigger LANGUAGE plpgsql');
    expect(code).toContain('NEW.written_by := current_user;');
    expect(code).toContain('NEW.observed_at := clock_timestamp();');
    expect([...code.matchAll(/CREATE TRIGGER (\w+) BEFORE INSERT OR UPDATE ON (\w+)\s+FOR EACH ROW EXECUTE FUNCTION model_signal_stamp\(\)/g)]
      .map(match => [match[1], match[2]])).toEqual([['model_helper_signals_stamp', 'model_helper_signals'],
      ['model_device_signals_stamp', 'model_device_signals'], ['model_role_demand_stamp', 'model_role_demand']]);
  });

  it('makes model_helper_stops append-only like operations_audit (UPDATE/DELETE/TRUNCATE raise 42501)', () => {
    expect(code).toContain("RAISE EXCEPTION 'model_helper_stops is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege'");
    expect(code).toMatch(/CREATE TRIGGER model_helper_stops_no_change BEFORE UPDATE OR DELETE ON model_helper_stops\s+FOR EACH ROW EXECUTE FUNCTION model_helper_stops_append_only\(\)/);
    expect(code).toMatch(/CREATE TRIGGER model_helper_stops_no_truncate BEFORE TRUNCATE ON model_helper_stops\s+FOR EACH STATEMENT EXECUTE FUNCTION model_helper_stops_append_only\(\)/);
    expect(code).toMatch(/CREATE TRIGGER model_helper_stops_stamp BEFORE INSERT ON model_helper_stops\s+FOR EACH ROW/);
  });

  it('extends the 0107 observation scope with the supervisor branch and keeps the two old branches byte-identical', () => {
    const body = (text: string, head: string) => { const from = text.indexOf(head); return text.slice(from, text.indexOf('$$;', from)); };
    const old = body(readFileSync('drizzle/0107_oracle_consumer_row_scope.sql', 'utf8'), 'CREATE FUNCTION oracle_consumer_observation_scope()');
    const next = body(migration, 'CREATE OR REPLACE FUNCTION oracle_consumer_observation_scope()');
    const branches = old.slice(old.indexOf('  IF current_user'), old.indexOf('  END IF;'));
    expect(branches).toContain("'nomorevibe_oracle_agent_scan'");
    expect(next).toContain(branches);
    expect(next).toContain(`ELSIF current_user::text = '${SUPERVISOR_PRINCIPAL}'`);
    // consumer prefix capacity-supervisor-consumer- (29) + SERVICE_INSTANCE_ID 48 → tail 1..19
    expect(next).toContain("'^(capacity-supervisor|service:maintenance):capacity-supervisor-consumer-[A-Za-z0-9._-]{1,19}$'");
    expect('capacity-supervisor-consumer-'.length + 19).toBe(48);
    expect([...next.matchAll(/ERRCODE = '(\w+)'/g)].map(match => match[1])).toEqual(['42501', '42501', '42501']);
  });
});

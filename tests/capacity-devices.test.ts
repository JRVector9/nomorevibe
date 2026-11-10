import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DEFAULT_DEVICE_IDLE_MS, DEFAULT_DEVICE_RESERVE_SLOTS, MODEL_CAPACITY_DEVICE_SAVE_AUDIT_ACTION, MODEL_CAPACITY_ROUTE_QUOTA_SAVE_AUDIT_ACTION, UNRANKED_ROLE_RANK,
  deviceCandidateSql, deviceFallbackLimit, deviceFits, deviceLending, deviceRoleRank, deviceRouteQuotaFits, deviceRouteQuotaGateSql, deviceSecondaryBound,
  deviceSettingsFromPolicyFallback, deviceStateCte, deviceStateFromRow, deviceStateSql, modelCapacityDeviceRoleSchema, modelCapacityDeviceSettingsSchema,
  modelCapacityRouteStateSchema, parseModelCapacityDeviceSettings, parseModelCapacityRouteQuotasInput, routeQuotaCap, routeQuotaGateCapped,
  routeQuotasFromRecords, routeQuotasLimitIssue, routeQuotasToRecords, routeStatesFromJson, type ModelCapacityRouteState,
  MODEL_CAPACITY_MODEL_LIMIT_SAVE_AUDIT_ACTION, deviceModelLimitText, deviceModelQuotaFits, deviceModelQuotaGateSql, deviceModelUsageText,
  modelCapacityModelStateSchema, modelLimitsAboveShared, modelLimitsFromRecords, modelLimitsToRecords, modelQuotaGateCapped, modelStatesFromJson,
  parseModelCapacityModelLimitsInput, type ModelCapacityModelState } from '@/lib/llm/capacity-devices';

const render = (query: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(query);
const generation = { epoch: 3, revision: 7, policyHash: 'a'.repeat(64) };
const valid = { deviceId: 'supa', limitSlots: 4, secondaryCap: 1, idleMs: 60_000, reserveSlots: 0, physicalLimit: 4,
  roles: [{ routeId: 'crawl-tagline', rank: 3 }, { routeId: 'crawl-agent-review', rank: 1 }, { routeId: 'product-search-verify', rank: 2 }], note: null };

describe('device settings schema', () => {
  it('parses a valid device and returns roles sorted by rank', () => {
    const parsed = parseModelCapacityDeviceSettings(valid);
    expect(parsed.roles.map(role => [role.routeId, role.rank])).toEqual([['crawl-agent-review', 1], ['product-search-verify', 2], ['crawl-tagline', 3]]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.roles)).toBe(true);
    expect(modelCapacityDeviceSettingsSchema.safeParse({ ...valid, physicalLimit: null, roles: [] }).success).toBe(true);
  });

  it('refuses every invariant the DB CHECKs also refuse, naming the field', () => {
    const refuse = (input: unknown, path: string) => expect(() => parseModelCapacityDeviceSettings(input)).toThrow(`model_capacity_device_invalid:${path}`);
    refuse({ ...valid, secondaryCap: 5 }, 'secondaryCap');                   // cap ≤ limit
    refuse({ ...valid, reserveSlots: 4 }, 'reserveSlots');                   // reserve < limit
    refuse({ ...valid, physicalLimit: 3 }, 'limitSlots');                    // limit ≤ physical
    refuse({ ...valid, roles: [{ routeId: 'a', rank: 1 }, { routeId: 'a', rank: 2 }] }, 'roles'); // unique routeId
    refuse({ ...valid, roles: [{ routeId: 'a', rank: 0 }] }, 'roles.0.rank');
    refuse({ ...valid, roles: [{ routeId: 'a', rank: 65 }] }, 'roles.0.rank');
    refuse({ ...valid, roles: [{ routeId: ' a', rank: 1 }] }, 'roles.0.routeId');
    refuse({ ...valid, limitSlots: 0 }, 'limitSlots');
    refuse({ ...valid, limitSlots: 257, physicalLimit: null }, 'limitSlots');
    refuse({ ...valid, idleMs: 3_600_001 }, 'idleMs');
    refuse({ ...valid, idleMs: 1.5 }, 'idleMs');
    refuse({ ...valid, deviceId: 'supa ' }, 'deviceId');
    refuse({ ...valid, deviceId: 'su\u0000pa' }, 'deviceId');
    refuse({ ...valid, deviceId: 'x'.repeat(121) }, 'deviceId');
    refuse({ ...valid, note: 'n'.repeat(401) }, 'note');
    refuse({ ...valid, extra: 1 }, 'root');                                  // strict
    refuse({ ...valid, roles: undefined }, 'roles');
    refuse(null, 'root');
    expect(modelCapacityDeviceRoleSchema.safeParse({ routeId: 'r', rank: 64 }).success).toBe(true);
    expect(modelCapacityDeviceRoleSchema.safeParse({ routeId: 'r', rank: 1, extra: true }).success).toBe(false);
  });

  it('pins the defaults and the audit action the UI and admission share', () => {
    expect(DEFAULT_DEVICE_IDLE_MS).toBe(60_000);
    expect(DEFAULT_DEVICE_RESERVE_SLOTS).toBe(0);
    expect(UNRANKED_ROLE_RANK).toBe(32767);
    expect(MODEL_CAPACITY_DEVICE_SAVE_AUDIT_ACTION).toBe('model-capacity-device-save');
  });
});

describe('policy fallback and pure predicate helpers', () => {
  it('accepts only groupLimits values the migration seed also accepts', () => {
    expect(deviceFallbackLimit({ supa: 4 }, 'supa')).toBe(4);
    expect(deviceFallbackLimit({ supa: '12' }, 'supa')).toBe(12);
    expect(deviceFallbackLimit({ supa: 256 }, 'supa')).toBe(256);
    expect(deviceFallbackLimit({ supa: 257 }, 'supa')).toBeNull();
    expect(deviceFallbackLimit({ supa: 0 }, 'supa')).toBeNull();
    expect(deviceFallbackLimit({ supa: '04' }, 'supa')).toBeNull();
    expect(deviceFallbackLimit({ supa: 'four' }, 'supa')).toBeNull();
    expect(deviceFallbackLimit({ supa: 4 }, 'other')).toBeNull();
    expect(deviceFallbackLimit(null, 'supa')).toBeNull();
    expect(deviceFallbackLimit(undefined, 'supa')).toBeNull();
  });

  it('reproduces today\'s per-group rule for a fallback device: cap = limit, no ranks, never busy', () => {
    const fallback = deviceSettingsFromPolicyFallback('supa', 4);
    expect(fallback).toEqual({ deviceId: 'supa', limitSlots: 4, secondaryCap: 4, idleMs: 60_000, reserveSlots: 0, physicalLimit: null, roles: [], note: null });
    expect(deviceRoleRank(fallback.roles, 'anything')).toBe(UNRANKED_ROLE_RANK);
    expect(deviceSecondaryBound(fallback, false)).toBe(4);
    expect(deviceSecondaryBound(fallback, true)).toBe(4);
  });

  it('bounds secondaries by the cap while the primary is busy and by the device minus reserve when idle', () => {
    const settings = { limitSlots: 4, secondaryCap: 1, reserveSlots: 1 };
    expect(deviceSecondaryBound(settings, true)).toBe(1);
    expect(deviceSecondaryBound(settings, false)).toBe(3);
    // the idle bound never drops below the cap (cap 3, reserve 3 of 4 → 3)
    expect(deviceSecondaryBound({ limitSlots: 4, secondaryCap: 3, reserveSlots: 3 }, false)).toBe(3);
    expect(deviceRoleRank([{ routeId: 'a', rank: 2 }], 'a')).toBe(2);
  });

  it('fits a waiting row by the same predicate the SQL applies', () => {
    const base = { limitSlots: 4, secondaryBound: 1 };
    expect(deviceFits({ ...base, active: 3, rank: 1, secondaryActive: 1 })).toBe(true);     // primary ignores the cap
    expect(deviceFits({ ...base, active: 4, rank: 1, secondaryActive: 0 })).toBe(false);    // device full
    expect(deviceFits({ ...base, active: 1, rank: 2, secondaryActive: 1 })).toBe(false);    // secondary at cap
    expect(deviceFits({ ...base, active: 1, rank: 2, secondaryActive: 0 })).toBe(true);
    expect(deviceFits({ ...base, active: 1, rank: UNRANKED_ROLE_RANK, secondaryActive: 0 })).toBe(true);
    expect(deviceLending({ primaryBusy: false, secondaryActive: 2, secondaryCap: 1 })).toBe(true);
    expect(deviceLending({ primaryBusy: false, secondaryActive: 1, secondaryCap: 1 })).toBe(false);
    expect(deviceLending({ primaryBusy: true, secondaryActive: 2, secondaryCap: 1 })).toBe(false);
  });
});

describe('candidate SQL', () => {
  it('renders the locked one-row candidate with the generation filter, fallback branch, reserve bound and rank order', () => {
    const query = render(deviceCandidateSql('supa', generation, '{"supa":4}', 0));
    expect(query.sql).toContain('FOR UPDATE OF q');
    expect(query.sql).toMatch(/LIMIT 1 FOR UPDATE OF q$/);
    expect(query.sql).toContain('ORDER BY h.helper, coalesce(ro.role_rank, 32767), q.queue_ordinal');
    expect(query.sql).toMatch(/q\.epoch = \$\d+ AND q\.revision = \$\d+ AND q\.policy_hash = \$\d+/);
    expect(query.sql).toContain("q.state = 'waiting'");
    expect(query.sql).toContain('q.queue_until > clock_timestamp()');
    expect(query.sql).toContain('c.total < s.limit_slots');
    expect(query.sql).toContain('(NOT h.helper AND coalesce(ro.role_rank, 32767) = 1)');
    expect(query.sql).toContain('CASE WHEN b.primary_busy THEN s.secondary_cap ELSE greatest(s.secondary_cap, s.limit_slots - s.reserve_slots) END');
    expect(query.sql).toContain("'policy_fallback'::text");
    expect(query.sql).toContain('NOT EXISTS (SELECT 1 FROM model_capacity_devices d WHERE d.device_id = $');
    expect(query.sql).toContain("~ '^[1-9][0-9]{0,2}$'");
    expect(query.sql).toContain("'table'::text AS source");
    expect(query.sql).toContain('FROM model_capacity_device_roles ro WHERE ro.device_id = $');
    expect(query.params).toEqual(expect.arrayContaining(['supa', '{"supa":4}', 3, 7, 'a'.repeat(64)]));
    expect(query.sql).not.toMatch(/\bINSERT\b|\bDELETE\b|\bUPDATE\s+model_capacity/); // the only UPDATE is the row lock FOR UPDATE OF q
  });

  it('counts occupancy from reserved/dispatched rows only (indeterminate holds nothing) and busy from rank-1 live/recent rows', () => {
    const query = render(deviceCandidateSql('supa', generation, '{}', 0)).sql;
    // helper_active + active CTE + busy CTE + route_use CTE (0169 route quotas: the same occupancy, split by route) + model_use CTE (0170, split by model)
    expect(query.match(/r\.state IN \('reserved','dispatched'\)/g)).toHaveLength(5);
    expect(query).not.toContain("'indeterminate'");
    expect(query).toContain('ro.role_rank = 1');
    expect(query).toContain("r.updated_at >= clock_timestamp() - s.idle_ms * interval '1 millisecond'");
    expect(query).toMatch(/r\.state = 'waiting' AND r\.epoch = \$\d+ AND r\.revision = \$\d+\s+AND r\.policy_hash = \$\d+ AND r\.queue_until > clock_timestamp\(\)/);
    expect(query).toContain("count(*) FILTER (WHERE role_rank > 1)");
    for (const cte of ['sup', 'helper_gate', 'helper_active', 'demand', 's', 'roles', 'active', 'busy', 'counts', 'waiting']) expect(query).toContain(`${cte} AS MATERIALIZED`);
  });

  it('shares the CTE prefix with the state view and accepts an outer column reference for the LATERAL form', () => {
    const state = render(deviceStateSql(sql`ids.device_id`, generation, '{}', 0));
    expect(state.sql).toContain('d.device_id = ids.device_id AND d.enabled');
    expect(state.sql).toContain('ids.device_id::text AS device_id');
    expect(state.sql).toContain('(NOT b.primary_busy AND c.secondary > s.secondary_cap) AS lending');
    expect(state.sql).toContain('END AS secondary_bound');
    expect(state.sql).toContain('w.waiting, w.waiting_primary');
    expect(state.sql).toContain('FROM s, counts c, busy b, waiting w');
    expect(state.sql).not.toMatch(/\bFOR\s+(SHARE|UPDATE)\b/);
    const prefix = render(deviceStateCte('supa', generation, '{}', 0)).sql;
    expect(render(deviceCandidateSql('supa', generation, '{}', 0)).sql.startsWith(prefix)).toBe(true);
    expect(render(deviceStateSql('supa', generation, '{}', 0)).sql.startsWith(prefix)).toBe(true);
  });

  it('composes the helper gate before busy: helper rows rank ≥ 2, sort after own roles, need an open gate, and fresh demand ends lending', () => {
    const prefix = render(deviceStateCte('supa', generation, '{}', 0)).sql;
    expect(prefix).toMatch(/^WITH sup AS MATERIALIZED/);
    expect(prefix.indexOf('demand AS MATERIALIZED')).toBeLessThan(prefix.indexOf('busy AS MATERIALIZED'));
    expect(prefix.indexOf('helper_gate AS MATERIALIZED')).toBeLessThan(prefix.indexOf('active AS MATERIALIZED'));
    // a helper row never takes the rank-1 bypass, never makes the primary busy, and counts as secondary occupancy
    expect(prefix).toContain('THEN greatest(coalesce(ro.role_rank, 32767), 2) ELSE coalesce(ro.role_rank, 32767) END AS role_rank');
    expect(prefix).toContain('NOT EXISTS (SELECT 1 FROM helper_gate hg WHERE hg.route_id = r.route_id AND hg.provider = r.provider AND hg.model = r.model)');
    expect(prefix).toContain('OR coalesce((SELECT d.on_ FROM demand d), false)) AS primary_busy');
    const candidate = render(deviceCandidateSql('supa', generation, '{}', 0)).sql;
    expect(candidate).toContain('CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM helper_gate hg WHERE hg.route_id = q.route_id');
    expect(candidate).toContain('AND NOT EXISTS (SELECT 1 FROM helper_gate g');
    expect(candidate).toContain('>= g.max_slots))');
    expect(candidate).toMatch(/ORDER BY h\.helper, coalesce\(ro\.role_rank, 32767\), q\.queue_ordinal LIMIT 1 FOR UPDATE OF q$/);
    const state = render(deviceStateSql('supa', generation, '{}', 0)).sql;
    expect(state).toContain("'max_slots', g.max_slots)");
    expect(state).toContain('AS helpers');
    expect(state).not.toMatch(/\bFOR\s+(SHARE|UPDATE)\b/);
  });

  it('maps a state row to the camelCase state with ISO time and numeric version', () => {
    const at = new Date('2026-10-30T12:00:00.000Z');
    expect(deviceStateFromRow({ device_id: 'supa', source: 'table', limit_slots: 4, secondary_cap: 1, idle_ms: 60000, reserve_slots: 0, active: 2,
      secondary_active: 1, secondary_bound: 1, primary_busy: true, lending: false, waiting: 3, waiting_primary: 1, version: '5', updated_at: at }))
      .toEqual({ deviceId: 'supa', source: 'table', limitSlots: 4, secondaryCap: 1, idleMs: 60000, reserveSlots: 0, active: 2, secondaryActive: 1,
        secondaryBound: 1, primaryBusy: true, lending: false, waiting: 3, waitingPrimary: 1, version: 5, updatedAt: '2026-10-30T12:00:00.000Z', helpers: [] });
    expect(deviceStateFromRow({ device_id: 'g', source: 'policy_fallback', limit_slots: 2, secondary_cap: 2, idle_ms: 60000, reserve_slots: 0, active: 0,
      secondary_active: 0, secondary_bound: 2, primary_busy: false, lending: false, waiting: 0, waiting_primary: 0, version: null, updated_at: null }))
      .toMatchObject({ source: 'policy_fallback', version: null, updatedAt: null, secondaryBound: 2 });
    const helpers = [{ assignment_id: 'g:ai1', kind: 'live', route_id: 'h', provider: 'local-direct', model: 'm', ok: true, active: 1, max_slots: 2 }];
    expect(deviceStateFromRow({ device_id: 'g', source: 'table', limit_slots: 2, secondary_cap: 0, idle_ms: 0, reserve_slots: 0, active: 1,
      secondary_active: 1, secondary_bound: 2, primary_busy: false, lending: true, waiting: 0, waiting_primary: 0, version: 1, updated_at: at, helpers }).helpers)
      .toEqual([{ assignmentId: 'g:ai1', kind: 'live', routeId: 'h', provider: 'local-direct', model: 'm', ok: true, active: 1, maxSlots: 2 }]);
  });
});

describe('route quotas (step 2, 0169)', () => {
  const input = { deviceId: 'gpu3090-qwen', expectedVersion: 3, lendIdle: true,
    quotas: [{ routeId: 'second-review', minSlots: 1, maxSlots: 2 }, { routeId: 'crawl-publish-classify', minSlots: 1, maxSlots: null }] };

  it('parses the save input, sorts lines by route and names the refused field', () => {
    const parsed = parseModelCapacityRouteQuotasInput(input);
    expect(parsed.quotas.map(quota => quota.routeId)).toEqual(['crawl-publish-classify', 'second-review']);
    expect(Object.isFrozen(parsed.quotas)).toBe(true);
    const refuse = (value: unknown, code: string) => expect(() => parseModelCapacityRouteQuotasInput(value)).toThrow(`model_capacity_route_quota_invalid:${code}`);
    refuse({ ...input, quotas: [{ routeId: 'a', minSlots: 2, maxSlots: 1 }] }, 'quotas.0.maxSlots:min_exceeds_max');
    refuse({ ...input, quotas: [{ routeId: 'a', minSlots: 0, maxSlots: 1 }, { routeId: 'a', minSlots: 0, maxSlots: null }] }, 'quotas:duplicate_route');
    refuse({ ...input, quotas: [{ routeId: 'a', minSlots: -1, maxSlots: null }] }, 'quotas.0.minSlots');
    refuse({ ...input, quotas: [{ routeId: 'a', minSlots: 0, maxSlots: 257 }] }, 'quotas.0.maxSlots');
    refuse({ ...input, quotas: Array.from({ length: 65 }, (_, index) => ({ routeId: `r${index}`, minSlots: 0, maxSlots: null })) }, 'quotas');
    refuse({ ...input, expectedVersion: null }, 'expectedVersion');
    refuse({ ...input, lendIdle: 'yes' }, 'lendIdle');
    refuse({ ...input, extra: true }, 'root');
    expect(MODEL_CAPACITY_ROUTE_QUOTA_SAVE_AUDIT_ACTION).toBe('model-capacity-route-quota-save');
  });

  it('checks the lines against the device limit like the DB function, and converts to and from the stored snake_case lines', () => {
    expect(routeQuotasLimitIssue([{ minSlots: 1, maxSlots: 5 }, { minSlots: 4, maxSlots: null }], 5)).toBeNull();
    expect(routeQuotasLimitIssue([{ minSlots: 1, maxSlots: 6 }], 5)).toBe('quotas.0.maxSlots:exceeds_limit');
    expect(routeQuotasLimitIssue([{ minSlots: 0, maxSlots: null }, { minSlots: 6, maxSlots: null }], 5)).toBe('quotas.1.minSlots:exceeds_limit');
    expect(routeQuotasLimitIssue([{ minSlots: 3, maxSlots: null }, { minSlots: 3, maxSlots: null }], 5)).toBe('quotas:min_sum_exceeds_limit');
    const parsed = parseModelCapacityRouteQuotasInput(input);
    const records = routeQuotasToRecords(parsed.quotas);
    expect(records).toEqual([{ route_id: 'crawl-publish-classify', min_slots: 1, max_slots: null }, { route_id: 'second-review', min_slots: 1, max_slots: 2 }]);
    expect(routeQuotasFromRecords(records)).toEqual(parsed.quotas);
    expect(routeQuotasFromRecords(JSON.stringify(records))).toEqual(parsed.quotas);
    expect(routeQuotasFromRecords([])).toEqual([]);
    expect(() => routeQuotasFromRecords([{ route_id: 'a', min_slots: 2, max_slots: 1 }])).toThrow('model_capacity_route_quotas_unreadable');
    expect(() => routeQuotasFromRecords({})).toThrow('model_capacity_route_quotas_unreadable');
  });

  it('applies the cap by the lending switch: on = max, off = the guarantee when there is one, else max', () => {
    expect(routeQuotaCap({ minSlots: 1, maxSlots: 3 }, true)).toBe(3);
    expect(routeQuotaCap({ minSlots: 1, maxSlots: null }, true)).toBeNull();
    expect(routeQuotaCap({ minSlots: 1, maxSlots: 3 }, false)).toBe(1);
    expect(routeQuotaCap({ minSlots: 0, maxSlots: 3 }, false)).toBe(3);
    expect(routeQuotaCap({ minSlots: 0, maxSlots: null }, false)).toBeNull();
    expect(routeQuotaCap({ minSlots: 0, maxSlots: 0 }, true)).toBe(0);
  });

  it('mirrors the admission expression for a new request: at cap counts waiting rows, under-guarantee ignores held slots, others leave them free', () => {
    const route = (routeId: string, over: Partial<ModelCapacityRouteState> = {}): ModelCapacityRouteState =>
      ({ routeId, active: 0, waiting: 0, minSlots: null, maxSlots: null, cap: null, demand: false, held: 0, ...over });
    const state = (active: number, routes: ModelCapacityRouteState[]) => ({ active, limitSlots: 5, routes });
    expect(deviceRouteQuotaFits({ active: 4, limitSlots: 5 }, 'x')).toEqual({ fits: true, atCap: false, underGuarantee: false }); // no routes = no quotas
    expect(deviceRouteQuotaFits(state(1, [route('a', { active: 1, cap: 1, maxSlots: 1, minSlots: 0 })]), 'a')).toMatchObject({ fits: false, atCap: true });
    expect(deviceRouteQuotaFits(state(0, [route('a', { waiting: 1, cap: 1, maxSlots: 1, minSlots: 0 })]), 'a')).toMatchObject({ fits: false, atCap: true });
    expect(deviceRouteQuotaFits(state(0, [route('a', { cap: 0, maxSlots: 0, minSlots: 0 })]), 'a')).toMatchObject({ fits: false, atCap: true });
    const crowded = state(4, [route('a', { minSlots: 1, held: 1, demand: true, waiting: 1 }), route('b', { active: 4 })]);
    expect(deviceRouteQuotaFits(crowded, 'b')).toEqual({ fits: false, atCap: false, underGuarantee: false }); // 4 + held 1 = limit
    expect(deviceRouteQuotaFits(crowded, 'a')).toEqual({ fits: true, atCap: false, underGuarantee: true });
    expect(deviceRouteQuotaFits(state(5, crowded.routes), 'a').fits).toBe(false);                            // never above the device limit
  });

  it('pins the candidate predicate, the pre-check and the observation shape', () => {
    const candidate = render(deviceCandidateSql('supa', generation, '{}', 0)).sql;
    for (const cte of ['quota', 'route_use', 'recent', 'quota_state']) expect(candidate).toContain(`${cte} AS MATERIALIZED`);
    expect(candidate).toContain('jsonb_to_recordset(d.route_quotas) AS x(route_id text, min_slots int, max_slots int)');
    expect(candidate).toContain('LEFT JOIN quota_state qs ON qs.route_id = q.route_id');
    expect(candidate).toContain('(NOT h.helper AND coalesce(qs.active < qs.min_slots, false))');
    expect(candidate).toContain('AND (qs.cap IS NULL OR qs.active < qs.cap)');
    expect(candidate).toContain('AND (coalesce(qs.active < qs.min_slots, false) OR c.total + (SELECT coalesce(sum(o.held), 0) FROM quota_state o WHERE o.route_id <> q.route_id) < s.limit_slots)');
    expect(candidate).toContain("CASE WHEN s.lend_idle THEN qu.max_slots WHEN qu.min_slots > 0 THEN qu.min_slots ELSE qu.max_slots END AS cap");
    expect(candidate).toContain("(r.state = 'settled' AND r.settled_at >= (SELECT clock_timestamp() - s.idle_ms * interval '1 millisecond' FROM s))");
    expect(candidate).toMatch(/ORDER BY h\.helper, coalesce\(ro\.role_rank, 32767\), q\.queue_ordinal LIMIT 1 FOR UPDATE OF q$/);
    // observation stays readable by the supervisor's column-limited SELECT (no queue_ordinal) and never locks
    const state = render(deviceStateSql('supa', generation, '{}', 0)).sql;
    expect(state).toContain('s.lend_idle');
    expect(state).toContain('FROM quota_state qs FULL JOIN route_use u ON u.route_id = qs.route_id) x) AS routes');
    expect(state).not.toContain('queue_ordinal');
    expect(state).not.toMatch(/\bFOR\s+(SHARE|UPDATE)\b/);
    const fresh = render(deviceRouteQuotaGateSql('supa', generation, '{}', 'second-review', null, 0));
    expect(fresh.sql).toContain('FROM quota_state qs WHERE qs.route_id = $');
    expect(fresh.sql).not.toContain('w.queue_ordinal <');
    expect(fresh.params).toContain('second-review');
    const own = render(deviceRouteQuotaGateSql('supa', generation, '{}', 'second-review', '7e2c1a90-0000-4000-8000-000000000001', 0)).sql;
    expect(own).toContain('w.queue_ordinal < (SELECT o.queue_ordinal FROM model_capacity_requests o WHERE o.request_id = $');
    expect(routeQuotaGateCapped(undefined)).toBe(false);
    expect(routeQuotaGateCapped({ cap: null, active: 9, min_slots: 0, ahead: 9 })).toBe(false);
    expect(routeQuotaGateCapped({ cap: 2, active: 1, min_slots: 0, ahead: 0 })).toBe(false);
    expect(routeQuotaGateCapped({ cap: 2, active: 1, min_slots: 0, ahead: 1 })).toBe(true);
    expect(routeQuotaGateCapped({ cap: 0, active: 0, min_slots: 0, ahead: 0 })).toBe(true);
  });

  it('maps the routes jsonb and lend_idle into the state only when the row carries them', () => {
    const base = { device_id: 'g', source: 'table' as const, limit_slots: 5, secondary_cap: 5, idle_ms: 0, reserve_slots: 0, active: 1,
      secondary_active: 1, secondary_bound: 5, primary_busy: false, lending: false, waiting: 0, waiting_primary: 0, version: 1, updated_at: null };
    expect(deviceStateFromRow(base)).not.toHaveProperty('routes');
    const routes = [{ route_id: 'second-review', active: 1, waiting: 0, min_slots: 1, max_slots: 2, cap: 2, demand: true, held: 0 },
      { route_id: 'other', active: 0, waiting: 2, min_slots: null, max_slots: null, cap: null, demand: false, held: 0 }];
    const mapped = deviceStateFromRow({ ...base, lend_idle: false, routes });
    expect(mapped.lendIdle).toBe(false);
    expect(mapped.routes).toEqual([{ routeId: 'second-review', active: 1, waiting: 0, minSlots: 1, maxSlots: 2, cap: 2, demand: true, held: 0 },
      { routeId: 'other', active: 0, waiting: 2, minSlots: null, maxSlots: null, cap: null, demand: false, held: 0 }]);
    for (const row of mapped.routes!) expect(modelCapacityRouteStateSchema.parse(row)).toEqual(row);
    expect(routeStatesFromJson({})).toEqual([]);
    expect(routeStatesFromJson(JSON.stringify(routes))).toEqual(mapped.routes);
  });
});

describe('model limits (0170)', () => {
  const DEEPSEEK = 'deepseek-v4.1-flash-1017', GPT = 'gpt-oss-120b';
  const input = { deviceId: 'm3-mlx', expectedVersion: 4, limits: [{ model: GPT, maxSlots: 2, engineMax: 4 }, { model: DEEPSEEK, maxSlots: 1, engineMax: 1 }] };

  it('parses the save input, sorts lines by model, defaults engineMax to null and names the refused field', () => {
    const parsed = parseModelCapacityModelLimitsInput(input);
    expect(parsed.limits).toEqual([{ model: DEEPSEEK, maxSlots: 1, engineMax: 1 }, { model: GPT, maxSlots: 2, engineMax: 4 }]);
    expect(Object.isFrozen(parsed.limits)).toBe(true);
    expect(parseModelCapacityModelLimitsInput({ ...input, limits: [{ model: GPT, maxSlots: 3 }] }).limits).toEqual([{ model: GPT, maxSlots: 3, engineMax: null }]);
    const refuse = (value: unknown, code: string) => expect(() => parseModelCapacityModelLimitsInput(value)).toThrow(`model_capacity_model_limit_invalid:${code}`);
    refuse({ ...input, limits: [{ model: GPT, maxSlots: 1 }, { model: GPT, maxSlots: 2 }] }, 'limits:duplicate_model');
    refuse({ ...input, limits: [{ model: GPT, maxSlots: 5, engineMax: 4 }] }, 'limits.0.maxSlots:exceeds_engine');
    refuse({ ...input, limits: [{ model: GPT, maxSlots: -1 }] }, 'limits.0.maxSlots');
    refuse({ ...input, limits: [{ model: GPT, maxSlots: 257 }] }, 'limits.0.maxSlots');
    refuse({ ...input, limits: [{ model: GPT, maxSlots: 1.5 }] }, 'limits.0.maxSlots');
    refuse({ ...input, limits: [{ model: GPT, maxSlots: 0, engineMax: 0 }] }, 'limits.0.engineMax');
    refuse({ ...input, limits: [{ model: ` ${GPT}`, maxSlots: 1 }] }, 'limits.0.model');
    refuse({ ...input, limits: [{ model: 'x'.repeat(201), maxSlots: 1 }] }, 'limits.0.model');
    refuse({ ...input, limits: [{ model: GPT, maxSlots: 1, extra: 1 }] }, 'limits.0');
    refuse({ ...input, limits: Array.from({ length: 65 }, (_, index) => ({ model: `m${index}`, maxSlots: 1 })) }, 'limits');
    refuse({ ...input, expectedVersion: 0 }, 'expectedVersion');
    refuse({ ...input, extra: true }, 'root');
    expect(MODEL_CAPACITY_MODEL_LIMIT_SAVE_AUDIT_ACTION).toBe('model-capacity-model-limit-save');
  });

  it('converts to and from the stored snake_case lines, warns (not refuses) above the shared limit', () => {
    const parsed = parseModelCapacityModelLimitsInput(input);
    const records = modelLimitsToRecords(parsed.limits);
    expect(records).toEqual([{ model: DEEPSEEK, max_slots: 1, engine_max: 1 }, { model: GPT, max_slots: 2, engine_max: 4 }]);
    expect(modelLimitsFromRecords(records)).toEqual(parsed.limits);
    expect(modelLimitsFromRecords(JSON.stringify(records))).toEqual(parsed.limits);
    expect(modelLimitsFromRecords([])).toEqual([]);
    expect(() => modelLimitsFromRecords([{ model: GPT, max_slots: 3, engine_max: 2 }])).toThrow('model_capacity_model_limits_unreadable');
    expect(() => modelLimitsFromRecords({})).toThrow('model_capacity_model_limits_unreadable');
    expect(modelLimitsAboveShared([{ model: DEEPSEEK, maxSlots: 1 }, { model: GPT, maxSlots: 4 }], 2)).toEqual([GPT]);
    expect(modelLimitsAboveShared([{ model: GPT, maxSlots: 2 }], 2)).toEqual([]);
  });

  it('mirrors the pre-check for a new request: waiting rows of the same model count, no line = no cap', () => {
    const model = (name: string, over: Partial<ModelCapacityModelState> = {}): ModelCapacityModelState =>
      ({ model: name, active: 0, waiting: 0, maxSlots: null, engineMax: null, ...over });
    expect(deviceModelQuotaFits({}, GPT)).toEqual({ fits: true, atCap: false });
    expect(deviceModelQuotaFits({ models: [model(GPT, { active: 9 })] }, GPT)).toEqual({ fits: true, atCap: false });
    expect(deviceModelQuotaFits({ models: [model(DEEPSEEK, { active: 1, maxSlots: 1 })] }, DEEPSEEK)).toEqual({ fits: false, atCap: true });
    expect(deviceModelQuotaFits({ models: [model(DEEPSEEK, { waiting: 1, maxSlots: 1 })] }, DEEPSEEK)).toEqual({ fits: false, atCap: true });
    expect(deviceModelQuotaFits({ models: [model(DEEPSEEK, { maxSlots: 0 })] }, DEEPSEEK)).toEqual({ fits: false, atCap: true });
    expect(deviceModelQuotaFits({ models: [model(DEEPSEEK, { active: 1, maxSlots: 1 }), model(GPT, { active: 1, maxSlots: 4 })] }, GPT).fits).toBe(true);
    const state = { active: 3, limitSlots: 4, models: [model(DEEPSEEK, { active: 1, maxSlots: 1, engineMax: 1 }), model(GPT, { active: 2, maxSlots: 4, engineMax: 4 }),
      model('unlimited', { active: 0, waiting: 2 })] };
    expect(deviceModelUsageText(state)).toBe(`${DEEPSEEK} 1/1 · ${GPT} 2/4 · 공유 3/4`);
    expect(deviceModelUsageText(state, name => name === DEEPSEEK ? 'm3-deepseek' : 'm3-gpt-oss')).toBe('m3-deepseek 1/1 · m3-gpt-oss 2/4 · 공유 3/4');
    expect(deviceModelLimitText({ models: [model(DEEPSEEK, { maxSlots: 1, engineMax: 1 }), model(GPT, { maxSlots: 2, engineMax: 4 }), model('x', { maxSlots: 1 })] },
      name => name === DEEPSEEK ? 'm3-deepseek' : name === GPT ? 'm3-gpt-oss' : name)).toBe('m3-deepseek 한도 1 / 엔진 1 · m3-gpt-oss 한도 2 / 엔진 4 · x 한도 1 / 엔진 ?');
  });

  it('pins the candidate predicate, the pre-check and the observation shape', () => {
    const candidate = render(deviceCandidateSql('m3-mlx', generation, '{}', 0)).sql;
    for (const cte of ['model_limit', 'model_use', 'model_state']) expect(candidate).toContain(`${cte} AS MATERIALIZED`);
    expect(candidate).toContain('jsonb_to_recordset(d.model_limits) AS x(model text, max_slots int, engine_max int)');
    expect(candidate).toContain('LEFT JOIN model_state ms ON ms.model = q.model');
    // absolute: its own AND line, outside the rank-1 / under-guarantee bypass
    expect(candidate).toMatch(/\n\s+AND \(ms\.max_slots IS NULL OR ms\.active < ms\.max_slots\)\n\s+ORDER BY h\.helper/);
    expect(candidate).toContain('GROUP BY r.model');
    expect(candidate).not.toContain('engine_max <');
    const state = render(deviceStateSql('m3-mlx', generation, '{}', 0)).sql;
    expect(state).toContain('FROM model_limit ml FULL JOIN model_use u ON u.model = ml.model) x) AS models');
    expect(state).not.toContain('queue_ordinal');
    const fresh = render(deviceModelQuotaGateSql('m3-mlx', generation, 'deepseek-v4.1-flash-1017', null, 0));
    expect(fresh.sql).toMatch(/^WITH model_limit AS MATERIALIZED/);
    expect(fresh.sql).not.toContain('quota_state');      // the light gate does not re-run the whole device CTE
    expect(fresh.sql).toContain('FROM model_state ms WHERE ms.model = $');
    expect(fresh.sql).toContain('w.model = $');
    expect(fresh.sql).not.toContain('w.route_id');       // any route, any provider: the exact model string
    expect(fresh.sql).not.toContain('w.queue_ordinal <');
    expect(fresh.params).toContain('deepseek-v4.1-flash-1017');
    const own = render(deviceModelQuotaGateSql('m3-mlx', generation, GPT, '7e2c1a90-0000-4000-8000-000000000001', 0)).sql;
    expect(own).toContain('w.queue_ordinal < (SELECT o.queue_ordinal FROM model_capacity_requests o WHERE o.request_id = $');
    expect(modelQuotaGateCapped(undefined)).toBe(false);
    expect(modelQuotaGateCapped({ max_slots: 2, active: 1, ahead: 0 })).toBe(false);
    expect(modelQuotaGateCapped({ max_slots: 2, active: 1, ahead: 1 })).toBe(true);
    expect(modelQuotaGateCapped({ max_slots: 0, active: 0, ahead: 0 })).toBe(true);
  });

  it('maps the models jsonb into the state only when the row carries it', () => {
    const base = { device_id: 'm3-mlx', source: 'table' as const, limit_slots: 2, secondary_cap: 2, idle_ms: 0, reserve_slots: 0, active: 1,
      secondary_active: 1, secondary_bound: 2, primary_busy: false, lending: false, waiting: 0, waiting_primary: 0, version: 1, updated_at: null };
    expect(deviceStateFromRow(base)).not.toHaveProperty('models');
    const models = [{ model: DEEPSEEK, active: 1, waiting: 0, max_slots: 1, engine_max: 1 }, { model: 'other', active: 0, waiting: 2, max_slots: null, engine_max: null }];
    const mapped = deviceStateFromRow({ ...base, models });
    expect(mapped.models).toEqual([{ model: DEEPSEEK, active: 1, waiting: 0, maxSlots: 1, engineMax: 1 }, { model: 'other', active: 0, waiting: 2, maxSlots: null, engineMax: null }]);
    for (const row of mapped.models!) expect(modelCapacityModelStateSchema.parse(row)).toEqual(row);
    expect(modelStatesFromJson(JSON.stringify(models))).toEqual(mapped.models);
    expect(modelStatesFromJson(null)).toEqual([]);
  });
});

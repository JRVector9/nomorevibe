import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DEFAULT_DEVICE_IDLE_MS, DEFAULT_DEVICE_RESERVE_SLOTS, MODEL_CAPACITY_DEVICE_SAVE_AUDIT_ACTION, UNRANKED_ROLE_RANK,
  deviceCandidateSql, deviceFallbackLimit, deviceFits, deviceLending, deviceRoleRank, deviceSecondaryBound, deviceSettingsFromPolicyFallback,
  deviceStateCte, deviceStateFromRow, deviceStateSql, modelCapacityDeviceRoleSchema, modelCapacityDeviceSettingsSchema,
  parseModelCapacityDeviceSettings } from '@/lib/llm/capacity-devices';

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
    const query = render(deviceCandidateSql('supa', generation, '{"supa":4}'));
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
    const query = render(deviceCandidateSql('supa', generation, '{}')).sql;
    expect(query.match(/r\.state IN \('reserved','dispatched'\)/g)).toHaveLength(3);  // helper_active + active CTE + busy CTE
    expect(query).not.toContain("'indeterminate'");
    expect(query).toContain('ro.role_rank = 1');
    expect(query).toContain("r.updated_at >= clock_timestamp() - s.idle_ms * interval '1 millisecond'");
    expect(query).toMatch(/r\.state = 'waiting' AND r\.epoch = \$\d+ AND r\.revision = \$\d+\s+AND r\.policy_hash = \$\d+ AND r\.queue_until > clock_timestamp\(\)/);
    expect(query).toContain("count(*) FILTER (WHERE role_rank > 1)");
    for (const cte of ['sup', 'helper_gate', 'helper_active', 'demand', 's', 'roles', 'active', 'busy', 'counts', 'waiting']) expect(query).toContain(`${cte} AS MATERIALIZED`);
  });

  it('shares the CTE prefix with the state view and accepts an outer column reference for the LATERAL form', () => {
    const state = render(deviceStateSql(sql`ids.device_id`, generation, '{}'));
    expect(state.sql).toContain('d.device_id = ids.device_id AND d.enabled');
    expect(state.sql).toContain('ids.device_id::text AS device_id');
    expect(state.sql).toContain('(NOT b.primary_busy AND c.secondary > s.secondary_cap) AS lending');
    expect(state.sql).toContain('END AS secondary_bound');
    expect(state.sql).toContain('w.waiting, w.waiting_primary');
    expect(state.sql).toContain('FROM s, counts c, busy b, waiting w');
    expect(state.sql).not.toMatch(/\bFOR\s+(SHARE|UPDATE)\b/);
    const prefix = render(deviceStateCte('supa', generation, '{}')).sql;
    expect(render(deviceCandidateSql('supa', generation, '{}')).sql.startsWith(prefix)).toBe(true);
    expect(render(deviceStateSql('supa', generation, '{}')).sql.startsWith(prefix)).toBe(true);
  });

  it('composes the helper gate before busy: helper rows rank ≥ 2, sort after own roles, need an open gate, and fresh demand ends lending', () => {
    const prefix = render(deviceStateCte('supa', generation, '{}')).sql;
    expect(prefix).toMatch(/^WITH sup AS MATERIALIZED/);
    expect(prefix.indexOf('demand AS MATERIALIZED')).toBeLessThan(prefix.indexOf('busy AS MATERIALIZED'));
    expect(prefix.indexOf('helper_gate AS MATERIALIZED')).toBeLessThan(prefix.indexOf('active AS MATERIALIZED'));
    // a helper row never takes the rank-1 bypass, never makes the primary busy, and counts as secondary occupancy
    expect(prefix).toContain('THEN greatest(coalesce(ro.role_rank, 32767), 2) ELSE coalesce(ro.role_rank, 32767) END AS role_rank');
    expect(prefix).toContain('NOT EXISTS (SELECT 1 FROM helper_gate hg WHERE hg.route_id = r.route_id AND hg.provider = r.provider AND hg.model = r.model)');
    expect(prefix).toContain('OR coalesce((SELECT d.on_ FROM demand d), false)) AS primary_busy');
    const candidate = render(deviceCandidateSql('supa', generation, '{}')).sql;
    expect(candidate).toContain('CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM helper_gate hg WHERE hg.route_id = q.route_id');
    expect(candidate).toContain('AND NOT EXISTS (SELECT 1 FROM helper_gate g');
    expect(candidate).toContain('>= g.max_slots))');
    expect(candidate).toMatch(/ORDER BY h\.helper, coalesce\(ro\.role_rank, 32767\), q\.queue_ordinal LIMIT 1 FOR UPDATE OF q$/);
    const state = render(deviceStateSql('supa', generation, '{}')).sql;
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

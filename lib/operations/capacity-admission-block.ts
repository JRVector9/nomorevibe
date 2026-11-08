import { sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { modelCapacityPolicyHash, parseModelCapacityPolicy, type ModelCapacityPolicy } from '@/lib/llm/capacity';
import { deviceFallbackLimit, routeQuotaCap, routeQuotasFromRecords, UNRANKED_ROLE_RANK, type ModelCapacityRouteQuota } from '@/lib/llm/capacity-devices';
import { inFlightStateSql } from '@/lib/llm/capacity-states';

/** 점유는 (장비, 경로) 묶음으로 센다 — route ≤ 128 이므로 129 행이면 잘렸다. */
const ACTIVE_GROUP_CAP = 129;
const WAITING_ROUTE_CAP = 129;
const DEVICE_CAP = 257;

/** 진행 단계로 재시작을 끄는 경로만. 같은 그룹의 다른 경로(예: human-deepseek)는 점유 계산에만 들어간다. */
const ROUTE_JOB = {
  'crawl-agent-review': { job: 'crawl-agent-review', class: 'first', pool: 'reviewer' },
  'second-review': { job: 'second-review', class: 'second', pool: 'reviewer' },
} as const;

/**
 * device: 장비(route 의 groupId) 칸이 다 찼다. device_cap: 낮은 순위(rank > 1) 경로가 우선 역할이 바쁜 동안 낮은 순위 상한(secondary_cap)에 막혔다.
 * policy: 옛 세대 점유가 모든 신규 접수를 막는다. 전역·풀·공급자 한도는 2026-10-30(PR 1b)부터 입장이 읽지 않는다.
 */
export type CapacityAdmissionScope = 'device' | 'device_cap' | 'policy';
export type CapacityAdmissionBlock = {
  job: string; routeId: string; groupId: string; scope: CapacityAdmissionScope;
};
/** 단계에 붙이는 안전한 막힘 설명. 경보·reason 은 바꾸지 않는다. */
export type StageAdmissionDetail = {
  reason: 'capacity'; routeId: string; groupId: string; scope: CapacityAdmissionScope;
};

type ActiveRow = { groupId: string; routeId: string; providerBudgetId: string; pool: string; n: number };
type WaitingRow = Omit<ActiveRow, 'routeId'> & { routeId: string; provider: string; model: string; class: string };
type DeviceRow = { deviceId: string; limitSlots: number; secondaryCap: number; roles: { routeId: string; rank: number }[];
  /** 경로 몫(0169). 옛 스냅숏에는 없다(그때는 빌려주기 켜짐·몫 없음). */
  lendIdle: boolean; quotas: readonly ModelCapacityRouteQuota[] };

/**
 * OPEN 정책의 이전 세대 점유는 모든 신규 접수를 막는다. 이 경우 waiting INSERT 이전에 거절되므로 대기 행이 없어도 보호한다.
 * 같은 세대 점유는 정확히 그 경로의 미만료 waiting 이 장비 한도(`model_capacity_devices`, 행이 없으면 정책 groupLimits 대체)나
 * 낮은 순위 상한에 막혀 있을 때만 보호한다. 우선 역할의 유휴(idle_ms) 판정은 집계 스냅숏으로는 모르므로 "우선 역할 행이 점유·대기 중"일 때만
 * 상한에 막힌 것으로 본다(힌트일 뿐 — 입장 판정은 lib/llm/capacity-devices.ts 의 SQL 이 한다).
 * 증거 없음·조회 실패·정책 불일치는 빈 배열이다(재시작 판정을 그대로 둔다).
 */
export async function readCapacityAdmissionBlocks(): Promise<CapacityAdmissionBlock[]> {
  if (currentReplayDb()) return [];
  try {
    const value = await onPrimary(() => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL jit = off`);
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      const [row] = await tx.execute<{ value: unknown }>(sql`
        SELECT jsonb_build_object(
          'mode', c.mode, 'policy', c.policy, 'policyHash', c.policy_hash,
          'writerActive', f.state = 'active',
          'oldActive', EXISTS (
            SELECT 1 FROM model_capacity_requests r
            WHERE (${inFlightStateSql('r.state')} OR (r.state = 'reserved' AND r.reserved_until > clock_timestamp()))
              AND (r.epoch <> c.epoch OR r.revision <> c.revision OR r.policy_hash IS DISTINCT FROM c.policy_hash)
          ),
          'active', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
              'groupId', s.group_id, 'routeId', s.route_id, 'providerBudgetId', s.provider_budget_id, 'pool', s.pool, 'n', s.n)), '[]'::jsonb)
            FROM (
              SELECT group_id, route_id, provider_budget_id, pool, count(*)::int AS n
              FROM model_capacity_requests r
              WHERE ${inFlightStateSql('r.state')} OR (r.state = 'reserved' AND r.reserved_until > clock_timestamp())
              GROUP BY group_id, route_id, provider_budget_id, pool
              LIMIT ${ACTIVE_GROUP_CAP}
            ) s
          ),
          'devices', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('deviceId', d.device_id, 'limitSlots', d.limit_slots, 'secondaryCap', d.secondary_cap,
              'lendIdle', d.lend_idle, 'routeQuotas', d.route_quotas,
              'roles', (SELECT coalesce(jsonb_agg(jsonb_build_object('routeId', ro.route_id, 'rank', ro.role_rank)), '[]'::jsonb)
                FROM model_capacity_device_roles ro WHERE ro.device_id = d.device_id))), '[]'::jsonb)
            FROM (SELECT device_id, limit_slots, secondary_cap, lend_idle, route_quotas FROM model_capacity_devices WHERE enabled ORDER BY device_id LIMIT ${DEVICE_CAP}) d
          ),
          'waiting', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
              'routeId', s.route_id, 'provider', s.provider, 'model', s.model,
              'providerBudgetId', s.provider_budget_id, 'groupId', s.group_id, 'pool', s.pool, 'class', s.class, 'n', s.n)), '[]'::jsonb)
            FROM (
              SELECT route_id, provider, model, provider_budget_id, group_id, pool, class, count(*)::int AS n
              FROM model_capacity_requests q
              WHERE q.state = 'waiting' AND q.epoch = c.epoch AND q.revision = c.revision
                AND q.policy_hash = c.policy_hash AND q.queue_until > clock_timestamp()
                AND q.queued_at > clock_timestamp() - interval '120 seconds'
              GROUP BY route_id, provider, model, provider_budget_id, group_id, pool, class
              LIMIT ${WAITING_ROUTE_CAP}
            ) s
          )
        ) AS value
        FROM model_capacity_control c CROSS JOIN dr_writer_fence f
        WHERE c.id = 1 AND f.id = 1`);
      return row?.value ?? null;
    }, { accessMode: 'read only' }));
    return capacityAdmissionBlocksFromSnapshot(value);
  } catch {
    return [];
  }
}

export function capacityAdmissionBlocksFromSnapshot(value: unknown): CapacityAdmissionBlock[] {
  try {
    return classifyCapacityAdmission(value);
  } catch {
    return [];
  }
}

/** restartEligible 인 단계만 끈다. reason·alarm·다른 단계·줄 정지는 그대로다. */
export function applyCapacityAdmissionBlock<T extends { job?: string; restartEligible?: boolean }>(
  stage: T, blocks: readonly CapacityAdmissionBlock[],
): T & { admissionBlock?: StageAdmissionDetail } {
  if (stage.restartEligible !== true || !stage.job) return stage;
  const block = blocks.find(row => row.job === stage.job);
  if (!block) return stage;
  const admissionBlock: StageAdmissionDetail = {
    reason: 'capacity', routeId: block.routeId, groupId: block.groupId, scope: block.scope,
  };
  return { ...stage, restartEligible: false, admissionBlock };
}

function classifyCapacityAdmission(value: unknown): CapacityAdmissionBlock[] {
  if (!value || typeof value !== 'object') return [];
  const row = value as { mode?: unknown; policy?: unknown; policyHash?: unknown; writerActive?: unknown; oldActive?: unknown; active?: unknown; waiting?: unknown;
    devices?: unknown };
  if (row.mode !== 'open' || row.writerActive !== true || typeof row.oldActive !== 'boolean') return [];
  if (typeof row.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.policyHash)) return [];
  const policy = parseModelCapacityPolicy(row.policy);
  if (modelCapacityPolicyHash(policy) !== row.policyHash) return [];
  if (row.oldActive) return policy.routes.flatMap(route => {
    const spec = ROUTE_JOB[route.routeId as keyof typeof ROUTE_JOB];
    return spec ? [{ job: spec.job, routeId: route.routeId, groupId: route.groupId, scope: 'policy' as const }] : [];
  });
  const active = parseRows(row.active, false);
  const waiting = parseRows(row.waiting, true);
  const devices = parseDevices(row.devices);
  if (!active || !waiting || !devices || active.length >= ACTIVE_GROUP_CAP || waiting.length >= WAITING_ROUTE_CAP || devices.length >= DEVICE_CAP) return [];
  const jobs = new Map<string, { open: boolean; block: CapacityAdmissionBlock | null }>();
  for (const item of waiting) {
    const spec = ROUTE_JOB[item.routeId as keyof typeof ROUTE_JOB];
    if (!spec || item.class !== spec.class || item.pool !== spec.pool) continue;
    const route = policy.routes.find(candidate => candidate.routeId === item.routeId
      && candidate.provider === item.provider && candidate.model === item.model);
    const state = jobs.get(spec.job) ?? { open: false, block: null };
    const scope = route && route.groupId === item.groupId && route.providerBudgetId === item.providerBudgetId
      ? saturatedScope(policy, devices, active, waiting, item) : null;
    if (!route || route.groupId !== item.groupId || route.providerBudgetId !== item.providerBudgetId || !scope) state.open = true;
    else state.block ??= { job: spec.job, routeId: route.routeId, groupId: route.groupId, scope };
    jobs.set(spec.job, state);
  }
  return [...jobs.values()].flatMap(state => state.block && !state.open ? [state.block] : []);
}

/** 장비 설정: enabled 행이 있으면 그것, 없으면 정책 groupLimits 대체(cap = limit, 순위 없음). 둘 다 없으면 null(입장은 device_unconfigured). */
function deviceSettings(policy: ModelCapacityPolicy, devices: DeviceRow[], deviceId: string): DeviceRow | null {
  const row = devices.find(device => device.deviceId === deviceId);
  if (row) return row;
  const limit = deviceFallbackLimit(policy.groupLimits, deviceId);
  return limit === null ? null : { deviceId, limitSlots: limit, secondaryCap: limit, roles: [], lendIdle: true, quotas: [] };
}
function saturatedScope(policy: ModelCapacityPolicy, devices: DeviceRow[], active: ActiveRow[], waiting: WaitingRow[], item: WaitingRow): CapacityAdmissionScope | null {
  const device = deviceSettings(policy, devices, item.groupId);
  if (!device) return null;
  const rank = (routeId: string) => device.roles.find(role => role.routeId === routeId)?.rank ?? UNRANKED_ROLE_RANK;
  const onDevice = (row: { groupId: string }) => row.groupId === item.groupId;
  if (sum(active, onDevice) >= device.limitSlots) return 'device';
  // 경로 몫(step 2): 이 경로가 상한에 닿았거나, 보장 아래가 아닌데 다른 경로의 못 채운 보장을 비워 두면 칸이 없다(장비 막힘).
  // 「최근(idle_ms)」 수요는 스냅숏에 없어 점유·대기만 수요로 본다 — 막힘을 덜 말하는 쪽(힌트, 입장은 capacity-devices.ts 의 SQL 이 한다).
  const onRoute = (routeId: string) => (row: { groupId: string; routeId: string }) => onDevice(row) && row.routeId === routeId;
  const own = device.quotas.find(quota => quota.routeId === item.routeId);
  const ownActive = sum(active, onRoute(item.routeId));
  const cap = own ? routeQuotaCap(own, device.lendIdle) : null;
  if (cap !== null && ownActive >= cap) return 'device';
  const under = own !== undefined && ownActive < own.minSlots;
  const held = device.quotas.reduce((total, quota) => {
    if (quota.routeId === item.routeId) return total;
    const routeActive = sum(active, onRoute(quota.routeId));
    const demand = !device.lendIdle || routeActive > 0 || sum(waiting, onRoute(quota.routeId)) > 0;
    return total + (demand ? Math.max(quota.minSlots - routeActive, 0) : 0);
  }, 0);
  if (!under && sum(active, onDevice) + held >= device.limitSlots) return 'device';
  if (rank(item.routeId) === 1 || under) return null;
  // 낮은 순위: 우선 역할이 점유 중이거나 대기 중이면(최근 updated_at 은 스냅숏에 없다) 낮은 순위 합계가 cap 에 닿았을 때 막힌다.
  const primaryBusy = active.some(row => onDevice(row) && rank(row.routeId) === 1) || waiting.some(row => onDevice(row) && rank(row.routeId) === 1);
  if (primaryBusy && sum(active, row => onDevice(row) && rank(row.routeId) > 1) >= device.secondaryCap) return 'device_cap';
  return null;
}

function sum(rows: { groupId: string; routeId: string; n: number }[], include: (row: { groupId: string; routeId: string }) => boolean): number {
  return rows.reduce((total, row) => total + (include(row) ? row.n : 0), 0);
}

function parseDevices(value: unknown): DeviceRow[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const rows: DeviceRow[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    const limitSlots = count(row.limitSlots), secondaryCap = row.secondaryCap === 0 ? 0 : count(row.secondaryCap);
    if (!identity(row.deviceId) || limitSlots === null || secondaryCap === null || !Array.isArray(row.roles)) return null;
    if (row.lendIdle !== undefined && typeof row.lendIdle !== 'boolean') return null;
    let quotas: readonly ModelCapacityRouteQuota[];
    try { quotas = routeQuotasFromRecords(row.routeQuotas ?? []); } catch { return null; }
    const roles: DeviceRow['roles'] = [];
    for (const role of row.roles) {
      if (!role || typeof role !== 'object') return null;
      const { routeId, rank } = role as Record<string, unknown>;
      const parsed = count(rank);
      if (!identity(routeId) || parsed === null) return null;
      roles.push({ routeId, rank: parsed });
    }
    rows.push({ deviceId: row.deviceId, limitSlots, secondaryCap, roles, lendIdle: row.lendIdle !== false, quotas });
  }
  return rows;
}

function parseRows(value: unknown, waiting: true): WaitingRow[] | null;
function parseRows(value: unknown, waiting: false): ActiveRow[] | null;
function parseRows(value: unknown, waiting: boolean): Array<ActiveRow | WaitingRow> | null {
  if (!Array.isArray(value)) return null;
  const rows: Array<ActiveRow | WaitingRow> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    const n = count(row.n);
    if (n === null) return null;
    if (!identity(row.groupId) || !identity(row.routeId) || !identity(row.providerBudgetId) || (row.pool !== 'reviewer' && row.pool !== 'text')) return null;
    const base: ActiveRow = { groupId: row.groupId, routeId: row.routeId, providerBudgetId: row.providerBudgetId, pool: row.pool, n };
    if (!waiting) { rows.push(base); continue; }
    if (!identity(row.provider) || !identity(row.model) || !identity(row.class)) return null;
    rows.push({ ...base, provider: row.provider, model: row.model, class: row.class });
  }
  return rows;
}

function count(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 1 && n <= 4096 ? n : null;
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

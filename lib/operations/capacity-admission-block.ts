import { sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { modelCapacityPolicyHash, parseModelCapacityPolicy, type ModelCapacityPolicy } from '@/lib/llm/capacity';

const ACTIVE_GROUP_CAP = 65;
const WAITING_ROUTE_CAP = 129;

/** 진행 단계로 재시작을 끄는 경로만. 같은 그룹의 다른 경로(예: human-deepseek)는 점유 계산에만 들어간다. */
const ROUTE_JOB = {
  'crawl-agent-review': { job: 'crawl-agent-review', class: 'first', pool: 'reviewer' },
  'second-review': { job: 'second-review', class: 'second', pool: 'reviewer' },
} as const;

export type CapacityAdmissionScope = 'global' | 'pool' | 'provider' | 'group' | 'policy';
export type CapacityAdmissionBlock = {
  job: string; routeId: string; groupId: string; scope: CapacityAdmissionScope;
};
/** 단계에 붙이는 안전한 막힘 설명. 경보·reason 은 바꾸지 않는다. */
export type StageAdmissionDetail = {
  reason: 'capacity'; routeId: string; groupId: string; scope: CapacityAdmissionScope;
};

type ActiveRow = { groupId: string; providerBudgetId: string; pool: string; n: number };
type WaitingRow = ActiveRow & { routeId: string; provider: string; model: string; class: string };

/**
 * OPEN 정책의 이전 세대 점유는 모든 신규 접수를 막는다. 이 경우 waiting INSERT 이전에 거절되므로 대기 행이 없어도 보호한다.
 * 같은 세대 점유는 정확히 그 경로의 미만료 waiting 이 한도(전역·풀·공급자·그룹)에 막혀 있을 때만 보호한다.
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
            WHERE (r.state IN ('dispatched','indeterminate') OR (r.state = 'reserved' AND r.reserved_until > clock_timestamp()))
              AND (r.epoch <> c.epoch OR r.revision <> c.revision OR r.policy_hash IS DISTINCT FROM c.policy_hash)
          ),
          'active', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
              'groupId', s.group_id, 'providerBudgetId', s.provider_budget_id, 'pool', s.pool, 'n', s.n)), '[]'::jsonb)
            FROM (
              SELECT group_id, provider_budget_id, pool, count(*)::int AS n
              FROM model_capacity_requests r
              WHERE r.state IN ('dispatched','indeterminate') OR (r.state = 'reserved' AND r.reserved_until > clock_timestamp())
              GROUP BY group_id, provider_budget_id, pool
              LIMIT ${ACTIVE_GROUP_CAP}
            ) s
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
  const row = value as { mode?: unknown; policy?: unknown; policyHash?: unknown; writerActive?: unknown; oldActive?: unknown; active?: unknown; waiting?: unknown };
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
  if (!active || !waiting || active.length >= ACTIVE_GROUP_CAP || waiting.length >= WAITING_ROUTE_CAP) return [];
  const global = sum(active, () => true);
  const jobs = new Map<string, { open: boolean; block: CapacityAdmissionBlock | null }>();
  for (const item of waiting) {
    const spec = ROUTE_JOB[item.routeId as keyof typeof ROUTE_JOB];
    if (!spec || item.class !== spec.class || item.pool !== spec.pool) continue;
    const route = policy.routes.find(candidate => candidate.routeId === item.routeId
      && candidate.provider === item.provider && candidate.model === item.model);
    const state = jobs.get(spec.job) ?? { open: false, block: null };
    const scope = route && route.groupId === item.groupId && route.providerBudgetId === item.providerBudgetId
      ? saturatedScope(policy, active, global, item) : null;
    if (!route || route.groupId !== item.groupId || route.providerBudgetId !== item.providerBudgetId || !scope) state.open = true;
    else state.block ??= { job: spec.job, routeId: route.routeId, groupId: route.groupId, scope };
    jobs.set(spec.job, state);
  }
  return [...jobs.values()].flatMap(state => state.block && !state.open ? [state.block] : []);
}

function saturatedScope(policy: ModelCapacityPolicy, active: ActiveRow[], global: number, item: WaitingRow): CapacityAdmissionScope | null {
  const groupLimit = policy.groupLimits[item.groupId];
  const providerLimit = policy.providerLimits[item.providerBudgetId];
  const poolLimit = item.pool === 'reviewer' || item.pool === 'text' ? policy.poolLimits[item.pool] : undefined;
  if (groupLimit === undefined || providerLimit === undefined || poolLimit === undefined) return null;
  if (sum(active, row => row.groupId === item.groupId) >= groupLimit) return 'group';
  if (sum(active, row => row.providerBudgetId === item.providerBudgetId) >= providerLimit) return 'provider';
  if (sum(active, row => row.pool === item.pool) >= poolLimit) return 'pool';
  if (global >= policy.globalLimit) return 'global';
  return null;
}

function sum(rows: ActiveRow[], include: (row: ActiveRow) => boolean): number {
  return rows.reduce((total, row) => total + (include(row) ? row.n : 0), 0);
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
    if (!identity(row.groupId) || !identity(row.providerBudgetId) || (row.pool !== 'reviewer' && row.pool !== 'text')) return null;
    const base: ActiveRow = { groupId: row.groupId, providerBudgetId: row.providerBudgetId, pool: row.pool, n };
    if (!waiting) { rows.push(base); continue; }
    if (!identity(row.routeId) || !identity(row.provider) || !identity(row.model) || !identity(row.class)) return null;
    rows.push({ ...base, routeId: row.routeId, provider: row.provider, model: row.model, class: row.class });
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

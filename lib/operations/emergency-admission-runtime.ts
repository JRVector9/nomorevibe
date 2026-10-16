import { inArray, sql } from 'drizzle-orm';
import { jobs } from '@/lib/db/schema';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { batchHostOrder, batchJobsForRole, BATCH_ROLES, type BatchMode, type BatchRole } from '@/lib/jobs/batches';
import { STALE_LOCK_MS } from '@/lib/jobs/lease';
import type { RoleTakeoverGate } from '@/lib/jobs/role-leader';
import { PAUSED_AFTER_MS } from '@/lib/jobs/status';
import { httpOriginPolicyHash, httpOriginPolicySchema } from '@/lib/net/http-origin-policy';
import { logger } from '@/lib/observability/logger';
import { writerSiteActive } from './dr/epoch';
import { emergencyAdmissionConfig, emergencyTakeoverAllowed, EMERGENCY_HOST, type EmergencyJobRow } from './emergency-admission';
import { classifyEmergencyMode, type EmergencyMode } from './emergency-priority';

/**
 * 비상 모드 입력을 호출한 TX 안에서 DB 로만 읽는다(PR16 설계 2.1·3.3). 쓰기는 없다.
 * - writer: dr_writer_fence(PR15). 연결 불가는 TX 자체가 실패해 호출 쪽이 미룬다.
 * - m3·mini: 그 host 로 매핑된 인스턴스의 역할 후보 관측(candidate:*)이 60초 안에 있었는가. 죽음의 증명이 아니다 — 일의 소유권은 lease token 이 지킨다.
 * - 인스턴스 → host 는 운영자가 정한 HTTP origin 장부 매핑(host 장부가 이미 요구하는 같은 매핑)이다.
 * - 인계 수: 이 host 인스턴스가 지금 쥔 역할 중 첫 순위가 Oracle 이 아닌 것.
 */
export async function readEmergencyState(tx: ProductTransaction, host: string): Promise<{ mode: EmergencyMode; reason: string; heldRoles: string[] }> {
  const writer = await writerSiteActive(tx) ? 'active' : 'fenced';
  const [control] = await tx.execute<{ policy: unknown; policy_hash: string | null }>(sql`SELECT policy, policy_hash FROM http_origin_control WHERE id=1`);
  const mapping = httpOriginPolicySchema.safeParse(control?.policy);
  if (!mapping.success || httpOriginPolicyHash(mapping.data) !== control.policy_hash) throw new Error('emergency_host_mapping_invalid');
  const hostOf = (instance: string) => Object.hasOwn(mapping.data.instanceHosts, instance) ? mapping.data.instanceHosts[instance] : undefined;
  const candidates = await tx.execute<{ key: string }>(sql`SELECT key FROM operations_observations
    WHERE key LIKE 'candidate:%' AND observed_at >= localtimestamp - interval '60 seconds'`);
  const alive = new Set(Array.from(candidates, row => hostOf(row.key.split(':')[2] ?? '')));
  const leases = await tx.execute<{ role: string; owner: string }>(sql`SELECT role, owner_instance_id AS owner FROM role_leases
    WHERE owner_instance_id IS NOT NULL AND lease_until > clock_timestamp()`);
  const heldRoles = Array.from(leases).filter(row => hostOf(row.owner) === host).map(row => row.role);
  const takeover = heldRoles.filter(role => BATCH_ROLES.includes(role as BatchRole) && batchHostOrder(role as BatchRole)[0] !== EMERGENCY_HOST).length;
  const { mode, reason } = classifyEmergencyMode({ m3: alive.has('m3') ? 'alive' : 'down', mini: alive.has('mini') ? 'alive' : 'down',
    writer, oracleTakeoverRoles: takeover });
  return { mode, reason, heldRoles };
}

/** host 가 쥔 역할의 잡(현재 batch mode 기준)과 요청한 잡의 jobs 행. 시각 비교는 모두 DB 시계다 */
export async function readEmergencyJobs(tx: ProductTransaction, heldRoles: readonly string[], job: string): Promise<EmergencyJobRow[]> {
  const [control] = await tx.execute<{ mode: BatchMode }>(sql`SELECT mode FROM job_batch_control WHERE id=1`);
  if (!control) throw new Error('job_batch_control_missing');
  const names = [...new Set([...heldRoles.flatMap(role => BATCH_ROLES.includes(role as BatchRole) ? batchJobsForRole(role as BatchRole, control.mode) : []), job])];
  const stale = sql`now() - ${STALE_LOCK_MS} * interval '1 millisecond'`;
  const rows = await tx.select({ name: jobs.name,
    pending: sql<boolean>`${jobs.requestedVersion} > ${jobs.processedVersion} AND (${jobs.notBefore} IS NULL OR ${jobs.notBefore} <= now())
      AND (${jobs.lockedAt} IS NULL OR ${jobs.lockedAt} < ${stale})`,
    running: sql<boolean>`${jobs.leaseToken} IS NOT NULL AND ${jobs.lockedAt} >= ${stale}`,
    paused: sql<boolean>`coalesce(${jobs.notBefore} > now() + ${PAUSED_AFTER_MS} * interval '1 millisecond', false)`,
    sinceRunMs: sql<number | null>`(extract(epoch from (now() - ${jobs.lastRunAt})) * 1000)::float8`,
  }).from(jobs).where(inArray(jobs.name, names));
  return rows.map(row => ({ ...row, sinceRunMs: row.sinceRunMs === null ? null : Number(row.sinceRunMs) }));
}

/**
 * 역할 선출 TX 안의 hook(PR16b). recovering 이면 Oracle 은 M3·mini 몫 역할을 새로 가져가지 않는다 — 이미 쥔 역할은 선출이
 * 위에서 그대로 돌려주므로(비선점) 영향이 없다. 비활성이면 hook 자체가 없다(기존 선출 그대로).
 */
export function emergencyTakeoverGate(env: Readonly<Record<string, string | undefined>>): RoleTakeoverGate | undefined {
  if (emergencyAdmissionConfig(env).mode === 'disabled') return undefined;
  return async (tx, role) => {
    // Oracle 이 첫 순위인 역할은 어느 상태에서도 인계가 아니다 — DB 를 읽지 않고 통과
    if (emergencyTakeoverAllowed(role, 'recovering')) return true;
    const state = await readEmergencyState(tx, EMERGENCY_HOST);
    const allowed = emergencyTakeoverAllowed(role, state.mode);
    if (!allowed) logger.info('emergency.takeover_held', { role, mode: state.mode, reason: state.reason });
    return allowed;
  };
}

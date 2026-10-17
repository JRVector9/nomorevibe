import { z } from 'zod';
import { JOB_CATALOG } from '@/lib/jobs/catalog';
import { batchHostOrder, type BatchRole } from '@/lib/jobs/batches';
import { budgetSchema, EMERGENCY_JOB_POLICY, planEmergencyAdmission, type EmergencyDecision, type EmergencyDeferReason,
  type EmergencyMode } from './emergency-priority';

/**
 * 비상 admission 연결(PR16b) — host 장부(PR10e)의 같은 TX 에서 읽은 DB 행을 planEmergencyAdmission 입력으로 바꾸는 순수 판정과 설정.
 * DB 는 emergency-admission-runtime.ts 가 읽는다. 기본 비활성: EMERGENCY_ADMISSION 이 없으면 아무 데서도 판정하지 않는다.
 */
export const EMERGENCY_HOST = 'oracle-osaka-smoke';
const policyOf = (job: string) => Object.hasOwn(EMERGENCY_JOB_POLICY, job) ? EMERGENCY_JOB_POLICY[job] : undefined;
const verifiedJobsSchema = z.array(z.string().min(1).max(120)).max(64)
  .refine(names => new Set(names).size === names.length && names.every(name => { const policy = policyOf(name); return typeof policy === 'object' && policy.model === true; }));
const configSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('disabled') }),
  z.strictObject({ mode: z.literal('enabled'), budget: budgetSchema, verifiedModelJobs: verifiedJobsSchema }),
]);
export type EmergencyAdmissionConfig = z.infer<typeof configSchema>;
export type EmergencyAdmissionDeferReason = `emergency_${EmergencyDeferReason}`;

/**
 * 켤 때는 실측 뒤 예산 네 값과 품질·비용 검증을 마친 모델 잡 목록을 모두 적는다(빈 목록도 명시). 기본값은 없다.
 * Oracle host 에서만 켤 수 있다 — M3·mini 는 비상 예산을 쓰지 않는다(설계 2.2 partial/normal).
 */
export function emergencyAdmissionConfig(env: Readonly<Record<string, string | undefined>>): EmergencyAdmissionConfig {
  const raw = env.EMERGENCY_ADMISSION;
  if (raw === undefined) return { mode: 'disabled' };
  try {
    if (Buffer.byteLength(raw, 'utf8') > 4096) throw new Error();
    const config = configSchema.parse(JSON.parse(raw));
    if (config.mode === 'enabled' && env.PHYSICAL_HOST !== EMERGENCY_HOST) throw new Error();
    return config;
  } catch { throw new Error('emergency_admission_invalid'); }
}

/** recovering 에서는 Oracle 이 새 인계 역할을 가져가지 않는다(현 소유는 선출이 그대로 돌려준다). Oracle 이 첫 순위인 역할은 인계가 아니다 */
export function emergencyTakeoverAllowed(role: BatchRole, mode: EmergencyMode): boolean {
  return batchHostOrder(role)[0] === EMERGENCY_HOST || mode !== 'recovering';
}

/** host 가 쥔 역할의 잡 행(jobs). pending 은 pendingJobNames, running 은 hasActiveRoleJob, paused 는 사람 pause 와 같은 식이다 */
export type EmergencyJobRow = { name: string; pending: boolean; running: boolean; paused: boolean; sinceRunMs: number | null };

/**
 * 한 잡의 비상 admission. 실행 중(장부 slot 또는 살아 있는 jobs 잠금)은 남은 몫에서 빼고 due 에서도 뺀다. 요청한 잡은 늘 판정에 넣는다.
 * 기다린 시간 = 마지막 차례(last_run_at) 뒤 주기를 넘긴 만큼 — DB 는 due 가 된 시각을 남기지 않는다(대기 중에도 scheduler 가
 * next_scheduled_at 을 민다). 미룬 잡은 claim 하지 않으므로 last_run_at 이 그대로라 기다림이 늘고 굶지 않는다. 한 번도 안 돈 잡은 가장 오래 기다린 것으로 본다.
 */
export function emergencyJobDecision(input: {
  mode: EmergencyMode; job: string; rows: readonly EmergencyJobRow[]; slots: readonly string[];
  config: Extract<EmergencyAdmissionConfig, { mode: 'enabled' }>; embedding: 'legacy' | 'semantic' | 'degraded'; hostPressure: string | null; nowMs: number;
}): { active: false } | { active: true; decision: EmergencyDecision; slot: boolean } {
  if (input.mode === 'normal' || input.mode === 'partial') return { active: false };
  const running = new Set([...input.slots, ...input.rows.filter(row => row.running).map(row => row.name)]);
  const used = { jobs: 0, model: 0, http: 0 };
  for (const name of running) {
    const policy = policyOf(name), need = typeof policy === 'object' ? policy : null;
    if (need?.tier === 'control') continue;
    used.jobs++;
    if (need?.model) used.model++;
    if (need?.http) used.http++;
  }
  // DB 시계 ms 는 float8 이라 정수로 맞춘다(planEmergencyAdmission 은 정수 ms 만 받는다)
  const overdue = (row: EmergencyJobRow | undefined) => row?.sinceRunMs == null ? Math.round(input.nowMs)
    : Math.max(0, Math.round(row.sinceRunMs) - (JOB_CATALOG.find(job => job.name === row.name)?.intervalMs ?? 0));
  const due = input.rows.filter(row => row.name !== input.job && row.pending && !running.has(row.name)).map(row => ({ job: row.name, overdueMs: overdue(row) }));
  due.push({ job: input.job, overdueMs: overdue(input.rows.find(row => row.name === input.job)) });
  const { budget } = input.config;
  const plan = planEmergencyAdmission({ mode: input.mode, due, paused: new Set(input.rows.filter(row => row.paused).map(row => row.name)),
    verifiedModelJobs: new Set(input.config.verifiedModelJobs), embedding: input.embedding, hostPressure: input.hostPressure,
    budget: { jobs: Math.max(0, budget.jobs - used.jobs), modelJobs: Math.max(0, budget.modelJobs - used.model),
      httpJobs: Math.max(0, budget.httpJobs - used.http), agingMs: budget.agingMs } });
  if (!plan.active) return { active: false };
  const decision = plan.decisions.find(item => item.job === input.job)!;
  return { active: true, decision, slot: decision.admitted && decision.tier !== 'control' };
}

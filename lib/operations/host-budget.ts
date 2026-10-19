import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hostDbBudgetCatalog, type HostDbBudget } from '@/lib/db/host-budget';
import { batchJobsForRole } from '@/lib/jobs/batches';
import { emergencyAdmissionConfig, type EmergencyAdmissionConfig } from './emergency-admission';

/**
 * host 합계 예산(PR10e) — 같은 PHYSICAL_HOST 의 여러 프로세스가 합쳐서 넘지 않아야 하는 물리 한도.
 * 개별 quota 를 더해 충분하다고 하지 않는다. 살아 있는 프로세스·번역 slot 을 DB 장부 한 곳에서 세고,
 * 넘으면 새 일감 admission 만 미룬다(진행 중 작업은 끊지 않는다). 이 파일은 DB 없이 판정만 한다.
 */
const pressureSchema = z.strictObject({
  maxLoadPerCpu: z.number().positive().max(1_000),
  maxHostRssBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxEventLoopDelayMs: z.number().int().positive().max(600_000),
  maxHeartbeatGapMs: z.number().int().positive().max(600_000),
});
export type HostPressureLimits = z.infer<typeof pressureSchema>;
const EnforcementSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('disabled') }),
  z.strictObject({ mode: z.literal('enabled'), pressure: pressureSchema }),
]);

/** 기본 비활성. CPU/RSS/heartbeat 한도는 실측 전 기본값을 두지 않는다 — 켤 때 모두 명시한다(PR11 계획 79행) */
export function hostBudgetEnforcement(env: Readonly<Record<string, string | undefined>>) {
  const raw = env.HOST_BUDGET_ENFORCEMENT;
  if (raw === undefined) return { mode: 'disabled' as const };
  try {
    if (Buffer.byteLength(raw, 'utf8') > 4096) throw new Error();
    return EnforcementSchema.parse(JSON.parse(raw));
  } catch { throw new Error('host_budget_invalid'); }
}

/** 장부에 참여하지 않는 진입점은 켜진 설정을 조용히 무시하지 않고 거절한다 — 세지 않은 연결이 합계를 깨므로(비상 admission 도 장부 위에서만 센다) */
export function assertHostBudgetEntrySupported(env: Readonly<Record<string, string | undefined>>): void {
  if (hostBudgetEnforcement(env).mode === 'enabled' || emergencyAdmissionConfig(env).mode === 'enabled') throw new Error('host_budget_entry_unsupported');
}

/** Oracle consumer principals deliberately lack host ledger cleanup/HTTP authority. Fail before any DB retry. */
export function assertHostBudgetConsumerSupported(env: Readonly<Record<string, string | undefined>>, consumer?: string): void {
  if (consumer === 'agent-scan' && env.PHYSICAL_HOST === 'oracle-osaka-smoke'
    && env.HTTP_ORIGIN_PERMITS === '1' && hostBudgetEnforcement(env).mode === 'enabled')
    throw new Error('agent_scan_oracle_host_budget_unsupported');
}

/** 선언값: Oracle host 번역 실제 호출 합 1(로드맵 PR10 행, PR11 계획 80행). M3·mini 는 이 gate 로 세지 않는다 */
export const HOST_TRANSLATION_CALLS: Readonly<Partial<Record<HostDbBudget['host'], number>>> = { 'oracle-osaka-smoke': 1 };
const TRANSLATION_JOBS: ReadonlySet<string> = new Set(batchJobsForRole('translation', 'versioned'));
export function hostTranslationCap(host: HostDbBudget['host'], job: string): number | null {
  return TRANSLATION_JOBS.has(job) ? HOST_TRANSLATION_CALLS[host] ?? null : null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
}
/**
 * 같은 host 의 모든 프로세스가 같은 roster·한도여야 합계가 성립한다. release 는 rolling copy 번호로 구분하므로 뺀다.
 * 비상 admission 예산도 host 합계라 켜졌으면 함께 묶는다(꺼져 있으면 PR10e shape 그대로).
 */
export function hostBudgetShape(policy: HostDbBudget, pressure: HostPressureLimits,
  emergency?: Omit<Extract<EmergencyAdmissionConfig, { mode: 'enabled' }>, 'mode'>): string {
  const roster = { ...policy, release: null, roles: [...policy.roles].sort(), reviewerConsumers: policy.reviewerConsumers ? [...policy.reviewerConsumers].sort() : null };
  return createHash('sha256').update(JSON.stringify(canonical({ ledger: 1, roster, pressure,
    translationCalls: HOST_TRANSLATION_CALLS[policy.host] ?? null,
    emergency: emergency && { budget: emergency.budget, verifiedModelJobs: [...emergency.verifiedModelJobs].sort() } }))).digest('hex');
}
export function hostProcessIdentity(process: { kind: string; role: string; consumer?: string; replica: number; copy: number }): string {
  return `${process.kind}:${process.role}:${process.consumer ?? (process.role === 'reviewer' ? 'legacy' : '-')}:${process.replica}:${process.copy}`;
}
export function hostSlotPrefix(host: HostDbBudget['host']): string { return `host-slot:${host}`; }

const common = { bootId: z.uuid(), shape: z.string().regex(/^[0-9a-f]{64}$/), leaseUntilMs: z.number() };
const ProcessRowSchema = z.object({ type: z.literal('process'), ...common, identity: z.string().min(1).max(60), pid: z.number().int(), release: z.string(),
  primaryMax: z.number().int().min(0), readMax: z.number().int().min(0), renewedAtMs: z.number(),
  rssBytes: z.number().min(0), eventLoopDelayMs: z.number().min(0), heartbeatGapMs: z.number().min(0), loadPerCpu: z.number().min(0) });
const TranslationRowSchema = z.object({ type: z.literal('translation'), ...common, token: z.uuid(), job: z.string().min(1),
  owner: z.string().min(1), holdMs: z.number().int().positive() });
/** 비상 admission 이 들인 잡 하나(PR16b). 번역 slot 과 같은 lease·hold·token 규칙이다 */
const EmergencyRowSchema = TranslationRowSchema.extend({ type: z.literal('emergency') });
const RowSchema = z.discriminatedUnion('type', [ProcessRowSchema, TranslationRowSchema, EmergencyRowSchema]);
export type HostProcessRow = z.infer<typeof ProcessRowSchema>;
export type HostTranslationRow = z.infer<typeof TranslationRowSchema>;
export type HostEmergencyRow = z.infer<typeof EmergencyRowSchema>;
export type HostLedgerRow = (HostProcessRow | HostTranslationRow | HostEmergencyRow) & { key: string };
export type HostDeferReason = 'host_slot_unconfirmed' | 'host_ledger_invalid' | 'host_policy_mismatch' | 'host_process_duplicate'
  | 'host_db_clients_exhausted' | 'host_http_unbound' | 'host_pressure_cpu' | 'host_pressure_rss' | 'host_pressure_event_loop'
  | 'host_pressure_heartbeat' | 'host_translation_busy' | 'host_budget_unavailable';

/** 만료는 DB 시계(ms)로만 판정한다. 모양·key 가 어긋난 행은 지우지 않고 장부 전체를 무효로 본다(fail closed) */
export function readHostLedger(host: HostDbBudget['host'], rows: readonly { key: string; value: unknown }[], nowMs: number):
  { ok: true; live: HostLedgerRow[]; expired: string[] } | { ok: false } {
  const prefix = hostSlotPrefix(host), live: HostLedgerRow[] = [], expired: string[] = [];
  for (const row of rows) {
    const parsed = RowSchema.safeParse(row.value);
    const slot = `${prefix}:${parsed.data?.type === 'emergency' ? 'e' : 't'}:`;
    const index = row.key.startsWith(slot) ? row.key.slice(slot.length) : '';
    if (!parsed.success || (parsed.data.type === 'process' ? row.key !== `${prefix}:p:${parsed.data.identity}` : !/^[1-9][0-9]*$/.test(index))) return { ok: false };
    if (parsed.data.leaseUntilMs <= nowMs) expired.push(row.key);
    else live.push({ ...parsed.data, key: row.key });
  }
  return { ok: true, live, expired };
}

/** 고유 선언 identity·같은 shape·host 합계(선언 catalog 값) 안에서만 프로세스 자리를 준다 */
export function hostProcessDecision(live: readonly HostLedgerRow[], self: { key: string; bootId: string; shape: string; primaryMax: number; readMax: number },
  policy: HostDbBudget): HostDeferReason | null {
  if (live.some(row => row.shape !== self.shape)) return 'host_policy_mismatch';
  const others = live.filter((row): row is HostProcessRow & { key: string } => row.type === 'process' && row.key !== self.key);
  if (live.some(row => row.type === 'process' && row.key === self.key && row.bootId !== self.bootId)) return 'host_process_duplicate';
  const catalog = hostDbBudgetCatalog(policy);
  if (others.reduce((sum, row) => sum + row.primaryMax, self.primaryMax) > catalog.primaryClients
    || others.reduce((sum, row) => sum + row.readMax, self.readMax) > catalog.replicaClients) return 'host_db_clients_exhausted';
  return null;
}

/** host 전체 압박: 한 프로세스라도 heartbeat 가 밀리거나 event loop 가 막히면 host 의 새 admission 을 멈춘다 */
export function hostPressureDecision(processes: readonly HostProcessRow[], nowMs: number, limits: HostPressureLimits): HostDeferReason | null {
  if (processes.some(row => row.heartbeatGapMs > limits.maxHeartbeatGapMs || nowMs - row.renewedAtMs > limits.maxHeartbeatGapMs)) return 'host_pressure_heartbeat';
  if (processes.some(row => row.eventLoopDelayMs > limits.maxEventLoopDelayMs)) return 'host_pressure_event_loop';
  if (processes.some(row => row.loadPerCpu > limits.maxLoadPerCpu)) return 'host_pressure_cpu';
  if (processes.reduce((sum, row) => sum + row.rssBytes, 0) > limits.maxHostRssBytes) return 'host_pressure_rss';
  return null;
}

import { z } from 'zod';
import { batchCapabilitySchema, batchHostOrder, BATCH_HOSTS, BATCH_ROLES, type BatchPolicy } from '@/lib/jobs/batches';
import { modelCapacityPolicyHash, modelCapacityPolicySchema } from '@/lib/llm/capacity';
import { httpOriginPolicyHash, httpOriginPolicySchema } from '@/lib/net/http-origin-policy';
import { EVIDENCE_KINDS } from './dr/promotion';
import { HOST_TRANSLATION_CALLS, hostSlotPrefix, readHostLedger } from './host-budget';

/**
 * PR13b 관리자 관측 — host 예산 장부·모델 슬롯·DR writer fence·Oracle gate 준비도를 표시용으로만 묶는다.
 * 실행 권한·활성화 판단에 쓰지 않는다. 읽지 못한 값은 null(미확인)이며 0이나 준비 완료로 바꾸지 않는다.
 */
const ORACLE = 'oracle-osaka-smoke' as const;
/** Oracle 우선 분리 역할 — batchHostOrder 가 Oracle 을 먼저 두는 역할(launcher SPLIT_ROLES 와 같은 목록) */
export const ORACLE_ROLES = BATCH_ROLES.filter(role => batchHostOrder(role)[0] === ORACLE);
export type GateCheck = { key: string; status: 'verified' | 'unknown' | 'rejected'; reason: string };
export type AnchorState = 'pinned' | 'absent' | 'invalid' | null;
export type HostLedger = { state: 'unknown' | 'absent' | 'invalid' | 'ok'; processes: number | null; expired: number | null;
  primaryClients: number | null; replicaClients: number | null; shapes: number | null; heartbeatGapMs: number | null;
  eventLoopDelayMs: number | null; loadPerCpu: number | null; rssBytes: number | null; translationHeld: number | null; translationCap: number | null };
export type ModelBudget = { budget: string; limit: number | null; waiting: number; reserved: number; expiredReserved: number;
  dispatched: number; indeterminate: number; oldestWaitingMin: number | null; oldestUnsettledMin: number | null };
export type DrStatus = { state: 'active' | 'fenced' | null; epoch: number | null; reason: string | null; updatedAt: string | null;
  promoted: number | null; sealed: { id: string; fromEpoch: number; toEpoch: number; sealedAt: string; evidence: string[] }[] | null };
export type OracleRole = { role: string; candidate: boolean | null; db: string | null; http: string | null; model: string | null;
  reason: string | null; anchor: AnchorState; lease: boolean | null };
export type PipelineRuntimeStatus = { ledgers: { host: string; ledger: HostLedger }[]; anchors: { host: string; role: string; anchor: AnchorState }[];
  ownersRead: boolean; models: ModelBudget[] | null; dr: DrStatus; oracle: { checks: GateCheck[]; roles: OracleRole[]; liveLeases: number | null } };
export type RuntimeContext = { at: string | null; batchMode: string | null; batchPolicy: BatchPolicy | null;
  readiness: { host: string; role: string; reason: string; anchor: boolean | null }[] | null;
  owners: { role: string; host: string | null; live: boolean }[] | null };

const count = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
const timestamp = z.iso.datetime({ offset: true });
const ledgerSchema = z.object({ atMs: z.number().finite(), rows: z.array(z.object({ key: z.string(), value: z.unknown() })) });
const budgetsSchema = z.array(z.object({ budget: z.string().min(1).max(120), waiting: count, reserved: count, expiredReserved: count,
  dispatched: count, indeterminate: count, oldestWaitingAt: timestamp.nullable(), oldestUnsettledAt: timestamp.nullable(), untimed: count }));
const drSchema = z.object({ state: z.enum(['active', 'fenced']), epoch: positive, reason: z.enum(['operator_fence', 'promotion_sealed']).nullable(),
  updatedAt: timestamp, promoted: count, sealed: z.array(z.object({ id: z.uuid(), fromEpoch: positive, toEpoch: positive, sealedAt: timestamp,
    evidence: z.array(z.enum(EVIDENCE_KINDS)) })) }).refine(row => (row.state === 'active') === (row.reason === null));
const candidatesSchema = z.array(z.object({ role: z.string(), instanceId: z.string(), release: z.string(), capability: z.unknown() }));
const controlSchema = z.object({ mode: z.string(), policy: z.unknown(), policyHash: z.string().nullable() });

const UNKNOWN_LEDGER: HostLedger = { state: 'unknown', processes: null, expired: null, primaryClients: null, replicaClients: null, shapes: null,
  heartbeatGapMs: null, eventLoopDelayMs: null, loadPerCpu: null, rssBytes: null, translationHeld: null, translationCap: null };
const minutes = (at: string, since: string | null) => {
  if (since === null) return null;
  const age = Math.floor((Date.parse(at) - Date.parse(since)) / 60_000);
  return Number.isFinite(age) && age >= 0 ? age : null;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** host-slot 장부 요약. 한도(HOST_BUDGET_ENFORCEMENT)는 각 host 설정에만 있어 압박 판정은 하지 않고 관측값만 낸다 */
export function summarizeHostLedger(host: typeof BATCH_HOSTS[number], rows: readonly { key: string; value: unknown }[] | null, nowMs: number): HostLedger {
  const cap = HOST_TRANSLATION_CALLS[host] ?? null;
  if (!rows) return { ...UNKNOWN_LEDGER, translationCap: cap };
  const own = rows.filter(row => row.key.startsWith(`${hostSlotPrefix(host)}:`));
  if (!own.length) return { ...UNKNOWN_LEDGER, state: 'absent', translationCap: cap };
  const ledger = readHostLedger(host, own, nowMs);
  // 모양이 어긋난 행이 하나라도 있으면 runtime 은 장부 전체를 무효로 보고 admission 을 미룬다(fail closed)
  if (!ledger.ok) return { ...UNKNOWN_LEDGER, state: 'invalid', translationCap: cap };
  const processes = ledger.live.flatMap(row => row.type === 'process' ? [row] : []);
  const max = (values: number[]) => values.length ? Math.max(...values) : null;
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return { state: 'ok', processes: processes.length, expired: ledger.expired.length,
    primaryClients: sum(processes.map(row => row.primaryMax)), replicaClients: sum(processes.map(row => row.readMax)),
    shapes: new Set(ledger.live.map(row => row.shape)).size,
    heartbeatGapMs: max(processes.map(row => Math.max(row.heartbeatGapMs, nowMs - row.renewedAtMs))),
    eventLoopDelayMs: max(processes.map(row => row.eventLoopDelayMs)), loadPerCpu: max(processes.map(row => row.loadPerCpu)),
    rssBytes: processes.length ? sum(processes.map(row => row.rssBytes)) : null,
    translationHeld: ledger.live.filter(row => row.type === 'translation').length, translationCap: cap };
}

function verifiedPolicy<T>(raw: unknown, schema: z.ZodType<T>, hash: (value: T) => string) {
  const control = controlSchema.safeParse(raw);
  if (!control.success) return null;
  const parsed = schema.safeParse(control.data.policy);
  return { mode: control.data.mode, policy: parsed.success && hash(parsed.data) === control.data.policyHash ? parsed.data : null };
}

/** 표시 전용. ctx 는 같은 스냅숏에서 이미 검증한 batch 정책·readiness·lease 이다 */
export function buildPipelineRuntimeStatus(raw: unknown, ctx: RuntimeContext): PipelineRuntimeStatus {
  const input = record(raw), at = ctx.at;
  const anchors = (ctx.readiness ?? []).map(row => ({ host: row.host, role: row.role,
    anchor: row.anchor === null ? null : row.reason.startsWith('anchor_') ? 'invalid' as const : row.anchor ? 'pinned' as const : 'absent' as const }));
  const result: PipelineRuntimeStatus = { ledgers: BATCH_HOSTS.map(host => ({ host, ledger: summarizeHostLedger(host, null, 0) })), anchors,
    ownersRead: ctx.owners !== null, models: null, dr: { state: null, epoch: null, reason: null, updatedAt: null, promoted: null, sealed: null },
    oracle: { checks: [], roles: [], liveLeases: null } };
  if (at !== null) {
    const ledger = ledgerSchema.safeParse(input.hostSlots);
    if (ledger.success) result.ledgers = BATCH_HOSTS.map(host => ({ host, ledger: summarizeHostLedger(host, ledger.data.rows, ledger.data.atMs) }));
    const model = verifiedPolicy(input.model, modelCapacityPolicySchema, modelCapacityPolicyHash);
    const budgets = budgetsSchema.safeParse(input.modelBudgets);
    if (budgets.success) {
      const limits = model?.policy?.providerLimits ?? {};
      const names = [...new Set([...Object.keys(limits), ...budgets.data.map(row => row.budget)])].sort();
      result.models = names.map(budget => {
        const row = budgets.data.find(item => item.budget === budget);
        return { budget, limit: limits[budget] ?? null, waiting: row?.waiting ?? 0, reserved: row?.reserved ?? 0, expiredReserved: row?.expiredReserved ?? 0,
          dispatched: row?.dispatched ?? 0, indeterminate: row?.indeterminate ?? 0, oldestWaitingMin: minutes(at, row?.oldestWaitingAt ?? null),
          // dispatch 시각을 모르는 미정산이 하나라도 있으면 최장 나이를 모른다고 둔다
          oldestUnsettledMin: row && row.untimed > 0 ? null : minutes(at, row?.oldestUnsettledAt ?? null) };
      });
    }
    const dr = drSchema.safeParse(input.dr);
    if (dr.success) result.dr = { ...dr.data };
  }
  const oracleLedger = result.ledgers.find(row => row.host === ORACLE)!.ledger;
  const http = at === null ? null : verifiedPolicy(input.http, httpOriginPolicySchema, httpOriginPolicyHash);
  const oracleInstances = ctx.batchPolicy?.instances.filter(row => row.host === ORACLE) ?? [];
  const check = (key: string, status: GateCheck['status'], reason: string): GateCheck => ({ key, status, reason });
  result.oracle.checks = [
    ctx.batchMode === null ? check('batch', 'unknown', 'batch_unverified') : ctx.batchMode !== 'versioned' ? check('batch', 'unknown', 'batch_not_versioned')
      : !oracleInstances.length ? check('batch', 'unknown', 'oracle_instance_missing') : check('batch', 'verified', 'oracle_instance_registered'),
    !http ? check('http', 'unknown', 'http_unread') : !http.policy ? check('http', 'unknown', 'http_policy_unverified')
      : http.mode !== 'open' ? check('http', 'unknown', 'http_not_open')
      : Object.values(http.policy.instanceHosts).includes(ORACLE) ? check('http', 'verified', 'oracle_http_mapped') : check('http', 'unknown', 'oracle_http_unmapped'),
    oracleLedger.state === 'invalid' ? check('ledger', 'rejected', 'ledger_invalid') : oracleLedger.state === 'ok' && oracleLedger.processes
      ? check('ledger', 'verified', 'ledger_participating') : check('ledger', 'unknown', oracleLedger.state === 'unknown' ? 'ledger_unread' : 'ledger_absent'),
    result.dr.state === 'active' ? check('dr', 'verified', 'writer_active') : result.dr.state === 'fenced' ? check('dr', 'rejected', 'writer_fenced')
      : check('dr', 'unknown', 'fence_unread'),
  ];
  const candidates = at === null ? null : candidatesSchema.safeParse(input.oracleCandidates);
  result.oracle.roles = ORACLE_ROLES.map(role => {
    const rows = candidates?.success ? candidates.data.filter(row => row.role === role) : null;
    // 현재 정책의 Oracle instance·release 와 맞는 후보를 먼저 본다
    const selected = rows?.find(row => ctx.batchPolicy?.release === row.release && oracleInstances.some(item => item.instanceId === row.instanceId)) ?? rows?.[0];
    const capability = batchCapabilitySchema.safeParse(selected?.capability);
    const readiness = ctx.readiness?.find(row => row.host === ORACLE && row.role === role);
    const owner = ctx.owners?.find(row => row.role === role && row.host === ORACLE);
    return { role, candidate: rows === null ? null : rows.length > 0, db: capability.success ? capability.data.dbPrivileges : null,
      http: capability.success ? capability.data.http : null, model: capability.success ? capability.data.model : null,
      reason: readiness?.reason ?? null, anchor: anchors.find(row => row.host === ORACLE && row.role === role)?.anchor ?? null,
      lease: ctx.owners === null ? null : !!owner?.live };
  });
  result.oracle.liveLeases = ctx.owners === null ? null : ctx.owners.filter(row => row.host === ORACLE && row.live).length;
  return result;
}

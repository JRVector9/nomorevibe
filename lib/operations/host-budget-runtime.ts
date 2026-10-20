import { randomUUID } from 'node:crypto';
import { availableParallelism, loadavg } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { and, inArray, like, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { hostDbRuntimeDeclaration } from '@/lib/db/host-budget';
import { operationsObservations } from '@/lib/db/schema';
import { embeddingReadiness } from '@/lib/domain/products/embedding';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { httpOriginPolicyHash, httpOriginPolicySchema } from '@/lib/net/http-origin-policy';
import { emergencyAdmissionConfig, emergencyJobDecision, type EmergencyAdmissionDeferReason } from './emergency-admission';
import { readEmergencyJobs, readEmergencyState } from './emergency-admission-runtime';
import { assertHostBudgetConsumerSupported, hostBudgetEnforcement, hostBudgetShape, hostPressureDecision, hostProcessDecision, hostProcessIdentity, hostSlotPrefix,
  hostTranslationCap, readHostLedger, type HostDeferReason, type HostEmergencyRow, type HostProcessRow, type HostTranslationRow } from './host-budget';
import { serviceInstanceId } from './instance';

export type HostAdmission = { admitted: true; release: () => Promise<void> } | { admitted: false; reason: HostDeferReason | EmergencyAdmissionDeferReason };
export type HostBudgetRuntime = {
  enabled: boolean; settled: Promise<void>; ready: () => boolean;
  admit: (job: string) => Promise<HostAdmission>; stop: () => Promise<void>;
};
/** role lease 와 같은 45초 만료·10초 갱신(lib/jobs/role-leader.ts, scripts/role-worker.ts). 장부 주기이지 운영 한도가 아니다 */
export const HOST_BUDGET_LEASE_MS = 45_000, HOST_BUDGET_RENEW_MS = 10_000;
const admitted: HostAdmission = { admitted: true, release: async () => {} };
const DISABLED: HostBudgetRuntime = { enabled: false, settled: Promise.resolve(), ready: () => true, admit: async () => admitted, stop: async () => {} };
let current: HostBudgetRuntime | undefined;
/** 같은 프로세스의 role-worker 와 감독은 장부 자리 하나를 함께 쓴다 */
export function currentHostBudget(): HostBudgetRuntime | undefined { return current; }

type Host = Parameters<typeof hostSlotPrefix>[0];
async function upsert(tx: ProductTransaction, key: string, value: Record<string, unknown>) {
  const observedAt = new Date();
  await tx.insert(operationsObservations).values({ key, value, observedAt })
    .onConflictDoUpdate({ target: operationsObservations.key, set: { value, observedAt } });
}
/**
 * host 마다 anchor 행 하나를 잠가 판정과 기록을 직렬화한다. 짧은 TX 의 행 잠금만 쓰므로 PgBouncer transaction
 * 모드와 맞고(세션 advisory lock 없음), 만료는 DB clock_timestamp 로만 판정한다(로컬 시계 비교 없음).
 */
async function lockedLedger(tx: ProductTransaction, host: Host) {
  const prefix = hostSlotPrefix(host);
  await tx.insert(operationsObservations).values({ key: prefix, value: { type: 'anchor' }, observedAt: new Date() }).onConflictDoNothing();
  await tx.execute(sql`SELECT key FROM operations_observations WHERE key=${prefix} FOR UPDATE`);
  const [clock] = await tx.execute<{ now: number }>(sql`SELECT (extract(epoch from clock_timestamp())*1000)::float8 AS now`);
  const rows = await tx.select({ key: operationsObservations.key, value: operationsObservations.value }).from(operationsObservations)
    .where(like(operationsObservations.key, `${prefix}:%`));
  const nowMs = Number(clock.now), ledger = readHostLedger(host, rows, nowMs);
  // 죽은 프로세스의 자리는 만료 뒤에만 비운다 — crash 해제는 lease 만료가 유일한 근거다
  if (ledger.ok && ledger.expired.length) await tx.delete(operationsObservations).where(inArray(operationsObservations.key, ledger.expired));
  return { nowMs, ledger };
}

/**
 * HOST_BUDGET_ENFORCEMENT 가 없으면 DB·타이머 없이 기존 동작 그대로다. 켜지면 HOST_DB_BUDGET 선언 identity 로
 * 장부 자리를 얻고 갱신하며, admit 은 자리·HTTP 장부 결합·host 압박·번역 slot 을 보고 새 일감만 미룬다.
 * holdMs 는 감독이 잡을 끊는 한도(job+drain)다. 번역 slot 은 그보다 먼저 만료되지 않아 끊긴 소유자와 겹치지 않는다.
 * EMERGENCY_ADMISSION(PR16b, Oracle 만)이 켜지면 같은 장부 TX 에서 비상 모드를 판정해 full·recovering·hold 일 때
 * planEmergencyAdmission 이 들인 잡만 비상 slot(:e:n)을 잡고 claim 한다. 정상·부분 장애에서는 기존 판정 그대로다.
 */
export function startHostBudget(env: Readonly<Record<string, string | undefined>> = process.env,
  options: { holdMs?: number; leaseMs?: number; renewMs?: number } = {}): HostBudgetRuntime {
  const enforcement = hostBudgetEnforcement(env);
  const emergency = emergencyAdmissionConfig(env);
  // 비상 예산은 host 장부 위에서만 센다 — 장부 없이 켜진 설정을 조용히 무시하지 않는다
  if (enforcement.mode === 'disabled' && emergency.mode === 'enabled') throw new Error('emergency_admission_invalid');
  if (enforcement.mode === 'disabled') return DISABLED;
  if (current) throw new Error('host_budget_already_started');
  const { holdMs, leaseMs = HOST_BUDGET_LEASE_MS, renewMs = HOST_BUDGET_RENEW_MS } = options;
  const declaration = hostDbRuntimeDeclaration(env), instanceId = serviceInstanceId(env);
  if (!declaration || !instanceId || env.HTTP_ORIGIN_PERMITS !== '1' || !Number.isSafeInteger(leaseMs) || !Number.isSafeInteger(renewMs)
    || renewMs < 1 || renewMs >= leaseMs || enforcement.pressure.maxHeartbeatGapMs <= renewMs
    || holdMs !== undefined && (!Number.isSafeInteger(holdMs) || holdMs < 1)) throw new Error('host_budget_invalid');
  assertHostBudgetConsumerSupported(env, 'consumer' in declaration.process ? declaration.process.consumer : undefined);
  const { policy, process: identity, primaryMax, readMax } = declaration;
  const host = policy.host, prefix = hostSlotPrefix(host), bootId = randomUUID(), owner = hostProcessIdentity(identity);
  const self = { key: `${prefix}:p:${owner}`, bootId, primaryMax, readMax,
    shape: hostBudgetShape(policy, enforcement.pressure, emergency.mode === 'enabled' ? emergency : undefined) };
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let validUntil = 0, lastRenewal: number | null = null, stopped = false, httpBound = false;
  let failure: HostDeferReason = 'host_slot_unconfirmed', pressure: HostDeferReason | null = null;
  let renewing: Promise<void> | null = null;
  const deny = (reason: HostDeferReason | EmergencyAdmissionDeferReason): HostAdmission => ({ admitted: false, reason });
  // 로컬 유효 기간은 갱신 요청을 보낸 시각(단조 시계)부터 잰다 — DB 가 적은 만료보다 늦지 않다
  const ready = () => !stopped && performance.now() < validUntil;
  const renew = (): Promise<void> => renewing ??= (async () => {
    if (stopped) return;
    const sentAt = performance.now();
    const telemetry = { rssBytes: process.memoryUsage().rss, eventLoopDelayMs: Math.round(delay.max / 1e6),
      heartbeatGapMs: lastRenewal === null ? 0 : Math.round(sentAt - lastRenewal), loadPerCpu: loadavg()[0] / availableParallelism() };
    delay.reset();
    try {
      const result = await onPrimary(() => db.transaction(async tx => {
        const { nowMs, ledger } = await lockedLedger(tx, host);
        if (!ledger.ok) return { reason: 'host_ledger_invalid' as const };
        const reason = hostProcessDecision(ledger.live, self, policy);
        if (reason) return { reason };
        const row: HostProcessRow = { type: 'process', bootId, shape: self.shape, identity: owner, pid: process.pid, release: identity.release,
          primaryMax, readMax, leaseUntilMs: nowMs + leaseMs, renewedAtMs: nowMs, ...telemetry };
        await upsert(tx, self.key, row);
        // 진행 중 번역·비상 잡은 끊지 않는다 — 소유 프로세스가 살아 있는 동안 slot 도 함께 연장한다
        for (const { key, ...held } of ledger.live) {
          if (held.type !== 'process' && held.bootId === bootId) await upsert(tx, key, { ...held, leaseUntilMs: nowMs + leaseMs + held.holdMs });
        }
        const [control] = await tx.execute<{ mode: string; policy: unknown; policy_hash: string | null }>(
          sql`SELECT mode, policy, policy_hash FROM http_origin_control WHERE id=1`);
        const http = httpOriginPolicySchema.safeParse(control?.policy);
        const processes = [...ledger.live.filter((value): value is HostProcessRow & { key: string } => value.type === 'process' && value.key !== self.key), row];
        return { reason: null, pressure: hostPressureDecision(processes, nowMs, enforcement.pressure),
          // 이 host 의 HTTP 합2/origin1 은 PR07 장부가 센다. 이 프로세스가 그 장부에서 같은 host 로 세일 때만 admission 한다
          http: control?.mode === 'open' && http.success && httpOriginPolicyHash(http.data) === control.policy_hash && http.data.instanceHosts[instanceId] === host };
      }));
      if (result.reason) { validUntil = 0; failure = result.reason; return; }
      lastRenewal = sentAt; validUntil = sentAt + leaseMs; httpBound = result.http; pressure = result.pressure; failure = 'host_slot_unconfirmed';
    } catch { failure = 'host_budget_unavailable'; }
  })().finally(() => { renewing = null; });

  const admit = async (job: string): Promise<HostAdmission> => {
    if (!ready()) return deny(failure);
    if (!httpBound) return deny('host_http_unbound');
    if (pressure) return deny(pressure);
    const cap = hostTranslationCap(host, job);
    if (cap === null && emergency.mode === 'disabled') return admitted;
    if (holdMs === undefined) return deny('host_budget_unavailable');
    const token = randomUUID();
    try {
      const slot = await onPrimary(() => db.transaction(async tx => {
        // 비상 admission 이 켜졌을 때만 DR fence(readEmergencyState 의 SHARE lock)가 첫 lock 이고 그다음 host anchor 를 잠근다.
        // 꺼져 있으면 fence 를 읽지 않고 host anchor 가 첫 lock 이다(fenced DB 의 claim 은 runner 의 claim TX 가 fence 를 보고 막는다).
        const state = emergency.mode === 'enabled' ? await readEmergencyState(tx, host) : null;
        const { nowMs, ledger } = await lockedLedger(tx, host);
        if (!ledger.ok) return { reason: 'host_ledger_invalid' as const };
        const reason = hostProcessDecision(ledger.live, self, policy)
          ?? (ledger.live.some(row => row.key === self.key && row.bootId === bootId) ? null : 'host_slot_unconfirmed' as const);
        if (reason) return { reason };
        // 판정을 모두 마친 뒤에만 쓴다 — 하나라도 미루면 아무 slot 도 남기지 않는다
        const rows: { key: string; value: HostTranslationRow | HostEmergencyRow }[] = [];
        if (state && emergency.mode === 'enabled') {
          const emergencySlots = ledger.live.filter(row => row.type === 'emergency');
          const processes = ledger.live.filter((row): row is HostProcessRow & { key: string } => row.type === 'process');
          const decision = emergencyJobDecision({ mode: state.mode, job, rows: await readEmergencyJobs(tx, state.heldRoles, job),
            slots: emergencySlots.map(row => row.job), config: emergency, embedding: embeddingReadiness(env).mode,
            hostPressure: hostPressureDecision(processes, nowMs, enforcement.pressure), nowMs });
          if (decision.active && !decision.decision.admitted) return { reason: `emergency_${decision.decision.reason}` as EmergencyAdmissionDeferReason };
          if (decision.active && decision.slot) {
            const held = new Set(emergencySlots.map(row => row.key));
            const key = Array.from({ length: emergency.budget.jobs }, (_, index) => `${prefix}:e:${index + 1}`).find(candidate => !held.has(candidate));
            if (!key) return { reason: 'emergency_budget_jobs' as const };
            rows.push({ key, value: { type: 'emergency', bootId, shape: self.shape, token, job, owner, holdMs, leaseUntilMs: nowMs + leaseMs + holdMs } });
          }
        }
        if (cap !== null) {
          const held = new Set(ledger.live.filter(row => row.type === 'translation').map(row => row.key));
          const key = Array.from({ length: cap }, (_, index) => `${prefix}:t:${index + 1}`).find(candidate => !held.has(candidate));
          if (!key || held.size >= cap) return { reason: 'host_translation_busy' as const };
          rows.push({ key, value: { type: 'translation', bootId, shape: self.shape, token, job, owner, holdMs, leaseUntilMs: nowMs + leaseMs + holdMs } });
        }
        for (const row of rows) await upsert(tx, row.key, row.value);
        return { reason: null, keys: rows.map(row => row.key) };
      }));
      if (slot.reason) return deny(slot.reason);
      const keys = slot.keys;
      if (!keys.length) return admitted;
      // 해제 실패는 숨기지 않고 만료까지 자리를 지킨다(보수적). 남의 slot 은 token 이 달라 지우지 않는다
      return { admitted: true, release: () => onPrimary(() => db.delete(operationsObservations)
        .where(and(inArray(operationsObservations.key, keys), sql`${operationsObservations.value}->>'token' = ${token}`))).then(() => {}, () => {}) };
    } catch { return deny('host_budget_unavailable'); }
  };

  const timer = setInterval(() => { void renew(); }, renewMs);
  timer.unref();
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await renewing;
    delay.disable();
    await onPrimary(() => db.delete(operationsObservations).where(and(like(operationsObservations.key, `${prefix}:%`),
      sql`${operationsObservations.value}->>'bootId' = ${bootId}`))).catch(() => {});
    if (current === runtime) current = undefined;
  };
  const runtime: HostBudgetRuntime = { enabled: true, settled: renew(), ready, admit, stop };
  current = runtime;
  return runtime;
}

/** 부모가 자식·틱을 시작하기 전에 장부 자리를 기다린다. 중단되면 false */
export async function waitForHostBudget(runtime: HostBudgetRuntime, signal: AbortSignal, pollMs = 1_000): Promise<boolean> {
  while (!runtime.ready()) {
    if (signal.aborted) return false;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, pollMs);
      signal.addEventListener('abort', done, { once: true });
    });
  }
  return true;
}

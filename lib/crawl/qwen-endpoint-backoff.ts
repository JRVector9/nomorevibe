import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { operationsObservations } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { writerSiteActive } from "@/lib/operations/dr/epoch";
import { qwenEndpointFailure, type QwenDirectErrorCode } from "./qwen-direct-review";

/**
 * gpu3090 Qwen(qwen-direct-review.ts)을 부르는 쪽마다 따로 쓰는 물러나기와, 감사가 아닌 쪽이 나눠 쓰는 두 번째 자리 — 이 프로세스의 것이다.
 *
 * 부르는 쪽은 넷이다(QwenCaller) — 2026-10-31(PR 3a-C) 부터 각자 자기 잡·자기 줄이다. 감사 Qwen 직접 심사(jobs/audit-qwen.ts, 0112, "audit"),
 * 감사 두 번째 의견과 공개분 2차 거르기(audit-second-opinion-auto.ts — audit-second-opinion 잡, "second_opinion"), 2차 갈림 판가름
 * (gate-split-tiebreak.ts — split-tiebreak 잡, "split_tiebreak"), 보류 Qwen-v2 재심사(held-qwen-retry.ts — held-qwen-retry 잡, "held_qwen").
 * 화면 판별(screen-review/job.ts)은 자기 물러나기(screenBackoff)만 본다. 모두 reviewer 역할이라 역할 lease 로 한 프로세스만 돌고, 이 상태도 그 프로세스가 센다.
 * 워커가 다시 뜨거나 다른 워커로 넘어가면 한 번 더 물어보고 다시 센다.
 *
 * 2026-10-31(PR 3a-B) 소유자 결정 "하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다": 예전에는 누가 탈을 만나든 다섯 호출자가 같은 시각까지
 * 함께 물러났다 — 감사 자리 하나의 5xx 가 갈림 판가름·보류 재심사·화면 판별까지 1~15분 세웠다. 이제 물러나기·붐빔 연속은 **호출자마다** 따로다:
 * 탈을 만난 호출자만 물러나고 다른 호출자는 각자 묻고 각자 판단한다. 서버가 정말 내려갔으면 호출자마다 한 번씩(최대 넷) 더 묻고 각자 물러난다.
 * 장비 행(model_capacity_devices)에 backoff_until 로 옮기는 일은 PR 2a 의 장비 신호와 겹쳐 뒤로 미뤘다 — 지금은 호출자(route) 단위다.
 *
 * 물러나기 — 그 호출자가 부르다 서버 탈이 나면 같은 호출자는 그 시각까지 부르지 않는다: 1분에서 두 배씩 15분까지. 답을 받으면 처음부터.
 * 무엇이 서버 탈인가(noteQwenCallFailure, 2026-10-21 실측 뒤 사용자 결정):
 *  - 닿지 않음·5xx·401/403/404(·설정 오류): 한 번이면 바로 탈이다.
 *  - 제한 시간(제한 시간을 다 쓴 진짜 시간 초과)·429: 붐빔일 수 있다 — 그 호출자의 호출을 통틀어 성공 없이 QWEN_SOFT_FAILURE_STREAK(3)번
 *    잇달아 날 때만 탈이다. 한 번의 시간 초과로 감사가 물러나 틱이 실패하던 것(4자리 동시 호출이면 한 건 12초, 최대 20초 근처)을 막는다.
 *    성공(이나 서버가 답한 항목 탓 실패)이 끼면 처음부터 센다. 남은 예산 때문에 줄인 제한 시간에 걸린 것은 여기 오지 않는다(부르는 쪽이 버린다).
 *
 * 동시 호출의 끝 — 감사 Qwen 직접 심사는 자리 AUDIT_QWEN_CONCURRENCY(기본 2·최대 4)를 쓰고, 나머지 셋은 이 프로세스에 하나뿐인
 * 두 번째 자리(withQwenSecondarySlot)를 나눠 한 번에 한 호출만 띄운다. 감사·2차·사람 검토 잡이 같은 프로세스에서 겹쳐 돌아도(배경 consumer 줄)
 * gpu3090 에 동시에 떠 있는 호출은 감사 자리 + 1 — 기본 3, 최대 5 — 을 넘지 않는다. 자리는 동시성의 상한일 뿐 실패를 퍼뜨리지 않는다.
 *
 * 막는 것은 이 프로세스 안의 값이다(워커가 다시 뜨면 한 번 더 물어보고 다시 센다). 바뀔 때마다 운영 관측(operations_observations
 * qwen-endpoint)에도 적어 웹 화면(다른 프로세스)이 지금 물러나는 중인지 보인다 — 맨 위 값은 가장 늦게까지 물러나는 호출자의 것이고,
 * `callers` 에 호출자마다의 값이 있다.
 */
export const QWEN_CALLERS = ["audit", "second_opinion", "split_tiebreak", "held_qwen"] as const;
export type QwenCaller = typeof QWEN_CALLERS[number];

export type QwenEndpointBackoffState = { failures: number; retryAt: number; lastError: QwenDirectErrorCode | null; failedAt: number };
export type QwenSoftFailureState = { streak: number; lastCode: QwenDirectErrorCode | null };

const emptyBackoff = (): QwenEndpointBackoffState => ({ failures: 0, retryAt: 0, lastError: null, failedAt: 0 });
const emptySoft = (): QwenSoftFailureState => ({ streak: 0, lastCode: null });
const backoffs: Record<QwenCaller, QwenEndpointBackoffState> =
  Object.fromEntries(QWEN_CALLERS.map(caller => [caller, emptyBackoff()])) as Record<QwenCaller, QwenEndpointBackoffState>;
const softs: Record<QwenCaller, QwenSoftFailureState> =
  Object.fromEntries(QWEN_CALLERS.map(caller => [caller, emptySoft()])) as Record<QwenCaller, QwenSoftFailureState>;

function assertCaller(caller: QwenCaller): void {
  if (!Object.hasOwn(backoffs, caller)) throw new Error(`qwen_caller_unknown:${String(caller)}`);
}

/** 그 호출자의 물러나기 — 살아 있는 값이다(시험이 바로 읽고 고친다) */
export function qwenEndpointBackoffOf(caller: QwenCaller): QwenEndpointBackoffState {
  assertCaller(caller);
  return backoffs[caller];
}

/** 그 호출자의 붐빔 연속 — 살아 있는 값이다 */
export function qwenSoftFailuresOf(caller: QwenCaller): QwenSoftFailureState {
  assertCaller(caller);
  return softs[caller];
}

const QWEN_BACKOFF_BASE_MS = 60_000;
const QWEN_BACKOFF_MAX_MS = 15 * 60_000;

/** 연달아 탈 난 횟수에 따른 물러나기 — 1분에서 두 배씩, 15분까지 */
export function qwenBackoffMs(failures: number): number {
  return Math.min(QWEN_BACKOFF_MAX_MS, QWEN_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/** 붐빔(진짜 시간 초과·429)이 탈이 되는 연속 횟수 — 그 호출자의 호출을 통틀어, 사이에 성공이 없을 때 */
export const QWEN_SOFT_FAILURE_STREAK = 3;

/** 모든 호출자의 물러나기를 처음으로 — 시험 */
export function resetQwenAuditBackoff(): void {
  for (const caller of QWEN_CALLERS) {
    Object.assign(backoffs[caller], emptyBackoff());
    Object.assign(softs[caller], emptySoft());
  }
}

/** 붐빔일 수 있는 탈 — 한 번으로는 서버 탈로 보지 않는다 */
export function qwenSoftFailure(code: QwenDirectErrorCode): boolean {
  return code === "qwen_timeout" || code === "qwen_http_429";
}

/** 그 호출자에게 서버가 답했다(성공이든 항목 탓 실패든) — 붐빔 연속을 처음부터 센다 */
export function noteQwenAnswered(caller: QwenCaller): void {
  Object.assign(qwenSoftFailuresOf(caller), emptySoft());
}

export const QWEN_ENDPOINT_OBSERVATION = "qwen-endpoint";
export type QwenEndpointCallerObservation = { failures: number; retryAt: string | null; lastError: QwenDirectErrorCode | null };
export type QwenEndpointObservation = QwenEndpointCallerObservation & { at: string; callers?: Partial<Record<QwenCaller, QwenEndpointCallerObservation>> };

const observe = (state: QwenEndpointBackoffState): QwenEndpointCallerObservation => ({ failures: state.failures,
  retryAt: state.retryAt ? new Date(state.retryAt).toISOString() : null, lastError: state.lastError });

/** 지금 값을 운영 관측에 적는다 — 맨 위는 가장 늦게까지 물러나는 호출자(없으면 마지막 탈을 적은 호출자)의 값. DR writer fence 가 첫 잠금이고,
 * 실패해도 부르는 일은 멈추지 않는다(화면에 보이는 값일 뿐이다) */
async function persist(): Promise<void> {
  const ranked = [...QWEN_CALLERS].sort((a, b) => backoffs[b].retryAt - backoffs[a].retryAt || backoffs[b].failedAt - backoffs[a].failedAt);
  const value: QwenEndpointObservation = { ...observe(backoffs[ranked[0]]), at: new Date().toISOString(),
    callers: Object.fromEntries(QWEN_CALLERS.map(caller => [caller, observe(backoffs[caller])])) };
  try {
    await db.transaction(async (tx) => {
      if (!currentReplayDb() && !await writerSiteActive(tx)) return;
      await tx.insert(operationsObservations).values({ key: QWEN_ENDPOINT_OBSERVATION, value, observedAt: new Date() })
        .onConflictDoUpdate({ target: operationsObservations.key, set: { value, observedAt: new Date() } });
    });
  } catch (error) {
    logger.warn("qwen_endpoint.persist_failed", { code: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * 그 호출자가 답을 받았다 — 서버가 멀쩡하다. 물러나던 중이었을 때만 관측을 고친다.
 * startedAt: 그 호출을 띄운 시각. 탈을 적기 전에 띄운 호출의 답은 회복의 증거가 아니다 — 그 답으로 방금 걸린 물러나기를 풀면 같은 틱의
 * 다른 자리가 곧바로 다시 부른다. 그래서 마지막 탈보다 늦게 띄운 호출의 답만 물러나기를 푼다
 */
export async function noteQwenEndpointSuccess(caller: QwenCaller, startedAt: number): Promise<void> {
  const state = qwenEndpointBackoffOf(caller);
  noteQwenAnswered(caller);
  if (!state.failures && !state.retryAt && !state.lastError) return;
  if (startedAt <= state.failedAt) return;
  Object.assign(state, emptyBackoff());
  await persist();
}

/** 탈을 그 호출자의 값에 바로 적는다(기다림 없이) — 물러나는 시간을 돌려준다. 관측에 적는 것은 부르는 쪽이 이어서 한다 */
function markQwenEndpointFailure(caller: QwenCaller, code: QwenDirectErrorCode, options: { now?: number; freshStreak?: boolean }): number {
  const state = qwenEndpointBackoffOf(caller), now = options.now ?? Date.now();
  state.failures = options.freshStreak ? 1 : state.failures + 1;
  const waitMs = qwenBackoffMs(state.failures);
  state.retryAt = now + waitMs;
  state.lastError = code;
  state.failedAt = now;
  return waitMs;
}

/**
 * 그 호출자가 부르다 탈 났다 — 그 호출자만 바로 물러난다(같은 틱의 다른 자리도 새 호출을 시작하지 않는다). 물러나는 시간을 돌려준다.
 * freshStreak: 이 틱에서 이미 답을 받았으면 연속 탈을 처음부터 센다(1분)
 */
export async function noteQwenEndpointFailure(caller: QwenCaller, code: QwenDirectErrorCode,
  options: { now?: number; freshStreak?: boolean } = {}): Promise<number> {
  const waitMs = markQwenEndpointFailure(caller, code, options);
  await persist();
  return waitMs;
}

export type QwenCallFailure = { outage: boolean; soft: boolean };

/**
 * noteQwenCallFailure 의 기다림 없는 판단 — 가름과 물러나기를 이 자리에서 바로 적고, 관측에 적는 일(persisted)만 나중에 기다린다.
 * 같은 틱의 여러 자리가 같은 순간에 실패해도 탈은 한 번만 센다(부르는 쪽이 이 결과로 바로 "이 틱은 탈"을 적는다)
 */
export function classifyQwenCallFailure(caller: QwenCaller, code: QwenDirectErrorCode, options: { now?: number; freshStreak?: boolean } = {}):
  QwenCallFailure & { persisted: Promise<void> } {
  const soft = qwenSoftFailuresOf(caller);
  if (!qwenEndpointFailure(code)) {
    if (code !== "qwen_cancelled") noteQwenAnswered(caller);
    return { outage: false, soft: false, persisted: Promise.resolve() };
  }
  const isSoft = qwenSoftFailure(code);
  if (isSoft) {
    soft.streak += 1;
    soft.lastCode = code;
    if (soft.streak < QWEN_SOFT_FAILURE_STREAK) return { outage: false, soft: isSoft, persisted: Promise.resolve() };
  }
  soft.streak = 0;
  markQwenEndpointFailure(caller, code, options);
  return { outage: true, soft: isSoft, persisted: persist() };
}

/**
 * 그 호출자의 한 호출이 실패했다 — 서버 탈이면 그 호출자를 물러나게 하고 outage 를 돌려준다. 부르는 쪽은 outage 일 때만 이 틱의 새 호출을 멈추고,
 * 아니면 그 항목만의 실패(또는 세지 않는 붐빔)로 다루고 이어 간다.
 *  - 항목 탓(형식·입력 초과·400/413/422)·멈춤: 서버는 답했다(멈춤 빼고) — 붐빔 연속을 끊는다. 탈이 아니다.
 *  - 붐빔(진짜 시간 초과·429): QWEN_SOFT_FAILURE_STREAK 번째에만 탈이다(그 사이 성공이 없을 때).
 *  - 그 밖(닿지 않음·5xx·401/403/404): 바로 탈이다.
 * 남은 예산 때문에 줄인 제한 시간에 걸린 시간 초과는 부르지 않는다 — 서버 탈도 항목 탓도 아니다(부르는 쪽이 버린다).
 */
export async function noteQwenCallFailure(caller: QwenCaller, code: QwenDirectErrorCode,
  options: { now?: number; freshStreak?: boolean } = {}): Promise<QwenCallFailure> {
  const { persisted, ...result } = classifyQwenCallFailure(caller, code, options);
  await persisted;
  return result;
}

/** 웹 화면이 보이는 물러나기 — 워커가 적은 운영 관측. 맨 위 값은 가장 늦게까지 물러나는 호출자의 것, callers 에 호출자마다의 값 */
export async function readQwenEndpointBackoff(): Promise<QwenEndpointObservation | null> {
  const [row] = await db.select({ value: operationsObservations.value }).from(operationsObservations)
    .where(eq(operationsObservations.key, QWEN_ENDPOINT_OBSERVATION));
  const value = row?.value as Partial<QwenEndpointObservation> | undefined;
  return value && typeof value === "object" ? { failures: Number(value.failures ?? 0), retryAt: value.retryAt ?? null,
    lastError: value.lastError ?? null, at: value.at ?? new Date(0).toISOString(), ...(value.callers ? { callers: value.callers } : {}) } : null;
}

/** 관측의 물러나기가 지금도 이어지는가 — 화면용 */
export function endpointBackoffActive(value: QwenEndpointObservation | null, now = Date.now()): value is QwenEndpointObservation & { retryAt: string } {
  return Boolean(value?.retryAt && Date.parse(value.retryAt) > now);
}

/** 그 호출자가 지금 물러나는 중인가 — 부르는 쪽은 새 호출 전에 자기 것만 본다 */
export function qwenEndpointBackingOff(caller: QwenCaller, now = Date.now()): boolean {
  return qwenEndpointBackoffOf(caller).retryAt > now;
}

let secondaryTail: Promise<void> = Promise.resolve();

/**
 * 감사 Qwen 직접 심사가 아닌 쪽(두 번째 의견·공개분 거르기·갈림 판가름·보류 재심사)이 나눠 쓰는 한 자리 — 앞 호출이 끝날 때까지 기다린 뒤 run 을 돌린다.
 * run 은 자리를 얻은 뒤에 남은 시간·물러나기를 다시 봐야 한다(기다리는 동안 바뀐다). 앞 호출은 한 번에 45초(두 번째 의견·공개분 거르기)를 넘지 않는다.
 * 앞 호출의 실패는 다음 호출에 아무것도 전하지 않는다 — 자리는 동시성의 상한일 뿐이다
 */
export async function withQwenSecondarySlot<T>(run: () => Promise<T>): Promise<T> {
  const previous = secondaryTail;
  let release!: () => void;
  secondaryTail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await previous;
    return await run();
  } finally {
    release();
  }
}

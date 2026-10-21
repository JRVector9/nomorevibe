import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { operationsObservations } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { writerSiteActive } from "@/lib/operations/dr/epoch";
import type { QwenDirectErrorCode } from "./qwen-direct-review";

/**
 * gpu3090 Qwen(qwen-direct-review.ts)을 부르는 모든 쪽이 함께 쓰는 물러나기와 자리 — 이 프로세스의 것이다.
 *
 * 부르는 쪽은 다섯이다. 감사 Qwen 직접 심사(jobs/product-audit.ts, 0112), 감사 두 번째 의견과 공개분 2차 거르기
 * (audit-second-opinion-auto.ts — 감사 잡 틱 안), 2차 갈림 판가름(gate-split-tiebreak.ts — 2차 잡 틱 안), 보류 Qwen-v2 재심사
 * (held-qwen-retry.ts — 사람 검토 잡 human-deepseek-review 틱 안). 모두 reviewer 역할이라
 * 역할 lease 로 한 프로세스만 돌고, 이 상태도 그 프로세스가 센다. 워커가 다시 뜨거나 다른 워커로 넘어가면 한 번 더 물어보고 다시 센다.
 * 잡 커서에 두지 않은 까닭: 감사 잡의 문맥(JobContext<null>)은 커서를 쓰지 않고, 커서는 틱이 성공해야 남는다(실패한 틱이 물러나기를 적어야 한다).
 *
 * 물러나기 — 누가 부르다 탈(qwenEndpointFailure)이 나든 같은 시각까지 모두 부르지 않는다: 1분에서 두 배씩 15분까지. 답을 받으면 처음부터.
 *
 * 동시 호출의 끝 — 감사 Qwen 직접 심사는 자리 AUDIT_QWEN_CONCURRENCY(기본 2·최대 4)를 쓰고, 나머지 넷은 이 프로세스에 하나뿐인
 * 두 번째 자리(withQwenSecondarySlot)를 나눠 한 번에 한 호출만 띄운다. 감사·2차·사람 검토 잡이 같은 프로세스에서 겹쳐 돌아도(배경 consumer 줄)
 * gpu3090 에 동시에 떠 있는 호출은 감사 자리 + 1 — 기본 3, 최대 5 — 을 넘지 않는다.
 *
 * 막는 것은 이 프로세스 안의 값 하나다(워커가 다시 뜨면 한 번 더 물어보고 다시 센다). 바뀔 때마다 운영 관측(operations_observations
 * qwen-endpoint)에도 적어 웹 화면(다른 프로세스)이 지금 물러나는 중인지 보인다 — 보류 재심사·갈림 판가름이 각자 DB 행으로 재던 물러나기는 없앴다.
 */
export const qwenEndpointBackoff: { failures: number; retryAt: number; lastError: QwenDirectErrorCode | null; failedAt: number } =
  { failures: 0, retryAt: 0, lastError: null, failedAt: 0 };

const QWEN_BACKOFF_BASE_MS = 60_000;
const QWEN_BACKOFF_MAX_MS = 15 * 60_000;

/** 연달아 탈 난 횟수에 따른 물러나기 — 1분에서 두 배씩, 15분까지 */
export function qwenBackoffMs(failures: number): number {
  return Math.min(QWEN_BACKOFF_MAX_MS, QWEN_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/** 물러나기를 처음으로 — 답을 받았을 때와 시험 */
export function resetQwenAuditBackoff(): void {
  qwenEndpointBackoff.failures = 0;
  qwenEndpointBackoff.retryAt = 0;
  qwenEndpointBackoff.lastError = null;
  qwenEndpointBackoff.failedAt = 0;
}

export const QWEN_ENDPOINT_OBSERVATION = "qwen-endpoint";
export type QwenEndpointObservation = { failures: number; retryAt: string | null; lastError: QwenDirectErrorCode | null; at: string };

/** 지금 값을 운영 관측에 적는다 — DR writer fence 가 첫 잠금이고, 실패해도 부르는 일은 멈추지 않는다(화면에 보이는 값일 뿐이다) */
async function persist(): Promise<void> {
  const value: QwenEndpointObservation = { failures: qwenEndpointBackoff.failures,
    retryAt: qwenEndpointBackoff.retryAt ? new Date(qwenEndpointBackoff.retryAt).toISOString() : null,
    lastError: qwenEndpointBackoff.lastError, at: new Date().toISOString() };
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
 * 답을 받았다 — 서버가 멀쩡하다. 물러나던 중이었을 때만 관측을 고친다.
 * startedAt: 그 호출을 띄운 시각. 누가 탈을 적기 전에 띄운 호출의 답은 회복의 증거가 아니다 — 그 답으로 방금 걸린 물러나기를 풀면 같은 틱의
 * 다른 자리·다른 단계가 곧바로 다시 부른다. 그래서 마지막 탈보다 늦게 띄운 호출의 답만 물러나기를 푼다
 */
export async function noteQwenEndpointSuccess(startedAt: number): Promise<void> {
  if (!qwenEndpointBackoff.failures && !qwenEndpointBackoff.retryAt && !qwenEndpointBackoff.lastError) return;
  if (startedAt <= qwenEndpointBackoff.failedAt) return;
  resetQwenAuditBackoff();
  await persist();
}

/**
 * 부르는 곳이 탈 났다 — 모두가 바로 물러난다(같은 틱의 다른 자리도 새 호출을 시작하지 않는다). 물러나는 시간을 돌려준다.
 * freshStreak: 이 틱에서 이미 답을 받았으면 연속 탈을 처음부터 센다(1분)
 */
export async function noteQwenEndpointFailure(code: QwenDirectErrorCode, options: { now?: number; freshStreak?: boolean } = {}): Promise<number> {
  const now = options.now ?? Date.now();
  qwenEndpointBackoff.failures = options.freshStreak ? 1 : qwenEndpointBackoff.failures + 1;
  const waitMs = qwenBackoffMs(qwenEndpointBackoff.failures);
  qwenEndpointBackoff.retryAt = now + waitMs;
  qwenEndpointBackoff.lastError = code;
  qwenEndpointBackoff.failedAt = now;
  await persist();
  return waitMs;
}

/** 웹 화면이 보이는 물러나기 — 워커가 적은 운영 관측. 지금 물러나는 중이 아니면 retryAt 이 지났다 */
export async function readQwenEndpointBackoff(): Promise<QwenEndpointObservation | null> {
  const [row] = await db.select({ value: operationsObservations.value }).from(operationsObservations)
    .where(eq(operationsObservations.key, QWEN_ENDPOINT_OBSERVATION));
  const value = row?.value as Partial<QwenEndpointObservation> | undefined;
  return value && typeof value === "object" ? { failures: Number(value.failures ?? 0), retryAt: value.retryAt ?? null,
    lastError: value.lastError ?? null, at: value.at ?? new Date(0).toISOString() } : null;
}

/** 관측의 물러나기가 지금도 이어지는가 — 화면용 */
export function endpointBackoffActive(value: QwenEndpointObservation | null, now = Date.now()): value is QwenEndpointObservation & { retryAt: string } {
  return Boolean(value?.retryAt && Date.parse(value.retryAt) > now);
}

/** 지금 물러나는 중인가 — 부르는 쪽은 모두 새 호출 전에 본다 */
export function qwenEndpointBackingOff(now = Date.now()): boolean {
  return qwenEndpointBackoff.retryAt > now;
}

let secondaryTail: Promise<void> = Promise.resolve();

/**
 * 감사 Qwen 직접 심사가 아닌 쪽(두 번째 의견·공개분 거르기·갈림 판가름·보류 재심사)이 나눠 쓰는 한 자리 — 앞 호출이 끝날 때까지 기다린 뒤 run 을 돌린다.
 * run 은 자리를 얻은 뒤에 남은 시간·물러나기를 다시 봐야 한다(기다리는 동안 바뀐다). 앞 호출은 한 번에 20초를 넘지 않는다
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

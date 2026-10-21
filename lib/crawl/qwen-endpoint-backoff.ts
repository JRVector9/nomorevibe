import type { QwenDirectErrorCode } from "./qwen-direct-review";

/**
 * gpu3090 Qwen(qwen-direct-review.ts)을 부르는 모든 쪽이 함께 쓰는 물러나기와 자리 — 이 프로세스의 것이다.
 *
 * 부르는 쪽은 넷이다. 감사 Qwen 직접 심사(jobs/product-audit.ts, 0112), 감사 두 번째 의견과 공개분 2차 거르기
 * (audit-second-opinion-auto.ts — 감사 잡 틱 안), 2차 갈림 판가름(gate-split-tiebreak.ts — 2차 잡 틱 안). 넷 다 reviewer 역할이라
 * 역할 lease 로 한 프로세스만 돌고, 이 상태도 그 프로세스가 센다. 워커가 다시 뜨거나 다른 워커로 넘어가면 한 번 더 물어보고 다시 센다.
 * 잡 커서에 두지 않은 까닭: 감사 잡의 문맥(JobContext<null>)은 커서를 쓰지 않고, 커서는 틱이 성공해야 남는다(실패한 틱이 물러나기를 적어야 한다).
 *
 * 물러나기 — 누가 부르다 탈(qwenEndpointFailure)이 나든 같은 시각까지 모두 부르지 않는다: 1분에서 두 배씩 15분까지. 답을 받으면 처음부터.
 *
 * 동시 호출의 끝 — 감사 Qwen 직접 심사는 자리 AUDIT_QWEN_CONCURRENCY(기본 2·최대 4)를 쓰고, 나머지 셋은 이 프로세스에 하나뿐인
 * 두 번째 자리(withQwenSecondarySlot)를 나눠 한 번에 한 호출만 띄운다. 감사 잡과 2차 잡이 같은 프로세스에서 겹쳐 돌아도(배경 consumer 줄)
 * gpu3090 에 동시에 떠 있는 호출은 감사 자리 + 1 — 기본 3, 최대 5 — 을 넘지 않는다.
 */
export const qwenEndpointBackoff: { failures: number; retryAt: number; lastError: QwenDirectErrorCode | null } = { failures: 0, retryAt: 0, lastError: null };

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
}

/** 답을 받았다 — 서버가 멀쩡하다 */
export const noteQwenEndpointSuccess = resetQwenAuditBackoff;

/** 부르는 곳이 탈 났다 — 모두가 물러난다. 물러나는 시간을 돌려준다 */
export function noteQwenEndpointFailure(code: QwenDirectErrorCode, now = Date.now()): number {
  qwenEndpointBackoff.failures += 1;
  const waitMs = qwenBackoffMs(qwenEndpointBackoff.failures);
  qwenEndpointBackoff.retryAt = now + waitMs;
  qwenEndpointBackoff.lastError = code;
  return waitMs;
}

/** 지금 물러나는 중인가 — 부르는 쪽은 모두 새 호출 전에 본다 */
export function qwenEndpointBackingOff(now = Date.now()): boolean {
  return qwenEndpointBackoff.retryAt > now;
}

let secondaryTail: Promise<void> = Promise.resolve();

/**
 * 감사 Qwen 직접 심사가 아닌 쪽(두 번째 의견·공개분 거르기·갈림 판가름)이 나눠 쓰는 한 자리 — 앞 호출이 끝날 때까지 기다린 뒤 run 을 돌린다.
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

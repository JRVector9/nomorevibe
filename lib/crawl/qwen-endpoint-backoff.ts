import type { QwenDirectErrorCode } from "./qwen-direct-review";

/**
 * gpu3090 Qwen 이 연달아 탈 난 틱 수와 다시 물어볼 시각 — 이 프로세스의 것이다(0112 감사 Qwen 직접 심사, jobs/product-audit.ts 가 센다).
 * 감사는 역할 lease 로 한 워커만 돌리므로 한 프로세스가 센다. 워커가 다시 뜨거나 다른 워커로 넘어가면 한 번 더 물어보고 다시 센다.
 * 잡 커서에 두지 않은 까닭: 이 잡의 문맥(JobContext<null>)은 커서를 쓰지 않고, 커서는 틱이 성공해야 남는다(실패한 틱이 물러나기를 적어야 한다).
 * 같은 서버를 부르는 Qwen-v2 두 번째 의견 단계(audit-second-opinion-auto.ts)도 이것을 읽어, 감사가 물러나는 동안 부르지 않는다 — 감사가 먼저다.
 */
export const qwenEndpointBackoff: { failures: number; retryAt: number; lastError: QwenDirectErrorCode | null } = { failures: 0, retryAt: 0, lastError: null };

/** 물러나기를 처음으로 — 한 틱에서 답을 받았을 때와 시험 */
export function resetQwenAuditBackoff(): void {
  qwenEndpointBackoff.failures = 0;
  qwenEndpointBackoff.retryAt = 0;
  qwenEndpointBackoff.lastError = null;
}

/** 감사의 Qwen 직접 심사가 지금 물러나는 중인가 */
export function qwenEndpointBackingOff(now = Date.now()): boolean {
  return qwenEndpointBackoff.retryAt > now;
}

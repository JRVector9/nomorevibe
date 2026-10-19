/** Shared with the uptime scheduler: a result expires when it becomes due again. */
export const RECHECK_AFTER_MINUTES = 6 * 60;
/** 최근 연속 실패가 이 횟수에 이르면 자동으로 내린다(uptime-auto-ban). 보류 기록(health-record)도 이 경계를 본다 */
export const UPTIME_AUTO_BAN_THRESHOLD = 10;
export function isHealthCurrent(checkedAt: Date | null, now = new Date()): boolean {
  if (!checkedAt) return false;
  const age = now.getTime() - checkedAt.getTime();
  return Number.isFinite(age) && age >= 0 && age <= RECHECK_AFTER_MINUTES * 60_000;
}

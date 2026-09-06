/** Shared with the uptime scheduler: a result expires when it becomes due again. */
export const RECHECK_AFTER_MINUTES = 6 * 60;
export function isHealthCurrent(checkedAt: Date | null, now = new Date()): boolean {
  if (!checkedAt) return false;
  const age = now.getTime() - checkedAt.getTime();
  return Number.isFinite(age) && age >= 0 && age <= RECHECK_AFTER_MINUTES * 60_000;
}

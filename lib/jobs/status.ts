export type ObservedJob = {
  lockedAt: Date | null; notBefore: Date | null; lastRunAt: Date | null;
  lastError: string | null; requestedVersion: number; processedVersion: number;
};

export function jobStatusLabel(state: ObservedJob | undefined, now = Date.now()): string {
  if (!state) return "실행 기록 없음";
  if (state.lockedAt) return now - state.lockedAt.getTime() >= 10 * 60_000 ? "중단·회수 대기" : "실행 중";
  if (state.notBefore && state.notBefore.getTime() > now) return "재시도 대기";
  if (state.requestedVersion > state.processedVersion) return "예약됨";
  if (state.lastError) return "오류";
  return state.lastRunAt ? "유휴" : "실행 기록 없음";
}

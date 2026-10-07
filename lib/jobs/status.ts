import { STALE_LOCK_MS } from "./lease";

export type ObservedJob = {
  lockedAt: Date | null; notBefore: Date | null; lastRunAt: Date | null;
  lastError: string | null; requestedVersion: number; processedVersion: number;
};

/** 사람이 멈춘 작업 — 재시도 유예가 아니라 not_before 를 먼 미래(소개 검수는 2100-01-01)로 밀어 둔 것 */
export const PAUSED_AFTER_MS = 365 * 24 * 60 * 60_000;
export function isPausedJob(state: Pick<ObservedJob, "notBefore"> | undefined, now = Date.now()): boolean {
  return !!state?.notBefore && state.notBefore.getTime() - now > PAUSED_AFTER_MS;
}

export function jobStatusLabel(state: ObservedJob | undefined, now = Date.now()): string {
  if (!state) return "실행 기록 없음";
  if (isPausedJob(state, now)) return "멈춤(사람이 중단)";
  if (state.lockedAt) return now - state.lockedAt.getTime() > STALE_LOCK_MS ? "중단·회수 대기" : "실행 중";
  if (state.notBefore && state.notBefore.getTime() > now) return "재시도 대기";
  if (state.requestedVersion > state.processedVersion) return "예약됨";
  if (state.lastError) return "오류";
  return state.lastRunAt ? "유휴" : "실행 기록 없음";
}

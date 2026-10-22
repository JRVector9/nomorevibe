import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { PAUSED_AFTER_MS } from "@/lib/jobs/status";
import type { StatusState } from "../components/StatusDot";

/**
 * 작업 하나가 지금 제때 도는가 — 운영센터 세 곳(작업 생존 띠 JobsStrip · 작업 흐름 탭 JobTimeline · 진단 탭 작업 미니 표)과
 * 작업 상세 창이 같은 규칙으로 그린다(2026-10-22). 전에는 띠만 주기의 5배를 보고 나머지 둘은 오류만 봐서, 같은 잡이 한 탭에서는 빨강·
 * 다른 탭에서는 초록이었다.
 *
 *   사람이 멈춤(not_before 가 먼 미래)   → idle ○ "멈춤(사람이 중단)"
 *   마지막 회차 오류                      → failed ■ "실패"
 *   제 일 못 함·성공 끊김이 긴급          → failed ■ (job.health — 조치할 일과 같은 판단, lib/operations/job-health.ts)
 *   실행 기록 없음                        → idle ○ "실행 기록 없음"
 *   마지막 실행이 주기의 5배 이상 지남    → failed ■ "크게 지연"
 *   제 일 못 함·성공 끊김이 보류          → delayed ▲ — 방금 돌았어도(돈 시각만 보면 실패를 삼킨 잡이 초록이었다)
 *   마지막 실행이 주기의 2배 이상 지남    → delayed ▲ "지연"
 *   그 밖(주기가 없는 잡 포함)            → ok ● "정상"
 *
 * 경보(조치할 일)를 띄울지는 여기서 정하지 않는다 — 이것은 잡마다의 표시 규칙이다.
 */
export const JOB_LATE_FACTOR = 2;
export const JOB_STALLED_FACTOR = 5;

export type JobLateness = {
  /** 까닭 — 멈춤·오류·기록 없음·크게 지연·지연·정상 */
  kind: "paused" | "error" | "degraded" | "never" | "stalled" | "late" | "ok";
  state: StatusState;
  /** 사람이 읽는 상태 — 점 옆·배지·상세 창에 쓴다 */
  text: string;
  /** 마지막 실행 뒤 지난 시간 ÷ 주기. 주기가 없거나(요청될 때만) 실행 기록이 없으면 null */
  ratio: number | null;
  /** 카탈로그 주기(ms). 요청될 때만 도는 잡은 null */
  intervalMs: number | null;
};

type JobTimes = { name: string; lastRunAt: string | Date | null; lastError: string | null; notBefore: string | Date | null;
  health?: { level: "hold" | "critical"; text: string } | null };

const ms = (value: string | Date) => typeof value === "string" ? Date.parse(value) : value.getTime();

export function jobLateness(job: JobTimes, now: string | Date): JobLateness {
  const intervalMs = JOB_CATALOG.find((entry) => entry.name === job.name)?.intervalMs ?? null;
  const at = ms(now);
  const lastRun = job.lastRunAt ? ms(job.lastRunAt) : null;
  const ratio = intervalMs && lastRun !== null && Number.isFinite(lastRun) ? Math.max(0, at - lastRun) / intervalMs : null;
  const base = { ratio, intervalMs };
  if (job.notBefore && ms(job.notBefore) - at > PAUSED_AFTER_MS) return { ...base, kind: "paused", state: "idle", text: "멈춤(사람이 중단)" };
  if (job.lastError) return { ...base, kind: "error", state: "failed", text: "실패" };
  if (job.health?.level === "critical") return { ...base, kind: "degraded", state: "failed", text: job.health.text };
  if (lastRun === null) return { ...base, kind: "never", state: "idle", text: "실행 기록 없음" };
  if (ratio !== null && ratio >= JOB_STALLED_FACTOR) return { ...base, kind: "stalled", state: "failed", text: `크게 지연 · 주기의 ${Math.floor(ratio)}배` };
  if (job.health) return { ...base, kind: "degraded", state: "delayed", text: job.health.text };
  if (ratio !== null && ratio >= JOB_LATE_FACTOR) return { ...base, kind: "late", state: "delayed", text: `지연 · 주기의 ${Math.floor(ratio)}배` };
  return { ...base, kind: "ok", state: "ok", text: "정상" };
}

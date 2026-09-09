/** Metadata only: importing this from the web must not load executable collectors. */
export type JobRole = "crawler" | "reviewer" | "publisher" | "maintenance";
export const JOB_ROLES: readonly JobRole[] = ["crawler", "reviewer", "publisher", "maintenance"];

export const JOB_CATALOG: readonly { name: string; role: JobRole | "scheduler"; intervalMs: number | null }[] = [
  { name: "heartbeat", role: "scheduler", intervalMs: null },
  /**
   * 검색 쿼터는 토큰 단위(30회/분 = 시간당 1,800페이지)라 워커를 늘려도 늘지 않는다.
   * 병목은 이 주기였다 — 15분 × 10페이지면 시간당 40페이지로 허용량의 2.2%만 썼다.
   * 3분으로 당기면 시간당 200페이지(11%)다. 밀리면 SEED_BACKLOG_PAUSE가 알아서 멈춘다.
   */
  { name: "crawl-seed", role: "crawler", intervalMs: 3 * 60_000 },
  // 하루 약 123건이 올라온다. 30분이면 한 번에 100건 상한에 걸릴 일이 없다.
  { name: "hn-show-seed", role: "crawler", intervalMs: 30 * 60_000 },
  { name: "crawl-fetch", role: "crawler", intervalMs: 60_000 },
  { name: "crawl-judge", role: "reviewer", intervalMs: 5 * 60_000 },
  { name: "crawl-agent-review", role: "reviewer", intervalMs: 60_000 },
  { name: "crawl-publish", role: "publisher", intervalMs: 5 * 60_000 },
  { name: "uptime-ping", role: "crawler", intervalMs: 10 * 60_000 },
  { name: "click-rollup", role: "maintenance", intervalMs: 60 * 60_000 },
  // The rollup completion transaction requests ranking; there is no independent schedule.
  { name: "ranking-refresh", role: "maintenance", intervalMs: null },
  { name: "product-evidence-refresh", role: "crawler", intervalMs: 60_000 },
  { name: "agent-evidence-refresh", role: "crawler", intervalMs: 60_000 },
];

export const JOB_NAMES = JOB_CATALOG.map(job => job.name);
export function isJobName(name: string): boolean { return JOB_NAMES.includes(name); }
export function jobsForRole(role: JobRole): string[] {
  return JOB_CATALOG.filter(job => job.role === role).map(job => job.name);
}

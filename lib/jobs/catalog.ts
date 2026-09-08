/** Metadata only: importing this from the web must not load executable collectors. */
export type JobRole = "crawler" | "reviewer" | "publisher" | "maintenance";
export const JOB_ROLES: readonly JobRole[] = ["crawler", "reviewer", "publisher", "maintenance"];

export const JOB_CATALOG: readonly { name: string; role: JobRole | "scheduler"; intervalMs: number | null }[] = [
  { name: "heartbeat", role: "scheduler", intervalMs: null },
  { name: "crawl-seed", role: "crawler", intervalMs: 15 * 60_000 },
  { name: "crawl-fetch", role: "crawler", intervalMs: 60_000 },
  { name: "crawl-judge", role: "reviewer", intervalMs: 5 * 60_000 },
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

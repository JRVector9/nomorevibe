import { batchJobsForRole } from "@/lib/jobs/batches";

/** 분리 역할 — 기존 역할의 잡을 떼어 batch versioned 에서만 따로 돈다(lib/jobs/batches.ts SPLIT_JOBS) */
export const SPLIT_SERVICE_ROLES = ["translation", "product-health", "site-evidence", "official-news"] as const;
export type SplitServiceRole = (typeof SPLIT_SERVICE_ROLES)[number];
export type SplitServiceRoleRow = { role: SplitServiceRole; jobs: string[]; alarms: boolean };

const RECENT_MS = 3_600_000;

/**
 * 운영센터 서비스 관측 표에 더할 분리 역할 행. versioned 이면 넷 다, 아니면 최근 1시간 안에 그 역할의 후보(candidate:)나
 * 서비스(service:) 관측이 있는 역할만 보인다. 경보(관측 없음·지연)는 versioned 에서만 — 기존 방식(legacy·draining)에서는
 * 이 역할들이 일하지 않으므로 관측이 없어도 대기다.
 */
export function splitServiceRoleRows(input: {
  batchMode: string;
  observations: ReadonlyArray<{ key: string; observedAt: unknown }>;
  now: number;
}): SplitServiceRoleRow[] {
  const versioned = input.batchMode === "versioned";
  const recent = (role: SplitServiceRole) => input.observations.some((row) => {
    if (!row.key.startsWith(`candidate:${role}:`) && !row.key.startsWith(`service:${role}:`)) return false;
    const at = row.observedAt instanceof Date ? row.observedAt.getTime() : new Date(row.observedAt as string).getTime();
    return Number.isFinite(at) && input.now - at <= RECENT_MS;
  });
  return SPLIT_SERVICE_ROLES.filter((role) => versioned || recent(role))
    .map((role) => ({ role, jobs: batchJobsForRole(role, "versioned"), alarms: versioned }));
}

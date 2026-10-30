import { z } from "zod";
import { firstReviewerKey } from "./first-reviewers";

const label = z.string().min(1).max(200);
const limits = z.record(z.string(), z.number().int().positive());
const policySchema = z.object({ groupLimits: limits, providerLimits: limits,
  routes: z.array(z.object({ provider: label, model: label, groupId: label, providerBudgetId: label }).loose()).max(128) }).loose();
export type CapacityUnknownOccupancy = { groupId: string; providerBudgetId: string };

/**
 * Routes whose physical group or provider budget is completely filled by the given occupancy rows.
 * Pure computation kept for its unit tests; since 2026-10-30 no reader feeds it `indeterminate` rows
 * (they occupy nothing), so readBlockedFirstReviewerKeys below is always empty.
 */
export function blockedFirstReviewerKeys(policy: unknown, unknown: readonly CapacityUnknownOccupancy[]): Set<string> {
  const parsed = policySchema.safeParse(policy);
  const blocked = new Set<string>();
  if (!parsed.success || !unknown.length) return blocked;
  const count = (pick: (row: CapacityUnknownOccupancy) => string, id: string) => unknown.filter(row => pick(row) === id).length;
  for (const route of parsed.data.routes) {
    const group = parsed.data.groupLimits[route.groupId], budget = parsed.data.providerLimits[route.providerBudgetId];
    if (group !== undefined && count(row => row.groupId, route.groupId) >= group
      || budget !== undefined && count(row => row.providerBudgetId, route.providerBudgetId) >= budget)
      blocked.add(firstReviewerKey(route));
  }
  return blocked;
}

/**
 * 2026-10-30 소유자 결정 뒤 읽기 힌트는 항상 비어 있다: 미확인(indeterminate) 행은 그룹·예산을 채우지 않으므로 어떤 경로도 그것 때문에
 * 접수를 못 하지 않는다. 순수 함수 blockedFirstReviewerKeys 는 점유 목록을 받는 계산으로 남긴다(DB 를 읽지 않는다).
 */
export async function readBlockedFirstReviewerKeys(): Promise<Set<string>> {
  return new Set();
}

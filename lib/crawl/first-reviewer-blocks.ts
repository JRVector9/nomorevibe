import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { firstReviewerKey } from "./first-reviewers";

const label = z.string().min(1).max(200);
const limits = z.record(z.string(), z.number().int().positive());
const policySchema = z.object({ groupLimits: limits, providerLimits: limits,
  routes: z.array(z.object({ provider: label, model: label, groupId: label, providerBudgetId: label }).loose()).max(128) }).loose();
const unknownSchema = z.array(z.object({ groupId: label, providerBudgetId: label }).strict()).max(256);
export type CapacityUnknownOccupancy = z.infer<typeof unknownSchema>[number];

/**
 * Routes whose physical group or provider budget is completely filled by `indeterminate` rows.
 * Such a route cannot admit anything until an evidenced release, so untouched AI1 candidates
 * may go to another pool model. This reads occupancy only and never releases or rewrites it.
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

/** Read-only hint for reviewer selection. Any read failure keeps the original fixed assignment. */
export async function readBlockedFirstReviewerKeys(): Promise<Set<string>> {
  if (currentReplayDb()) return new Set();
  try {
    return await onPrimary(async () => {
      const [row] = await db.execute<{ policy: unknown; unknown: unknown }>(sql`
        SELECT c.policy, (SELECT coalesce(jsonb_agg(jsonb_build_object('groupId', r.group_id, 'providerBudgetId', r.provider_budget_id)), '[]'::jsonb)
          FROM (SELECT group_id, provider_budget_id FROM model_capacity_requests WHERE state = 'indeterminate'
            ORDER BY queue_ordinal LIMIT 256) r) AS unknown
        FROM model_capacity_control c WHERE c.id = 1 AND c.mode = 'open'`);
      const unknown = unknownSchema.safeParse(row?.unknown);
      return row && unknown.success ? blockedFirstReviewerKeys(row.policy, unknown.data) : new Set<string>();
    });
  } catch { return new Set(); }
}

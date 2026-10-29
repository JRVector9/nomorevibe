import { z } from "zod";
import { modelCapacityPolicyHash, modelCapacityPolicySchema } from "@/lib/llm/capacity";
import { modelIdentityKey } from "./admin-models-view";
export { modelIdentityKey, elapsedModelTime } from "./admin-models-view";

export const adminModelIdentitySchema = z.object({ routeId: z.string().min(1).max(120), provider: z.string().min(1).max(60), model: z.string().min(1).max(200) }).strict();
export type AdminModelIdentity = z.infer<typeof adminModelIdentitySchema>;
const count = z.number().int().nonnegative().safe();
const time = z.iso.datetime({ offset: true });
export const adminModelMetricsSchema = adminModelIdentitySchema.extend({ groupId: z.string(), providerBudgetId: z.string(),
  succeeded1h: count, failed1h: count, withdrawn1h: count, unclassified1h: count,
  waiting: count, reserved: count, dispatched: count, indeterminate: count, lastSuccessAt: time.nullable() });
export const adminModelRequestSchema = adminModelIdentitySchema.extend({ requestId: z.uuid(), groupId: z.string(),
  providerBudgetId: z.string(), state: z.enum(["waiting", "reserved", "dispatched", "indeterminate"]),
  queuedAt: time, stateSince: time, dispatchedAt: time.nullable(), reservedUntil: time.nullable(),
  ownerInstanceId: z.string(), localEndRecorded: z.boolean() });
export type AdminModelRequest = z.infer<typeof adminModelRequestSchema>;
export type AdminModelMetrics = z.infer<typeof adminModelMetricsSchema>;
export type AdminModelsObservation = {
  observedAt: string | null; error: string | null; mode: "open" | "draining" | "disabled" | null;
  epoch: number | null; revision: number | null; policyHash: string | null; controlUpdatedAt: string | null;
  policyVerified: boolean; globalLimit: number | null; rows: AdminModelMetrics[];
  groups: { groupId: string; held: number; limit: number | null }[];
  requests: AdminModelRequest[]; truncated: boolean;
};
export function unavailableAdminModels(): AdminModelsObservation {
  return { observedAt: null, error: "운영 DB 실측을 읽지 못했습니다. 0건으로 간주하지 않습니다.", mode: null,
    epoch: null, revision: null, policyHash: null, controlUpdatedAt: null, policyVerified: false, globalLimit: null,
    rows: [], groups: [], requests: [], truncated: false };
}
export function buildAdminModelsObservation(raw: {
  observedAt: string; control: { mode: "open" | "draining" | "disabled"; epoch: number; revision: number;
    policy: unknown; policyHash: string | null; updatedAt: string }; metrics: unknown[]; requests: unknown[];
}): AdminModelsObservation {
  const observedAt = time.parse(raw.observedAt), rows = raw.metrics.map(row => adminModelMetricsSchema.parse(row));
  const requests = raw.requests.slice(0, 100).map(row => adminModelRequestSchema.parse(row));
  const parsed = modelCapacityPolicySchema.safeParse(raw.control.policy);
  const verified = parsed.success && modelCapacityPolicyHash(parsed.data) === raw.control.policyHash;
  const groups = new Map<string, { groupId: string; held: number; limit: number | null }>();
  if (verified) for (const [groupId, limit] of Object.entries(parsed.data.groupLimits)) groups.set(groupId, { groupId, limit, held: 0 });
  for (const row of rows) {
    const group = groups.get(row.groupId) ?? { groupId: row.groupId, limit: null, held: 0 };
    group.held += row.reserved + row.dispatched + row.indeterminate;
    groups.set(row.groupId, group);
  }
  // Include configured routes even when they have never emitted a ledger event.
  if (verified) for (const route of parsed.data.routes) {
    if (!rows.some(row => modelIdentityKey(row) === modelIdentityKey(route) && row.groupId === route.groupId && row.providerBudgetId === route.providerBudgetId))
      rows.push({ ...route, succeeded1h: 0, failed1h: 0, withdrawn1h: 0, unclassified1h: 0,
        waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, lastSuccessAt: null });
  }
  return { observedAt, error: null, mode: raw.control.mode, epoch: raw.control.epoch, revision: raw.control.revision,
    policyHash: raw.control.policyHash, controlUpdatedAt: time.parse(raw.control.updatedAt), policyVerified: verified,
    globalLimit: verified ? parsed.data.globalLimit : null, rows, groups: [...groups.values()], requests,
    truncated: raw.requests.length > 100 };
}


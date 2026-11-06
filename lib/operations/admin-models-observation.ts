import { z } from "zod";
import type { ModelThroughput } from "./admin-models-throughput";
import { modelCapacityPolicyHash, modelCapacityPolicySchema } from "@/lib/llm/capacity";
import { deviceFallbackLimit, type ModelCapacityDeviceState } from "@/lib/llm/capacity-devices";
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
  policyVerified: boolean; rows: AdminModelMetrics[];
  /** Current verified policy bindings; historical ledger groups are not configured capacity. */
  configuredRoutes?: Pick<AdminModelMetrics, "routeId" | "provider" | "model" | "groupId" | "providerBudgetId">[];
  /**
   * 장비(groupId)별 점유와 한도. 한도는 실시간 장비 상태(`model_capacity_devices`, 없으면 정책 groupLimits 대체)에서 온다 — 전역·풀 한도는 없다(PR 1b).
   * lending: 우선 역할이 유휴라서 낮은 순위가 평소 상한을 넘겨 쓰고 있다. source 가 null 이면 장비 상태를 읽지 못했다(한도는 정책 대체만).
   */
  groups: { groupId: string; held: number; limit: number | null; lending: boolean; source: "table" | "policy_fallback" | null }[];
  /** 실시간 장비 상태 그대로(관리자 장비 화면과 같은 읽기). 읽지 못했으면 빈 배열이고 devicesRead 가 false 다. */
  devices: ModelCapacityDeviceState[]; devicesRead: boolean;
  requests: AdminModelRequest[]; truncated: boolean; throughput?: ModelThroughput;
};
export function unavailableAdminModels(): AdminModelsObservation {
  return { observedAt: null, error: "운영 DB 실측을 읽지 못했습니다. 0건으로 간주하지 않습니다.", mode: null,
    epoch: null, revision: null, policyHash: null, controlUpdatedAt: null, policyVerified: false,
    rows: [], configuredRoutes: [], groups: [], devices: [], devicesRead: false, requests: [], truncated: false };
}
export function buildAdminModelsObservation(raw: {
  observedAt: string; control: { mode: "open" | "draining" | "disabled"; epoch: number; revision: number;
    policy: unknown; policyHash: string | null; updatedAt: string }; metrics: unknown[]; requests: unknown[];
  /** readModelCapacityDeviceStates 의 결과. undefined = 읽지 않음(정책 groupLimits 대체만), null = 읽기 실패. */
  devices?: readonly ModelCapacityDeviceState[] | null;
}): AdminModelsObservation {
  const observedAt = time.parse(raw.observedAt), rows = raw.metrics.map(row => adminModelMetricsSchema.parse(row));
  const requests = raw.requests.slice(0, 100).map(row => adminModelRequestSchema.parse(row));
  const parsed = modelCapacityPolicySchema.safeParse(raw.control.policy);
  const verified = parsed.success && modelCapacityPolicyHash(parsed.data) === raw.control.policyHash;
  const devices = raw.devices ? [...raw.devices] : [];
  type Group = AdminModelsObservation["groups"][number];
  const groups = new Map<string, Group>();
  const fallback = (groupId: string): Group => ({ groupId, held: 0, lending: false, source: null,
    limit: verified && raw.devices !== null ? deviceFallbackLimit(parsed.data.groupLimits, groupId) : null });
  for (const state of devices) groups.set(state.deviceId, { groupId: state.deviceId, held: 0, limit: state.limitSlots, lending: state.lending, source: state.source });
  if (verified && raw.devices === undefined) for (const groupId of Object.keys(parsed.data.groupLimits ?? {})) groups.set(groupId, fallback(groupId));
  if (verified) for (const route of parsed.data.routes) if (!groups.has(route.groupId)) groups.set(route.groupId, fallback(route.groupId));
  for (const row of rows) {
    const group = groups.get(row.groupId) ?? fallback(row.groupId);
    // 미확인(indeterminate)은 점유가 아니다(2026-10-30) — 카드의 '확인 못함' 항목으로만 보인다.
    group.held += row.reserved + row.dispatched;
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
    rows, configuredRoutes: verified ? parsed.data.routes.map(({ routeId, provider, model, groupId, providerBudgetId }) =>
      ({ routeId, provider, model, groupId, providerBudgetId })) : [],
    groups: [...groups.values()].sort((a, b) => a.groupId.localeCompare(b.groupId)), devices, devicesRead: Array.isArray(raw.devices), requests,
    truncated: raw.requests.length > 100 };
}

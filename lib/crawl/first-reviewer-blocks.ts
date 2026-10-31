import { z } from "zod";
import { deviceFallbackLimit } from "@/lib/llm/capacity-devices";
import { firstReviewerKey } from "./first-reviewers";

const label = z.string().min(1).max(200);
const limits = z.record(z.string(), z.number().int().positive());
/** 정책은 route 의 장비(groupId) 매핑과, 장비 행이 없을 때의 대체 한도(groupLimits, 선택)만 준다. 공급자 예산은 한도가 아니다(PR 1b). */
const policySchema = z.object({ groupLimits: limits.optional(),
  routes: z.array(z.object({ provider: label, model: label, groupId: label, providerBudgetId: label }).loose()).max(128) }).loose();
export type CapacityUnknownOccupancy = { groupId: string; providerBudgetId?: string };

/**
 * Routes whose device (groupId) is completely filled by the given occupancy rows. The limit per device is the live
 * `model_capacity_devices` row (`deviceLimits`, from `readModelCapacityDeviceStates`) and, for a device without a row, the policy's
 * `groupLimits` fallback; a device with neither limit is never reported (admission defers it as device_unconfigured instead).
 * Pure computation kept for its unit tests; since 2026-10-30 no reader feeds it `indeterminate` rows
 * (they occupy nothing), so readBlockedFirstReviewerKeys below is always empty.
 */
export function blockedFirstReviewerKeys(policy: unknown, occupancy: readonly CapacityUnknownOccupancy[],
  deviceLimits: Readonly<Record<string, number>> | null = null): Set<string> {
  const parsed = policySchema.safeParse(policy);
  const blocked = new Set<string>();
  if (!parsed.success || !occupancy.length) return blocked;
  const held = (deviceId: string) => occupancy.filter(row => row.groupId === deviceId).length;
  for (const route of parsed.data.routes) {
    const limit = deviceLimits && Object.hasOwn(deviceLimits, route.groupId) ? deviceLimits[route.groupId]
      : deviceFallbackLimit(parsed.data.groupLimits, route.groupId);
    if (limit !== null && held(route.groupId) >= limit) blocked.add(firstReviewerKey(route));
  }
  return blocked;
}

/**
 * 2026-10-30 소유자 결정 뒤 읽기 힌트는 항상 비어 있다: 미확인(indeterminate) 행은 장비를 채우지 않으므로 어떤 경로도 그것 때문에
 * 접수를 못 하지 않는다. 순수 함수 blockedFirstReviewerKeys 는 점유 목록과 장비 한도를 받는 계산으로 남긴다(DB 를 읽지 않는다).
 */
export async function readBlockedFirstReviewerKeys(): Promise<Set<string>> {
  return new Set();
}

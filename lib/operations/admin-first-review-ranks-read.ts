import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { modelCapacityDevices } from "@/lib/db/schema";
import { readModelCapacityControlObservation } from "@/lib/llm/capacity-repository";
import { ensureServingContracts, servingContractSnapshot } from "@/lib/llm/serving-contract-store";
import type { PolicyRoute, rankReadiness } from "./admin-first-review-ranks";

/** rankReadiness 의 입력을 읽는다(읽기 전용). 실패하면 capacity 는 null — 경고로 남는다. */
export async function readRankReadinessInput(): Promise<Parameters<typeof rankReadiness>[2]> {
  await ensureServingContracts(0);
  const contracts = servingContractSnapshot().rows;
  try {
    const control = await readModelCapacityControlObservation();
    const policy = control.policy as { routes?: unknown; groupLimits?: unknown } | null;
    const routes = Array.isArray(policy?.routes) ? policy.routes.filter((route): route is PolicyRoute => !!route && typeof route === "object"
      && typeof (route as PolicyRoute).routeId === "string" && typeof (route as PolicyRoute).provider === "string" && typeof (route as PolicyRoute).model === "string") : [];
    const groups = [...new Set(routes.map(route => route.groupId).filter((id): id is string => typeof id === "string"))];
    const devices = groups.length ? await db.select({ deviceId: modelCapacityDevices.deviceId, enabled: modelCapacityDevices.enabled })
      .from(modelCapacityDevices).where(inArray(modelCapacityDevices.deviceId, groups)) : [];
    return { contracts, capacity: { mode: control.mode, routes, devices: new Map(devices.map(row => [row.deviceId, row.enabled])),
      groupLimits: policy?.groupLimits && typeof policy.groupLimits === "object" ? policy.groupLimits as Record<string, unknown> : {} } };
  } catch { return { contracts, capacity: null }; }
}

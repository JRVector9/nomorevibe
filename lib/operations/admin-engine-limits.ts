import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { modelCapacityPolicyHash, modelCapacityPolicySchema } from "@/lib/llm/capacity";
import { logger } from "@/lib/observability/logger";
import { z } from "zod";
import { deviceFallbackLimit, deviceSettingsFromPolicyFallback } from "@/lib/llm/capacity-devices";
import { readModelCapacityDevice, saveModelCapacityDevice } from "@/lib/llm/capacity-devices-repository";
import { DrWriterFencedError, writerSiteActive } from "./dr/epoch";
import { capacityDeviceIssueMessage, type SaveCapacityDeviceResult } from "./admin-capacity-devices";
import type { AiConnectionView } from "./admin-ai-tasks";

/** Display metadata only. A policy group is the existing shared admission boundary, never a per-stage allowance. */
export type EngineLimitIdentity = Readonly<{
  deviceId: string;
  connections: readonly Pick<AiConnectionView, "id" | "label" | "kind" | "cliTool" | "baseUrl" | "deviceId" | "models">[];
  models: readonly string[];
  routes: readonly string[];
}>;
export type EngineLimitMetadata = Readonly<{
  policyHash: string | null; engines: readonly EngineLimitIdentity[]; error: string | null;
}>;

/** Read only whitelisted connection columns: no credentials, probes, model calls or rank mutation. */
export async function readEngineLimitMetadata(): Promise<EngineLimitMetadata> {
  try {
    return await onPrimary(() => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      const [control] = await tx.execute<{ policy: unknown; policy_hash: string | null }>(sql`
        SELECT policy, policy_hash FROM model_capacity_control WHERE id=1`);
      const parsed = modelCapacityPolicySchema.safeParse(control?.policy);
      if (!parsed.success || !control?.policy_hash || modelCapacityPolicyHash(parsed.data) !== control.policy_hash)
        return { policyHash: null, engines: [], error: "engine_limit_policy_unavailable" };
      const rows = await tx.execute<{ id: string; label: string; kind: "api" | "cli"; cli_tool: AiConnectionView["cliTool"];
        base_url: string | null; device_id: string; models: AiConnectionView["models"] }>(sql`
        SELECT id::text, label, kind, cli_tool, base_url, device_id, models FROM ai_connections
        WHERE enabled ORDER BY label, id`);
      const connections = Array.from(rows).map(row => ({ id: row.id, label: row.label, kind: row.kind, cliTool: row.cli_tool,
        baseUrl: row.base_url, deviceId: row.device_id, models: row.models }));
      const devices = [...new Set(parsed.data.routes.map(route => route.groupId))].sort();
      const engines = devices.map(deviceId => {
        const routes = parsed.data.routes.filter(route => route.groupId === deviceId);
        const bound = connections.filter(connection => connection.deviceId === deviceId);
        return { deviceId, connections: bound, models: [...new Set(routes.map(route => route.model))].sort(),
          routes: [...new Set(routes.map(route => route.routeId))].sort() };
      });
      return { policyHash: control.policy_hash, engines, error: null };
    }, { accessMode: "read only", isolationLevel: "repeatable read" }));
  } catch {
    logger.warn("admin_engine_limits.read_failed", {});
    return { policyHash: null, engines: [], error: "engine_limit_metadata_unavailable" };
  }
}

const sharedLimitInput = z.object({
  deviceId: z.string().min(1).max(120).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value)),
  limitSlots: z.number().int().min(1).max(256),
  expectedVersion: z.number().int().positive().safe().nullable(),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** One shared maximum, using the existing device writer and its audit/CAS contract. No route or model assignment changes. */
export async function saveEngineSharedLimit(input: unknown, actor: string): Promise<SaveCapacityDeviceResult> {
  const parsed = sharedLimitInput.safeParse(input);
  if (!parsed.success) return { ok: false, issues: ["공유 한도는 1~256의 정수여야 합니다. 현재 설정을 새로고침해 주세요."] };
  if (!actor.trim() || actor.length > 120) return { ok: false, issues: [capacityDeviceIssueMessage("invalid_actor")] };
  try {
    return await onPrimary(() => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout='1s'`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      // Same lock order as the existing writer/admission: fence -> control -> device.
      const [control] = await tx.execute<{ policy: unknown; policy_hash: string | null }>(sql`
        SELECT policy, policy_hash FROM model_capacity_control WHERE id=1 FOR UPDATE`);
      const policy = modelCapacityPolicySchema.safeParse(control?.policy);
      if (!policy.success || control?.policy_hash !== parsed.data.policyHash || modelCapacityPolicyHash(policy.data) !== parsed.data.policyHash)
        return { ok: false as const, issues: ["엔진에 연결된 작업 구성이 바뀌었습니다. 새로고침 후 다시 저장해 주세요."] };
      const { deviceId, limitSlots, expectedVersion } = parsed.data;
      if (!policy.data.routes.some(route => route.groupId === deviceId))
        return { ok: false as const, issues: ["현재 작업이 연결된 엔진만 여기서 저장할 수 있습니다."] };
      const [connection] = await tx.execute(sql`SELECT id FROM ai_connections WHERE device_id=${deviceId} AND enabled LIMIT 1`);
      if (!connection) return { ok: false as const, issues: ["이 엔진의 등록 연결을 확인하지 못했습니다. 고급 설정에서 현재 구성을 확인해 주세요."] };
      const before = await readModelCapacityDevice(deviceId, tx);
      if ((before?.version ?? null) !== expectedVersion)
        return { ok: false as const, issues: ["다른 곳에서 한도를 바꿨습니다. 새로고침 후 현재 값으로 다시 저장해 주세요."] };
      if (before && !before.enabled) return { ok: false as const, issues: ["꺼진 장비입니다. 고급 설정에서 사용 상태를 먼저 확인해 주세요."] };
      const fallback = deviceFallbackLimit(policy.data.groupLimits, deviceId);
      if (!before && fallback === null) return { ok: false as const, issues: ["이 엔진의 초기 설정이 없습니다. 고급 설정에서 먼저 등록해 주세요."] };
      const current = before ?? deviceSettingsFromPolicyFallback(deviceId, fallback!);
      const next = { deviceId, limitSlots, physicalLimit: limitSlots,
        secondaryCap: Math.min(current.secondaryCap, limitSlots), reserveSlots: Math.min(current.reserveSlots, limitSlots - 1),
        idleMs: current.idleMs, roles: current.roles, note: current.note };
      const saved = await saveModelCapacityDevice(tx, next, expectedVersion, actor);
      const changes = [`공유 동시 실행 한도: ${current.limitSlots} → ${saved.after.limitSlots}`,
        `엔진 최대치: ${current.physicalLimit ?? "미설정"} → ${saved.after.physicalLimit}`];
      if (current.secondaryCap !== next.secondaryCap) changes.push(`낮은 순위 상한: ${current.secondaryCap} → ${next.secondaryCap}`);
      if (current.reserveSlots !== next.reserveSlots) changes.push(`우선 역할에 남겨 둘 수: ${current.reserveSlots} → ${next.reserveSlots}`);
      return { ok: true as const, deviceId, version: saved.after.version, created: saved.before === null, changes };
    }));
  } catch (error) {
    if (error instanceof DrWriterFencedError) return { ok: false, issues: [capacityDeviceIssueMessage(error.reason)] };
    if (error instanceof Error && /^model_capacity_(?:device_|control_missing|replay_unsupported)/.test(error.message))
      return { ok: false, issues: [capacityDeviceIssueMessage(error.message)] };
    logger.warn("admin_engine_limits.save_failed", {});
    return { ok: false, issues: ["저장 결과를 확인하지 못했습니다. 다시 저장하기 전에 새로고침해 현재 한도를 확인해 주세요."] };
  }
}

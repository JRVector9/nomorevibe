import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { modelCapacityControl, modelCapacityDeviceRoles, modelCapacityDevices, operationsAudit } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import { MODEL_CAPACITY_DEVICE_SAVE_AUDIT_ACTION, MODEL_CAPACITY_ROUTE_QUOTA_SAVE_AUDIT_ACTION, deviceStateFromRow, deviceStateSql,
  parseModelCapacityDeviceSettings, parseModelCapacityRouteQuotasInput, routeQuotaCap, routeQuotasFromRecords, routeQuotasLimitIssue, routeQuotasToRecords,
  type DeviceStateRow, type ModelCapacityDeviceRow, type ModelCapacityDeviceState, type ModelCapacityGeneration,
  type ModelCapacityRouteQuota } from "./capacity-devices";
import { parseModelCapacityPolicy } from "./capacity";

/**
 * 장비 설정 표(model_capacity_devices / model_capacity_device_roles, 0153)의 DB 읽기·저장 — 1b-A.
 * lib/llm/capacity-repository.ts 는 PR #750 이 병합될 때까지 건드리지 않으므로 여기 따로 둔다. 1b-C 의 grantOne 은 deviceCandidateSql 을 직접 쓴다.
 *
 * 저장 한 트랜잭션(호출자의 tx 안에서): replay 거부 → DR writer fence(SHARE; fenced 면 site_fenced) → model_capacity_control id=1 FOR UPDATE
 * (모든 입장 TX 와 같은 잠금 순서 fence → control 이므로 grant 마다 설정 스냅샷이 하나다) → zod → 장비 행 FOR UPDATE → version compare-and-set
 * → upsert(version + 1) → 순위 행 교체 → operations_audit 한 줄(MODEL_CAPACITY_DEVICE_SAVE_AUDIT_ACTION, target = device_id).
 * 감싸는 쪽(1b-B 의 saveAdminCapacityDevice)은 감사 줄을 **또 쓰지 않는다**.
 */
type DeviceRowRecord = typeof modelCapacityDevices.$inferSelect;
type RoleRowRecord = typeof modelCapacityDeviceRoles.$inferSelect;
type Reader = Pick<ProductTransaction, "select" | "execute">;

const fail = (code: string): never => { throw new Error(code); };

function toRow(row: DeviceRowRecord, roles: readonly RoleRowRecord[]): ModelCapacityDeviceRow {
  const ranked = roles.filter(role => role.deviceId === row.deviceId)
    .map(role => Object.freeze({ routeId: role.routeId, rank: role.roleRank }))
    .sort((a, b) => a.rank - b.rank || (a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0));
  return Object.freeze({
    deviceId: row.deviceId, limitSlots: row.limitSlots, secondaryCap: row.secondaryCap, idleMs: row.idleMs, reserveSlots: row.reserveSlots,
    physicalLimit: row.physicalLimit, roles: Object.freeze(ranked), note: row.note, enabled: row.enabled, version: Number(row.version),
    updatedBy: row.updatedBy, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    lendIdle: row.lendIdle, routeQuotas: routeQuotasFromRecords(row.routeQuotas),
  });
}

async function rolesOf(reader: Reader, deviceIds: readonly string[]): Promise<RoleRowRecord[]> {
  if (!deviceIds.length) return [];
  return reader.select().from(modelCapacityDeviceRoles).where(inArray(modelCapacityDeviceRoles.deviceId, [...deviceIds]))
    .orderBy(asc(modelCapacityDeviceRoles.deviceId), asc(modelCapacityDeviceRoles.roleRank), asc(modelCapacityDeviceRoles.routeId));
}

/** 모든 장비 행(enabled 여부와 무관, device_id 순). tx 가 없으면 primary 에서 잠그지 않고 읽는다. */
export async function listModelCapacityDevices(tx?: ProductTransaction): Promise<ModelCapacityDeviceRow[]> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const load = async (reader: Reader) => {
    const rows = await reader.select().from(modelCapacityDevices).orderBy(asc(modelCapacityDevices.deviceId));
    const roles = await rolesOf(reader, rows.map(row => row.deviceId));
    return rows.map(row => toRow(row, roles));
  };
  return tx ? load(tx) : onPrimary(() => load(db));
}

/** 장비 행 하나(없으면 null). 폼이 expectedVersion 을 얻는 읽기다. */
export async function readModelCapacityDevice(deviceId: string, tx?: ProductTransaction): Promise<ModelCapacityDeviceRow | null> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const load = async (reader: Reader) => {
    const [row] = await reader.select().from(modelCapacityDevices).where(eq(modelCapacityDevices.deviceId, deviceId));
    return row ? toRow(row, await rolesOf(reader, [deviceId])) : null;
  };
  return tx ? load(tx) : onPrimary(() => load(db));
}

/**
 * 장비 설정 저장(upsert). `expectedVersion`: 현재 행의 version(새 장비는 null) — 다르면 `model_capacity_device_version_mismatch:<current|none>`.
 * 입력 거절은 `model_capacity_device_invalid:<path>`. fenced DB 는 DrWriterFencedError("site_fenced"). 장부 행은 건드리지 않는다 —
 * 한도를 점유 아래로 내리면 새 grant 만 막히고 잡힌 행은 그대로 끝난다.
 */
export async function saveModelCapacityDevice(tx: ProductTransaction, input: unknown, expectedVersion: number | null, actor: string):
  Promise<{ before: ModelCapacityDeviceRow | null; after: ModelCapacityDeviceRow }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  if (typeof actor !== "string" || !actor.trim() || actor.length > 120) fail("model_capacity_device_invalid:actor");
  if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) fail("model_capacity_device_version_mismatch:invalid");
  if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
  // 모든 입장 TX 가 쥐는 control 행을 먼저 잠근다: grant 는 설정 스냅샷 하나만 본다(저장 중간 상태를 읽지 않는다).
  const [control] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for("update");
  if (!control) fail("model_capacity_control_missing");
  const settings = parseModelCapacityDeviceSettings(input);
  const [existing] = await tx.select().from(modelCapacityDevices).where(eq(modelCapacityDevices.deviceId, settings.deviceId)).for("update");
  const before = existing ? toRow(existing, await rolesOf(tx, [settings.deviceId])) : null;
  const current = before?.version ?? null;
  if (expectedVersion !== null && current !== expectedVersion) fail(`model_capacity_device_version_mismatch:${current ?? "none"}`);
  if (current !== null && current >= 9007199254740991) fail("model_capacity_device_version_exhausted");
  // 경로 몫(0169)은 장비 저장이 바꾸지 않는다 — 칸 수를 보장 합계·상한 아래로 줄이려면 몫을 먼저 줄인다(DB 검사도 같은 규칙으로 거절한다)
  if (before?.routeQuotas?.length && routeQuotasLimitIssue(before.routeQuotas, settings.limitSlots) !== null)
    fail("model_capacity_device_invalid:route_quotas_exceed_limit");
  const values = { limitSlots: settings.limitSlots, secondaryCap: settings.secondaryCap, idleMs: settings.idleMs, reserveSlots: settings.reserveSlots,
    physicalLimit: settings.physicalLimit, note: settings.note, updatedBy: actor };
  const [saved] = await tx.insert(modelCapacityDevices).values({ deviceId: settings.deviceId, ...values, enabled: true })
    .onConflictDoUpdate({ target: modelCapacityDevices.deviceId,
      set: { ...values, enabled: true, version: sql`${modelCapacityDevices.version} + 1`, updatedAt: sql`clock_timestamp()` } }).returning();
  await tx.delete(modelCapacityDeviceRoles).where(eq(modelCapacityDeviceRoles.deviceId, settings.deviceId));
  if (settings.roles.length) {
    await tx.insert(modelCapacityDeviceRoles).values(settings.roles.map(role => ({ deviceId: settings.deviceId, routeId: role.routeId, roleRank: role.rank })));
  }
  const after = toRow(saved, await rolesOf(tx, [settings.deviceId]));
  await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: MODEL_CAPACITY_DEVICE_SAVE_AUDIT_ACTION, target: settings.deviceId,
    detail: { version: after.version, expectedVersion, before: before && settingsOf(before), after: settingsOf(after) } }));
  return { before, after };
}

/**
 * 경로 몫 저장(step 2, 운영자 결정 2026-11-08) — 장비 한 대의 lend_idle 과 route_quotas 를 통째로 바꾼다. 호출자의 tx 안에서, 던지면 아무것도 남지 않는다.
 * 순서(모든 입장 TX 와 같은 잠금 순서): replay 거부 → 입력 검증(zod) → DR writer fence(SHARE; fenced 면 site_fenced) → model_capacity_control id=1
 * FOR UPDATE(grant 는 몫 스냅숏 하나만 본다) → 장비 행 FOR UPDATE(있고 enabled 여야 한다) → version compare-and-set → 칸 수와 견준 검사
 * (줄마다 min·max ≤ 칸, 보장 합계 ≤ 칸) → UPDATE(lend_idle, route_quotas, version + 1) → operations_audit 한 줄
 * (MODEL_CAPACITY_ROUTE_QUOTA_SAVE_AUDIT_ACTION, target = device_id, detail { version, expectedVersion, before, after, warnings }).
 * 거절: `model_capacity_route_quota_invalid:<path>` · `model_capacity_route_quota_version_mismatch:<current|none>` · `model_capacity_route_quota_device_unconfigured`
 * · `model_capacity_device_version_exhausted` · `model_capacity_control_missing` · DrWriterFencedError("site_fenced").
 * 경고(저장은 한다): `route_unmapped:<route>` = 지금 정책에 이 장비로 가는 그 route 가 없다(몫은 route 가 생기면 적용된다), `policy_unreadable`.
 * 장부 행은 건드리지 않는다 — 이미 잡힌 칸은 그대로 끝나고, 새 grant 부터 몫이 적용된다(DRAIN 불필요).
 */
export async function saveModelCapacityRouteQuotas(tx: ProductTransaction, input: unknown, actor: string): Promise<{
  before: { lendIdle: boolean; quotas: readonly ModelCapacityRouteQuota[] }; after: ModelCapacityDeviceRow; warnings: readonly string[] }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  if (typeof actor !== "string" || !actor.trim() || actor.length > 120) fail("model_capacity_route_quota_invalid:actor");
  const parsed = parseModelCapacityRouteQuotasInput(input);
  if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
  const [control] = await tx.select({ id: modelCapacityControl.id, policy: modelCapacityControl.policy }).from(modelCapacityControl)
    .where(eq(modelCapacityControl.id, 1)).for("update");
  if (!control) fail("model_capacity_control_missing");
  const [existing] = await tx.select().from(modelCapacityDevices).where(eq(modelCapacityDevices.deviceId, parsed.deviceId)).for("update");
  if (!existing || !existing.enabled) fail("model_capacity_route_quota_device_unconfigured");
  const current = Number(existing.version);
  if (current !== parsed.expectedVersion) fail(`model_capacity_route_quota_version_mismatch:${current}`);
  if (current >= 9007199254740991) fail("model_capacity_device_version_exhausted");
  const issue = routeQuotasLimitIssue(parsed.quotas, existing.limitSlots);
  if (issue !== null) fail(`model_capacity_route_quota_invalid:${issue}`);
  const warnings: string[] = [];
  let policy: ReturnType<typeof parseModelCapacityPolicy> | null = null;
  try { policy = control.policy === null ? null : parseModelCapacityPolicy(control.policy); } catch { policy = null; }
  if (policy === null) warnings.push("policy_unreadable");
  else for (const quota of parsed.quotas)
    if (!policy.routes.some(route => route.routeId === quota.routeId && route.groupId === parsed.deviceId)) warnings.push(`route_unmapped:${quota.routeId}`);
  const before = { lendIdle: existing.lendIdle, quotas: routeQuotasFromRecords(existing.routeQuotas) };
  const [saved] = await tx.update(modelCapacityDevices).set({ lendIdle: parsed.lendIdle, routeQuotas: routeQuotasToRecords(parsed.quotas),
    version: sql`${modelCapacityDevices.version} + 1`, updatedBy: actor, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(modelCapacityDevices.deviceId, parsed.deviceId), eq(modelCapacityDevices.version, existing.version))).returning();
  if (!saved) fail(`model_capacity_route_quota_version_mismatch:${current}`);
  const after = toRow(saved, await rolesOf(tx, [parsed.deviceId]));
  const quotaView = (lendIdle: boolean, quotas: readonly ModelCapacityRouteQuota[]) => ({ lendIdle,
    quotas: quotas.map(quota => ({ ...quota, cap: routeQuotaCap(quota, lendIdle) })) });
  await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: MODEL_CAPACITY_ROUTE_QUOTA_SAVE_AUDIT_ACTION, target: parsed.deviceId,
    detail: { version: after.version, expectedVersion: parsed.expectedVersion, limitSlots: after.limitSlots,
      before: quotaView(before.lendIdle, before.quotas), after: quotaView(after.lendIdle ?? true, after.routeQuotas ?? []), warnings } }));
  return { before, after, warnings: Object.freeze(warnings) };
}

const settingsOf = (row: ModelCapacityDeviceRow) => ({ limitSlots: row.limitSlots, secondaryCap: row.secondaryCap, idleMs: row.idleMs,
  reserveSlots: row.reserveSlots, physicalLimit: row.physicalLimit, roles: row.roles.map(role => ({ ...role })), note: row.note, enabled: row.enabled });

type ControlRow = { epoch: string | number; revision: string | number; policy_hash: string | null; group_limits: unknown; route_groups: unknown };

/**
 * 모든 장비의 실시간 상태 — enabled 설정 행 ∪ 정책 groupLimits 키 ∪ 정책 route 의 groupId(설정 출처가 없는 장비는 빠진다: 관리자 화면은
 * 정책 route 목록과 견줘 `device_unconfigured` 를 표시한다). 한 문장(LATERAL + deviceStateCte), 잠그지 않는다. tx 를 주면 그 TX 가 보는
 * 스냅샷으로 읽고(1b-C 의 입장 TX·status), 없으면 primary 에서 읽는다.
 */
export async function readModelCapacityDeviceStates(tx?: ProductTransaction): Promise<ModelCapacityDeviceState[]> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const load = async (reader: Reader) => {
    const [control] = await reader.execute<ControlRow>(sql`SELECT epoch, revision, policy_hash,
        CASE WHEN jsonb_typeof(policy->'groupLimits') = 'object' THEN policy->'groupLimits' ELSE '{}'::jsonb END AS group_limits,
        CASE WHEN jsonb_typeof(policy->'routes') = 'array' THEN (SELECT coalesce(jsonb_agg(DISTINCT r->>'groupId'), '[]'::jsonb)
          FROM jsonb_array_elements(policy->'routes') r WHERE jsonb_typeof(r->'groupId') = 'string') ELSE '[]'::jsonb END AS route_groups
      FROM model_capacity_control WHERE id = 1`);
    if (!control) fail("model_capacity_control_missing");
    const generation: ModelCapacityGeneration = { epoch: Number(control.epoch), revision: Number(control.revision), policyHash: control.policy_hash ?? "" };
    const groupLimits = control.group_limits && typeof control.group_limits === "object" ? control.group_limits as Record<string, unknown> : {};
    const groupLimitsJson = JSON.stringify(groupLimits);
    // 장비 id 는 요청 행의 group_id 와 같은 identity 규칙(공백·제어문자 없음, 120자)을 지키는 것만 — seed(0153)와 같은 필터
    const rows = await reader.execute<DeviceStateRow>(sql`SELECT x.* FROM (
        SELECT candidates.device_id FROM (
          SELECT d.device_id FROM model_capacity_devices d WHERE d.enabled
          UNION SELECT g.key FROM jsonb_object_keys(${groupLimitsJson}::jsonb) g(key)
          UNION SELECT r.value FROM jsonb_array_elements_text(${JSON.stringify(Array.isArray(control.route_groups) ? control.route_groups : [])}::jsonb) r(value)
        ) candidates
        WHERE char_length(candidates.device_id) BETWEEN 1 AND 120 AND candidates.device_id = btrim(candidates.device_id) AND candidates.device_id !~ '[[:cntrl:]]'
      ) ids, LATERAL (${deviceStateSql(sql`ids.device_id`, generation, groupLimitsJson)}) x ORDER BY x.device_id`);
    return rows.map(deviceStateFromRow);
  };
  return tx ? load(tx) : onPrimary(() => load(db));
}

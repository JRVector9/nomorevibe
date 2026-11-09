import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { aiConnections, aiTaskModels, aiTaskPoolMembers, modelCapacityControl, modelCapacityDeviceRoles, modelCapacityDevices, modelHelperAssignments,
  modelServingContracts, operationsAudit } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import { AI_TASKS, aiTask } from "./ai-tasks";
import { modelCapacityPolicyHash, parseModelCapacityPolicy, type ModelCapacityMode, type ModelCapacityPolicy, type ModelCapacityRoute } from "./capacity";
import { routeQuotasFromRecords } from "./capacity-devices";
import { removeCapacityRoutes, type RemoveCapacityRoutesResult } from "./capacity-repository";
import { capacityBlockersText, capacityDeviceRetireBlockers, capacityRouteKeyText, findStaleCapacityRoutes, type CapacityReferenceSnapshot,
  type CapacityRouteKey, type StaleRouteCandidate } from "./capacity-retire";
import { openStateSql } from "./capacity-states";

/**
 * 쓰지 않는 장비 은퇴·남은 정책 route 정리(2026-11-09)의 DB 쪽. 둘 다 호출자의 쓰기 TX 하나에서:
 * replay 거부 → 입력 검증 → DR writer fence(SHARE; fenced 면 site_fenced) → model_capacity_control id=1 FOR UPDATE(모든 입장 TX 와 같은 잠금 순서 —
 * 확인과 쓰기 사이에 새 장부 행이 생기지 않는다) → (은퇴만) 장비 행 FOR UPDATE + version CAS / (정리만) 정책 revision CAS → 참조 읽기(같은 TX) →
 * 판정(capacity-retire.ts) → 정책에서 route·groupLimits 키 빼기(removeCapacityRoutes — OPEN 이어도 되는 근거는 그 주석) → (은퇴만) 역할 행·장비 행 지우기
 * → operations_audit 한 줄(전·후). 거절은 아무것도 쓰지 않고 던진다(코드는 admin-capacity-retire.ts 가 한국어로 푼다). 장부 행은 읽기만 한다.
 */
export const MODEL_CAPACITY_DEVICE_RETIRE_AUDIT_ACTION = "model-capacity-device-retire";
export const MODEL_CAPACITY_ROUTES_PRUNE_AUDIT_ACTION = "model-capacity-routes-prune";
/** 한 번에 정리할 수 있는 route 수 */
export const MODEL_CAPACITY_PRUNE_MAX = 64;

type Reader = Pick<ProductTransaction, "select" | "execute">;
const fail = (code: string): never => { throw new Error(code); };
const identity = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), "invalid_identity");
const validActor = (actor: unknown): actor is string => typeof actor === "string" && !!actor.trim() && actor.length <= 120;

const retireInputSchema = z.object({ deviceId: identity(120), expectedVersion: z.number().int().positive().safe().nullable() }).strict();
const routeKeySchema = z.object({ routeId: identity(120), provider: identity(60), model: identity(200), groupId: identity(120) }).strict();
const pruneInputSchema = z.object({ routes: z.array(routeKeySchema).min(1).max(MODEL_CAPACITY_PRUNE_MAX), expectedRevision: z.number().int().positive().safe() }).strict();
const parseOr = <T>(schema: z.ZodType<T>, value: unknown, prefix: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(`${prefix}:${parsed.error.issues[0]?.path.join(".") || "root"}`);
  return parsed.data as T;
};

type LockedControl = Readonly<{ mode: ModelCapacityMode; epoch: number; revision: number; policy: ModelCapacityPolicy | null; policyHash: string | null }>;
/** fence → control FOR UPDATE, 정책 JSON 을 hash 로 검증한다(맞지 않으면 쓰지 않는다) */
async function lockControl(tx: ProductTransaction): Promise<LockedControl> {
  if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
  const [row] = await tx.select().from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for("update");
  if (!row) return fail("model_capacity_control_missing");
  const policy = row.policy === null ? null : parseModelCapacityPolicy(row.policy);
  if (policy !== null && modelCapacityPolicyHash(policy) !== row.policyHash) fail("model_capacity_policy_hash_mismatch");
  return { mode: row.mode, epoch: Number(row.epoch), revision: Number(row.revision), policy, policyHash: row.policyHash };
}

const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
function hiddenOf(options: unknown): string[] {
  const raw = options && typeof options === "object" ? (options as Record<string, unknown>).hiddenModels : undefined;
  return stringList(raw);
}
const text = (value: unknown) => typeof value === "string" ? value : null;

/**
 * 판정에 쓰는 참조를 이 TX 의 스냅숏으로 읽는다(잠그지 않는다 — 순위·연결·계약 저장이 이 확인 뒤에 route 를 다시 부르면 그 저장의 appendCompatibleRoutes 가
 * route 를 다시 덧붙이고, 장부 행은 control 잠금 아래에서만 생긴다). 키·암호문은 읽지 않는다.
 */
export async function readCapacityReferenceSnapshot(reader: Reader, routes: readonly ModelCapacityRoute[]): Promise<CapacityReferenceSnapshot> {
  const connections = await reader.select({ id: aiConnections.id, label: aiConnections.label, deviceId: aiConnections.deviceId, enabled: aiConnections.enabled,
    kind: aiConnections.kind, models: aiConnections.models, cliModels: aiConnections.cliModels, options: aiConnections.options }).from(aiConnections).orderBy(asc(aiConnections.label));
  const ranks = await reader.select({ task: aiTaskModels.task, slot: aiTaskModels.slot, rank: aiTaskModels.rank, connectionId: aiTaskModels.connectionId,
    model: aiTaskModels.model, enabled: aiTaskModels.enabled }).from(aiTaskModels).orderBy(asc(aiTaskModels.task), asc(aiTaskModels.slot), asc(aiTaskModels.rank));
  const members = await reader.select({ task: aiTaskPoolMembers.task, slot: aiTaskPoolMembers.slot, position: aiTaskPoolMembers.position,
    connectionId: aiTaskPoolMembers.connectionId, model: aiTaskPoolMembers.model, canonicalModel: aiTaskPoolMembers.canonicalModel, deviceId: aiTaskPoolMembers.deviceId })
    .from(aiTaskPoolMembers).orderBy(asc(aiTaskPoolMembers.task), asc(aiTaskPoolMembers.slot), asc(aiTaskPoolMembers.position));
  const helpers = await reader.select({ assignmentId: modelHelperAssignments.assignmentId, deviceId: modelHelperAssignments.deviceId, model: modelHelperAssignments.model,
    liveRouteId: modelHelperAssignments.liveRouteId, liveProvider: modelHelperAssignments.liveProvider, shadowRouteId: modelHelperAssignments.shadowRouteId,
    mode: modelHelperAssignments.mode }).from(modelHelperAssignments).orderBy(asc(modelHelperAssignments.assignmentId));
  const contracts = await reader.select({ id: modelServingContracts.id, routeId: modelServingContracts.routeId, model: modelServingContracts.model,
    transport: modelServingContracts.transport, contract: modelServingContracts.contract }).from(modelServingContracts)
    .where(eq(modelServingContracts.enabled, true)).orderBy(asc(modelServingContracts.id));
  const open = await reader.execute<{ route_id: string; provider: string; model: string; group_id: string; state: string; n: number }>(sql`
    SELECT route_id, provider, model, group_id, state, count(*)::int AS n FROM model_capacity_requests WHERE ${openStateSql("state")}
    GROUP BY route_id, provider, model, group_id, state ORDER BY route_id, provider, model, group_id, state`);
  const routeOf = (task: string) => aiTask(task)?.routeId ?? null;
  return Object.freeze({
    routes,
    connections: connections.map(row => Object.freeze({ id: row.id, label: row.label, deviceId: row.deviceId, enabled: row.enabled, kind: row.kind,
      models: row.kind === "cli" ? [...row.cliModels] : Array.isArray(row.models) ? row.models.flatMap(entry => entry && typeof entry.id === "string" ? [entry.id] : []) : [],
      hiddenModels: hiddenOf(row.options) })),
    ranks: ranks.map(row => Object.freeze({ ...row, routeId: routeOf(row.task) })),
    poolMembers: members.map(row => Object.freeze({ ...row, routeId: routeOf(row.task) })),
    helpers: helpers.map(row => Object.freeze({ ...row })),
    contracts: contracts.map(row => {
      const contract = row.contract && typeof row.contract === "object" ? row.contract as Record<string, unknown> : {};
      return Object.freeze({ id: Number(row.id), routeId: row.routeId, model: row.model, transport: row.transport, provider: text(contract.provider),
        backendId: text(contract.backendId), physicalGroup: text(contract.physicalGroup) });
    }),
    ledgerOpen: Array.from(open).map(row => Object.freeze({ routeId: row.route_id, provider: row.provider, model: row.model, groupId: row.group_id, state: row.state,
      count: Number(row.n) })),
    taskRouteIds: [...new Set(AI_TASKS.flatMap(task => task.routeId ? [task.routeId] : []))].sort(),
  });
}

const generationView = (value: RemoveCapacityRoutesResult["before"]) => ({ epoch: value.epoch, revision: value.revision, policyHash: value.policyHash });
const routeView = (route: ModelCapacityRoute) => ({ routeId: route.routeId, provider: route.provider, model: route.model, providerBudgetId: route.providerBudgetId,
  groupId: route.groupId });

export type RetireCapacityDeviceResult = Readonly<{ deviceId: string; mode: ModelCapacityMode; deletedRow: boolean; removedRoutes: readonly ModelCapacityRoute[];
  removedGroupLimit: number | null; policy: Readonly<{ before: RemoveCapacityRoutesResult["before"]; after: RemoveCapacityRoutesResult["after"]; written: boolean }> }>;

/**
 * 쓰지 않는 장비 하나를 지운다 — 정책에서 그 장비의 route 전부와 groupLimits 키를 빼고, 장비 행·역할 행을 지운다. `expectedVersion` = 장비 행의 version
 * (행 없이 정책에만 있는 장비는 null). mode 는 가리지 않는다(OPEN 이어도 된다 — removeCapacityRoutes 주석).
 * 거절: `model_capacity_device_retire_invalid:<path>` · `model_capacity_device_retire_version_mismatch:<current|none>` ·
 * `model_capacity_device_already_retired`(행·route·groupLimits 키 모두 없음 — 다시 눌러도 두 번 쓰지 않는다) ·
 * `model_capacity_device_retire_blocked:<kind=detail | …>`(연결·풀·배정·계약·순위·장부) · removeCapacityRoutes 의 거절 · site_fenced.
 */
export async function retireCapacityDevice(tx: ProductTransaction, input: unknown, actor: string): Promise<RetireCapacityDeviceResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  if (!validActor(actor)) fail("model_capacity_device_retire_invalid:actor");
  const { deviceId, expectedVersion } = parseOr(retireInputSchema, input, "model_capacity_device_retire_invalid");
  const control = await lockControl(tx);
  const [row] = await tx.select().from(modelCapacityDevices).where(eq(modelCapacityDevices.deviceId, deviceId)).for("update");
  const current = row ? Number(row.version) : null;
  const routes = (control.policy?.routes ?? []).filter(route => route.groupId === deviceId);
  const groupLimit = control.policy?.groupLimits && Object.hasOwn(control.policy.groupLimits, deviceId) ? control.policy.groupLimits[deviceId] : null;
  if (!row && !routes.length && groupLimit === null) fail("model_capacity_device_already_retired");
  if (current !== expectedVersion) fail(`model_capacity_device_retire_version_mismatch:${current ?? "none"}`);
  const snapshot = await readCapacityReferenceSnapshot(tx, control.policy?.routes ?? []);
  const blockers = capacityDeviceRetireBlockers(snapshot, deviceId);
  if (blockers.length) fail(`model_capacity_device_retire_blocked:${capacityBlockersText(blockers)}`);
  const roles = row ? await tx.select().from(modelCapacityDeviceRoles).where(eq(modelCapacityDeviceRoles.deviceId, deviceId))
    .orderBy(asc(modelCapacityDeviceRoles.roleRank), asc(modelCapacityDeviceRoles.routeId)) : [];
  const policy = control.policy
    ? await removeCapacityRoutes(tx, { routes: routes.map(route => ({ routeId: route.routeId, provider: route.provider, model: route.model, groupId: route.groupId })),
      groupLimitKeys: [deviceId] })
    : null;
  if (row) {
    await tx.delete(modelCapacityDeviceRoles).where(eq(modelCapacityDeviceRoles.deviceId, deviceId));
    const [deleted] = await tx.delete(modelCapacityDevices).where(and(eq(modelCapacityDevices.deviceId, deviceId), eq(modelCapacityDevices.version, row.version)))
      .returning({ deviceId: modelCapacityDevices.deviceId });
    if (!deleted) fail(`model_capacity_device_retire_version_mismatch:${current}`);
  }
  const generation = { epoch: control.epoch, revision: control.revision, policyHash: control.policyHash ?? "" };
  const before = policy?.before ?? generation, after = policy?.after ?? generation;
  await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: MODEL_CAPACITY_DEVICE_RETIRE_AUDIT_ACTION, target: deviceId,
    detail: { deviceId, expectedVersion, mode: control.mode,
      before: { device: row ? { version: current, limitSlots: row.limitSlots, secondaryCap: row.secondaryCap, idleMs: row.idleMs, reserveSlots: row.reserveSlots,
        physicalLimit: row.physicalLimit, enabled: row.enabled, note: row.note, lendIdle: row.lendIdle, routeQuotas: routeQuotasFromRecords(row.routeQuotas),
        roles: roles.map(role => ({ routeId: role.routeId, rank: role.roleRank })), updatedBy: row.updatedBy } : null,
        routes: routes.map(routeView), groupLimit, policy: generationView(before) },
      after: { device: null, routes: [], groupLimit: null, policy: generationView(after), predecessors: policy?.predecessors ?? [] } } }));
  return { deviceId, mode: control.mode, deletedRow: !!row, removedRoutes: policy?.removed ?? [], removedGroupLimit: groupLimit,
    policy: { before, after, written: policy?.written ?? false } };
}

export type PruneStaleCapacityRoutesResult = Readonly<{ mode: ModelCapacityMode; removed: readonly StaleRouteCandidate[];
  policy: Readonly<{ before: RemoveCapacityRoutesResult["before"]; after: RemoveCapacityRoutesResult["after"] }> }>;

/**
 * 남은 정책 route(옛 별칭 등)를 뺀다 — 고른 route 가 모두 지금 판정(findStaleCapacityRoutes)에서 후보여야 한다. `expectedRevision` = 고를 때 본 정책 revision
 * (그 사이 정책이 바뀌었으면 다시 본다). 장비 행·groupLimits 는 그대로다.
 * 거절: `model_capacity_routes_prune_invalid:<path>` · `model_capacity_routes_prune_revision_mismatch:<current>` · `model_capacity_policy_missing` ·
 * `model_capacity_route_missing:<key>`(이미 빠졌다) · `model_capacity_route_conflict` · `model_capacity_route_prune_blocked:<key> | <kind=detail | …>` ·
 * removeCapacityRoutes 의 거절 · site_fenced.
 */
export async function pruneStaleCapacityRoutes(tx: ProductTransaction, input: unknown, actor: string): Promise<PruneStaleCapacityRoutesResult> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  if (!validActor(actor)) fail("model_capacity_routes_prune_invalid:actor");
  const { routes: wanted, expectedRevision } = parseOr(pruneInputSchema, input, "model_capacity_routes_prune_invalid");
  const control = await lockControl(tx);
  if (control.revision !== expectedRevision) fail(`model_capacity_routes_prune_revision_mismatch:${control.revision}`);
  if (!control.policy) return fail("model_capacity_policy_missing");
  const policyRoutes = control.policy.routes;
  const keys: CapacityRouteKey[] = [];
  for (const route of wanted) {
    const existing = policyRoutes.find(other => capacityRouteKeyText(other) === capacityRouteKeyText(route));
    if (!existing) fail(`model_capacity_route_missing:${capacityRouteKeyText(route)}`);
    if (existing!.groupId !== route.groupId) fail("model_capacity_route_conflict");
    if (!keys.some(key => capacityRouteKeyText(key) === capacityRouteKeyText(route))) keys.push(route);
  }
  const verdict = findStaleCapacityRoutes(await readCapacityReferenceSnapshot(tx, policyRoutes));
  const removed: StaleRouteCandidate[] = [];
  for (const key of keys) {
    const candidate = verdict.candidates.find(entry => capacityRouteKeyText(entry.route) === capacityRouteKeyText(key));
    if (!candidate) {
      const blockers = verdict.kept.find(entry => capacityRouteKeyText(entry.route) === capacityRouteKeyText(key))?.blockers ?? [];
      fail(`model_capacity_route_prune_blocked:${capacityRouteKeyText(key)} | ${capacityBlockersText(blockers)}`);
    }
    removed.push(candidate!);
  }
  const policy = await removeCapacityRoutes(tx, { routes: keys });
  await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: MODEL_CAPACITY_ROUTES_PRUNE_AUDIT_ACTION,
    target: removed.length === 1 ? capacityRouteKeyText(removed[0].route) : `routes:${removed.length}`,
    detail: { expectedRevision, mode: control.mode,
      before: { policy: generationView(policy.before), routes: removed.map(entry => ({ ...routeView(entry.route), reason: entry.reason, aliasHints: entry.aliasHints })) },
      after: { policy: generationView(policy.after), routes: [], predecessors: policy.predecessors } } }));
  return { mode: control.mode, removed, policy: { before: policy.before, after: policy.after } };
}

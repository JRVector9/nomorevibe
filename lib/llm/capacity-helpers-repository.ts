import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { modelCapacityControl, modelCapacityDeviceRoles, modelCapacityDevices, modelDeviceSignals, modelHelperAssignments, modelHelperSignals,
  modelHelperStops, modelRoleDemand, modelSupervisorControl, operationsAudit } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import { parseModelCapacityPolicy, type ModelCapacityPolicy } from "./capacity";
import {
  HELPER_ASSIGNMENT_ID_PATTERN, HELPER_MODE_AUDIT_ACTION, HELPER_SAVE_AUDIT_ACTION, HELPER_SHADOW_PROVIDER, SUPERVISOR_CONTROL_ID,
  SUPERVISOR_TOGGLE_AUDIT_ACTION, helperEvidenceKey, helperGateStateFromRow, helperGateStatesSql, parseHelperAssignment,
  supervisorControlPatchSchema, supervisorControlTimingValid,
  type DeviceSignalRow, type HelperAssignmentInput, type HelperAssignmentRow, type HelperEvidenceParts, type HelperGateState,
  type HelperGateStateRow, type HelperMetrics, type HelperMode, type HelperSaveRefusal, type HelperSignalRow, type HelperStatusSnapshot,
  type HelperStopRow, type RoleDemandMetrics, type RoleDemandRow, type SupervisorControlPatch, type SupervisorControlRow,
} from "./capacity-helpers";
import { localModelContractHash, resolveLocalModelServingContract } from "./local-model-serving-contract";

/**
 * 도우미 배정·감시자 control 의 DB 읽기·저장(PR 2a WP-2a-A). 서명·오류 문자열·감사 action 은 day 0 계약(bf117187) 그대로다.
 *
 * 저장 한 트랜잭션(호출자의 tx 안에서, 장비 저장과 같은 순서): replay 거부 → DR writer fence(SHARE; fenced 면 DrWriterFencedError("site_fenced"))
 * → model_capacity_control id=1 FOR UPDATE(입장 TX 와 같은 잠금 순서 fence → control) → 검증(zod) → 행 FOR UPDATE → 거절 → version compare-and-set
 * → 쓰기(version + 1) → operations_audit 한 줄. 감싸는 쪽(lib/operations/admin-model-helpers.ts)은 감사 줄을 **또 쓰지 않는다**.
 *
 * 오류 문자열: `model_helper_invalid:<path>` · `model_helper_version_mismatch:<current|none|invalid>` · `model_helper_refused:<HelperSaveRefusal>`
 * · `model_supervisor_invalid:<path>` · `model_supervisor_control_missing` · `model_capacity_replay_unsupported` · `model_capacity_control_missing`.
 * 같은 장비의 다른 배정과 경로 (route, provider, model) 가 겹치면 `model_helper_invalid:liveRouteId|shadowRouteId`, 저장된 배정의 단계·장비를 바꾸려 하면
 * `model_helper_invalid:stage|deviceId` 다(배정 id 는 장비 × 단계의 이름이다).
 */

type AssignmentRecord = typeof modelHelperAssignments.$inferSelect;
type Reader = Pick<ProductTransaction, "select" | "execute">;
type Env = Readonly<Record<string, string | undefined>>;

const fail = (code: string): never => { throw new Error(code); };
const refuse = (code: HelperSaveRefusal): never => fail(`model_helper_refused:${code}`);
const iso = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();
const isoRequired = (value: Date | string): string => new Date(value).toISOString();
const VERSION_MAX = 9007199254740991;
/** 저장이 계약을 찾지 못했을 때 evidence 의 contractHash 자리(그 경로의 backendId 를 적는다). 섀도·실전 실행 쪽은 자기 계약으로 다시 계산해 다르면 쓰지 않는다. */
export const HELPER_UNRESOLVED_CONTRACT_PREFIX = "unresolved:";

function checkActor(actor: string, prefix: string): void {
  if (typeof actor !== "string" || !actor.trim() || actor.length > 120) fail(`${prefix}:actor`);
}

function toRow(row: AssignmentRecord): HelperAssignmentRow {
  return Object.freeze({
    assignmentId: row.assignmentId, stage: row.stage, deviceId: row.deviceId, model: row.model, shadowRouteId: row.shadowRouteId,
    liveRouteId: row.liveRouteId, liveProvider: row.liveProvider, mode: row.mode, maxSlots: row.maxSlots, perTick: row.perTick,
    shadowPerHour: row.shadowPerHour, minShadowSamples: row.minShadowSamples, minAgreement: Number(row.minAgreement),
    maxWrongApproval: Number(row.maxWrongApproval), maxWrongRejection: Number(row.maxWrongRejection), maxUnknownRate: Number(row.maxUnknownRate),
    maxFailureRate: Number(row.maxFailureRate), maxLiveDisagreement: Number(row.maxLiveDisagreement), enterSamples: row.enterSamples,
    exitSamples: row.exitSamples, minHelpMs: row.minHelpMs, reenterCooldownMs: row.reenterCooldownMs, note: row.note,
    version: Number(row.version), evidenceKey: row.evidenceKey, promotedAt: iso(row.promotedAt), promotedBy: row.promotedBy,
    updatedBy: row.updatedBy, createdAt: isoRequired(row.createdAt), updatedAt: isoRequired(row.updatedAt),
  });
}

/** 감사 detail 의 before·after = 저장 전후의 전체 행(HelperAssignmentRow, 관리자 화면 감사 목록이 그대로 읽는다). */
const auditRow = (row: HelperAssignmentRow | null) => row && { ...row };

/** DR fence(SHARE) → model_capacity_control FOR UPDATE. 정책(없으면 null)을 돌려준다 — 경로 검증은 이 잠금 아래의 정책 하나만 본다. */
async function lockForWrite(tx: ProductTransaction): Promise<ModelCapacityPolicy | null> {
  if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
  const [control] = await tx.select({ policy: modelCapacityControl.policy }).from(modelCapacityControl)
    .where(eq(modelCapacityControl.id, 1)).for("update");
  if (!control) return fail("model_capacity_control_missing");
  return control.policy === null ? null : parseModelCapacityPolicy(control.policy);
}

type RouteIdentity = Readonly<{ routeId: string; provider: string; model: string }>;
const liveRoute = (a: Pick<HelperAssignmentInput, "liveRouteId" | "liveProvider" | "model">): RouteIdentity =>
  ({ routeId: a.liveRouteId, provider: a.liveProvider, model: a.model });
const shadowRoute = (a: Pick<HelperAssignmentInput, "shadowRouteId" | "model">): RouteIdentity =>
  ({ routeId: a.shadowRouteId, provider: HELPER_SHADOW_PROVIDER, model: a.model });
const sameRoute = (a: RouteIdentity, b: RouteIdentity) => a.routeId === b.routeId && a.provider === b.provider && a.model === b.model;

/**
 * 경로 검증(저장·섀도 시작): 장비 행(enabled) → 현재 정책에 두 경로가 이 장비(groupId)로 있음 → 장비 순위에서 rank 1 이 아님 → 같은 장비의 다른 배정과 겹치지 않음.
 * 섀도 경로의 정책 providerBudgetId(= 로컬 모델 backendId)를 돌려준다(evidence 계산).
 */
async function validateHelperRoutes(tx: ProductTransaction, policy: ModelCapacityPolicy | null,
  a: Pick<HelperAssignmentInput, "assignmentId" | "deviceId" | "model" | "shadowRouteId" | "liveRouteId" | "liveProvider">): Promise<string> {
  const [device] = await tx.select({ deviceId: modelCapacityDevices.deviceId }).from(modelCapacityDevices)
    .where(and(eq(modelCapacityDevices.deviceId, a.deviceId), eq(modelCapacityDevices.enabled, true))).limit(1);
  if (!device) refuse("helper_device_unconfigured");
  const live = liveRoute(a), shadow = shadowRoute(a);
  const mapped = (identity: RouteIdentity) => policy?.routes.find(route => sameRoute(route, identity));
  const livePolicy = mapped(live), shadowPolicy = mapped(shadow);
  if (!livePolicy || !shadowPolicy || livePolicy.groupId !== a.deviceId || shadowPolicy.groupId !== a.deviceId) return refuse("helper_route_unmapped");
  const [primary] = await tx.select({ routeId: modelCapacityDeviceRoles.routeId }).from(modelCapacityDeviceRoles)
    .where(and(eq(modelCapacityDeviceRoles.deviceId, a.deviceId), eq(modelCapacityDeviceRoles.roleRank, 1),
      or(eq(modelCapacityDeviceRoles.routeId, a.liveRouteId), eq(modelCapacityDeviceRoles.routeId, a.shadowRouteId)))).limit(1);
  if (primary) refuse("helper_route_is_primary");
  const others = await tx.select().from(modelHelperAssignments)
    .where(and(eq(modelHelperAssignments.deviceId, a.deviceId), ne(modelHelperAssignments.assignmentId, a.assignmentId)));
  for (const other of others) {
    const taken = [liveRoute(other), shadowRoute(other)];
    if (taken.some(route => sameRoute(route, live))) fail("model_helper_invalid:liveRouteId");
    if (taken.some(route => sameRoute(route, shadow))) fail("model_helper_invalid:shadowRouteId");
  }
  return shadowPolicy.providerBudgetId;
}

/**
 * 배정의 evidence 조각(§4.1 Q5): 단계·모델·심사 프롬프트판·규칙판·wire 변형·서빙 계약 hash. 계약은 섀도 경로의 정책 backendId 로 이 프로세스의
 * LOCAL_MODEL_SERVING_CONTRACTS 에서 찾는다(장비·모델이 같아야 한다). 못 찾으면 contractHash = `unresolved:<backendId>`, wire = no_response_format —
 * 계약이 있는 프로세스에서 다시 저장하면 evidence_key 가 바뀐다. 섀도·실전 실행(PR 2b·2c)은 자기 계약으로 같은 함수를 불러 배정의 evidence_key 와
 * 다르면 그 배정을 쓰지 않는다.
 */
export async function helperEvidencePartsFor(a: Pick<HelperAssignmentInput, "stage" | "deviceId" | "model">, backendId: string,
  env: Env = process.env): Promise<HelperEvidenceParts> {
  const { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } = await import("@/lib/crawl/agent-review-contract");
  const found = resolveLocalModelServingContract(backendId, env);
  const contract = found && found.model === a.model && found.physicalGroup === a.deviceId ? found : null;
  return Object.freeze({ stage: a.stage, model: a.model, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    wireVariant: contract?.capabilities.jsonSchema ? "json_schema" : "no_response_format",
    contractHash: contract ? localModelContractHash(contract) : `${HELPER_UNRESOLVED_CONTRACT_PREFIX}${backendId}` });
}

/**
 * 배정 저장(upsert). `expectedVersion`: 현재 행의 version(새 배정은 null) — 다르면 `model_helper_version_mismatch:<current|none>`.
 * 저장이 evidence_key 를 계산한다(helperEvidenceKey). 임계값·이력 설정만 바뀌면 version 만 올라가고(그 판의 자동 정지가 풀린다) evidence 는 유지,
 * 모델·프롬프트판·규칙판·wire 변형·계약이 바뀌면 evidence_key 가 바뀌고 같은 저장에서 mode 'live' 는 'shadow' 로 내려간다(승격 기록도 지운다).
 * 거절: `helper_route_is_primary`(장비 순위에서 도우미 경로가 rank 1) · `helper_route_unmapped`(정책에 경로 없음) ·
 * `helper_ai2_voter_not_in_fallbacks` · `helper_device_unconfigured`(장비 행 없음) · `helper_live_requires_promotion`(승격 없이 live).
 * 저장으로는 live 에 **들어갈** 수 없다(이미 live 인 행의 같은 evidence 재저장만 live 를 유지한다) — 승격은 PR 2c 의 promote 경로만 한다.
 * 감사 action `model-helper-save`, target = assignment_id. `options.env` 는 계약을 찾는 환경(기본 process.env, 시험용).
 */
export async function saveHelperAssignment(tx: ProductTransaction, input: unknown, expectedVersion: number | null, actor: string,
  options: Readonly<{ env?: Env }> = {}): Promise<{ before: HelperAssignmentRow | null; after: HelperAssignmentRow }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  checkActor(actor, "model_helper_invalid");
  if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) fail("model_helper_version_mismatch:invalid");
  const policy = await lockForWrite(tx);
  const parsed = parseHelperAssignment(input);
  const [existing] = await tx.select().from(modelHelperAssignments)
    .where(eq(modelHelperAssignments.assignmentId, parsed.assignmentId)).for("update");
  const before = existing ? toRow(existing) : null;
  if (before && before.stage !== parsed.stage) fail("model_helper_invalid:stage");
  if (before && before.deviceId !== parsed.deviceId) fail("model_helper_invalid:deviceId");
  const backendId = await validateHelperRoutes(tx, policy, parsed);
  const evidenceKey = helperEvidenceKey(await helperEvidencePartsFor(parsed, backendId, options.env));
  const evidenceChanged = before !== null && before.evidenceKey !== evidenceKey;
  let mode: HelperMode = parsed.mode;
  if (parsed.mode === "live") {
    if (before?.mode !== "live" || before.promotedAt === null) refuse("helper_live_requires_promotion");
    if (evidenceChanged) mode = "shadow";
  }
  if (mode === "live" && parsed.stage === "ai2") {
    const { getSettings } = await import("@/lib/crawl/settings");
    const fallbacks = (await getSettings()).secondReview.fallbacks ?? [];
    if (!fallbacks.some(voter => voter.provider === parsed.liveProvider && voter.model === parsed.model)) refuse("helper_ai2_voter_not_in_fallbacks");
  }
  const current = before?.version ?? null;
  if (current !== expectedVersion) fail(`model_helper_version_mismatch:${current ?? "none"}`);
  if (current !== null && current >= VERSION_MAX) fail("model_helper_version_exhausted");
  const keepPromotion = existing !== undefined && !evidenceChanged;
  const values = {
    stage: parsed.stage, deviceId: parsed.deviceId, model: parsed.model, shadowRouteId: parsed.shadowRouteId, liveRouteId: parsed.liveRouteId,
    liveProvider: parsed.liveProvider, mode, maxSlots: parsed.maxSlots, perTick: parsed.perTick, shadowPerHour: parsed.shadowPerHour,
    minShadowSamples: parsed.minShadowSamples, minAgreement: parsed.minAgreement, maxWrongApproval: parsed.maxWrongApproval,
    maxWrongRejection: parsed.maxWrongRejection, maxUnknownRate: parsed.maxUnknownRate, maxFailureRate: parsed.maxFailureRate,
    maxLiveDisagreement: parsed.maxLiveDisagreement, enterSamples: parsed.enterSamples, exitSamples: parsed.exitSamples,
    minHelpMs: parsed.minHelpMs, reenterCooldownMs: parsed.reenterCooldownMs, evidenceKey, note: parsed.note, updatedBy: actor,
    promotedEvidence: keepPromotion ? existing.promotedEvidence : null, promotedAt: keepPromotion ? existing.promotedAt : null,
    promotedBy: keepPromotion ? existing.promotedBy : null,
  };
  const [saved] = existing
    ? await tx.update(modelHelperAssignments).set({ ...values, version: sql`${modelHelperAssignments.version} + 1`, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(modelHelperAssignments.assignmentId, parsed.assignmentId), eq(modelHelperAssignments.version, existing.version))).returning()
    : await tx.insert(modelHelperAssignments).values({ assignmentId: parsed.assignmentId, ...values }).returning();
  if (!saved) return fail(`model_helper_version_mismatch:${current ?? "none"}`);
  const after = toRow(saved);
  await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: HELPER_SAVE_AUDIT_ACTION, target: parsed.assignmentId,
    detail: { version: after.version, expectedVersion, before: auditRow(before), after: auditRow(after), evidenceChanged,
      modeDemoted: parsed.mode !== mode } }));
  return { before, after };
}

/**
 * 배정의 mode 만 바꾼다(관리자 버튼: 섀도 시작·섀도로 내리기·끄기). 'live' 승격은 PR 2c 의 promote 경로만 한다(`model_helper_invalid:mode`).
 * version 을 올린다(그 판의 자동 정지가 풀린다 = 「자동 정지 해제」). 'shadow' 는 저장과 같은 경로 검증을 다시 하고, 'off' 는 검증 없이 언제나 된다
 * (정책·장비가 바뀌어도 끌 수 있다). evidence_key·승격 기록은 바꾸지 않는다. 감사 action `model-helper-mode`.
 */
export async function setHelperMode(tx: ProductTransaction, assignmentId: string, mode: Exclude<HelperMode, "live">, expectedVersion: number, actor: string):
  Promise<{ before: HelperAssignmentRow; after: HelperAssignmentRow }> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  checkActor(actor, "model_helper_invalid");
  if (typeof assignmentId !== "string" || !HELPER_ASSIGNMENT_ID_PATTERN.test(assignmentId)) fail("model_helper_invalid:assignmentId");
  if (mode !== "off" && mode !== "shadow") fail("model_helper_invalid:mode");
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) fail("model_helper_version_mismatch:invalid");
  const policy = await lockForWrite(tx);
  const [existing] = await tx.select().from(modelHelperAssignments).where(eq(modelHelperAssignments.assignmentId, assignmentId)).for("update");
  if (!existing) return fail("model_helper_version_mismatch:none");
  const before = toRow(existing);
  if (mode === "shadow") await validateHelperRoutes(tx, policy, before);
  if (before.version !== expectedVersion) fail(`model_helper_version_mismatch:${before.version}`);
  if (before.version >= VERSION_MAX) fail("model_helper_version_exhausted");
  const [saved] = await tx.update(modelHelperAssignments).set({ mode, updatedBy: actor, version: sql`${modelHelperAssignments.version} + 1`,
    updatedAt: sql`clock_timestamp()` }).where(and(eq(modelHelperAssignments.assignmentId, assignmentId),
    eq(modelHelperAssignments.version, existing.version))).returning();
  if (!saved) return fail(`model_helper_version_mismatch:${before.version}`);
  const after = toRow(saved);
  await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: HELPER_MODE_AUDIT_ACTION, target: assignmentId,
    detail: { version: after.version, expectedVersion, before: auditRow(before), after: auditRow(after), from: before.mode, to: after.mode } }));
  return { before, after };
}

/** 모든 배정(device_id, stage 순). tx 가 없으면 primary 에서 잠그지 않고 읽는다. */
export async function listHelperAssignments(tx?: ProductTransaction): Promise<HelperAssignmentRow[]> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const load = async (reader: Reader) => (await reader.select().from(modelHelperAssignments)
    .orderBy(asc(modelHelperAssignments.deviceId), asc(modelHelperAssignments.stage), asc(modelHelperAssignments.assignmentId))).map(toRow);
  return tx ? load(tx) : onPrimary(() => load(db));
}

/** 배정이 있는 모든 장비의 도우미 경로 상태 — 한 문장(LATERAL + helperGateStatesSql), 잠그지 않는다. */
async function allGateStates(reader: Reader): Promise<HelperGateState[]> {
  const rows = await reader.execute<HelperGateStateRow>(sql`SELECT x.* FROM (SELECT DISTINCT a.device_id FROM model_helper_assignments a) ids,
    LATERAL (${helperGateStatesSql(sql`ids.device_id`)}) x ORDER BY x.assignment_id, x.kind`);
  return rows.map(helperGateStateFromRow);
}

/** 도우미 경로 상태(helperGateStatesSql). deviceId 가 없으면 배정이 있는 모든 장비(한 문장, LATERAL). primary 에서 잠그지 않고 읽는다. */
export async function readHelperGateStates(deviceId?: string): Promise<HelperGateState[]> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  if (deviceId !== undefined && (typeof deviceId !== "string" || !deviceId || deviceId.length > 120)) fail("model_helper_invalid:deviceId");
  return onPrimary(async () => deviceId === undefined ? allGateStates(db)
    : (await db.execute<HelperGateStateRow>(helperGateStatesSql(deviceId))).map(helperGateStateFromRow));
}

const controlOf = (row: typeof modelSupervisorControl.$inferSelect): SupervisorControlRow => Object.freeze({
  enabled: row.enabled, signalPrincipal: row.signalPrincipal, signalTtlMs: row.signalTtlMs, loopMs: row.loopMs,
  ownerInstanceId: row.ownerInstanceId, ownerBootId: row.ownerBootId, epoch: Number(row.epoch), leaseUntil: iso(row.leaseUntil),
  heartbeatAt: iso(row.heartbeatAt), loopSeq: Number(row.loopSeq), release: row.release, updatedBy: row.updatedBy, updatedAt: isoRequired(row.updatedAt),
});

/**
 * 관리자 쪽 control 변경(enabled·signal_ttl_ms·loop_ms). 합친 값이 loop_ms × 2 ≤ signal_ttl_ms 를 지켜야 한다(`model_supervisor_invalid:loopMs`).
 * lease 열은 건드리지 않는다. 끄면 다음 입장 TX 부터 새 도우미 grant 가 없다 — 돌고 있는 호출은 끝까지 간다. 감사 action `model-supervisor-toggle`,
 * target = `model_supervisor_control`. 잠금 순서는 저장과 같다(fence → model_capacity_control → model_supervisor_control).
 */
export async function setSupervisorControl(tx: ProductTransaction, patch: SupervisorControlPatch, actor: string): Promise<void> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  checkActor(actor, "model_supervisor_invalid");
  await lockForWrite(tx);
  const parsed = supervisorControlPatchSchema.safeParse(patch);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(`model_supervisor_invalid:${issue?.path.length ? issue.path.map(String).join(".") : "root"}`);
  }
  const value = parsed.data;
  const [row] = await tx.select().from(modelSupervisorControl).where(eq(modelSupervisorControl.id, SUPERVISOR_CONTROL_ID)).for("update");
  if (!row) return fail("model_supervisor_control_missing");
  const next = { enabled: value.enabled ?? row.enabled, signalTtlMs: value.signalTtlMs ?? row.signalTtlMs, loopMs: value.loopMs ?? row.loopMs };
  if (!supervisorControlTimingValid(next)) fail("model_supervisor_invalid:loopMs");
  await tx.update(modelSupervisorControl).set({ ...next, updatedBy: actor, updatedAt: sql`clock_timestamp()` })
    .where(eq(modelSupervisorControl.id, SUPERVISOR_CONTROL_ID));
  await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: SUPERVISOR_TOGGLE_AUDIT_ACTION, target: "model_supervisor_control",
    detail: { before: { enabled: row.enabled, signalTtlMs: row.signalTtlMs, loopMs: row.loopMs }, after: next } }));
}

const signalOf = (row: typeof modelHelperSignals.$inferSelect): HelperSignalRow => Object.freeze({
  assignmentId: row.assignmentId, assignmentVersion: Number(row.assignmentVersion), supervisorEpoch: Number(row.supervisorEpoch),
  verdict: row.verdict, reason: row.reason, streak: row.streak, stateSince: isoRequired(row.stateSince), lastExitAt: iso(row.lastExitAt),
  metrics: Object.freeze({ ...row.metrics }) as HelperMetrics, observedAt: isoRequired(row.observedAt), validUntil: isoRequired(row.validUntil),
  writtenBy: row.writtenBy,
});
const deviceSignalOf = (row: typeof modelDeviceSignals.$inferSelect): DeviceSignalRow => Object.freeze({
  deviceId: row.deviceId, supervisorEpoch: Number(row.supervisorEpoch), primaryDemand: row.primaryDemand, backlog: row.backlog,
  metrics: Object.freeze({ ...row.metrics }) as HelperMetrics, observedAt: isoRequired(row.observedAt), validUntil: isoRequired(row.validUntil),
  writtenBy: row.writtenBy,
});
const roleDemandOf = (row: typeof modelRoleDemand.$inferSelect): RoleDemandRow => Object.freeze({
  roleId: row.roleId, deviceId: row.deviceId, backlog: row.backlog, oldestAgeMs: row.oldestAgeMs === null ? null : Number(row.oldestAgeMs),
  metrics: Object.freeze({ ...row.metrics }) as RoleDemandMetrics, observedAt: isoRequired(row.observedAt), validUntil: isoRequired(row.validUntil),
  writtenBy: row.writtenBy,
});
const stopOf = (row: typeof modelHelperStops.$inferSelect): HelperStopRow => Object.freeze({
  id: Number(row.id), assignmentId: row.assignmentId, assignmentVersion: Number(row.assignmentVersion), effect: row.effect, reason: row.reason,
  evidence: Object.freeze({ ...row.evidence }), createdAt: isoRequired(row.createdAt), writtenBy: row.writtenBy,
});

/** 관리자 화면·pipeline-control status 의 한 번 읽기(REPEATABLE READ READ ONLY 한 TX 또는 주어진 tx). control 행이 없으면 `model_supervisor_control_missing`. */
export async function readHelperStatusSnapshot(tx?: ProductTransaction): Promise<HelperStatusSnapshot> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const load = async (reader: Reader): Promise<HelperStatusSnapshot> => {
    const [clock] = await reader.execute<{ now_ms: string | number }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms`);
    const [control] = await reader.select().from(modelSupervisorControl).where(eq(modelSupervisorControl.id, SUPERVISOR_CONTROL_ID));
    if (!control) return fail("model_supervisor_control_missing");
    const assignments = (await reader.select().from(modelHelperAssignments)
      .orderBy(asc(modelHelperAssignments.deviceId), asc(modelHelperAssignments.stage), asc(modelHelperAssignments.assignmentId))).map(toRow);
    const signals = (await reader.select().from(modelHelperSignals).orderBy(asc(modelHelperSignals.assignmentId))).map(signalOf);
    // 현재 배정 version 의 정지 행만(다시 저장한 옛 판의 정지는 더 걸리지 않는다)
    const stops = (await reader.select({ stop: modelHelperStops }).from(modelHelperStops).innerJoin(modelHelperAssignments,
      and(eq(modelHelperAssignments.assignmentId, modelHelperStops.assignmentId), eq(modelHelperAssignments.version, modelHelperStops.assignmentVersion)))
      .orderBy(asc(modelHelperStops.id))).map(row => stopOf(row.stop));
    const deviceSignals = (await reader.select().from(modelDeviceSignals).orderBy(asc(modelDeviceSignals.deviceId))).map(deviceSignalOf);
    const roleDemand = (await reader.select().from(modelRoleDemand).orderBy(asc(modelRoleDemand.roleId))).map(roleDemandOf);
    const gates = await allGateStates(reader);
    return Object.freeze({ nowMs: Number(clock.now_ms), control: controlOf(control), assignments: Object.freeze(assignments),
      signals: Object.freeze(signals), stops: Object.freeze(stops), deviceSignals: Object.freeze(deviceSignals),
      roleDemand: Object.freeze(roleDemand), gates: Object.freeze(gates) });
  };
  return tx ? load(tx) : onPrimary(() => db.transaction(load, { isolationLevel: "repeatable read", accessMode: "read only" }));
}

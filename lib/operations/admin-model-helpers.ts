import { db, onPrimary } from "@/lib/db";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import {
  HELPER_AUDIT_ACTIONS, HELPER_MODES, HELPER_ROUTE_DEFAULTS, HELPER_STAGES, HELPER_ASSIGNMENT_ID_PATTERN, HELPER_NOTE_MAX,
  helperAssignmentSchema, helperSignalStaleness, deviceSignalUsable, roleDemandFresh, supervisorControlPatchSchema, supervisorControlTimingValid,
  type HelperAssignmentInput, type HelperAssignmentRow, type HelperAuditAction, type HelperGateState, type HelperMetrics, type HelperMode,
  type HelperReason, type HelperSaveRefusal, type HelperSignalStaleness, type HelperStage, type HelperStatusSnapshot, type HelperStopEffect,
  type HelperVerdict, type SupervisorControlPatch,
} from "@/lib/llm/capacity-helpers";
import { logger } from "@/lib/observability/logger";
import { adminLog, settingsChanges, type AdminLogRow } from "./admin-log";
import { DrWriterFencedError } from "./dr/epoch";

/**
 * 관리자 「도우미 장비」(/admin/models/helpers) 화면 모형 — PR 2a WP-2a-C (Layer B).
 *
 * 쉬는 장비(예: M3 DeepSeek 이 사람 검수를 끝내고 쉴 때)가 1차·2차 검수를 돕게 하는 배정(model_helper_assignments)과 Oracle 감시자
 * control(model_supervisor_control)을 보이고 바꾼다. 원칙(pr2-plan §0): 감시자 신호는 도우미 경로를 *열거나* 빌려주기를 *줄일* 뿐 우선 역할 일을
 * 막지 못한다 — 신호가 없거나·만료됐거나·다른 epoch·판·계정이면 도우미는 닫힌다(fail-closed). 그래서 이 화면의 모든 "열림"은 DB 가 판정한
 * helper_gate(스냅샷의 gates)를 그대로 보이고, 이 모듈의 TS 판정(helperSignalStaleness 등)은 "왜 닫혔나"를 글자로 만드는 데만 쓴다.
 *
 * - 상태는 WP-2a-A 의 readHelperStatusSnapshot 한 번(REPEATABLE READ READ ONLY 한 TX, nowMs = 그 읽기의 DB 시계)에서만 만든다.
 * - 저장(배정 저장·모드 바꿈·자동 정지 해제·감시자 스위치·순환 설정)은 WP-2a-A 저장소 함수를 쓰기 TX 하나에서 한 번 부른다. 그 안이 replay 거부 →
 *   DR fence SHARE → control FOR UPDATE → 검증 → 행 FOR UPDATE·CAS → 쓰기 → operations_audit 한 줄을 모두 한다 — 여기서는 감사 줄을 **또 쓰지 않는다**.
 * - 거절 코드 → 한국어 문장은 modelHelperIssueMessage 한 곳에서 만든다(모르는 코드는 그대로 보인다).
 * - 「실전」(live) 승격은 PR 2c 의 promote 경로다. 이 화면은 off·shadow 만 바꾸고 승격 단추는 꺼 둔다.
 *
 * 이 모듈은 DB 를 읽으므로 서버에서만 import 한다. 클라이언트 폼은 여기서 만든 값(문자열·숫자)과 `import type` 만 쓴다.
 * WP-2a-A 저장소(@/lib/llm/capacity-helpers-repository)는 늦게(동적 import) 올린다 — 테스트는 setCapacityHelpersRepositoryForTest 로
 * 같은 계약의 메모리 구현을 끼운다(lib/operations/admin-capacity-devices.ts 와 같은 꼴).
 */

// ---------- 저장소 계약(WP-2a-A, lib/llm/capacity-helpers-repository.ts 의 고정 서명) ----------

export type HelperRepository = {
  saveHelperAssignment(tx: ProductTransaction, input: unknown, expectedVersion: number | null, actor: string):
    Promise<{ before: HelperAssignmentRow | null; after: HelperAssignmentRow }>;
  setHelperMode(tx: ProductTransaction, assignmentId: string, mode: Exclude<HelperMode, "live">, expectedVersion: number, actor: string):
    Promise<{ before: HelperAssignmentRow; after: HelperAssignmentRow }>;
  listHelperAssignments(tx?: ProductTransaction): Promise<HelperAssignmentRow[]>;
  setSupervisorControl(tx: ProductTransaction, patch: SupervisorControlPatch, actor: string): Promise<void>;
  readHelperStatusSnapshot(tx?: ProductTransaction): Promise<HelperStatusSnapshot>;
};
export const HELPER_REPOSITORY_MODULE = "@/lib/llm/capacity-helpers-repository";
let repositoryForTest: HelperRepository | null = null;
/** 테스트 전용 — 같은 계약의 메모리 구현을 끼운다(setCapacityDeviceRepositoryForTest 와 같은 꼴). null 이면 진짜 모듈을 올린다 */
export function setCapacityHelpersRepositoryForTest(repository: HelperRepository | null): void { repositoryForTest = repository; }
async function helperRepository(): Promise<HelperRepository> {
  if (repositoryForTest) return repositoryForTest;
  return import("@/lib/llm/capacity-helpers-repository");
}

// ---------- 이름(화면·감사 줄·거절 문장이 같은 말을 쓴다) ----------

export const HELPER_STAGE_LABELS: Readonly<Record<HelperStage, string>> = { ai1: "1차 검수", ai2: "2차 검수" };
export const HELPER_MODE_LABELS: Readonly<Record<HelperMode, string>> = { off: "꺼짐", shadow: "섀도", live: "실전" };
export const HELPER_VERDICT_LABELS: Readonly<Record<HelperVerdict, string>> = { help: "돕는 중", shadow_only: "섀도만", hold: "쉬는 중" };
/** pr2-plan §5.2 의 이유 이름 */
export const HELPER_REASON_LABELS: Readonly<Record<HelperReason, string>> = {
  primary_full: "주 장비가 가득 참", primary_not_full: "주 장비 여유", helper_own_work: "자기 일이 있음", stale_inputs: "관측이 오래됨",
  auto_stopped: "자동 정지됨", unknown_rate: "확인 못함 비율 초과", failure_rate: "실패 비율 초과", quality_regression: "품질 저하",
  mode_off: "꺼짐", supervisor_off: "감시자 꺼짐",
};
/** 신호를 쓸 수 없는 이유(helperSignalStaleness) — 이때 도우미는 판정과 관계없이 쉰다 */
export const HELPER_STALENESS_LABELS: Readonly<Record<HelperSignalStaleness, string>> = {
  supervisor_missing: "감시자 control 행이 없음", supervisor_disabled: "감시자 꺼짐", lease_expired: "감시자 lease 만료(감시자가 돌지 않음)",
  assignment_missing: "배정 없음", signal_missing: "아직 신호 없음", epoch_mismatch: "다른 epoch 의 신호(감시자가 바뀜)",
  principal_mismatch: "다른 계정이 쓴 신호", version_mismatch: "저장 전 판의 신호(다음 순환에 갱신)", signal_expired: "신호 만료",
};
export const HELPER_STOP_EFFECT_LABELS: Readonly<Record<HelperStopEffect, string>> = {
  stop: "자동 정지(실전·섀도 모두 닫힘)", demote_to_shadow: "실전 → 섀도 강등(섀도 표본은 계속)",
};
export const HELPER_AUDIT_ACTION_LABELS: Readonly<Record<HelperAuditAction, string>> = {
  "model-helper-save": "배정 저장", "model-helper-mode": "모드 바꿈", "model-helper-promote": "실전 승격", "model-supervisor-toggle": "감시자 설정",
};
/** 역할 수요 beacon(model_role_demand.role_id) 이름 — ROLE_DEMAND_BEACONS 의 두 역할 */
export const HELPER_ROLE_LABELS: Readonly<Record<string, string>> = { "human-review": "사람 검수 대기", ai1: "1차 검수 대기" };
const roleLabel = (roleId: string) => HELPER_ROLE_LABELS[roleId] ?? `${roleId} 대기`;

export const HELPER_FIELD_LABELS: Readonly<Record<string, string>> = {
  assignmentId: "배정 이름", stage: "돕는 단계", deviceId: "도우미 장비", model: "모델", shadowRouteId: "섀도 경로", liveRouteId: "실전 경로",
  liveProvider: "실전 공급자", mode: "모드", maxSlots: "최대 칸", perTick: "한 틱 최대 건수", shadowPerHour: "시간당 섀도 표본",
  minShadowSamples: "승격 최소 표본", minAgreement: "최소 일치율", maxWrongApproval: "잘못 승인 상한", maxWrongRejection: "잘못 거절 상한",
  maxUnknownRate: "확인 못함 비율 상한", maxFailureRate: "실패 비율 상한", maxLiveDisagreement: "실전 2차 불일치 상한",
  enterSamples: "들어가는 표본 수", exitSamples: "나오는 표본 수", minHelpMs: "최소 유지 시간", reenterCooldownMs: "재진입 대기", note: "메모",
  enabled: "감시자 전체 스위치", signalTtlMs: "신호 유효 시간", loopMs: "순환 간격",
};
export const helperFieldLabel = (path: string): string => HELPER_FIELD_LABELS[path.split(".")[0]] ?? path;

/** 비율 칸(numeric(4,3)) — 폼은 백분율(소수 한 자리까지)로 받고 저장은 0~1 */
export const HELPER_RATIO_FIELDS = Object.freeze(["minAgreement", "maxWrongApproval", "maxWrongRejection", "maxUnknownRate", "maxFailureRate",
  "maxLiveDisagreement"] as const);
export type HelperRatioField = (typeof HELPER_RATIO_FIELDS)[number];
export const HELPER_INT_FIELDS = Object.freeze(["maxSlots", "perTick", "shadowPerHour", "minShadowSamples", "enterSamples", "exitSamples"] as const);
export type HelperIntField = (typeof HELPER_INT_FIELDS)[number];
/** ms 칸 — 폼은 초로 받는다. 폼 칸 이름은 <field 에서 Ms 를 뺀 것>Seconds */
export const HELPER_MS_FIELDS = Object.freeze(["minHelpMs", "reenterCooldownMs"] as const);
export type HelperMsField = (typeof HELPER_MS_FIELDS)[number];
const TEXT_FIELDS = Object.freeze(["assignmentId", "stage", "deviceId", "model", "shadowRouteId", "liveRouteId", "liveProvider", "mode"] as const);
export const helperSecondsFieldName = (field: HelperMsField): string => `${field.slice(0, -2)}Seconds`;
export const helperPercentFieldName = (field: HelperRatioField): string => `${field}Pct`;
/** 배정 입력의 칸 목록 — zod schema 의 shape 하나가 기준이다(strict 라 행에서 입력을 만들 때 이 칸만 고른다) */
export const HELPER_INPUT_KEYS = Object.freeze(Object.keys(helperAssignmentSchema.shape) as (keyof HelperAssignmentInput)[]);

/** 배정 칸의 기본값 — WP-2a-A zod 의 default 를 그대로 읽는다(단일 출처) */
export type HelperSettingsDefaults = Pick<HelperAssignmentInput, HelperIntField | HelperRatioField | HelperMsField | "mode" | "note">;
export const HELPER_SETTING_DEFAULTS: Readonly<HelperSettingsDefaults> = (() => {
  const parsed = helperAssignmentSchema.parse({ assignmentId: "defaults", stage: "ai1", deviceId: "defaults", model: "defaults",
    shadowRouteId: "defaults-shadow", liveRouteId: "defaults-live", liveProvider: "defaults" });
  const pick = <K extends keyof HelperSettingsDefaults>(keys: readonly K[]) => Object.fromEntries(keys.map(key => [key, parsed[key]]));
  return Object.freeze({ ...pick([...HELPER_INT_FIELDS, ...HELPER_RATIO_FIELDS, ...HELPER_MS_FIELDS]), mode: parsed.mode, note: parsed.note } as HelperSettingsDefaults);
})();

// ---------- 글자 모양 ----------

const fmt = (value: number) => value.toLocaleString("ko-KR");
/** 0~1 비율 → "95%", "0.5%" */
export const percentLabel = (ratio: number | null | undefined): string =>
  ratio === null || ratio === undefined || !Number.isFinite(ratio) ? "—" : `${fmt(Math.round(ratio * 1000) / 10)}%`;
/** 0~1 비율 → 폼의 백분율 글자("95", "0.5") */
export const ratioToPercentInput = (ratio: number): string => String(Math.round(ratio * 1000) / 10);
/** ms → 초 글자("120", "1.5") */
export const msToSecondsInput = (ms: number | null | undefined): string => ms === null || ms === undefined ? "" : String(Math.round(ms) / 1000);
/** ms 나이 → "12초 전", "3분 4초 전" */
export function ageLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초 전`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}시간 ${minutes % 60}분 전` : `${fmt(Math.floor(hours / 24))}일 전`;
}
/** ms 길이 → "45초", "2분" */
export function durationLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const seconds = Math.round(ms) / 1000;
  return seconds >= 60 && Number.isInteger(seconds / 60) ? `${fmt(seconds / 60)}분` : `${fmt(seconds)}초`;
}
const timeMs = (value: string | null | undefined): number => value ? Date.parse(value) : Number.NaN;
const ageOf = (nowMs: number, value: string | null | undefined): number | null => {
  const at = timeMs(value);
  return Number.isFinite(at) ? Math.max(0, nowMs - at) : null;
};
const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** 감사 줄·토스트의 값 글자 — 비율은 %, ms 는 초, 모드·단계·스위치는 한국어 */
export function helperValueLabel(path: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "없음";
  const head = path.split(".")[0];
  if ((HELPER_RATIO_FIELDS as readonly string[]).includes(head) && typeof value === "number") return percentLabel(value);
  if ([...HELPER_MS_FIELDS, "signalTtlMs", "loopMs"].includes(head) && typeof value === "number") return durationLabel(value);
  if (head === "mode" && typeof value === "string") return HELPER_MODE_LABELS[value as HelperMode] ?? value;
  if (head === "stage" && typeof value === "string") return HELPER_STAGE_LABELS[value as HelperStage] ?? value;
  if (head === "enabled" && typeof value === "boolean") return value ? "켜짐" : "꺼짐";
  if (typeof value === "number") return fmt(value);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

// ---------- 화면 모형 ----------

/**
 * 감시자가 신호 metrics(jsonb, 평평한 수·글자·참거짓)에 적어 주면 화면이 읽는 열쇠. 없으면 "—"이고 전체 지표는 따로 그대로 보인다.
 * 쓰는 쪽은 WP-2a-B 감시자(decide.ts)다 — 이름이 다르면 이 표만 맞추면 된다.
 */
export const HELPER_METRIC_KEYS = Object.freeze({
  primaryFull: "primaryFull", primaryActive: "primaryActive", primaryLimit: "primaryLimit", primaryWaiting: "primaryWaiting",
  primaryDevices: "primaryDevices", ownBacklog: "ownBacklog",
  shadowSamples: "shadowSamples", shadowAgreement: "shadowAgreement", shadowWrongApproval: "shadowWrongApproval",
  shadowWrongRejection: "shadowWrongRejection", shadowUnknownRate: "shadowUnknownRate", shadowFailureRate: "shadowFailureRate",
} as const);
const METRICS_SHOWN_MAX = 40;

export type SupervisorBadge = "ok" | "late" | "off" | "principal_mismatch";
export const SUPERVISOR_BADGE_LABELS: Readonly<Record<SupervisorBadge, string>> = {
  ok: "정상", late: "늦음", off: "꺼짐", principal_mismatch: "계정 불일치",
};
export type DeviceDemandView = { deviceId: string; primaryDemand: boolean; backlog: number; usable: boolean; ageMs: number | null; reason: string | null };
export type RoleDemandView = { roleId: string; label: string; deviceId: string; backlog: number; oldestAgeMs: number | null; fresh: boolean; ageMs: number | null;
  writtenBy: string };
export type SupervisorView = {
  enabled: boolean; badge: SupervisorBadge; badgeLabel: string; badgeDetail: string;
  location: string; instanceId: string | null; bootId: string | null; epoch: number; loopSeq: number; release: string | null;
  leaseAlive: boolean; leaseUntil: string | null; leaseLeftMs: number | null; heartbeatAgeMs: number | null; lastSignalAgeMs: number | null;
  signalPrincipal: string; signalTtlMs: number; loopMs: number; updatedBy: string; updatedAt: string;
  foreignWriters: string[]; deviceDemand: DeviceDemandView[]; roleDemand: RoleDemandView[];
};
export type HelperGateView = { ok: boolean; active: number; maxSlots: number; routeId: string; provider: string };
export type HelperStopView = { id: number; assignmentId: string; version: number; effect: HelperStopEffect; effectLabel: string; reason: string;
  reasonLabel: string; createdAt: string; writtenBy: string; evidence: string };
export type HelperRowView = {
  assignmentId: string; stage: HelperStage; stageLabel: string; deviceId: string; model: string; mode: HelperMode; modeLabel: string;
  version: number; evidenceKey: string; promotedAt: string | null; updatedBy: string; updatedAt: string;
  shadowRouteId: string; liveRouteId: string; liveProvider: string;
  /** 신호를 쓸 수 있으면 그 판정, 아니면 hold(쉬는 중) */
  verdict: HelperVerdict; verdictLabel: string; reasonLabel: string;
  signalUsable: boolean; staleness: HelperSignalStaleness | null; signalAgeMs: number | null; signalLeftMs: number | null; streak: number | null;
  gates: { live: HelperGateView | null; shadow: HelperGateView | null };
  primary: { full: boolean | null; active: number | null; limit: number | null; waiting: number | null; devices: number | null };
  ownWork: { label: string; backlog: number | null; fresh: boolean; ageMs: number | null } | null;
  deviceDemand: DeviceDemandView | null;
  shadow: { samples: number | null; agreement: number | null; wrongApproval: number | null; wrongRejection: number | null;
    unknownRate: number | null; failureRate: number | null };
  stops: HelperStopView[];
  metrics: [string, string][];
  /** 폼 값(저장된 배정 입력) */
  settings: HelperAssignmentInput;
  issues: string[];
};
export type HelperAuditView = { id: number; actor: string; at: string; ok: boolean; action: string; actionLabel: string; target: string;
  version: number | null; changes: string[]; error: string | null };
export type HelperRouteDefaults = Readonly<Record<HelperStage, Readonly<{ shadowRouteId: string; liveRouteId: string; liveProvider: string }>>>;
export type ModelHelpersAdminView = {
  nowMs: number; snapshotError: string | null; supervisor: SupervisorView | null; helpers: HelperRowView[]; stops: HelperStopView[];
  audit: HelperAuditView[]; counts: { help: number; shadowOnly: number; hold: number }; issues: string[];
  defaults: HelperSettingsDefaults; routeDefaults: HelperRouteDefaults;
};
export type ModelHelpersViewInput = { snapshot: HelperStatusSnapshot | null; snapshotError?: string | null; audit?: readonly AdminLogRow[]; now?: Date };

const AUDIT_ROWS = 20;

/** 감시자 인스턴스 이름으로 위치를 짐작한다(PR 2 는 Oracle 에서만 돈다 — pr2-plan §3.1) */
export function supervisorLocation(instanceId: string | null): string {
  if (!instanceId) return "없음(lease 를 잡은 감시자가 없습니다)";
  return /oracle/i.test(instanceId) ? "Oracle" : "Oracle 아님(인스턴스 이름 확인)";
}

function supervisorView(snapshot: HelperStatusSnapshot): SupervisorView {
  const { control, nowMs } = snapshot;
  const leaseAt = timeMs(control.leaseUntil);
  const leaseAlive = leaseAt > nowMs;
  const writers = [...snapshot.signals.map(signal => signal.writtenBy), ...snapshot.deviceSignals.map(signal => signal.writtenBy)];
  const foreignWriters = [...new Set(writers.filter(writer => writer !== control.signalPrincipal))].sort();
  const fresh = snapshot.signals.filter(signal => signal.supervisorEpoch === control.epoch && signal.writtenBy === control.signalPrincipal
    && timeMs(signal.validUntil) > nowMs);
  const observed = snapshot.signals.map(signal => timeMs(signal.observedAt)).filter(Number.isFinite);
  const lastSignalAgeMs = observed.length ? Math.max(0, nowMs - Math.max(...observed)) : null;
  let badge: SupervisorBadge = "ok";
  let badgeDetail = "lease 가 살아 있고 신호가 유효합니다.";
  if (!control.enabled) {
    badge = "off"; badgeDetail = "감시자 전체 스위치가 꺼져 있어 입장 판정이 모든 신호를 무시합니다 — 도우미는 모두 쉬고 우선 역할은 그대로입니다.";
  } else if (foreignWriters.length) {
    badge = "principal_mismatch";
    badgeDetail = `신호를 쓴 계정(${foreignWriters.join(", ")})이 signal_principal(${control.signalPrincipal})과 다릅니다 — 입장 판정은 그 신호를 쓰지 않습니다.`;
  } else if (!leaseAlive) {
    badge = "late"; badgeDetail = "감시자 lease 가 만료됐습니다(감시자가 돌지 않음) — 신호가 만료되어 도우미는 모두 쉽니다.";
  } else if (snapshot.assignments.length > 0 && fresh.length === 0) {
    badge = "late"; badgeDetail = "유효한 신호가 없습니다(신호 만료) — 도우미는 모두 쉽니다.";
  }
  const deviceDemand = snapshot.deviceSignals.map(signal => ({ deviceId: signal.deviceId, primaryDemand: signal.primaryDemand, backlog: signal.backlog,
    usable: deviceSignalUsable({ nowMs, control, signal }), ageMs: ageOf(nowMs, signal.observedAt),
    reason: typeof signal.metrics.reason === "string" ? signal.metrics.reason : null }))
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  const roleDemand = snapshot.roleDemand.map(beacon => ({ roleId: beacon.roleId, label: roleLabel(beacon.roleId), deviceId: beacon.deviceId,
    backlog: beacon.backlog, oldestAgeMs: beacon.oldestAgeMs, fresh: roleDemandFresh({ nowMs, beacon }), ageMs: ageOf(nowMs, beacon.observedAt),
    writtenBy: beacon.writtenBy }))
    .sort((a, b) => a.roleId.localeCompare(b.roleId));
  return { enabled: control.enabled, badge, badgeLabel: SUPERVISOR_BADGE_LABELS[badge], badgeDetail,
    location: supervisorLocation(control.ownerInstanceId), instanceId: control.ownerInstanceId, bootId: control.ownerBootId, epoch: control.epoch,
    loopSeq: control.loopSeq, release: control.release, leaseAlive, leaseUntil: control.leaseUntil,
    leaseLeftMs: Number.isFinite(leaseAt) ? leaseAt - nowMs : null, heartbeatAgeMs: ageOf(nowMs, control.heartbeatAt), lastSignalAgeMs,
    signalPrincipal: control.signalPrincipal, signalTtlMs: control.signalTtlMs, loopMs: control.loopMs, updatedBy: control.updatedBy,
    updatedAt: control.updatedAt, foreignWriters, deviceDemand, roleDemand };
}

const stopView = (stop: HelperStatusSnapshot["stops"][number]): HelperStopView => ({ id: stop.id, assignmentId: stop.assignmentId,
  version: stop.assignmentVersion, effect: stop.effect, effectLabel: HELPER_STOP_EFFECT_LABELS[stop.effect] ?? stop.effect, reason: stop.reason,
  reasonLabel: HELPER_REASON_LABELS[stop.reason] ?? stop.reason, createdAt: stop.createdAt, writtenBy: stop.writtenBy,
  // 감시자가 남긴 근거 — 화면에는 글자로만(마크업으로 해석하지 않는다)
  evidence: JSON.stringify(stop.evidence ?? {}) });

const gateView = (gate: HelperGateState | undefined): HelperGateView | null =>
  gate ? { ok: gate.ok, active: gate.active, maxSlots: gate.maxSlots, routeId: gate.routeId, provider: gate.provider } : null;

/** 저장된 배정 행 → 저장 입력(zod strict 의 칸만) */
export function helperInputOf(row: HelperAssignmentRow): HelperAssignmentInput {
  return Object.fromEntries(HELPER_INPUT_KEYS.map(key => [key, row[key]])) as HelperAssignmentInput;
}

function metricsList(metrics: HelperMetrics | undefined): [string, string][] {
  return Object.entries(metrics ?? {}).filter(([, value]) => ["number", "string", "boolean"].includes(typeof value))
    .sort(([a], [b]) => a.localeCompare(b)).slice(0, METRICS_SHOWN_MAX).map(([key, value]) => [key, String(value)]);
}

function helperRowView(snapshot: HelperStatusSnapshot, row: HelperAssignmentRow, supervisor: SupervisorView): HelperRowView {
  const { nowMs, control } = snapshot;
  const signal = snapshot.signals.find(entry => entry.assignmentId === row.assignmentId) ?? null;
  const staleness = helperSignalStaleness({ nowMs, control, assignment: row, signal });
  const usable = staleness === null && signal !== null;
  const metrics: HelperMetrics = signal?.metrics ?? {};
  const k = HELPER_METRIC_KEYS;
  const stops = snapshot.stops.filter(stop => stop.assignmentId === row.assignmentId && stop.assignmentVersion === row.version).map(stopView);
  const gates = { live: gateView(snapshot.gates.find(gate => gate.assignmentId === row.assignmentId && gate.kind === "live")),
    shadow: gateView(snapshot.gates.find(gate => gate.assignmentId === row.assignmentId && gate.kind === "shadow")) };
  // 자기 일 = 이 도우미 장비의 역할 beacon(예: human-review → m3-deepseek). 신선하지 않거나 없으면 감시자는 바쁨으로 본다(돕지 않는다)
  const beacon = snapshot.roleDemand.find(entry => entry.deviceId === row.deviceId) ?? null;
  const ownWork = beacon ? { label: roleLabel(beacon.roleId), backlog: beacon.backlog, fresh: roleDemandFresh({ nowMs, beacon }), ageMs: ageOf(nowMs, beacon.observedAt) }
    : finite(metrics[k.ownBacklog]) !== null ? { label: "자기 일 대기", backlog: finite(metrics[k.ownBacklog]), fresh: usable, ageMs: ageOf(nowMs, signal?.observedAt) } : null;
  const deviceDemand = supervisor.deviceDemand.find(entry => entry.deviceId === row.deviceId) ?? null;
  const verdict: HelperVerdict = usable ? signal!.verdict : "hold";
  const reasonLabel = usable ? HELPER_REASON_LABELS[signal!.reason] ?? signal!.reason : HELPER_STALENESS_LABELS[staleness!];
  const issues: string[] = [];
  if (stops.length) issues.push(`자동 정지 중(${stops.map(stop => stop.reasonLabel).join(", ")}) — 「자동 정지 해제」로 판을 올려야 풀립니다`);
  if (row.mode !== "off" && control.enabled && !beacon) issues.push("자기 일 beacon 이 없어 감시자가 이 장비를 바쁨으로 봅니다(돕지 않음)");
  else if (row.mode !== "off" && control.enabled && beacon && !roleDemandFresh({ nowMs, beacon }))
    issues.push(`자기 일 beacon(${beacon.roleId})이 오래돼 감시자가 이 장비를 바쁨으로 봅니다(돕지 않음)`);
  if (deviceDemand?.usable && deviceDemand.primaryDemand) issues.push(`자기 일 수요 신호(대기 ${fmt(deviceDemand.backlog)})가 있어 이 장비는 빌려주지 않습니다`);
  if (row.mode === "live" && !row.promotedAt) issues.push("실전인데 승격 기록이 없습니다 — 운영자에게 알려주세요");
  if (row.mode === "off" && (gates.live?.ok || gates.shadow?.ok)) issues.push("꺼진 배정인데 입장 판정이 경로를 열린 것으로 봅니다 — 운영자에게 알려주세요");
  return {
    assignmentId: row.assignmentId, stage: row.stage, stageLabel: HELPER_STAGE_LABELS[row.stage] ?? row.stage, deviceId: row.deviceId, model: row.model,
    mode: row.mode, modeLabel: HELPER_MODE_LABELS[row.mode] ?? row.mode, version: row.version, evidenceKey: row.evidenceKey, promotedAt: row.promotedAt,
    updatedBy: row.updatedBy, updatedAt: row.updatedAt, shadowRouteId: row.shadowRouteId, liveRouteId: row.liveRouteId, liveProvider: row.liveProvider,
    verdict, verdictLabel: HELPER_VERDICT_LABELS[verdict], reasonLabel, signalUsable: usable, staleness,
    signalAgeMs: ageOf(nowMs, signal?.observedAt), signalLeftMs: signal && Number.isFinite(timeMs(signal.validUntil)) ? timeMs(signal.validUntil) - nowMs : null,
    streak: signal?.streak ?? null, gates,
    primary: { full: typeof metrics[k.primaryFull] === "boolean" ? metrics[k.primaryFull] as boolean : null, active: finite(metrics[k.primaryActive]),
      limit: finite(metrics[k.primaryLimit]), waiting: finite(metrics[k.primaryWaiting]), devices: finite(metrics[k.primaryDevices]) },
    ownWork, deviceDemand,
    shadow: { samples: finite(metrics[k.shadowSamples]), agreement: finite(metrics[k.shadowAgreement]), wrongApproval: finite(metrics[k.shadowWrongApproval]),
      wrongRejection: finite(metrics[k.shadowWrongRejection]), unknownRate: finite(metrics[k.shadowUnknownRate]), failureRate: finite(metrics[k.shadowFailureRate]) },
    stops, metrics: metricsList(signal?.metrics), settings: helperInputOf(row), issues,
  };
}

/** 감사 detail 의 바뀐 값 — detail.changes([{path, before, after}])가 있으면 그것, 없으면 { before, after }(또는 감시자 { patch })에서 만든다 */
export function helperAuditChangeLines(row: Pick<AdminLogRow, "detail">): string[] {
  const detail = isPlainObject(row.detail) ? row.detail : {};
  const changes = Array.isArray(detail.changes) ? detail.changes as { path?: unknown; before?: unknown; after?: unknown }[]
    : isPlainObject(detail.after) ? settingsChanges(isPlainObject(detail.before) ? pickInputish(detail.before) : {}, pickInputish(detail.after))
    : isPlainObject(detail.patch) ? Object.entries(detail.patch).map(([path, after]) => ({ path, before: undefined, after })) : [];
  return changes.flatMap(change => {
    if (typeof change.path !== "string") return [];
    const before = helperValueLabel(change.path, change.before), after = helperValueLabel(change.path, change.after);
    if (change.before === undefined && "patch" in detail) return [`${helperFieldLabel(change.path)}: ${after}`];
    return before === after ? [] : [`${helperFieldLabel(change.path)}: ${before} → ${after}`];
  });
}
/** 감사 줄의 before/after 에서 사람이 읽을 칸만(version·시각·evidence 는 따로 보인다) */
const AUDIT_HIDDEN = new Set(["version", "evidenceKey", "createdAt", "updatedAt", "updatedBy", "promotedBy", "promotedAt", "promotedEvidence"]);
const pickInputish = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !AUDIT_HIDDEN.has(key)));

export function helperAuditView(rows: readonly AdminLogRow[]): HelperAuditView[] {
  return rows.slice(0, AUDIT_ROWS).map(row => {
    const detail = isPlainObject(row.detail) ? row.detail : {};
    const after = isPlainObject(detail.after) ? detail.after : {};
    const version = finite(detail.version) ?? finite(after.version);
    return { id: row.id, actor: row.actor, at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt), ok: row.ok,
      action: row.action, actionLabel: HELPER_AUDIT_ACTION_LABELS[row.action as HelperAuditAction] ?? row.action, target: String(row.target ?? ""),
      version, changes: helperAuditChangeLines(row), error: row.error ?? null };
  });
}

/** 순수 — DB 없이 시험한다. 스냅샷을 못 읽으면 그 이유만 보이고(읽기 전용) 화면은 뜬다 */
export function buildModelHelpersAdminView(input: ModelHelpersViewInput): ModelHelpersAdminView {
  const routeDefaults = HELPER_ROUTE_DEFAULTS as HelperRouteDefaults;
  const base = { defaults: { ...HELPER_SETTING_DEFAULTS }, routeDefaults, audit: helperAuditView(input.audit ?? []) };
  const snapshot = input.snapshot;
  if (!snapshot) {
    return { ...base, nowMs: (input.now ?? new Date()).getTime(), snapshotError: input.snapshotError ?? "model_helper_status_unreadable", supervisor: null,
      helpers: [], stops: [], counts: { help: 0, shadowOnly: 0, hold: 0 }, issues: [] };
  }
  const supervisor = supervisorView(snapshot);
  const helpers = [...snapshot.assignments].sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.stage.localeCompare(b.stage))
    .map(row => helperRowView(snapshot, row, supervisor));
  const current = new Map(snapshot.assignments.map(row => [row.assignmentId, row.version]));
  const stops = snapshot.stops.filter(stop => current.get(stop.assignmentId) === stop.assignmentVersion).map(stopView)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  const issues: string[] = [];
  if (supervisor.enabled && !supervisor.leaseAlive) issues.push("감시자가 켜져 있지만 lease 가 만료됐습니다 — Oracle 소비자 capacity-supervisor 를 확인하세요(도우미는 모두 쉼, 우선 역할은 영향 없음).");
  if (supervisor.enabled && snapshot.assignments.length === 0) issues.push("배정이 없어 감시자가 돌아도 바뀌는 것이 없습니다 — 아래 「새 배정」에서 꺼짐으로 먼저 만드세요.");
  if (supervisor.foreignWriters.length) issues.push(supervisor.badgeDetail);
  return { ...base, nowMs: snapshot.nowMs, snapshotError: null, supervisor, helpers, stops,
    counts: { help: helpers.filter(row => row.verdict === "help").length, shadowOnly: helpers.filter(row => row.verdict === "shadow_only").length,
      hold: helpers.filter(row => row.verdict === "hold").length }, issues };
}

const settle = <T>(work: Promise<T>) => work.then(value => ({ value, error: null as string | null }),
  (error: unknown) => ({ value: null as T | null, error: error instanceof Error ? error.message : String(error) }));

/** 화면 한 번 그리기 — 스냅샷(저장소 한 번 읽기)과 감사를 함께 읽는다. 스냅샷을 못 읽어도 화면은 뜬다(그 자리에 이유) */
export async function readModelHelpersAdminView(now = new Date()): Promise<ModelHelpersAdminView> {
  const repo = await settle(helperRepository());
  const [snapshot, audit] = await Promise.all([
    repo.value ? settle(repo.value.readHelperStatusSnapshot()) : Promise.resolve({ value: null, error: repo.error }),
    adminLog({ actions: [...HELPER_AUDIT_ACTIONS] }).catch(() => [] as AdminLogRow[]),
  ]);
  return buildModelHelpersAdminView({ snapshot: snapshot.value, snapshotError: snapshot.error, audit, now });
}

// ---------- 폼 → 저장 입력 ----------

type FormLike = { get(name: string): FormDataEntryValue | null };
const text = (value: FormDataEntryValue | null) => typeof value === "string" ? value.trim() : "";
const parseInt10 = (raw: string): number | undefined => /^-?\d{1,9}$/.test(raw.replace(/,/g, "")) ? Number(raw.replace(/,/g, "")) : undefined;
/** 백분율 글자(소수 한 자리까지) → 0~1 비율(소수 셋째 자리) */
export function percentInputToRatio(raw: string): number | undefined {
  const value = raw.replace(/,/g, "").replace(/%$/, "").trim();
  if (!/^\d{1,3}(\.\d)?$/.test(value)) return undefined;
  return Math.round(Number(value) * 10) / 1000;
}
/** 초 글자 → ms(0 이상) */
export function secondsInputToMs(raw: string): number | undefined {
  const value = raw.replace(/,/g, "").trim();
  if (!/^\d{1,7}(\.\d{1,3})?$/.test(value)) return undefined;
  return Math.round(Number(value) * 1000);
}
export function expectedVersionFromForm(form: FormLike, issues: string[]): number | null {
  const raw = text(form.get("expectedVersion"));
  if (!raw) return null;
  const parsed = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) { issues.push("판 번호(version)를 읽지 못했습니다. 새로고침해 주세요."); return null; }
  return parsed;
}
export type HelperFormParse = { input: Record<string, unknown> | null; expectedVersion: number | null; issues: string[] };

/**
 * 폼 칸 이름: assignmentId(비우면 <장비>:<단계>) · stage · deviceId · model · shadowRouteId · liveRouteId · liveProvider · mode(비우면 off) ·
 * expectedVersion(빈 값 = 새 배정, CAS 없음) · 정수 칸(maxSlots·perTick·shadowPerHour·minShadowSamples·enterSamples·exitSamples) ·
 * 백분율 칸 <비율>Pct(소수 한 자리까지) · 초 칸 minHelpSeconds·reenterCooldownSeconds · note. 범위·교차 검사의 기준은 WP-2a-A zod(저장 때)다 —
 * 여기서는 숫자 모양만 본다.
 */
export function helperAssignmentInputFromForm(form: FormLike): HelperFormParse {
  const issues: string[] = [];
  const expectedVersion = expectedVersionFromForm(form, issues);
  const values: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) values[field] = text(form.get(field));
  if (!values.stage) issues.push("돕는 단계를 골라주세요");
  if (!values.deviceId) issues.push("도우미 장비를 넣어주세요");
  if (!values.model) issues.push("모델을 넣어주세요");
  if (!values.mode) values.mode = "off";
  if (!values.assignmentId && values.deviceId && values.stage) {
    const derived = `${values.deviceId}:${values.stage}`;
    if (HELPER_ASSIGNMENT_ID_PATTERN.test(derived)) values.assignmentId = derived;
  }
  if (!values.assignmentId) issues.push("배정 이름을 넣어주세요(예: m3-deepseek:ai1)");
  for (const field of HELPER_INT_FIELDS) {
    const value = parseInt10(text(form.get(field)));
    if (value === undefined) issues.push(`${HELPER_FIELD_LABELS[field]}: 정수를 넣어주세요`);
    values[field] = value;
  }
  for (const field of HELPER_RATIO_FIELDS) {
    const value = percentInputToRatio(text(form.get(helperPercentFieldName(field))));
    if (value === undefined) issues.push(`${HELPER_FIELD_LABELS[field]}: 0~100 사이 백분율(소수 한 자리까지)을 넣어주세요`);
    values[field] = value;
  }
  for (const field of HELPER_MS_FIELDS) {
    const value = secondsInputToMs(text(form.get(helperSecondsFieldName(field))));
    if (value === undefined) issues.push(`${HELPER_FIELD_LABELS[field]}(초): 0 이상의 초 단위 숫자를 넣어주세요`);
    values[field] = value;
  }
  const note = text(form.get("note"));
  if (note.length > HELPER_NOTE_MAX) issues.push(`메모는 ${HELPER_NOTE_MAX}자까지입니다`);
  values.note = note || null;
  return issues.length ? { input: null, expectedVersion, issues } : { input: values, expectedVersion, issues };
}

export type SupervisorTimingParse = { patch: SupervisorControlPatch | null; issues: string[] };
/** 감시자 순환 설정 폼: signalTtlSeconds · loopSeconds(초 → ms). 잘못된 값은 저장소와 같은 코드(model_supervisor_invalid:<path>)로 돌려준다 */
export function supervisorTimingFromForm(form: FormLike): SupervisorTimingParse {
  const signalTtlMs = secondsInputToMs(text(form.get("signalTtlSeconds")));
  const loopMs = secondsInputToMs(text(form.get("loopSeconds")));
  if (signalTtlMs === undefined) return { patch: null, issues: ["model_supervisor_invalid:signalTtlMs"] };
  if (loopMs === undefined) return { patch: null, issues: ["model_supervisor_invalid:loopMs"] };
  const checked = checkSupervisorPatch({ signalTtlMs, loopMs });
  return checked.ok ? { patch: checked.patch, issues: [] } : { patch: null, issues: [checked.issue] };
}
function checkSupervisorPatch(patch: unknown): { ok: true; patch: SupervisorControlPatch } | { ok: false; issue: string } {
  const parsed = supervisorControlPatchSchema.safeParse(patch);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, issue: `model_supervisor_invalid:${issue?.path.length ? issue.path.map(String).join(".") : "root"}` };
  }
  const value = parsed.data;
  if (value.signalTtlMs !== undefined && value.loopMs !== undefined && !supervisorControlTimingValid({ signalTtlMs: value.signalTtlMs, loopMs: value.loopMs }))
    return { ok: false, issue: "model_supervisor_invalid:loopMs" };
  return { ok: true, patch: Object.freeze(value) };
}

// ---------- 저장(WP-2a-A 저장소 한 번, 쓰기 TX 하나) ----------

/** 저장소가 던지는 거절(검사·CAS·재생 DB·제어 행 없음) — 운영자 문장으로 돌려준다(저장소가 감사도 행도 건드리지 않은 채 던졌다). 그 밖(DB 오류·미구현)은 던진다 */
const REFUSAL_PREFIXES = ["model_helper_invalid:", "model_helper_version_mismatch:", "model_helper_refused:", "model_supervisor_invalid:"];
const REFUSAL_CODES = ["model_supervisor_control_missing", "model_capacity_replay_unsupported", "model_capacity_control_missing"];
export const isModelHelperRefusal = (code: string) => REFUSAL_PREFIXES.some(prefix => code.startsWith(prefix)) || REFUSAL_CODES.includes(code);
const refusalOf = (error: unknown): string[] | null => {
  if (error instanceof DrWriterFencedError) return [error.reason];
  const code = error instanceof Error ? error.message : String(error);
  return isModelHelperRefusal(code) ? [code] : null;
};
const validActor = (actor: string) => !!actor.trim() && actor.length <= 120;
const validVersion = (version: number) => Number.isSafeInteger(version) && version >= 1;

export type SaveModelHelperResult = { ok: true; assignmentId: string; version: number; created: boolean; changes: string[]; evidenceChanged: boolean;
  modeBefore: HelperMode | null; modeAfter: HelperMode } | { ok: false; issues: string[] };
const changeSlice = (row: HelperAssignmentRow) => Object.fromEntries(HELPER_INPUT_KEYS.filter(key => key !== "assignmentId").map(key => [key, row[key]]));

/**
 * 배정 하나 저장 — 쓰기 TX 하나에서 saveHelperAssignment(tx, input, expectedVersion, actor). 그 안이 fence → control FOR UPDATE → zod → 거절 검사 →
 * 행 FOR UPDATE·CAS → upsert(version+1, evidence_key 계산) → 감사 한 줄(model-helper-save)을 모두 한다. 임계값·이력만 바뀌면 evidence 는 그대로,
 * 모델·경로·프롬프트판 등이 바뀌면 evidence_key 가 바뀌고 실전은 섀도로 내려간다(저장소가 정한다 — 여기서는 결과만 알린다).
 */
export async function saveAdminModelHelper(input: unknown, expectedVersion: number | null, actor: string): Promise<SaveModelHelperResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  if (expectedVersion !== null && !validVersion(expectedVersion)) return { ok: false, issues: ["model_helper_version_mismatch:invalid"] };
  const repo = await helperRepository();
  try {
    const { before, after } = await onPrimary(() => db.transaction(tx => repo.saveHelperAssignment(tx, input, expectedVersion, actor)));
    const changes = settingsChanges(before ? changeSlice(before) : {}, changeSlice(after))
      .filter(change => helperValueLabel(change.path, change.before) !== helperValueLabel(change.path, change.after))
      .map(change => `${helperFieldLabel(change.path)}: ${helperValueLabel(change.path, change.before)} → ${helperValueLabel(change.path, change.after)}`);
    logger.info("model_helper.saved", { actor, assignmentId: after.assignmentId, version: after.version, mode: after.mode });
    return { ok: true, assignmentId: after.assignmentId, version: after.version, created: before === null, changes,
      evidenceChanged: before !== null && before.evidenceKey !== after.evidenceKey, modeBefore: before?.mode ?? null, modeAfter: after.mode };
  } catch (error) {
    const issues = refusalOf(error);
    if (!issues) throw error;
    return { ok: false, issues };
  }
}

export type ModelHelperModeResult = { ok: true; assignmentId: string; version: number; modeBefore: HelperMode; modeAfter: HelperMode } | { ok: false; issues: string[] };
const validAssignmentId = (assignmentId: string) => HELPER_ASSIGNMENT_ID_PATTERN.test(assignmentId);

/** 모드만 바꾼다(섀도 시작·섀도로 내리기·끄기). 실전은 승격(PR 2c)만 — 여기서는 저장소에 닿기 전에 거절한다. version 이 올라 그 판의 자동 정지가 풀린다 */
export async function setAdminModelHelperMode(assignmentId: string, mode: string, expectedVersion: number, actor: string): Promise<ModelHelperModeResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  if (!validAssignmentId(assignmentId)) return { ok: false, issues: ["model_helper_invalid:assignmentId"] };
  if (mode === "live") return { ok: false, issues: ["model_helper_refused:helper_live_requires_promotion"] };
  if (mode !== "off" && mode !== "shadow") return { ok: false, issues: ["model_helper_invalid:mode"] };
  if (!validVersion(expectedVersion)) return { ok: false, issues: ["model_helper_version_mismatch:invalid"] };
  const repo = await helperRepository();
  try {
    const { before, after } = await onPrimary(() => db.transaction(tx => repo.setHelperMode(tx, assignmentId, mode, expectedVersion, actor)));
    logger.info("model_helper.mode", { actor, assignmentId, version: after.version, before: before.mode, after: after.mode });
    return { ok: true, assignmentId, version: after.version, modeBefore: before.mode, modeAfter: after.mode };
  } catch (error) {
    const issues = refusalOf(error);
    if (!issues) throw error;
    return { ok: false, issues };
  }
}

/**
 * 「자동 정지 해제」 = 같은 값으로 다시 저장해 판(version)을 올린다 — 자동 정지 행은 지우지 않고(append-only) 옛 판에만 걸린 채 남는다.
 * off·shadow 는 setHelperMode(같은 모드), live 는 saveHelperAssignment(같은 입력; 승격 기록은 저장소가 지킨다). 둘 다 CAS(expectedVersion) 다.
 */
export async function clearAdminModelHelperStops(assignmentId: string, expectedVersion: number, actor: string): Promise<ModelHelperModeResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  if (!validAssignmentId(assignmentId)) return { ok: false, issues: ["model_helper_invalid:assignmentId"] };
  if (!validVersion(expectedVersion)) return { ok: false, issues: ["model_helper_version_mismatch:invalid"] };
  const repo = await helperRepository();
  try {
    const { before, after } = await onPrimary(() => db.transaction(async tx => {
      const current = (await repo.listHelperAssignments(tx)).find(row => row.assignmentId === assignmentId);
      if (!current) throw new Error("model_helper_version_mismatch:none");
      if (current.mode === "live") {
        const saved = await repo.saveHelperAssignment(tx, helperInputOf(current), expectedVersion, actor);
        return { before: saved.before ?? current, after: saved.after };
      }
      return repo.setHelperMode(tx, assignmentId, current.mode, expectedVersion, actor);
    }));
    logger.info("model_helper.stops_cleared", { actor, assignmentId, version: after.version, mode: after.mode });
    return { ok: true, assignmentId, version: after.version, modeBefore: before.mode, modeAfter: after.mode };
  } catch (error) {
    const issues = refusalOf(error);
    if (!issues) throw error;
    return { ok: false, issues };
  }
}

export type SupervisorControlResult = { ok: true; patch: SupervisorControlPatch } | { ok: false; issues: string[] };
/**
 * 감시자 control 의 관리자 쪽 값(전체 스위치·신호 유효 시간·순환 간격). 끄면 다음 입장 TX 부터 새 도우미 grant 가 없다 — 돌고 있는 호출은 끝까지 간다.
 * lease 열은 건드리지 않는다. 감사 줄(model-supervisor-toggle)은 저장소가 쓴다.
 */
export async function setAdminSupervisorControl(patch: unknown, actor: string): Promise<SupervisorControlResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  const checked = checkSupervisorPatch(patch);
  if (!checked.ok) return { ok: false, issues: [checked.issue] };
  if (!Object.keys(checked.patch).length) return { ok: false, issues: ["model_supervisor_invalid:root"] };
  const repo = await helperRepository();
  try {
    await onPrimary(() => db.transaction(tx => repo.setSupervisorControl(tx, checked.patch, actor)));
    logger.info("model_supervisor.control", { actor, patch: checked.patch });
    return { ok: true, patch: checked.patch };
  } catch (error) {
    const issues = refusalOf(error);
    if (!issues) throw error;
    return { ok: false, issues };
  }
}

// ---------- 거절 코드 → 한국어 ----------

const FIXED_MESSAGES: Record<string, string> = {
  site_fenced: "이 사이트는 지금 쓰기가 막혀 있습니다(DR).",
  lineage_mismatch: "이 사이트는 지금 쓰기가 막혀 있습니다(DR: 다른 계보의 DB).",
  epoch_stale: "이 사이트는 지금 쓰기가 막혀 있습니다(DR: 옛 쓰기 epoch).",
  epoch_ahead: "이 사이트는 지금 쓰기가 막혀 있습니다(DR: 앞선 쓰기 epoch).",
  invalid_actor: "저장한 사람을 확인하지 못했습니다. 다시 로그인해 주세요.",
  model_supervisor_control_missing: "감시자 control 행(model_supervisor_control id=1)이 없습니다 — migration 0154 적용을 확인해 주세요.",
  model_capacity_replay_unsupported: "재생(replay) DB 에서는 도우미 설정을 저장할 수 없습니다.",
  model_capacity_control_missing: "용량 제어 행(model_capacity_control)이 없습니다.",
  model_helper_status_unreadable: "도우미 상태를 읽지 못했습니다.",
  capacity_helpers_not_implemented: "도우미 저장소가 아직 준비되지 않았습니다(WP-2a-A 저장소 본문 대기) — 상태는 비어 있고 저장할 수 없습니다.",
};
export const HELPER_REFUSAL_MESSAGES: Readonly<Record<HelperSaveRefusal, string>> = {
  helper_route_is_primary: "도우미 경로가 이 장비의 우선 역할입니다 — 장비 한도에서 순위를 2 이상으로 바꿔 주세요(/admin/models/devices).",
  helper_route_unmapped: "정책에 도우미 경로(live·shadow)가 없습니다 — 경로를 정책에 먼저 덧붙인 뒤 저장하세요(DRAIN 은 필요 없습니다).",
  helper_ai2_voter_not_in_fallbacks: "2차 대체 모델 목록에 이 모델(local-direct)을 먼저 넣으세요(단계별 모델 → 2차 검수 대체).",
  helper_device_unconfigured: "도우미 장비 행이 없습니다 — 장비 한도(/admin/models/devices)에서 이 장비를 먼저 저장하세요.",
  helper_live_requires_promotion: "실전은 승격으로만 켤 수 있습니다(섀도 근거·확인 「실전」 — PR 2c).",
};
const pct = (min: number, max: number) => `${min}~${max}% 의 백분율(소수 한 자리까지)이어야 합니다`;
const INVALID_FIELD_MESSAGES: Record<string, string> = {
  assignmentId: "배정 이름: 영어 소문자·숫자로 시작하고 소문자·숫자·':'·'-' 만, 120자까지 적어주세요(예: m3-deepseek:ai1)",
  stage: "돕는 단계: 1차 검수(ai1) 또는 2차 검수(ai2)여야 합니다",
  deviceId: "도우미 장비: 1~120자, 앞뒤 공백·제어 문자 없이 적어주세요",
  model: "모델: 1~200자, 앞뒤 공백·제어 문자 없이 적어주세요",
  shadowRouteId: "섀도 경로: 1~120자, 앞뒤 공백·제어 문자 없이, 실전 경로와 달라야 합니다",
  liveRouteId: "실전 경로: 1~120자, 앞뒤 공백·제어 문자 없이 적어주세요",
  liveProvider: "실전 공급자: 1~60자, 앞뒤 공백·제어 문자 없이 적어주세요",
  mode: "모드: 꺼짐·섀도·실전 중 하나여야 합니다",
  maxSlots: "최대 칸: 1~256 의 정수여야 합니다",
  perTick: "한 틱 최대 건수: 1~16 의 정수여야 합니다",
  shadowPerHour: "시간당 섀도 표본: 0~600 의 정수여야 합니다",
  minShadowSamples: "승격 최소 표본: 20~10000 의 정수여야 합니다",
  minAgreement: `최소 일치율: ${pct(50, 100)}`,
  maxWrongApproval: `잘못 승인 상한: ${pct(0, 50)}`,
  maxWrongRejection: `잘못 거절 상한: ${pct(0, 50)}`,
  maxUnknownRate: `확인 못함 비율 상한: ${pct(0, 50)}`,
  maxFailureRate: `실패 비율 상한: ${pct(0, 90)}`,
  maxLiveDisagreement: `실전 2차 불일치 상한: ${pct(0, 90)}`,
  enterSamples: "들어가는 표본 수: 1~20 의 정수여야 합니다",
  exitSamples: "나오는 표본 수: 1~40 의 정수여야 합니다",
  minHelpMs: "최소 유지 시간: 0~3600초여야 합니다",
  reenterCooldownMs: "재진입 대기: 0~3600초여야 합니다",
  note: `메모: ${HELPER_NOTE_MAX}자까지입니다`,
  evidence: "근거 열쇠(evidence_key)를 만들지 못했습니다 — 모델·프롬프트판·규칙판·서빙 계약을 확인해 주세요",
  actor: "저장한 사람을 확인하지 못했습니다. 다시 로그인해 주세요.",
  root: "배정 모양이 틀립니다(알 수 없는 칸이 있거나 칸이 빠졌습니다). 새로고침해 주세요.",
};
const SUPERVISOR_INVALID_MESSAGES: Record<string, string> = {
  enabled: "감시자 전체 스위치 값을 읽지 못했습니다. 새로고침해 주세요.",
  signalTtlMs: "신호 유효 시간: 15~300초의 정수 ms 여야 합니다",
  loopMs: "순환 간격: 5~60초이고, 신호 유효 시간의 절반 이하여야 합니다(순환 간격 × 2 ≤ 신호 유효 시간)",
  root: "감시자 설정 모양이 틀립니다(바꿀 값이 없거나 알 수 없는 칸이 있습니다). 새로고침해 주세요.",
};

/** 저장소·화면의 코드를 운영자 문장으로. 모르는 코드는 그대로 보인다(숨기지 않는다) */
export function modelHelperIssueMessage(issue: string): string {
  if (FIXED_MESSAGES[issue]) return FIXED_MESSAGES[issue];
  if (/^Cannot find (module|package)|^Failed to load/.test(issue)) return FIXED_MESSAGES.capacity_helpers_not_implemented;
  const colon = issue.indexOf(":");
  if (colon < 0) return issue;
  const code = issue.slice(0, colon), detail = issue.slice(colon + 1);
  switch (code) {
    case "model_helper_version_mismatch":
      if (detail === "invalid") return "판 번호(version)를 읽지 못했습니다. 새로고침해 주세요.";
      if (detail === "none") return "다른 사람이 먼저 저장했습니다(지금 판 없음 — 이 배정이 없습니다). 새로고침해 주세요.";
      return `다른 사람이 먼저 저장했습니다(지금 판 ${detail}). 새로고침해 주세요.`;
    case "model_helper_refused":
      return HELPER_REFUSAL_MESSAGES[detail as HelperSaveRefusal] ?? `저장이 거절됐습니다: ${detail}`;
    case "model_helper_invalid": {
      if (INVALID_FIELD_MESSAGES[detail]) return INVALID_FIELD_MESSAGES[detail];
      const head = detail.split(/[.[]/)[0];
      return INVALID_FIELD_MESSAGES[head] ?? `도우미 배정이 검사를 통과하지 못했습니다: ${detail}`;
    }
    case "model_supervisor_invalid":
      return SUPERVISOR_INVALID_MESSAGES[detail] ?? SUPERVISOR_INVALID_MESSAGES[detail.split(/[.[]/)[0]] ?? `감시자 설정이 검사를 통과하지 못했습니다: ${detail}`;
    default: return issue;
  }
}

/** 화면의 정적 목록(폼 select) — 클라이언트 폼에 값으로 넘긴다 */
export const HELPER_STAGE_OPTIONS = HELPER_STAGES.map(stage => ({ value: stage, label: HELPER_STAGE_LABELS[stage] }));
export const HELPER_MODE_OPTIONS = HELPER_MODES.map(mode => ({ value: mode, label: HELPER_MODE_LABELS[mode] }));

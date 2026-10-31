import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { MODEL_CAPACITY_OCCUPYING_STATES_SQL } from "./capacity-states";

/**
 * 도우미 장비 · Oracle 감시자(PR 2a, Layer B) — WP-2a-A 가 day 0 에 고정한 계약. WP-2a-B(감시자)·WP-2a-C(관리자 화면)는 이 모듈의 이름만 쓴다.
 * 표는 migration 0154(`model_supervisor_control`, `model_helper_assignments`, `model_helper_signals`, `model_device_signals`,
 * `model_role_demand`, `model_helper_stops`, `model_helper_shadow_runs`, `model_helper_live_outputs`).
 *
 * 원칙(pr2-plan §0):
 * - D1 감시자 신호는 선택적 도우미 경로를 **열거나** 빌려주기를 **줄일** 뿐, 우선 역할 일을 막지 못한다. 신호가 없거나·만료됐거나·다른 epoch·
 *   다른 판(version)·다른 계정이 썼으면 도우미는 닫힌다(fail-closed). 빌려주기 제한 신호(model_device_signals)가 신선하지 않으면 **무시**한다
 *   (PR 1b 장부 규칙 그대로). 신선도는 입장 TX 안에서 DB 시계(`clock_timestamp()`)로만 판정한다 — Oracle 호스트 시계와 견주지 않는다.
 * - D3 도우미는 관리자 행(장비 × 단계 × 경로 × mode off/shadow/live)이고 항상 그 장비의 우선 역할보다 낮다. grant-or-nothing — 대기 행을 남기지 않는다.
 * - 기본값은 모두 꺼짐: control `enabled=false`, 배정 `mode='off'`.
 *
 * 이 모듈은 서버 모듈이다(node:crypto). 클라이언트 컴포넌트는 `import type` 만 한다(DeviceForm 과 같은 규칙).
 */

// ── 어휘 ────────────────────────────────────────────────────────────────────────────────────────────────

export const HELPER_STAGES = Object.freeze(["ai1", "ai2"] as const);
export type HelperStage = (typeof HELPER_STAGES)[number];
export const HELPER_MODES = Object.freeze(["off", "shadow", "live"] as const);
export type HelperMode = (typeof HELPER_MODES)[number];
export const HELPER_VERDICTS = Object.freeze(["help", "shadow_only", "hold"] as const);
export type HelperVerdict = (typeof HELPER_VERDICTS)[number];
/** 신호·화면의 판정 이유(관리자 화면 라벨은 pr2-plan §5.2). 표 CHECK 는 `^[a-z_]{1,40}$` 뿐이므로 이 목록이 단일 출처다. */
export const HELPER_REASONS = Object.freeze(["primary_full", "primary_not_full", "helper_own_work", "stale_inputs", "auto_stopped",
  "unknown_rate", "failure_rate", "quality_regression", "mode_off", "supervisor_off"] as const);
export type HelperReason = (typeof HELPER_REASONS)[number];
/** 도우미 경로 종류: live = 실전 경로(live_route_id/live_provider), shadow = 섀도 경로(shadow_route_id, 언제나 local-direct). */
export const HELPER_GATE_KINDS = Object.freeze(["live", "shadow"] as const);
export type HelperGateKind = (typeof HELPER_GATE_KINDS)[number];
/** 자동 정지 효과. stop = 두 경로 모두 닫음, demote_to_shadow = 실전 경로만 닫음(섀도 표본은 계속 쌓인다). */
export const HELPER_STOP_EFFECTS = Object.freeze(["stop", "demote_to_shadow"] as const);
export type HelperStopEffect = (typeof HELPER_STOP_EFFECTS)[number];
export const HELPER_SHADOW_RUN_STATES = Object.freeze(["claimed", "succeeded", "failed", "unknown", "cancelled"] as const);
export type HelperShadowRunState = (typeof HELPER_SHADOW_RUN_STATES)[number];
export const HELPER_SHADOW_AGREEMENTS = Object.freeze(["same", "helper_approve_primary_reject", "helper_reject_primary_approve",
  "helper_abstain", "primary_abstain", "other"] as const);
export type HelperShadowAgreement = (typeof HELPER_SHADOW_AGREEMENTS)[number];
export const HELPER_LIVE_DOWNSTREAMS = Object.freeze(["ai2_agreed", "ai2_disagreed", "human_overturned", "none"] as const);
export type HelperLiveDownstream = (typeof HELPER_LIVE_DOWNSTREAMS)[number];
/** 보내는 wire 의 변형(evidence_key 에 들어간다: 섀도가 실전이 보낼 정확한 wire 를 검증한다, pr2-plan §4.1 Q5). */
export const HELPER_WIRE_VARIANTS = Object.freeze(["json_schema", "no_response_format"] as const);
export type HelperWireVariant = (typeof HELPER_WIRE_VARIANTS)[number];

/** operations_audit 의 action(저장 함수가 한 줄씩 쓴다 — 감싸는 쪽이 또 쓰지 않는다). */
export const HELPER_SAVE_AUDIT_ACTION = "model-helper-save";
export const HELPER_MODE_AUDIT_ACTION = "model-helper-mode";
export const HELPER_PROMOTE_AUDIT_ACTION = "model-helper-promote";
export const SUPERVISOR_TOGGLE_AUDIT_ACTION = "model-supervisor-toggle";
export const HELPER_AUDIT_ACTIONS = Object.freeze([HELPER_SAVE_AUDIT_ACTION, HELPER_MODE_AUDIT_ACTION, HELPER_PROMOTE_AUDIT_ACTION,
  SUPERVISOR_TOGGLE_AUDIT_ACTION] as const);
export type HelperAuditAction = (typeof HELPER_AUDIT_ACTIONS)[number];

/**
 * 저장 거절 코드. 오류 문자열 규칙(장비 저장과 같은 모양):
 * - 입력 검증 실패 `model_helper_invalid:<path>` (zod 첫 issue 의 위치, 없으면 `root`)
 * - compare-and-set 실패 `model_helper_version_mismatch:<current|none>` (화면의 `version_mismatch`)
 * - 아래 거절은 `model_helper_refused:<code>`
 */
export const HELPER_SAVE_REFUSALS = Object.freeze(["helper_route_is_primary", "helper_route_unmapped", "helper_ai2_voter_not_in_fallbacks",
  "helper_device_unconfigured", "helper_live_requires_promotion"] as const);
export type HelperSaveRefusal = (typeof HELPER_SAVE_REFUSALS)[number];

// ── 상수 ────────────────────────────────────────────────────────────────────────────────────────────────

/** 감시자가 신호를 쓰는 DB 계정(운영자가 deploy/oracle/least-privilege.sql 로 만든다). control.signal_principal 의 기본값. */
export const SUPERVISOR_PRINCIPAL = "nomorevibe_oracle_capacity_supervisor";
export const SUPERVISOR_CONTROL_ID = 1;
export const DEFAULT_SIGNAL_TTL_MS = 45_000;
export const SIGNAL_TTL_MS_MIN = 15_000;
export const SIGNAL_TTL_MS_MAX = 300_000;
export const DEFAULT_SUPERVISOR_LOOP_MS = 15_000;
export const SUPERVISOR_LOOP_MS_MIN = 5_000;
export const SUPERVISOR_LOOP_MS_MAX = 60_000;
/** 감시자 lease = loop_ms × 이 값(pr2-plan §3.3 TX-A). */
export const SUPERVISOR_LEASE_LOOPS = 3;
/** 모든 신호 행의 TTL CHECK: observed_at < valid_until ≤ observed_at + 5분. */
export const SIGNAL_VALIDITY_MAX_MS = 300_000;
export const HELPER_ASSIGNMENT_ID_PATTERN = /^[a-z0-9][a-z0-9:-]{0,119}$/;
export const HELPER_EVIDENCE_KEY_PATTERN = /^[a-f0-9]{64}$/;
export const HELPER_REASON_PATTERN = /^[a-z_]{1,40}$/;
export const HELPER_NOTE_MAX = 400;
export const HELPER_SIGNAL_METRICS_MAX_BYTES = 8192;
/** 실전 AI1 도우미의 reject 는 이 확신 이상에서만 적용한다(소유자 결정; DEEPSEEK_MIN_CONFIDENCE·HELD_QWEN_MIN_CONFIDENCE 와 같다). */
export const HELPER_LIVE_MIN_REJECT_CONFIDENCE = 0.9;
/** 실전 AI2 도우미 대체 표는 기존 abcllm 대체보다 **먼저** 시도한다(소유자 결정). */
export const HELPER_AI2_FALLBACK_BEFORE_ABCLLM = true;
/** 섀도 경로의 공급자는 언제나 local-direct 다(helper_gate 의 shadow 행). */
export const HELPER_SHADOW_PROVIDER = "local-direct";

/** 단계별 경로 기본값(pr2-plan §2.4 rev14). 배정 저장은 값을 명시해야 한다 — 폼의 초기값이다. */
export const HELPER_ROUTE_DEFAULTS = Object.freeze({
  ai1: Object.freeze({ shadowRouteId: "local-helper-shadow-ai1", liveRouteId: "local-ai1-helper", liveProvider: "local-direct" }),
  ai2: Object.freeze({ shadowRouteId: "local-helper-shadow-ai2", liveRouteId: "second-review", liveProvider: "local-direct" }),
} as const satisfies Record<HelperStage, { shadowRouteId: string; liveRouteId: string; liveProvider: string }>);

/**
 * 집 쪽 역할 수요 beacon(model_role_demand) — 쓰는 쪽(WP-2a-C: human-review 잡·AI1 소비자)과 읽는 쪽(WP-2a-B: 감시자)이 같은 이름을 쓴다.
 * human-review: 장비 m3-deepseek 의 자기 일(사람 검수 대기). TTL 150 s = 60 s 간격 × 2.5.
 * ai1: AI1 주 장비들의 정보성 beacon. 풀 장비 목록은 metrics.devices(string[]), 전부 쉼은 metrics.pausedAll. device_id 는 실제 장비가 아니라 풀 표지다.
 */
export const ROLE_DEMAND_BEACONS = Object.freeze({
  humanReview: Object.freeze({ roleId: "human-review", deviceId: "m3-deepseek", ttlMs: 150_000, minIntervalMs: 0 }),
  ai1: Object.freeze({ roleId: "ai1", deviceId: "ai1-pool", ttlMs: 45_000, minIntervalMs: 15_000 }),
} as const);

/** 감시자 decide 의 고정 한도(pr2-plan §3.4–3.5). 배정별로 바뀌는 값은 배정 행의 임계값이다. */
export const HELPER_DECISION_LIMITS = Object.freeze({
  /** 건강 창(장부·섀도·실전 결과). */
  healthWindowMs: 30 * 60_000,
  /** 미확인·실패 비율 정지에 필요한 최소 표본. */
  minHealthSamples: 10,
  /** 연속 미확인 정지. */
  consecutiveUnknownStop: 3,
  /** 실전 AI2 불일치 강등에 필요한 최소 표본. */
  minLiveDisagreementSamples: 20,
  /** 실전 중 섀도 감사 rolling 창(결정된 쌍 수). */
  rollingShadowWindow: 100,
  /** rolling 섀도 일치율 < min_agreement − 이 값 ⇒ demote_to_shadow. */
  demoteAgreementMargin: 0.05,
  /** 섀도 통계 창(배정 × evidence_key 의 최근 실행 수). */
  shadowStatsWindow: 1000,
  /** 실전 결과 최근 표본 수. */
  liveStatsRecent: 200,
  /** AI2 주 장비 가득 참 판정: local-direct second-review 대기 행 나이 ≥ 15 s(AI2 소비자의 오늘 대체 조건과 같다). */
  ai2PrimaryWaitMinMs: 15_000,
} as const);

// ── 배정 schema ─────────────────────────────────────────────────────────────────────────────────────────

const identity = (max: number) => z.string().min(1).max(max)
  .refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), "invalid_identity");
const int = (min: number, max: number) => z.number().int().min(min).max(max);
/** numeric(4,3) 와 같은 범위·자릿수. */
const ratio = (min: number, max: number) => z.number().min(min).max(max)
  .refine(value => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-9, "three_decimals");

/** 배정 입력(§1.1 열, camelCase). 생략한 값은 기본값이 된다 — mode 는 'off'. evidence_key·promoted_*·version 은 저장이 정한다. */
export const helperAssignmentSchema = z.object({
  assignmentId: z.string().regex(HELPER_ASSIGNMENT_ID_PATTERN),
  stage: z.enum(HELPER_STAGES),
  deviceId: identity(120),
  /** 계약·wire 모델 이름(참 identity). */
  model: identity(200),
  shadowRouteId: identity(120),
  liveRouteId: identity(120),
  liveProvider: identity(60),
  mode: z.enum(HELPER_MODES).default("off"),
  maxSlots: int(1, 256).default(1),
  perTick: int(1, 16).default(2),
  shadowPerHour: int(0, 600).default(30),
  minShadowSamples: int(20, 10_000).default(200),
  minAgreement: ratio(0.5, 1).default(0.95),
  maxWrongApproval: ratio(0, 0.5).default(0.01),
  maxWrongRejection: ratio(0, 0.5).default(0.02),
  maxUnknownRate: ratio(0, 0.5).default(0.02),
  maxFailureRate: ratio(0, 0.9).default(0.1),
  maxLiveDisagreement: ratio(0, 0.9).default(0.1),
  enterSamples: int(1, 20).default(2),
  exitSamples: int(1, 40).default(4),
  minHelpMs: int(0, 3_600_000).default(120_000),
  reenterCooldownMs: int(0, 3_600_000).default(60_000),
  note: z.string().max(HELPER_NOTE_MAX).nullable().default(null),
}).strict()
  .refine(value => value.shadowRouteId !== value.liveRouteId, { message: "shadow_route_equals_live_route", path: ["shadowRouteId"] });
export type HelperAssignmentInput = Readonly<z.output<typeof helperAssignmentSchema>>;

/** 저장된 배정 행. version 은 폼 compare-and-set·감사·신호(assignment_version)의 참조다. 시각은 ISO 문자열. */
export type HelperAssignmentRow = HelperAssignmentInput & Readonly<{
  version: number; evidenceKey: string; promotedAt: string | null; promotedBy: string | null;
  updatedBy: string; createdAt: string; updatedAt: string;
}>;

/** 배정 입력을 검증한다. 거절은 `model_helper_invalid:<path>`. */
export function parseHelperAssignment(input: unknown): HelperAssignmentInput {
  const parsed = helperAssignmentSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.map(String).join(".") : "root";
    throw new Error(`model_helper_invalid:${path}`);
  }
  return Object.freeze(parsed.data);
}

/** 감시자 control 의 관리자 쪽 변경. loopMs × 2 ≤ signalTtlMs 는 저장이 현재 값과 합쳐 다시 본다(표 CHECK 와 같다). */
export const supervisorControlPatchSchema = z.object({
  enabled: z.boolean().optional(),
  signalTtlMs: int(SIGNAL_TTL_MS_MIN, SIGNAL_TTL_MS_MAX).optional(),
  loopMs: int(SUPERVISOR_LOOP_MS_MIN, SUPERVISOR_LOOP_MS_MAX).optional(),
}).strict();
export type SupervisorControlPatch = Readonly<z.output<typeof supervisorControlPatchSchema>>;

/** 저장 전에 합친 control 값이 표 CHECK 를 지키는지. */
export function supervisorControlTimingValid(value: { signalTtlMs: number; loopMs: number }): boolean {
  return Number.isInteger(value.signalTtlMs) && Number.isInteger(value.loopMs)
    && value.signalTtlMs >= SIGNAL_TTL_MS_MIN && value.signalTtlMs <= SIGNAL_TTL_MS_MAX
    && value.loopMs >= SUPERVISOR_LOOP_MS_MIN && value.loopMs <= SUPERVISOR_LOOP_MS_MAX && value.loopMs * 2 <= value.signalTtlMs;
}

// ── 행 타입(camelCase, 시각은 ISO 문자열, bigint 는 number) ─────────────────────────────────────────────────

export type HelperMetrics = Readonly<Record<string, number | string | boolean>>;

export type SupervisorControlRow = Readonly<{
  enabled: boolean; signalPrincipal: string; signalTtlMs: number; loopMs: number;
  ownerInstanceId: string | null; ownerBootId: string | null; epoch: number;
  leaseUntil: string | null; heartbeatAt: string | null; loopSeq: number; release: string | null;
  updatedBy: string; updatedAt: string;
}>;

export type HelperSignalRow = Readonly<{
  assignmentId: string; assignmentVersion: number; supervisorEpoch: number; verdict: HelperVerdict; reason: HelperReason;
  streak: number; stateSince: string; lastExitAt: string | null; metrics: HelperMetrics; observedAt: string; validUntil: string; writtenBy: string;
}>;

export type DeviceSignalRow = Readonly<{
  deviceId: string; supervisorEpoch: number; primaryDemand: boolean; backlog: number; metrics: HelperMetrics;
  observedAt: string; validUntil: string; writtenBy: string;
}>;

export type RoleDemandMetrics = Readonly<Record<string, number | string | boolean | readonly string[]>>;
export type RoleDemandRow = Readonly<{
  roleId: string; deviceId: string; backlog: number; oldestAgeMs: number | null; metrics: RoleDemandMetrics;
  observedAt: string; validUntil: string; writtenBy: string;
}>;

export type HelperStopRow = Readonly<{
  id: number; assignmentId: string; assignmentVersion: number; effect: HelperStopEffect; reason: HelperReason;
  evidence: Readonly<Record<string, unknown>>; createdAt: string; writtenBy: string;
}>;

/** helper_gate + helper_active 한 줄(관리자 화면·status·requestSlot 사전 거절). */
export type HelperGateState = Readonly<{
  assignmentId: string; kind: HelperGateKind; routeId: string; provider: string; model: string; ok: boolean; active: number; maxSlots: number;
}>;

/** 관리자 화면·pipeline-control status 가 한 번에 읽는 스냅샷(readHelperStatusSnapshot). nowMs 는 그 읽기의 DB 시계다. */
export type HelperStatusSnapshot = Readonly<{
  nowMs: number;
  control: SupervisorControlRow;
  assignments: readonly HelperAssignmentRow[];
  signals: readonly HelperSignalRow[];
  /** 현재 배정 version 의 정지 행만. */
  stops: readonly HelperStopRow[];
  deviceSignals: readonly DeviceSignalRow[];
  roleDemand: readonly RoleDemandRow[];
  gates: readonly HelperGateState[];
}>;

// ── 신선도(§1.3) — SQL helper_gate 와 같은 식의 TS 판정 ─────────────────────────────────────────────────────
// 실제 입장 판정은 helperGateCte 가 DB 안에서 한다. 아래 함수는 감시자 decide·도우미 단계 사전 확인·관리자 배지·테스트용이다.
// 모든 시각은 DB 시계(ms). 읽을 수 없는 시각(NaN)은 비교가 false 가 되어 닫힌다 — SQL 의 coalesce(…, false) 와 같다.

const timeMs = (value: string | null | undefined): number => value ? Date.parse(value) : Number.NaN;

/** 도우미 신호가 쓸 수 없는 첫 이유(§1.3 순서). null = 신선. */
export type HelperSignalStaleness = "supervisor_missing" | "supervisor_disabled" | "lease_expired" | "assignment_missing" | "signal_missing"
  | "epoch_mismatch" | "principal_mismatch" | "version_mismatch" | "signal_expired";

export type HelperFreshnessInput = Readonly<{
  /** DB clock_timestamp() 의 ms. */
  nowMs: number;
  control: Pick<SupervisorControlRow, "enabled" | "epoch" | "signalPrincipal" | "leaseUntil"> | null;
  assignment: Pick<HelperAssignmentRow, "assignmentId" | "version" | "mode"> | null;
  signal: Pick<HelperSignalRow, "assignmentId" | "assignmentVersion" | "supervisorEpoch" | "writtenBy" | "validUntil" | "verdict"> | null;
}>;

export function helperSignalStaleness(input: HelperFreshnessInput): HelperSignalStaleness | null {
  const { nowMs, control, assignment, signal } = input;
  if (!control) return "supervisor_missing";
  if (control.enabled !== true) return "supervisor_disabled";
  if (!(timeMs(control.leaseUntil) > nowMs)) return "lease_expired";
  if (!assignment) return "assignment_missing";
  if (!signal || signal.assignmentId !== assignment.assignmentId) return "signal_missing";
  if (signal.supervisorEpoch !== control.epoch) return "epoch_mismatch";
  if (signal.writtenBy !== control.signalPrincipal) return "principal_mismatch";
  if (signal.assignmentVersion !== assignment.version) return "version_mismatch";
  if (!(timeMs(signal.validUntil) > nowMs)) return "signal_expired";
  return null;
}

/** §1.3 의 앞 여섯 조건(정지·mode·verdict 제외). */
export function helperSignalUsable(input: HelperFreshnessInput): boolean {
  return helperSignalStaleness(input) === null;
}

/** 정지 행 하나가 이 경로 종류를 막는가: stop 은 둘 다, demote_to_shadow 는 live 만. */
export function helperStopBlocks(effect: HelperStopEffect, kind: HelperGateKind): boolean {
  return effect === "stop" || kind === "live";
}

/**
 * helper_gate.ok 와 같은 식: 신호 신선 AND (현재 version 의 막는 정지 없음) AND
 * live ⇒ mode 'live' AND verdict 'help'; shadow ⇒ mode ∈ {shadow, live} AND verdict ∈ {help, shadow_only}.
 */
export function helperGateOk(input: HelperFreshnessInput & Readonly<{
  kind: HelperGateKind; stops: readonly Pick<HelperStopRow, "assignmentId" | "assignmentVersion" | "effect">[];
}>): boolean {
  if (!helperSignalUsable(input) || !input.assignment || !input.signal) return false;
  const { assignment, signal, kind } = input;
  if (input.stops.some(stop => stop.assignmentId === assignment.assignmentId && stop.assignmentVersion === assignment.version
    && helperStopBlocks(stop.effect, kind))) return false;
  return kind === "live"
    ? assignment.mode === "live" && signal.verdict === "help"
    : (assignment.mode === "shadow" || assignment.mode === "live") && (signal.verdict === "help" || signal.verdict === "shadow_only");
}

/** 빌려주기 제한 신호를 쓸 수 있는가. false 면 **무시**(막지 않는다) — Layer A 는 PR 1b 장부 규칙으로 돌아간다(D1). */
export function deviceSignalUsable(input: Readonly<{
  nowMs: number;
  control: Pick<SupervisorControlRow, "enabled" | "epoch" | "signalPrincipal" | "leaseUntil"> | null;
  signal: Pick<DeviceSignalRow, "supervisorEpoch" | "writtenBy" | "validUntil"> | null;
}>): boolean {
  const { nowMs, control, signal } = input;
  return !!control && control.enabled === true && timeMs(control.leaseUntil) > nowMs && !!signal
    && signal.supervisorEpoch === control.epoch && signal.writtenBy === control.signalPrincipal && timeMs(signal.validUntil) > nowMs;
}

/** 역할 수요 beacon 이 신선한가(감시자만 읽는다). 신선하지 않거나 없으면 그 역할은 **바쁨**으로 본다(돕기에 대해 fail-closed). */
export function roleDemandFresh(input: Readonly<{ nowMs: number; beacon: Pick<RoleDemandRow, "validUntil"> | null }>): boolean {
  return !!input.beacon && timeMs(input.beacon.validUntil) > input.nowMs;
}

// ── evidence key · actor ──────────────────────────────────────────────────────────────────────────────

export type HelperEvidenceParts = Readonly<{
  stage: HelperStage; model: string; promptVersion: string; rulesVersion: string; wireVariant: HelperWireVariant; contractHash: string;
}>;

/** sha256(단계, 모델, 프롬프트판, 규칙판, wire 변형, 서빙 계약 hash) — 배정 저장이 계산한다. 같은 입력이면 같은 64자 hex. */
export function helperEvidenceKey(v: HelperEvidenceParts): string {
  const fields = [v.model, v.promptVersion, v.rulesVersion, v.contractHash];
  if (!HELPER_STAGES.includes(v.stage) || !HELPER_WIRE_VARIANTS.includes(v.wireVariant)
    || fields.some(field => typeof field !== "string" || !field || field !== field.trim())) throw new Error("model_helper_invalid:evidence");
  return createHash("sha256")
    .update(JSON.stringify(["nmv-helper-evidence/1", v.stage, v.model, v.promptVersion, v.rulesVersion, v.wireVariant, v.contractHash]))
    .digest("hex");
}

/** 도우미 출력의 참 identity actor(D4): `helper:<assignmentId>:<evidenceKey 앞 8자>`. */
export function helperActor(assignmentId: string, evidenceKey: string): string {
  if (!HELPER_ASSIGNMENT_ID_PATTERN.test(assignmentId) || !HELPER_EVIDENCE_KEY_PATTERN.test(evidenceKey)) throw new Error("model_helper_invalid:actor");
  return `helper:${assignmentId}:${evidenceKey.slice(0, 8)}`;
}

// ── SQL(§2.1) ─────────────────────────────────────────────────────────────────────────────────────────

const deviceRef = (deviceId: SQL | string): SQL => typeof deviceId === "string" ? sql`${deviceId}` : deviceId;
const SQL_ALIAS = /^[a-z_][a-z0-9_]{0,30}$/;

/**
 * 장비 D 의 도우미 CTE 목록 — `WITH` 없이 `sup, helper_gate, helper_active, demand` 네 항목을 쉼표로 잇는다. 이 조각은 자기 안에서만 참조하므로
 * (deviceStateCte 의 s·roles 를 보지 않는다) WITH 목록의 맨 앞에 둘 수 있다. Postgres 의 비재귀 WITH 는 앞 항목만 참조하므로 `busy` 가
 * `demand` 를 읽으려면 이 조각이 `busy` 보다 앞에 있어야 한다. `deviceId` 는 bind 값(string) 또는 바깥 열 참조(SQL, LATERAL 안).
 *
 * - sup: control 한 행(enabled·epoch·principal·lease 살아 있음). 행이 없으면 LEFT JOIN 이 NULL 을 주고 coalesce 가 닫는다.
 * - helper_gate: 배정마다 live·shadow 두 줄과 `ok`(§1.3 + 정지 + mode·verdict). NULL 은 모두 false.
 * - helper_active: 배정별 도우미 경로 점유 수(reserved/dispatched — indeterminate 는 점유가 아니다).
 * - demand: 신선한 primary_demand 신호가 있는가(`on_`). 신선하지 않으면 false = 무시.
 */
export function helperGateCte(deviceId: SQL | string): SQL {
  const device = deviceRef(deviceId);
  const occupying = sql.raw(MODEL_CAPACITY_OCCUPYING_STATES_SQL);
  const shadowProvider = sql.raw(`'${HELPER_SHADOW_PROVIDER}'`);
  return sql`sup AS MATERIALIZED (
      SELECT c.enabled, c.epoch, c.signal_principal, c.lease_until > clock_timestamp() AS live
      FROM model_supervisor_control c WHERE c.id = 1
    ),
    helper_gate AS MATERIALIZED (
      SELECT ha.assignment_id, ha.max_slots, g.kind, g.route_id, g.provider, g.model,
        coalesce(sup.enabled AND sup.live AND hs.supervisor_epoch = sup.epoch AND hs.written_by = sup.signal_principal
          AND hs.assignment_version = ha.version AND hs.valid_until > clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM model_helper_stops st WHERE st.assignment_id = ha.assignment_id
                            AND st.assignment_version = ha.version AND (st.effect = 'stop' OR g.kind = 'live'))
          AND CASE g.kind WHEN 'live' THEN ha.mode = 'live' AND hs.verdict = 'help'
                          ELSE ha.mode IN ('shadow','live') AND hs.verdict IN ('help','shadow_only') END, false) AS ok
      FROM model_helper_assignments ha
      CROSS JOIN LATERAL (VALUES ('live'::text, ha.live_route_id, ha.live_provider, ha.model),
                                 ('shadow'::text, ha.shadow_route_id, ${shadowProvider}::text, ha.model)) g(kind, route_id, provider, model)
      LEFT JOIN model_helper_signals hs ON hs.assignment_id = ha.assignment_id
      LEFT JOIN sup ON true
      WHERE ha.device_id = ${device}
    ),
    helper_active AS MATERIALIZED (
      SELECT g.assignment_id, count(*)::int AS n FROM helper_gate g JOIN model_capacity_requests r
        ON r.group_id = ${device} AND r.route_id = g.route_id AND r.provider = g.provider AND r.model = g.model AND r.state IN ${occupying}
      GROUP BY g.assignment_id
    ),
    demand AS MATERIALIZED (
      SELECT EXISTS (SELECT 1 FROM model_device_signals ds JOIN sup ON true WHERE ds.device_id = ${device} AND ds.primary_demand
        AND sup.enabled AND sup.live AND ds.supervisor_epoch = sup.epoch AND ds.written_by = sup.signal_principal
        AND ds.valid_until > clock_timestamp()) AS on_
    )`;
}

/**
 * 입장 후보 WHERE 에 붙이는 조건(§2.1): 대기 행 `alias` 가 도우미 경로이면 그 경로가 열려 있고(ok) 배정 점유 < max_slots 일 때만 맞는다.
 * 보통 경로의 행은 helper_gate 와 맞는 줄이 없어 영향이 없다. helperGateCte 가 같은 WITH 안에 있어야 한다.
 */
export function helperCandidateExclusionSql(alias = "q"): SQL {
  if (!SQL_ALIAS.test(alias)) throw new Error("model_helper_invalid:alias");
  const q = sql.raw(alias);
  return sql`NOT EXISTS (SELECT 1 FROM helper_gate g
      WHERE g.route_id = ${q}.route_id AND g.provider = ${q}.provider AND g.model = ${q}.model
        AND (NOT g.ok OR coalesce((SELECT a.n FROM helper_active a WHERE a.assignment_id = g.assignment_id), 0) >= g.max_slots))`;
}

/** busy CTE 에 OR 로 붙이는 신선한 우선 역할 수요(§2.1). helperGateCte 가 같은 WITH 안의 busy 앞에 있어야 한다. */
export function helperDemandOnSql(): SQL {
  return sql`coalesce((SELECT d.on_ FROM demand d), false)`;
}

/** helperGateStatesSql 이 돌려주는 행(snake_case). */
export type HelperGateStateRow = {
  assignment_id: string; kind: HelperGateKind; route_id: string; provider: string; model: string; ok: boolean; active: number; max_slots: number;
};

/**
 * 장비 D 의 도우미 경로 상태(잠그지 않는다; assignment_id, kind 순). `route` 를 주면 그 (route, provider, model) 한 줄만 — requestSlot 의
 * 사전 거절(§2.2: 0 행 = 도우미 경로가 아님, 1 행 = ok·active·max_slots 로 판정). `deviceId` 가 SQL 이면 LATERAL 안에서 쓸 수 있다.
 */
export function helperGateStatesSql(deviceId: SQL | string, route?: Readonly<{ routeId: string; provider: string; model: string }>): SQL {
  const filter = route ? sql` WHERE g.route_id = ${route.routeId} AND g.provider = ${route.provider} AND g.model = ${route.model}` : sql``;
  return sql`WITH ${helperGateCte(deviceId)}
    SELECT g.assignment_id, g.kind, g.route_id, g.provider, g.model, g.ok, coalesce(a.n, 0)::int AS active, g.max_slots
    FROM helper_gate g LEFT JOIN helper_active a ON a.assignment_id = g.assignment_id${filter}
    ORDER BY g.assignment_id, g.kind`;
}

/** HelperGateStateRow → HelperGateState. */
export function helperGateStateFromRow(row: HelperGateStateRow): HelperGateState {
  return Object.freeze({ assignmentId: row.assignment_id, kind: row.kind, routeId: row.route_id, provider: row.provider, model: row.model,
    ok: row.ok === true, active: Number(row.active), maxSlots: Number(row.max_slots) });
}

// ── 감시자 decide 입력·출력(§3.5; 구현은 lib/operations/capacity-supervisor/decide.ts, 순수 함수) ──────────────────────

/** 주 장비 하나의 표본(deviceStateSql 의 active·limitSlots·waiting; AI2 는 local-direct second-review 대기 행의 가장 오래된 나이). */
export type HelperPrimaryDeviceSample = Readonly<{
  deviceId: string; active: number; limitSlots: number; waiting: number; oldestWaitingAgeMs: number | null;
}>;

/** 도우미 장비 자기 역할: PR 1b 장부 규칙(primaryBusy)과 beacon. beacon 이 신선하지 않거나 없으면 바쁨이다. */
export type HelperOwnRoleSample = Readonly<{ ledgerBusy: boolean; beacon: RoleDemandRow | null; beaconFresh: boolean }>;

/** 건강 창 집계(§3.4). 섀도는 현재 evidence_key 의 최근 shadowStatsWindow 실행, rolling 은 최근 rollingShadowWindow 결정 쌍. */
export type HelperHealthCounts = Readonly<{
  dispatch: Readonly<{ n: number; ok: number; unknown: number; failed: number; notStarted: number }>;
  shadow: Readonly<{ n: number; succeeded: number; failed: number; unknown: number; decided: number; agreed: number; wrongApproval: number; wrongRejection: number }>;
  rollingShadow: Readonly<{ decided: number; agreed: number }>;
  live: Readonly<{ ai2Agreed: number; ai2Disagreed: number; humanOverturned: number }>;
  /** 배정별 최근 행부터 센 연속 미확인 수. */
  consecutiveUnknowns: number;
}>;

export type HelperInputs = Readonly<{
  /** 스냅샷의 DB 시계(ms). */
  nowMs: number;
  /** 이번 순환의 감시자 epoch. previous.supervisorEpoch 와 다르면 streak 를 버리고 7단계부터 시작한다. */
  epoch: number;
  assignment: HelperAssignmentRow;
  previous: HelperSignalRow | null;
  /** 현재 배정 version 의 정지 행. */
  stops: readonly HelperStopRow[];
  /** 스냅샷이 모든 조각을 읽었는가. false ⇒ hold/stale_inputs. */
  snapshotComplete: boolean;
  /** 주 장비 표본. null = 모름(beacon stale·장비 상태 없음) ⇒ hold/stale_inputs. */
  primaryDevices: readonly HelperPrimaryDeviceSample[] | null;
  ownRole: HelperOwnRoleSample;
  health: HelperHealthCounts;
  /** 최근 1시간 섀도 실행 수(shadow_per_hour 와 견준다). */
  shadowRunsLastHour: number;
}>;

/** decide 가 제안하는 정지 행(쓰기 TX 는 (배정, version) 에 활성 정지가 없을 때만 넣는다). */
export type HelperStopProposal = Readonly<{
  effect: HelperStopEffect; reason: Extract<HelperReason, "unknown_rate" | "failure_rate" | "quality_regression">; evidence: HelperMetrics;
}>;

/** decide 의 결과 = 쓸 신호 한 줄(+ 선택적 정지). 시각은 ISO(nowMs 기준). valid_until 은 쓰기 TX 가 clock_timestamp() + signal_ttl_ms 로 정한다. */
export type HelperDecision = Readonly<{
  assignmentId: string; assignmentVersion: number; verdict: HelperVerdict; reason: HelperReason;
  /** 'help' 상태면 나가기 streak, 아니면 들어가기 streak. */
  streak: number; stateSince: string; lastExitAt: string | null; metrics: HelperMetrics; stop: HelperStopProposal | null;
}>;

export type DeviceDemandInputs = Readonly<{ nowMs: number; epoch: number; deviceId: string; beacons: readonly RoleDemandRow[] }>;
/** primary_demand = beacon 신선 && backlog > 0. 신선하지 않으면 false 와 metrics.reason 'stale'|'missing'(Layer A 는 장부 규칙으로 돌아간다). */
export type DeviceDemandDecision = Readonly<{
  deviceId: string; supervisorEpoch: number; primaryDemand: boolean; backlog: number;
  metrics: HelperMetrics & Readonly<{ reason: "fresh" | "stale" | "missing" }>;
}>;

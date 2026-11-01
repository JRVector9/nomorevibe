import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import type { ModelCapacityPolicy } from "@/lib/llm/capacity";
import { listModelCapacityDevices } from "@/lib/llm/capacity-devices-repository";
import {
  ASSIGNMENT_CLI_EQUIPMENT, ASSIGNMENT_STAGE_IDS, ASSIGNMENT_STAGES, ASSIGNMENT_TRANSPORTS, HELPER_ASSIGNMENT_ID_PATTERN, HELPER_NOTE_MAX,
  MODEL_ASSIGNMENT_SAVE_AUDIT_ACTION, assignmentRouteProvider, assignmentWireModel, localAssignmentContractRouteId, registryKeyEquipment,
  type AssignmentRole, type AssignmentStage, type AssignmentTransport, type HelperAssignmentRow, type HelperMode, type ModelAssignmentRefusal,
  type ModelAssignmentRow,
} from "@/lib/llm/capacity-helpers";
import {
  listHelperAssignments, readModelAssignments, saveModelAssignment, type ModelAssignmentContractSource, type ModelAssignmentDeps,
  type ModelAssignmentSaveResult,
} from "@/lib/llm/capacity-helpers-repository";
import type { ModelCapacityDeviceRow } from "@/lib/llm/capacity-devices";
import { planAssignmentImport, type AssignmentImportPlan, type AssignmentImportRow, type AssignmentImportSources } from "@/lib/llm/assignment-import";
import { readModelRegistry, type ModelDefinition } from "@/lib/llm/model-registry";
import { logger } from "@/lib/observability/logger";
import type { AssignmentFlag } from "@/lib/llm/assignment-flag";
import { assignmentFlagState, assignmentSources, type AssignmentReadSource } from "./admin-assignment-source";
import { readCapacityDevicesControl } from "./admin-capacity-devices";
import { adminLog, settingsChanges, type AdminLogRow } from "./admin-log";
import { HELPER_MODE_LABELS, modelHelperIssueMessage } from "./admin-model-helpers";
import { DrWriterFencedError } from "./dr/epoch";

/**
 * 관리자 「모델 배정」(/admin/models/assignments) 화면 모형 — PR 3b-D.
 *
 * 단계 × 장비 × 모델 × 순위 × 모드 × 전송 배정(model_helper_assignments 의 role 'primary' 행, migration 0156)을 보이고, PR 3b-A 의 저장 함수
 * `saveModelAssignment` 하나로 저장한다(재배포 없음). 저장 한 번이 계약 확인(없으면 readback + 1-token probe)·정책 route 덧붙이기(DRAIN 없음)·
 * 장비 순위·배정 행·감사 한 줄을 한 TX 에 한다 — 여기서는 감사 줄을 **또 쓰지 않는다**.
 *
 * - 도우미 행(role 'helper')은 표에 함께 보이지만 바꾸지 않는다 — 섀도·승격은 「도우미 장비」(/admin/models/helpers, PR 2a·2b·2c)에서 한다.
 * - 이 화면의 배정 행을 읽어 모델을 고르는 쪽은 3b-B 다. 스위치는 3b-E 부터 runtime_settings 토글 「배정 표 읽기」(이 화면의 폼, 저장 즉시 모든 역할)이고
 *   env MODEL_ASSIGNMENT_TABLE 은 강제다. 읽기 출처는 admin-assignment-source(3b-B 의 assignmentSource·3b-E 의 assignmentFlagState)가 준다.
 * - 거절 코드 → 한국어 문장(무엇을 하면 되는지)은 modelAssignmentIssueMessage 한 곳에서 만든다(모르는 코드는 그대로 보인다).
 * - 「현재 설정 → 배정 표 가져오기」는 lib/llm/assignment-import.ts 의 planAssignmentImport(3b-B)가 만든 계획을 행마다 같은 저장 함수로 적용한다.
 *
 * 이 모듈은 DB·node:crypto 를 쓰는 서버 모듈이다. 클라이언트 폼은 여기서 만든 값(문자열·숫자·배열)과 `import type` 만 쓴다.
 */

// ---------- 이름 ----------

/** 단계 이름 — 도우미 화면(1차·2차 검수)·단계별 모델(ADMIN_MODEL_STAGES)·실시간 한도(ROUTE_LABELS)와 같은 말 */
export const ASSIGNMENT_STAGE_LABELS: Readonly<Record<AssignmentStage, string>> = {
  ai1: "1차 검수", ai2: "2차 검수", human: "사람 위임 검수", audit: "발행분 감사", "audit-second-opinion": "감사 두 번째 의견", intro: "소개 검수",
  screen: "화면 판별", assist: "LLM 보강", "assist-audit": "LLM 보강 · 감사", reason: "심사 사유 번역", tagline: "수집 소개 생성",
  profile: "검색 키워드·프로필 생성", verify: "검색 키워드 검증", ko: "한국어 소개 번역", translate: "제품 다국어 번역", "publish-classify": "발행 분류",
  repo: "저장소 검토",
};
export const ASSIGNMENT_TRANSPORT_LABELS: Readonly<Record<AssignmentTransport, string>> = {
  gateway: "장비 표지", direct: "엔진 직접", "local-direct": "로컬 직접", cli: "CLI",
};
export const ASSIGNMENT_ROLE_LABELS: Readonly<Record<AssignmentRole, string>> = { primary: "주 배정", helper: "도우미" };
export const ASSIGNMENT_MODE_LABELS: Readonly<Record<HelperMode, string>> = HELPER_MODE_LABELS;
export type AssignmentStageSource = AssignmentReadSource | "table_empty";
export const ASSIGNMENT_SOURCE_LABELS: Readonly<Record<AssignmentStageSource, string>> = { table: "표", legacy: "설정", table_empty: "표 비어 있음" };
/**
 * 상태 띠(PR 3b-E) — 스위치의 출처까지 보인다. runtime = runtime_settings 토글(모든 역할이 같은 행을 30초 안에 읽는다, 재배포 없음),
 * env = 이 프로세스의 MODEL_ASSIGNMENT_TABLE 강제(토글이 닿지 않는다 — 비상용), unread = 토글을 아직 못 읽음(표가 고르는 길목은 읽을 때까지 미룬다).
 */
export type AssignmentReadBannerKind = "runtime_off" | "runtime_on" | "env_off" | "env_on" | "unread";
export const ASSIGNMENT_READ_BANNERS: Readonly<Record<AssignmentReadBannerKind, string>> = {
  runtime_off: "읽기: 설정(legacy). 아래 「배정 표 읽기」를 켜면 저장 즉시(30초 안) 모든 역할이 표를 읽습니다 — 재배포 없음",
  runtime_on: "읽기: 배정 표 읽기 켜짐(runtime_settings 토글) — 단계마다 아래 출처(표 · 설정 · 표 비어 있음)를 따릅니다",
  env_off: "읽기: 설정(legacy) — env MODEL_ASSIGNMENT_TABLE=0 이 이 프로세스에서 강제로 끕니다. 토글은 이 프로세스에 닿지 않습니다(비상용)",
  env_on: "읽기: 배정 표 읽기 env 강제(MODEL_ASSIGNMENT_TABLE=1, 이 프로세스) — 토글은 이 프로세스에 닿지 않습니다. 단계마다 아래 출처를 따릅니다",
  unread: "읽기: 배정 표 읽기 토글(runtime_settings)을 아직 읽지 못했습니다 — 표가 고르는 길목은 읽을 때까지 미룹니다(assignments_unavailable). 설정(legacy)으로 보입니다",
};
export const ASSIGNMENT_FLAG_OFF_BANNER = ASSIGNMENT_READ_BANNERS.runtime_off;
export const ASSIGNMENT_FLAG_ON_BANNER = ASSIGNMENT_READ_BANNERS.runtime_on;
/** 스위치 상태 → 띠 종류 */
export function assignmentReadBannerKind(flag: Pick<AssignmentFlag, "enabled" | "source">): AssignmentReadBannerKind {
  if (flag.source === "unread") return "unread";
  if (flag.source === "env") return flag.enabled ? "env_on" : "env_off";
  return flag.enabled ? "runtime_on" : "runtime_off";
}
export const ASSIGNMENT_CONTRACT_SOURCE_LABELS: Readonly<Record<ModelAssignmentContractSource, string>> = {
  stored: "저장된 계약", probed: "엔진 확인(readback·1토큰)으로 새로 만든 계약", cli: "CLI 계약",
};
/** 폼의 순위 상한(표는 64 까지 받지만 한 단계에 8 이상을 둘 일이 없다 — 단계별 모델 풀 상한과 같다) */
export const ASSIGNMENT_FORM_RANK_MAX = 8;
/** mode live 저장의 확인 글자 */
export const ASSIGNMENT_LIVE_CONFIRM = "배정";
export const ASSIGNMENT_PAGE = "/admin/models/assignments";
const AUDIT_ROWS = 20;
const CONTRACT_HASH_PREFIX = 12;

// ---------- 고를 수 있는 것(순수) ----------

/** 단계에서 그 등록부 모델이 쓸 수 있는 전송: 단계가 허락 × 공급자가 맞음 × cli 는 connect 장비만. 권하는 것이 먼저(장비 표지 gatewayLabel 이 있으면 그 전송, 없으면 엔진 직접). 값 gateway 는 요청 이름 앞 대괄호이고, 텍스트 경로를 여는 것은 직접 연결 계약이다. */
export function assignmentTransportsFor(stage: AssignmentStage, entry: Pick<ModelDefinition, "key" | "provider" | "gatewayLabel">): AssignmentTransport[] {
  const spec = ASSIGNMENT_STAGES[stage];
  const allowed = ASSIGNMENT_TRANSPORTS.filter(transport => spec.transports.has(transport) && assignmentRouteProvider(transport, entry.provider) !== null
    && (transport !== "cli" || registryKeyEquipment(entry.key) === ASSIGNMENT_CLI_EQUIPMENT));
  const preferred: AssignmentTransport = entry.gatewayLabel ? "gateway" : "direct";
  return allowed.toSorted((a, b) => Number(b === preferred) - Number(a === preferred));
}

export type AssignmentStageOption = { id: AssignmentStage; label: string; routeId: string | null; transports: AssignmentTransport[]; vote: boolean; reserved: boolean };
export type AssignmentRegistryOption = { key: string; label: string; provider: string; equipment: string;
  /** 전송마다의 wire 모델(저장이 정하는 이름 그대로) */
  wire: Partial<Record<AssignmentTransport, string>>;
  /** 단계마다 고를 수 있는 전송(빈 단계는 빠진다) */
  transportsByStage: Partial<Record<AssignmentStage, AssignmentTransport[]>> };
export type AssignmentDeviceOption = { id: string; enabled: boolean };
export type AssignmentFormOptions = { stages: AssignmentStageOption[]; registry: AssignmentRegistryOption[]; devices: AssignmentDeviceOption[];
  transportLabels: Record<AssignmentTransport, string>; rankMax: number; confirmWord: string };

export const ASSIGNMENT_STAGE_OPTIONS: readonly AssignmentStageOption[] = ASSIGNMENT_STAGE_IDS.map(id => {
  const spec = ASSIGNMENT_STAGES[id];
  return { id, label: ASSIGNMENT_STAGE_LABELS[id], routeId: spec.routeId, transports: [...spec.transports], vote: spec.vote, reserved: spec.routeId === null || !spec.transports.size };
});

export function assignmentFormOptions(models: readonly ModelDefinition[], devices: readonly Pick<ModelCapacityDeviceRow, "deviceId" | "enabled">[]): AssignmentFormOptions {
  const registry = models.flatMap(entry => {
    const transportsByStage = Object.fromEntries(ASSIGNMENT_STAGE_IDS.map(stage => [stage, assignmentTransportsFor(stage, entry)])
      .filter(([, list]) => list.length > 0)) as Partial<Record<AssignmentStage, AssignmentTransport[]>>;
    if (!Object.keys(transportsByStage).length) return [];
    const wire = Object.fromEntries(ASSIGNMENT_TRANSPORTS.filter(transport => assignmentRouteProvider(transport, entry.provider) !== null)
      .map(transport => [transport, assignmentWireModel(transport, entry)])) as Partial<Record<AssignmentTransport, string>>;
    return [{ key: entry.key, label: `${entry.displayName} (${entry.key})`, provider: entry.provider, equipment: entry.equipment, wire, transportsByStage }];
  });
  return { stages: ASSIGNMENT_STAGE_OPTIONS.map(stage => ({ ...stage, transports: [...stage.transports] })), registry,
    devices: devices.map(device => ({ id: device.deviceId, enabled: device.enabled })).toSorted((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id)),
    transportLabels: { ...ASSIGNMENT_TRANSPORT_LABELS }, rankMax: ASSIGNMENT_FORM_RANK_MAX, confirmWord: ASSIGNMENT_LIVE_CONFIRM };
}

/** 새 배정 이름: <장비>:<단계>:<등록부 key>. 모양이 맞지 않으면 null(폼이 직접 적게 한다) */
export function assignmentIdFor(deviceId: string, stage: string, registryKey: string): string | null {
  const id = `${deviceId}:${stage}:${registryKey}`;
  return HELPER_ASSIGNMENT_ID_PATTERN.test(id) ? id : null;
}

// ---------- 화면 모형(순수) ----------

export type AssignmentContractRow = { id: number; routeId: string; model: string; contractHash: string; transport: string };
export type AssignmentSettledCount = { routeId: string; model: string; groupId: string; settled: number };
export type AssignmentContractView = { state: "present" | "missing" | "cli" | "helper"; label: string; hashPrefix: string | null; transportMismatch: boolean };
export type AssignmentRouteView = { state: "present" | "missing" | "other_device" | "unknown"; label: string };
export type AssignmentRowView = {
  assignmentId: string; stage: AssignmentStage; role: AssignmentRole; roleLabel: string; deviceId: string;
  /** 서버 이름(모델 카드의 modelServerName 이 이 base 에 아직 없다 — 들어오면 채운다). 없으면 null */
  deviceName: string | null;
  registryKey: string | null; registryLabel: string | null; model: string; transport: AssignmentTransport | null; transportLabel: string;
  rank: number | null; vote: boolean; mode: HelperMode; modeLabel: string; routeId: string; provider: string; maxSlots: number;
  contract: AssignmentContractView; route: AssignmentRouteView; deviceRoleRank: number | null; settled1h: number | null;
  version: number; updatedBy: string; updatedAt: string; note: string | null;
  /** 도우미 행은 도우미 화면으로(섀도·승격) */
  helperHref: string | null; editHref: string | null; issues: string[];
};
export type AssignmentStageGroupView = AssignmentStageOption & { source: AssignmentStageSource; sourceLabel: string; rows: AssignmentRowView[];
  liveCount: number; transportLabel: string };
export type AssignmentAuditView = { id: number; actor: string; at: string; ok: boolean; target: string; version: number | null; changes: string[]; error: string | null };
export type ModelAssignmentsAdminView = {
  /** flagSource(3b-E): runtime 토글 · env 강제 · unread(못 읽음). banner 는 그 조합의 글 */
  nowMs: number; flagOn: boolean; flagSource: AssignmentFlag["source"]; banner: string; groups: AssignmentStageGroupView[]; options: AssignmentFormOptions;
  counts: { primary: number; live: number; helpers: number };
  policy: { mode: string; revision: number; routes: number } | null;
  /** 못 읽은 것(화면은 뜬다). rows 를 못 읽으면 저장 칸을 막는다 */
  errors: Partial<Record<"rows" | "helpers" | "devices" | "policy" | "contracts" | "counts" | "registry", string>>;
  audit: AssignmentAuditView[]; readOnly: boolean;
};
export type ModelAssignmentsViewInput = {
  assignments: readonly ModelAssignmentRow[] | null; helpers?: readonly HelperAssignmentRow[] | null;
  devices: readonly ModelCapacityDeviceRow[] | null; policy?: { mode: string; revision: number; policy: ModelCapacityPolicy | null } | null;
  contracts?: readonly AssignmentContractRow[] | null; settled?: readonly AssignmentSettledCount[] | null;
  models: readonly ModelDefinition[]; flagOn?: boolean; flagSource?: AssignmentFlag["source"]; sources?: Partial<Record<AssignmentStage, AssignmentReadSource>>;
  audit?: readonly AdminLogRow[]; errors?: ModelAssignmentsAdminView["errors"]; now?: Date;
};

const fmt = (value: number) => value.toLocaleString("ko-KR");
const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const helperHref = (assignmentId: string) => `/admin/models/helpers#helper-${assignmentId}`;
export const assignmentEditHref = (assignmentId: string) => `${ASSIGNMENT_PAGE}?edit=${encodeURIComponent(assignmentId)}#form`;

function contractView(row: Pick<AssignmentRowView, "role" | "transport" | "routeId" | "model">, contracts: readonly AssignmentContractRow[] | null): AssignmentContractView {
  if (row.role === "helper") return { state: "helper", label: "도우미 화면에서", hashPrefix: null, transportMismatch: false };
  if (row.transport === "cli") return { state: "cli", label: "CLI 계약(저장·실행 때 확인)", hashPrefix: null, transportMismatch: false };
  if (contracts === null) return { state: "missing", label: "모름(계약을 읽지 못함)", hashPrefix: null, transportMismatch: false };
  const routeId = row.transport === "local-direct" ? localAssignmentContractRouteId(row.routeId) : row.routeId;
  const found = contracts.find(contract => contract.routeId === routeId && contract.model === row.model);
  if (!found) return { state: "missing", label: "없음", hashPrefix: null, transportMismatch: false };
  const expected = row.transport === "direct" ? "direct" : "gateway";
  const transportMismatch = row.transport !== "local-direct" && found.transport !== expected;
  return { state: "present", label: "있음", hashPrefix: found.contractHash.slice(0, CONTRACT_HASH_PREFIX), transportMismatch };
}
function routeView(row: Pick<AssignmentRowView, "routeId" | "provider" | "model" | "deviceId">, policy: ModelCapacityPolicy | null | undefined): AssignmentRouteView {
  if (!policy) return { state: "unknown", label: "모름(정책 없음·못 읽음)" };
  const same = policy.routes.filter(route => route.routeId === row.routeId && route.provider === row.provider && route.model === row.model);
  if (same.some(route => route.groupId === row.deviceId)) return { state: "present", label: "있음" };
  if (same.length) return { state: "other_device", label: `다른 장비(${same.map(route => route.groupId).join(", ")})` };
  return { state: "missing", label: "없음" };
}

/** 순수 — DB 없이 시험한다. 못 읽은 것은 그 자리를 「모름」·「—」로 두고 화면은 뜬다 */
export function buildModelAssignmentsAdminView(input: ModelAssignmentsViewInput): ModelAssignmentsAdminView {
  const now = input.now ?? new Date();
  const errors = { ...input.errors };
  const assignments = input.assignments ?? [];
  const helpers = input.helpers ?? [];
  const devices = input.devices ?? [];
  const policy = input.policy?.policy ?? null;
  const contracts = input.contracts === undefined ? [] : input.contracts;
  const settled = input.settled ?? null;
  const flagOn = input.flagOn === true;
  // 출처가 없으면(시험·옛 호출) runtime 토글로 본다 — 띠는 「켜짐/꺼짐」의 runtime 글
  const flagSource: AssignmentFlag["source"] = input.flagSource ?? "runtime";
  const registryByKey = new Map(input.models.map(entry => [entry.key, entry]));
  const deviceById = new Map(devices.map(device => [device.deviceId, device]));
  const roleRank = (deviceId: string, routeId: string) => deviceById.get(deviceId)?.roles.find(role => role.routeId === routeId)?.rank ?? null;
  const settledOf = (routeId: string, model: string, groupId: string) => settled === null ? null
    : settled.filter(row => row.routeId === routeId && row.model === model && row.groupId === groupId).reduce((sum, row) => sum + row.settled, 0);

  const primaryRows: AssignmentRowView[] = assignments.map(row => {
    const entry = registryByKey.get(row.registryKey);
    const base = { role: "primary" as const, transport: row.transport, routeId: row.routeId, provider: row.provider, model: row.model, deviceId: row.deviceId };
    const view: AssignmentRowView = {
      assignmentId: row.assignmentId, stage: row.stage, role: "primary", roleLabel: ASSIGNMENT_ROLE_LABELS.primary, deviceId: row.deviceId, deviceName: null,
      registryKey: row.registryKey, registryLabel: entry ? entry.displayName : null, model: row.model, transport: row.transport,
      transportLabel: ASSIGNMENT_TRANSPORT_LABELS[row.transport], rank: row.rank, vote: row.vote, mode: row.mode, modeLabel: ASSIGNMENT_MODE_LABELS[row.mode],
      routeId: row.routeId, provider: row.provider, maxSlots: row.maxSlots, contract: contractView(base, contracts), route: routeView(base, policy),
      deviceRoleRank: roleRank(row.deviceId, row.routeId), settled1h: settledOf(row.routeId, row.model, row.deviceId),
      version: row.version, updatedBy: row.updatedBy, updatedAt: row.updatedAt, note: row.note, helperHref: null, editHref: assignmentEditHref(row.assignmentId), issues: [],
    };
    const device = deviceById.get(row.deviceId);
    if (!entry) view.issues.push(`등록부에 없는 key(${row.registryKey}) — 모델 연결 화면에서 등록부를 확인하세요`);
    if (input.devices && !device) view.issues.push("장비 행이 없습니다 — 장비 한도에서 이 장비를 저장하세요");
    else if (device && !device.enabled) view.issues.push("장비 행이 꺼져 있습니다 — 입장 판정이 이 장비를 보지 않습니다");
    if (view.mode === "live" && view.contract.state === "missing" && contracts !== null) view.issues.push("켜진 계약이 없습니다(꺼졌거나 지워짐) — 다시 저장하면 엔진을 확인해 계약을 만듭니다");
    if (view.contract.transportMismatch) view.issues.push("저장된 계약의 전송이 배정 전송과 다릅니다 — 「모델 연결」에서 직접 연결 계약인지 확인하세요");
    if (view.mode === "live" && view.route.state === "missing") view.issues.push("현재 정책에 이 경로가 없습니다 — 다시 저장하면 덧붙입니다");
    if (view.route.state === "other_device") view.issues.push("같은 경로·공급자·모델이 정책에서 다른 장비에 묶여 있습니다");
    if (view.deviceRoleRank !== null && view.deviceRoleRank !== row.rank)
      view.issues.push(`장비 역할 순위(${fmt(view.deviceRoleRank)})가 배정 순위(${fmt(row.rank)})와 다릅니다 — 장비 한도에서 바뀌었습니다. 다시 저장하면 맞춥니다`);
    return view;
  });
  const helperRows: AssignmentRowView[] = helpers.map(row => ({
    assignmentId: row.assignmentId, stage: row.stage, role: "helper", roleLabel: ASSIGNMENT_ROLE_LABELS.helper, deviceId: row.deviceId, deviceName: null,
    registryKey: null, registryLabel: null, model: row.model, transport: null, transportLabel: "—", rank: null, vote: false, mode: row.mode,
    modeLabel: ASSIGNMENT_MODE_LABELS[row.mode], routeId: row.liveRouteId, provider: row.liveProvider, maxSlots: row.maxSlots,
    contract: { state: "helper", label: "도우미 화면에서", hashPrefix: null, transportMismatch: false },
    route: routeView({ routeId: row.liveRouteId, provider: row.liveProvider, model: row.model, deviceId: row.deviceId }, policy),
    deviceRoleRank: roleRank(row.deviceId, row.liveRouteId), settled1h: settledOf(row.liveRouteId, row.model, row.deviceId),
    version: row.version, updatedBy: row.updatedBy, updatedAt: row.updatedAt, note: row.note ?? null, helperHref: helperHref(row.assignmentId), editHref: null, issues: [],
  }));
  const sortRows = (rows: AssignmentRowView[]) => rows.toSorted((a, b) => Number(a.role === "helper") - Number(b.role === "helper")
    || (a.rank ?? 99) - (b.rank ?? 99) || (a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0));
  const groups: AssignmentStageGroupView[] = ASSIGNMENT_STAGE_OPTIONS.map(stage => {
    const rows = sortRows([...primaryRows, ...helperRows].filter(row => row.stage === stage.id));
    const liveCount = rows.filter(row => row.role === "primary" && row.mode === "live").length;
    const source: AssignmentStageSource = flagOn && input.sources?.[stage.id] === "table" ? (liveCount > 0 ? "table" : "table_empty") : "legacy";
    return { ...stage, transports: [...stage.transports], source, sourceLabel: ASSIGNMENT_SOURCE_LABELS[source], rows, liveCount,
      transportLabel: stage.transports.length ? stage.transports.map(transport => ASSIGNMENT_TRANSPORT_LABELS[transport]).join(" · ") : "예약(아직 배정 없음)" };
  });
  const readOnly = input.assignments === null;
  return {
    nowMs: now.getTime(), flagOn, flagSource, banner: ASSIGNMENT_READ_BANNERS[assignmentReadBannerKind({ enabled: flagOn, source: flagSource })], groups,
    options: assignmentFormOptions(input.models, devices),
    counts: { primary: primaryRows.length, live: primaryRows.filter(row => row.mode === "live").length, helpers: helperRows.length },
    policy: input.policy ? { mode: input.policy.mode, revision: input.policy.revision, routes: input.policy.policy?.routes.length ?? 0 } : null,
    errors, audit: assignmentAuditView(input.audit ?? []), readOnly,
  };
}

// ---------- 감사 줄 ----------

const AUDIT_FIELDS: Readonly<Record<string, string>> = {
  registryKey: "모델(등록부)", model: "wire 모델", transport: "전송", rank: "순위", vote: "표", mode: "모드", maxSlots: "최대 칸", note: "메모",
  routeId: "경로", provider: "공급자",
};
function auditValue(path: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "없음";
  if (path === "mode" && typeof value === "string") return ASSIGNMENT_MODE_LABELS[value as HelperMode] ?? value;
  if (path === "transport" && typeof value === "string") return ASSIGNMENT_TRANSPORT_LABELS[value as AssignmentTransport] ?? value;
  if (path === "vote" && typeof value === "boolean") return value ? "투표" : "아님";
  if (typeof value === "number") return fmt(value);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
/** 감사 detail(저장 함수가 남긴 before·after·계약·route·장비 순위) → "이름: 전 → 후" 줄 */
export function assignmentAuditChangeLines(row: Pick<AdminLogRow, "detail">): string[] {
  const detail = isPlainObject(row.detail) ? row.detail : {};
  const pick = (value: unknown) => isPlainObject(value) ? Object.fromEntries(Object.keys(AUDIT_FIELDS).map(key => [key, value[key]])) : {};
  const lines = settingsChanges(pick(detail.before), pick(detail.after)).flatMap(change => {
    const before = auditValue(change.path, change.before), after = auditValue(change.path, change.after);
    return before === after ? [] : [`${AUDIT_FIELDS[change.path] ?? change.path}: ${before} → ${after}`];
  });
  if (detail.offOnly === true) lines.push("끄기만 — 계약·정책 경로를 보지 않음");
  const contract = isPlainObject(detail.contract) ? detail.contract : null;
  if (contract && contract.source === "probed") lines.push(`계약: 새로 만듦(${String(contract.contractHash ?? "").slice(0, CONTRACT_HASH_PREFIX)})`);
  if (detail.appended === true) lines.push(`정책 경로 덧붙임(revision ${auditValue("revision", detail.policyRevision)})`);
  const role = isPlainObject(detail.deviceRole) ? detail.deviceRole : null;
  if (role && role.before !== role.after) lines.push(`장비 역할 순위: ${auditValue("rank", role.before)} → ${auditValue("rank", role.after)}`);
  return lines;
}
export function assignmentAuditView(rows: readonly AdminLogRow[]): AssignmentAuditView[] {
  return rows.slice(0, AUDIT_ROWS).map(row => {
    const detail = isPlainObject(row.detail) ? row.detail : {};
    return { id: row.id, actor: row.actor, at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt), ok: row.ok,
      target: String(row.target ?? ""), version: finite(detail.version), changes: assignmentAuditChangeLines(row), error: row.error ?? null };
  });
}

// ---------- 읽기 ----------

const settle = <T>(work: Promise<T>) => work.then(value => ({ value, error: null as string | null }),
  (error: unknown) => ({ value: null as T | null, error: error instanceof Error ? error.message : String(error) }));

/** 배정 단계 route 의 켜진 계약(gateway·direct 는 route 그대로, local-direct 는 `local-direct:<route>`). 키는 읽지 않는다 */
export async function readAssignmentContracts(): Promise<AssignmentContractRow[]> {
  const routes = [...new Set(ASSIGNMENT_STAGE_IDS.flatMap(stage => { const routeId = ASSIGNMENT_STAGES[stage].routeId; return routeId ? [routeId, localAssignmentContractRouteId(routeId)] : []; }))];
  const rows = await onPrimary(() => db.execute<{ id: number; route_id: string; model: string; contract_hash: string; transport: string }>(
    sql`SELECT id::float8 AS id, route_id, model, contract_hash, transport FROM model_serving_contracts
      WHERE enabled AND route_id IN (${sql.join(routes.map(route => sql`${route}`), sql`, `)}) ORDER BY id`));
  return rows.map(row => ({ id: Number(row.id), routeId: row.route_id, model: row.model, contractHash: row.contract_hash, transport: row.transport }));
}

/**
 * 최근 1시간 정산(settled) 건수 — (route, 모델, 장비)마다. settled_at 부분 색인(model_capacity_requests_settled_at_idx)의 범위 읽기 하나이고,
 * 2초를 넘기면 끊는다(화면은 「—」). TODO(3b-D): 배정이 많아지고 이 읽기가 무거워지면 운영센터 관측(admin-models-observation)의 1h 집계를 재사용한다.
 */
export async function readAssignmentSettledCounts(): Promise<AssignmentSettledCount[]> {
  const rows = await onPrimary(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
    return tx.execute<{ route_id: string; model: string; group_id: string; settled: number }>(sql`SELECT route_id, model, group_id, count(*)::int AS settled
      FROM model_capacity_requests WHERE state = 'settled' AND settled_at >= clock_timestamp() - interval '1 hour' GROUP BY route_id, model, group_id`);
  }, { accessMode: "read only" }));
  return rows.map(row => ({ routeId: row.route_id, model: row.model, groupId: row.group_id, settled: Number(row.settled) }));
}

async function readRegistryModels(): Promise<ModelDefinition[]> {
  const { ensureServingContracts } = await import("@/lib/llm/serving-contract-store");
  // 관리자 등록부 덮어쓰기(0148)까지 합친 등록부 — 저장 함수가 고르는 등록부와 같다
  await ensureServingContracts();
  return [...readModelRegistry().models];
}

/** 화면 한 번 그리기 — 배정·도우미·장비·정책·계약·1h 건수·감사·등록부·읽기 출처. 어느 하나를 못 읽어도 화면은 뜬다(그 자리에 이유) */
export async function readModelAssignmentsAdminView(now = new Date()): Promise<ModelAssignmentsAdminView> {
  const [assignments, helpers, devices, control, contracts, settled, registry, flag, sources, audit] = await Promise.all([
    settle(readModelAssignments()), settle(listHelperAssignments()), settle(listModelCapacityDevices()), settle(readCapacityDevicesControl()),
    settle(readAssignmentContracts()), settle(readAssignmentSettledCounts()), settle(readRegistryModels()),
    assignmentFlagState(), assignmentSources(ASSIGNMENT_STAGE_IDS),
    adminLog({ actions: [MODEL_ASSIGNMENT_SAVE_AUDIT_ACTION] }).catch(() => [] as AdminLogRow[]),
  ]);
  const errors: ModelAssignmentsAdminView["errors"] = {};
  for (const [key, result] of [["rows", assignments], ["helpers", helpers], ["devices", devices], ["policy", control], ["contracts", contracts],
    ["counts", settled], ["registry", registry]] as const) if (result.error) errors[key] = result.error;
  return buildModelAssignmentsAdminView({ assignments: assignments.value, helpers: helpers.value, devices: devices.value,
    policy: control.value ? { mode: control.value.mode, revision: control.value.revision, policy: control.value.policy } : null,
    contracts: contracts.value, settled: settled.value, models: registry.value ?? [], flagOn: flag.enabled, flagSource: flag.source, sources, audit, errors, now });
}

// ---------- 폼 → 저장 입력 ----------

type FormLike = { get(name: string): FormDataEntryValue | null };
const text = (value: FormDataEntryValue | null) => typeof value === "string" ? value.trim() : "";
const intOf = (raw: string): number | undefined => /^\d{1,4}$/.test(raw) ? Number(raw) : undefined;
export type AssignmentFormParse = { input: Record<string, unknown> | null; issues: string[] };

/**
 * 폼 칸: expectedVersion(빈 값 = 새 배정) · assignmentId(비우면 <장비>:<단계>:<등록부 key>) · stage · deviceId · registryKey · transport · rank(1~8) ·
 * role(primary 만 — helper 는 도우미 화면으로) · vote(체크) · mode(off·live) · maxSlots(숨은 값, 기본 1) · note · confirm(mode live 면 「배정」).
 * 돌려주는 issues 는 거절 코드다(modelAssignmentIssueMessage 가 문장으로 바꾼다). 범위·교차 검사의 기준은 저장 함수의 zod 다 — 여기서는 모양만 본다.
 */
export function modelAssignmentInputFromForm(form: FormLike): AssignmentFormParse {
  const issues: string[] = [];
  const rawVersion = text(form.get("expectedVersion"));
  const expectedVersion = rawVersion === "" ? null : /^\d{1,15}$/.test(rawVersion) && Number(rawVersion) >= 1 ? Number(rawVersion) : undefined;
  if (expectedVersion === undefined) issues.push("model_assignment_invalid:expectedVersion");
  const stage = text(form.get("stage")), deviceId = text(form.get("deviceId")), registryKey = text(form.get("registryKey"));
  const transport = text(form.get("transport")), role = text(form.get("role")) || "primary", mode = text(form.get("mode")) || "off";
  if (role === "helper") return { input: null, issues: ["assignment_helper_role"] };
  if (role !== "primary") issues.push("model_assignment_invalid:role");
  if (!(ASSIGNMENT_STAGE_IDS as readonly string[]).includes(stage)) issues.push("model_assignment_invalid:stage");
  if (!deviceId) issues.push("assignment_device_required");
  if (!registryKey) issues.push("assignment_registry_required");
  if (!(ASSIGNMENT_TRANSPORTS as readonly string[]).includes(transport)) issues.push("model_assignment_invalid:transport");
  const rank = intOf(text(form.get("rank")));
  if (rank === undefined || rank < 1 || rank > ASSIGNMENT_FORM_RANK_MAX) issues.push("model_assignment_invalid:rank");
  const maxSlotsRaw = text(form.get("maxSlots"));
  const maxSlots = maxSlotsRaw === "" ? 1 : intOf(maxSlotsRaw);
  if (maxSlots === undefined) issues.push("model_assignment_invalid:maxSlots");
  if (mode !== "off" && mode !== "live") issues.push("model_assignment_invalid:mode");
  const voteRaw = text(form.get("vote"));
  const vote = voteRaw === "on" || voteRaw === "true";
  const note = text(form.get("note"));
  if (note.length > HELPER_NOTE_MAX) issues.push("model_assignment_invalid:note");
  let assignmentId = text(form.get("assignmentId"));
  if (!assignmentId && deviceId && stage && registryKey) assignmentId = assignmentIdFor(deviceId, stage, registryKey) ?? "";
  if (!assignmentId) issues.push("assignment_id_required");
  if (mode === "live" && text(form.get("confirm")) !== ASSIGNMENT_LIVE_CONFIRM) issues.push("assignment_confirm_required");
  if (issues.length) return { input: null, issues };
  return { input: { assignmentId, expectedVersion, stage, deviceId, registryKey, transport, rank, role: "primary", vote, mode, maxSlots, note: note || null }, issues };
}

/** 저장된 배정 행 → 저장 입력(끄기·다시 저장). 바꾸는 칸은 patch 로 */
export function modelAssignmentInputOf(row: ModelAssignmentRow, patch: Partial<{ mode: "off" | "live"; expectedVersion: number | null }> = {}) {
  return { assignmentId: row.assignmentId, expectedVersion: patch.expectedVersion === undefined ? row.version : patch.expectedVersion, stage: row.stage,
    deviceId: row.deviceId, registryKey: row.registryKey, transport: row.transport, rank: row.rank, role: "primary" as const, vote: row.vote,
    mode: patch.mode ?? (row.mode === "live" ? "live" as const : "off" as const), maxSlots: row.maxSlots, note: row.note };
}

// ---------- 저장(PR 3b-A saveModelAssignment 한 번, 쓰기 TX 하나) ----------

let depsForTest: ModelAssignmentDeps | null = null;
/**
 * 테스트 전용 — 저장 함수의 바깥 의존(등록부·계약 readback/probe·CLI 계약)을 바꾼다. null 이면 운영 배선: 저장 함수의 기본값
 * (등록부 = ensureServingContracts 뒤 readModelRegistry, probeContract = admin-engine-connect 의 probeEngineContract — 등록부 baseUrl 의
 * `/models` readback + 1-token probe, 어느 전송이든 키 없음(게이트웨이 키 env 는 2026-10-31 제거); cliContract = probeCliServingContracts 뒤 resolveCliServingContract).
 */
export function setModelAssignmentDepsForTest(deps: ModelAssignmentDeps | null): void { depsForTest = deps; }
const assignmentDeps = (): ModelAssignmentDeps => depsForTest ?? {};

const SAFE_CODE = /^[a-z0-9_:.-]{1,200}$/;
/** 던진 것 → 거절 코드. fence 는 그 이유(site_fenced 등), 코드 모양이면 그대로, 아니면 model_assignment_save_failed(로그에 남긴다) */
function issueCodeOf(error: unknown): string {
  if (error instanceof DrWriterFencedError) return error.reason;
  const message = error instanceof Error ? error.message : String(error);
  if (SAFE_CODE.test(message)) return message;
  logger.warn("model_assignment.save_failed", { error: message.slice(0, 300) });
  return "model_assignment_save_failed";
}
const validActor = (actor: string) => typeof actor === "string" && !!actor.trim() && actor.length <= 120;

export type SaveModelAssignmentAdminResult = { ok: true; created: boolean; result: ModelAssignmentSaveResult } | { ok: false; issues: string[] };
/**
 * 배정 하나 저장 — onPrimary 의 쓰기 TX 하나에서 saveModelAssignment(tx, input, actor, deps). 그 안이 replay 거부 → zod → 등록부 → 계약 확인(없으면
 * readback + probe; 실패 = 거절) → DR fence → control FOR UPDATE → 장비 행 → 배정 행 CAS → 정책 route 덧붙이기 → 장비 순위 → upsert → 감사 한 줄을 모두 한다.
 * 던지면 TX 가 되돌려 아무것도 남지 않는다 — 거절 코드를 돌려준다.
 */
export async function saveAdminModelAssignment(input: unknown, actor: string): Promise<SaveModelAssignmentAdminResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  try {
    const result = await onPrimary(() => db.transaction(tx => saveModelAssignment(tx, input, actor, assignmentDeps())));
    logger.info("model_assignment.saved", { actor, assignmentId: result.after.assignmentId, version: result.after.version, mode: result.after.mode,
      appended: result.appended.length > 0, contract: result.contract?.source ?? "skipped", offOnly: result.offOnly });
    return { ok: true, created: result.before === null, result };
  } catch (error) { return { ok: false, issues: [issueCodeOf(error)] }; }
}

/** 「끄기」 — 지금 행을 mode off 로 같은 저장 함수에 다시 넣는다(CAS = 화면이 본 판). 계약·route·장비 순위는 그대로 남는다 */
export async function turnOffAdminModelAssignment(assignmentId: string, expectedVersion: number, actor: string): Promise<SaveModelAssignmentAdminResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  if (!HELPER_ASSIGNMENT_ID_PATTERN.test(assignmentId)) return { ok: false, issues: ["model_assignment_invalid:assignmentId"] };
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return { ok: false, issues: ["model_assignment_invalid:expectedVersion"] };
  let row: ModelAssignmentRow | undefined;
  try { row = (await readModelAssignments()).find(entry => entry.assignmentId === assignmentId); }
  catch (error) { return { ok: false, issues: [issueCodeOf(error)] }; }
  if (!row) return { ok: false, issues: ["model_assignment_version_mismatch:none"] };
  return saveAdminModelAssignment(modelAssignmentInputOf(row, { mode: "off", expectedVersion }), actor);
}

/** 저장 결과 → 운영자 문장(무엇이 바뀌었나: 판·모드·계약 출처·정책 route·장비 순위, 플래그가 꺼져 있으면 아직 읽지 않는다는 말) */
export function assignmentSavedMessage(result: ModelAssignmentSaveResult, flagOn: boolean): string {
  const after = result.after;
  // 끄기 갈래(offOnly): 계약·정책 경로를 보지 않고 끈다 — 끄기는 거절되지 않는다
  const contract = result.contract ? `${ASSIGNMENT_CONTRACT_SOURCE_LABELS[result.contract.source]}(${result.contract.contractHash.slice(0, CONTRACT_HASH_PREFIX)})`
    : "확인하지 않음(끄기)";
  const route = result.offOnly ? "정책 경로는 그대로 둡니다"
    : result.appended.length ? `정책에 경로를 덧붙였습니다(revision ${fmt(result.policyRevision)}, DRAIN 없음)` : "정책 경로는 이미 있습니다";
  const role = result.deviceRole.before === result.deviceRole.after ? `장비 역할 순위 ${fmt(result.deviceRole.after)} 그대로`
    : `장비 역할 순위 ${result.deviceRole.before === null ? "없음" : fmt(result.deviceRole.before)} → ${fmt(result.deviceRole.after)}`;
  const reader = flagOn ? "" : " 읽는 쪽은 아직 설정을 씁니다(배정 표 읽기 꺼짐) — 「배정 표 읽기」를 켜면 이 배정을 읽습니다.";
  return `${result.before ? "저장했습니다" : "만들었습니다"}(배정 ${after.assignmentId}, 판 ${fmt(after.version)}, 모드 ${ASSIGNMENT_MODE_LABELS[after.mode]}). `
    + `계약: ${contract}. ${route}. ${role}.${reader}`;
}

// ---------- 현재 설정 → 배정 표 가져오기 ----------

type Planner = (sources: AssignmentImportSources) => AssignmentImportPlan | Promise<AssignmentImportPlan>;
let plannerForTest: Planner | null = null;
/** 테스트 전용 — 계획 함수를 바꾼다(null 이면 lib/llm/assignment-import.ts 의 planAssignmentImport) */
export function setAssignmentImportPlannerForTest(planner: Planner | null): void { plannerForTest = planner; }

/** 계획이 읽는 것 — 설정·등록부·정책·장비·지금 배정 표 행 */
export async function readAssignmentImportSources(): Promise<AssignmentImportSources> {
  const { getSettings } = await import("@/lib/crawl/settings");
  const [settings, models, control, devices, assignments] = await Promise.all([getSettings(), readRegistryModels(), readCapacityDevicesControl(),
    listModelCapacityDevices(), readModelAssignments()]);
  return { settings, registry: { ...readModelRegistry(), models }, policy: control.policy,
    devices: devices.map(device => ({ deviceId: device.deviceId, enabled: device.enabled, roles: device.roles.map(role => ({ routeId: role.routeId, rank: role.rank })) })),
    assignments };
}

const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : isPlainObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
/** 계획의 hash(보여 준 계획 = 적용할 계획인지). 행의 동작·출처·입력만 본다 */
export function assignmentImportPlanHash(plan: AssignmentImportPlan): string {
  return createHash("sha256").update(JSON.stringify(stable(plan.rows.map(row => [row.action, row.origin, row.input])))).digest("hex");
}

export type AssignmentImportRowView = { index: number; action: AssignmentImportRow["action"]; actionLabel: string; origin: string; assignmentId: string;
  stage: string; stageLabel: string; deviceId: string; registryKey: string; transport: string; rank: number | null; mode: string; vote: boolean; changes: string[] };
export type AssignmentImportPreview = { hash: string | null; rows: AssignmentImportRowView[]; warnings: string[]; counts: Record<AssignmentImportRow["action"], number>;
  error: string | null };
export const ASSIGNMENT_IMPORT_ACTION_LABELS: Readonly<Record<AssignmentImportRow["action"], string>> = { create: "만들기", update: "고치기", unchanged: "그대로" };

export function assignmentImportPreviewOf(plan: AssignmentImportPlan): AssignmentImportPreview {
  const rows = plan.rows.map((row, index) => {
    const input = row.input as Record<string, unknown>;
    const stage = String(input.stage ?? "");
    return { index, action: row.action, actionLabel: ASSIGNMENT_IMPORT_ACTION_LABELS[row.action], origin: row.origin, assignmentId: String(input.assignmentId ?? ""),
      stage, stageLabel: ASSIGNMENT_STAGE_LABELS[stage as AssignmentStage] ?? stage, deviceId: String(input.deviceId ?? ""), registryKey: String(input.registryKey ?? ""),
      transport: String(input.transport ?? ""), rank: finite(input.rank), mode: String(input.mode ?? "off"), vote: input.vote === true, changes: [...row.changes ?? []] };
  });
  const counts = { create: 0, update: 0, unchanged: 0 };
  for (const row of plan.rows) counts[row.action] += 1;
  return { hash: assignmentImportPlanHash(plan), rows, warnings: [...plan.warnings], counts, error: null };
}

async function buildImportPlan(): Promise<AssignmentImportPlan> {
  return (plannerForTest ?? planAssignmentImport)(await readAssignmentImportSources());
}

/** 가져오기 계획 보기(쓰지 않는다). 못 만들면 그 이유 */
export async function previewAdminAssignmentImport(): Promise<AssignmentImportPreview> {
  try { return assignmentImportPreviewOf(await buildImportPlan()); }
  catch (error) { return { hash: null, rows: [], warnings: [], counts: { create: 0, update: 0, unchanged: 0 }, error: issueCodeOf(error) }; }
}

export type AssignmentImportRowResult = { index: number; origin: string; assignmentId: string; action: AssignmentImportRow["action"]; ok: boolean;
  skipped: boolean; version: number | null; issues: string[] };
export type ApplyAssignmentImportResult = { ok: true; results: AssignmentImportRowResult[]; warnings: string[] } | { ok: false; issues: string[] };
/**
 * 가져오기 적용 — 계획을 다시 만들어 화면이 보여 준 hash 와 같을 때만, 행마다 saveAdminModelAssignment(행마다 TX 하나·감사 한 줄)로 저장한다.
 * 한 행이 거절돼도 다음 행을 계속한다(행마다 결과). 「그대로」 행은 건너뛴다. 행의 expectedVersion 이 CAS 다.
 */
export async function applyAdminAssignmentImport(expectedHash: string, actor: string): Promise<ApplyAssignmentImportResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return { ok: false, issues: ["assignment_import_plan_changed"] };
  let plan: AssignmentImportPlan;
  try { plan = await buildImportPlan(); } catch (error) { return { ok: false, issues: [issueCodeOf(error)] }; }
  if (assignmentImportPlanHash(plan) !== expectedHash) return { ok: false, issues: ["assignment_import_plan_changed"] };
  const results: AssignmentImportRowResult[] = [];
  for (const [index, row] of plan.rows.entries()) {
    const assignmentId = String((row.input as Record<string, unknown>).assignmentId ?? "");
    if (row.action === "unchanged") { results.push({ index, origin: row.origin, assignmentId, action: row.action, ok: true, skipped: true, version: null, issues: [] }); continue; }
    const saved = await saveAdminModelAssignment(row.input, actor);
    results.push(saved.ok ? { index, origin: row.origin, assignmentId, action: row.action, ok: true, skipped: false, version: saved.result.after.version, issues: [] }
      : { index, origin: row.origin, assignmentId, action: row.action, ok: false, skipped: false, version: null, issues: saved.issues });
  }
  logger.info("model_assignment.import_applied", { actor, rows: plan.rows.length, ok: results.filter(row => row.ok && !row.skipped).length,
    refused: results.filter(row => !row.ok).length });
  return { ok: true, results, warnings: [...plan.warnings] };
}

// ---------- 들어오는 링크(엔진 연결 → 배정) ----------

export type AssignmentPrefill = { stage?: AssignmentStage; deviceId?: string; registryKey?: string; transport?: AssignmentTransport; editId?: string };
const one = (value: string | string[] | undefined) => typeof value === "string" ? value.trim() : Array.isArray(value) ? (value[0] ?? "").trim() : "";
/** 주소 칸(?edit= · ?stage= · ?deviceId= · ?registryKey= · ?transport=) → 폼 미리 채우기. 모르는 값은 버린다 */
export function assignmentPrefillFromParams(params: Record<string, string | string[] | undefined>): AssignmentPrefill {
  const stage = one(params.stage), transport = one(params.transport), registryKey = one(params.registryKey), deviceId = one(params.deviceId), editId = one(params.edit);
  return {
    ...((ASSIGNMENT_STAGE_IDS as readonly string[]).includes(stage) ? { stage: stage as AssignmentStage } : {}),
    ...((ASSIGNMENT_TRANSPORTS as readonly string[]).includes(transport) ? { transport: transport as AssignmentTransport } : {}),
    ...(/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(registryKey) && registryKey.length <= 200 ? { registryKey } : {}),
    ...(deviceId && deviceId.length <= 120 && !/[\p{Cc}\s]/u.test(deviceId) ? { deviceId } : {}),
    ...(HELPER_ASSIGNMENT_ID_PATTERN.test(editId) ? { editId } : {}),
  };
}
// 엔진 연결 뒤 「이 모델을 단계에 배정」 주소는 lib/operations/admin-engine-connect.ts 의 engineConnectAssignmentHref 가 만든다(이 주소 칸을 채운다).

// ---------- 거절 코드 → 한국어(무엇을 하면 되는지) ----------

const FIXED: Record<string, string> = {
  site_fenced: "이 사이트는 지금 쓰기가 막혀 있습니다(DR) — 쓰기 사이트에서 저장하세요.",
  lineage_mismatch: "이 사이트는 지금 쓰기가 막혀 있습니다(DR: 다른 계보의 DB).",
  epoch_stale: "이 사이트는 지금 쓰기가 막혀 있습니다(DR: 옛 쓰기 epoch).",
  epoch_ahead: "이 사이트는 지금 쓰기가 막혀 있습니다(DR: 앞선 쓰기 epoch).",
  invalid_actor: "저장한 사람을 확인하지 못했습니다. 다시 로그인해 주세요.",
  assignment_helper_role: "도우미 배정은 「도우미 장비」 화면(/admin/models/helpers)에서 만들고 섀도·승격합니다 — 이 폼은 주 배정만 저장합니다.",
  assignment_confirm_required: `실전(live)으로 저장하려면 확인 칸에 「${ASSIGNMENT_LIVE_CONFIRM}」을 적어 주세요.`,
  assignment_device_required: "장비를 골라 주세요. 목록이 비어 있으면 장비 한도(/admin/models/devices)에서 장비를 먼저 저장하세요.",
  assignment_registry_required: "모델(등록부 key)을 골라 주세요.",
  assignment_id_required: "배정 이름을 만들 수 없습니다 — 「배정 이름」 칸에 소문자·숫자·':'·'-' 로 직접 적어 주세요.",
  assignment_import_plan_changed: "보여 준 계획과 지금 계획이 다릅니다(그 사이 설정·배정 표가 바뀜) — 「계획 보기」를 다시 눌러 새 계획을 확인한 뒤 적용하세요.",
  model_assignment_version_exhausted: "이 배정의 판 번호가 끝에 닿았습니다 — 새 이름으로 다시 만드세요.",
  model_assignment_save_failed: "저장하지 못했습니다(알 수 없는 오류, 로그에 남겼습니다). 새로고침해 현재 상태를 확인해 주세요.",
  model_capacity_append_predecessor_busy: "정책에 앞 판의 잡힌 호출(예약·진행)이 아직 남아 있어 경로를 덧붙일 수 없습니다 — 그 호출이 끝난 뒤(보통 몇 분) 다시 저장하세요.",
  model_capacity_append_chain_full: "옛 정책 세대 16개에 아직 잡힌 호출이 남아 경로를 덧붙일 수 없습니다(앞 판 사슬이 가득) — 가장 오래된 호출이 끝난 뒤(보통 몇 분) 다시 저장하세요.",
  model_capacity_predecessor_unproven: "정책의 앞 판 사슬을 증명할 수 없습니다 — 사슬은 지금 정책의 사슬·지금 세대만, 새 정책은 경로 덧붙이기만이어야 합니다.",
  model_capacity_routes_cap: "정책 경로가 상한(256)에 닿았습니다 — 안 쓰는 경로를 정책에서 정리한 뒤 저장하세요.",
  model_capacity_route_conflict: "같은 경로·공급자·모델이 정책에 다른 값(예산·장비)으로 있습니다 — 실시간 한도·장비 한도에서 정책을 확인하세요.",
  model_capacity_route_invalid: "덧붙일 정책 경로 모양이 틀립니다 — 등록부 key·장비 이름을 확인하세요.",
  model_capacity_policy_missing: "용량 정책이 없습니다(DISABLED) — 정책을 먼저 적용한 뒤 저장하세요.",
  model_capacity_control_missing: "용량 제어 행(model_capacity_control)이 없습니다 — 마이그레이션 적용을 확인하세요.",
  model_capacity_replay_unsupported: "재생(replay) DB 에서는 배정을 저장할 수 없습니다.",
  model_capacity_revision_exhausted: "정책 revision 이 끝에 닿았습니다 — 정책을 새 epoch 로 다시 적용하세요.",
  model_capacity_device_version_exhausted: "장비 행의 판 번호가 끝에 닿았습니다 — 장비 한도에서 장비를 다시 만드세요.",
  contract_schema_invalid: "만든 계약이 이 경로의 계약 형식과 맞지 않습니다 — 모델 연결 화면(/admin/models/contracts)에서 계약을 직접 넣으세요.",
  serving_contract_input_invalid: "계약 저장 입력이 틀립니다 — 모델 연결 화면에서 계약을 직접 넣으세요.",
  secret_box_key_missing: "서버에 키 암호화 설정(NMV_SECRET_BOX_KEY)이 없어 계약을 저장할 수 없습니다.",
};
export const MODEL_ASSIGNMENT_REFUSAL_MESSAGES: Readonly<Record<ModelAssignmentRefusal, string>> = {
  registry_key_unknown: "등록부에 없는 모델입니다 — 모델 연결 화면(/admin/models/contracts)에서 등록부를 확인하세요.",
  transport_provider_mismatch: "이 모델의 공급자로는 고른 전송을 쓸 수 없습니다(장비 표지·엔진 직접 = abcllm 형, 로컬 직접 = 로컬 모델, CLI = Claude·Grok·Codex CLI) — 전송을 바꾸세요.",
  backend_id_invalid: "로컬 계약의 backendId 를 만들 수 없는 등록부 key 입니다 — key 를 60자 이하 소문자·숫자·'-' 로 바꾸세요.",
  device_unconfigured: "장비 행이 없거나 꺼져 있습니다 — 장비 한도(/admin/models/devices)에서 이 장비를 먼저 저장(켜기)하세요.",
  assignment_is_helper: "이 이름은 도우미 배정입니다 — 「도우미 장비」 화면(/admin/models/helpers)에서 바꾸세요.",
  route_is_helper_route: "이 장비의 도우미 경로와 겹칩니다(같은 모델을 도우미로 쓰거나, 도우미 경로를 순위 1 로 올리게 됨) — 순위를 2 이상으로 하거나 도우미를 먼저 끄세요.",
  route_device_mismatch: "같은 경로·공급자·모델이 정책에서 다른 장비에 묶여 있습니다 — 그 장비로 배정하거나, 정책의 장비 매핑을 먼저 고치세요.",
  contract_probe_failed: "엔진 확인(readback·1토큰 시험)이 맞지 않아 저장하지 않았습니다 — 엔진이 다른 모델 이름으로 답했습니다. 등록부의 모델 이름을 확인하세요.",
  contract_unbuildable: "이 경로의 계약을 자동으로 만들 수 없습니다(예: 2차 second-review) — 모델 연결 화면(/admin/models/contracts)에서 계약을 먼저 넣고 다시 저장하세요.",
  contract_transport_mismatch: "저장된 계약의 전송이 고른 배정 전송과 다릅니다. 엔진 직접 배정은 직접 연결 계약과 맞아야 하고, 장비 표지 배정은 그 외 계약 행과 맞아야 합니다. 텍스트 경로는 「모델 연결」의 직접 연결 계약만 열립니다 — 전송을 계약에 맞추거나 계약을 다시 저장하세요.",
  contract_device_mismatch: "저장된 로컬 계약의 장비(physicalGroup)가 이 장비와 다릅니다 — 계약의 장비로 배정하거나 계약을 고치세요.",
  cli_contract_missing: "이 CLI 모델의 계약(CLI_SERVING_CONTRACTS)이 웹 프로세스에 없거나 --version 확인을 통과하지 못했습니다 — env 계약을 넣은 뒤 저장하세요.",
};
const INVALID_FIELDS: Record<string, string> = {
  assignmentId: "배정 이름: 영어 소문자·숫자로 시작하고 소문자·숫자·':'·'-' 만, 120자까지 적어 주세요.",
  expectedVersion: "판 번호(version)를 읽지 못했습니다. 새로고침해 주세요.",
  stage: "단계를 고를 수 없습니다 — 예약 단계(LLM 보강·감사 보강·저장소 검토)는 아직 배정하지 않고, 저장된 배정의 단계는 바꿀 수 없습니다(새 배정을 만드세요).",
  deviceId: "저장된 배정의 장비는 바꿀 수 없습니다 — 새 장비로 새 배정을 만들고 이 배정은 끄세요.",
  registryKey: "모델을 쓸 수 없습니다 — 등록부 key 모양이 틀렸거나, 같은 장비·단계에 같은 모델 배정이 이미 있습니다(그 행을 고치세요).",
  transport: "이 단계에서 쓸 수 없는 전송이거나, CLI 인데 connect 장비 모델이 아닙니다 — 목록의 전송을 고르세요.",
  rank: `순위는 1~${ASSIGNMENT_FORM_RANK_MAX} 의 정수여야 합니다.`,
  role: "역할은 주 배정만 이 폼에서 저장합니다(도우미는 도우미 장비 화면).",
  vote: "표(투표)는 2차 검수의 순위 1 배정에만 켤 수 있습니다.",
  mode: "모드는 꺼짐·실전만 고를 수 있습니다(섀도는 도우미 화면).",
  maxSlots: "최대 칸은 1~256 의 정수여야 합니다.",
  note: `메모는 ${HELPER_NOTE_MAX}자까지입니다.`,
  actor: "저장한 사람을 확인하지 못했습니다. 다시 로그인해 주세요.",
  evidence: "근거 열쇠(evidence_key)를 만들지 못했습니다 — 경로·모델·계약을 확인해 주세요.",
  root: "배정 모양이 틀립니다(알 수 없는 칸이 있거나 칸이 빠졌습니다). 새로고침해 주세요.",
};
/** 엔진 확인(probe) 실패 원인 → 무엇을 하면 되는지 */
function probeReasonMessage(reason: string): string {
  if (reason.startsWith("engine_unreachable:")) return `엔진에 닿지 못했습니다(${reason.slice("engine_unreachable:".length)}) — 등록부의 주소·키·엔진 상태를 확인하세요.`;
  const mismatch = /^engine_max_len_mismatch:(\d+):(\d+)$/.exec(reason);
  if (mismatch) return `엔진이 알려 준 최대 길이(${mismatch[1]})와 입력한 상한(${mismatch[2]})이 다릅니다.`;
  switch (reason) {
    case "engine_model_not_found": return "엔진의 모델 목록에 이 모델이 없습니다 — 엔진 연결(모델 연결 화면)에서 모델 이름을 확인하세요.";
    case "engine_max_len_unknown": return "엔진이 최대 길이(max_model_len)를 알려 주지 않습니다 — 모델 연결 화면의 「엔진 연결」에서 컨텍스트 상한을 넣어 계약을 먼저 만든 뒤 다시 저장하세요(저장된 계약을 씁니다).";
    case "engine_probe_failed": return "엔진에 1토큰 시험 호출을 보냈지만 정상 응답이 오지 않았습니다 — 모델 이름·키·엔진 상태를 확인하세요.";
    case "engine_base_url_invalid": return "등록부의 주소(baseUrl)가 https://호스트/v1 모양이 아닙니다 — 엔진 연결로 주소를 고치세요.";
    default: return `엔진 확인이 실패했습니다(${reason}) — 엔진 상태를 확인하고 다시 저장하세요.`;
  }
}

/** 저장 함수·화면의 코드를 운영자 문장으로. 모르는 코드는 그대로 보인다(숨기지 않는다) */
export function modelAssignmentIssueMessage(issue: string): string {
  if (FIXED[issue]) return FIXED[issue];
  const colon = issue.indexOf(":");
  if (colon < 0) return issue;
  const code = issue.slice(0, colon), detail = issue.slice(colon + 1);
  switch (code) {
    case "model_assignment_version_mismatch":
      return detail === "none" ? "이 배정이 지금 없습니다(그 사이 지워졌거나 아직 만들지 않음) — 새로고침해 주세요."
        : `다른 사람이 먼저 저장했습니다(지금 판 ${detail}). 새로고침해 바뀐 값을 확인한 뒤 다시 저장하세요.`;
    case "model_assignment_refused": {
      if (detail.startsWith("contract_probe_failed:")) return `엔진 확인(readback·1토큰 시험)이 실패해 저장하지 않았습니다 — ${probeReasonMessage(detail.slice("contract_probe_failed:".length))}`;
      return MODEL_ASSIGNMENT_REFUSAL_MESSAGES[detail as ModelAssignmentRefusal] ?? `저장이 거절됐습니다: ${detail}`;
    }
    case "model_assignment_invalid":
      return INVALID_FIELDS[detail] ?? INVALID_FIELDS[detail.split(/[.[]/)[0]] ?? `배정이 검사를 통과하지 못했습니다: ${detail}`;
    case "model_helper_invalid": case "model_helper_refused": case "model_helper_version_mismatch":
      return `${modelHelperIssueMessage(issue)} (도우미 배정은 /admin/models/helpers)`;
    default: return issue;
  }
}

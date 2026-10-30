import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { modelCapacityPolicyHash, modelCapacityPolicySchema, type ModelCapacityMode, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import type { ModelCapacityDeviceRow, ModelCapacityDeviceSettings, ModelCapacityDeviceState } from "@/lib/llm/capacity-devices";
import { logger } from "@/lib/observability/logger";
import { adminLog, settingsChanges, type AdminLogRow } from "./admin-log";
import { modelStageLabel } from "./admin-models-view";
import { DrWriterFencedError } from "./dr/epoch";
import { ROUTE_LABELS } from "./runtime-settings-schema";

/**
 * 관리자 「장비 한도」(/admin/models/devices) 화면 모형 — PR 1b WP-B.
 *
 * 장비(device) = 정책 경로의 groupId = model_capacity_requests.group_id. 장비 행(model_capacity_devices)과 역할 순서(model_capacity_device_roles)는
 * 정책 세대(hash)와 분리된 실시간 설정이다: 입장 판정(grantOne)이 트랜잭션 안에서 이 표를 그대로 읽으므로 저장 즉시 다음 입장부터 쓰이고
 * DRAIN·배포·"읽은 판"이 없다(pr1-plan §2.7·§3.3). 경로→장비 매핑을 바꾸는 것만 정책 개정(DRAIN)이다.
 *
 * - 화면은 장비마다 설정값(칸 수·낮은 순위 평소 상한·유휴 판정 시간·항상 비워 둘 칸·엔진 실제 동시 처리 수·메모)과 기본값, 역할 순서(route → rank),
 *   실시간 상태(점유·우선 역할 바쁨/유휴·낮은 순위 n/상한·빌려 쓰는 중·대기), 판(version)·마지막 저장을 함께 보인다.
 * - 점유는 예약(reserved)+진행(dispatched)만이다 — 미확인(indeterminate) 행은 점유가 아니다(live-settings-plan §7 PR 1b, 소유자 결정 a).
 * - 장비 목록 = 장비 행 ∪ 현재 정책 경로의 groupId ∪ 실시간 상태의 deviceId. 행이 없는 정책 장비는 policy_fallback(groupLimits 값으로 대신) 또는
 *   unconfigured(groupLimits 도 없어 device_unconfigured 로 보류)로 표시한다.
 * - 저장은 WP-A 의 saveModelCapacityDevice 한 번이다(그 안에서 replay 거부 → DR fence → control FOR UPDATE → zod → CAS → upsert → 역할 교체 →
 *   operations_audit 한 줄). 여기서는 감사 줄을 **또 쓰지 않는다**(1b-A 계약). 거절 코드 → 한국어 문장은 capacityDeviceIssueMessage 한 곳에서 만든다
 *   (모르는 코드는 그대로 보인다).
 * 이 모듈은 DB 를 읽으므로 서버에서만 import 한다. 클라이언트 폼은 여기서 만든 값(문자열·숫자)만 받는다.
 *
 * WP-A 저장소 모듈(@/lib/llm/capacity-devices-repository)은 늦게(동적 import) 올린다 — 이 화면은 그 모듈이 아직 없어도 컴파일되고,
 * 테스트는 setCapacityDeviceRepositoryForTest 로 같은 계약의 메모리 구현을 끼운다.
 */

/** = lib/llm/capacity-devices.ts MODEL_CAPACITY_DEVICE_SAVE_AUDIT_ACTION. 저장소가 쓰는 줄을 읽기만 한다 */
export const MODEL_CAPACITY_DEVICE_AUDIT_ACTION = "model-capacity-device-save";
/** 장비 행이 없을 때의 기본값 — WP-A 의 DEFAULT_DEVICE_IDLE_MS·DEFAULT_DEVICE_RESERVE_SLOTS 와 같은 수(0152 seed 도 이 값으로 심는다) */
export const DEVICE_DEFAULT_IDLE_MS = 60_000;
export const DEVICE_DEFAULT_RESERVE_SLOTS = 0;
/** 표에 있는 장비·행 없이 정책 groupLimits 로 대신하는 장비·둘 다 없어 보류되는 장비 */
export type DeviceSource = "table" | "policy_fallback" | "unconfigured";
export type DeviceSettingsView = { limitSlots: number | null; secondaryCap: number | null; idleMs: number; reserveSlots: number; physicalLimit: number | null; note: string | null };
export type DeviceRoleView = {
  routeId: string;
  /** null = 순위 없음(최하위, UNRANKED_ROLE_RANK) */
  rank: number | null;
  label: string;
  /** 현재 정책의 경로가 이 장비를 쓴다 */
  inPolicy: boolean };
export type DeviceLiveView = { source: "table" | "policy_fallback"; limitSlots: number; active: number; primaryBusy: boolean; secondaryActive: number; secondaryBound: number;
  lending: boolean; waiting: number; waitingPrimary: number };
export type DeviceView = {
  deviceId: string; source: DeviceSource; enabled: boolean;
  version: number | null; updatedBy: string | null; updatedAt: string | null;
  /** 지금 값(행이 없으면 정책 대체값·기본값) */
  settings: DeviceSettingsView;
  /** 기본값 — 칸 수는 정책 groupLimits(없으면 null), 낮은 순위 상한은 칸 수(seed 규칙: cap = limit), 유휴 60초, 비워 둘 칸 0 */
  defaults: DeviceSettingsView;
  roles: DeviceRoleView[];
  policyRoutes: string[];
  live: DeviceLiveView | null;
  issues: string[] };
export type DeviceAuditView = { id: number; actor: string; at: string; ok: boolean; deviceId: string; version: number | null; changes: string[]; error: string | null };
export type CapacityDevicesAdminView = {
  mode: ModelCapacityMode | null; epoch: number | null; revision: number | null; policyVerified: boolean;
  controlError: string | null; rowsError: string | null; statesError: string | null;
  devices: DeviceView[]; lendingCount: number; issues: string[]; audit: DeviceAuditView[] };
export type DevicesControlView = { mode: ModelCapacityMode; epoch: number; revision: number; policy: ModelCapacityPolicy | null; policyVerified: boolean };
export type DevicesViewInput = {
  rows: readonly ModelCapacityDeviceRow[] | null; rowsError?: string | null;
  states: readonly ModelCapacityDeviceState[] | null; statesError?: string | null;
  control: DevicesControlView | null; controlError?: string | null;
  audit?: readonly AdminLogRow[]; now?: Date };

/** WP-A 저장소 계약(lib/llm/capacity-devices-repository.ts, 1b-A). actor = 관리자 로그인(updated_by·감사 actor). */
export type DeviceRepository = {
  saveModelCapacityDevice(tx: ProductTransaction, input: unknown, expectedVersion: number | null, actor: string):
    Promise<{ before: ModelCapacityDeviceRow | null; after: ModelCapacityDeviceRow }>;
  listModelCapacityDevices(tx?: ProductTransaction): Promise<ModelCapacityDeviceRow[]>;
  readModelCapacityDeviceStates(tx?: ProductTransaction): Promise<ModelCapacityDeviceState[]>;
};
export const DEVICE_REPOSITORY_MODULE = "@/lib/llm/capacity-devices-repository";
let repositoryForTest: DeviceRepository | null = null;
/** 테스트 전용 — 같은 계약의 메모리 구현을 끼운다(runtime-settings-store 의 setRuntimeSettingsForTest 와 같은 꼴). null 이면 진짜 모듈을 올린다 */
export function setCapacityDeviceRepositoryForTest(repository: DeviceRepository | null): void { repositoryForTest = repository; }
async function deviceRepository(): Promise<DeviceRepository> {
  if (repositoryForTest) return repositoryForTest;
  return import("@/lib/llm/capacity-devices-repository");
}

const AUDIT_ROWS = 10;
const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const fmt = (value: number) => value.toLocaleString("ko-KR");
/** 정책 대체 한도의 규칙 — lib/llm/capacity-devices.ts deviceFallbackLimit 과 같다(^[1-9][0-9]{0,2}$, 1..256) */
const FALLBACK_LIMIT_PATTERN = /^[1-9][0-9]{0,2}$/, DEVICE_LIMIT_MAX = 256;
/** ms → 초 글자("60", "1.5") */
export const idleToInput = (ms: number | null | undefined): string => ms === null || ms === undefined ? "" : String(Math.round(ms) / 1000);
export const secondsLabel = (ms: number | null | undefined): string => ms === null || ms === undefined ? "—" : `${idleToInput(ms)}초`;

/** 폼·감사 줄·거절 문장이 같은 이름을 쓴다 */
export const DEVICE_FIELD_LABELS: Readonly<Record<string, string>> = {
  deviceId: "장비 이름", limitSlots: "칸 수", secondaryCap: "낮은 순위 평소 상한", idleMs: "유휴 판정 시간(ms)", reserveSlots: "항상 비워 둘 칸",
  physicalLimit: "엔진 실제 동시 처리 수", roles: "역할 순서", note: "메모", enabled: "사용",
};
export const deviceFieldLabel = (path: string): string => DEVICE_FIELD_LABELS[path.split(".")[0]] ?? path;
/** 역할(경로) 이름 — 실시간 한도 화면과 같은 ROUTE_LABELS, 없으면 단계 이름, 그것도 없으면 경로 id */
export function deviceRoleLabel(routeId: string): string {
  if (ROUTE_LABELS[routeId]) return ROUTE_LABELS[routeId];
  const stage = modelStageLabel(routeId);
  return stage === "다른 모델 단계" ? routeId : stage;
}

const settingsView = (row: Pick<ModelCapacityDeviceSettings, "limitSlots" | "secondaryCap" | "idleMs" | "reserveSlots" | "physicalLimit" | "note">): DeviceSettingsView =>
  ({ limitSlots: row.limitSlots, secondaryCap: row.secondaryCap, idleMs: row.idleMs, reserveSlots: row.reserveSlots, physicalLimit: row.physicalLimit, note: row.note });
const groupLimit = (policy: ModelCapacityPolicy | null, deviceId: string): number | null => {
  const limits = (policy as { groupLimits?: Record<string, unknown> } | null)?.groupLimits;
  const raw = limits?.[deviceId];
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : null;
  if (text === null || !FALLBACK_LIMIT_PATTERN.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= DEVICE_LIMIT_MAX ? value : null;
};

function deviceView(deviceId: string, row: ModelCapacityDeviceRow | undefined, state: ModelCapacityDeviceState | undefined, policy: ModelCapacityPolicy | null): DeviceView {
  const policyRoutes = [...new Set((policy?.routes ?? []).filter(route => route.groupId === deviceId).map(route => route.routeId))].sort();
  // 대체 한도: 정책 groupLimits(이 화면이 읽은 정책), 정책을 못 읽었으면 저장소의 실시간 상태가 policy_fallback 으로 알린 값
  const fallback = groupLimit(policy, deviceId) ?? (state?.source === "policy_fallback" ? state.limitSlots : null);
  const defaults: DeviceSettingsView = { limitSlots: fallback, secondaryCap: row?.limitSlots ?? fallback, idleMs: DEVICE_DEFAULT_IDLE_MS, reserveSlots: DEVICE_DEFAULT_RESERVE_SLOTS,
    physicalLimit: null, note: null };
  const settings: DeviceSettingsView = row ? settingsView(row) : { ...defaults };
  const source: DeviceSource = row ? "table" : fallback !== null ? "policy_fallback" : "unconfigured";
  const ranked = (row?.roles ?? []).map(role => ({ routeId: role.routeId, rank: role.rank as number | null, label: deviceRoleLabel(role.routeId), inPolicy: policyRoutes.includes(role.routeId) }))
    .sort((a, b) => (a.rank! - b.rank!) || a.routeId.localeCompare(b.routeId));
  const unranked = policyRoutes.filter(routeId => !ranked.some(role => role.routeId === routeId))
    .map(routeId => ({ routeId, rank: null, label: deviceRoleLabel(routeId), inPolicy: true }));
  const live: DeviceLiveView | null = state ? { source: state.source, limitSlots: state.limitSlots, active: state.active, primaryBusy: state.primaryBusy,
    secondaryActive: state.secondaryActive, secondaryBound: state.secondaryBound, lending: state.lending, waiting: state.waiting, waitingPrimary: state.waitingPrimary } : null;
  const issues: string[] = [];
  if (!row && fallback !== null) issues.push(`장비 행이 없어 정책 groupLimits 값(${fmt(fallback)}칸, 낮은 순위 상한도 ${fmt(fallback)})으로 대신합니다(policy_fallback) — 저장하면 이 표가 기준이 됩니다`);
  if (!row && fallback === null) issues.push("장비 행도 정책 groupLimits 도 없어 이 장비로 가는 요청은 device_unconfigured 로 보류됩니다 — OPEN 전에 저장해 주세요");
  if (row && !row.enabled) issues.push("꺼진 행 — 입장 판정은 이 행을 보지 않고 정책 대체값을 쓰거나 보류합니다");
  if (row && policy && !policyRoutes.length) issues.push("현재 정책의 어느 경로도 이 장비를 쓰지 않습니다(정책 개정 전에 미리 만든 행이면 정상)");
  if (settings.physicalLimit !== null && settings.limitSlots !== null && settings.limitSlots > settings.physicalLimit)
    issues.push(`칸 수(${fmt(settings.limitSlots)})가 엔진 실제 동시 처리 수(${fmt(settings.physicalLimit)})를 넘습니다`);
  if (live && live.active > live.limitSlots) issues.push(`점유 ${fmt(live.active)}가 칸 수 ${fmt(live.limitSlots)}를 넘습니다(한도를 낮춘 뒤 아직 끝나지 않은 호출) — 새 입장만 막히고 잡힌 행은 그대로입니다`);
  const foreign = ranked.filter(role => !role.inPolicy && policy).map(role => role.routeId);
  if (foreign.length) issues.push(`순위에 있지만 현재 정책에 없는 경로: ${foreign.join(", ")}`);
  return { deviceId, source, enabled: row?.enabled ?? true, version: row?.version ?? null, updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null,
    settings, defaults, roles: [...ranked, ...unranked], policyRoutes, live, issues };
}

/** 감사 detail 의 바뀐 값 — 저장소가 남긴 { before, after }(1b-A: roles 는 [{routeId, rank}])를 "이름: 전 → 후" 로. detail.changes 가 있으면 그것을 쓴다 */
export function deviceAuditChangeLines(row: Pick<AdminLogRow, "detail">): string[] {
  const detail = isPlainObject(row.detail) ? row.detail : {};
  const changes = Array.isArray(detail.changes) ? detail.changes as { path?: unknown; before?: unknown; after?: unknown }[]
    : isPlainObject(detail.after) ? settingsChanges(isPlainObject(detail.before) ? detail.before : {}, detail.after) : [];
  const show = (value: unknown): string => value === null || value === undefined ? "없음"
    : Array.isArray(value) ? (value.length ? value.map(item => isPlainObject(item) && typeof item.routeId === "string" ? `${item.routeId}=${String(item.rank)}` : show(item)).join(", ") : "없음")
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  // 새 장비(before null)의 "없음 → 없음"(빈 순위·빈 메모)은 바뀐 값이 아니다
  return changes.flatMap(change => typeof change.path === "string" && show(change.before) !== show(change.after)
    ? [`${deviceFieldLabel(change.path)}: ${show(change.before)} → ${show(change.after)}`] : []);
}
export function deviceAuditView(rows: readonly AdminLogRow[]): DeviceAuditView[] {
  return rows.slice(0, AUDIT_ROWS).map(row => {
    const version = row.detail?.version;
    return { id: row.id, actor: row.actor, at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt), ok: row.ok,
      deviceId: typeof row.detail?.deviceId === "string" ? row.detail.deviceId : String(row.target), version: typeof version === "number" ? version : null,
      changes: deviceAuditChangeLines(row), error: row.error ?? null };
  });
}

/** 순수 — DB 없이 시험한다. rows·states·control 중 못 읽은 것은 null 로 받아 그 자리만 비우고 화면은 뜬다 */
export function buildCapacityDevicesAdminView(input: DevicesViewInput): CapacityDevicesAdminView {
  const policy = input.control?.policy ?? null;
  const rows = new Map((input.rows ?? []).map(row => [row.deviceId, row]));
  const states = new Map((input.states ?? []).map(state => [state.deviceId, state]));
  const policyDevices = (policy?.routes ?? []).map(route => route.groupId);
  const ids = [...new Set([...rows.keys(), ...policyDevices, ...states.keys()])].sort((a, b) => a.localeCompare(b));
  const devices = ids.map(deviceId => deviceView(deviceId, rows.get(deviceId), states.get(deviceId), policy));
  const issues: string[] = [];
  if (input.control && !input.control.policyVerified) issues.push("정책 JSON 이 저장된 hash 와 맞지 않아 정책 경로를 보이지 않습니다(pipeline-control status 로 확인)");
  if (input.control?.mode === "disabled" && !policy) issues.push("용량 제어가 꺼져 있고 정책이 없습니다 — 장비 행은 정책을 적용한 뒤부터 쓰입니다");
  return { mode: input.control?.mode ?? null, epoch: input.control?.epoch ?? null, revision: input.control?.revision ?? null,
    policyVerified: input.control?.policyVerified ?? false,
    controlError: input.control ? null : input.controlError ?? "model_capacity_control_unreadable",
    rowsError: input.rows ? null : input.rowsError ?? "model_capacity_devices_unreadable",
    statesError: input.states ? null : input.statesError ?? "model_capacity_device_states_unreadable",
    devices, lendingCount: devices.filter(device => device.live?.lending).length, issues, audit: deviceAuditView(input.audit ?? []) };
}

type ControlRow = { mode: ModelCapacityMode; epoch: string | number; revision: string | number; policy: unknown; policy_hash: string | null };
/** SELECT-only 관측(lock 없음) — admin-models-repository 와 같은 방식으로 정책 JSON 을 hash 로 검증해 경로·groupLimits 를 읽는다 */
export async function readCapacityDevicesControl(): Promise<DevicesControlView> {
  const [row] = await withDbDeadline(Date.now() + 4_000, () => onPrimary(() => db.execute<ControlRow>(
    sql`SELECT mode, epoch::float8 AS epoch, revision::float8 AS revision, policy, policy_hash FROM model_capacity_control WHERE id = 1`)));
  if (!row) throw new Error("model_capacity_control_missing");
  const parsed = row.policy === null ? null : modelCapacityPolicySchema.safeParse(row.policy);
  const policy: ModelCapacityPolicy | null = parsed?.success ? parsed.data : null;
  const verified = row.policy === null ? true : policy !== null && modelCapacityPolicyHash(policy) === row.policy_hash;
  return { mode: row.mode, epoch: Number(row.epoch), revision: Number(row.revision), policy: verified ? policy : null, policyVerified: verified };
}

const settle = <T>(work: Promise<T>) => work.then(value => ({ value, error: null as string | null }),
  (error: unknown) => ({ value: null as T | null, error: error instanceof Error ? error.message : String(error) }));

/** 화면 한 번 그리기 — 제어 행·장비 행·실시간 상태·감사를 함께 읽는다. 어느 하나를 못 읽어도 화면은 뜬다(그 자리에 이유) */
export async function readCapacityDevicesAdminView(now = new Date()): Promise<CapacityDevicesAdminView> {
  const repo = await settle(deviceRepository());
  const [control, rows, states, audit] = await Promise.all([
    settle(readCapacityDevicesControl()),
    repo.value ? settle(repo.value.listModelCapacityDevices()) : Promise.resolve({ value: null, error: repo.error }),
    repo.value ? settle(repo.value.readModelCapacityDeviceStates()) : Promise.resolve({ value: null, error: repo.error }),
    adminLog({ actions: [MODEL_CAPACITY_DEVICE_AUDIT_ACTION] }).catch(() => [] as AdminLogRow[]),
  ]);
  return buildCapacityDevicesAdminView({ control: control.value, controlError: control.error, rows: rows.value, rowsError: rows.error,
    states: states.value, statesError: states.error, audit, now });
}

// ---------- 폼 → 저장 입력 ----------
export type DeviceFormInput = { deviceId: string; limitSlots: number; secondaryCap: number; idleMs: number; reserveSlots: number; physicalLimit: number | null;
  roles: { routeId: string; rank: number }[]; note: string | null };
export type DeviceFormParse = { input: DeviceFormInput | null; expectedVersion: number | null; issues: string[] };
type FormLike = { get(name: string): FormDataEntryValue | null; entries(): IterableIterator<[string, FormDataEntryValue]> };
const text = (value: FormDataEntryValue | null) => typeof value === "string" ? value.trim() : "";
const parseInt10 = (raw: string): number | undefined => /^-?\d{1,9}$/.test(raw.replace(/,/g, "")) ? Number(raw.replace(/,/g, "")) : undefined;

/**
 * 폼 칸 이름: deviceId · expectedVersion(빈 값 = 새 장비, CAS 없음) · limitSlots · secondaryCap · idleSeconds(초 → ms) · reserveSlots · physicalLimit(빈 값 = 없음) · note
 * · rank:<routeId>(빈 값 = 순위 없음) · extraRoute:<i> + extraRank:<i>(정책에 없는 경로를 더할 때). 범위·중복 검사의 기준은 WP-A 의 zod(저장 때)다 — 여기서는 숫자 모양만 본다.
 */
export function capacityDeviceInputFromForm(form: FormLike): DeviceFormParse {
  const issues: string[] = [];
  const deviceId = text(form.get("deviceId"));
  if (!deviceId) issues.push("장비 이름을 넣어주세요");
  else if (deviceId.length > 120 || /[\u0000-\u001f\u007f]/.test(deviceId)) issues.push("장비 이름이 너무 길거나 제어 문자가 있습니다");
  const versionText = text(form.get("expectedVersion"));
  let expectedVersion: number | null = null;
  if (versionText) {
    const parsed = /^\d{1,15}$/.test(versionText) ? Number(versionText) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1) issues.push("판 번호(version)를 읽지 못했습니다. 새로고침해주세요.");
    else expectedVersion = parsed;
  }
  const int = (name: string): number | undefined => {
    const raw = text(form.get(name));
    const value = parseInt10(raw);
    if (value === undefined) issues.push(`${DEVICE_FIELD_LABELS[name]}: 정수를 넣어주세요`);
    return value;
  };
  const limitSlots = int("limitSlots"), secondaryCap = int("secondaryCap"), reserveSlots = int("reserveSlots");
  const idleRaw = text(form.get("idleSeconds"));
  const idleNumber = Number(idleRaw.replace(/,/g, ""));
  const idleMs = idleRaw !== "" && Number.isFinite(idleNumber) && idleNumber >= 0 ? Math.round(idleNumber * 1000) : undefined;
  if (idleMs === undefined) issues.push("유휴 판정 시간(초): 0 이상의 초 단위 숫자를 넣어주세요");
  const physicalRaw = text(form.get("physicalLimit"));
  const physicalLimit = physicalRaw === "" ? null : parseInt10(physicalRaw);
  if (physicalLimit === undefined) issues.push(`${DEVICE_FIELD_LABELS.physicalLimit}: 정수를 넣어주세요(비우면 없음)`);
  const noteRaw = text(form.get("note"));
  if (noteRaw.length > 400) issues.push("메모는 400자까지입니다");
  const roles: { routeId: string; rank: number }[] = [];
  const addRole = (routeId: string, rankRaw: string) => {
    if (!routeId && !rankRaw) return;
    if (!routeId) { issues.push("역할 순서: 경로 이름 없이 순위만 적었습니다"); return; }
    if (!rankRaw) return;
    const rank = parseInt10(rankRaw);
    if (rank === undefined) { issues.push(`역할 순서 ${deviceRoleLabel(routeId)}(${routeId}): 순위는 정수입니다(비우면 순위 없음)`); return; }
    if (roles.some(role => role.routeId === routeId)) { issues.push(`역할 순서에 같은 경로가 두 번 있습니다: ${routeId}`); return; }
    roles.push({ routeId, rank });
  };
  for (const [name, entry] of form.entries()) if (name.startsWith("rank:")) addRole(name.slice("rank:".length).trim(), text(entry));
  for (const [name, entry] of form.entries()) {
    if (!name.startsWith("extraRoute:")) continue;
    const index = name.slice("extraRoute:".length);
    addRole(text(entry), text(form.get(`extraRank:${index}`)));
  }
  roles.sort((a, b) => (a.rank - b.rank) || a.routeId.localeCompare(b.routeId));
  if (issues.length || limitSlots === undefined || secondaryCap === undefined || reserveSlots === undefined || idleMs === undefined || physicalLimit === undefined)
    return { input: null, expectedVersion, issues };
  return { input: { deviceId, limitSlots, secondaryCap, idleMs, reserveSlots, physicalLimit, roles, note: noteRaw || null }, expectedVersion, issues };
}

// ---------- 저장(WP-A 저장 한 번) ----------
export type SaveCapacityDeviceResult = { ok: true; deviceId: string; version: number; created: boolean; changes: string[] } | { ok: false; issues: string[] };
const toastSlice = (row: ModelCapacityDeviceRow) => ({ limitSlots: row.limitSlots, secondaryCap: row.secondaryCap, idleMs: row.idleMs, reserveSlots: row.reserveSlots,
  physicalLimit: row.physicalLimit, note: row.note, enabled: row.enabled, roles: [...row.roles].map(role => `${role.routeId}=${role.rank}`).sort() });
/** WP-A 가 던지는 거절(검사·CAS·재생 DB·제어 행 없음) — 운영자 문장으로 돌려준다(저장소가 감사도 행도 건드리지 않은 채 던졌다). 그 밖(DB 오류·미구현)은 던진다 */
const REFUSAL_PREFIXES = ["model_capacity_device_invalid:", "model_capacity_device_version_mismatch:"];
const REFUSAL_CODES = ["model_capacity_replay_unsupported", "model_capacity_control_missing", "model_capacity_device_version_exhausted"];
const isDeviceRefusal = (code: string) => REFUSAL_PREFIXES.some(prefix => code.startsWith(prefix)) || REFUSAL_CODES.includes(code);

/**
 * 장비 한 대 저장 — 쓰기 TX 하나에서 WP-A saveModelCapacityDevice(tx, input, expectedVersion, actor) 를 부른다. 그 안이 DR fence SHARE → control FOR UPDATE
 * (모든 입장과 직렬화) → zod → 장비 행 FOR UPDATE·CAS → upsert(version+1) → 역할 교체 → operations_audit 한 줄(target = deviceId, detail { version, expectedVersion,
 * before, after })을 모두 한다 — 여기서는 감사 줄을 또 쓰지 않는다. 저장 즉시 다음 입장 판정부터 쓰인다 — 잡힌 행은 그대로이고 DRAIN 은 없다.
 */
export async function saveAdminCapacityDevice(input: unknown, expectedVersion: number | null, actor: string): Promise<SaveCapacityDeviceResult> {
  if (!actor.trim() || actor.length > 120) return { ok: false, issues: ["invalid_actor"] };
  if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) return { ok: false, issues: ["model_capacity_device_version_mismatch:invalid"] };
  const repo = await deviceRepository();
  try {
    const { before, after } = await onPrimary(() => db.transaction(tx => repo.saveModelCapacityDevice(tx, input, expectedVersion, actor)));
    const show = (value: unknown) => value === null || value === undefined || (Array.isArray(value) && !value.length) ? "없음" : Array.isArray(value) ? value.join(", ") : String(value);
    const changes = settingsChanges(before ? toastSlice(before) : {}, toastSlice(after)).filter(change => show(change.before) !== show(change.after));
    // 한도·순위가 바뀌면 다음 입장부터 결과가 바뀐다 — "왜 이때부터 달라졌지"를 되짚을 수 있어야 한다(감사 줄은 저장소가 남겼다)
    logger.info("model_capacity_device.saved", { actor, deviceId: after.deviceId, version: after.version, changes: changes.map(change => change.path) });
    return { ok: true, deviceId: after.deviceId, version: after.version, created: before === null,
      changes: changes.map(change => `${deviceFieldLabel(change.path)}: ${show(change.before)} → ${show(change.after)}`) };
  } catch (error) {
    if (error instanceof DrWriterFencedError) return { ok: false, issues: [error.reason] };
    const code = error instanceof Error ? error.message : String(error);
    if (!isDeviceRefusal(code)) throw error;
    return { ok: false, issues: [code] };
  }
}

// ---------- 거절 코드 → 한국어 ----------
const FIXED_MESSAGES: Record<string, string> = {
  site_fenced: "이 사이트는 지금 쓰기가 막혀 있습니다(DR).",
  invalid_actor: "저장한 사람을 확인하지 못했습니다. 다시 로그인해주세요.",
  model_capacity_replay_unsupported: "재생(replay) DB 에서는 장비 설정을 저장할 수 없습니다.",
  model_capacity_control_missing: "용량 제어 행(model_capacity_control)이 없습니다.",
  model_capacity_device_version_exhausted: "이 장비의 판 번호가 상한에 닿았습니다 — 운영자에게 알려주세요.",
  model_capacity_control_unreadable: "용량 제어 행을 읽지 못했습니다.",
  model_capacity_devices_unreadable: "장비 행(model_capacity_devices)을 읽지 못했습니다.",
  model_capacity_device_states_unreadable: "장비 실시간 상태를 읽지 못했습니다.",
  not_implemented: "저장 경로가 아직 준비되지 않았습니다(model_capacity_devices).",
  model_capacity_devices_not_implemented: "저장 경로가 아직 준비되지 않았습니다(model_capacity_devices).",
};
/**
 * zod 거절의 path(1b-A parseModelCapacityDeviceSettings: 첫 issue 의 경로, 없으면 root) → 문장. 교차 검사(refine)는 그 칸의 path 로 온다 —
 * secondaryCap(secondary_cap_exceeds_limit)·reserveSlots(reserve_exceeds_limit)·limitSlots(limit_exceeds_physical)·roles(duplicate_route) — 그래서 범위와 교차 규칙을 함께 적는다.
 */
const INVALID_FIELD_MESSAGES: Record<string, string> = {
  deviceId: "장비 이름: 1~120자, 앞뒤 공백·제어 문자 없이 적어주세요",
  limitSlots: "칸 수: 1~256 의 정수이고, 엔진 실제 동시 처리 수를 적었으면 그 값을 넘을 수 없습니다",
  secondaryCap: "낮은 순위 평소 상한: 0 이상, 칸 수 이하의 정수여야 합니다(칸 수를 넘을 수 없습니다)",
  idleMs: "유휴 판정 시간: 0~3600초여야 합니다",
  reserveSlots: "항상 비워 둘 칸: 0 이상, 칸 수 미만의 정수여야 합니다(최소 한 칸은 남겨야 합니다)",
  physicalLimit: "엔진 실제 동시 처리 수: 1~256 의 정수이거나 비워 둡니다",
  roles: "역할 순서: 같은 경로가 두 번 있거나 64개를 넘습니다",
  note: "메모: 400자까지입니다",
  actor: "저장한 사람을 확인하지 못했습니다. 다시 로그인해주세요.",
  root: "장비 설정 모양이 틀립니다(알 수 없는 칸이 있거나 칸이 빠졌습니다). 새로고침해주세요.",
};
const REFINEMENT_MESSAGES: Record<string, string> = {
  secondary_cap_exceeds_limit: INVALID_FIELD_MESSAGES.secondaryCap, reserve_exceeds_limit: INVALID_FIELD_MESSAGES.reserveSlots,
  limit_exceeds_physical: INVALID_FIELD_MESSAGES.limitSlots, duplicate_route: INVALID_FIELD_MESSAGES.roles,
  invalid_identity: "이름에 앞뒤 공백이나 제어 문자가 있습니다",
};
/** WP-A 저장·읽기의 코드를 운영자 문장으로. 모르는 코드는 그대로 보인다(숨기지 않는다) */
export function capacityDeviceIssueMessage(issue: string): string {
  if (FIXED_MESSAGES[issue]) return FIXED_MESSAGES[issue];
  if (/^Cannot find (module|package)|^Failed to load/.test(issue)) return FIXED_MESSAGES.model_capacity_devices_not_implemented;
  const colon = issue.indexOf(":");
  if (colon < 0) return issue;
  const code = issue.slice(0, colon), detail = issue.slice(colon + 1);
  switch (code) {
    case "model_capacity_device_version_mismatch":
      if (detail === "invalid") return "판 번호(version)를 읽지 못했습니다. 새로고침해주세요.";
      return `다른 사람이 먼저 저장했습니다(지금 판 ${detail === "none" ? "없음(새 장비)" : detail}). 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요.`;
    case "model_capacity_device_invalid": {
      if (REFINEMENT_MESSAGES[detail]) return REFINEMENT_MESSAGES[detail];
      if (INVALID_FIELD_MESSAGES[detail]) return INVALID_FIELD_MESSAGES[detail];
      const match = detail.match(/^roles\.(\d+)(?:\.(routeId|rank))?$/);
      if (match) return `역할 순서 ${Number(match[1]) + 1}번째: ${match[2] === "rank" ? "순위는 1~64 의 정수입니다" : match[2] === "routeId" ? "경로 id 는 1~120자, 앞뒤 공백·제어 문자 없이 적어주세요" : "경로 id 와 순위(1~64)를 함께 적어주세요"}`;
      const head = detail.split(/[.[]/)[0];
      return DEVICE_FIELD_LABELS[head] ? `${DEVICE_FIELD_LABELS[head]}: 범위를 벗어났거나 형식이 틀립니다(${detail})` : `장비 설정이 검사를 통과하지 못했습니다: ${detail}`;
    }
    default: return issue;
  }
}
export const deviceSourceLabel = (source: DeviceSource): string => source === "table" ? "표" : source === "policy_fallback" ? "정책 대체" : "미설정";

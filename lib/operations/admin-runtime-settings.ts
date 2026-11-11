import { inArray, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsObservations } from "@/lib/db/schema";
import { adminLog, type AdminLogRow } from "./admin-log";
import { isConsumerServiceInstance, parseServiceObservationKey } from "./instance";
import { readRuntimeSettingsRow, RUNTIME_SETTINGS_AUDIT_ACTION, type RuntimeSettingsRow } from "./runtime-settings";
import { MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS_MAX } from "@/lib/llm/capacity-unknown-hold";
import { ASSIGNMENT_TABLE_READS, ASSIGNMENT_TABLE_READS_LABELS, BUDGET_CALL_MARGIN_MS, BUDGET_THIN_MARGIN_MS, DEFAULT_JOB_BUDGET_MS, DEFAULT_RUNTIME_SETTINGS,
  GROUP_LABELS, JOB_LABELS, jobKnobsSchema, resolveRuntimeSettings, ROUTE_LABELS, RUNTIME_SETTING_GROUPS,
  runtimeSettingLabel, type JobKnobName, type RuntimeSettingGroup, type RuntimeSettings } from "./runtime-settings-schema";
import { parseRuntimeLanes } from "./worker-progress";

/**
 * 관리자 실시간 한도(runtime_settings)의 칸 모형·폼 → sparse patch·거절 문장 — PR 1a WP-D, 2026-11-11 개편.
 *
 * - 칸(SettingField)은 유효값(코드 기본값 위에 저장 문서를 덮은 것)·기본값·덮어쓴 키를 함께 싣는다. 저장 문서는 sparse 라(D2) 덮어쓴 키만 "덮어씀"이다.
 * - 폼은 바뀐 칸만 sparse patch 로 보낸다(runtimeSettingsPatchFromForm). ms 칸은 화면에서 초로 적고 patch 는 ms 다.
 * - 「실시간 한도」 화면(/admin/models/limits)의 작업 줄 모형은 admin-limits-view.ts 이고, 이 모듈은 칸·폼·문장과 다른 화면으로 옮긴 칸 묶음(buildSettingsControl)을 맡는다.
 * - 저장 거절 코드 → 한국어 문장은 runtimeSettingsIssueMessage 한 곳에서 만든다(폼·감사 줄이 같은 말을 쓴다).
 * 이 모듈은 DB 를 읽으므로 서버에서만 import 한다. 클라이언트 폼은 여기서 만든 값(문자열)만 받는다.
 */

/** "choice"(PR 3b-E): 숫자가 아닌 열거 칸 — 입력은 options 중 하나의 value 글자다(예: assignments.tableReads 'off' | 'on') */
export type FieldKind = "ms" | "int" | "budget" | "choice";
export type ChoiceOption = Readonly<{ value: string; label: string }>;
export type SettingField = {
  /** 저장 문서의 점 경로("routes.limits.product-translate.timeoutMs") — 폼 칸 이름의 뒷부분 */
  path: string;
  /** RUNTIME_SETTING_LABELS 의 한국어 이름. ms 칸은 화면이 초로 받으므로 "(ms)" 를 "(초)" 로 바꾼다 */
  label: string;
  kind: FieldKind;
  /** 유효값(ms·정수, choice 는 값 글자). 값이 없는 칸(예: 호출 상한이 없는 경로 → 모델 상한을 따른다)은 null */
  value: number | string | null;
  defaultValue: number | string | null;
  /** 저장 문서에 이 키가 있다(기본값과 같은 값이라도 "덮어씀") */
  overridden: boolean;
  /** 입력칸에 넣을 글자 — ms 는 초("300", "1.5"), 정수는 그대로, choice 는 값 글자. 값이 없으면 "" */
  input: string;
  defaultInput: string;
  /** choice 칸의 선택지(값 → 한국어). 다른 kind 에는 없다 */
  options?: readonly ChoiceOption[];
  readOnly?: boolean;
  note?: string;
};
/** 열거 칸의 선택지 — 경로마다 고정. 폼(runtimeSettingsPatchFromForm)이 이 목록 밖의 값을 거절하고, 저장 검사(zod enum)가 한 번 더 본다 */
export const CHOICE_OPTIONS: Readonly<Record<string, readonly ChoiceOption[]>> = Object.freeze({
  "assignments.tableReads": ASSIGNMENT_TABLE_READS.map(value => ({ value, label: ASSIGNMENT_TABLE_READS_LABELS[value] })),
});

export type LaneView = { state: string; currentJob: string | null; ageMs: number | null; budgetMs: number | null };
export type AuditView = { id: number; actor: string; at: string; ok: boolean; group: string; revision: number | null; changes: string[]; error: string | null };
export type RoleEnvView = { role: string; label: string; registryEnv: boolean };
/** 배정 화면(/admin/models/assignments)이 그리는 「배정 표 읽기」 폼 한 묶음 — 행을 못 읽으면 revision null·읽기 전용 */
export type AssignmentReadsControlView = { revision: number | null; rowError: string | null; fields: SettingField[] };

export type AdminObservation = { key: string; value: Record<string, unknown>; ageSeconds: number };
/** 모든 batch 역할 — 워커는 poll 마다 판을 읽으므로 maintenance 도 본다(live-settings-plan §3.3; settings-apply.ts RUNTIME_SETTINGS_APPLY.roles 와 같은 목록) */
export const RUNTIME_SETTINGS_ROLES = ["crawler", "reviewer", "publisher", "text", "maintenance"] as const;
/** 감시 프로세스는 15초마다 관측을 남긴다 — 1분 넘게 없으면 그 역할은 지금 일하지 않는다(settings-apply.ts 와 같다) */
const ACTIVE_SECONDS = 60;
const AUDIT_ROWS = 10;

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** ms → 초 글자("300", "1.5"). 소수는 셋째 자리까지만 */
export const msToInput = (ms: number | null | undefined): string => ms === null || ms === undefined ? "" : String(Math.round(ms) / 1000);
export const secondsLabel = (ms: number | null | undefined): string => ms === null || ms === undefined ? "—" : `${msToInput(ms)}초`;
export function fieldKind(path: string): FieldKind {
  if (path in CHOICE_OPTIONS) return "choice";
  if (path.startsWith("budgets.")) return "budget";
  // routes.timeouts.<route> 는 이름에 Ms 가 없지만 ms 값이다(lib/llm/model-registry.ts DEFAULT_MODEL_TIMEOUTS)
  return path.startsWith("routes.timeouts.") || path.endsWith("Ms") ? "ms" : "int";
}
/** 화면 이름표 — ms 칸은 초로 받으므로 "(ms)" 를 "(초)" 로 */
export function fieldLabel(path: string): string {
  const label = runtimeSettingLabel(path), kind = fieldKind(path);
  return kind === "int" || kind === "choice" ? label : label.replace("(ms)", "(초)");
}

/** 저장 문서(sparse)의 점 경로 값. 없으면 undefined, 명시된 null 은 null */
export function storedLeaf(stored: unknown, path: string): unknown {
  let node: unknown = stored;
  for (const key of path.split(".")) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

export function settingField(stored: unknown, path: string, value: number | string | null | undefined, defaultValue: number | string | null | undefined,
  extra: Partial<Pick<SettingField, "readOnly" | "note">> = {}): SettingField {
  const kind = fieldKind(path);
  const leaf = storedLeaf(stored, path);
  const toInput = (raw: number | string | null | undefined) => raw === null || raw === undefined ? "" : typeof raw === "string" || kind === "int" ? String(raw) : msToInput(raw);
  return { path, label: fieldLabel(path), kind, value: value ?? null, defaultValue: defaultValue ?? null, overridden: leaf !== undefined && leaf !== null,
    input: toInput(value), defaultInput: toInput(defaultValue), ...(kind === "choice" ? { options: CHOICE_OPTIONS[path] } : {}), ...extra };
}

/** 모델 배정 읽기(3b-E) — 열거 칸 하나. 켜면 모든 역할이 30초 안에 배정 표를 읽고, 끄면 설정으로 돌아간다(재배포 없음) */
export function assignmentFields(stored: unknown, effective: RuntimeSettings, defaults: RuntimeSettings): SettingField[] {
  return [settingField(stored, "assignments.tableReads", effective.assignments.tableReads, defaults.assignments.tableReads,
    { note: "켜면 1차·2차·단계 풀·등록부 기본값이 배정 표의 실전(live) 행으로 고릅니다(쓸 행이 없는 단계는 설정 그대로). 모든 역할이 30초 안에 같은 값을 읽습니다 — 재배포 없음. "
      + "env MODEL_ASSIGNMENT_TABLE(1·0)이 있는 앱은 그 값이 이깁니다(비상용)." })];
}

/**
 * 모델 장부 점유(2026-11-10 소유자 결정 「결과 미확정 점유」) — 정수 칸 하나(초). 입장 TX 가 이 행을 바로 읽으므로 저장 즉시 다음 입장부터 바뀐다.
 * 범위 0~3600(0 = 예전처럼 차지하지 않음).
 */
export function capacityFields(stored: unknown, effective: RuntimeSettings, defaults: RuntimeSettings): SettingField[] {
  return [settingField(stored, "capacity.unknownHoldSeconds", effective.capacity.unknownHoldSeconds, defaults.capacity.unknownHoldSeconds,
    { note: "결과 미확정(확인 못함) 호출은 보낸 시각부터 이 시간 동안 장비 칸·모델 상한·경로 몫을 계속 차지합니다 — 취소가 없는 엔진(M1 mlx-lm·supa)은 "
      + "기한이 지나도 생성을 계속하기 때문입니다. 지나면 칸을 놓고 재실행 대기 목록에만 남습니다(행 상태는 그대로). "
      + `0 이면 차지하지 않습니다(10-30 규칙). 범위 0~${MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS_MAX}초. 저장 즉시 다음 모델 입장부터 씁니다.` })];
}

export type RoleObservation = { registryEnv: boolean; jobMs: number | null; lanes: ReturnType<typeof parseRuntimeLanes> };
/** 역할마다 지금 일하는 인스턴스의 관측 하나(consumer 제외, 1분 안, running). 없으면 null */
export function latestRoleObservations(observations: readonly AdminObservation[]): Record<string, RoleObservation | null> {
  const result: Record<string, RoleObservation | null> = {};
  for (const role of RUNTIME_SETTINGS_ROLES) {
    const latest = observations.flatMap(row => {
      const parsed = parseServiceObservationKey(row.key);
      return parsed && parsed.role === role && !isConsumerServiceInstance(parsed.instanceId) ? [row] : [];
    }).sort((a, b) => a.ageSeconds - b.ageSeconds)[0];
    if (!latest || latest.ageSeconds > ACTIVE_SECONDS || latest.value.status !== "running") { result[role] = null; continue; }
    const limits = isPlainObject(latest.value.laneLimits) ? latest.value.laneLimits : {};
    const jobMs = typeof limits.jobMs === "number" && Number.isSafeInteger(limits.jobMs) && limits.jobMs > 0 ? limits.jobMs : null;
    result[role] = { registryEnv: latest.value.runtimeSettingsRegistryEnv === true, jobMs, lanes: parseRuntimeLanes(latest.value.lanes, role) };
  }
  return result;
}

/** 감사 detail.changes({path,before,after}[]) 를 "이름: 전 → 후" 로. path 는 전체 경로거나 그룹 안 경로일 수 있어 둘 다 받는다 */
export function auditChangeLines(row: Pick<AdminLogRow, "detail" | "target">): string[] {
  const group = String(row.target).replace(/^runtime_settings:/, "");
  const changes = Array.isArray(row.detail?.changes) ? row.detail.changes as { path?: unknown; before?: unknown; after?: unknown }[] : [];
  const show = (value: unknown) => value === null || value === undefined ? "기본값" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return changes.flatMap(change => {
    if (typeof change.path !== "string") return [];
    const label = runtimeSettingLabel(change.path) !== change.path ? runtimeSettingLabel(change.path) : runtimeSettingLabel(`${group}.${change.path}`);
    return [`${label}: ${show(change.before)} → ${show(change.after)}`];
  });
}
export function auditView(rows: readonly AdminLogRow[]): AuditView[] {
  return rows.slice(0, AUDIT_ROWS).map(row => {
    const group = String(row.target).replace(/^runtime_settings:/, "");
    const revision = row.detail?.revision;
    return { id: row.id, actor: row.actor, at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt), ok: row.ok,
      group: (GROUP_LABELS as Record<string, string>)[group] ?? group, revision: typeof revision === "number" ? revision : null,
      changes: auditChangeLines(row), error: row.error ? row.error.split(" · ").map(part => runtimeSettingsIssueMessage(part.trim())).join(" · ") : null };
  });
}

/** 역할 관측(service:<역할>) — 화면의 「읽은 판」 진단·지금 도는 틱이 읽는다 */
export async function readAdminObservations(): Promise<AdminObservation[]> {
  const rows = await db.select({ key: operationsObservations.key, value: operationsObservations.value,
    ageSeconds: sql<number>`extract(epoch from ((now() at time zone 'utc') - ${operationsObservations.observedAt}))::double precision` })
    .from(operationsObservations)
    .where(or(like(operationsObservations.key, "service:%"), inArray(operationsObservations.key, [...RUNTIME_SETTINGS_ROLES])));
  return rows.map(row => ({ key: row.key, value: row.value, ageSeconds: Number(row.ageSeconds) }));
}

/** 실시간 한도 저장 기록(runtime-settings-save) 최근 줄 — 못 읽으면 빈 목록 */
export async function readRuntimeSettingsAudit(): Promise<AuditView[]> {
  return auditView(await adminLog({ actions: [RUNTIME_SETTINGS_AUDIT_ACTION] }).catch(() => [] as AdminLogRow[]));
}

/**
 * 다른 화면으로 옮긴 실시간 한도 칸(2026-11-11 개편) — 그 값을 쓰는 화면이 같은 저장 행의 칸 몇 개를 그린다(저장은 saveRuntimeSettingsGroup, 그룹 하나).
 * 행을 못 읽으면 revision null(읽기 전용)이고 값은 코드 기본값이다.
 */
export type SettingsControlView = { revision: number | null; rowError: string | null; fields: SettingField[] };
export type SettingsControlSpec = Readonly<{ path: string; note?: string; readOnly?: boolean }>;
/** 점 경로의 유효값 — settings 를 그 경로로 따라간다(없으면 undefined) */
export function settingsLeaf(settings: RuntimeSettings, path: string): number | string | null | undefined {
  const value = storedLeaf(settings, path);
  return typeof value === "number" || typeof value === "string" || value === null ? value : undefined;
}
export function buildSettingsControl(row: RuntimeSettingsRow | null, specs: readonly SettingsControlSpec[], rowError: string | null = null): SettingsControlView {
  const { settings } = resolveRuntimeSettings(row?.values ?? null);
  const stored = row?.values ?? null;
  return { revision: row?.revision ?? null, rowError: row ? null : rowError ?? "runtime_settings_row_missing",
    fields: specs.map(spec => settingField(stored, spec.path, settingsLeaf(settings, spec.path), settingsLeaf(DEFAULT_RUNTIME_SETTINGS, spec.path),
      { ...(spec.note ? { note: spec.note } : {}), ...(spec.readOnly ? { readOnly: true } : {}) })) };
}
export async function readSettingsControl(specs: readonly SettingsControlSpec[]): Promise<SettingsControlView> {
  try { return buildSettingsControl(await readRuntimeSettingsRow(), specs); }
  catch (error) { return buildSettingsControl(null, specs, error instanceof Error ? error.message : String(error)); }
}

/** 장비 한도 화면(세부 설정)으로 옮긴 칸 — 결과 미확정 점유 유지 시간 */
export const UNKNOWN_HOLD_CONTROL: readonly SettingsControlSpec[] = Object.freeze([{ path: "capacity.unknownHoldSeconds",
  note: "결과 미확정(확인 못함) 호출은 보낸 시각부터 이 시간 동안 장비 칸·모델 상한·경로 몫을 계속 차지합니다 — 취소가 없는 엔진(M1 mlx-lm·supa)은 "
    + "기한이 지나도 생성을 계속하기 때문입니다. 지나면 칸을 놓고 재실행 대기 목록에만 남습니다(행 상태는 그대로). "
    + `0 이면 차지하지 않습니다(10-30 규칙). 범위 0~${MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS_MAX}초. 저장 즉시 다음 모델 입장부터 씁니다.` }]);
/** lib/domain/products/translations.ts DISPATCHABLE_ATTEMPTS — 자동 처리가 보내는 시도 수의 상한(이보다 큰 최대 시도는 보내기에 효과가 없다) */
export const TRANSLATION_DISPATCHABLE_ATTEMPTS = 4;
/** 공개 번역 화면으로 옮긴 칸 — 원문 글자 상한·묶음 글자·요청 보류 한도·최대 시도, 묶음 최대 건수(고정). 자동 틱 여유(jobMarginMs)는 실시간 한도에 남는다 */
export const TRANSLATION_LIMITS_CONTROL: readonly SettingsControlSpec[] = Object.freeze([
  { path: "translation.product.maxSourceChars", note: "낮추면 더 긴 원문 행은 다음 틱에 source_too_long 으로 표시되고 시도가 소진됩니다 — 되돌려도 그 행은 아래 목록에서 재요청해야 합니다" },
  { path: "translation.product.batchChars", note: "한 번에 묶어 보내는 글자 수의 문턱입니다. 원문 글자 상한보다 클 수 없습니다" },
  { path: "translation.product.demandLimit", note: "한 틱에 접수해 둘 번역 요청 수의 상한입니다" },
  { path: "translation.product.maxAttempts", note: `같은 원문의 자동 시도 상한입니다. 자동 처리는 ${TRANSLATION_DISPATCHABLE_ATTEMPTS}회까지만 보내므로 ${TRANSLATION_DISPATCHABLE_ATTEMPTS}보다 크게 해도 더 보내지 않습니다` },
  { path: "translation.product.batchMax", readOnly: true, note: "한 묶음의 최대 건수 — 코드에 4로 고정" },
]);
/** 작업 배정 화면으로 옮긴 칸 — 2차 심사 소비자 동시 업무 · 발행 분류 동시 묶음 */
export const JOB_CONCURRENCY_CONTROL: readonly SettingsControlSpec[] = Object.freeze([
  { path: "jobs.second-review.consumerConcurrency", note: "2차 심사 소비자가 한꺼번에 맡는 후보 수(1~4)입니다. 투표자 수·장비 한도와 별개이며 실제 동시 호출은 장비 한도가 막습니다" },
  { path: "jobs.crawl-publish.classifierConcurrency", note: "발행 분류를 작업 분산으로 돌릴 때 한 틱에 동시에 보내는 묶음 수(1~4)입니다. 대체 실행이면 늘 1입니다" },
]);

/** 배정 화면의 「배정 표 읽기」 폼 — 행 하나만 읽는다(못 읽으면 revision null·읽기 전용, 값은 기본값). 순수 부분은 assignmentFields */
export function buildAssignmentReadsControl(row: RuntimeSettingsRow | null, rowError: string | null = null): AssignmentReadsControlView {
  const { settings } = resolveRuntimeSettings(row?.values ?? null);
  return { revision: row?.revision ?? null, rowError: row ? null : rowError ?? "runtime_settings_row_missing",
    fields: assignmentFields(row?.values ?? null, settings, DEFAULT_RUNTIME_SETTINGS) };
}
export async function readAssignmentReadsControl(): Promise<AssignmentReadsControlView> {
  try { return buildAssignmentReadsControl(await readRuntimeSettingsRow()); }
  catch (error) { return buildAssignmentReadsControl(null, error instanceof Error ? error.message : String(error)); }
}

/**
 * 공개분 변경 재판정의 한도(잡별 묶음 jobs.published-recheck 다섯 칸, 2026-11-09) — /admin/audit?tab=recheck 가 보이는 그 자리에서 고친다.
 * 단위(건·%·시간)와 스키마 범위(jobKnobsSchema 그대로)를 칸마다 싣는다. 저장은 실시간 한도 화면과 같은 saveRuntimeSettings(group jobs, revision CAS)다
 */
export const RECHECK_LIMITS_JOB = "published-recheck";
export const RECHECK_LIMIT_KNOBS = Object.freeze(["scanBatch", "dailyCap", "askBatch", "minSimilarity", "yieldHours"] as const satisfies readonly JobKnobName[]);
export type RecheckLimitKnob = (typeof RECHECK_LIMIT_KNOBS)[number];
const RECHECK_LIMIT_UNITS: Readonly<Record<RecheckLimitKnob, string>> = Object.freeze({ scanBatch: "건", dailyCap: "건", askBatch: "건", minSimilarity: "%", yieldHours: "시간" });
const RECHECK_LIMIT_NOTES: Readonly<Record<RecheckLimitKnob, string>> = Object.freeze({
  scanBatch: "틱(1분)마다 견줄 공개 제품 수", dailyCap: "지난 24시간 재판정 줄에 올릴 최대 수 — 0 이면 올리기·쓸기 멈춤",
  askBatch: "묻기 갈래(CLI 순위 감사 잡·API 순위 Qwen 직접 감사 잡)마다 틱에 물을 항목 수 — 0 이면 묻기 멈춤",
  minSimilarity: "글 칸의 낱말 유사도가 이 % 아래면 바뀐 것으로 봄", yieldHours: "1차 대기가 있으면 물러나되, 가장 오래 기다린 항목이 이 시간을 넘으면 함께 묻기 — 0 이면 물러나지 않음" });
export type RecheckLimitField = SettingField & { knob: RecheckLimitKnob; unit: string; min: number; max: number };
export type RecheckLimitsControlView = { revision: number | null; rowError: string | null; fields: RecheckLimitField[]; settings: RuntimeSettings };

/** 그 잡 손잡이의 스키마 범위(jobKnobsSchema 의 min·max 그대로) — 화면이 범위를 보이고 거절 문장이 같은 범위를 말한다 */
export function jobKnobRange(knob: string): { min: number; max: number } | null {
  const schema = (jobKnobsSchema.shape as Record<string, (typeof jobKnobsSchema.shape)[JobKnobName] | undefined>)[knob]?.unwrap();
  return schema && typeof schema.minValue === "number" && typeof schema.maxValue === "number" ? { min: schema.minValue, max: schema.maxValue } : null;
}

/** 재판정 한도 폼 한 묶음 — 행을 못 읽으면 revision null(읽기 전용)이고 값은 코드 기본값이다. settings 는 화면의 다른 글(양보 시간 등)이 같은 값을 쓰게 함께 준다 */
export function buildRecheckLimitsControl(row: RuntimeSettingsRow | null, rowError: string | null = null): RecheckLimitsControlView {
  const { settings } = resolveRuntimeSettings(row?.values ?? null);
  const stored = row?.values ?? null;
  const fields = RECHECK_LIMIT_KNOBS.map((knob): RecheckLimitField => {
    const base = DEFAULT_RUNTIME_SETTINGS.jobs[RECHECK_LIMITS_JOB]?.[knob];
    const range = jobKnobRange(knob)!;
    return { ...settingField(stored, `jobs.${RECHECK_LIMITS_JOB}.${knob}`, settings.jobs[RECHECK_LIMITS_JOB]?.[knob] ?? base, base, { note: RECHECK_LIMIT_NOTES[knob] }),
      knob, unit: RECHECK_LIMIT_UNITS[knob], ...range };
  });
  return { revision: row?.revision ?? null, rowError: row ? null : rowError ?? "runtime_settings_row_missing", fields, settings };
}
/** 저장 행을 바로 읽는다(30초 스냅숏이 아니다) — 저장 뒤 화면이 새 값을 그린다 */
export async function readRecheckLimitsControl(): Promise<RecheckLimitsControlView> {
  try { return buildRecheckLimitsControl(await readRuntimeSettingsRow()); }
  catch (error) { return buildRecheckLimitsControl(null, error instanceof Error ? error.message : String(error)); }
}

// ---------- 폼 → sparse patch ----------
export type FormPatch = { patch: Record<string, unknown>; changed: string[]; issues: string[] };
type FormLike = { get(name: string): FormDataEntryValue | null; entries(): IterableIterator<[string, FormDataEntryValue]> };
const text = (value: FormDataEntryValue | null) => typeof value === "string" ? value.trim() : "";

function setLeaf(patch: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = patch;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}
/** 입력 글자 → 값. ms 칸은 초 → ms. 빈 글자는 null(relayMs 의 "중계 없음"), 숫자가 아니면 undefined */
export function parseFieldInput(kind: FieldKind, raw: string): number | null | undefined {
  if (raw === "") return null;
  const number = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(number)) return undefined;
  if (kind === "int") return Number.isInteger(number) ? number : undefined;
  return Math.round(number * 1000);
}

/**
 * 초 칸에 ms 를 넣는 실수 막기 — 화면은 ms 값을 초로 받는다(이름표 「(초)」). 2026-11-07 CLI 심사 호출 상한에 60000(ms 생각)을 넣어
 * 그대로였으면 60000초(약 17시간)가 될 뻔했다. 이 화면의 호출 상한·기한·틱 예산은 모두 1시간보다 짧으므로 1시간 넘는 값은 거절하고 고칠 값을 알려 준다.
 */
export const SECONDS_FIELD_MAX_MS = 3_600_000;
function secondsTooLarge(label: string, raw: string, value: number): string | null {
  if (value <= SECONDS_FIELD_MAX_MS) return null;
  const asMs = Number(raw.replace(/,/g, "")) / 1000;
  return `${label}: ${raw}초는 1시간이 넘습니다 — 이 칸은 초 단위입니다${Number.isFinite(asMs) && asMs >= 1 ? `(ms로 넣으셨다면 ${asMs}초)` : ""}`;
}

/**
 * 폼 칸 이름: value:<path>(지금 글자) · initial:<path>(처음 그린 글자) · stored:<path>("1" = 덮어쓴 키) · reset:<path>(기본값으로)
 * · auto:budgets.<job> / initialAuto:budgets.<job>. 바뀐 칸만 patch 에 넣는다. reset 은 덮어쓴 키에만 null 을 넣는다(없는 키의 reset 은 바뀐 것이 없다).
 * patch 는 저장 문서 모양(그룹 키부터)이다: { translation: { product: { batchChars: 6000 } } }.
 * group 은 하나거나 여럿이다(실시간 한도 화면은 한 폼이 routes·jobs·budgets·translation 을 함께 보낸다 — saveRuntimeSettings 가 한 TX 로 저장한다).
 */
export function runtimeSettingsPatchFromForm(group: RuntimeSettingGroup | readonly RuntimeSettingGroup[], form: FormLike): FormPatch {
  const groups: readonly RuntimeSettingGroup[] = typeof group === "string" ? [group] : group;
  const patch: Record<string, unknown> = {}, changed: string[] = [], issues: string[] = [];
  for (const [name, entry] of form.entries()) {
    if (!name.startsWith("value:")) continue;
    const path = name.slice("value:".length);
    if (!groups.some(each => path.startsWith(`${each}.`)) || path.split(".").some(part => !part)) { issues.push(`모르는 설정입니다: ${path}`); continue; }
    const label = fieldLabel(path), kind = fieldKind(path);
    if (text(form.get(`reset:${path}`)) === "on") {
      if (text(form.get(`stored:${path}`)) === "1") { setLeaf(patch, path, null); changed.push(path); }
      continue;
    }
    const raw = text(entry), initial = text(form.get(`initial:${path}`));
    if (kind === "choice") {
      // 열거 칸(3b-E): 선택지 밖의 값은 거절, 처음 그린 값과 같으면 바뀐 것이 없다. 값은 글자 그대로 저장 문서에 들어간다
      if (!CHOICE_OPTIONS[path]?.some(option => option.value === raw)) { issues.push(`${label}: 고를 수 있는 값이 아닙니다(${raw || "비었음"})`); continue; }
      if (raw !== initial) { setLeaf(patch, path, raw); changed.push(path); }
      continue;
    }
    if (kind === "budget") {
      const autoNow = text(form.get(`auto:${path}`)) === "on", autoBefore = text(form.get(`initialAuto:${path}`)) === "1";
      if (autoNow) { if (!autoBefore) { setLeaf(patch, path, "auto"); changed.push(path); } continue; }
      // auto 를 끄지 않았고 처음 그린 글자 그대로면 바뀐 칸이 아니다 — 예산을 적지 않은 잡(소개 생성 crawl-tagline)은 빈칸으로 그려져
      // 숫자 검사를 먼저 하면 다른 잡의 예산을 고쳐도 묶음 저장이 늘 거절됐다(2026-11-11, 경로 한도의 2026-11-07 거절과 같은 꼴). auto 를 끈 칸은 그 값으로 저장한다
      if (!autoBefore && raw === initial) continue;
      const value = parseFieldInput("ms", raw);
      if (value === undefined || value === null) { issues.push(`${label}: 초 단위 숫자를 넣어주세요`); continue; }
      const tooLargeBudget = secondsTooLarge(label, raw, value);
      if (tooLargeBudget && raw !== initial) { issues.push(tooLargeBudget); continue; }
      if (autoBefore || value !== parseFieldInput("ms", initial)) { setLeaf(patch, path, value); changed.push(path); }
      continue;
    }
    // 처음 그린 글자 그대로면 바뀐 칸이 아니다 — 코드 기본값이 없어 빈칸으로 그려진 칸(routes.timeouts.<route> 등)을 「값이 비었습니다」로
    // 거절하면 같은 묶음의 다른 칸을 고쳐도 저장이 늘 실패한다(2026-11-07 CLI 심사 상한 저장 거절). 「기본값으로」는 덮어쓴 칸에만 있어 우회도 없었다
    if (raw === initial) continue;
    const value = parseFieldInput(kind, raw);
    if (value === undefined) { issues.push(kind === "int" ? `${label}: 정수를 넣어주세요` : `${label}: 초 단위 숫자를 넣어주세요`); continue; }
    if (value === null && !path.endsWith(".relayMs")) { issues.push(`${label}: 값이 비었습니다 — 기본값으로 돌리려면 「기본값으로」를 켜주세요`); continue; }
    if (kind === "ms" && value !== null) {
      const tooLarge = secondsTooLarge(label, raw, value);
      if (tooLarge) { issues.push(tooLarge); continue; }
    }
    if (value !== parseFieldInput(kind, initial)) { setLeaf(patch, path, value); changed.push(path); }
  }
  if (groups.includes("routes")) deriveReviewLadder(patch, changed, form);
  return { patch, changed, issues };
}

/** 심사 사다리(routes.deadlines.review-gateway) — 화면은 클라이언트 기한(= 2차 심사·1차 Qwen 호출 상한)만 받는다 */
export const REVIEW_LADDER_ROUTE = "review-gateway";
const LADDER_STEP_MS = 5_000;
/**
 * 클라이언트 기한(clientMs)을 바꾸면 안쪽 선언 층(게이트웨이·중계·엔진)을 순서가 맞게 끌어내린다(2026-11-11 개편 — 그 세 칸은 아무도 강제하지 않는 선언이라
 * 화면에서 뺐다; 남겨 두면 클라이언트 기한을 57초 아래로 낮추는 저장이 deadline_order_inverted 로 늘 거절된다).
 * 지금 값은 폼의 숨은 칸 current:<사다리 경로>.<층> 에서 읽는다. 층이 이미 순서에 맞으면 건드리지 않는다(올릴 때는 아무 것도 바꾸지 않는다).
 * 게이트웨이 = min(지금, 클라이언트 - 5초), 중계(있으면) = min(지금, 게이트웨이 - 2.5초), 엔진 = min(지금, (중계 ?? 게이트웨이) - 5초). 엔진이 1초 아래로 가면 끌어내리지 않는다(검사가 거절한다).
 */
function deriveReviewLadder(patch: Record<string, unknown>, changed: string[], form: FormLike): void {
  const base = `routes.deadlines.${REVIEW_LADDER_ROUTE}`;
  const client = storedLeaf(patch, `${base}.clientMs`);
  if (typeof client !== "number") return;
  const current = (layer: string) => { const value = parseFieldInput("ms", text(form.get(`current:${base}.${layer}`))); return typeof value === "number" ? value : null; };
  const gateway = current("gatewayMs"), engine = current("engineMs"), relay = current("relayMs");
  if (gateway === null || engine === null) return;
  const nextGateway = Math.min(gateway, client - LADDER_STEP_MS);
  const nextRelay = relay === null ? null : Math.min(relay, nextGateway - LADDER_STEP_MS / 2);
  const nextEngine = Math.min(engine, (nextRelay ?? nextGateway) - LADDER_STEP_MS);
  if (nextEngine < 1_000) return;
  for (const [layer, before, after] of [["gatewayMs", gateway, nextGateway], ["relayMs", relay, nextRelay], ["engineMs", engine, nextEngine]] as const) {
    if (after === null || after === before) continue;
    setLeaf(patch, `${base}.${layer}`, after);
    changed.push(`${base}.${layer}`);
  }
}

// ---------- 거절·경고 코드 → 한국어 ----------
const routeLabel = (route: string) => ROUTE_LABELS[route] ?? route;
const jobLabel = (job: string) => JOB_LABELS[job] ?? job;
const FIXED_MESSAGES: Record<string, string> = {
  stale_form: "그 사이 다른 곳에서 설정이 바뀌었습니다. 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요.",
  site_fenced: "이 사이트는 지금 쓰기가 막혀 있습니다(DR).",
  batch_exceeds_source_cap: "묶음 글자 수가 원문 상한보다 큽니다",
  deadline_order_inverted: "기한 사다리 순서가 어긋났습니다(엔진 < 중계 < 게이트웨이 < 클라이언트, 층 사이 2초 이상)",
  model_timeout_ladder_mismatch: "호출 상한이 같은 경로 사다리의 클라이언트 기한과 다릅니다",
  model_role_deadline_order_inverted: "모델 상한이 심사 사다리 순서를 어긋나게 합니다(서빙 계약·등록부 → 등록부 덮어쓰기에서 확인)",
  invalid_model_registry: "합친 등록부가 검사를 통과하지 못했습니다.",
  runtime_settings_unreadable: "저장 문서를 읽을 수 없습니다.",
  runtime_settings_not_implemented: "저장 경로가 아직 준비되지 않았습니다(runtime_settings).",
  runtime_settings_row_missing: "runtime_settings 행이 없습니다(마이그레이션 0151 전). 값은 코드 기본값입니다.",
};
/** saveRuntimeSettings·resolveRuntimeSettings 의 issue 코드를 운영자 문장으로. 모르는 코드는 그대로 보인다(숨기지 않는다) */
export function runtimeSettingsIssueMessage(issue: string): string {
  if (FIXED_MESSAGES[issue]) return FIXED_MESSAGES[issue];
  const colon = issue.indexOf(":");
  if (colon < 0) return issue;
  const code = issue.slice(0, colon), detail = issue.slice(colon + 1);
  switch (code) {
    case "unknown_route": return `모르는 경로입니다: ${detail}`;
    case "unknown_job": return `모르는 잡입니다: ${detail}`;
    case "unknown_job_knob": { const [job, knob] = detail.split("."); return `${jobLabel(job)} 에 없는 손잡이입니다: ${knob}`; }
    case "unknown_group": case "unknown_setting": return `모르는 설정입니다: ${detail}`;
    case "budget_below_call_timeout": return `${jobLabel(detail)} 틱 예산이 호출 상한보다 짧습니다 — 예산 ≥ 상한 + ${secondsLabel(BUDGET_CALL_MARGIN_MS)}`;
    case "budget_below_min_call": return `${jobLabel(detail)} 틱 예산이 최소 남은 시간보다 짧습니다 — 예산 ≥ 최소 남은 시간 + 5초`;
    case "min_call_exceeds_timeout": return `${jobLabel(detail)} 최소 남은 시간이 호출 상한보다 깁니다 — 틱이 호출을 시작하지 못합니다`;
    case "auto_budget_without_route": return `${jobLabel(detail)} 은 호출 상한 경로가 없어 auto 예산을 쓸 수 없습니다`;
    case "timeout_below_engine_bound": return `${routeLabel(detail)} 호출 상한이 엔진 기한 + ${secondsLabel(BUDGET_CALL_MARGIN_MS)}보다 짧습니다`;
    case "runtime_settings_invalid": {
      if (detail in CHOICE_OPTIONS) return `${runtimeSettingLabel(detail)}: 고를 수 있는 값이 아닙니다(${CHOICE_OPTIONS[detail].map(option => option.value).join(" · ")})`;
      // 잡별 묶음의 정수 칸은 스키마 범위를 함께 말한다(2026-11-09 — 재판정 한도를 그 자리에서 고칠 때 무엇을 넣어야 하는지 보이게). ms 칸은 화면 단위가 초라 범위를 붙이지 않는다
      const parts = detail.split("."), range = parts[0] === "jobs" && parts.length === 3 && fieldKind(detail) === "int" ? jobKnobRange(parts[2])
        : detail === "capacity.unknownHoldSeconds" ? { min: 0, max: MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS_MAX } : null;
      return `${runtimeSettingLabel(detail)}: 범위를 벗어났습니다${range ? `(${range.min}~${range.max})` : ""}`;
    }
    case "runtime_settings_version": return `저장 문서 판 표시가 다릅니다: ${detail}`;
    default: return issue;
  }
}
export function runtimeSettingsWarningMessage(code: string): string {
  const colon = code.indexOf(":"), kind = colon < 0 ? code : code.slice(0, colon), job = colon < 0 ? "" : code.slice(colon + 1);
  switch (kind) {
    case "budget_margin_thin": return `${jobLabel(job)} 예산 여유가 ${secondsLabel(BUDGET_THIN_MARGIN_MS)}보다 좁습니다 — 틱 끝의 호출이 자주 헛돕니다`;
    case "budget_default_below_call_timeout": return `${jobLabel(job)} 은 예산을 적지 않아 runner 기본 ${secondsLabel(DEFAULT_JOB_BUDGET_MS)}로 돕니다 — 호출 상한보다 짧습니다`;
    default: return code;
  }
}
/** 「실시간 한도」 화면 한 폼이 보내는 그룹 — 작업 줄의 호출 상한·동시 호출·응답 토큰(routes), 묶음(jobs), 틱 시간(budgets), 자동 틱 여유(translation) */
export const LIMITS_PAGE_GROUPS: readonly RuntimeSettingGroup[] = Object.freeze(["routes", "jobs", "budgets", "translation"]);
export const isRuntimeSettingGroup = (value: unknown): value is RuntimeSettingGroup => typeof value === "string" && (RUNTIME_SETTING_GROUPS as readonly string[]).includes(value);

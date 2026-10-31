import { inArray, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsObservations } from "@/lib/db/schema";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import type { DeadlineLadder } from "@/lib/llm/deadline-policy";
import { DEFAULT_MODEL_DEFINITIONS, DEFAULT_MODEL_TIMEOUTS, readModelRegistry, type ModelDefinition } from "@/lib/llm/model-registry";
import { adminLog, type AdminLogRow } from "./admin-log";
import { ROLE_LABELS } from "./contracts";
import { isConsumerServiceInstance, parseServiceObservationKey } from "./instance";
import { readRuntimeSettingsApply, readRuntimeSettingsRow, RUNTIME_SETTINGS_AUDIT_ACTION, type RuntimeSettingsRow } from "./runtime-settings";
import { ASSIGNMENT_TABLE_READS, ASSIGNMENT_TABLE_READS_LABELS, BUDGET_CALL_MARGIN_MS, BUDGET_THIN_MARGIN_MS, DEFAULT_JOB_BUDGET_MS, DEFAULT_RUNTIME_SETTINGS,
  effectiveJobBudgetMs, GROUP_LABELS, JOB_CALL_ROUTES, JOB_KNOB_NAMES, JOB_LABELS, jobCallCeilingMs, resolveRuntimeSettings, ROUTE_LABELS, RUNTIME_SETTING_GROUPS,
  runtimeSettingLabel, runtimeSettingsWarnings, shortRuntimeSettingsVersion, storedSettingsVersion, type JobKnobName, type ProductTranslationPolicy,
  type RuntimeSettingGroup, type RuntimeSettings } from "./runtime-settings-schema";
import type { SettingsApply } from "./settings-apply";
import { parseRuntimeLanes } from "./worker-progress";

/**
 * 관리자 「실시간 한도」(/admin/models/limits) 화면 모형 — PR 1a WP-D.
 *
 * - 유효값(코드 기본값 위에 저장 문서를 덮은 것)·기본값·덮어쓴 키를 칸마다 함께 보인다. 저장 문서는 sparse 라(D2) 덮어쓴 키만 "덮어씀"이다.
 * - 폼은 바뀐 칸만 sparse patch 로 보낸다(runtimeSettingsPatchFromForm). ms 칸은 화면에서 초로 적고 patch 는 ms 다.
 * - "읽은 판"은 readRuntimeSettingsApply(WP-A/B)가 주고, 역할별 env 등록부 여부·감독 하한·지금 도는 틱은 service:<역할> 관측에서 읽는다
 *   (heartbeat 의 runtimeSettingsRegistryEnv·laneLimits·lanes — scripts/worker-supervisor.ts WorkerHealth 계약).
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

export type RouteRow = { route: string; label: string; maxTokens: SettingField | null; concurrency: SettingField | null; timeout: SettingField | null;
  /** 호출 상한 칸이 없을 때의 설명(사다리 클라이언트 기한을 따른다 등) */
  timeoutNote: string | null;
  /** 이 경로를 맡은 등록부 모델의 상한(읽기 전용, 가장 작은 값) */
  modelCeiling: string | null };
export type LadderRow = { route: string; label: string; fields: Record<keyof DeadlineLadder, SettingField> };
export type JobKnobRow = { job: string; label: string; knobs: Partial<Record<JobKnobName, SettingField>> };
export type LaneView = { state: string; currentJob: string | null; ageMs: number | null; budgetMs: number | null };
export type BudgetRow = { job: string; label: string; role: string; roleLabel: string; field: SettingField; auto: boolean; defaultAuto: boolean;
  /** "auto" 일 때 "= 호출 상한 300초 + 여유 15초 = 315초" */
  autoNote: string | null;
  /** 예산을 적지 않은 잡(runner 기본 25초로 돈다) */
  declared: boolean;
  ceilingMs: number | null;
  /** 최근 관측의 laneLimits.jobMs — 감독의 env 하한 */
  supervisorFloorMs: number | null;
  lane: LaneView | null;
  warning: string | null };
export type AuditView = { id: number; actor: string; at: string; ok: boolean; group: string; revision: number | null; changes: string[]; error: string | null };
export type RoleEnvView = { role: string; label: string; registryEnv: boolean };
export type RuntimeSettingsAdminView = {
  /** 저장 행을 읽었으면 revision·판. 못 읽었으면(0151 전·stub) null 이고 rowError 에 이유 */
  revision: number | null; version: string; shortVersion: string; updatedBy: string | null; updatedAt: string | null; rowError: string | null;
  stored: Record<string, unknown>;
  effective: RuntimeSettings; defaults: RuntimeSettings;
  issues: string[]; warnings: string[];
  routes: RouteRow[]; ladders: LadderRow[]; translation: SettingField[]; jobKnobs: JobKnobRow[]; budgets: BudgetRow[];
  /** 모델 배정 읽기(3b-E) — 열거 칸(assignments.tableReads) */
  assignments: SettingField[];
  apply: SettingsApply | null; roles: RoleEnvView[];
  audit: AuditView[];
};
/** 배정 화면(/admin/models/assignments)이 그리는 「배정 표 읽기」 폼 한 묶음 — 행을 못 읽으면 revision null·읽기 전용 */
export type AssignmentReadsControlView = { revision: number | null; rowError: string | null; fields: SettingField[] };

export type AdminObservation = { key: string; value: Record<string, unknown>; ageSeconds: number };
/** 모든 batch 역할 — 워커는 poll 마다 판을 읽으므로 maintenance 도 본다(live-settings-plan §3.3; settings-apply.ts RUNTIME_SETTINGS_APPLY.roles 와 같은 목록) */
export const RUNTIME_SETTINGS_ROLES = ["crawler", "reviewer", "publisher", "text", "maintenance"] as const;
/** 감시 프로세스는 15초마다 관측을 남긴다 — 1분 넘게 없으면 그 역할은 지금 일하지 않는다(settings-apply.ts 와 같다) */
const ACTIVE_SECONDS = 60;
const AUDIT_ROWS = 10;

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const fmt = (value: number) => value.toLocaleString("ko-KR");
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

function field(stored: unknown, path: string, value: number | string | null | undefined, defaultValue: number | string | null | undefined,
  extra: Partial<Pick<SettingField, "readOnly" | "note">> = {}): SettingField {
  const kind = fieldKind(path);
  const leaf = storedLeaf(stored, path);
  const toInput = (raw: number | string | null | undefined) => raw === null || raw === undefined ? "" : typeof raw === "string" || kind === "int" ? String(raw) : msToInput(raw);
  return { path, label: fieldLabel(path), kind, value: value ?? null, defaultValue: defaultValue ?? null, overridden: leaf !== undefined && leaf !== null,
    input: toInput(value), defaultInput: toInput(defaultValue), ...(kind === "choice" ? { options: CHOICE_OPTIONS[path] } : {}), ...extra };
}

/** 모델 배정 읽기(3b-E) — 열거 칸 하나. 켜면 모든 역할이 30초 안에 배정 표를 읽고, 끄면 설정으로 돌아간다(재배포 없음) */
export function assignmentFields(stored: unknown, effective: RuntimeSettings, defaults: RuntimeSettings): SettingField[] {
  return [field(stored, "assignments.tableReads", effective.assignments.tableReads, defaults.assignments.tableReads,
    { note: "켜면 1차·2차·단계 풀·등록부 기본값이 배정 표의 실전(live) 행으로 고릅니다(쓸 행이 없는 단계는 설정 그대로). 모든 역할이 30초 안에 같은 값을 읽습니다 — 재배포 없음. "
      + "env MODEL_ASSIGNMENT_TABLE(1·0)이 있는 앱은 그 값이 이깁니다(비상용)." })];
}

function modelCeiling(route: string, models: readonly ModelDefinition[]): string | null {
  const serving = models.filter(model => model.purposes.includes(route));
  if (!serving.length) return null;
  const min = (pick: (model: ModelDefinition) => number) => Math.min(...serving.map(pick));
  const names = serving.map(model => model.key).join(", ");
  return `${names}: 상한 ${secondsLabel(min(model => model.timeoutMs))} · ${fmt(min(model => model.maxTokens))} 토큰 · 동시 ${min(model => model.concurrency)}`;
}

function routeRows(stored: unknown, effective: RuntimeSettings, defaults: RuntimeSettings, models: readonly ModelDefinition[]): RouteRow[] {
  const storedRoutes = isPlainObject(storedLeaf(stored, "routes")) ? storedLeaf(stored, "routes") as Record<string, unknown> : {};
  const routes = new Set([...Object.keys(defaults.routes.limits), ...Object.keys(defaults.routes.timeouts),
    ...Object.keys(isPlainObject(storedRoutes.limits) ? storedRoutes.limits : {}), ...Object.keys(isPlainObject(storedRoutes.timeouts) ? storedRoutes.timeouts : {})]);
  return [...routes].sort((a, b) => (ROUTE_LABELS[a] ?? a).localeCompare(ROUTE_LABELS[b] ?? b, "ko")).map(route => {
    const limit = effective.routes.limits[route], base = defaults.routes.limits[route];
    const row: RouteRow = { route, label: ROUTE_LABELS[route] ?? route, maxTokens: null, concurrency: null, timeout: null, timeoutNote: null,
      modelCeiling: modelCeiling(route, models) };
    if (limit) {
      row.maxTokens = field(stored, `routes.limits.${route}.maxTokens`, limit.maxTokens, base?.maxTokens);
      row.concurrency = field(stored, `routes.limits.${route}.concurrency`, limit.concurrency, base?.concurrency);
    }
    if (effective.routes.deadlines[route]) row.timeoutNote = `기한 사다리의 클라이언트 기한(${secondsLabel(effective.routes.deadlines[route].clientMs)})을 따릅니다 — 아래 사다리에서 바꿉니다`;
    else if (route in DEFAULT_MODEL_TIMEOUTS || effective.routes.timeouts[route] !== undefined)
      row.timeout = field(stored, `routes.timeouts.${route}`, effective.routes.timeouts[route], defaults.routes.timeouts[route]);
    else if (limit) row.timeout = field(stored, `routes.limits.${route}.timeoutMs`, limit.timeoutMs, base?.timeoutMs,
      limit.timeoutMs === undefined ? { note: "비우면 모델 상한을 따릅니다" } : {});
    return row;
  });
}

function ladderRows(stored: unknown, effective: RuntimeSettings, defaults: RuntimeSettings): LadderRow[] {
  return Object.keys(effective.routes.deadlines).sort().map(route => {
    const ladder = effective.routes.deadlines[route], base = defaults.routes.deadlines[route];
    const part = (key: keyof DeadlineLadder, note?: string) => field(stored, `routes.deadlines.${route}.${key}`, ladder[key], base?.[key], note ? { note } : {});
    return { route, label: ROUTE_LABELS[route] ?? route, fields: { engineMs: part("engineMs", "선언만 — 엔진이 강제하지 않습니다"), relayMs: part("relayMs", "비우면 중계 층 없음"),
      gatewayMs: part("gatewayMs", "선언만 — 게이트웨이가 강제하지 않습니다"), clientMs: part("clientMs", "이 경로의 호출 상한") } };
  });
}

function translationFields(stored: unknown, effective: RuntimeSettings, defaults: RuntimeSettings): SettingField[] {
  const keys = Object.keys(defaults.translation.product) as (keyof ProductTranslationPolicy)[];
  return keys.map(key => field(stored, `translation.product.${key}`, effective.translation.product[key], defaults.translation.product[key],
    key === "batchMax" ? { readOnly: true, note: "PR 1a 에서는 4로 고정" }
      : key === "maxSourceChars" ? { note: "낮추면 더 긴 원문 행은 다음 틱에 source_too_long 으로 표시되고 시도가 소진됩니다 — 되돌려도 그 행은 공개 번역 화면에서 재요청해야 합니다" } : {}));
}

function jobKnobRows(stored: unknown, effective: RuntimeSettings, defaults: RuntimeSettings): JobKnobRow[] {
  return Object.keys(defaults.jobs).map(job => {
    const knobs: JobKnobRow["knobs"] = {};
    for (const knob of JOB_KNOB_NAMES) {
      const base = defaults.jobs[job]?.[knob];
      if (base === undefined) continue;
      knobs[knob] = field(stored, `jobs.${job}.${knob}`, effective.jobs[job]?.[knob] ?? base, base);
    }
    return { job, label: JOB_LABELS[job] ?? job, knobs };
  });
}

type RoleObservation = { registryEnv: boolean; jobMs: number | null; lanes: ReturnType<typeof parseRuntimeLanes> };
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

function budgetRows(stored: unknown, effective: RuntimeSettings, defaults: RuntimeSettings, models: readonly ModelDefinition[],
  roles: Record<string, RoleObservation | null>, warnings: readonly string[], now: Date): BudgetRow[] {
  const storedBudgets = isPlainObject(storedLeaf(stored, "budgets")) ? storedLeaf(stored, "budgets") as Record<string, unknown> : {};
  const jobs = new Set([...Object.keys(defaults.budgets), ...Object.keys(JOB_CALL_ROUTES), ...Object.keys(storedBudgets)]);
  const roleOrder = [...RUNTIME_SETTINGS_ROLES] as string[];
  const rows = [...jobs].map((job): BudgetRow => {
    const role = JOB_CATALOG.find(entry => entry.name === job)?.role ?? "unknown";
    const raw = effective.budgets[job], base = defaults.budgets[job];
    const declared = raw !== undefined;
    const auto = raw === "auto", defaultAuto = base === "auto";
    const ceilingMs = jobCallCeilingMs(job, effective, models);
    const value = declared ? effectiveJobBudgetMs(job, effective, models) : null;
    const defaultValue = base === undefined ? null : base === "auto" ? effectiveJobBudgetMs(job, defaults, models) : base;
    const row = field(stored, `budgets.${job}`, value, defaultValue, declared ? {} : { note: `예산을 적지 않은 잡 — runner 기본 ${secondsLabel(DEFAULT_JOB_BUDGET_MS)}로 돕니다` });
    const margin = effective.translation.product.jobMarginMs;
    const autoNote = auto && ceilingMs !== null ? `= 호출 상한 ${secondsLabel(ceilingMs)} + 여유 ${secondsLabel(margin)} = ${secondsLabel(ceilingMs + margin)}` : null;
    const observed = roles[role] ?? null;
    const lane = observed?.lanes?.find(entry => entry.jobs.includes(job)) ?? null;
    const laneView: LaneView | null = lane ? { state: lane.state, currentJob: lane.currentJob,
      ageMs: lane.state === "running" && lane.startedAt !== null ? Math.max(0, now.getTime() - lane.startedAt) : null, budgetMs: lane.budgetMs ?? null } : null;
    const warning = warnings.find(code => code.endsWith(`:${job}`)) ?? null;
    return { job, label: JOB_LABELS[job] ?? job, role, roleLabel: ROLE_LABELS[role] ?? role, field: row, auto, defaultAuto, autoNote, declared, ceilingMs,
      supervisorFloorMs: observed?.jobMs ?? null, lane: laneView, warning: warning ? runtimeSettingsWarningMessage(warning) : null };
  });
  return rows.sort((a, b) => (roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role)) || a.label.localeCompare(b.label, "ko"));
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
      changes: auditChangeLines(row), error: row.error ?? null };
  });
}

export type AdminViewInput = { row: RuntimeSettingsRow | null; rowError?: string | null; models?: readonly ModelDefinition[]; apply?: SettingsApply | null;
  observations?: readonly AdminObservation[]; audit?: readonly AdminLogRow[]; now?: Date };

/** 순수 — DB 없이 시험한다. row 가 null 이면(0151 전·stub) 기본값으로 그리고 폼은 읽기 전용이다 */
export function buildRuntimeSettingsAdminView(input: AdminViewInput): RuntimeSettingsAdminView {
  const models = input.models ?? DEFAULT_MODEL_DEFINITIONS, now = input.now ?? new Date();
  const stored = isPlainObject(input.row?.values) ? input.row!.values as Record<string, unknown> : {};
  const { settings: effective, issues } = resolveRuntimeSettings(input.row?.values ?? null, { models });
  const defaults = DEFAULT_RUNTIME_SETTINGS;
  const warnings = runtimeSettingsWarnings(effective, models);
  const roles = latestRoleObservations(input.observations ?? []);
  const version = input.row ? storedSettingsVersion(input.row.values) : "default";
  return {
    revision: input.row?.revision ?? null, version, shortVersion: shortRuntimeSettingsVersion(version), updatedBy: input.row?.updatedBy ?? null,
    updatedAt: input.row?.updatedAt ?? null, rowError: input.row ? null : input.rowError ?? "runtime_settings_row_missing",
    stored, effective, defaults, issues: issues.map(runtimeSettingsIssueMessage), warnings: warnings.map(runtimeSettingsWarningMessage),
    routes: routeRows(stored, effective, defaults, models), ladders: ladderRows(stored, effective, defaults), translation: translationFields(stored, effective, defaults),
    jobKnobs: jobKnobRows(stored, effective, defaults), budgets: budgetRows(stored, effective, defaults, models, roles, warnings, now),
    assignments: assignmentFields(stored, effective, defaults),
    apply: input.apply ?? null,
    // env 등록부 여부는 관측에서 직접 읽은 것과 적용 확인(WP-B settings-apply.ts RoleSettingsApply.registryEnv, 선택 필드) 중 하나라도 true 면 true
    roles: RUNTIME_SETTINGS_ROLES.map(role => ({ role, label: ROLE_LABELS[role] ?? role,
      registryEnv: roles[role]?.registryEnv === true || (input.apply?.roles.find(entry => entry.role === role) as { registryEnv?: boolean } | undefined)?.registryEnv === true })),
    audit: auditView(input.audit ?? []),
  };
}

async function readAdminObservations(): Promise<AdminObservation[]> {
  const rows = await db.select({ key: operationsObservations.key, value: operationsObservations.value,
    ageSeconds: sql<number>`extract(epoch from ((now() at time zone 'utc') - ${operationsObservations.observedAt}))::double precision` })
    .from(operationsObservations)
    .where(or(like(operationsObservations.key, "service:%"), inArray(operationsObservations.key, [...RUNTIME_SETTINGS_ROLES])));
  return rows.map(row => ({ key: row.key, value: row.value, ageSeconds: Number(row.ageSeconds) }));
}

/** 화면 한 번 그리기 — 행·적용 확인·관측·감사를 함께 읽는다. 행 말고는 덤이다(못 읽어도 화면은 뜬다) */
export async function readRuntimeSettingsAdminView(now = new Date()): Promise<RuntimeSettingsAdminView> {
  let models: readonly ModelDefinition[];
  try { models = readModelRegistry().models; } catch { models = DEFAULT_MODEL_DEFINITIONS; }
  const [row, apply, observations, audit] = await Promise.all([
    readRuntimeSettingsRow().then(value => ({ value, error: null as string | null }), (error: unknown) => ({ value: null, error: error instanceof Error ? error.message : String(error) })),
    readRuntimeSettingsApply().catch(() => null),
    readAdminObservations().catch(() => [] as AdminObservation[]),
    adminLog({ actions: [RUNTIME_SETTINGS_AUDIT_ACTION] }).catch(() => [] as AdminLogRow[]),
  ]);
  return buildRuntimeSettingsAdminView({ row: row.value, rowError: row.error, models, apply, observations, audit, now });
}

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
 * 폼 칸 이름: value:<path>(지금 글자) · initial:<path>(처음 그린 글자) · stored:<path>("1" = 덮어쓴 키) · reset:<path>(기본값으로)
 * · auto:budgets.<job> / initialAuto:budgets.<job>. 바뀐 칸만 patch 에 넣는다. reset 은 덮어쓴 키에만 null 을 넣는다(없는 키의 reset 은 바뀐 것이 없다).
 * patch 는 저장 문서 모양(그룹 키부터)이다: { translation: { product: { batchChars: 6000 } } }.
 */
export function runtimeSettingsPatchFromForm(group: RuntimeSettingGroup, form: FormLike): FormPatch {
  const patch: Record<string, unknown> = {}, changed: string[] = [], issues: string[] = [];
  for (const [name, entry] of form.entries()) {
    if (!name.startsWith("value:")) continue;
    const path = name.slice("value:".length);
    if (!path.startsWith(`${group}.`) || path.split(".").some(part => !part)) { issues.push(`모르는 설정입니다: ${path}`); continue; }
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
      const value = parseFieldInput("ms", raw);
      if (value === undefined || value === null) { issues.push(`${label}: 초 단위 숫자를 넣어주세요`); continue; }
      if (autoBefore || value !== parseFieldInput("ms", initial)) { setLeaf(patch, path, value); changed.push(path); }
      continue;
    }
    const value = parseFieldInput(kind, raw);
    if (value === undefined) { issues.push(kind === "int" ? `${label}: 정수를 넣어주세요` : `${label}: 초 단위 숫자를 넣어주세요`); continue; }
    if (value === null && !path.endsWith(".relayMs")) { issues.push(`${label}: 값이 비었습니다 — 기본값으로 돌리려면 「기본값으로」를 켜주세요`); continue; }
    if (value !== parseFieldInput(kind, initial)) { setLeaf(patch, path, value); changed.push(path); }
  }
  return { patch, changed, issues };
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
  model_role_deadline_order_inverted: "모델 상한이 심사 사다리 순서를 어긋나게 합니다(모델 연결 → 등록부 덮어쓰기에서 확인)",
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
    case "runtime_settings_invalid": return detail in CHOICE_OPTIONS ? `${runtimeSettingLabel(detail)}: 고를 수 있는 값이 아닙니다(${CHOICE_OPTIONS[detail].map(option => option.value).join(" · ")})`
      : `${runtimeSettingLabel(detail)}: 범위를 벗어났습니다`;
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
export const isRuntimeSettingGroup = (value: unknown): value is RuntimeSettingGroup => typeof value === "string" && (RUNTIME_SETTING_GROUPS as readonly string[]).includes(value);

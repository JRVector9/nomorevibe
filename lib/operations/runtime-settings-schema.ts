import { createHash } from "node:crypto";
import { z } from "zod";
import { JOB_NAMES } from "@/lib/jobs/catalog";
import { DEADLINE_LADDER_SKEW_MS, deadlineLadderSchema, type DeadlineLadder } from "@/lib/llm/deadline-policy";
import { DEFAULT_MODEL_DEADLINES, DEFAULT_MODEL_DEFINITIONS, DEFAULT_MODEL_PURPOSE_LIMITS, DEFAULT_MODEL_TIMEOUTS, MODEL_PURPOSE_ENV,
  modelTimeoutMs, type ModelDefinition } from "@/lib/llm/model-registry";

/**
 * 관리자 실시간 한도(runtime_settings, PR 1a)의 순수 계약 — DB·Next 없이 쓴다.
 *
 * - 저장 문서는 sparse 다(운영자가 바꾼 키만). 유효값 = 코드 기본값(DEFAULT_RUNTIME_SETTINGS) 위에 저장 문서를 덮은 것.
 *   코드 기본값은 오늘의 상수와 같다(lib/llm/model-registry.ts 경로 한도, lib/domain/products/translation-policy.ts 번역 묶음,
 *   scripts/worker.ts jobRunOptions 틱 예산). 상수 쪽은 이 모듈의 기본값을 읽어 한 곳에서만 바뀐다.
 * - resolveRuntimeSettings 는 던지지 않는다: 읽을 수 없는 키는 기본값으로 두고 issues 에 적는다. 저장 경로는 issues 가 비어야 저장한다.
 * - 판(version) = storedSettingsVersion(저장 문서). 빈 문서는 "default" — 기본값으로 도는 워커와 빈 행이 같은 판이다.
 * - routes 는 등록부 덮개(setModelRoutePolicyOverlay)로 들어가 modelTimeoutMs/modelLimits 가 그대로 읽는다. MODEL_REGISTRY_CONFIG env 는 그대로 이긴다.
 */

export type PurposeLimit = { maxTokens: number; concurrency: number; timeoutMs?: number };
export type JobKnobs = { batch?: number; batchChars?: number; minCallMs?: number; slowCallMs?: number; soloAttempts?: number; callMs?: number; maxAttempts?: number };
export type JobKnobName = keyof JobKnobs;
export type ProductTranslationPolicy = { maxSourceChars: number; batchChars: number; batchMax: 4; demandLimit: number; maxAttempts: number; jobMarginMs: number };
export type JobBudget = number | "auto";
/**
 * 배정 표 읽기 토글(PR 3b-E): 'on' 이면 단계별 모델 고르기가 배정 표(model_helper_assignments role 'primary' · mode 'live')를 먼저 본다
 * (lib/llm/assignment-flag.ts 가 30초 스냅숏으로 읽는다 — 재배포 없이 저장 즉시). env MODEL_ASSIGNMENT_TABLE 은 비상 강제(1=켬·0=끔)로만 이긴다.
 */
export const ASSIGNMENT_TABLE_READS = ["off", "on"] as const;
export type AssignmentTableReads = (typeof ASSIGNMENT_TABLE_READS)[number];
export type RuntimeSettings = Readonly<{
  routes: { limits: Record<string, PurposeLimit>; timeouts: Record<string, number>; deadlines: Record<string, DeadlineLadder> };
  translation: { product: ProductTranslationPolicy };
  /** 알려진 잡마다 오늘 그 잡이 실제로 읽는 손잡이만 들어 있다(해당 없는 손잡이는 키가 없다). 값은 jobKnob() 으로 읽는다. */
  jobs: Record<string, JobKnobs>;
  /** 적힌 잡만. 없는 잡은 runner 기본 DEFAULT_JOB_BUDGET_MS. "auto" = jobCallCeilingMs + translation.product.jobMarginMs */
  budgets: Record<string, JobBudget>;
  /** 모델 배정 읽기 — 숫자가 아닌 첫 묶음(열거). 기본 'off' = 오늘과 같다(배정 표 SELECT 도 없다). */
  assignments: { tableReads: AssignmentTableReads };
}>;

export const RUNTIME_SETTINGS_VERSION = 1 as const;
/** lib/jobs/runner.ts 의 기본 틱 예산(options.budgetMs ?? 25_000) */
export const DEFAULT_JOB_BUDGET_MS = 25_000;
/** 알린 예산의 상한 — lib/operations/worker-progress.ts DECLARED_BUDGET_MAX_MS 와 같다(1시간) */
export const RUNTIME_BUDGET_MAX_MS = 3_600_000;
/** 호출 상한 ↔ 예산 사이 기록 여유: translations.ts callBudget 가 상한 + 2초를 요구한다 */
export const BUDGET_CALL_MARGIN_MS = 2_000;
/** 이보다 좁은 여유는 저장은 되지만 경고한다 */
export const BUDGET_THIN_MARGIN_MS = 15_000;

export const RUNTIME_SETTING_GROUPS = ["routes", "translation", "jobs", "budgets", "assignments", "devices"] as const;
export type RuntimeSettingGroup = (typeof RUNTIME_SETTING_GROUPS)[number];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}
const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = deepFreeze({
  routes: {
    limits: Object.fromEntries(Object.entries(DEFAULT_MODEL_PURPOSE_LIMITS).map(([route, limit]) => [route, { ...limit }])),
    timeouts: { ...DEFAULT_MODEL_TIMEOUTS },
    deadlines: Object.fromEntries(Object.entries(DEFAULT_MODEL_DEADLINES).map(([route, ladder]) => [route, { ...ladder }])),
  },
  // lib/domain/products/translation-policy.ts PRODUCT_TRANSLATION_* 와 lib/llm/deadline-ladder.ts PRODUCT_TRANSLATION_JOB_MARGIN_MS 의 원천
  translation: { product: { maxSourceChars: 30_000, batchChars: 8_000, batchMax: 4, demandLimit: 80, maxAttempts: 4, jobMarginMs: 15_000 } },
  jobs: {
    // lib/crawl/jobs/translate-reasons.ts BATCH·BATCH_CHARS·MIN_CALL_MS·SOLO_ATTEMPTS
    "reason-translate": { batch: 4, batchChars: 1_600, minCallMs: 30_000, soloAttempts: 3 },
    // lib/crawl/jobs/tagline.ts BATCH·MIN_CALL_MS (동시 호출·호출 상한은 routes.limits/timeouts.crawl-tagline)
    "crawl-tagline": { batch: 12, minCallMs: 15_000 },
    // lib/jobs/products/korean-tagline.ts BATCH·legacy 3,600자·MIN_CALL_MS·SLOW_CALL_MS·SOLO_ATTEMPTS (native 경로의 1,200자는 고정)
    "product-tagline-ko": { batch: 8, batchChars: 3_600, minCallMs: 25_000, slowCallMs: 35_000, soloAttempts: 2 },
    // lib/jobs/products/search-profile.ts BATCH·MIN_CALL_MS. slowCallMs 는 2026-10-31 부터 잡이 읽지 않는다(느린 호출로 틱 접기 삭제) —
    // 저장된 문서·화면과의 호환을 위해 기본값만 남겼다(관리자 정리는 3b-D)
    "product-search-profile": { batch: 12, minCallMs: 15_000, slowCallMs: 20_000 },
    // lib/jobs/products/search-verify.ts BATCH·MIN_CALL_MS
    "product-search-verify": { batch: 16, minCallMs: 20_000 },
    // lib/jobs/products/intro-check.ts CALL_MS(CLI 호출에 직접 주는 상한)·MIN_CALL_MS
    "product-intro-check": { callMs: 90_000, minCallMs: 40_000 },
  },
  // scripts/worker.ts jobRunOptions 의 리터럴. product-translate 만 "auto"(= 호출 상한 300초 + 여유 15초 = 315초).
  // 2026-10-31(PR 3a-C) 합성 잡 분해 — 나뉜 잡은 전 잡의 예산 봉투를 그대로 받는다: held-qwen-retry·split-confirm 110초(human-deepseek-review),
  // split-tiebreak 110초(second-review), audit-qwen·audit-second-opinion 70초(product-audit). 각 단계의 안쪽 상한(budgetSeconds·LANE_MS·STEP_MS)은 그대로다
  budgets: {
    "crawl-agent-review": 110_000, "product-audit": 70_000, "audit-qwen": 70_000, "audit-second-opinion": 70_000, "audit-screen-review": 150_000,
    "product-llm-assist-review": 105_000, "product-llm-assist-audit-review": 105_000, "product-automated-action-audit": 20_000,
    "crawl-publish": 120_000, "reason-translate": 55_000, "product-translate": "auto",
    "product-search-profile": 55_000, "product-search-verify": 110_000, "product-embedding": 50_000, "product-repo-review": 55_000,
    "product-tagline-ko": 55_000, "product-stars-refresh": 40_000, "product-star-observation": 40_000, "ai-level-refresh": 55_000,
    "product-evidence-refresh": 55_000, "product-site-evidence-refresh": 55_000, "agent-evidence-refresh": 55_000,
    "product-intro-check": 110_000, "second-review": 110_000, "split-tiebreak": 110_000, "human-deepseek-review": 110_000,
    "held-qwen-retry": 110_000, "split-confirm": 110_000,
    "product-thumbnail-refresh": 40_000, "bluesky-talk": 40_000, "crawl-seed": 30_000, "crawl-fetch": 120_000,
  },
  // 배정 표 읽기(PR 3b-E) — 기본 꺼짐: 3b-B 배포 상태(설정으로 고른다)와 같다
  assignments: { tableReads: "off" },
});

/**
 * 잡 → 그 틱이 시작하는 가장 긴 호출의 상한을 주는 경로. 예산은 상한 + BUDGET_CALL_MARGIN_MS 이상이어야 한다.
 * orRoutes: 둘 중 긴 쪽(product-audit 은 심사자 종류에 따라 review-gateway 또는 review-cli 상한을 쓴다 — Qwen 직접 감사는 2026-10-31 부터 audit-qwen 잡).
 * knob: 경로가 아니라 jobs.<job>.<knob> 가 상한이다(product-intro-check 의 callMs). extraMs: 호출 앞의 고정 단계(화면 그리기 40초).
 */
export type JobCallRoute = Readonly<{ route: string; extraMs?: number; orRoutes?: readonly string[]; knob?: JobKnobName }>;
export const JOB_CALL_ROUTES: Readonly<Record<string, JobCallRoute>> = deepFreeze({
  "reason-translate": { route: "reason-translate" },
  "crawl-tagline": { route: "crawl-tagline" },
  "product-search-profile": { route: "product-search-profile" },
  "product-search-verify": { route: "product-search-verify" },
  "product-tagline-ko": { route: "product-tagline-ko" },
  "product-translate": { route: "product-translate" },
  "crawl-agent-review": { route: "review-gateway" },
  "second-review": { route: "review-gateway" },
  "split-tiebreak": { route: "split-tiebreak" },
  "product-audit": { route: "review-gateway" },
  "audit-qwen": { route: "product-audit" },
  "audit-second-opinion": { route: "audit-second-opinion" },
  "human-deepseek-review": { route: "human-review" },
  "held-qwen-retry": { route: "held-review-retry" },
  "split-confirm": { route: "split-confirm" },
  "audit-screen-review": { route: "screen-review", extraMs: 40_000 },
  "product-intro-check": { route: "product-intro-check", knob: "callMs" },
});

/** 경로 한도를 받을 수 있는 경로: 코드 기본 한도·상한·사다리·레거시 env 용도·등록부 모델의 purposes. 저장 시에는 덮어쓴 등록부로 넓힌다. */
export function knownRoutes(models: readonly ModelDefinition[] = DEFAULT_MODEL_DEFINITIONS): Set<string> {
  return new Set([...Object.keys(DEFAULT_MODEL_PURPOSE_LIMITS), ...Object.keys(DEFAULT_MODEL_TIMEOUTS), ...Object.keys(DEFAULT_MODEL_DEADLINES),
    ...Object.keys(MODEL_PURPOSE_ENV), ...models.flatMap(model => model.purposes)]);
}
export const KNOWN_ROUTES: readonly string[] = Object.freeze([...knownRoutes()].sort());

// ---------- zod ----------
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const ms = (min: number, max = RUNTIME_BUDGET_MAX_MS) => int(min, max);
/** model-registry.ts purposeLimitSchema 와 같은 상한; 운영자 입력이라 timeoutMs 바닥은 1초 */
export const purposeLimitSchema = z.object({ maxTokens: int(1, 262_144), concurrency: int(1, 64), timeoutMs: ms(1_000).optional() }).strict();
export const routeTimeoutSchema = ms(1_000);
export const translationProductSchema = z.object({
  maxSourceChars: int(1_000, 200_000), batchChars: int(200, 200_000), batchMax: z.literal(4),
  demandLimit: int(1, 1_000), maxAttempts: int(1, 20), jobMarginMs: ms(5_000, 120_000),
}).strict();
export const jobKnobsSchema = z.object({
  batch: int(1, 64), batchChars: int(100, 30_000), minCallMs: ms(1_000, 600_000), slowCallMs: ms(1_000, 600_000),
  soloAttempts: int(1, 10), callMs: ms(5_000, 600_000), maxAttempts: int(1, 50),
}).partial().strict();
export const jobBudgetSchema = z.union([ms(5_000), z.literal("auto")]);
export const JOB_KNOB_NAMES = Object.freeze(Object.keys(jobKnobsSchema.shape) as JobKnobName[]);
/** 모델 배정 읽기 묶음 — 열거 칸만(불리언처럼 쓰되 저장 문서에는 글자로 남아 감사 줄이 "off → on" 으로 읽힌다) */
export const assignmentsSchema = z.object({ tableReads: z.enum(ASSIGNMENT_TABLE_READS) }).strict();

const boundsSchema = z.object({
  version: z.literal(RUNTIME_SETTINGS_VERSION),
  routes: z.object({ limits: z.record(z.string(), purposeLimitSchema), timeouts: z.record(z.string(), routeTimeoutSchema),
    deadlines: z.record(z.string(), deadlineLadderSchema) }).strict(),
  translation: z.object({ product: translationProductSchema }).strict(),
  jobs: z.record(z.string(), jobKnobsSchema),
  budgets: z.record(z.string(), jobBudgetSchema),
  assignments: assignmentsSchema,
}).strict();
/** 유효(병합된) 문서를 검사한다: 범위 + 교차 불변식(코드 기본 등록부 기준). 저장 경로는 resolveRuntimeSettings(…, { models }) 로 덮어쓴 등록부까지 본다. */
export const runtimeSettingsSchema = boundsSchema.superRefine((value, context) => {
  for (const issue of crossCheckIssues(value, DEFAULT_MODEL_DEFINITIONS)) context.addIssue({ code: "custom", message: issue.message, path: issue.path });
});
export type RuntimeSettingsDocument = z.infer<typeof boundsSchema>;

// ---------- 경로 상한 · 예산 ----------
function routePolicyEnv(settings: RuntimeSettings, models: readonly ModelDefinition[]): { MODEL_REGISTRY_CONFIG: string } {
  return { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models, limits: settings.routes.limits, timeouts: settings.routes.timeouts,
    deadlines: settings.routes.deadlines }) };
}
/** 등록부의 modelTimeoutMs 그대로(모델 상한과의 min 포함). 경로를 못 풀면 null. */
function routeTimeoutMs(route: string, env: { MODEL_REGISTRY_CONFIG: string }): number | null {
  try { return modelTimeoutMs(route, env); } catch { return null; }
}
export function jobCallCeilingMs(job: string, settings: RuntimeSettings, models: readonly ModelDefinition[] = DEFAULT_MODEL_DEFINITIONS): number | null {
  const call = JOB_CALL_ROUTES[job];
  if (!call) return null;
  const extra = call.extraMs ?? 0;
  if (call.knob) {
    const value = settings.jobs[job]?.[call.knob];
    return typeof value === "number" ? value + extra : null;
  }
  const env = routePolicyEnv(settings, models);
  const ceilings = [call.route, ...(call.orRoutes ?? [])].map(route => routeTimeoutMs(route, env)).filter((value): value is number => value !== null);
  return ceilings.length ? Math.max(...ceilings) + extra : null;
}
export function effectiveJobBudgetMs(job: string, settings: RuntimeSettings, models: readonly ModelDefinition[] = DEFAULT_MODEL_DEFINITIONS): number {
  const budget = settings.budgets[job];
  if (budget === undefined) return DEFAULT_JOB_BUDGET_MS;
  if (budget !== "auto") return budget;
  const ceiling = jobCallCeilingMs(job, settings, models);
  return ceiling === null ? DEFAULT_JOB_BUDGET_MS : ceiling + settings.translation.product.jobMarginMs;
}
/** 잡이 실제로 읽는 손잡이. 기본값에 없는 손잡이를 읽는 것은 코드 오류다(runtime_settings_knob_missing). */
export function jobKnob(settings: RuntimeSettings, job: string, knob: JobKnobName): number {
  const value = settings.jobs[job]?.[knob] ?? DEFAULT_RUNTIME_SETTINGS.jobs[job]?.[knob];
  if (typeof value !== "number") throw new Error(`runtime_settings_knob_missing:${job}.${knob}`);
  return value;
}

// ---------- 교차 검사 ----------
type CrossIssue = { message: string; path: (string | number)[] };
function crossCheckIssues(value: RuntimeSettingsDocument | RuntimeSettings, models: readonly ModelDefinition[]): CrossIssue[] {
  const issues: CrossIssue[] = [];
  const known = knownRoutes(models);
  const settings: RuntimeSettings = { routes: value.routes, translation: value.translation, jobs: value.jobs, budgets: value.budgets, assignments: value.assignments };
  for (const part of ["limits", "timeouts", "deadlines"] as const)
    for (const route of Object.keys(settings.routes[part])) if (!known.has(route)) issues.push({ message: `unknown_route:${route}`, path: ["routes", part, route] });
  for (const [job, knobs] of Object.entries(settings.jobs)) {
    if (!JOB_NAMES.includes(job)) { issues.push({ message: `unknown_job:${job}`, path: ["jobs", job] }); continue; }
    const base = DEFAULT_RUNTIME_SETTINGS.jobs[job];
    for (const knob of Object.keys(knobs)) if (!base || !(knob in base)) issues.push({ message: `unknown_job_knob:${job}.${knob}`, path: ["jobs", job, knob] });
  }
  for (const job of Object.keys(settings.budgets)) if (!JOB_NAMES.includes(job)) issues.push({ message: `unknown_job:${job}`, path: ["budgets", job] });
  const product = settings.translation.product;
  if (product.batchChars > product.maxSourceChars) issues.push({ message: "batch_exceeds_source_cap", path: ["translation", "product", "batchChars"] });
  // 등록부 전체 검사(기한 사다리 순서·상한↔사다리 불일치·역할 사다리) — 저장 전에 admin-model-registry 와 같은 길로 본다
  try { modelTimeoutMs("review-gateway", routePolicyEnv(settings, models)); } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/^invalid_model_registry:/, "") : "invalid_model_registry";
    for (const item of detail.split(",").filter(Boolean)) {
      const colon = item.lastIndexOf(":");
      const path = colon > 0 ? item.slice(0, colon).split(".") : [], message = colon > 0 ? item.slice(colon + 1) : item;
      issues.push({ message: message === "custom" || !message ? "invalid_model_registry" : message, path: ["routes", ...path] });
    }
  }
  for (const [route, ladder] of Object.entries(settings.routes.deadlines)) {
    const timeout = settings.routes.timeouts[route] ?? settings.routes.limits[route]?.timeoutMs;
    if (timeout !== undefined && timeout < ladder.engineMs + DEADLINE_LADDER_SKEW_MS)
      issues.push({ message: `timeout_below_engine_bound:${route}`, path: ["routes", "timeouts", route] });
  }
  for (const job of Object.keys(JOB_CALL_ROUTES)) {
    const budget = settings.budgets[job];
    const ceiling = jobCallCeilingMs(job, settings, models);
    if (budget === "auto" && ceiling === null) issues.push({ message: `auto_budget_without_route:${job}`, path: ["budgets", job] });
    // runner 기본 예산으로 도는 잡(예산을 적지 않은 crawl-tagline)은 운영자가 정한 값이 아니다 — 경고(runtimeSettingsWarnings)로만 드러낸다
    if (budget === undefined) continue;
    const effective = effectiveJobBudgetMs(job, settings, models);
    if (ceiling !== null && effective < ceiling + BUDGET_CALL_MARGIN_MS) issues.push({ message: `budget_below_call_timeout:${job}`, path: ["budgets", job] });
    const minCall = settings.jobs[job]?.minCallMs;
    if (minCall === undefined) continue;
    if (effective < minCall + 5_000) issues.push({ message: `budget_below_min_call:${job}`, path: ["budgets", job] });
    if (ceiling !== null && minCall > ceiling) issues.push({ message: `min_call_exceeds_timeout:${job}`, path: ["jobs", job, "minCallMs"] });
  }
  return issues;
}
/**
 * 막지 않는 경고: 예산이 호출 상한 + 15초 안쪽이면 틱 끝의 호출이 자주 헛돈다(budget_margin_thin).
 * 예산을 적지 않아 runner 기본(25초)으로 도는 잡의 상한이 그보다 길면 budget_default_below_call_timeout — 오늘 crawl-tagline 이 그렇다(jobRunOptions 에 줄이 없다).
 */
export function runtimeSettingsWarnings(settings: RuntimeSettings, models: readonly ModelDefinition[] = DEFAULT_MODEL_DEFINITIONS): string[] {
  const warnings: string[] = [];
  for (const job of Object.keys(JOB_CALL_ROUTES)) {
    const ceiling = jobCallCeilingMs(job, settings, models);
    if (ceiling === null) continue;
    const effective = effectiveJobBudgetMs(job, settings, models);
    if (settings.budgets[job] === undefined) { if (effective < ceiling + BUDGET_CALL_MARGIN_MS) warnings.push(`budget_default_below_call_timeout:${job}`); continue; }
    if (effective < ceiling + BUDGET_THIN_MARGIN_MS) warnings.push(`budget_margin_thin:${job}`);
  }
  return warnings;
}

// ---------- sparse 문서 → 유효값 ----------
function storedDocument(stored: unknown, issues: string[]): Record<string, unknown> {
  if (stored === null || stored === undefined) return {};
  if (!isPlainObject(stored)) { issues.push("runtime_settings_unreadable"); return {}; }
  if (stored.version !== undefined && stored.version !== RUNTIME_SETTINGS_VERSION) issues.push(`runtime_settings_version:${String(stored.version)}`);
  return stored;
}
function groupOf(doc: Record<string, unknown>, key: string, issues: string[]): Record<string, unknown> {
  const value = doc[key];
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) { issues.push(`runtime_settings_invalid:${key}`); return {}; }
  return value;
}
/** 기본값 위에 저장된 키만 덮는다. null 은 "기본값으로"(없는 것과 같다). */
function overlay(base: Record<string, unknown> | undefined, patch: Record<string, unknown>, keepNull = false): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) if (value !== null || keepNull) merged[key] = value;
  return merged;
}

/**
 * 저장 문서(sparse)를 기본값 위에 덮어 유효값을 만든다. 던지지 않는다.
 * 읽을 수 없는 키·범위 밖 값·모르는 경로/잡은 기본값으로 두고 issues 에 적는다. 교차 불변식 위반은 값은 그대로 두고 issues 에만 적는다
 * (저장은 issues 가 비어야 하므로 코드 기본값이 뒤에 바뀐 경우에만 나타난다).
 */
export function resolveRuntimeSettings(stored: unknown, options: { models?: readonly ModelDefinition[] } = {}): { settings: RuntimeSettings; issues: string[] } {
  const models = options.models ?? DEFAULT_MODEL_DEFINITIONS;
  const issues: string[] = [];
  const doc = storedDocument(stored, issues);
  for (const key of Object.keys(doc)) if (key !== "version" && !(RUNTIME_SETTING_GROUPS as readonly string[]).includes(key)) issues.push(`unknown_group:${key}`);
  const known = knownRoutes(models);
  const defaults = DEFAULT_RUNTIME_SETTINGS;

  const routes: RuntimeSettings["routes"] = { limits: { ...defaults.routes.limits }, timeouts: { ...defaults.routes.timeouts }, deadlines: { ...defaults.routes.deadlines } };
  const storedRoutes = groupOf(doc, "routes", issues);
  for (const key of Object.keys(storedRoutes)) if (!["limits", "timeouts", "deadlines"].includes(key)) issues.push(`unknown_setting:routes.${key}`);
  for (const [route, value] of Object.entries(groupOf(storedRoutes, "limits", issues))) {
    if (value === null) continue;
    if (!known.has(route)) { issues.push(`unknown_route:${route}`); continue; }
    const parsed = purposeLimitSchema.safeParse(isPlainObject(value) ? overlay(routes.limits[route], value) : value);
    if (parsed.success) routes.limits[route] = parsed.data; else issues.push(`runtime_settings_invalid:routes.limits.${route}`);
  }
  for (const [route, value] of Object.entries(groupOf(storedRoutes, "timeouts", issues))) {
    if (value === null) continue;
    if (!known.has(route)) { issues.push(`unknown_route:${route}`); continue; }
    const parsed = routeTimeoutSchema.safeParse(value);
    if (parsed.success) routes.timeouts[route] = parsed.data; else issues.push(`runtime_settings_invalid:routes.timeouts.${route}`);
  }
  for (const [route, value] of Object.entries(groupOf(storedRoutes, "deadlines", issues))) {
    if (value === null) continue;
    if (!known.has(route)) { issues.push(`unknown_route:${route}`); continue; }
    // relayMs: null 은 "중계 층 없음"이라는 값이므로 사다리에서는 null 을 남긴다
    const parsed = deadlineLadderSchema.safeParse(isPlainObject(value) ? overlay(routes.deadlines[route], value, true) : value);
    if (parsed.success) routes.deadlines[route] = parsed.data; else issues.push(`runtime_settings_invalid:routes.deadlines.${route}`);
  }

  const product: Record<string, unknown> = { ...defaults.translation.product };
  const storedTranslation = groupOf(doc, "translation", issues);
  for (const key of Object.keys(storedTranslation)) if (key !== "product") issues.push(`unknown_setting:translation.${key}`);
  for (const [key, value] of Object.entries(groupOf(storedTranslation, "product", issues))) {
    if (value === null) continue;
    const field = translationProductSchema.shape[key as keyof typeof translationProductSchema.shape];
    if (!field) { issues.push(`unknown_setting:translation.product.${key}`); continue; }
    const parsed = field.safeParse(value);
    if (parsed.success) product[key] = parsed.data; else issues.push(`runtime_settings_invalid:translation.product.${key}`);
  }

  const jobs: Record<string, JobKnobs> = Object.fromEntries(Object.entries(defaults.jobs).map(([job, knobs]) => [job, { ...knobs }]));
  for (const [job, value] of Object.entries(groupOf(doc, "jobs", issues))) {
    if (value === null) continue;
    if (!JOB_NAMES.includes(job)) { issues.push(`unknown_job:${job}`); continue; }
    if (!isPlainObject(value)) { issues.push(`runtime_settings_invalid:jobs.${job}`); continue; }
    const base = jobs[job];
    for (const [knob, knobValue] of Object.entries(value)) {
      if (knobValue === null) continue;
      const field = jobKnobsSchema.shape[knob as JobKnobName];
      if (!base || !field || !(knob in base)) { issues.push(`unknown_job_knob:${job}.${knob}`); continue; }
      const parsed = field.safeParse(knobValue);
      if (parsed.success) base[knob as JobKnobName] = parsed.data; else issues.push(`runtime_settings_invalid:jobs.${job}.${knob}`);
    }
  }

  const budgets: Record<string, JobBudget> = { ...defaults.budgets };
  for (const [job, value] of Object.entries(groupOf(doc, "budgets", issues))) {
    if (value === null) continue;
    if (!JOB_NAMES.includes(job)) { issues.push(`unknown_job:${job}`); continue; }
    const parsed = jobBudgetSchema.safeParse(value);
    if (parsed.success) budgets[job] = parsed.data; else issues.push(`runtime_settings_invalid:budgets.${job}`);
  }

  const assignments: RuntimeSettings["assignments"] = { ...defaults.assignments };
  for (const [key, value] of Object.entries(groupOf(doc, "assignments", issues))) {
    if (value === null) continue;
    const field = assignmentsSchema.shape[key as keyof typeof assignmentsSchema.shape];
    if (!field) { issues.push(`unknown_setting:assignments.${key}`); continue; }
    const parsed = field.safeParse(value);
    if (parsed.success) assignments[key as keyof typeof assignmentsSchema.shape] = parsed.data; else issues.push(`runtime_settings_invalid:assignments.${key}`);
  }

  const settings: RuntimeSettings = { routes, translation: { product: product as ProductTranslationPolicy }, jobs, budgets, assignments };
  const bounds = boundsSchema.safeParse({ version: RUNTIME_SETTINGS_VERSION, ...settings });
  if (!bounds.success) for (const issue of bounds.error.issues)
    issues.push(issue.code === "custom" ? issue.message : `runtime_settings_invalid:${issue.path.map(String).join(".")}`);
  for (const issue of crossCheckIssues(settings, models)) issues.push(issue.message);
  return { settings: deepFreeze(settings), issues: [...new Set(issues)] };
}

// ---------- 판 ----------
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const inner = canonical(value[key]);
    if (inner === null || inner === undefined) continue;
    if (isPlainObject(inner) && !Object.keys(inner).length) continue;
    out[key] = inner;
  }
  return out;
}
/**
 * 저장 문서(sparse)의 판 — 키 순서·null·빈 객체·version 표시에 무관하게 같은 내용이면 같은 판. 빈 문서는 "default".
 * 워커 heartbeat 와 관리자 화면이 이 값으로 "읽은 판"을 견준다(lib/crawl/settings-version.ts 와 같은 길이 16자리).
 */
export function storedSettingsVersion(values: unknown): string {
  const doc = isPlainObject(values) ? canonical({ ...values, version: undefined }) as Record<string, unknown> : {};
  if (!Object.keys(doc).length) return "default";
  return createHash("sha256").update(JSON.stringify(doc)).digest("hex").slice(0, 16);
}
/** 화면에 보일 짧은 판 이름 — "default" 는 그대로, 해시는 "v3f9a2c" */
export const shortRuntimeSettingsVersion = (version: string) => version === "default" ? version : `v${version.slice(0, 6)}`;

// ---------- 한국어 이름표 ----------
export const ROUTE_LABELS: Readonly<Record<string, string>> = {
  "gateway-review": "게이트웨이 심사", "review-cli": "CLI 심사", relay: "중계(relay)", "human-review": "사람 큐 심사", "product-intro-check": "소개 검수",
  "classify-claude": "분류(Claude)", "product-search-profile": "검색 키워드", "product-search-verify": "키워드 검수", "crawl-tagline": "소개 생성",
  "reason-translate": "사유 번역", "product-tagline-ko": "한국어 소개", "product-translate": "공개 번역", "search-query-translate": "검색어 번역",
  "direct-review": "직접 연결 심사", "audit-second-opinion": "감사 2차 의견", "held-review-retry": "보류 심사 재시도", "split-tiebreak": "갈림 판정",
  "split-confirm": "갈림 확인", "product-audit": "제품 감사", "grok-review": "Grok 심사", "grok-session": "Grok 세션", "classify-cli": "분류(CLI)",
  "screen-review": "화면 판별", "review-gateway": "AI 심사 게이트웨이", "ai1-preset": "AI1 심사", "ai2-direct": "AI2 직접 연결", "ai2-cli": "AI2 CLI",
  "ai2-grok": "AI2 Grok", "assist-primary": "LLM 보조(1차)", "assist-audit": "LLM 보조 감사", "assist-legacy-family": "LLM 보조(레거시)",
  "korean-translation-direct": "한국어 번역 직접 연결", "classify-primary": "분류(1차)", "classify-fallback": "분류(예비)", "first-review": "1차 심사",
};
export const JOB_LABELS: Readonly<Record<string, string>> = {
  "reason-translate": "사유 번역", "crawl-tagline": "소개 생성", "product-tagline-ko": "한국어 소개", "product-search-profile": "검색 키워드",
  "product-search-verify": "키워드 검수", "product-intro-check": "소개 검수", "product-translate": "공개 번역", "crawl-agent-review": "AI1 심사",
  "product-audit": "제품 감사", "audit-screen-review": "화면 판별", "product-llm-assist-review": "LLM 보조 심사", "product-llm-assist-audit-review": "LLM 보조 감사",
  "product-automated-action-audit": "자동 조치 감사", "crawl-publish": "발행", "product-embedding": "임베딩", "product-repo-review": "저장소 검토",
  "product-stars-refresh": "스타 갱신", "product-star-observation": "스타 관측", "ai-level-refresh": "AI 제작 근거", "product-evidence-refresh": "제품 근거 갱신",
  "product-site-evidence-refresh": "사이트 근거 갱신", "agent-evidence-refresh": "에이전트 근거 갱신", "second-review": "2차 심사",
  "split-tiebreak": "2차 갈림 판가름", "human-deepseek-review": "사람 큐 DeepSeek 심사", "held-qwen-retry": "보류 Qwen 재심사", "split-confirm": "갈림 DeepSeek 확인",
  "audit-qwen": "Qwen 직접 감사", "audit-second-opinion": "감사 두 번째 의견",
  "product-thumbnail-refresh": "썸네일 갱신", "bluesky-talk": "Bluesky 화제", "crawl-seed": "검색 수집",
  "crawl-fetch": "원본 확보",
};
const LIMIT_FIELD_LABELS: Record<keyof PurposeLimit, string> = { maxTokens: "출력 토큰 상한", concurrency: "동시 호출", timeoutMs: "호출 상한(ms)" };
const LADDER_FIELD_LABELS: Record<keyof DeadlineLadder, string> = { engineMs: "엔진 기한(ms)", relayMs: "중계 기한(ms)", gatewayMs: "게이트웨이 기한(ms)", clientMs: "클라이언트 기한(ms)" };
const TRANSLATION_FIELD_LABELS: Record<keyof ProductTranslationPolicy, string> = { maxSourceChars: "원문 글자 상한", batchChars: "묶음 글자 임계", batchMax: "묶음 최대 건수",
  demandLimit: "요청 보류 한도", maxAttempts: "최대 시도", jobMarginMs: "틱 여유(ms)" };
const KNOB_LABELS: Record<JobKnobName, string> = { batch: "묶음", batchChars: "묶음 글자", minCallMs: "최소 남은 시간(ms)", slowCallMs: "느린 호출(ms)",
  soloAttempts: "혼자 보내는 실패 수", callMs: "호출 상한(ms)", maxAttempts: "최대 시도" };
export const GROUP_LABELS: Readonly<Record<RuntimeSettingGroup, string>> = { routes: "경로 한도", translation: "번역·묶음", jobs: "잡별 묶음", budgets: "틱 예산",
  assignments: "모델 배정 읽기", devices: "장비 한도" };
/** 열거 칸의 값 이름 — 폼의 선택지와 감사 줄이 같은 말을 쓴다 */
export const ASSIGNMENT_TABLE_READS_LABELS: Readonly<Record<AssignmentTableReads, string>> = { off: "끔 — 설정(legacy)으로 고른다", on: "켬 — 배정 표(live 행)로 고른다" };

const routeLabel = (route: string) => ROUTE_LABELS[route] ?? route;
const jobLabel = (job: string) => JOB_LABELS[job] ?? job;
/** 모든 키의 한국어 이름 — 감사 기록의 changes 문자열과 폼이 같은 말을 쓴다. 모르는 경로/잡은 runtimeSettingLabel 이 즉석에서 만든다. */
export const RUNTIME_SETTING_LABELS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ...KNOWN_ROUTES.flatMap(route => [
    ...Object.entries(LIMIT_FIELD_LABELS).map(([field, label]) => [`routes.limits.${route}.${field}`, `${routeLabel(route)} ${label}`]),
    [`routes.timeouts.${route}`, `${routeLabel(route)} 호출 상한(ms)`],
    ...Object.entries(LADDER_FIELD_LABELS).map(([field, label]) => [`routes.deadlines.${route}.${field}`, `${routeLabel(route)} ${label}`]),
  ]),
  ...Object.entries(TRANSLATION_FIELD_LABELS).map(([field, label]) => [`translation.product.${field}`, `공개 번역 ${label}`]),
  ...JOB_NAMES.flatMap(job => [
    ...JOB_KNOB_NAMES.map(knob => [`jobs.${job}.${knob}`, `${jobLabel(job)} ${KNOB_LABELS[knob]}`]),
    [`budgets.${job}`, `${jobLabel(job)} 틱 예산(ms)`],
  ]),
  ["assignments.tableReads", "배정 표 읽기"],
]));
export function runtimeSettingLabel(path: string): string {
  const known = RUNTIME_SETTING_LABELS[path];
  if (known) return known;
  const [group, ...rest] = path.split(".");
  if (group === "routes" && rest.length >= 2) {
    const [part, route, field] = rest;
    if (part === "limits" && field && field in LIMIT_FIELD_LABELS) return `${routeLabel(route)} ${LIMIT_FIELD_LABELS[field as keyof PurposeLimit]}`;
    if (part === "timeouts") return `${routeLabel(route)} 호출 상한(ms)`;
    if (part === "deadlines" && field && field in LADDER_FIELD_LABELS) return `${routeLabel(route)} ${LADDER_FIELD_LABELS[field as keyof DeadlineLadder]}`;
  }
  if (group === "jobs" && rest.length === 2 && rest[1] in KNOB_LABELS) return `${jobLabel(rest[0])} ${KNOB_LABELS[rest[1] as JobKnobName]}`;
  if (group === "budgets" && rest.length === 1) return `${jobLabel(rest[0])} 틱 예산(ms)`;
  return path;
}

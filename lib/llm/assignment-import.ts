import type { z } from "zod";
import { legacyFirstReviewers } from "@/lib/crawl/first-reviewers";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { ADMIN_MODEL_STAGES } from "./admin-model-stages";
import type { ModelCapacityPolicy } from "./capacity";
import { ASSIGNMENT_CLI_EQUIPMENT, ASSIGNMENT_STAGES, ASSIGNMENT_TRANSPORTS, assignmentRouteProvider, assignmentWireModel, modelAssignmentInputSchema,
  registryKeyEquipment, type AssignmentStage, type AssignmentTransport, type HelperMode, type ModelAssignmentRow } from "./capacity-helpers";
import type { ModelDefinition, ModelRegistry } from "./model-registry";
import { ADMIN_STAGE_ASSIGNMENTS } from "./stage-assignments";

/**
 * 배정 표 가져오기 계획(PR 3b-B, 순수 — DB·네트워크·스냅숏 없음). 오늘 예전 설정이 고르는 모델을 배정 표 행으로 옮기는 `saveModelAssignment`
 * 입력 목록과, 지금 표와의 차이(create·update·unchanged)를 만든다. 화면·적용은 3b-D 가 한다(이 함수는 아무것도 쓰지 않는다).
 * 두 층: `buildAssignmentImportPlan(settings, policy, registry, options)` = 자세한 계획(경고 코드·바뀐 칸 이름·지금 행),
 * `planAssignmentImport(sources)` = 3b-D 화면 계약(`AssignmentImportPlan` — 행의 출처·입력·사람이 읽는 바뀐 칸, 경고 문장)으로 옮긴 것.
 *
 * 옮기는 것과 rank:
 * - ai1: 오늘 1차 풀(`legacyFirstReviewers` — firstReview(없으면 호출자가 준 env 대체)·firstReviewAdditional, 최대 3·같은 가중치 한 번) → 모두 rank 1.
 *   assignment_id 의 두 자리 순번이 풀 순서다(rank 1 안에서는 assignment_id 순으로 돈다 — 오늘 `(id − 1) mod n` 칸과 같다).
 * - ai2: voters → rank 1 · vote, fallbacks[i] → rank 2 + i(오늘 순서대로 먼저 고른다).
 * - stageModelPools: 대응하는 관리자 단계(ADMIN_STAGE_ASSIGNMENTS)의 key → 그 단계 rank 1(풀 순서).
 * 장비(device_id) = 정책 route `(단계 route, provider, wire 모델)` 의 groupId. 그런 route 가 없으면 `mode off` + 경고(`route_missing`) — 장비는 등록부
 * equipment 로 둔다. off 행도 저장하면 계약 확인·route 덧붙이기·장비 순위를 한다(쓰지 않을 뿐) — 적용 쪽이 고른다.
 * 등록부에서 찾지 못한 모델, 단계가 받지 않는 전송, 입력 검증을 지나지 못한 조합은 입력 없이 경고만 남긴다.
 */
export type AssignmentImportSettings = Pick<CrawlSettings, "firstReview" | "firstReviewAdditional" | "secondReview" | "stageModelPools">;
export type AssignmentImportOptions = Readonly<{
  /** 지금 배정 표 행(role 'primary') — 차이를 만든다. 기본 []. */
  existing?: readonly ModelAssignmentRow[];
  /** firstReview 가 없을 때 대신 옮길 1차 심사자(호출자가 정한다 — 코드의 env 대체는 2026-10-31 abcLLM 정리 때 지웠다). 순수 함수라 env 를 읽지 않는다. */
  firstReviewFallback?: { provider: "claude-cli" | "abcllm" | "grok-cli"; model: string } | null;
  /** 장비 행(관리자 화면이 모은다). 주면 켜진 장비가 아닌 곳의 만들기·실전 고치기를 건너뛰고 `device_unconfigured` 로 알린다(저장이 거절할 행). */
  devices?: readonly Readonly<{ deviceId: string; enabled: boolean }>[];
}>;
export type AssignmentImportDraft = Readonly<{
  assignmentId: string; expectedVersion: number | null; stage: AssignmentStage; deviceId: string; registryKey: string; transport: AssignmentTransport;
  rank: number; role: "primary"; vote: boolean; mode: "off" | "live"; maxSlots: number; note: string | null;
}>;
export const ASSIGNMENT_IMPORT_WARNINGS = Object.freeze(["registry_unmatched", "registry_ambiguous", "transport_unsupported", "route_missing",
  "duplicate", "input_invalid", "stage_unmapped", "first_review_from_env", "first_review_unset", "device_unconfigured"] as const);
export type AssignmentImportWarningCode = (typeof ASSIGNMENT_IMPORT_WARNINGS)[number];
export type AssignmentImportWarning = Readonly<{ source: string; code: AssignmentImportWarningCode; detail: string }>;
export type AssignmentImportEntry = Readonly<{
  action: AssignmentImportAction; source: string; input: AssignmentImportDraft;
  /** 같은 (단계, 장비, wire 모델)의 지금 행 — 표의 유일 키 */
  current: ModelAssignmentRow | null;
  /** update 일 때 바뀌는 칸(registryKey·transport·rank·vote·mode) */
  changes: readonly (typeof FIELDS)[number][];
}>;
export type AssignmentImportDetail = Readonly<{ entries: readonly AssignmentImportEntry[]; warnings: readonly AssignmentImportWarning[];
  counts: Readonly<{ create: number; update: number; unchanged: number; skipped: number }> }>;

type Reviewer = { provider: string; model: string };
type Resolved = { entry: ModelDefinition; transport: AssignmentTransport; wire: string; provider: string };
const slug = (key: string) => key.replace(":", "-");

/**
 * 전송 후보: 단계가 받는 전송 중 등록부 provider 가 맞고(cli 는 connect 장비만) — ASSIGNMENT_TRANSPORTS 순서(gateway → direct → local-direct → cli).
 * 게이트웨이 표지(gatewayLabel)가 없는 abcllm 행은 direct 만이다 — 엔진 연결이 표지를 지운 직접 연결 모델이고, gateway·direct 의 wire 이름이 같아 가를 수 없다.
 */
function transportsFor(stage: AssignmentStage, entry: ModelDefinition): AssignmentTransport[] {
  return ASSIGNMENT_TRANSPORTS.filter(transport => ASSIGNMENT_STAGES[stage].transports.has(transport)
    && assignmentRouteProvider(transport, entry.provider) !== null && (transport !== "cli" || entry.equipment === ASSIGNMENT_CLI_EQUIPMENT)
    && !(transport === "gateway" && entry.provider === "abcllm" && !entry.gatewayLabel));
}
const resolution = (entry: ModelDefinition, transport: AssignmentTransport): Resolved =>
  ({ entry, transport, wire: assignmentWireModel(transport, entry), provider: assignmentRouteProvider(transport, entry.provider)! });
const routeFor = (policy: ModelCapacityPolicy | null, stage: AssignmentStage, value: Pick<Resolved, "provider" | "wire">) =>
  policy?.routes.find(route => route.routeId === ASSIGNMENT_STAGES[stage].routeId && route.provider === value.provider && route.model === value.wire) ?? null;

/** 설정의 (provider, wire 모델) → 등록부 행과 전송. 여럿이면 정책 route 가 있는 것 하나만 받는다. */
function resolveReviewer(stage: AssignmentStage, reviewer: Reviewer, registry: Pick<ModelRegistry, "models">, policy: ModelCapacityPolicy | null):
  { ok: true; value: Resolved } | { ok: false; code: AssignmentImportWarningCode; detail: string } {
  const matches = registry.models.flatMap(entry => transportsFor(stage, entry).map(transport => resolution(entry, transport)))
    .filter(value => value.provider === reviewer.provider && value.wire === reviewer.model);
  if (!matches.length) return { ok: false, code: "registry_unmatched", detail: `${reviewer.provider} ${reviewer.model}` };
  if (matches.length === 1) return { ok: true, value: matches[0] };
  const routed = matches.filter(value => routeFor(policy, stage, value));
  if (routed.length === 1) return { ok: true, value: routed[0] };
  return { ok: false, code: "registry_ambiguous", detail: `${reviewer.provider} ${reviewer.model}: ${matches.map(value => `${value.entry.key}/${value.transport}`).join(", ")}` };
}

/** 단계 풀의 등록부 key → 전송. 정책 route 가 있는 전송을 먼저, 없으면 첫 후보(route_missing 은 부르는 쪽이 붙인다). */
function resolveKey(stage: AssignmentStage, key: string, registry: Pick<ModelRegistry, "models">, policy: ModelCapacityPolicy | null):
  { ok: true; value: Resolved } | { ok: false; code: AssignmentImportWarningCode; detail: string } {
  const entry = registry.models.find(model => model.key === key);
  if (!entry) return { ok: false, code: "registry_unmatched", detail: key };
  const options = transportsFor(stage, entry).map(transport => resolution(entry, transport));
  if (!options.length) return { ok: false, code: "transport_unsupported", detail: `${key} (${entry.provider}) → ${stage}` };
  return { ok: true, value: options.find(value => routeFor(policy, stage, value)) ?? options[0] };
}

const FIELDS = ["registryKey", "transport", "rank", "vote", "mode"] as const;

export function buildAssignmentImportPlan(settings: AssignmentImportSettings, policy: ModelCapacityPolicy | null, registry: Pick<ModelRegistry, "models">,
  options: AssignmentImportOptions = {}): AssignmentImportDetail {
  const existing = options.existing ?? [];
  const warnings: AssignmentImportWarning[] = [];
  const planned: { source: string; stage: AssignmentStage; value: Resolved; rank: number; vote: boolean; order: number }[] = [];
  const warn = (source: string, code: AssignmentImportWarningCode, detail: string) => warnings.push(Object.freeze({ source, code, detail }));
  const addReviewer = (source: string, stage: AssignmentStage, reviewer: Reviewer, rank: number, vote: boolean, order: number) => {
    const resolved = resolveReviewer(stage, reviewer, registry, policy);
    if (!resolved.ok) return warn(source, resolved.code, resolved.detail);
    planned.push({ source, stage, value: resolved.value, rank, vote, order });
  };

  if (!settings.firstReview && options.firstReviewFallback) warn("firstReview", "first_review_from_env", options.firstReviewFallback.model);
  if (!settings.firstReview && !options.firstReviewFallback) warn("firstReview", "first_review_unset", "관리자 설정에서 1차 심사자를 고른 뒤 다시 가져온다(환경변수 대체는 2026-10-31 제거)");
  legacyFirstReviewers(settings, options.firstReviewFallback ?? null).forEach((reviewer, index) =>
    addReviewer(index === 0 ? "firstReview" : `firstReviewAdditional[${index - 1}]`, "ai1", reviewer, 1, false, index + 1));
  settings.secondReview.voters.forEach((voter, index) => addReviewer(`secondReview.voters[${index}]`, "ai2", voter, 1, true, index + 1));
  (settings.secondReview.fallbacks ?? []).forEach((voter, index) =>
    addReviewer(`secondReview.fallbacks[${index}]`, "ai2", voter, 2 + index, false, index + 1));
  for (const stage of ADMIN_MODEL_STAGES) {
    const keys = settings.stageModelPools?.[stage.id] ?? [];
    const target = ADMIN_STAGE_ASSIGNMENTS[stage.id];
    if (keys.length && !target) { warn(`stageModelPools.${stage.id}`, "stage_unmapped", keys.join(", ")); continue; }
    keys.forEach((key, index) => {
      const resolved = resolveKey(target!, key, registry, policy);
      if (!resolved.ok) return warn(`stageModelPools.${stage.id}[${index}]`, resolved.code, resolved.detail);
      planned.push({ source: `stageModelPools.${stage.id}[${index}]`, stage: target!, value: resolved.value, rank: 1, vote: false, order: index + 1 });
    });
  }

  const entries: AssignmentImportEntry[] = [];
  const seen = new Map<string, string>();
  for (const item of planned) {
    const route = routeFor(policy, item.stage, item.value);
    const deviceId = route?.groupId ?? registryKeyEquipment(item.value.entry.key);
    // 표의 유일 키는 (단계, 장비, wire 모델); 2차는 같은 모델(canonical)을 두 번 세우지 않는다
    const identity = JSON.stringify([item.stage, deviceId, item.value.wire]);
    const modelIdentity = item.stage === "ai2" ? JSON.stringify([item.stage, canonicalReviewModel(item.value.wire)]) : identity;
    const first = seen.get(identity) ?? seen.get(modelIdentity);
    if (first) { warn(item.source, "duplicate", `${item.value.wire} — ${first}`); continue; }
    seen.set(identity, item.source); seen.set(modelIdentity, item.source);
    if (!route) warn(item.source, "route_missing", `${ASSIGNMENT_STAGES[item.stage].routeId} / ${item.value.provider} / ${item.value.wire}`);
    const current = existing.find(row => row.role === "primary" && row.stage === item.stage && row.deviceId === deviceId && row.model === item.value.wire) ?? null;
    const input: AssignmentImportDraft = Object.freeze({
      assignmentId: current?.assignmentId ?? `${item.stage}:${String(item.order).padStart(2, "0")}:${slug(item.value.entry.key)}`.slice(0, 120),
      expectedVersion: current?.version ?? null, stage: item.stage, deviceId, registryKey: item.value.entry.key, transport: item.value.transport,
      rank: item.rank, role: "primary", vote: item.vote, mode: route ? "live" : "off", maxSlots: current?.maxSlots ?? 1,
      note: current?.note ?? `가져옴: ${item.source}`.slice(0, 400) });
    const parsed = modelAssignmentInputSchema.safeParse(input);
    if (!parsed.success) { warn(item.source, "input_invalid", parsed.error.issues.map(issue => `${issue.path.join(".")}:${issue.message}`).join(", ")); continue; }
    const changes = current ? FIELDS.filter(field => current[field] !== input[field]) : [];
    const writesLive = !current || changes.length > 0 && input.mode === "live";
    if (options.devices && writesLive && !options.devices.some(device => device.deviceId === deviceId && device.enabled)) {
      warn(item.source, "device_unconfigured", deviceId); continue;
    }
    entries.push(Object.freeze({ action: !current ? "create" : changes.length ? "update" : "unchanged", source: item.source, input, current,
      changes: Object.freeze(changes) }));
  }
  const count = (action: AssignmentImportEntry["action"]) => entries.filter(entry => entry.action === action).length;
  return Object.freeze({ entries: Object.freeze(entries), warnings: Object.freeze(warnings),
    counts: Object.freeze({ create: count("create"), update: count("update"), unchanged: count("unchanged"),
      skipped: warnings.filter(warning => !["route_missing", "first_review_from_env", "first_review_unset"].includes(warning.code)).length }) });
}

// ── 3b-D 화면 계약(/admin/models/assignments 「현재 설정 → 배정 표 가져오기」) ──────────────────────────────────

/** saveModelAssignment 의 입력(zod 입력형). update 는 expectedVersion = 지금 행의 판, create 는 null. */
export type AssignmentImportInput = z.input<typeof modelAssignmentInputSchema>;
export type AssignmentImportAction = "create" | "update" | "unchanged";
export type AssignmentImportRow = Readonly<{
  action: AssignmentImportAction;
  input: AssignmentImportInput;
  /** 설정의 어디서 왔나(예: "firstReview", "secondReview.voters[0]", "stageModelPools.reason-translate[1]") — 화면에 그대로 보인다 */
  origin: string;
  /** 사람이 읽는 바뀐 칸(update 만, 예: "순위 2 → 1") */
  changes?: readonly string[];
}>;
export type AssignmentImportPlan = Readonly<{ rows: readonly AssignmentImportRow[]; warnings: readonly string[] }>;
/** 계획이 읽는 것(화면이 모아서 넘긴다 — lib/operations/admin-model-assignments.ts readAssignmentImportSources). */
export type AssignmentImportSources = Readonly<{
  settings: CrawlSettings;
  registry: ModelRegistry;
  policy: ModelCapacityPolicy | null;
  devices: readonly Readonly<{ deviceId: string; enabled: boolean; roles: readonly Readonly<{ routeId: string; rank: number }>[] }>[];
  assignments: readonly ModelAssignmentRow[];
}>;

const FIELD_LABELS: Readonly<Record<(typeof FIELDS)[number], string>> = { registryKey: "모델", transport: "전송", rank: "순위", vote: "표", mode: "모드" };
const TRANSPORT_LABELS: Readonly<Record<AssignmentTransport, string>> = { gateway: "게이트웨이", direct: "엔진 직접", "local-direct": "로컬 직접", cli: "CLI" };
const MODE_LABELS: Readonly<Record<HelperMode, string>> = { off: "꺼짐", shadow: "섀도", live: "실전" };
function fieldValue(field: (typeof FIELDS)[number], value: unknown): string {
  if (field === "transport") return TRANSPORT_LABELS[value as AssignmentTransport] ?? String(value);
  if (field === "mode") return MODE_LABELS[value as HelperMode] ?? String(value);
  if (field === "vote") return value ? "투표" : "투표 아님";
  return String(value);
}
/** 경고 코드 → 화면 문장(출처: 문장 — 자세히). */
export const ASSIGNMENT_IMPORT_WARNING_TEXT: Readonly<Record<AssignmentImportWarningCode, string>> = {
  registry_unmatched: "등록부에서 이 모델을 찾지 못해 옮기지 않습니다",
  registry_ambiguous: "등록부의 여러 항목·전송이 같은 이름이라 고를 수 없어 옮기지 않습니다",
  transport_unsupported: "이 단계가 받는 전송으로 부를 수 없는 모델이라 옮기지 않습니다",
  route_missing: "정책에 이 경로가 없어 꺼짐으로 옮깁니다(저장하면 계약을 확인하고 경로를 덧붙입니다)",
  duplicate: "같은 행이 이미 계획에 있어 한 번만 옮깁니다",
  input_invalid: "저장 입력 검사를 지나지 못해 옮기지 않습니다",
  stage_unmapped: "배정 표에 대응하는 단계가 없는 단계 풀이라 옮기지 않습니다(저장 풀 그대로 씁니다)",
  first_review_from_env: "1차 모델이 설정에 없어 env 대체를 옮깁니다",
  first_review_unset: "1차 모델이 설정에 없어 1차는 옮기지 않습니다",
  device_unconfigured: "장비 행이 없거나 꺼져 있어 옮기지 않습니다(장비 한도에서 먼저 저장)",
};

/**
 * 3b-D 화면이 부르는 계획: 화면이 모은 sources 를 buildAssignmentImportPlan 에 넘기고(지금 배정 표 = existing, 장비 = devices — 켜진 장비가 아니면 건너뜀),
 * 행은 { action, input(saveModelAssignment 입력 그대로), origin(설정의 출처), changes(「순위 2 → 1」) }, 경고는 「출처: 문장 — 자세히」 글로 바꾼다.
 * env 대체 1차 심사자는 화면이 알 수 없어 넘기지 않는다(first_review_unset).
 */
export function planAssignmentImport(sources: AssignmentImportSources): AssignmentImportPlan {
  const detail = buildAssignmentImportPlan(sources.settings, sources.policy, sources.registry,
    { existing: sources.assignments, devices: sources.devices });
  const rows: AssignmentImportRow[] = detail.entries.map(entry => Object.freeze({ action: entry.action, input: { ...entry.input }, origin: entry.source,
    changes: Object.freeze(entry.changes.map(field => `${FIELD_LABELS[field as (typeof FIELDS)[number]]} `
      + `${fieldValue(field as (typeof FIELDS)[number], entry.current?.[field as (typeof FIELDS)[number]])} → ${fieldValue(field as (typeof FIELDS)[number], entry.input[field as (typeof FIELDS)[number]])}`)) }));
  const warnings = detail.warnings.map(warning => `${warning.source}: ${ASSIGNMENT_IMPORT_WARNING_TEXT[warning.code]} — ${warning.detail}`);
  return Object.freeze({ rows: Object.freeze(rows), warnings: Object.freeze(warnings) });
}

import { legacyFirstReviewers } from "@/lib/crawl/first-reviewers";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { ADMIN_MODEL_STAGES } from "./admin-model-stages";
import type { ModelCapacityPolicy } from "./capacity";
import { ASSIGNMENT_CLI_EQUIPMENT, ASSIGNMENT_STAGES, ASSIGNMENT_TRANSPORTS, assignmentRouteProvider, assignmentWireModel, modelAssignmentInputSchema,
  registryKeyEquipment, type AssignmentStage, type AssignmentTransport, type ModelAssignmentRow } from "./capacity-helpers";
import type { ModelDefinition, ModelRegistry } from "./model-registry";
import { ADMIN_STAGE_ASSIGNMENTS } from "./stage-assignments";

/**
 * 배정 표 가져오기 계획(PR 3b-B, 순수 — DB·네트워크·스냅숏 없음). 오늘 예전 설정이 고르는 모델을 배정 표 행으로 옮기는 `saveModelAssignment`
 * 입력 목록과, 지금 표와의 차이(create·update·unchanged)를 만든다. 화면·적용은 3b-D 가 한다(이 함수는 아무것도 쓰지 않는다).
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
  /** firstReview 가 없을 때 오늘 쓰는 env 대체(claude-cli + CRAWL_REVIEW_MODEL). 순수 함수라 env 를 읽지 않는다. */
  firstReviewFallback?: { provider: "claude-cli" | "abcllm" | "grok-cli"; model: string } | null;
}>;
export type AssignmentImportInput = Readonly<{
  assignmentId: string; expectedVersion: number | null; stage: AssignmentStage; deviceId: string; registryKey: string; transport: AssignmentTransport;
  rank: number; role: "primary"; vote: boolean; mode: "off" | "live"; maxSlots: number; note: string | null;
}>;
export const ASSIGNMENT_IMPORT_WARNINGS = Object.freeze(["registry_unmatched", "registry_ambiguous", "transport_unsupported", "route_missing",
  "duplicate", "input_invalid", "stage_unmapped", "first_review_from_env"] as const);
export type AssignmentImportWarningCode = (typeof ASSIGNMENT_IMPORT_WARNINGS)[number];
export type AssignmentImportWarning = Readonly<{ source: string; code: AssignmentImportWarningCode; detail: string }>;
export type AssignmentImportEntry = Readonly<{
  action: "create" | "update" | "unchanged"; source: string; input: AssignmentImportInput;
  /** 같은 (단계, 장비, wire 모델)의 지금 행 — 표의 유일 키 */
  current: ModelAssignmentRow | null;
  /** update 일 때 바뀌는 칸(registryKey·transport·rank·vote·mode) */
  changes: readonly string[];
}>;
export type AssignmentImportPlan = Readonly<{ entries: readonly AssignmentImportEntry[]; warnings: readonly AssignmentImportWarning[];
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

export function planAssignmentImport(settings: AssignmentImportSettings, policy: ModelCapacityPolicy | null, registry: Pick<ModelRegistry, "models">,
  options: AssignmentImportOptions = {}): AssignmentImportPlan {
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
    const input: AssignmentImportInput = Object.freeze({
      assignmentId: current?.assignmentId ?? `${item.stage}:${String(item.order).padStart(2, "0")}:${slug(item.value.entry.key)}`.slice(0, 120),
      expectedVersion: current?.version ?? null, stage: item.stage, deviceId, registryKey: item.value.entry.key, transport: item.value.transport,
      rank: item.rank, role: "primary", vote: item.vote, mode: route ? "live" : "off", maxSlots: current?.maxSlots ?? 1,
      note: current?.note ?? `가져옴: ${item.source}`.slice(0, 400) });
    const parsed = modelAssignmentInputSchema.safeParse(input);
    if (!parsed.success) { warn(item.source, "input_invalid", parsed.error.issues.map(issue => `${issue.path.join(".")}:${issue.message}`).join(", ")); continue; }
    const changes = current ? FIELDS.filter(field => current[field] !== input[field]) : [];
    entries.push(Object.freeze({ action: !current ? "create" : changes.length ? "update" : "unchanged", source: item.source, input, current,
      changes: Object.freeze(changes) }));
  }
  const count = (action: AssignmentImportEntry["action"]) => entries.filter(entry => entry.action === action).length;
  return Object.freeze({ entries: Object.freeze(entries), warnings: Object.freeze(warnings),
    counts: Object.freeze({ create: count("create"), update: count("update"), unchanged: count("unchanged"),
      skipped: warnings.filter(warning => !["route_missing", "first_review_from_env"].includes(warning.code)).length }) });
}

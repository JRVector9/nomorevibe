import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { introCheckCliArgs } from "@/lib/domain/products/intro-check";
import { reviewCliArgs } from "@/lib/crawl/agent-review";
import { AI_TASKS, aiTask, aiTaskAccepts, aiTaskSlotLabel, isAiLiveTask, type AiCliTool } from "@/lib/llm/ai-tasks";
import type { ModelCapacityRoute } from "@/lib/llm/capacity";
import { aiConnectionLabel, aiRankChoiceOfRow, aiRankReasoningEfforts, aiTaskConnectionModelIds, type AiConnectionView, type AiCurrentSlot,
  type AiRankChoice, type AiTaskRankRow, type AiTaskRanksInput } from "./admin-ai-tasks";
import { aiTaskEditTarget } from "./ai-task-edit-target";
import { aiTaskReasoningEfforts } from "@/lib/llm/ai-task-reasoning";

/**
 * 「장비 한도」 화면의 CLI 장비 줄 아래 작업별 모델·추론 강도(2026-11-09). Claude CLI·Codex CLI 만 다룬다(OpenCode 는 그대로다).
 *
 * 어댑터가 실제로 프로세스에 넘기는 것(코드에서 확인):
 * - 1차·2차 AI 검수 × Claude CLI: 순위 행의 options.reasoningEffort → prepareReviewCliCall → reviewCliArgs(model, effort) 의 `--effort <값>`.
 *   값이 없으면 어댑터 기본 low. 고를 수 있는 값은 aiTaskReasoningEfforts(sonnet·opus: low·medium·high) — 실행 쪽 검사와 같은 함수다.
 *   이 두 작업만 실행 쪽이 순위를 읽으므로 이 화면에서 바꿀 수 있다(작업 배정과 같은 saveAiTaskRanks — 규칙·감사가 같다).
 * - 소개 검수 × Claude CLI: 모델은 단계 풀(settings.stageModelPools["product-intro-check"])·배정 표·등록부 기본값에서 오고 순위 행은 읽지 않는다.
 *   강도는 그 등록부 key 에 저장한 settings.stageModelEfforts["product-intro-check"][key] 를 introCheckEffort 가 확인해 `--effort` 로 넘긴다(기본 high).
 *   출처가 단계 풀(한 모델)이거나 등록부 기본값이면 이 화면에서 그 단계 풀·강도를 저장한다(saveCliStageModelAction — 단계 풀 저장과 같은 검사, settings-save 감사).
 *   배정 표·여러 모델 풀이 출처면 읽기만 한다.
 * - 카테고리 분류 × Codex·Claude CLI: connect 에이전트 설정(우선·예비)의 model·effort — Codex 는 `-c model_reasoning_effort="<값>"`(high·xhigh),
 *   Claude 는 `--effort high` 고정. 웹의 기존 쓰기 길(운영센터 AI 연결과 같은 codexOperation test → apply: 에이전트가 표본 분류로 검사한 뒤 적용)로 바꾼다.
 * - 작업 분산(workload_pool) 칸은 순위 대신 구성원을 쓴다 — 그 칸의 순위는 고칠 수 없게 두고 구성원은 읽기만 한다.
 */

export const CLI_TASK_USAGE_TOOLS = Object.freeze(["claude", "codex"] as const satisfies readonly AiCliTool[]);
export type CliTaskUsageTool = (typeof CLI_TASK_USAGE_TOOLS)[number];
const isUsageTool = (tool: unknown): tool is CliTaskUsageTool => (CLI_TASK_USAGE_TOOLS as readonly unknown[]).includes(tool);

export type CliTaskUsage = Readonly<{
  /** 화면 key — 같은 판 안에서 겹치지 않는다 */
  key: string;
  /** 장비 id(정책 groupId) — 장비 표의 행 열쇠. 모르면 null */
  deviceId: string | null;
  cliTool: CliTaskUsageTool;
  connectionId: string | null;
  connectionLabel: string;
  task: string;
  /** 「2차 AI 검수 · 투표자 2」 */
  taskLabel: string;
  slot: number;
  rank: number | null;
  /** 작은 글자: 「1순위」·「단계 풀」·「connect 우선」 */
  where: string;
  source: "rank" | "pool" | "current" | "connect";
  model: string;
  /** 저장된 추론 강도(없으면 null = 어댑터 기본) */
  effort: string | null;
  /** 「기본」을 고르면 어댑터가 넘기는 값(있으면) */
  defaultEffort: string | null;
  /** 이 줄에서 고를 수 있는 값(연결의 CLI 모델 + 지금 값; 소개 검수는 등록부 key) */
  models: readonly string[];
  /** 값 → 보이는 이름(값이 등록부 key 일 때) */
  modelLabels?: Readonly<Record<string, string>>;
  /** 모델마다 받는 추론 강도 — 빈 목록이면 강도를 넘기지 않는다 */
  effortsByModel: Readonly<Record<string, readonly string[]>>;
  /** 고칠 수 있는 줄과 그 저장 길 — 저장 때 같은 판인지 비교한다 */
  edit: CliTaskUsageEdit | null;
  /** 읽기 전용 까닭과 실제 설정 위치 */
  readOnly: Readonly<{ reason: string; href: string; linkLabel: string }> | null;
}>;

export type CliTaskUsageEdit = Readonly<
  | { kind: "rank"; revision: string }
  /** 소개 검수 단계 풀 + 강도(settings). settingsVersion = 화면이 본 설정 판, currentKey = 지금 고른 등록부 key */
  | { kind: "stage"; stage: "product-intro-check"; settingsVersion: string; currentKey: string }
  /** connect 에이전트 우선·예비 — 저장 때 에이전트의 지금 설정·판을 다시 읽는다 */
  | { kind: "connect"; which: "primary" | "fallback" }>;

/** 소개 검수 단계의 지금 출처(읽기에서 계산) — 단계 풀 한 모델 또는 등록부 기본값일 때만 */
export type CliIntroStageSource = Readonly<{ source: "pool" | "default"; currentKey: string; settingsVersion: string;
  savedEfforts: Readonly<Record<string, string>>; choices: readonly Readonly<{ key: string; model: string }>[] }>;

export type CliTaskUsageView = Readonly<{ usages: readonly CliTaskUsage[]; unavailable: readonly string[] }>;

export type CliClassifierObservation = Readonly<{ observedAt: string; fresh: boolean;
  models: readonly Readonly<{ rank: 1 | 2; model: string; effort: string | null; provider: string | null }>[] }>;

export type CliTaskUsageInput = Readonly<{
  connections: readonly AiConnectionView[];
  rows: readonly AiTaskRankRow[];
  /** (작업, 칸) → 판(sha256) — aiTaskSlotRevision */
  revisionOf: (rows: readonly AiTaskRankRow[]) => string;
  executions: readonly Readonly<{ task: string; slot: number; mode: "fallback" | "workload_pool";
    members: readonly Readonly<{ memberId: string; position: number; connectionId: string; model: string; options: unknown; deviceId: string }>[] }>[] | null;
  /** 순위를 읽지 않는 작업의 실제 출처(buildAiCurrentSlots). 못 읽으면 null */
  current: readonly AiCurrentSlot[] | null;
  classifier: CliClassifierObservation | null;
  /** 소개 검수를 이 화면에서 저장할 수 있을 때의 출처. null = 읽기만 */
  introStage?: CliIntroStageSource | null;
  /** 웹 등록부의 분류 모델(classificationModelOptions) — connect 줄의 선택지 */
  connectModels?: readonly Readonly<{ model: string; provider: string }>[];
  routes: readonly Pick<ModelCapacityRoute, "routeId" | "provider" | "model" | "groupId">[] | null;
}>;

const TASKS_PAGE = "/admin/models";
const CONNECT_PAGE = "/admin/status?tab=ai";
const EFFORT = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** 어댑터 argv 에서 `--effort` 다음 값을 읽는다 — 화면이 어댑터와 다른 값을 지어내지 않게 */
const argvEffort = (args: readonly string[]): string | null => {
  const at = args.indexOf("--effort");
  return at >= 0 && typeof args[at + 1] === "string" ? args[at + 1] : null;
};
/** 1차·2차 검수 Claude CLI 에 강도를 저장하지 않았을 때 어댑터가 넘기는 값 */
export const CLAUDE_REVIEW_DEFAULT_EFFORT = argvEffort(reviewCliArgs("sonnet"));
/** 소개 검수 Claude CLI 가 늘 넘기는 값(고정) */
export const CLAUDE_INTRO_CHECK_EFFORT = argvEffort(introCheckCliArgs("sonnet"));
/** connect 분류 에이전트가 받는 강도(lib/operations/contracts.ts modelConfigSchema) — Claude 는 high 만 */
export const CONNECT_EFFORTS: Readonly<Record<CliTaskUsageTool, readonly string[]>> = Object.freeze({ codex: ["high", "xhigh"], claude: ["high"] });

const rankWhere = (task: string, slot: number, rank: number) => {
  const def = aiTask(task);
  return def?.slotLabel ? `${def.slotLabel} ${slot} · ${rank}순위` : `${rank}순위`;
};
const optionEffort = (options: unknown): string | null => {
  const value = options && typeof options === "object" ? (options as Record<string, unknown>).reasoningEffort : undefined;
  return typeof value === "string" && value ? value : null;
};

/** 순수 — 읽은 것들로 장비별 작업 줄을 만든다(화면 순서 = AI_TASKS 순서 → 칸 → 순위). */
export function buildCliTaskUsages(input: CliTaskUsageInput): CliTaskUsageView {
  const usages: CliTaskUsage[] = [], unavailable: string[] = [];
  const connections = input.connections.filter(connection => connection.kind === "cli" && isUsageTool(connection.cliTool));
  const byId = new Map(connections.map(connection => [connection.id, connection]));
  const deviceOfTool = (tool: CliTaskUsageTool): string | null => {
    const devices = [...new Set(connections.filter(connection => connection.cliTool === tool).map(connection => connection.deviceId))];
    return devices.length === 1 ? devices[0] : null;
  };
  const routeDevice = (routeId: string | null, provider: string, model: string): string | null =>
    routeId ? input.routes?.find(route => route.routeId === routeId && route.provider === provider && route.model === model)?.groupId ?? null : null;
  const modelChoices = (connection: AiConnectionView, taskId: string, current: string) => {
    const def = aiTask(taskId);
    const models = [...new Set([...(def ? aiTaskConnectionModelIds(def, connection) : []), current])];
    return { models, effortsByModel: Object.fromEntries(models.map(model => [model, [...aiRankReasoningEfforts(taskId, connection, model)]])) };
  };
  const poolSlots = new Set((input.executions ?? []).filter(row => row.mode === "workload_pool").map(row => `${row.task}#${row.slot}`));

  // 1) 실행 쪽이 순위를 읽는 작업의 순위 행 — 고칠 수 있다(작업 분산 칸·꺼진 연결·꺼진 순위는 읽기만)
  const ranked = input.rows.filter(row => byId.has(row.connectionId) && isAiLiveTask(row.task) && aiTask(row.task))
    .sort((a, b) => taskOrder(a.task) - taskOrder(b.task) || a.slot - b.slot || a.rank - b.rank);
  for (const row of ranked) {
    const connection = byId.get(row.connectionId)!, def = aiTask(row.task)!, tool = connection.cliTool as CliTaskUsageTool;
    const slotRows = input.rows.filter(other => other.task === row.task && other.slot === row.slot).sort((a, b) => a.rank - b.rank);
    const pool = poolSlots.has(`${row.task}#${row.slot}`);
    const reason = pool ? "작업 분산을 쓰는 칸이라 이 순위는 실행에 쓰이지 않습니다"
      : !connection.enabled ? "연결이 꺼져 있습니다" : !row.enabled || slotRows.some(other => !other.enabled) ? "꺼진 순위가 있는 칸입니다"
      : !aiTaskAccepts(def, connection) ? "이 작업이 받지 않는 CLI 도구입니다" : null;
    usages.push(Object.freeze({ key: `rank:${row.task}:${row.slot}:${row.rank}`, deviceId: connection.deviceId, cliTool: tool, connectionId: connection.id,
      connectionLabel: aiConnectionLabel(connection), task: row.task, taskLabel: aiTaskSlotLabel(def, row.slot), slot: row.slot, rank: row.rank,
      where: rankWhere(row.task, row.slot, row.rank), source: "rank", model: row.model, effort: optionEffort(row.options),
      defaultEffort: tool === "claude" && (row.task === "first-review" || row.task === "second-review") ? CLAUDE_REVIEW_DEFAULT_EFFORT : null,
      ...modelChoices(connection, row.task, row.model),
      edit: reason ? null : Object.freeze({ kind: "rank", revision: input.revisionOf(slotRows) }),
      readOnly: reason ? Object.freeze({ reason, href: `${TASKS_PAGE}#execution-${row.task}-${row.slot}`, linkLabel: "작업 배정에서 바꾸기" }) : null }));
  }

  // 2) 작업 분산 구성원 — 구성원 편집기에서만 바꾼다
  if (input.executions === null) unavailable.push("작업 분산 구성을 읽지 못했습니다 — 분산 구성원으로 쓰는 CLI 는 빠져 있을 수 있습니다.");
  for (const execution of input.executions ?? []) {
    if (execution.mode !== "workload_pool") continue;
    const def = aiTask(execution.task);
    if (!def) continue;
    for (const member of execution.members) {
      const connection = byId.get(member.connectionId);
      if (!connection) continue;
      usages.push(Object.freeze({ key: `pool:${member.memberId}`, deviceId: member.deviceId || connection.deviceId, cliTool: connection.cliTool as CliTaskUsageTool,
        connectionId: connection.id, connectionLabel: aiConnectionLabel(connection), task: def.id, taskLabel: aiTaskSlotLabel(def, execution.slot),
        slot: execution.slot, rank: null, where: `작업 분산 ${member.position}번`, source: "pool", model: member.model, effort: optionEffort(member.options),
        defaultEffort: null, models: [member.model], effortsByModel: { [member.model]: [] }, edit: null,
        readOnly: Object.freeze({ reason: "작업 분산 구성원입니다", href: `${TASKS_PAGE}#execution-${def.id}-${execution.slot}`, linkLabel: "작업 분산에서 바꾸기" }) }));
    }
  }

  // 3) 순위를 읽지 않는 작업의 실제 CLI(소개 검수 등) — 단계 풀·배정 표·등록부
  if (input.current === null) unavailable.push("순위를 읽지 않는 작업(소개 검수 등)의 실제 모델을 읽지 못했습니다.");
  for (const slot of input.current ?? []) {
    const def = aiTask(slot.task);
    if (!def || isAiLiveTask(def.id) || def.id === "publish-classify") continue;
    slot.uses.forEach((use, index) => {
      if (use.kind !== "cli" || !isUsageTool(use.cliTool)) return;
      const tool = use.cliTool;
      const target = aiTaskEditTarget(def.id);
      const stage = input.introStage;
      const stageModel = stage?.choices.find(choice => choice.key === stage.currentKey)?.model;
      if (tool === "claude" && def.id === "product-intro-check" && index === 0 && slot.uses.length === 1 && stage && stageModel === use.model) {
        const keys = [...new Set([stage.currentKey, ...stage.choices.map(choice => choice.key)])];
        const modelOf = (key: string) => stage.choices.find(choice => choice.key === key)?.model ?? key;
        const saved = stage.savedEfforts[stage.currentKey];
        usages.push(Object.freeze({ key: `stage:${def.id}`, deviceId: use.deviceId ?? deviceOfTool(tool), cliTool: tool, connectionId: null,
          connectionLabel: "Claude CLI", task: def.id, taskLabel: def.label, slot: 1, rank: null,
          where: stage.source === "pool" ? "단계 풀" : "등록부 기본값", source: "current", model: stage.currentKey,
          effort: typeof saved === "string" && saved ? saved : null, defaultEffort: CLAUDE_INTRO_CHECK_EFFORT,
          models: keys, modelLabels: Object.fromEntries(keys.map(key => [key, modelOf(key)])),
          effortsByModel: Object.fromEntries(keys.map(key => [key, [...aiTaskReasoningEfforts(def.id, "claude", modelOf(key))]])),
          edit: Object.freeze({ kind: "stage", stage: "product-intro-check", settingsVersion: stage.settingsVersion, currentKey: stage.currentKey }), readOnly: null }));
        return;
      }
      const fixed = tool === "claude" && def.id === "product-intro-check" ? CLAUDE_INTRO_CHECK_EFFORT : null;
      usages.push(Object.freeze({ key: `current:${def.id}:${slot.slot}:${index}`, deviceId: use.deviceId ?? deviceOfTool(tool), cliTool: tool, connectionId: null,
        connectionLabel: tool === "claude" ? "Claude CLI" : "Codex CLI", task: def.id, taskLabel: aiTaskSlotLabel(def, slot.slot), slot: slot.slot, rank: null,
        where: slot.source, source: "current", model: use.model, effort: fixed, defaultEffort: null, models: [use.model], effortsByModel: { [use.model]: fixed ? [fixed] : [] },
        edit: null, readOnly: Object.freeze({ reason: fixed ? `${slot.source}에서 오는 값이라 여기서 바꾸지 않습니다(저장한 강도가 없으면 ${fixed})` : "이 작업은 순위를 읽지 않습니다",
          href: target?.href ?? "/admin/models/advanced#model-settings", linkLabel: target?.label ?? "실제 적용 모델 설정" }) }));
    });
  }

  // 4) 카테고리 분류 — connect 에이전트의 우선·예비(마지막 관측)
  if (input.classifier === null) unavailable.push("connect 에이전트(카테고리 분류) 관측을 읽지 못했습니다.");
  const classify = aiTask("publish-classify")!;
  for (const entry of input.classifier?.models ?? []) {
    const tool = entry.provider === "codex-cli" ? "codex" : entry.provider === "claude-cli" ? "claude" : null;
    if (!tool) continue;
    const effort = entry.effort && EFFORT.test(entry.effort) ? entry.effort : null;
    const provider = entry.provider!;
    const offered = (input.connectModels ?? []).filter(option => option.provider === provider).map(option => option.model);
    const models = [...new Set([entry.model, ...offered])];
    const editable = offered.includes(entry.model) && input.classifier!.fresh;
    usages.push(Object.freeze({ key: `connect:${entry.rank}`, deviceId: routeDevice(classify.routeId, entry.provider!, entry.model) ?? deviceOfTool(tool), cliTool: tool,
      connectionId: null, connectionLabel: tool === "claude" ? "Claude CLI" : "Codex CLI", task: classify.id, taskLabel: classify.label, slot: 1, rank: entry.rank,
      where: `connect ${entry.rank === 1 ? "우선" : "예비"}${input.classifier!.fresh ? "" : " · 관측 오래됨"}`, source: "connect", model: entry.model, effort,
      defaultEffort: null, models, effortsByModel: Object.fromEntries(models.map(model => [model, [...CONNECT_EFFORTS[tool]]])),
      edit: editable ? Object.freeze({ kind: "connect", which: entry.rank === 1 ? "primary" : "fallback" }) : null,
      readOnly: editable ? null : Object.freeze({ reason: input.classifier!.fresh ? "웹 등록부에 없는 분류 모델입니다" : "connect 관측이 오래되어 지금 설정을 확인할 수 없습니다",
        href: CONNECT_PAGE, linkLabel: "AI 연결·설정에서 바꾸기" }) }));
  }
  return Object.freeze({ usages: Object.freeze(usages), unavailable: Object.freeze(unavailable) });
}
const taskOrder = (id: string) => {
  const index = AI_TASKS.findIndex(task => task.id === id);
  return index < 0 ? AI_TASKS.length : index;
};

/** 장비 id → 그 장비의 작업 줄. 장비를 모르는 줄은 unmapped 에 둔다(화면이 따로 보일 수 있다). */
export function cliTaskUsagesByDevice(usages: readonly CliTaskUsage[]): { byDevice: Record<string, CliTaskUsage[]>; unmapped: CliTaskUsage[] } {
  const byDevice: Record<string, CliTaskUsage[]> = {}, unmapped: CliTaskUsage[] = [];
  for (const usage of usages) {
    if (!usage.deviceId) { unmapped.push(usage); continue; }
    (byDevice[usage.deviceId] ??= []).push(usage);
  }
  return { byDevice, unmapped };
}

// ── 저장 요청 → 같은 칸의 순위 저장 입력 ─────────────────────────────────────────────────────────────────

export type CliTaskModelEditRequest = Readonly<{ task: string; slot: number; rank: number; revision: string; connectionId: string; model: string;
  /** "" = 기본(강도를 지운다) */
  reasoningEffort: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
type FormLike = { get(name: string): unknown };

export function cliTaskModelEditFromForm(form: FormLike): CliTaskModelEditRequest | null {
  const text = (name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
  const task = text("task"), slot = text("slot"), rank = text("rank"), revision = text("revision"), connectionId = text("connectionId"), model = text("model");
  const reasoningEffort = text("reasoningEffort");
  if (!aiTask(task) || !/^[1-8]$/.test(slot) || !/^[1-3]$/.test(rank) || !/^[a-f0-9]{64}$/.test(revision) || !UUID.test(connectionId)
    || !CLI_MODEL.test(model) || (reasoningEffort !== "" && !EFFORT.test(reasoningEffort))) return null;
  return { task, slot: Number(slot), rank: Number(rank), revision, connectionId, model, reasoningEffort };
}

export type CliTaskModelEdit = { ok: true; input: AiTaskRanksInput; changed: boolean } | { ok: false; issue: string };
export const CLI_TASK_EDIT_STALE = "그사이 이 작업의 순위가 바뀌었습니다 — 새로 고친 뒤 다시 저장하세요.";

/**
 * 한 순위의 모델·강도만 바꾼 같은 칸 전체 입력(순수). 나머지 순위는 지금 저장된 그대로(aiRankChoiceOfRow) 다시 보낸다 — 저장은 작업 배정과 같은
 * saveAiTaskRanks 가 판 비교·검증·준비 확인·감사를 한다. 판이 다르거나 그 순위의 연결이 바뀌었으면 거절한다. 꺼진 순위가 있는 칸은 다시 저장하면
 * 켜지므로 받지 않는다.
 */
export function cliTaskModelEdit(rows: readonly AiTaskRankRow[], request: CliTaskModelEditRequest, revisionOf: (rows: readonly AiTaskRankRow[]) => string): CliTaskModelEdit {
  const def = aiTask(request.task);
  if (!def || request.slot > def.slots) return { ok: false, issue: "ai_task_invalid:task" };
  if (!isAiLiveTask(def.id)) return { ok: false, issue: `${def.label}의 순위는 실행 쪽이 읽지 않아 여기서 바꾸지 않습니다.` };
  const slotRows = rows.filter(row => row.task === def.id && row.slot === request.slot).sort((a, b) => a.rank - b.rank);
  if (revisionOf(slotRows) !== request.revision) return { ok: false, issue: CLI_TASK_EDIT_STALE };
  const target = slotRows.find(row => row.rank === request.rank);
  if (!target || target.connectionId !== request.connectionId) return { ok: false, issue: CLI_TASK_EDIT_STALE };
  if (slotRows.some(row => !row.enabled)) return { ok: false, issue: "꺼진 순위가 있는 칸이라 여기서 저장하지 않습니다 — 작업 배정에서 바꾸세요." };
  const ranks: (AiRankChoice | null)[] = [1, 2, 3].map(rank => {
    const row = slotRows.find(entry => entry.rank === rank);
    return row ? aiRankChoiceOfRow(row) : null;
  });
  const before = ranks[request.rank - 1]!;
  ranks[request.rank - 1] = { provider: target.connectionId, model: request.model, reasoningEffort: request.reasoningEffort };
  // 뒤쪽 빈 순위는 보내지 않는다(작업 배정 폼과 같은 모양)
  while (ranks.length && ranks[ranks.length - 1] === null) ranks.pop();
  const changed = before.model !== request.model || (before.reasoningEffort ?? "") !== request.reasoningEffort;
  return { ok: true, input: { task: def.id, slot: request.slot, revision: request.revision, ranks }, changed };
}

// ── 소개 검수 단계 풀·강도 저장 입력 ──────────────────────────────────────────────────────────────────────

export type CliStageModelEditRequest = Readonly<{ stage: "product-intro-check"; settingsVersion: string; currentKey: string; key: string;
  /** "" = 기본(저장한 강도를 지운다 → high) */
  reasoningEffort: string }>;
const REGISTRY_KEY = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;

export function cliStageModelEditFromForm(form: FormLike): CliStageModelEditRequest | null {
  const text = (name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
  const currentKey = text("currentKey"), key = text("model") || currentKey, settingsVersion = text("settingsVersion"), reasoningEffort = text("reasoningEffort");
  if (text("stage") !== "product-intro-check" || !/^[a-f0-9]{32}$/.test(settingsVersion) || !REGISTRY_KEY.test(currentKey) || !REGISTRY_KEY.test(key)
    || (reasoningEffort !== "" && !EFFORT.test(reasoningEffort))) return null;
  return { stage: "product-intro-check", settingsVersion, currentKey, key, reasoningEffort };
}

export type CliStageSettingsPatch = { ok: true; changed: boolean; poolChanged: boolean;
  patch: { stageModelEfforts: Record<string, Record<string, string>>; stageModelPools?: Record<string, string[]> } } | { ok: false; issue: string };

/**
 * 순수 — 지금 설정 위에 소개 검수 단계 풀(바꾼 모델이면 그 key 하나)과 그 key 의 강도를 얹은 saveSettings 패치. 모델은 등록부의 Claude CLI 정의여야 하고
 * (호출자가 adminStageAcceptsModel 로 거른 choices), 강도는 그 모델이 받는 값(aiTaskReasoningEfforts)이거나 ""(기본 high).
 * 다른 단계 풀·다른 key 의 강도는 그대로다.
 */
export function cliStageSettingsPatch(current: { stageModelPools?: Readonly<Record<string, readonly string[] | undefined>>;
    stageModelEfforts?: Readonly<Record<string, Readonly<Record<string, string>>>> }, request: CliStageModelEditRequest,
  choices: readonly Readonly<{ key: string; model: string }>[]): CliStageSettingsPatch {
  const choice = choices.find(entry => entry.key === request.key);
  if (!choice) return { ok: false, issue: "소개 검수가 받지 않는 모델입니다(등록부의 Claude CLI 모델만)." };
  if (request.reasoningEffort && !aiTaskReasoningEfforts(request.stage, "claude", choice.model).includes(request.reasoningEffort))
    return { ok: false, issue: `${choice.model}은(는) 추론 강도 ${request.reasoningEffort}을(를) 받지 않습니다.` };
  const poolChanged = request.key !== request.currentKey;
  const efforts: Record<string, Record<string, string>> = Object.fromEntries(Object.entries(current.stageModelEfforts ?? {}).map(([stage, map]) => [stage, { ...map }]));
  const mine = efforts[request.stage] ?? {};
  const before = mine[request.key] ?? "";
  if (request.reasoningEffort) mine[request.key] = request.reasoningEffort; else delete mine[request.key];
  if (Object.keys(mine).length) efforts[request.stage] = mine; else delete efforts[request.stage];
  const changed = poolChanged || before !== request.reasoningEffort;
  const pools = Object.fromEntries(Object.entries(current.stageModelPools ?? {}).flatMap(([stage, keys]) => keys ? [[stage, [...keys]]] : [])) as Record<string, string[]>;
  if (poolChanged) pools[request.stage] = [request.key];
  return { ok: true, changed, poolChanged, patch: { stageModelEfforts: efforts, ...(poolChanged ? { stageModelPools: pools } : {}) } };
}

// ── 읽기 ───────────────────────────────────────────────────────────────────────────────────────────────

const CONNECT_FRESH_MS = 5 * 60_000;
/** connect 에이전트의 마지막 관측 값 → 우선·예비 모델·강도·도구. 모양이 틀린 칸은 버린다(키 등 다른 칸은 읽지 않는다). */
export function parseCliClassifierObservation(observedAt: string, value: unknown, now = Date.now()): CliClassifierObservation | null {
  if (!value || typeof value !== "object" || !Number.isFinite(Date.parse(observedAt))) return null;
  const record = value as Record<string, unknown>;
  const config = record.config && typeof record.config === "object" ? record.config as Record<string, unknown> : {};
  const options = Array.isArray(record.modelOptions) ? record.modelOptions as unknown[] : [];
  const providerOf = (model: string) => {
    const option = options.find(row => !!row && typeof row === "object" && (row as Record<string, unknown>).model === model) as Record<string, unknown> | undefined;
    return typeof option?.provider === "string" && /^[a-z0-9-]{1,40}$/.test(option.provider) ? option.provider : null;
  };
  const models = ([config.primary, config.fallback] as unknown[]).flatMap((candidate, index) => {
    const entry = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
    const model = entry?.model, effort = entry?.effort;
    return typeof model === "string" && CLI_MODEL.test(model)
      ? [{ rank: (index + 1) as 1 | 2, model, effort: typeof effort === "string" && EFFORT.test(effort) ? effort : null, provider: providerOf(model) }] : [];
  });
  const age = now - Date.parse(observedAt);
  return { observedAt, fresh: age >= -60_000 && age <= CONNECT_FRESH_MS, models };
}

async function readConnectObservation(now: number): Promise<CliClassifierObservation | null> {
  try {
    const [row] = await onPrimary(() => db.execute<{ observedAt: string; value: unknown }>(sql`
      SELECT to_char(observed_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt", value
      FROM operations_observations WHERE key LIKE 'service:connect-agent:%' ORDER BY observed_at DESC LIMIT 1`));
    return row ? parseCliClassifierObservation(row.observedAt, row.value, now) : { observedAt: new Date(now).toISOString(), fresh: false, models: [] };
  } catch { return null; }
}

/**
 * 장비 한도 화면이 한 번 읽는다 — 연결·순위·작업 분산·순위를 읽지 않는 작업의 실제 출처·connect 관측. 네트워크(에이전트 호출)는 하지 않는다.
 * 하나를 못 읽어도 나머지는 보이고 unavailable 에 그 문장이 남는다. 연결·순위를 못 읽으면 줄이 없다.
 */
/** 소개 검수 단계의 지금 출처 → 이 화면이 저장할 수 있는가(단계 풀 한 모델 또는 등록부 기본값). 배정 표·여러 모델 풀·출처 미확인이면 null. */
export function introStageSource(input: { settings: { stageModelPools?: Readonly<Record<string, readonly string[] | undefined>>;
    stageModelEfforts?: Readonly<Record<string, Readonly<Record<string, string>>>> }; settingsUnknown?: boolean; slot: AiCurrentSlot | null;
  settingsVersion: string; defaultKey: string | null; choices: readonly Readonly<{ key: string; model: string }>[] }): CliIntroStageSource | null {
  if (input.settingsUnknown || !input.slot || input.slot.error) return null;
  const pool = input.settings.stageModelPools?.["product-intro-check"] ?? [];
  const savedEfforts = input.settings.stageModelEfforts?.["product-intro-check"] ?? {};
  const base = { settingsVersion: input.settingsVersion, savedEfforts, choices: input.choices };
  if (input.slot.source === "단계 풀" && pool.length === 1) return { ...base, source: "pool", currentKey: pool[0] };
  if (input.slot.source === "등록부·env 기본값" && pool.length === 0 && input.defaultKey) return { ...base, source: "default", currentKey: input.defaultKey };
  return null;
}

/**
 * 장비 한도 화면이 한 번 읽는다 — 연결·순위·작업 분산·순위를 읽지 않는 작업의 실제 출처·connect 관측. 네트워크(에이전트 호출)는 하지 않는다.
 * 하나를 못 읽어도 나머지는 보이고 unavailable 에 그 문장이 남는다. 연결·순위를 못 읽으면 순위 줄이 없다.
 */
export async function readCliTaskUsages(): Promise<CliTaskUsageView> {
  const [{ aiTaskSlotRevision, listAiConnections, listAiTaskRows }, { readAiTaskExecutionAdminViews }, { buildAiCurrentSlots, readAiCurrentSources },
    { readCapacityDevicesControl }, { settingsFormVersion }, registryModule, { ADMIN_MODEL_STAGES, adminStageAcceptsModel }, { classificationModelOptions }] = await Promise.all([
    import("./admin-ai-tasks-repository"), import("./admin-ai-task-execution"), import("./admin-ai-task-current"), import("./admin-capacity-devices"),
    import("@/lib/crawl/settings"), import("@/lib/llm/model-registry"), import("@/lib/llm/admin-model-stages"), import("./classification-models")]);
  const now = Date.now();
  const policy = await readCapacityDevicesControl().then(control => control.policy).catch(() => null);
  const [connections, rows, executions, sources, classifier] = await Promise.all([
    listAiConnections().catch(() => null),
    listAiTaskRows().catch(() => null),
    readAiTaskExecutionAdminViews().catch(() => null),
    readAiCurrentSources(policy, { includeAgent: false }).catch(() => null),
    readConnectObservation(now),
  ]);
  let current: AiCurrentSlot[] | null = null;
  try { current = sources ? buildAiCurrentSlots(sources) : null; } catch { current = null; }
  let introStage: CliIntroStageSource | null = null;
  try {
    const stage = ADMIN_MODEL_STAGES.find(row => row.id === "product-intro-check")!;
    const choices = registryModule.readModelRegistry().models.filter(model => model.provider === "claude-cli" && adminStageAcceptsModel(stage, model))
      .map(model => ({ key: model.key, model: registryModule.modelRequestName(model) }));
    let defaultKey: string | null = null;
    try { defaultKey = registryModule.configuredModelDefinition("product-intro-check").key; } catch { defaultKey = null; }
    introStage = sources ? introStageSource({ settings: sources.settings, settingsUnknown: sources.settingsUnknown, settingsVersion: settingsFormVersion(sources.settings),
      slot: current?.find(slot => slot.task === "product-intro-check") ?? null, defaultKey, choices }) : null;
  } catch { introStage = null; }
  let connectModels: { model: string; provider: string }[] = [];
  try { connectModels = classificationModelOptions(); } catch { connectModels = []; }
  const routes = policy?.routes ?? null;
  const common = { revisionOf: aiTaskSlotRevision, executions, current, classifier, routes, introStage, connectModels };
  if (!connections || !rows) {
    const rest = buildCliTaskUsages({ ...common, connections: [], rows: [] });
    return Object.freeze({ usages: rest.usages, unavailable: Object.freeze(["CLI 연결·작업 순위를 읽지 못했습니다 — 순위 줄은 보이지 않습니다.", ...rest.unavailable]) });
  }
  return buildCliTaskUsages({ ...common, connections, rows });
}

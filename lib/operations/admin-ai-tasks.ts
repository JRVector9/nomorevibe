import { aiTaskReasoningEfforts } from "@/lib/llm/ai-task-reasoning";
import type { CliCatalogMetadata } from "@/lib/llm/cli-catalog-metadata";
import { OPENCODE_NATIVE_TASK_ROUTES, aiTaskUsesCliEngine, cliEngineEndpoint, cliEngineRevision, type CliEngineSource } from "@/lib/llm/cli-engine-config";
import { AI_TASK_EXECUTION_SAVE_AUDIT_ACTION } from "@/lib/llm/ai-task-execution-config";
import { AI_CLI_TOOL_LABELS, AI_CLI_TOOL_PROVIDERS, AI_CLI_TOOLS, AI_TASK_RANK_MAX, AI_TASKS, aiTask, aiTaskAccepts, aiTaskAliasIdentity, aiTaskSlotLabel, isAiLiveTask,
  type AiCliTool, type AiTaskDef } from "@/lib/llm/ai-tasks";

/**
 * 「AI 연결」·「작업 ↔ 모델」 관리 화면의 순수 규칙(2026-11-02, PR A) — 입력 읽기·선택지·순위 검증·저장 전 준비 확인·가져오기 계획·한국어 문장.
 * DB·네트워크·node 모듈을 쓰지 않는다(lib/operations/admin-ai-tasks-repository.ts 가 읽어 넘긴다) — 화면 구성 요소도 그대로 읽는다.
 * 판·계획 hash(sha256)는 서버 모듈(admin-ai-tasks-repository.ts)이 만든다.
 */

export type AiConnectionKind = "api" | "cli";
export type AiServedModel = Readonly<{ id: string; maxModelLen: number | null }>;
/** 화면·검증이 보는 연결(키는 없다 — 저장됐는지만). OpenCode의 hasKey는 호스트 RPC 인증 정보이며 provider API 키가 아니다. */
export type AiConnectionView = Readonly<{
  id: string; label: string; kind: AiConnectionKind; baseUrl: string | null; host: string | null; hasKey: boolean;
  cliTool: AiCliTool | null; cliModels: readonly string[];
  models: readonly AiServedModel[] | null; modelsReadAt: string | null; modelsError: string | null;
  deviceId: string; capacitySlots: number; contextTokens: number | null; enabled: boolean; version: number; note: string | null;
  updatedBy: string; updatedAt: string;
  /** 운영자가 목록에서 뺀 모델(options.hiddenModels) — models·cliModels·cliCatalog 에서 이미 빠져 있다. 「되돌리기」에만 쓴다 */
  hiddenModels?: readonly string[];
  /** CLI version for serving contracts. OpenCode uses the observed existing-host version; other tools retain manual input. */
  cliVersion: string | null;
  /** Whitelisted metadata from the existing M3 CLI host, never provider configuration or keys. */
  cliCatalog?: CliCatalogMetadata | null;
}>;
export type AiTaskRankRow = Readonly<{ task: string; slot: number; rank: number; connectionId: string; model: string;
  options: Readonly<Record<string, unknown>>; enabled: boolean }>;
/** RankSelects 의 값 한 칸 — provider 칸에 연결 id 를 둔다(폼 칸 이름 rank<N>Connection·rank<N>Model). */
export type AiRankChoice = { provider: string; model: string; reasoningEffort?: string };
/** Only settings actually consumed by the review CLI adapter are offered. */
export const aiRankReasoningEfforts = (task: string, connection: Pick<AiConnectionView, "kind" | "cliTool" | "cliCatalog">, model: string): readonly string[] =>
  connection.kind === "cli" ? aiTaskReasoningEfforts(task, connection.cliTool, model, connection.cliCatalog?.models.find(entry => entry.id === model)?.variants) : [];
export const aiRankChoiceOfRow = (row: Pick<AiTaskRankRow, "connectionId" | "model" | "options">): AiRankChoice => ({
  provider: row.connectionId, model: row.model,
  ...(typeof row.options.reasoningEffort === "string" && row.options.reasoningEffort ? { reasoningEffort: row.options.reasoningEffort } : {}),
});
/** Preserve unrelated existing options; absence of this form field keeps legacy callers compatible. */
export function aiRankSavedOptions(choice: AiRankChoice, previous: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const options = { ...previous };
  if (choice.reasoningEffort !== undefined) {
    if (choice.reasoningEffort) options.reasoningEffort = choice.reasoningEffort;
    else delete options.reasoningEffort;
  }
  return options;
}
/**
 * 드롭다운 한 칸. label = 「연결 이름 · 모델」(묶지 않은 목록·기록용), group = 서버(연결) 이름 — 드롭다운은 서버마다 묶고(optgroup) 그 안에 text(모델 이름)만 보인다.
 */
export type AiRankOption = AiRankChoice & { label: string; saved?: boolean; group?: string; text?: string; reasoningEfforts?: readonly string[] };

export const AI_CONNECTION_SAVE_AUDIT_ACTION = "ai-connection-save";
export const AI_CONNECTION_MODELS_AUDIT_ACTION = "ai-connection-models-read";
export const AI_CONNECTION_DELETE_AUDIT_ACTION = "ai-connection-delete";
/** 연결의 모델 하나를 목록에서 빼거나 되돌림(2026-11-08 — options.hiddenModels, 서버·CLI 쪽 모델은 그대로) */
export const AI_CONNECTION_MODEL_HIDE_AUDIT_ACTION = "ai-connection-model-hide";
export const AI_TASK_MODELS_SAVE_AUDIT_ACTION = "ai-task-models-save";
export const AI_TASK_MODELS_IMPORT_AUDIT_ACTION = "ai-task-models-import";
/** 같은 주소 계약 키로 연결 키를 채움(lib/operations/ai-connection-key-fill.ts — 사람이 아니라 상자 키가 있는 프로세스가 쓴다) */
export const AI_CONNECTION_KEY_FILL_AUDIT_ACTION = "ai-connection-key-fill";
export const AI_TASK_AUDIT_ACTIONS = Object.freeze([AI_CONNECTION_SAVE_AUDIT_ACTION, AI_CONNECTION_MODELS_AUDIT_ACTION, AI_CONNECTION_DELETE_AUDIT_ACTION, AI_CONNECTION_MODEL_HIDE_AUDIT_ACTION,
  AI_TASK_MODELS_SAVE_AUDIT_ACTION, AI_TASK_MODELS_IMPORT_AUDIT_ACTION, AI_CONNECTION_KEY_FILL_AUDIT_ACTION, AI_TASK_EXECUTION_SAVE_AUDIT_ACTION] as const);
/**
 * 실행 쪽이 1·2·3순위를 읽지 않는 작업인가(2026-11-08). 이 작업의 순위 행은 실행에 쓰이지 않는 옛 기록이다 — 실제 모델은 단계 풀·감사 설정·등록부에서 온다
 * (admin-ai-task-current). 순위 저장도 막혀 있어(saveAiTaskRanks) 지우는 길은 clearUnreadAiTaskRanks 뿐이다. 검색 벡터·재정렬은 검색 설정이 순위 행을 읽으므로 아니다.
 */
export const aiTaskRanksUnread = (taskId: string): boolean => !isAiLiveTask(taskId) && !["embedding", "rerank"].includes(aiTask(taskId)?.kind ?? "");
/** 운영자가 연결의 목록에서 삭제한 모델 이름(options.hiddenModels, 2026-11-08) — 문자열만, 중복 없이. 모든 읽기가 이것으로 거른다. */
export function aiConnectionHiddenModels(options: unknown): string[] {
  const raw = options && typeof options === "object" ? (options as Record<string, unknown>).hiddenModels : undefined;
  return Array.isArray(raw) ? [...new Set(raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 200))] : [];
}
/** 삭제한 모델을 뺀 목록(목록이 없으면 그대로 null) */
export function aiConnectionVisibleModels<T extends { id: string }>(models: readonly T[] | null | undefined, options: unknown): T[] | null {
  if (!Array.isArray(models)) return null;
  const hidden = new Set(aiConnectionHiddenModels(options));
  return models.filter(model => !!model && typeof model.id === "string" && !hidden.has(model.id));
}
export const AI_TASK_IMPORT_CONFIRM = "가져오기";
export const AI_TASKS_PAGE = "/admin/models/tasks";
/** 키 암호문의 AAD — 행 id 에 묶는다(다른 행으로 옮긴 암호문은 열리지 않는다). */
export const aiConnectionKeyAad = (id: string) => `ai_connections\n${id}`;

// ── 입력 읽기 ───────────────────────────────────────────────────────────────────────────────────────────────

const CONTROL = /[\p{Cc}]/u;
const LABEL_MAX = 80, NOTE_MAX = 400, DEVICE_MAX = 120, CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
export const AI_CONNECTION_CONTEXT_MAX = 2_097_152;

/**
 * OpenAI 호환 주소 → `origin/v1`. 받는 꼴: `…/v1`, `…/v1/`, `…/v1/chat/completions`, `…/v1/models`, 경로 없는 주소(→ `/v1` 을 붙인다).
 * http(s) 만, 계정·질의·조각이 든 주소는 받지 않는다(null). 계약·엔진 연결(engineBaseUrl)과 같은 `origin/v1` 이다.
 */
export function aiConnectionBaseUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.host) return null;
  const path = url.pathname.replace(/\/(chat\/completions|models|embeddings|rerank)\/?$/, "").replace(/\/+$/, "");
  return path === "/v1" || path === "" ? `${url.origin}/v1` : null;
}
export const aiConnectionHost = (baseUrl: string | null): string | null => {
  if (!baseUrl) return null;
  try { return new URL(baseUrl).host || null; } catch { return null; }
};
/** 이름 → 장비 이름 기본값(소문자·숫자·-). */
export const aiDeviceSlug = (label: string): string => label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "ai-connection";

export type AiConnectionInput = Readonly<{
  id: string | null; expectedVersion: number | null; label: string; kind: AiConnectionKind; baseUrl: string | null;
  /** keep = 저장된 키 그대로, set = 새 키, clear = 키 지움 */
  key: { mode: "keep" } | { mode: "set"; value: string } | { mode: "clear" };
  cliTool: AiCliTool | null; cliModels: string[]; deviceId: string; capacitySlots: number; contextTokens: number | null; enabled: boolean; note: string | null;
  /** CLI 만, 선택: `<도구> --version` 출력 그대로(PR C1) */
  cliVersion: string | null;
}>;
type FormLike = { get(name: string): FormDataEntryValue | null };
const text = (form: FormLike, name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 「AI 연결」 폼 → 입력. 문제는 코드(`ai_connection_invalid:<칸>`)로 돌려준다 — aiTaskIssueMessage 가 한국어로 바꾼다. */
export function aiConnectionInputFromForm(form: FormLike): { input: AiConnectionInput | null; issues: string[] } {
  const issues: string[] = [];
  const rawId = text(form, "id"), id = rawId ? (UUID.test(rawId) ? rawId : (issues.push("ai_connection_invalid:id"), null)) : null;
  const rawVersion = text(form, "expectedVersion");
  const expectedVersion = rawVersion ? (/^\d{1,15}$/.test(rawVersion) ? Number(rawVersion) : (issues.push("ai_connection_invalid:expectedVersion"), null)) : null;
  if (id && expectedVersion === null) issues.push("ai_connection_invalid:expectedVersion");
  const label = text(form, "label");
  if (!label || label.length > LABEL_MAX || CONTROL.test(label)) issues.push("ai_connection_invalid:label");
  const kind = text(form, "kind") === "cli" ? "cli" : text(form, "kind") === "api" ? "api" : (issues.push("ai_connection_invalid:kind"), "api");
  let baseUrl: string | null = null, cliTool: AiCliTool | null = null, cliModels: string[] = [], cliVersion: string | null = null;
  let key: AiConnectionInput["key"] = { mode: "keep" };
  if (kind === "api") {
    baseUrl = aiConnectionBaseUrl(text(form, "baseUrl"));
    if (!baseUrl) issues.push("ai_connection_invalid:baseUrl");
    const typed = text(form, "apiKey");
    if (text(form, "clearKey") === "1") key = { mode: "clear" };
    else if (typed) {
      if (typed.length > 4096 || /[\s\p{Cc}]/u.test(typed)) issues.push("ai_connection_invalid:apiKey");
      else key = { mode: "set", value: typed };
    }
  } else {
    const tool = text(form, "cliTool");
    cliTool = (AI_CLI_TOOLS as readonly string[]).includes(tool) ? tool as AiCliTool : (issues.push("ai_connection_invalid:cliTool"), null);
    cliModels = [...new Set(text(form, "cliModels").split(/[\s,]+/).map(value => value.trim()).filter(Boolean))];
    if (!cliModels.length || cliModels.length > (cliTool === "opencode" ? 512 : 32) || cliModels.some(model => !CLI_MODEL.test(model))) issues.push("ai_connection_invalid:cliModels");
    cliVersion = text(form, "cliVersion") || null;
    if (cliVersion && (cliVersion.length > 80 || CONTROL.test(cliVersion))) issues.push("ai_connection_invalid:cliVersion");
    key = { mode: "clear" };
  }
  const deviceId = text(form, "deviceId") || aiDeviceSlug(label);
  if (deviceId.length > DEVICE_MAX || CONTROL.test(deviceId) || /\s/.test(deviceId)) issues.push("ai_connection_invalid:deviceId");
  const rawSlots = text(form, "capacitySlots") || "1";
  const capacitySlots = /^\d{1,3}$/.test(rawSlots) && Number(rawSlots) >= 1 && Number(rawSlots) <= 256 ? Number(rawSlots) : (issues.push("ai_connection_invalid:capacitySlots"), 1);
  const rawContext = kind === "api" ? text(form, "contextTokens") : "";
  const contextTokens = !rawContext ? null : /^\d{1,7}$/.test(rawContext) && Number(rawContext) >= 1 && Number(rawContext) <= AI_CONNECTION_CONTEXT_MAX
    ? Number(rawContext) : (issues.push("ai_connection_invalid:contextTokens"), null);
  const note = text(form, "note") || null;
  if (note && (note.length > NOTE_MAX || CONTROL.test(note))) issues.push("ai_connection_invalid:note");
  const enabled = text(form, "enabled") !== "0";
  if (issues.length) return { input: null, issues };
  return { input: Object.freeze({ id, expectedVersion, label, kind, baseUrl, key, cliTool, cliModels, deviceId, capacitySlots, contextTokens, enabled, note, cliVersion }), issues };
}

/** 「작업 ↔ 모델」 한 줄의 폼 칸 이름(RankSelects slotNames). */
export const AI_RANK_SLOT_NAMES = Object.freeze(Array.from({ length: AI_TASK_RANK_MAX }, (_, index) =>
  Object.freeze({ provider: `rank${index + 1}Connection`, model: `rank${index + 1}Model`, reasoningEffort: `rank${index + 1}ReasoningEffort` })));

export type AiTaskRanksInput = Readonly<{ task: string; slot: number; revision: string; ranks: (AiRankChoice | null)[] }>;
/** 「작업 ↔ 모델」 한 줄 폼 → 입력(빈 칸 = 「없음」). */
export function aiTaskRanksInputFromForm(form: FormLike): { input: AiTaskRanksInput | null; issues: string[] } {
  const task = text(form, "task"), rawSlot = text(form, "slot"), revision = text(form, "revision");
  const issues: string[] = [];
  if (!aiTask(task)) issues.push("ai_task_invalid:task");
  const slot = /^\d$/.test(rawSlot) ? Number(rawSlot) : (issues.push("ai_task_invalid:slot"), 1);
  if (!/^[a-f0-9]{64}$/.test(revision)) issues.push("ai_task_invalid:revision");
  const ranks = AI_RANK_SLOT_NAMES.map(names => {
    const connection = text(form, names.provider), model = text(form, names.model);
    if (!connection && !model) return null;
    if (!UUID.test(connection) || !model || model.length > 200 || CONTROL.test(model)) { issues.push("ai_task_invalid:rank"); return null; }
    const rawEffort = form.get(names.reasoningEffort);
    const reasoningEffort = typeof rawEffort === "string" ? rawEffort.trim() : undefined;
    if (reasoningEffort !== undefined && !/^[a-z0-9_-]{0,32}$/.test(reasoningEffort)) issues.push("ai_task_invalid:rank");
    return { provider: connection, model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) };
  });
  return issues.length ? { input: null, issues } : { input: Object.freeze({ task, slot, revision, ranks }), issues };
}

/** 키 순서를 고정한 값(hash 입력). */
export function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson((value as Record<string, unknown>)[key])]));
  return value;
}

// ── 선택지 ───────────────────────────────────────────────────────────────────────────────────────────────

/** API uses the last /models list; OpenCode requires verified host metadata; other CLI tools keep their registered names. */
export const aiConnectionModelIds = (connection: Pick<AiConnectionView, "kind" | "models" | "cliModels"> & Partial<Pick<AiConnectionView, "cliTool" | "cliCatalog">>): string[] => {
  if (connection.kind === "api") return (connection.models ?? []).map(model => model.id);
  if (connection.cliTool === "opencode") {
    const verified = new Set(connection.cliCatalog?.models.map(model => model.id) ?? []);
    return connection.cliModels.filter(model => verified.has(model));
  }
  return [...connection.cliModels];
};

/** 작업이 실제로 고를 수 있는 모델 id — OpenCode chat은 DeepSeek, vision은 카탈로그의 실제 vision=true만. 그 밖의 CLI/API는 기존과 같다. */
export const aiTaskConnectionModelIds = (task: AiTaskDef, connection: Pick<AiConnectionView, "kind" | "models" | "cliModels"> & Partial<Pick<AiConnectionView, "cliTool" | "cliCatalog">>): string[] => {
  if (connection.kind === "cli" && connection.cliTool === "opencode") {
    if (task.kind === "vision") return (connection.cliCatalog?.models ?? []).filter(model => model.vision === true && /deepseek/i.test(model.id) && connection.cliModels.includes(model.id)).map(model => model.id);
    const ids = aiConnectionModelIds(connection);
    if (task.kind === "chat") return ids.filter(id => id.toLowerCase().includes("deepseek"));
    return ids;
  }
  return aiConnectionModelIds(connection);
};
export const aiConnectionLabel = (connection: Pick<AiConnectionView, "label" | "kind" | "cliTool"> & Partial<Pick<AiConnectionView, "deviceId" | "baseUrl">>) => {
  if (connection.kind === "api" && connection.deviceId === "m1-qwen" && connection.baseUrl === "https://m1-studio.tail02799e.ts.net/v1")
    return "M1 Studio · Gemma";
  return connection.kind === "cli" && connection.cliTool && !connection.label.toLowerCase().includes("cli")
    ? `${connection.label}(${AI_CLI_TOOL_LABELS[connection.cliTool]})` : connection.label;
};

/**
 * 한 작업의 선택지: 이 작업이 받는 켜진 연결마다 그 연결이 실제로 내놓는 모델 하나씩 — 「연결 이름 · 모델」. 지금 저장된 값이 목록에 없으면
 * 「(저장된 값 · 지금 목록에 없음)」으로 남긴다(저장 누락으로 지우지 않는다). 순서: API 연결 먼저, 그다음 CLI, 같은 쪽은 이름순.
 */
export function aiTaskRankOptions(task: AiTaskDef, connections: readonly AiConnectionView[], saved: readonly Pick<AiTaskRankRow, "connectionId" | "model">[]): AiRankOption[] {
  const options: AiRankOption[] = [];
  const seen = new Set<string>();
  const sorted = [...connections].sort((a, b) => Number(a.kind === "cli") - Number(b.kind === "cli") || a.label.localeCompare(b.label));
  for (const connection of sorted) {
    if (!connection.enabled || !aiTaskAccepts(task, connection)) continue;
    for (const model of aiTaskConnectionModelIds(task, connection)) {
      const key = `${connection.id}\u0000${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ provider: connection.id, model, label: `${aiConnectionLabel(connection)} · ${model}`, group: aiConnectionLabel(connection), text: model, reasoningEfforts: aiRankReasoningEfforts(task.id, connection, model) });
    }
  }
  for (const row of saved) {
    const key = `${row.connectionId}\u0000${row.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const connection = connections.find(entry => entry.id === row.connectionId), group = connection ? aiConnectionLabel(connection) : "지워진 연결";
    options.push({ provider: row.connectionId, model: row.model, saved: true, group, text: `${row.model} (목록에 없음)`,
      label: `${group} · ${row.model} (저장된 값 · 지금 목록에 없음)`, reasoningEfforts: connection ? aiRankReasoningEfforts(task.id, connection, row.model) : [] });
  }
  return options;
}

/**
 * 이 칸(rank = index + 1)에서 고를 수 없는 선택지인가(순수, 화면이 드롭다운에서 흐리게 둔다 — 저장 검증 validateAiTaskRanks 는 그대로 막는다):
 * 벡터·재정렬의 2·3순위는 1순위와 같은 모델만, 나란한 칸(2차 투표자)은 다른 칸에 저장된 모델(같은 가중치 포함)을 고를 수 없다. 지금 이 칸의 값은 늘 고를 수 있다.
 */
export function aiRankOptionBlocked(task: Pick<AiTaskDef, "id" | "slots" | "sameModelAcrossRanks">, slot: number, index: number, option: AiRankChoice,
  slots: readonly (AiRankChoice | null)[], rows: readonly Pick<AiTaskRankRow, "task" | "slot" | "model">[]): boolean {
  const mine = slots[index];
  if (mine && mine.provider === option.provider && mine.model === option.model) return false;
  if (task.sameModelAcrossRanks && index > 0 && slots[0] && slots[0].model !== option.model) return true;
  return task.slots > 1 && rows.some(row => row.task === task.id && row.slot !== slot && aiSameUnderlyingModel(row.model, option.model));
}

export const AI_KEY_CONFLICT_TEXT = "같은 주소의 계약 키가 서로 다름";
/**
 * 켜진 API 연결 중 모델 목록을 못 읽은 것 — 그 서버의 모델은 드롭다운에 없다(화면이 까닭과 함께 위에 알린다).
 * keyConflicts = 키가 없고 같은 주소의 계약 키가 서로 달라 자동으로 채우지 않은 연결 id(목록을 읽었어도 키가 필요해 순위를 쓸 수 없으니 함께 알린다).
 */
export function aiUnreadConnections(connections: readonly AiConnectionView[], keyConflicts: readonly string[] = []): { id: string; label: string; reason: string }[] {
  const conflict = new Set(keyConflicts);
  return connections.filter(row => row.enabled && row.kind === "api" && (row.models === null || row.models.length === 0 || (!row.hasKey && conflict.has(row.id))))
    .map(row => ({ id: row.id, label: row.label, reason: [row.hasKey ? "" : "키 없음", !row.hasKey && conflict.has(row.id) ? AI_KEY_CONFLICT_TEXT : "",
      row.models === null || row.models.length === 0 ? aiModelsErrorText(row.modelsError) ?? (row.models === null ? "아직 못 읽음" : "모델 0개") : ""].filter(Boolean).join(" · ") }));
}

// ── 검증 ───────────────────────────────────────────────────────────────────────────────────────────────

export type AiRankValidationContext = Readonly<{
  connections: readonly AiConnectionView[];
  /** 모든 작업의 지금 행(같은 칸의 저장된 값, 다른 칸·다른 작업과의 규칙에 쓴다) */
  rows: readonly AiTaskRankRow[];
}>;

/**
 * 한 줄(작업 × 칸)의 1·2·3순위 검증(순수, 한국어). 저장을 막는 문제만 낸다:
 * 빈 칸 뒤 순위 · 없는/꺼진 연결 · 작업이 받지 않는 연결(API·CLI 도구) · 연결이 내놓지 않는 모델(저장된 값은 그대로 둘 수 있다) ·
 * 벡터·재정렬의 「2·3순위도 같은 모델」 · 검색어 벡터 = 제품 벡터 모델 · 2차 투표자끼리 같은 1순위 모델.
 */
export function validateAiTaskRanks(taskId: string, slot: number, ranks: readonly (AiRankChoice | null)[], context: AiRankValidationContext): string[] {
  const task = aiTask(taskId);
  if (!task) return ["알 수 없는 작업입니다."];
  const name = aiTaskSlotLabel(task, slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > task.slots) return [`${task.label}에는 ${slot}번 칸이 없습니다.`];
  const issues: string[] = [];
  if (ranks.length > AI_TASK_RANK_MAX) issues.push(`${name}은(는) ${AI_TASK_RANK_MAX}순위까지 고를 수 있습니다.`);
  const firstEmpty = ranks.findIndex(row => !row);
  if (firstEmpty >= 0 && ranks.slice(firstEmpty + 1).some(Boolean))
    issues.push(`${firstEmpty + 1}순위를 비우고 그 뒤 순위만 고를 수 없습니다. ${firstEmpty + 1}순위부터 차례로 골라주세요.`);
  const saved = context.rows.filter(row => row.task === task.id && row.slot === slot);
  ranks.forEach((row, index) => {
    if (!row) return;
    const rank = index + 1, connection = context.connections.find(entry => entry.id === row.provider);
    if (!connection) { issues.push(`${rank}순위: 연결을 찾지 못했습니다(지워졌을 수 있습니다). 다시 골라주세요.`); return; }
    if (!connection.enabled) issues.push(`${rank}순위: 연결 「${connection.label}」이 꺼져 있습니다. AI 연결에서 켜거나 다른 연결을 고르세요.`);
    if (!aiTaskAccepts(task, connection)) issues.push(connection.kind === "api"
      ? `${rank}순위: ${task.label}은(는) API 주소 연결을 받지 않습니다(CLI ${task.cliTools.map(tool => AI_CLI_TOOL_LABELS[tool]).join("·") || "없음"}만).`
      : `${rank}순위: ${task.label}은(는) ${connection.cliTool ? AI_CLI_TOOL_LABELS[connection.cliTool] : "이 CLI"}를 받지 않습니다.`);
    if (row.reasoningEffort && !aiRankReasoningEfforts(task.id, connection, row.model).includes(row.reasoningEffort))
      issues.push(`${rank}순위: 이 작업·모델에서 추론 강도 ${row.reasoningEffort}을(를) 실행할 수 없습니다.`);
    const offered = aiTaskConnectionModelIds(task, connection).includes(row.model);
    const keptSaved = saved.some(entry => entry.connectionId === row.provider && entry.model === row.model);
    const visionUnverified = task.kind === "vision" && connection.kind === "cli" && connection.cliTool === "opencode" && !offered;
    if (visionUnverified) issues.push(`${rank}순위: ${task.label}은(는) 실제 vision 지원이 확인된 모델만 쓸 수 있습니다. AI 연결에서 M3 호스트 목록을 다시 조회해 vision=true 모델을 고르세요.`);
    else if (!offered && !keptSaved) issues.push(connection.kind === "api"
      ? `${rank}순위: 「${connection.label}」의 모델 목록에 ${row.model}이(가) 없습니다. AI 연결에서 「다시 읽기」로 목록을 새로 읽으세요.`
      : `${rank}순위: 「${connection.label}」에 ${row.model} 모델 이름이 없습니다. AI 연결에서 CLI 모델 이름에 더하세요.`);
    // Review resumes identify provider/model. Repeated CLI ranks must therefore resolve to the same options.
    const earlier = ranks.slice(0, index).findIndex(other => other && other.provider === row.provider && other.model === row.model);
    if (connection.kind === "cli" && earlier >= 0 && (ranks[earlier]?.reasoningEffort || "") !== (row.reasoningEffort || ""))
      issues.push(`${earlier + 1}순위와 ${rank}순위의 같은 CLI 모델은 추론 강도도 같게 설정하세요. 대기 작업을 같은 설정으로 이어가기 위한 조건입니다.`);
    if (task.sameModelAcrossRanks && index > 0 && ranks[0] && ranks[0].model !== row.model)
      issues.push(`${rank}순위: ${task.label}은(는) 2·3순위도 1순위와 같은 모델(${ranks[0].model})이어야 합니다.`);
  });
  const first = ranks[0];
  if (task.sameModelAs && first) {
    const other = aiTask(task.sameModelAs);
    const anchor = context.rows.find(row => row.task === task.sameModelAs && row.slot === 1 && row.rank === 1);
    if (anchor && anchor.model !== first.model)
      issues.push(`${task.label}은(는) ${other?.label ?? task.sameModelAs}의 1순위 모델(${anchor.model})과 같은 모델이어야 합니다.`);
  }
  // 나란한 칸(2차 투표자 1·2·3): 한 모델은 한 칸에만 둔다(PR C1) — 칸마다 1순위를 쓸 수 없으면 그 칸의 2·3순위가 표를 내므로, 같은 모델(같은 가중치·
  // 다른 서버 포함)이 두 칸에 있으면 한 항목에 같은 모델이 두 표를 낼 수 있다(예전에는 대체 목록을 투표자 모두가 나눠 써서 이 일이 생겼다)
  if (task.slots > 1) ranks.forEach((row, index) => {
    if (!row) return;
    const clash = context.rows.find(other => other.task === task.id && other.slot !== slot && aiSameUnderlyingModel(other.model, row.model));
    if (clash) issues.push(`${index + 1}순위: ${task.slotLabel ?? "칸"} ${clash.slot}의 ${clash.rank}순위와 같은 모델(${row.model})입니다. 한 모델은 한 ${task.slotLabel ?? "칸"} 칸에만 둘 수 있습니다 — `
      + "같은 모델이 한 항목에 두 표를 낼 수 없습니다.");
  });
  return [...new Set(issues)];
}

/**
 * 같은 가중치의 모델인가(순수 — review-model-identity.ts bareModelName 과 같은 규칙): 연결로 가른 장부 이름의 꼬리(@<8자>)·앞의 자리 표시 대괄호·배포자 접두어(xxx/)·
 * 이미지 판별 꼬리를 떼고 소문자로 견준다. 화면이 그대로 읽어야 해서 등록부를 보지 않는다(순위의 모델은 엔진 이름이다).
 */
export function aiSameUnderlyingModel(a: string, b: string): boolean {
  const bare = (model: string) => model.trim().replace(/@[0-9a-f]{8}$/, "").replace(/^\[[^\]]*\]\s*/, "").replace(/^[^/\s]+\//, "").toLowerCase()
    .replace(/\+(?:vision(?:-shot2)?|prompt-v3)$/, "");
  return bare(a) !== "" && bare(a) === bare(b);
}

/** 저장은 받되 알릴 것(막지 않는다): 제품 벡터를 바꾸면 검색어 벡터도 맞춰야 한다 등. */
export function aiTaskRankNotices(taskId: string, ranks: readonly (AiRankChoice | null)[], rows: readonly AiTaskRankRow[]): string[] {
  const first = ranks[0];
  const notices: string[] = [];
  for (const dependent of AI_TASKS.filter(row => row.sameModelAs === taskId)) {
    const theirs = rows.find(row => row.task === dependent.id && row.slot === 1 && row.rank === 1);
    if (first && theirs && theirs.model !== first.model)
      notices.push(`${dependent.label}의 1순위(${theirs.model})가 이 모델과 다릅니다 — ${dependent.label}도 같은 모델로 바꿔야 합니다.`);
  }
  return notices;
}

// ── 저장 전 준비 확인 ─────────────────────────────────────────────────────────────────────────────────────

export type AiPolicyRoute = Readonly<{ routeId: string; provider: string; model: string; providerBudgetId: string; groupId: string }>;
export type AiReadinessInput = Readonly<{
  /** 서버에서만 계산하는 CLI 장부 이름. 클라이언트 공유 규칙은 node 모듈을 불러오지 않는다. */
  cliEngineIdentity?: (model: string, source: CliEngineSource) => string;
  /** 켜진 계약 행(model_serving_contracts, 키 없이). provider·endpoint·engineModel 은 계약 JSON 의 값(engineModel 은 연결로 가른 이름의 계약만, PR B) */
  contracts: readonly Readonly<{ routeId: string; model: string; provider: string | null; endpoint: string | null; transport: string; engineModel?: string | null;
    /** CLI 계약 행(`cli:<provider>:<route>`)의 버전(PR C1) */
    cliVersion?: string | null;
    /** CLI 엔진 계약의 배포 리비전 — prepared source와 다르면 계약을 새로 만든다. */
    deploymentRevision?: string | null }>[];
  /** 고정 로컬 경로의 계약(backendId = 정책 route 의 providerBudgetId) */
  localContract: (backendId: string) => Readonly<{ model: string; endpoint: string | null }> | null;
  /** 엔진 직접 계약을 만들 수 있는 경로(admin-engine-connect ENGINE_CONNECT_ROUTES + 2차 second-review, PR C1) */
  engineRoutes: readonly string[];
  /** CLI 계약을 DB 행으로 만드는 route(cli-serving-contract CLI_DB_CONTRACT_ROUTES — 1차·2차·Grok 로그인 유지, PR C1). 없으면 빈 목록 */
  cliContractRoutes?: readonly string[];
  policy: Readonly<{ mode: string; routes: readonly AiPolicyRoute[]; groupLimits: Readonly<Record<string, number>> }> | null;
  devices: ReadonlyMap<string, Readonly<{ enabled: boolean; limitSlots: number }>>;
}>;
export type AiRankReadiness = Readonly<{
  rank: number; connectionId: string; model: string;
  /** 장부·정책 route·계약 행의 model 열쇠(보통 model 그대로, 같은 모델을 다른 연결에도 둔 순위는 연결로 가른 이름 — PR B) */
  identity: string;
  /** 저장을 막는 것(한국어) */
  blocking: readonly string[];
  /** 막지 않지만 알릴 것 */
  warnings: readonly string[];
  /** 저장이 만들 것 */
  createDevice: Readonly<{ deviceId: string; limitSlots: number }> | null;
  /** identity = 만들 계약의 model 열쇠, engineModel = 엔진에 보낼 이름(identity 가 연결로 가른 이름일 때만) */
  createContract: Readonly<{ routeId: string; replacesGateway: boolean; identity: string; engineModel: string | null; cliEngine?: CliEngineSource }> | null;
  appendRoute: AiPolicyRoute | null;
  /** 저장이 만들(또는 버전을 바꿀) CLI 계약 행(PR C1 — 1차·2차·Grok 로그인 유지 route 만, 연결의 CLI 버전으로) */
  createCliContract: Readonly<{ routeId: string; provider: string; model: string; cliVersion: string; replaces: string | null }> | null;
  /** 이 순위를 부를 provider(장부·계약 이름) */
  provider: string | null;
}>;

const contractBase = (endpoint: string | null) => endpoint ? aiConnectionBaseUrl(endpoint) : null;

/**
 * 순위 하나가 오늘 실행 쪽에서 쓰일 수 있는지와 저장이 만들 것(순수). 만들 수 있는 것: 장비 행(없을 때), 엔진 직접 계약(engine-route·review-ai1 의 abcllm 경로),
 * 정책 route(abcllm·CLI — 같은 장비의 다른 route 가 쓰는 예산 이름을 따른다). 그 밖에 없는 것은 막는다(blocking): 계약이 다른 서버를 가리킴, 정책 route 가
 * 다른 장비에 있음, 로컬·2차 계약 없음, 꺼진 장비. 확인할 수 없는 것(CLI 계약·보강 경로)은 경고로만 알린다.
 */
export function aiRankReadiness(task: AiTaskDef, rank: number, connection: AiConnectionView, model: string, input: AiReadinessInput, reasoningEffort?: string): AiRankReadiness {
  const blocking: string[] = [], warnings: string[] = [];
  let createDevice: AiRankReadiness["createDevice"] = null, createContract: AiRankReadiness["createContract"] = null, appendRoute: AiPolicyRoute | null = null;
  let createCliContract: AiRankReadiness["createCliContract"] = null;
  let provider: string | null = null, identity = model;
  const head = `${rank}순위 ${connection.label} · ${model}`;
  const result = () => Object.freeze({ rank, connectionId: connection.id, model, identity, blocking: Object.freeze(blocking), warnings: Object.freeze(warnings),
    createDevice, createContract, appendRoute, createCliContract, provider });
  const routeId = task.routeId;
  const policyRoutes = input.policy?.routes ?? [];
  const budgetFor = (deviceId: string) => policyRoutes.find(route => route.groupId === deviceId)?.providerBudgetId ?? deviceId;
  /** 정책 route 확인 — 있으면 장비가 연결의 장비와 같아야 한다. 없으면 appendable 일 때 덧붙일 route 를 정한다. */
  const checkRoute = (routeProvider: string, appendable: boolean, why: string): string | null => {
    if (!routeId) return null;
    if (input.policy === null) { blocking.push(`${head}: 용량 정책을 읽지 못해 경로를 확인하지 못했습니다. 잠시 뒤 다시 저장하세요.`); return null; }
    if (input.policy.mode === "disabled") { warnings.push(`${head}: 용량 관리가 꺼져 있어 경로를 확인하지 않았습니다.`); return null; }
    const known = policyRoutes.find(route => route.routeId === routeId && route.provider === routeProvider && route.model === identity);
    if (known) {
      if (known.groupId !== connection.deviceId)
        blocking.push(`${head}: 용량 정책의 ${routeId} / ${routeProvider} / ${identity} 경로는 장비 ${known.groupId}에 있습니다. 연결의 장비 이름을 ${known.groupId}(으)로 바꾸거나 용량 정책을 고치세요.`);
      return known.groupId;
    }
    if (!appendable) { blocking.push(`${head}: 용량 정책에 ${routeId} / ${routeProvider} / ${identity} 경로가 없습니다. ${why}`); return null; }
    const sibling = policyRoutes.find(route => route.routeId === routeId && route.provider === routeProvider);
    if (routeProvider !== "abcllm" && sibling && sibling.groupId !== connection.deviceId) {
      blocking.push(`${head}: 같은 경로의 다른 모델이 장비 ${sibling.groupId}에 있습니다. 연결의 장비 이름을 ${sibling.groupId}(으)로 맞추세요.`);
      return null;
    }
    appendRoute = Object.freeze({ routeId, provider: routeProvider, model: identity, groupId: connection.deviceId,
      providerBudgetId: routeProvider === "abcllm" ? budgetFor(connection.deviceId) : sibling?.providerBudgetId ?? budgetFor(connection.deviceId) });
    return connection.deviceId;
  };
  const checkDevice = (deviceId: string | null) => {
    if (!deviceId || !routeId || input.policy?.mode === "disabled") return;
    const device = input.devices.get(deviceId);
    if (device && !device.enabled) blocking.push(`${head}: 장비 ${deviceId}가 꺼져 있습니다. 장비 한도 화면에서 켜야 이 순위가 쓰입니다.`);
    if (!device) createDevice = Object.freeze({ deviceId, limitSlots: input.policy?.groupLimits[deviceId] ?? connection.capacitySlots });
  };

  const nativeCliEngineExcluded = task.id === "product-audit" || task.id === "product-intro-check";
  if (!nativeCliEngineExcluded && aiTaskUsesCliEngine(task.id, connection)) {
    if (!connection.baseUrl) { blocking.push(`${head}: CLI 엔진 주소가 없습니다.`); return result(); }
    if (!connection.hasKey) { blocking.push(`${head}: CLI 엔진 HTTP 인증 정보가 없습니다. AI 연결에서 키를 저장하세요.`); return result(); }
    const catalogModel = connection.cliCatalog?.models.find(entry => entry.id === model);
    if (!catalogModel) { blocking.push(`${head}: 실제 CLI 카탈로그에 ${model} 모델이 없습니다.`); return result(); }
    const maxModelLen = catalogModel.maxModelLen;
    if (!(typeof maxModelLen === "number" && maxModelLen > 0 && maxModelLen <= 2097152)) {
      blocking.push(`${head}: 모델 context(${maxModelLen ?? "없음"})가 1~2097152 범위가 아닙니다.`); return result();
    }
    if (reasoningEffort && !(catalogModel.variants ?? []).includes(reasoningEffort)) {
      blocking.push(`${head}: 이 모델에서 추론 강도 ${reasoningEffort}을(를) 실행할 수 없습니다.`); return result();
    }
    if (task.kind === "vision" && catalogModel.vision !== true) {
      blocking.push(`${head}: 실제 vision 지원이 확인된 모델이 아닙니다.`); return result();
    }
    const engineSource: CliEngineSource = { connectionId: connection.id, ...(reasoningEffort ? { reasoningEffort } : {}) };
    try {
      cliEngineEndpoint(connection.baseUrl);
    } catch {
      blocking.push(`${head}: CLI 엔진 주소를 확인하세요.`);
      return result();
    }
    provider = "abcllm";
    if (!input.cliEngineIdentity) {
      blocking.push(`${head}: CLI 계약 정보를 읽지 못했습니다. 다시 시도하세요.`);
      return result();
    }
    identity = input.cliEngineIdentity(model, engineSource);
    const existing = task.routeId
      ? input.contracts.find(entry => entry.routeId === task.routeId && entry.model === identity)
      : undefined;
    if (existing) {
      if (existing.provider !== "abcllm" || existing.transport !== "direct"
        || contractBase(existing.endpoint) !== connection.baseUrl
        || existing.engineModel !== model
        || existing.deploymentRevision !== cliEngineRevision(engineSource)) {
        blocking.push(`${head}: CLI 연결·모델·추론 강도가 저장된 계약과 다릅니다.`);
        return result();
      }
    } else if (task.routeId && input.engineRoutes.includes(task.routeId)) {
      createContract = Object.freeze({
        routeId: task.routeId,
        replacesGateway: false,
        identity,
        engineModel: model,
        cliEngine: engineSource,
      });
    } else {
      blocking.push(`${head}: 이 작업의 CLI 실행 경로를 준비할 수 없습니다.`);
      return result();
    }
    checkDevice(checkRoute(provider, true, ""));
    return result();
  }
  if (connection.kind === "cli") {
    provider = connection.cliTool ? AI_CLI_TOOL_PROVIDERS[connection.cliTool] : null;
    if (!provider) { blocking.push(`${head}: CLI 도구를 알 수 없습니다.`); return result(); }
    checkDevice(checkRoute(provider, true, ""));
    if (routeId && ((input.cliContractRoutes ?? []).includes(routeId) || provider === "opencode-cli" && OPENCODE_NATIVE_TASK_ROUTES.includes(routeId))) {
      // 1차·2차·Grok 로그인 유지(PR C1): CLI 계약은 이 저장이 연결의 CLI 버전으로 만든다(env CLI_SERVING_CONTRACTS 는 읽지 않는다). 버전은 워커가 부를 때 견준다
      const version = connection.cliVersion?.trim() || null;
      const row = input.contracts.find(entry => entry.routeId === `cli:${provider}:${routeId}` && entry.model === model);
      if (!version) blocking.push(connection.cliTool === "opencode" ? `${head}: M3 호스트의 CLI 버전이 없습니다. AI 연결에서 실제 목록을 조회한 뒤 연결을 저장하세요.`
        : `${head}: 연결에 CLI 버전이 없습니다. AI 연결에서 「CLI 버전」(워커의 \`${connection.cliTool} --version\` 출력 그대로)을 적은 뒤 저장하세요.`);
      else if (!row || row.cliVersion !== version)
        createCliContract = Object.freeze({ routeId, provider, model, cliVersion: version, replaces: row?.cliVersion ?? null });
      if (version) warnings.push(connection.cliTool === "opencode" ? `${head}: M3 호스트에서 조회한 CLI 버전(${version})을 사용합니다. 목록 확인은 모델 호출 성공과 별개이며, 실행 전에 호스트가 버전·모델을 다시 확인합니다.`
        : `${head}: CLI 버전(${version})은 이 화면이 확인하지 못합니다 — 워커가 부를 때 \`--version\` 과 다르면 이 순위는 쓰이지 않습니다(상태 화면에 까닭).`);
    } else if (routeId) warnings.push(`${head}: CLI 계약(connect 에이전트 쪽)은 이 화면이 확인하지 못합니다. 계약이 없으면 이 순위는 쓰이지 않습니다.`);
    return result();
  }
  const base = connection.baseUrl;
  switch (task.wiring) {
    case "uncapped": return result();
    case "deferred":
      warnings.push(`${head}: 이 작업의 연결 계약·용량 경로 규칙은 아직 정해지지 않아 확인하지 않았습니다(다음 단계에서 정합니다).`);
      return result();
    case "engine-route": case "review-ai1": case "review-ai2": {
      // PR B(text)·PR C1(1차·2차): 실행 쪽이 순위마다 「그 연결을 가리키는 계약」(끝점 = 연결 주소, 엔진 모델 = 순위 모델)을 찾는다
      // (lib/llm/ai-task-resolver.ts·lib/crawl/review-task-ranks.ts). 1차·2차는 abcllm 형 total-bound 계약(transport direct — 엔진에 바로)을 만든다.
      // 같은 모델 이름의 계약이 다른 서버에 있으면 연결로 가른 이름(<모델>@<연결 id 앞 8자>)으로 따로 계약·용량 경로를 둔다 — 두 서버를 두 순위로 쓸 수 있다.
      const isDirect = (entry: AiReadinessInput["contracts"][number]) => entry.transport === "direct" || entry.provider === "local-direct";
      const wireOf = (entry: AiReadinessInput["contracts"][number]) => entry.provider === "local-direct" ? entry.model : entry.engineModel ?? entry.model;
      const own = input.contracts.filter(entry => entry.routeId === routeId && isDirect(entry) && contractBase(entry.endpoint) === base && wireOf(entry) === model)
        .sort((a, b) => Number(a.provider === "local-direct") - Number(b.provider === "local-direct") || Number(a.model !== model) - Number(b.model !== model));
      provider = "abcllm";
      if (own.length) {
        identity = own[0].model;
        provider = own[0].provider === "local-direct" ? "local-direct" : "abcllm";
      } else if (!routeId || !input.engineRoutes.includes(routeId)) {
        blocking.push(`${head}: ${routeId} 경로의 연결 계약이 없고 자동으로 만들 수 없습니다.`);
      } else {
        const plain = input.contracts.find(entry => entry.routeId === routeId && entry.model === model);
        if (!plain || !isDirect(plain)) createContract = Object.freeze({ routeId, replacesGateway: !!plain, identity: model, engineModel: null });
        else {
          const alias = aiTaskAliasIdentity(model, connection.id);
          const taken = alias ? input.contracts.find(entry => entry.routeId === routeId && entry.model === alias) : undefined;
          if (!alias) blocking.push(`${head}: 같은 모델 이름의 계약이 다른 서버에 있는데 모델 이름이 길어 연결로 가른 이름을 만들 수 없습니다.`);
          else if (taken) blocking.push(`${head}: ${routeId} 경로의 ${alias} 계약이 다른 서버(${aiConnectionHost(contractBase(taken.endpoint)) ?? "주소 없음"})를 가리킵니다. `
            + "서빙 계약·등록부 화면에서 그 계약을 고치세요.");
          else {
            identity = alias;
            createContract = Object.freeze({ routeId, replacesGateway: false, identity: alias, engineModel: model });
            warnings.push(`${head}: 같은 모델 이름의 계약이 다른 서버(${aiConnectionHost(contractBase(plain.endpoint)) ?? "주소 없음"})에 있어 이 연결은 장부 이름 ${alias}(으)로 `
              + `따로 계약·용량 경로를 둡니다 — 엔진에는 ${model}이(가) 나갑니다.`);
          }
        }
      }
      checkDevice(checkRoute(provider, provider === "abcllm", "로컬 직접 경로는 예산·장비 이름이 계약과 같아야 해서 자동으로 만들지 않습니다."));
      return result();
    }
    case "local-direct": {
      provider = "local-direct";
      const group = checkRoute("local-direct", false, "로컬 직접 경로는 예산·장비 이름이 계약과 같아야 해서 자동으로 만들지 않습니다(용량 정책 개정).");
      const route = policyRoutes.find(entry => entry.routeId === routeId && entry.provider === "local-direct" && entry.model === model);
      if (route) {
        const contract = input.localContract(route.providerBudgetId);
        if (!contract) blocking.push(`${head}: 로컬 직접 계약(${route.providerBudgetId})이 없습니다.`);
        else if (contract.model !== model || contractBase(contract.endpoint) !== base)
          blocking.push(`${head}: 로컬 직접 계약(${route.providerBudgetId})은 ${aiConnectionHost(contractBase(contract.endpoint)) ?? "다른 서버"} · ${contract.model}입니다.`);
      }
      checkDevice(group);
      return result();
    }
  }
}

/**
 * 한 줄(작업 × 칸)의 순위들을 차례로 확인한다 — 앞 순위가 만들 계약을 뒤 순위가 본다(PR B). 둘 다 계약이 없는 같은 모델을 다른 연결로 고르면
 * 1순위는 모델 이름 그대로, 2순위는 연결로 가른 이름으로 계약을 만든다(한 저장에서 같은 계약 열쇠를 두 서버로 만들지 않는다).
 */
export function aiRanksReadiness(task: AiTaskDef, ranks: readonly Readonly<{ rank: number; connection: AiConnectionView; model: string; reasoningEffort?: string }>[],
  input: AiReadinessInput): AiRankReadiness[] {
  const contracts = [...input.contracts];
  return ranks.map(entry => {
    const ready = aiRankReadiness(task, entry.rank, entry.connection, entry.model, { ...input, contracts }, entry.reasoningEffort);
    if (ready.createContract && entry.connection.baseUrl)
      contracts.push({ routeId: ready.createContract.routeId, model: ready.createContract.identity, provider: "abcllm",
        endpoint: ready.createContract.cliEngine ? cliEngineEndpoint(entry.connection.baseUrl) : `${entry.connection.baseUrl}/chat/completions`, transport: "direct", engineModel: ready.createContract.engineModel,
        ...(ready.createContract.cliEngine ? { deploymentRevision: cliEngineRevision(ready.createContract.cliEngine) } : {}) });
    if (ready.createCliContract) contracts.push({ routeId: `cli:${ready.createCliContract.provider}:${ready.createCliContract.routeId}`,
      model: ready.createCliContract.model, provider: ready.createCliContract.provider, endpoint: null, transport: "direct", cliVersion: ready.createCliContract.cliVersion });
    return ready;
  });
}

/** 저장된 순위에 아직 없는 것(그 줄을 다시 저장하면 만든다) — 화면의 준비 상태 문장. */
export function aiRankPendingText(ready: Pick<AiRankReadiness, "rank" | "model" | "createContract" | "appendRoute" | "createDevice"> & Partial<Pick<AiRankReadiness, "createCliContract">>): string[] {
  const out: string[] = [];
  if (ready.createCliContract) out.push(`${ready.rank}순위 ${ready.model}: ${ready.createCliContract.routeId} CLI 계약이 ${ready.createCliContract.replaces
    ? `버전 ${ready.createCliContract.replaces}입니다` : "없습니다"} — 이 줄을 저장하면 연결의 CLI 버전(${ready.createCliContract.cliVersion})으로 ${ready.createCliContract.replaces ? "바꿉니다" : "만듭니다"}.`);
  if (ready.createContract) out.push(`${ready.rank}순위 ${ready.model}: ${ready.createContract.routeId} 엔진 직접 계약이 ${ready.createContract.replacesGateway
    ? "게이트웨이 계약뿐입니다" : "없습니다"} — 이 줄을 저장하면 엔진을 확인하고 만듭니다${ready.createContract.engineModel
    ? `(같은 모델이 다른 서버에도 있어 장부 이름 ${ready.createContract.identity})` : ""}.`);
  if (ready.appendRoute) out.push(`${ready.rank}순위 ${ready.model}: 용량 정책에 ${ready.appendRoute.routeId} / ${ready.appendRoute.provider} 경로가 없습니다 — 저장하면 덧붙입니다(DRAIN 없음).`);
  if (ready.createDevice) out.push(`${ready.rank}순위 ${ready.model}: 장비 행 ${ready.createDevice.deviceId}이(가) 없습니다 — 저장하면 ${ready.createDevice.limitSlots}칸으로 만듭니다.`);
  return out;
}

// ── 가져오기 계획 ────────────────────────────────────────────────────────────────────────────────────────

/** 지금 실행 쪽이 고르는 모델 하나(현재 값 계산이 만든다, lib/operations/admin-ai-task-current.ts). */
export type AiCurrentUse = Readonly<{
  kind: AiConnectionKind;
  /** API: 실제로 부르는 엔진 주소(`origin/v1`), 모르면 null */
  baseUrl: string | null;
  cliTool: AiCliTool | null;
  model: string;
  /** 오늘의 provider(abcllm·local-direct·claude-cli…) */
  provider: string;
  /** 어디서 왔나(설정 칸·등록부·환경변수 이름) */
  origin: string;
  /** 정책 route 의 장비(groupId) — 알면 */
  deviceId: string | null;
  /** 이 엔진의 저장 키를 가진 계약(가져오기가 키를 옮긴다) */
  keyFrom: Readonly<{ routeId: string; model: string }> | null;
  /** 이 엔진의 키를 담은 웹 프로세스 env 이름(값은 계획에 싣지 않는다 — 적용이 읽어 암호화한다) */
  keyEnv?: string | null;
  /** 요청에 모델 이름을 싣지 않는 서버(임베딩·재정렬): 이름은 그 서버의 /models 목록에서 고른다(하나뿐이면 그것) */
  serverNamed?: boolean;
  /** 순위별 덧붙임(분류 CLI effort 등) */
  options?: Readonly<Record<string, unknown>>;
  note?: string;
}>;
export type AiCurrentSlot = Readonly<{ task: string; slot: number; uses: readonly AiCurrentUse[];
  /** 고르기 출처 설명 */
  source: string;
  /** 계산하지 못했으면 그 까닭 */
  error: string | null;
  /** 옮기지 않는 까닭(예: 꺼져 있음) */
  skip: string | null; notes: readonly string[] }>;

export type AiImportConnection = Readonly<{
  key: string; action: "create" | "update" | "existing"; id: string | null; label: string; kind: AiConnectionKind; baseUrl: string | null;
  cliTool: AiCliTool | null; cliModels: readonly string[]; deviceId: string; capacitySlots: number; keyFrom: Readonly<{ routeId: string; model: string }> | null;
  keyEnv: string | null;
}>;
export type AiImportRank = Readonly<{ rank: number; connectionKey: string; model: string; origin: string; options: Readonly<Record<string, unknown>> }>;
export type AiImportSlot = Readonly<{ task: string; slot: number; action: "create" | "unchanged" | "differs" | "empty"; ranks: readonly AiImportRank[] }>;
export type AiImportPlan = Readonly<{ connections: readonly AiImportConnection[]; slots: readonly AiImportSlot[]; warnings: readonly string[] }>;
export type AiImportInput = Readonly<{
  current: readonly AiCurrentSlot[];
  connections: readonly AiConnectionView[];
  rows: readonly AiTaskRankRow[];
  /** 장비 이름 → 칸 수(장비 행, 없으면 정책 groupLimits) */
  deviceSlots: ReadonlyMap<string, number>;
  /** 엔진 주소의 호스트 → 등록부 장비 이름(이름 짓기 참고) */
  hostEquipment: ReadonlyMap<string, string>;
  /** 계획이 방금 읽은 /models 목록(주소 → 모델 id, 못 읽었으면 없음). 서버가 이름을 정하는 작업(serverNamed)의 모델 이름에 쓴다 */
  served?: ReadonlyMap<string, readonly string[]>;
}>;

const connectionKeyOf = (use: Pick<AiCurrentUse, "kind" | "baseUrl" | "cliTool">) => use.kind === "cli" ? `cli:${use.cliTool}` : `api:${use.baseUrl}`;

/**
 * 「지금 설정 → 작업 ↔ 모델 가져오기」 계획(순수). 오늘 실행 쪽이 고르는 모델(current)을 연결과 순위로 옮긴다 — 첫날 순위 = 오늘 동작.
 * - 연결: API 는 실제로 부르는 엔진 주소마다 하나(이미 같은 주소의 연결이 있으면 그것), CLI 는 도구마다 하나(있으면 쓰는 모델 이름만 더한다).
 *   주소를 지어내지 않는다 — 주소를 모르는 순위는 옮기지 않고 경고한다. 이름 = 정책 route 의 장비 이름, 없으면 등록부 장비, 없으면 호스트.
 * - 순위: 칸마다 지금 순서대로 1·2·3(같은 연결·모델은 한 번, 넷째부터는 경고). 이미 저장된 칸은 덮지 않는다(같으면 「그대로」, 다르면 「다름 — 건너뜀」).
 */
export function buildAiImportPlan(input: AiImportInput): AiImportPlan {
  const warnings: string[] = [];
  const connections = new Map<string, AiImportConnection>();
  const labels = new Set(input.connections.map(connection => connection.label.toLowerCase()));
  const uniqueLabel = (wanted: string) => {
    let label = wanted.slice(0, LABEL_MAX), n = 2;
    while (labels.has(label.toLowerCase())) label = `${wanted.slice(0, LABEL_MAX - 5)} (${n++})`;
    labels.add(label.toLowerCase());
    return label;
  };
  const connectionFor = (use: AiCurrentUse): AiImportConnection | null => {
    const key = connectionKeyOf(use);
    const known = connections.get(key);
    if (known) {
      if (use.kind === "cli" && !known.cliModels.includes(use.model)) {
        const next = { ...known, cliModels: Object.freeze([...known.cliModels, use.model]), action: known.action === "existing" ? "update" as const : known.action };
        connections.set(key, next);
        return next;
      }
      if (use.kind === "api" && known.action === "create" && !known.keyFrom && !known.keyEnv && (use.keyFrom || use.keyEnv))
        connections.set(key, { ...known, keyFrom: use.keyFrom, keyEnv: use.keyFrom ? null : use.keyEnv ?? null });
      return connections.get(key)!;
    }
    const existing = input.connections.find(connection => use.kind === "cli" ? connection.kind === "cli" && connection.cliTool === use.cliTool
      : connection.kind === "api" && connection.baseUrl === use.baseUrl);
    if (existing) {
      const models = use.kind === "cli" && !existing.cliModels.includes(use.model) ? [...existing.cliModels, use.model] : [...existing.cliModels];
      const entry: AiImportConnection = Object.freeze({ key, action: models.length !== existing.cliModels.length ? "update" : "existing", id: existing.id, label: existing.label,
        kind: existing.kind, baseUrl: existing.baseUrl, cliTool: existing.cliTool, cliModels: Object.freeze(models), deviceId: existing.deviceId,
        capacitySlots: existing.capacitySlots, keyFrom: null, keyEnv: null });
      connections.set(key, entry);
      return entry;
    }
    const host = aiConnectionHost(use.baseUrl);
    const deviceId = use.deviceId ?? (use.kind === "cli" ? `${use.cliTool}-cli` : aiDeviceSlug((host && input.hostEquipment.get(host)) ?? host ?? "engine"));
    const label = uniqueLabel(use.kind === "cli" ? AI_CLI_TOOL_LABELS[use.cliTool!] : use.deviceId ?? (host && input.hostEquipment.get(host)) ?? host ?? deviceId);
    const entry: AiImportConnection = Object.freeze({ key, action: "create", id: null, label, kind: use.kind, baseUrl: use.kind === "api" ? use.baseUrl : null,
      cliTool: use.kind === "cli" ? use.cliTool : null, cliModels: Object.freeze(use.kind === "cli" ? [use.model] : []), deviceId,
      capacitySlots: input.deviceSlots.get(deviceId) ?? 1, keyFrom: use.kind === "api" ? use.keyFrom : null,
      keyEnv: use.kind === "api" && !use.keyFrom ? use.keyEnv ?? null : null });
    connections.set(key, entry);
    return entry;
  };

  const slots: AiImportSlot[] = [];
  for (const current of input.current) {
    const task = aiTask(current.task);
    if (!task) continue;
    const name = aiTaskSlotLabel(task, current.slot);
    for (const note of current.notes) warnings.push(`${name}: ${note}`);
    if (current.error) { warnings.push(`${name}: 지금 모델을 읽지 못해 옮기지 않습니다(${current.error}).`); continue; }
    if (current.skip) { warnings.push(`${name}: ${current.skip}`); continue; }
    const ranks: AiImportRank[] = [];
    for (const use of current.uses) {
      if (use.kind === "api" && !use.baseUrl) { warnings.push(`${name}: ${use.model}(${use.origin})의 서버 주소를 몰라 옮기지 않습니다.`); continue; }
      if (use.kind === "cli" && !use.cliTool) { warnings.push(`${name}: ${use.model}의 CLI 도구를 몰라 옮기지 않습니다.`); continue; }
      if (!aiTaskAccepts(task, { kind: use.kind, cliTool: use.cliTool })) { warnings.push(`${name}: ${use.provider} · ${use.model}은(는) 이 작업이 받는 연결이 아니라 옮기지 않습니다.`); continue; }
      const key = connectionKeyOf(use);
      let model = use.model;
      if (use.serverNamed) {
        const listed = input.served?.get(use.baseUrl ?? "") ?? input.connections.find(connection => connection.baseUrl === use.baseUrl)?.models?.map(entry => entry.id) ?? [];
        const named = listed.includes(use.model) ? use.model : listed.length === 1 ? listed[0] : null;
        if (!named) { warnings.push(`${name}: 서버(${aiConnectionHost(use.baseUrl)})의 모델 목록에서 이름을 하나로 정하지 못해 옮기지 않습니다(목록 ${listed.length}개).`); continue; }
        model = named;
      }
      if (ranks.some(row => row.connectionKey === key && row.model === model)) continue;
      if (ranks.length >= AI_TASK_RANK_MAX) { warnings.push(`${name}: ${model}(${use.origin})은(는) 4순위 이상이라 옮기지 않습니다.`); continue; }
      ranks.push(Object.freeze({ rank: ranks.length + 1, connectionKey: key, model, origin: use.origin, options: Object.freeze({ ...use.options ?? {} }) }));
      connectionFor({ ...use, model });
    }
    const existing = input.rows.filter(row => row.task === task.id && row.slot === current.slot).sort((a, b) => a.rank - b.rank);
    const same = existing.length === ranks.length && existing.every((row, index) => {
      const planned = ranks[index], connection = connections.get(planned.connectionKey);
      return connection?.id === row.connectionId && planned.model === row.model && planned.rank === row.rank;
    });
    const action: AiImportSlot["action"] = !ranks.length ? "empty" : !existing.length ? "create" : same ? "unchanged" : "differs";
    if (action === "differs") warnings.push(`${name}: 이미 저장한 순위가 지금 설정과 달라 덮지 않습니다(작업 ↔ 모델 표에서 고치세요).`);
    if (action === "empty") warnings.push(`${name}: 지금 쓰는 모델이 없어 옮길 순위가 없습니다.`);
    slots.push(Object.freeze({ task: task.id, slot: current.slot, action, ranks: Object.freeze(ranks) }));
  }
  return Object.freeze({ connections: Object.freeze([...connections.values()]), slots: Object.freeze(slots), warnings: Object.freeze([...new Set(warnings)]) });
}

/** 계획 hash 의 입력(보여 준 계획 = 적용할 계획인지) — 연결·순위의 쓰는 칸만 본다. hash 는 서버가 sha256 으로 만든다. */
export function aiImportPlanDigestInput(plan: AiImportPlan): string {
  return JSON.stringify(stableJson({
    connections: plan.connections.map(row => [row.key, row.action, row.id, row.label, row.kind, row.baseUrl, row.cliTool, row.cliModels, row.deviceId, row.capacitySlots,
      row.keyFrom, row.keyEnv]),
    slots: plan.slots.map(row => [row.task, row.slot, row.action, row.ranks.map(rank => [rank.rank, rank.connectionKey, rank.model, rank.options])]),
  }));
}
/** 한 칸의 지금 행 → 폼 compare-and-set 값의 입력(순위·연결·모델·옵션·켜짐). */
export function aiTaskSlotDigestInput(rows: readonly Pick<AiTaskRankRow, "rank" | "connectionId" | "model" | "options" | "enabled">[]): string {
  return JSON.stringify([...rows].sort((a, b) => a.rank - b.rank).map(row => [row.rank, row.connectionId, row.model, stableJson(row.options), row.enabled]));
}

// ── 문장 ───────────────────────────────────────────────────────────────────────────────────────────────

const FIELD_LABELS: Readonly<Record<string, string>> = {
  id: "연결 id", expectedVersion: "판", label: "이름(1~80자)", kind: "종류(API·CLI)", baseUrl: "주소(http(s)://호스트[:포트]/v1)", apiKey: "API 키(공백 없이 4096자까지)",
  cliTool: "CLI 도구(claude·codex·grok·opencode)", cliModels: "CLI 모델 이름(일반 CLI 1~32개, M3 OpenCode 실제 목록 1~512개)", cliVersion: "CLI 버전(80자까지, `--version` 출력 그대로)",
  deviceId: "장비 이름(공백 없이 120자까지)",
  capacitySlots: "칸 수(1~256)", contextTokens: "컨텍스트 상한(1~2097152 토큰)", note: "메모(400자까지)",
  task: "작업", slot: "칸", revision: "화면 판", rank: "순위 칸",
};
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  ai_connection_label_taken: "같은 이름의 연결이 이미 있습니다. 다른 이름을 쓰세요.",
  ai_connection_base_url_taken: "같은 주소의 연결이 이미 있습니다. 그 연결을 고치세요.",
  ai_connection_version_mismatch: "그 사이 다른 저장이 있었습니다. 새로고침한 뒤 다시 저장하세요.",
  ai_connection_missing: "연결을 찾지 못했습니다(지워졌을 수 있습니다). 새로고침하세요.",
  ai_connection_kind_change: "연결의 종류(API·CLI)는 바꿀 수 없습니다. 새 연결을 만드세요.",
  ai_connection_in_use: "이 연결을 쓰는 순위가 있어 지울 수 없습니다. 먼저 작업 ↔ 모델 표에서 빼거나 연결을 끄세요.",
  ai_connection_model_in_use: "이 모델을 쓰는 순위나 작업 분산 구성원이 있어 목록에서 뺄 수 없습니다. 먼저 작업 배정에서 바꾸세요.",
  ai_connection_model_missing: "이 연결의 목록에 없는 모델입니다. 새로고침하세요.",
  ai_connection_model_invalid: "모델 이름이 올바르지 않습니다.",
  ai_task_ranks_read: "실행 쪽이 이 작업의 순위를 읽습니다 — 옛 기록이 아니므로 「바꾸기」에서 바꾸세요.",
  ai_connection_models_too_soon: "1분 안에 이미 목록을 읽었습니다. 잠시 뒤 다시 읽으세요.",
  ai_connection_not_api: "CLI 연결은 /models 목록이 없습니다. CLI 모델 이름을 직접 적으세요.",
  ai_connection_cli_host_unavailable: "M3 OpenCode에 연결하지 못해 저장하지 않았습니다. 기존 선택은 유지됩니다. 실제 목록을 다시 조회하세요.",
  ai_connection_cli_catalog_changed: "M3의 실제 모델 목록·버전이 바뀌었습니다. 연결 편집에서 목록을 다시 조회한 뒤 저장하세요.",
  ai_connection_options_full: "기존 연결 옵션과 모델 메타데이터가 저장 한도를 넘습니다. 기존 옵션을 보존하기 위해 저장하지 않았습니다.",
  ai_connection_key_unreadable: "저장한 키를 열 수 없습니다(암호화 설정이 바뀌었을 수 있습니다). 키를 다시 넣으세요.",
  secret_box_key_missing: "이 서버에는 키 암호화 설정(NMV_SECRET_BOX_KEY)이 없어 키를 저장할 수 없습니다.",
  ai_task_revision_mismatch: "그 사이 이 줄이 바뀌었습니다. 새로고침한 뒤 다시 저장하세요.",
  ai_task_import_plan_changed: "계획을 보여 준 뒤 설정이 바뀌었습니다. 계획을 다시 보고 적용하세요.",
  ai_task_import_confirm_required: `확인 칸에 「${AI_TASK_IMPORT_CONFIRM}」를 적어야 적용합니다.`,
  site_fenced: "이 사이트는 지금 쓰기가 막혀 있습니다(DR 전환 중). 잠시 뒤 다시 하세요.",
  model_capacity_policy_missing: "용량 정책이 없어 경로를 덧붙일 수 없습니다.",
  model_capacity_route_conflict: "용량 정책에 같은 경로·모델이 다른 예산·장비로 있어 덧붙일 수 없습니다(정책 개정 필요).",
  model_capacity_routes_cap: "용량 정책의 경로 수가 한도를 넘습니다.",
  model_capacity_append_chain_full: "용량 정책의 앞 판 사슬이 가득 찼습니다. 옛 판의 호출이 끝난 뒤 다시 저장하세요.",
  invalid_actor: "관리자 이름을 읽지 못했습니다. 다시 로그인하세요.",
  denied: "권한이 없습니다. 다시 로그인해주세요.",
};
const PROBE_MESSAGES: Readonly<Record<string, string>> = {
  engine_model_not_found: "엔진 목록에 이 모델이 없습니다",
  engine_max_len_unknown: "엔진이 최대 길이를 알려 주지 않습니다 — 연결의 「컨텍스트 상한」을 적으세요",
  engine_max_len_invalid: "컨텍스트 상한 값이 맞지 않습니다",
  engine_probe_failed: "1토큰 시험 호출이 실패했습니다",
  contract_schema_invalid: "계약 꼴이 맞지 않습니다",
};

/** 저장 거절 코드 → 운영자 문장. 이미 한국어 문장이면 그대로. */
export function aiTaskIssueMessage(issue: string): string {
  if (/[가-힣]/.test(issue)) return issue;
  const field = /^ai_(?:connection|task)_invalid:(.+)$/.exec(issue);
  if (field) return `입력을 확인하세요: ${FIELD_LABELS[field[1]] ?? field[1]}.`;
  const probe = /^ai_task_contract_probe_failed:([^:]+)(?::(.*))?$/.exec(issue);
  if (probe) {
    const reason = probe[2] ?? "";
    const text = PROBE_MESSAGES[reason] ?? (reason.startsWith("engine_unreachable") ? `엔진에 닿지 않습니다(${reason.split(":")[1] ?? "연결 실패"})`
      : reason.startsWith("engine_max_len_mismatch") ? "엔진이 알려 준 최대 길이와 연결의 컨텍스트 상한이 다릅니다" : reason || "확인 실패");
    return `${probe[1]} 경로의 엔진 직접 계약을 만들지 못했습니다: ${text}.`;
  }
  if (issue.startsWith("ai_connection_models_failed:")) return `모델 목록을 읽지 못했습니다(${issue.slice("ai_connection_models_failed:".length)}).`;
  return CODE_MESSAGES[issue] ?? `저장하지 못했습니다(${issue}).`;
}

/** /models 실패 이유 코드 → 화면 문장(연결 표의 「마지막 오류」). */
export function aiModelsErrorText(code: string | null): string | null {
  if (!code) return null;
  if (code === "unreachable") return "닿지 않음(연결 실패·시간 초과)";
  if (code === "endpoint_invalid") return "주소가 맞지 않음";
  if (code === "key_unreadable") return "저장한 키를 열 수 없음";
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return http[1] === "401" || http[1] === "403" ? `거절됨(HTTP ${http[1]} — 키 확인)` : `HTTP ${http[1]}`;
  return code;
}

import { aiTask, aiTaskAccepts, aiTaskSlotLabel, AI_TASKS, type AiTaskDef } from "@/lib/llm/ai-tasks";
import { AI_CONNECTION_CONTEXT_MAX, aiAllowedTaskField, aiConnectionBaseUrl, aiConnectionModelIds, aiDeviceSlug, aiModelDisplayName, aiModelMachine,
  type AiConnectionView } from "./admin-ai-tasks";
import { CONSOLE_TASK_LIMITS, formatCount, formatDays, formatKst, formatShare, type ConsoleTask, type ConsoleTaskBoard } from "./console-tasks";
import { stagePanelHref, stagePanelKeyOfTask } from "./stage-panel-catalog";

/**
 * 운영 콘솔 「모델」 화면(2026-11-12 최종 시안 화면 4·흐름 3, 조각 3a) — 순수 함수. DB·네트워크를 쓰지 않는다(읽기는 model-console-read.ts).
 *
 * 사용자 요구: 「장비랑 모델을 분리해서 표기하니 복잡해졌다. 사용할 수 있는 모델의 이름을 정하면 그대로 표기되면 되고, 한도·최대 토큰은 지금처럼.
 * 서비스가 확인한 모델 이름과 내가 정한 이름이 둘 다 뜰 필요가 없다.」
 *
 * - 모델 한 줄 = 연결(ai_connections) 하나 = 사용자가 정한 이름 하나(aiModelDisplayName). 표(연결·장비·계약·등록부)는 바꾸지 않고 화면에서만 합친다.
 *   한 연결이 같은 모델을 이름 둘로 알려 줘도(예: supa 의 `supa` 와 `Inferact/…` — /models 의 root 가 같음) 한 줄이고,
 *   서버가 알려 준 이름·엔진 경로는 목록에 내지 않고 상세의 「연결 확인」 줄에만 둔다(servedGroups).
 * - 장비 = 사용자가 적는 묶음 이름(aiModelMachine, 기본은 용량 장비 id). 용량 판정과 한도 검증은 늘 장비 id 로 한다.
 * - 한도 = 이 모델에 실제로 걸리는 동시 칸: 장비의 모델별 한도(0170) → 장비 행 한도 → 연결 칸 수 순서로 처음 있는 값.
 * - 24시간 사용률 = 24시간 호출 시간 합 ÷ (86,400초 × 한도) — 시안 build.py·홈 할 일(console-tasks)과 같은 식.
 * - 상태는 첫 문제 하나(시안 build.py 순서): 쉬는 중 → 결과 없이 끝남 N(하루 10건 이상) → 미확정 N(5건 이상) → 쓰는 단계 없음 → 쓰는 단계가 멈춤 → 여유 많음(5% 미만) → 정상.
 * 읽지 못한 값은 0 으로 꾸미지 않는다(null — 화면은 「—」).
 */

export const MODEL_CONSOLE_LIMITS = Object.freeze({
  /** 결과 없이 끝난 호출이 하루 이만큼 이상이면 상태에 올린다(홈 「정리」 규칙과 같은 값) */
  noResultPerDay: CONSOLE_TASK_LIMITS.noResultPerDay,
  /** 미확정이 24시간에 이만큼 이상이면 상태에 올린다(시안 build.py) */
  indeterminatePerDay: 5,
  /** 24시간 사용률이 이 값 미만이면 「여유 많음」(홈 「남는 모델」과 같은 값) */
  idleUtilization: CONSOLE_TASK_LIMITS.idleUtilization,
  /** 키 만료가 이 날수 안이면 문제로 올린다(홈 「정리」 규칙과 같은 값) */
  keyExpiryDays: CONSOLE_TASK_LIMITS.keyExpiryDays,
  /** 동시 한도·칸 수 상한(연결·장비 행과 같은 값) */
  limitMax: 256,
});

export type ModelTone = "ok" | "warn" | "bad" | "off";

// ── 입력 ───────────────────────────────────────────────────────────────────────────────────────────────

/** 24시간 장부 한 묶음(route · 장비 · 모델) — 미확정을 함께 센다 */
export type ModelLedgerRow = Readonly<{ routeId: string; groupId: string; model: string; calls: number; settled: number; avgSeconds: number | null;
  noResult: number; indeterminate: number }>;
/** 장비 점유·한도(readAdminModelsObservation devices) — 쓰는 칸만 */
export type ModelDeviceState = Readonly<{ deviceId: string; source: "table" | "policy_fallback" | null; limitSlots: number | null; active: number;
  version: number | null; models: readonly Readonly<{ model: string; active: number; maxSlots: number | null; engineMax: number | null }>[] }>;
export type ModelRankUse = Readonly<{ task: string; slot: number; rank: number; connectionId: string; model: string; enabled: boolean }>;
export type ModelPoolUse = Readonly<{ task: string; slot: number; connectionId: string; model: string }>;

export type ModelConsoleInput = Readonly<{
  now: string;
  connections: readonly AiConnectionView[] | null;
  ranks: readonly ModelRankUse[] | null;
  pools: readonly ModelPoolUse[] | null;
  devices: readonly ModelDeviceState[] | null;
  ledger: readonly ModelLedgerRow[] | null;
  /** 사람이 멈춘 잡 이름(isPausedJob). null = 읽지 못함 */
  pausedJobs: readonly string[] | null;
  /** 시험용 — 기본은 AI_TASKS */
  tasks?: readonly AiTaskDef[];
}>;

// ── 출력 ───────────────────────────────────────────────────────────────────────────────────────────────

/** 이 모델을 쓰는 단계 하나 — 순위(1·2·3) 또는 「함께」(작업 분산 구성원) */
export type ModelStageUse = Readonly<{ task: string; slot: number; label: string; place: string; rank: number | null; enabled: boolean; paused: boolean;
  /** 그 단계 패널의 모델 구역(패널이 없는 작업은 작업 배정의 그 줄) */
  href: string }>;
/** 서버가 알려 준 이름 묶음 — 같은 root(또는 같은 이름)는 한 묶음. 상세 「연결 확인」 줄에만 보인다 */
export type ModelServedGroup = Readonly<{ ids: readonly string[]; root: string | null; maxModelLen: number | null }>;
/** 문제 한 줄 — 읽은 사실만. label 은 왼쪽 짧은 칸(시안 「거절」「약관」) */
export type ModelProblem = Readonly<{ key: string; tone: ModelTone; label: string; text: string; href?: string; action?: string }>;
export type ModelLimitSource = "model" | "device" | "connection";

export type ModelConsoleRow = Readonly<{
  id: string; name: string; machine: string; deviceId: string; kind: "api" | "cli"; enabled: boolean;
  /** 실제로 걸리는 동시 한도와 그 값이 온 곳 */
  limit: number; limitSource: ModelLimitSource;
  /** 지금 쓰는 칸 — 장비 관측을 못 읽었으면 null */
  active: number | null;
  /** 24시간 사용률(0~1) — 장부를 못 읽었으면 null */
  utilization: number | null; utilizationText: string;
  /** 막대 너비(%) — 0보다 크면 적어도 1 */
  bar: number;
  calls: number | null; settled: number | null; avgSeconds: number | null; noResult: number | null; indeterminate: number | null;
  stages: readonly ModelStageUse[]; stageCount: number;
  status: Readonly<{ tone: ModelTone; text: string }>;
  problems: readonly ModelProblem[];
  served: readonly ModelServedGroup[];
  /** 장부·순위가 부르는 서버 이름(상세의 「연결 확인」·표본 비교 후보) */
  models: readonly string[];
  /** 같은 장비 id 를 함께 쓰는 다른 모델 이름 */
  sharedWith: readonly string[];
  connection: AiConnectionView;
}>;

export type ModelConsoleView = Readonly<{ rows: readonly ModelConsoleRow[]; errors: readonly string[]; checkedAt: string }>;

// ── 계산 ───────────────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
export const modelHref = (id: string) => `/admin/models?model=${encodeURIComponent(id)}`;
export const MODEL_ADD_HREF = "/admin/models/new";
export const modelTaskHref = (task: string, slot = 1) => `/admin/models/tasks#execution-${task}-${slot}`;
/** 이 모델을 쓰는 단계 — 그 단계 패널의 모델 구역(운영 콘솔 2a, 순위·「동시에」를 그 자리에서 고친다). 패널이 없는 작업은 작업 배정의 그 줄 */
export const modelStageHref = (task: string, slot = 1) => { const key = stagePanelKeyOfTask(task); return key ? stagePanelHref(key, "models") : modelTaskHref(task, slot); };
export const modelCompareHref = (task: string, connectionId: string, model?: string | null) =>
  `/admin/models/compare?task=${encodeURIComponent(task)}&candidate=${encodeURIComponent(connectionId)}${model ? `&model=${encodeURIComponent(model)}` : ""}`;
const RETRY_HREF = "/admin/models/history#retry";

/** 서버가 알려 준 이름을 같은 모델끼리 묶는다 — root 가 같으면 한 묶음, root 를 모르면 이름 하나가 한 묶음(처음 나온 차례) */
export function servedModelGroups(connection: Pick<AiConnectionView, "kind" | "models" | "cliModels"> & Partial<Pick<AiConnectionView, "cliTool" | "cliCatalog" | "manualModels">>,
  extra: readonly string[] = []): ModelServedGroup[] {
  const listed = connection.kind === "api" ? connection.models ?? [] : [];
  const ids = [...aiConnectionModelIds(connection), ...extra];
  const groups = new Map<string, { ids: string[]; root: string | null; maxModelLen: number | null }>();
  for (const id of ids) {
    const served = listed.find(model => model.id === id);
    const root = served?.root ?? null;
    // 다른 이름의 root 로 알려진 이름(= 별칭의 원래 이름)도 그 묶음에 든다
    const key = root ?? (listed.some(model => model.root === id) ? id : `id:${id}`);
    const group = groups.get(key) ?? { ids: [], root, maxModelLen: null };
    if (!group.ids.includes(id)) group.ids.push(id);
    group.root ??= root;
    if (served?.maxModelLen && (group.maxModelLen === null || served.maxModelLen > group.maxModelLen)) group.maxModelLen = served.maxModelLen;
    groups.set(key, group);
  }
  return [...groups.values()].map(group => Object.freeze({ ids: Object.freeze([...group.ids]), root: group.root, maxModelLen: group.maxModelLen }));
}

/** 최대 토큰 — 운영자가 적은 컨텍스트 상한, 없으면 서버가 알려 준 가장 긴 것. 모르면 null */
export function modelMaxTokens(connection: Pick<AiConnectionView, "contextTokens" | "models">): number | null {
  if (connection.contextTokens) return connection.contextTokens;
  const lengths = (connection.models ?? []).flatMap(model => model.maxModelLen ? [model.maxModelLen] : []);
  return lengths.length ? Math.max(...lengths) : null;
}

/** 키를 넣은 날·만료일·남은 날(시안 「11-11 넣음 · 12-11 만료 · 28일 남음」). 키가 없거나 넣은 때를 모르면 null */
export function modelKeyText(connection: Pick<AiConnectionView, "hasKey"> & Partial<Pick<AiConnectionView, "keySetAt" | "keyValidDays">>, now: string): string | null {
  if (!connection.hasKey) return null;
  if (!connection.keySetAt) return "저장됨";
  const set = Date.parse(connection.keySetAt);
  if (!connection.keyValidDays) return `${formatKst(set, true)} 넣음`;
  const expires = set + connection.keyValidDays * DAY_MS, left = Math.floor((expires - Date.parse(now)) / DAY_MS);
  return `${formatKst(set, true)} 넣음 · ${formatKst(expires, true)} 만료 · ${left < 0 ? "지남" : `${left}일 남음`}`;
}

const sum = (rows: readonly ModelLedgerRow[], key: "calls" | "settled" | "noResult" | "indeterminate") => rows.reduce((total, row) => total + row[key], 0);

/** 이 연결의 모델이 장부·순위에서 쓰는 이름들 — 서버 목록 + 순위·분산이 부르는 이름 + 연결로 가른 장부 이름(`<모델>@<연결 id 앞 8자>`) */
function ledgerNames(connection: AiConnectionView, uses: readonly { model: string }[]): Set<string> {
  const base = new Set([...aiConnectionModelIds(connection), ...connection.cliModels, ...uses.map(use => use.model)]);
  for (const model of [...base]) base.add(`${model}@${connection.id.slice(0, 8)}`);
  return base;
}

export function buildModelConsole(input: ModelConsoleInput): ModelConsoleView {
  const tasks = input.tasks ?? AI_TASKS;
  const taskDef = (id: string) => tasks.find(task => task.id === id) ?? aiTask(id);
  const errors: string[] = [];
  if (!input.connections) errors.push("모델(연결) 목록을 읽지 못했습니다.");
  if (!input.ledger) errors.push("24시간 장부를 읽지 못했습니다 — 사용률·호출은 「—」로 보입니다.");
  if (!input.devices) errors.push("장비 점유를 읽지 못했습니다 — 「지금」 칸이 「—」로 보입니다.");
  if (!input.ranks || !input.pools) errors.push("모델을 쓰는 단계를 읽지 못했습니다 — 단계 수가 비어 보일 수 있습니다.");
  const paused = input.pausedJobs ? new Set(input.pausedJobs) : null;
  const taskPaused = (id: string) => { const def = taskDef(id); return !!paused && !!def && def.jobs.length > 0 && def.jobs.every(job => paused.has(job)); };
  const connections = input.connections ?? [];

  const rows = connections.map((connection): ModelConsoleRow => {
    // 없앤 작업(RETIRED_AI_TASKS — 예: korean-translation-direct)의 남은 순위 행은 실행 쪽이 모른다 — 쓰는 단계로 세지 않는다(시안 build.py 와 같다)
    const ranks = (input.ranks ?? []).filter(row => row.connectionId === connection.id && taskDef(row.task));
    const pools = (input.pools ?? []).filter(row => row.connectionId === connection.id && taskDef(row.task));
    const names = ledgerNames(connection, [...ranks, ...pools]);
    // 단계 — 켜진 순위와 작업 분산 구성원. 같은 작업·칸은 한 번(순위가 앞)
    const stageMap = new Map<string, ModelStageUse>();
    for (const row of [...ranks].sort((a, b) => a.rank - b.rank)) {
      if (!row.enabled) continue;
      const key = `${row.task}#${row.slot}`;
      if (stageMap.has(key)) continue;
      const def = taskDef(row.task);
      stageMap.set(key, { task: row.task, slot: row.slot, label: def ? (def.slots > 1 ? aiTaskSlotLabel(def, row.slot) : def.label) : row.task,
        place: `${row.rank}순위`, rank: row.rank, enabled: true, paused: taskPaused(row.task), href: modelStageHref(row.task, row.slot) });
    }
    for (const row of pools) {
      const key = `${row.task}#${row.slot}`;
      if (stageMap.has(key)) continue;
      const def = taskDef(row.task);
      stageMap.set(key, { task: row.task, slot: row.slot, label: def ? (def.slots > 1 ? aiTaskSlotLabel(def, row.slot) : def.label) : row.task,
        place: "함께", rank: null, enabled: true, paused: taskPaused(row.task), href: modelStageHref(row.task, row.slot) });
    }
    const stages = [...stageMap.values()];
    const stageCount = new Set(stages.map(stage => stage.task)).size;

    // 한도 — 장비의 모델별 한도 → 장비 행 → 연결 칸 수
    const device = input.devices?.find(row => row.deviceId === connection.deviceId) ?? null;
    const modelLimit = device?.models.find(row => names.has(row.model) && row.maxSlots !== null)?.maxSlots ?? null;
    const [limit, limitSource]: [number, ModelLimitSource] = modelLimit !== null ? [modelLimit, "model"]
      : device?.source === "table" && device.limitSlots ? [device.limitSlots, "device"] : [connection.capacitySlots, "connection"];
    const perModel = device?.models.filter(row => names.has(row.model)) ?? [];
    const active = !input.devices ? null : !device ? 0 : perModel.length ? perModel.reduce((total, row) => total + row.active, 0) : device.models.length ? 0 : device.active;

    // 24시간 장부
    const own = input.ledger?.filter(row => row.groupId === connection.deviceId && names.has(row.model)) ?? null;
    const seconds = own?.reduce((total, row) => total + (row.avgSeconds ?? 0) * row.settled, 0) ?? null;
    const settled = own ? sum(own, "settled") : null, calls = own ? sum(own, "calls") : null;
    const noResult = own ? sum(own, "noResult") : null, indeterminate = own ? sum(own, "indeterminate") : null;
    const utilization = seconds === null ? null : seconds / (86_400 * Math.max(1, limit));
    const avgSeconds = settled ? seconds! / settled : null;

    const name = aiModelDisplayName(connection);
    const problems: ModelProblem[] = [];
    if (noResult) problems.push({ key: "no-result", tone: noResult >= MODEL_CONSOLE_LIMITS.noResultPerDay ? "warn" : "off", label: "거절",
      text: `24시간 ${formatCount(calls ?? 0)}건 중 ${formatCount(noResult)}건이 결과 없이 끝났습니다(공급자가 처리 전에 거절했거나 보내지 못함).` });
    if (indeterminate) problems.push({ key: "indeterminate", tone: indeterminate >= MODEL_CONSOLE_LIMITS.indeterminatePerDay ? "warn" : "off", label: "미확정",
      text: `24시간 안에 결과를 모르는 호출이 ${formatCount(indeterminate)}건 있습니다.`, href: RETRY_HREF, action: "재실행 보기" });
    if ((input.ranks && input.pools) && !stageCount) problems.push({ key: "unused", tone: "off", label: "단계", text: "어느 단계에도 붙어 있지 않습니다." });
    const pausedStages = stages.filter(stage => stage.paused);
    if (stageCount && pausedStages.length === stages.length) problems.push({ key: "paused", tone: "off", label: "멈춤",
      text: `쓰는 단계(${[...new Set(pausedStages.map(stage => stage.label))].join(" · ")})가 모두 사람이 멈춘 상태입니다.` });
    if (connection.keySetAt && connection.keyValidDays && connection.hasKey) {
      const expires = Date.parse(connection.keySetAt) + connection.keyValidDays * DAY_MS, left = (expires - Date.parse(input.now)) / DAY_MS;
      if (left <= MODEL_CONSOLE_LIMITS.keyExpiryDays) problems.push({ key: "key", tone: left < 0 ? "bad" : "warn", label: "키",
        text: left < 0 ? `키가 ${formatKst(expires, true)}에 만료됐습니다.` : `키가 ${Math.ceil(left)}일 뒤(${formatKst(expires, true)}) 만료됩니다.`, action: "키 바꾸기" });
    }
    if (connection.modelsError) problems.push({ key: "models", tone: "warn", label: "연결 확인", text: `마지막 모델 목록 읽기가 실패했습니다(${connection.modelsError}).` });
    if (connection.capacitySlots !== limit) problems.push({ key: "limit", tone: "off", label: "한도",
      text: `연결에 적힌 칸 수 ${formatCount(connection.capacitySlots)}와 실제 걸리는 한도 ${formatCount(limit)}이(가) 다릅니다. 이 화면에서 저장하면 맞춰집니다.` });

    // 상태 — 첫 문제 하나(시안 build.py 순서)
    const status: { tone: ModelTone; text: string } = !connection.enabled ? { tone: "off", text: "쉬는 중" }
      : noResult !== null && noResult >= MODEL_CONSOLE_LIMITS.noResultPerDay ? { tone: "warn", text: `결과 없이 끝남 ${formatCount(noResult)}` }
      : indeterminate !== null && indeterminate >= MODEL_CONSOLE_LIMITS.indeterminatePerDay ? { tone: "warn", text: `미확정 ${formatCount(indeterminate)}` }
      : input.ranks && input.pools && !stageCount ? { tone: "off", text: "쓰는 단계 없음" }
      : stageCount && pausedStages.length === stages.length ? { tone: "off", text: "쓰는 단계가 멈춤" }
      : utilization === null ? { tone: "off", text: "사용량 확인 불가" }
      : utilization < MODEL_CONSOLE_LIMITS.idleUtilization && stageCount ? { tone: "ok", text: "여유 많음" }
      : { tone: "ok", text: "정상" };

    const percent = utilization === null ? 0 : utilization * 100;
    return Object.freeze({
      id: connection.id, name, machine: aiModelMachine(connection), deviceId: connection.deviceId, kind: connection.kind, enabled: connection.enabled,
      limit, limitSource, active, utilization,
      utilizationText: utilization === null ? "—" : formatShare(utilization, calls ?? 0),
      bar: utilization === null || !calls ? 0 : Math.max(percent > 0 ? 1 : 0, Math.min(100, Math.round(percent))),
      calls, settled, avgSeconds, noResult, indeterminate,
      stages: Object.freeze(stages), stageCount, status: Object.freeze(status), problems: Object.freeze(problems),
      served: Object.freeze(servedModelGroups(connection, [...ranks, ...pools].map(use => use.model).filter(model => !aiConnectionModelIds(connection).includes(model)))),
      models: Object.freeze([...new Set([...aiConnectionModelIds(connection), ...ranks.map(row => row.model), ...pools.map(row => row.model)])]),
      sharedWith: Object.freeze([]), connection,
    });
  });
  // 같은 장비 id 를 쓰는 다른 모델
  const withShared = rows.map(row => Object.freeze({ ...row, sharedWith: Object.freeze(rows.filter(other => other.id !== row.id && other.deviceId === row.deviceId).map(other => other.name)) }));
  withShared.sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1) || a.name.localeCompare(b.name, "ko"));
  return Object.freeze({ rows: Object.freeze(withShared), errors: Object.freeze(errors), checkedAt: input.now });
}

/** 평균 응답 글자 — 「7.9초」, 모르면 「—」 */
export const formatSeconds = (seconds: number | null) => seconds === null ? "—" : `${seconds.toFixed(1)}초`;

// ── 저장 전 확인 ───────────────────────────────────────────────────────────────────────────────────────

/** 상세의 설정 칸(시안 「설정」) — 화면이 고치는 값 */
export type ModelSettings = Readonly<{
  name: string; machine: string; limit: number;
  /** 최대 토큰(API 의 컨텍스트 상한). null = 비움(서버가 알려 주는 값) */
  maxTokens: number | null;
  /** 추론 토큰 여유. null = 비움 */
  reasoningReserve: number | null;
  /** 쓸 수 있는 단계(빈 목록 = 모든 단계) */
  allowedTasks: readonly string[];
  enabled: boolean;
  /** 새 키(평문은 화면 안에서만) — 넣었는지만 본다 */
  newKey: boolean;
  keyValidDays: number | null;
}>;
export const modelSettingsOf = (row: Pick<ModelConsoleRow, "name" | "machine" | "limit" | "connection">): ModelSettings => ({
  name: row.name, machine: row.machine, limit: row.limit, maxTokens: row.connection.kind === "api" ? row.connection.contextTokens : null,
  reasoningReserve: row.connection.reasoningTokenReserve ?? null, allowedTasks: [...(row.connection.allowedTasks ?? [])], enabled: row.connection.enabled,
  newKey: false, keyValidDays: row.connection.keyValidDays ?? null,
});

/** 장비 행에 함께 쓸 값 — 모델별 한도가 있는 장비는 그 줄, 아니면 장비 한도(장비 행이 있을 때만) */
export type ModelDeviceWrite = Readonly<{ deviceId: string; expectedVersion: number | null; limitSlots: number;
  /** null = 모델 줄을 보내지 않음(모델이 나뉘지 않은 장비) */
  modelLimits: readonly Readonly<{ model: string; maxSlots: number; engineMax: number | null }>[] | null }>;
export type ModelDiffLine = Readonly<{ key: string; label: string; before: string; after: string }>;
export type ModelSavePlan = Readonly<{
  lines: readonly ModelDiffLine[];
  /** 한도를 어디에 함께 쓰는가 — 「연결 칸 수 · 장비의 모델별 한도」 같은 줄 */
  writes: readonly string[];
  /** 영향을 받는 단계와 같은 장비의 다른 모델 */
  impacts: readonly string[];
  /** 저장 전에 보여 줄 어긋남·주의(막지는 않는다 — 막는 것은 기존 저장의 검증) */
  warnings: readonly string[];
  device: ModelDeviceWrite | null;
  changed: boolean;
}>;

const shown = (value: number | null, unit = "") => value === null ? "비움" : `${formatCount(value)}${unit}`;
const taskList = (ids: readonly string[]) => ids.length ? `${ids.length}개만 허용(${ids.map(id => aiTask(id)?.label ?? id).join(" · ")})` : "모든 단계";

/**
 * 저장 전 확인 — 바뀌는 값(전 → 후), 동시 한도를 함께 쓸 곳, 영향을 받는 단계. 한도는 이 화면의 「동시 한도」 한 칸으로 받아
 * 연결 칸 수(saveAiConnection)와, 장비에 모델별 한도가 있으면 그 줄을 · 없고 장비 행이 있으면 장비 한도를(saveAdminDeviceRow) 함께 쓴다.
 * 같은 장비를 다른 모델이 나눠 쓰는 장비 한도를 바꾸면 그 모델도 영향을 받는다 — impacts 에 적는다.
 */
export function modelSavePlan(row: Pick<ModelConsoleRow, "name" | "machine" | "limit" | "limitSource" | "stages" | "sharedWith" | "connection" | "deviceId" | "models">,
  device: ModelDeviceState | null, after: ModelSettings): ModelSavePlan {
  const before = modelSettingsOf(row);
  const lines: ModelDiffLine[] = [];
  const line = (key: string, label: string, was: string, now: string) => { if (was !== now) lines.push({ key, label, before: was, after: now }); };
  line("name", "이름", before.name, after.name.trim() || row.connection.label);
  line("machine", "장비", before.machine, after.machine.trim() || row.deviceId);
  line("limit", "동시 한도", formatCount(before.limit), formatCount(after.limit));
  if (row.connection.kind === "api") {
    line("maxTokens", "최대 토큰", shown(before.maxTokens), shown(after.maxTokens));
    line("reasoningReserve", "추론 토큰 여유", shown(before.reasoningReserve), shown(after.reasoningReserve));
    line("keyValidDays", "키 유효 기간", shown(before.keyValidDays, "일"), shown(after.keyValidDays, "일"));
  }
  line("allowedTasks", "쓸 수 있는 단계", taskList(before.allowedTasks), taskList([...after.allowedTasks].sort((a, b) =>
    AI_TASKS.findIndex(task => task.id === a) - AI_TASKS.findIndex(task => task.id === b))));
  line("enabled", "상태", before.enabled ? "켜짐" : "쉬는 중", after.enabled ? "켜짐" : "쉬는 중");
  if (after.newKey) lines.push({ key: "key", label: "키", before: row.connection.hasKey ? "저장된 키" : "없음", after: "새 키" });

  const writes: string[] = [], warnings: string[] = [], impacts: string[] = [];
  let deviceWrite: ModelDeviceWrite | null = null;
  // 동시 한도 — 연결 칸 수는 늘 이 값으로 맞추고(어긋나 있었으면 저장이 바로잡는다), 장비 쪽은 값이 다를 때만 쓴다
  if (row.connection.capacitySlots !== after.limit) writes.push(`연결 칸 수 ${formatCount(row.connection.capacitySlots)} → ${formatCount(after.limit)}`);
  const names = new Set(row.models);
  const split = device?.source === "table" ? device.models.filter(entry => entry.maxSlots !== null) : [];
  const mine = split.find(entry => names.has(entry.model));
  if (device && device.source === "table" && mine) {
    if (mine.maxSlots !== after.limit) {
      writes.push(`장비 ${row.deviceId}의 모델별 한도(${mine.model}) ${formatCount(mine.maxSlots ?? 0)} → ${formatCount(after.limit)}`);
      if (device.limitSlots !== null && after.limit > device.limitSlots)
        warnings.push(`장비 한도 ${formatCount(device.limitSlots)}보다 큽니다 — 같은 장비의 모델별 한도 검증에 걸려 장비 쪽 저장이 거절될 수 있습니다.`);
      deviceWrite = { deviceId: row.deviceId, expectedVersion: device.version, limitSlots: device.limitSlots ?? after.limit,
        modelLimits: split.map(entry => ({ model: entry.model, maxSlots: entry.model === mine.model ? after.limit : entry.maxSlots!, engineMax: entry.engineMax })) };
      const others = split.filter(entry => entry.model !== mine.model);
      if (others.length && device.limitSlots !== null) impacts.push(`같은 장비의 모델별 한도: ${others.map(entry => `${entry.model} ${formatCount(entry.maxSlots ?? 0)}`).join(" · ")}`
        + ` · 장비 한도 ${formatCount(device.limitSlots)}`);
    }
  } else if (device && device.source === "table") {
    if (device.limitSlots !== after.limit) {
      writes.push(`장비 ${row.deviceId}의 한도 ${formatCount(device.limitSlots ?? 0)} → ${formatCount(after.limit)}`);
      deviceWrite = { deviceId: row.deviceId, expectedVersion: device.version, limitSlots: after.limit, modelLimits: null };
      if (row.sharedWith.length) impacts.push(`같은 장비를 나눠 쓰는 ${row.sharedWith.join(" · ")}도 이 한도를 함께 씁니다.`);
    }
  } else if (after.limit !== row.limit) {
    warnings.push("이 장비는 아직 장비 행이 없습니다 — 연결 칸 수만 바뀌고, 단계에 붙일 때 이 값으로 장비 행을 만듭니다.");
  }
  const active = row.stages.filter(stage => stage.enabled);
  if (lines.some(entry => entry.key !== "name" && entry.key !== "machine") || deviceWrite) {
    if (active.length) impacts.unshift(`이 모델을 쓰는 단계 ${active.length}개: ${active.map(stage => `${stage.label}(${stage.place})`).join(" · ")}`);
    else impacts.unshift("이 모델을 쓰는 단계가 없어 지금 처리에는 바로 영향이 없습니다.");
  }
  if (!after.enabled && before.enabled) impacts.push("쉬는 동안 모든 단계가 이 모델을 건너뛰고 다음 순위·함께 쓰는 모델로 넘어갑니다. 순위는 그대로 남습니다.");
  const removed = before.allowedTasks.length || after.allowedTasks.length
    ? active.filter(stage => after.allowedTasks.length && !after.allowedTasks.includes(stage.task)) : [];
  if (removed.length) warnings.push(`쓸 수 있는 단계에서 빠지는 단계가 있습니다: ${removed.map(stage => stage.label).join(" · ")} — 그 단계는 이 모델을 더 부르지 않습니다.`);
  return Object.freeze({ lines: Object.freeze(lines), writes: Object.freeze(writes), impacts: Object.freeze(impacts), warnings: Object.freeze(warnings),
    device: deviceWrite, changed: lines.length > 0 || writes.length > 0 });
}

// ── 기존 저장(saveAiConnectionAction)에 보낼 폼 ─────────────────────────────────────────────────────────

/**
 * 연결 하나를 기존 연결 저장(saveAiConnectionAction → saveAiConnection, 감사 한 줄)에 그대로 보낼 폼 칸 — 고치지 않는 칸은 지금 값을 그대로 싣는다.
 * 키: newKey 가 있으면 새 키, 없으면 비워 둔다(저장된 키 그대로). OpenCode 는 호스트가 지금 목록을 다시 읽어 확인한다(saveAiConnection).
 */
export function connectionFormEntries(connection: AiConnectionView, change: Partial<Omit<ModelSettings, "newKey">> & { newKey?: string | null } = {}): [string, string][] {
  const entries: [string, string][] = [
    ["id", connection.id], ["expectedVersion", String(connection.version)], ["label", connection.label], ["kind", connection.kind],
    ["deviceId", connection.deviceId], ["capacitySlots", String(change.limit ?? connection.capacitySlots)],
    ["enabled", (change.enabled ?? connection.enabled) ? "1" : "0"], ["note", connection.note ?? ""],
    ["displayName", change.name !== undefined ? (change.name.trim() === connection.label ? "" : change.name.trim()) : connection.displayName ?? ""],
    ["machine", change.machine !== undefined ? (change.machine.trim() === connection.deviceId ? "" : change.machine.trim()) : connection.machine ?? ""],
  ];
  if (connection.kind === "api") {
    entries.push(["baseUrl", connection.baseUrl ?? ""], ["apiKey", change.newKey ?? ""],
      ["contextTokens", String((change.maxTokens !== undefined ? change.maxTokens : connection.contextTokens) ?? "")],
      ["manualModels", (connection.manualModels ?? []).join(" ")],
      ["reasoningTokenReserve", String((change.reasoningReserve !== undefined ? change.reasoningReserve : connection.reasoningTokenReserve) ?? "")],
      ["keyValidDays", String((change.keyValidDays !== undefined ? change.keyValidDays : connection.keyValidDays) ?? "")]);
  } else {
    entries.push(["cliTool", connection.cliTool ?? ""], ["cliModels", connection.cliModels.join(" ")], ["cliVersion", connection.cliVersion ?? ""]);
  }
  for (const task of change.allowedTasks ?? connection.allowedTasks ?? []) entries.push([aiAllowedTaskField(task), "1"]);
  return entries;
}

/** 장비 행 저장(saveDeviceRowAction → saveAdminDeviceRow)에 보낼 칸 — 모델 줄은 지금 줄을 모두 싣는다(빈 칸이면 그 줄을 지우므로) */
export function deviceRowFormEntries(write: ModelDeviceWrite): [string, string][] {
  const entries: [string, string][] = [["deviceId", write.deviceId], ["expectedVersion", write.expectedVersion === null ? "" : String(write.expectedVersion)],
    ["limitSlots", String(write.limitSlots)]];
  if (write.modelLimits) {
    entries.push(["modelLimits", "1"]);
    for (const limit of write.modelLimits) entries.push(["model", limit.model], [`max:${limit.model}`, String(limit.maxSlots)],
      [`engine:${limit.model}`, limit.engineMax === null ? "" : String(limit.engineMax)]);
  }
  return entries;
}

// ── 모델 추가 세 걸음 ─────────────────────────────────────────────────────────────────────────────────

export type ModelAddKind = "api" | "cli";
export type ModelAddStepOne = Readonly<{ kind: ModelAddKind; baseUrl: string; cliTool: string; cliModels: string }>;
/** ① 넣기 검사 — 문제는 한국어 문장. 통과하면 연결 저장에 보낼 기본 이름·장비(주소의 호스트에서 만든다, 두 번째 걸음에서 고친다) */
export function checkModelAddStepOne(input: ModelAddStepOne, taken: readonly string[]): { issues: string[]; label: string; deviceId: string; baseUrl: string | null } {
  const issues: string[] = [];
  let label = "", baseUrl: string | null = null;
  if (input.kind === "api") {
    baseUrl = aiConnectionBaseUrl(input.baseUrl);
    if (!baseUrl) issues.push("주소는 OpenAI 호환 http(s)://호스트[:포트]/v1 꼴이어야 합니다.");
    else label = new URL(baseUrl).hostname.split(".")[0].slice(0, 60);
  } else {
    if (!["claude", "codex", "grok"].includes(input.cliTool)) issues.push("CLI 도구를 고르세요(OpenCode 는 LLM 운영의 연결 추가에서 호스트와 함께 넣습니다).");
    const models = input.cliModels.split(/[\s,]+/).filter(Boolean);
    if (!models.length) issues.push("CLI 모델 이름을 하나 이상 적으세요.");
    label = `${input.cliTool} ${models[0] ?? ""}`.trim().slice(0, 60);
  }
  // 이름표는 겹칠 수 없다 — 겹치면 뒤에 번호를 붙인다(두 번째 걸음에서 사용자가 정한 이름으로 바꾼다)
  const lower = new Set(taken.map(name => name.toLowerCase()));
  let unique = label || "새 모델", n = 2;
  while (lower.has(unique.toLowerCase())) unique = `${label || "새 모델"} (${n++})`;
  return { issues, label: unique, deviceId: aiDeviceSlug(unique), baseUrl };
}

export type ModelAddStepTwo = Readonly<{ name: string; machine: string; limit: string; maxTokens: string }>;
/** ② 이름과 한도 검사 — 숫자 모양·범위만(저장 검증은 기존 연결 저장이 한다) */
export function checkModelAddStepTwo(input: ModelAddStepTwo, taken: readonly string[], kind: ModelAddKind): string[] {
  const issues: string[] = [];
  const name = input.name.trim();
  if (!name) issues.push("이름을 적으세요.");
  else if (name.length > 80) issues.push("이름은 80자까지입니다.");
  else if (taken.some(other => other.toLowerCase() === name.toLowerCase())) issues.push(`「${name}」은(는) 다른 모델이 쓰는 이름입니다.`);
  if (input.machine.trim().length > 80) issues.push("장비 이름은 80자까지입니다.");
  const limit = Number(input.limit);
  if (!/^\d{1,3}$/.test(input.limit.trim()) || limit < 1 || limit > MODEL_CONSOLE_LIMITS.limitMax) issues.push(`동시 한도는 1~${MODEL_CONSOLE_LIMITS.limitMax}의 정수입니다.`);
  if (kind === "api" && input.maxTokens.trim()) {
    const tokens = Number(input.maxTokens.replace(/,/g, ""));
    if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > AI_CONNECTION_CONTEXT_MAX) issues.push(`최대 토큰은 1~${formatCount(AI_CONNECTION_CONTEXT_MAX)}의 정수이거나 비워 둡니다.`);
  }
  return issues;
}

/** ③ 쓸 단계 — 홈 「쌓임」(지금 속도로 며칠, console-tasks)에서 이 모델을 받을 수 있는 단계를 오래 걸리는 순으로 */
export type ModelStageRecommendation = Readonly<{ task: string; label: string; days: number; daysText: string; fact: string; compare: boolean; href: string }>;
export function recommendStages(board: Pick<ConsoleTaskBoard, "groups"> | null, connection: Pick<AiConnectionView, "id" | "kind" | "cliTool" | "allowedTasks">,
  compareTasks: readonly string[], model: string | null): ModelStageRecommendation[] {
  const pile = board?.groups.find(group => group.key === "pile")?.tasks ?? [];
  return pile.filter((task): task is ConsoleTask & { stageTask: string; days: number } => task.rule === "backlog-eta" && !!task.stageTask && typeof task.days === "number")
    .flatMap(task => {
      const def = aiTask(task.stageTask);
      if (!def || !aiTaskAccepts(def, connection)) return [];
      const compare = compareTasks.includes(def.id);
      return [Object.freeze({ task: def.id, label: task.title.replace(/[이가] 쌓입니다$/, ""), days: task.days,
        daysText: Number.isFinite(task.days) ? `${formatDays(task.days)} 밀림` : "줄지 않음", fact: task.fact, compare,
        href: compare ? modelCompareHref(def.id, connection.id, model) : modelStageHref(def.id) })];
    }).sort((a, b) => b.days - a.days);
}

import type { AssistWorkTask } from "@/lib/domain/llm-assist/work";
import { AI_CLI_TOOL_LABELS, AI_TASKS, aiCliToolOfProvider, aiTask, aiTaskOwnsLedgerRoute, type AiTaskDef } from "@/lib/llm/ai-tasks";
import { aiConnectionLabel, type AiConnectionView } from "./admin-ai-tasks";
import type { AdminModelsObservation } from "./admin-models-observation";
import { modelStageId, modelStageLabel } from "./admin-models-view";

/**
 * 관리자 LLM 화면들이 장비·모델·용량 경로를 부르는 이름(2026-11-09 운영자 지적: 「supa·supa-direct 가 두 서버처럼 보인다」, 「m1-qwen 안 쓴다, m1-gemma 잖아」,
 * 「local-assist-decision_audit-m3-deepseek 가 두 번 찍힌다」). DB 를 읽지 않는 순수 모듈이고 표시만 한다 — 장비 id(정책 groupId)·경로 id·모델 이름은
 * 그대로 저장·전송된다.
 *
 * - 장비 이름 = 그 장비를 쓰는 켜진 연결 이름들(정렬, 「 · 」), 켜진 연결이 없으면 꺼진 연결 이름, 그것도 없으면 CLI 도구 이름, 그것도 없으면 장비 id.
 * - 장비 모델 = 켜진 연결이 내놓는 모델(운영자가 숨긴 모델은 이미 빠져 있다)을 같은 엔진의 별칭끼리 묶은 화면 이름.
 * - 장비 id 는 연결 이름이 있으면 보이는 이름으로 쓰지 않는다 — title 같은 보조 표시에만 둔다.
 */

// ── 모델 별칭 ──────────────────────────────────────────────────────────────────────────────────────────

/** M1 이 내보내는 Gemma 4 26B 의 이름들 — 2026-11-08 M1 서버가 목록 이름을 m1-gemma 로 바꿨다(옛 이름은 저장된 순위·계약에 남아 있을 수 있다). */
export const GEMMA_MODEL = "mlx-community--gemma-4-26b-a4b-it-4bit";
export const GEMMA_MODEL_NAMES: ReadonlySet<string> = new Set([GEMMA_MODEL, "m1-gemma"]);
export const GEMMA_DISPLAY = "Gemma 4 26B";
/** Supa vLLM 의 모델 — 같은 엔진이 짧은 별칭 `supa` 로도 목록에 낸다 */
export const SUPA_MODEL = "Inferact/Qwen3.8-27B-NVFP4";

/** 모델 하나의 화면 이름. 증명된 별칭만 묶는다 — Gemma 의 옛·새 이름, 같은 목록에 정식 이름이 함께 있는 `supa`. 그 밖은 그대로. */
export function modelDisplayName(model: string, siblings: readonly string[] = []): string {
  if (GEMMA_MODEL_NAMES.has(model)) return GEMMA_DISPLAY;
  if (model === "supa" && siblings.includes(SUPA_MODEL)) return SUPA_MODEL;
  return model;
}
/** 모델 이름들 → 화면 이름(처음 나온 순서, 같은 화면 이름은 하나) */
export function modelDisplayNames(ids: readonly string[]): string[] {
  return [...new Set(ids.map(id => modelDisplayName(id, ids)))];
}

// ── 장비 ──────────────────────────────────────────────────────────────────────────────────────────────

export type DisplayConnection = Pick<AiConnectionView, "id" | "label" | "kind" | "cliTool" | "deviceId" | "enabled">
  & Partial<Pick<AiConnectionView, "models" | "cliModels" | "baseUrl">>;
type DisplayObservation = Pick<AdminModelsObservation, "configuredRoutes"> | null | undefined;
export type DeviceDisplay = Readonly<{
  deviceId: string;
  /** 보이는 이름 */
  name: string;
  /** 이 장비의 LLM 모델(별칭은 하나로) — 이름 아래 한 줄 */
  models: readonly string[];
  /** 이 장비를 쓰는 연결(꺼진 것 포함) */
  connections: readonly Readonly<{ id: string; label: string; enabled: boolean }>[];
  /** connection = 연결 이름, cli = CLI 도구 이름, id = 장비 id 그대로 */
  source: "connection" | "cli" | "id";
}>;

/** 잘 알려진 CLI 장비 이름 → 그 도구(정책 경로가 없을 때도 장비 행만으로 CLI 도구를 안다) */
export const CLI_VENDOR_DEVICES: Readonly<Record<string, string>> = Object.freeze({ "anthropic-cli": "claude-cli", "openai-cli": "codex-cli", "xai-cli": "grok-cli" });
export const isCliProvider = (provider: string) => /-cli$/.test(provider);
export const cliProviderLabel = (provider: string) => {
  const tool = aiCliToolOfProvider(provider);
  return tool ? AI_CLI_TOOL_LABELS[tool] : provider;
};
const connectionModelIds = (connection: DisplayConnection): string[] =>
  connection.kind === "api" ? (connection.models ?? []).map(model => model.id) : [...connection.cliModels ?? []];
const byName = (a: string, b: string) => a.localeCompare(b, "ko");

/** 장비 하나의 이름·모델. connections 를 못 읽었으면(null) CLI 도구 이름 또는 장비 id 다. */
export function deviceDisplay(deviceId: string, connections: readonly DisplayConnection[] | null | undefined, observation?: DisplayObservation): DeviceDisplay {
  const mine = (connections ?? []).filter(connection => connection.deviceId === deviceId);
  const enabled = mine.filter(connection => connection.enabled);
  const named = enabled.length ? enabled : mine;
  const labels = [...new Set(named.map(connection => aiConnectionLabel(connection)))].sort(byName);
  const models = modelDisplayNames(enabled.flatMap(connectionModelIds));
  const base = { deviceId, models, connections: mine.map(connection => ({ id: connection.id, label: aiConnectionLabel(connection), enabled: connection.enabled })) };
  if (labels.length) return { ...base, name: labels.join(" · "), source: "connection" };
  const cli = (observation?.configuredRoutes ?? []).find(route => route.groupId === deviceId && isCliProvider(route.provider))?.provider ?? CLI_VENDOR_DEVICES[deviceId];
  if (cli) return { ...base, name: cliProviderLabel(cli), source: "cli" };
  return { ...base, name: deviceId, source: "id" };
}

/** 화면에 나오는 모든 장비(연결·정책 경로·장부·장비 상태의 장비 id) → 이름·모델 */
export function deviceDisplayMap(connections: readonly DisplayConnection[] | null | undefined,
  observation?: (DisplayObservation & Partial<Pick<AdminModelsObservation, "groups" | "devices" | "rows">>) | null, extra: readonly string[] = []): Map<string, DeviceDisplay> {
  const ids = new Set<string>([...(connections ?? []).map(connection => connection.deviceId), ...(observation?.configuredRoutes ?? []).map(route => route.groupId),
    ...(observation?.groups ?? []).map(group => group.groupId), ...(observation?.devices ?? []).map(device => device.deviceId),
    ...(observation?.rows ?? []).map(row => row.groupId), ...extra].filter(Boolean));
  return new Map([...ids].map(id => [id, deviceDisplay(id, connections, observation)]));
}
/** 이름 아래 모델 한 줄 — 셋까지, 나머지는 「외 N」(CLI 카탈로그처럼 긴 목록이 머리를 덮지 않게) */
export const deviceModelsText = (models: readonly string[], max = 3) =>
  models.length > max ? `${models.slice(0, max).join(" · ")} 외 ${models.length - max}` : models.join(" · ");
/** 장비 id → 보이는 이름(모르는 장비는 id) */
export const deviceName = (names: ReadonlyMap<string, DeviceDisplay> | null | undefined, deviceId: string) => names?.get(deviceId)?.name ?? deviceId;

/**
 * 손댈 것이 없는 장비인가 — 그 장비를 쓰는 연결이 없고(꺼진 연결도 없음), CLI 도구 장비도 아니고, 장부·장비 상태에 쓰임(점유·대기·미확정·최근 1시간 정산)도 없다
 * (예: 2026-11 의 `supa` — 연결 없이 옛 정책 경로만 남은 장비). 이런 장비는 장비 한도 화면에만 두고 칸 배분·대시보드·LLM 운영 목록에서는 뺀다.
 * 연결이나 장부를 못 읽었으면 판정하지 않는다(false — 모르는 것을 숨기지 않는다).
 */
export function isOrphanDevice(deviceId: string, connections: readonly Pick<DisplayConnection, "deviceId">[] | null | undefined,
  observation: Pick<AdminModelsObservation, "error" | "observedAt" | "configuredRoutes" | "groups" | "devices" | "rows"> | null | undefined): boolean {
  if (!connections || !observation || observation.error || !observation.observedAt) return false;
  if (connections.some(connection => connection.deviceId === deviceId)) return false;
  if (CLI_VENDOR_DEVICES[deviceId] || (observation.configuredRoutes ?? []).some(route => route.groupId === deviceId && isCliProvider(route.provider))) return false;
  if (observation.groups.some(group => group.groupId === deviceId && group.held > 0)) return false;
  if (observation.devices.some(device => device.deviceId === deviceId && (device.active > 0 || device.waiting > 0))) return false;
  return !observation.rows.some(row => row.groupId === deviceId
    && row.dispatched + row.reserved + row.waiting + row.indeterminate + row.succeeded1h + row.failed1h + row.unclassified1h > 0);
}

// ── 용량 경로 ─────────────────────────────────────────────────────────────────────────────────────────

/** LLM 보조 작업(local-assist-<작업>-<백엔드>)의 작업 이름 */
export const ASSIST_TASK_LABELS: Readonly<Record<AssistWorkTask, string>> = Object.freeze({
  uptime: "연결 확인", repo_move: "저장소 이동", intro_recheck: "소개 재검수", decision_audit: "판정 감사", semantic_exception: "의미 예외", news: "소식",
});
const HELPER_ROUTE = new RegExp(`^local-assist-(${Object.keys(ASSIST_TASK_LABELS).join("|")})-([a-z0-9][a-z0-9-]{0,59})$`);
export type HelperRoute = Readonly<{ task: AssistWorkTask; backendId: string; label: string }>;
/** 보조 경로(local-assist-<작업>-<백엔드>)면 그 작업·백엔드·이름(「보조 · 연결 확인」), 아니면 null */
export function helperRouteOf(routeId: string): HelperRoute | null {
  const match = HELPER_ROUTE.exec(routeId);
  if (!match) return null;
  const task = match[1] as AssistWorkTask;
  return { task, backendId: match[2], label: `보조 · ${ASSIST_TASK_LABELS[task]}` };
}
/** 쓰지 않게 된 옛 경로 id(예: product-tagline-ko-qwen-legacy) */
export const isLegacyRouteId = (routeId: string) => /-legacy$/.test(routeId);
/** 장부 route → AI 작업(작업 목록의 routeId, LLM 보강이면 보강 일의 local-assist-<일>-<backend>, 없으면 단계 id). */
export function taskOfRoute(routeId: string): AiTaskDef | null {
  return AI_TASKS.find(task => task.routeId === routeId) ?? AI_TASKS.find(task => aiTaskOwnsLedgerRoute(task, routeId)) ?? aiTask(modelStageId(routeId));
}
function knownRouteLabel(routeId: string): string | null {
  const helper = helperRouteOf(routeId);
  if (helper) return helper.label;
  const task = taskOfRoute(routeId);
  if (task) return task.label;
  const stage = modelStageLabel(routeId);
  return stage === "다른 모델 단계" ? null : stage;
}
/**
 * 용량 경로의 사람 이름 — 보조 경로는 「보조 · <작업>」, 작업 목록의 경로는 작업 이름, 단계 경로는 단계 이름, 옛 경로는 「옛 경로 · <바탕 이름>」
 * (뒤 조각을 둘까지 떼어 아는 이름을 찾는다), 모르면 경로 id 그대로.
 */
export function routeDisplayLabel(routeId: string): string {
  const known = knownRouteLabel(routeId);
  if (known) return known;
  if (isLegacyRouteId(routeId)) {
    let base = routeId.replace(/-legacy$/, "");
    for (let drop = 0; drop <= 2 && base; drop += 1) {
      const label = knownRouteLabel(base);
      if (label) return `옛 경로 · ${label}`;
      base = base.includes("-") ? base.slice(0, base.lastIndexOf("-")) : "";
    }
    return `옛 경로 · ${routeId.replace(/-legacy$/, "")}`;
  }
  return routeId;
}
/** 화면에서 경로를 묶는 갈래 — helper = LLM 보조 작업 경로 */
export const routeGroupOf = (routeId: string): "helper" | "task" => helperRouteOf(routeId) ? "helper" : "task";

/**
 * 정책 경로 한 줄이 낡았는가(화면에서 숨겨도 되는가 — 데이터는 지우지 않는다):
 * 옛 경로 id(-legacy)이거나, API 경로인데 그 장비의 어떤 연결도 그 모델을 내놓지 않고(별칭 이름 `[supa] …`·옛 Gemma 이름 포함) 지금 순위·분산 구성도 그 모델을 쓰지 않는다.
 * CLI 경로(도구는 연결 밖에서 정한다), 연결을 못 읽었거나 그 장비에 연결이 없거나 그 장비 연결의 모델 목록을 못 읽은 경우는 낡았다고 하지 않는다.
 * references: 지금 순위·분산 구성이 쓰는 모델 이름(장부 이름의 「@연결 8자」는 떼고 맞춘다).
 */
export function isStalePolicyRoute(entry: Readonly<{ routeId: string; provider: string; model: string; groupId: string }>,
  connections: readonly DisplayConnection[] | null | undefined, references: ReadonlySet<string> = new Set()): boolean {
  if (isLegacyRouteId(entry.routeId)) return true;
  if (!connections || isCliProvider(entry.provider)) return false;
  const mine = connections.filter(connection => connection.deviceId === entry.groupId);
  // 연결이 하나도 없는 장비(연결 밖 계약으로 도는 경로일 수 있다)와 모델 목록을 못 읽은 연결은 판정하지 않는다 — 그런 장비는 isOrphanDevice 가 다룬다
  if (!mine.length || mine.some(connection => connection.kind === "api" && !connection.models)) return false;
  const bare = entry.model.replace(/@[0-9a-f]{8}$/i, "");
  if (references.has(entry.model) || references.has(bare)) return false;
  return !mine.some(connection => connectionModelIds(connection).some(id => id === bare || id === entry.model));
}

/** 갈린 장비 묶음 머리 이름 — 연결 이름들의 공통 앞 조각(「-」·공백으로 가른다). 「m3」처럼 글자+숫자 한 조각이면 대문자(M3). 없으면 null */
export function sharedColumnGroupName(names: readonly string[]): string | null {
  if (names.length < 2) return null;
  const parts = names.map(name => name.trim().split(/[-\s_]+/).filter(Boolean));
  const common: string[] = [];
  for (let index = 0; parts.every(list => index < list.length - 1 && list[index].toLowerCase() === parts[0][index].toLowerCase()); index += 1) common.push(parts[0][index]);
  if (!common.length) return null;
  const joined = common.join("-");
  return /^[a-z]\d+$/i.test(joined) ? joined.toUpperCase() : joined;
}

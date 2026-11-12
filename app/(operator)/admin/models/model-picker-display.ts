import { aiConnectionLabel, type AiConnectionView } from "@/lib/operations/admin-ai-tasks";
import { deviceDisplayMap, GEMMA_DISPLAY, GEMMA_MODEL as GEMMA, GEMMA_MODEL_NAMES as GEMMA_NAMES, SUPA_MODEL as SUPA } from "@/lib/operations/llm-display";

/** Presentation only. Execution identities, connection records and form bindings are never rewritten here. */
export type PickerConnection = Pick<AiConnectionView, "id" | "kind" | "cliTool"> & Partial<Pick<AiConnectionView, "label" | "baseUrl" | "deviceId" | "models" | "enabled">>;
type Choice = { provider: string; model: string };
type Option = Choice & { label: string; group?: string; text?: string };
/** M1 Studio 의 mlx_lm.server(Gemma 만 고를 수 있게 둔다)·Supa vLLM(supa 별칭) — 주소로 가린다. 보이는 이름은 늘 연결 이름표다(2026-11-09). */
const m1 = (connection: PickerConnection) => connection.kind === "api" && connection.baseUrl === "https://m1-studio.tail02799e.ts.net/v1";
const supa = (connection: PickerConnection) => connection.kind === "api" && connection.baseUrl === "http://100.78.219.124:8000/v1";

export function modelPickerConnectionLabel(connection: PickerConnection): string {
  return aiConnectionLabel({ ...connection, label: connection.label ?? "" });
}
/** 연결의 장비 id(정책 groupId) 그대로 — 같은 이름의 연결 둘을 가를 때만 쓴다 */
export function modelPickerConnectionDevice(connection: PickerConnection): string {
  return connection.deviceId ?? "";
}
export function modelPickerModelLabel(connection: PickerConnection, model: string): string {
  return m1(connection) && GEMMA_NAMES.has(model) ? GEMMA_DISPLAY : supa(connection) && model === "supa" ? SUPA : model;
}
/**
 * 서버가 만든 요약 글 안의 장비 id 를 그 장비의 연결 이름으로 바꾼다(예: 「m1-qwen」 → 「m1-gemma」). 연결 이름표 글자 안은 건드리지 않고,
 * 다른 이름의 일부(앞뒤가 영문·숫자·-·_)도 바꾸지 않는다. Text only — never apply this to a form field or a stored record.
 */
export function modelPickerVisibleText(text: string, connections: readonly PickerConnection[]): string {
  const known = connections.filter((connection): connection is PickerConnection & { deviceId: string; label: string } => !!connection.deviceId && !!connection.label)
    .map(connection => ({ id: connection.id, label: connection.label, kind: connection.kind, cliTool: connection.cliTool, deviceId: connection.deviceId,
      enabled: connection.enabled ?? true }));
  const swaps = [...deviceDisplayMap(known).values()].filter(device => device.source === "connection" && device.name !== device.deviceId)
    .sort((a, b) => b.deviceId.length - a.deviceId.length);
  if (!swaps.length) return text;
  const labels = [...new Set(known.map(connection => modelPickerConnectionLabel(connection)).filter(Boolean))].sort((a, b) => b.length - a.length);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ids = new RegExp(`(?<![A-Za-z0-9_-])(${swaps.map(device => escape(device.deviceId)).join("|")})(?![A-Za-z0-9_-])`, "g");
  const swap = (part: string) => part.replace(ids, id => swaps.find(device => device.deviceId === id)?.name ?? id);
  if (!labels.length) return swap(text);
  // 연결 이름표(예: 「m3-mlx (2)」)는 그대로 두고 그 사이 글자만 바꾼다
  return text.split(new RegExp(`(${labels.map(escape).join("|")})`)).map((part, index) => index % 2 ? part : swap(part)).join("");
}
export function modelPickerConnectionModels(connection: PickerConnection): AiConnectionView["models"] {
  const models = connection.models ?? null;
  if (models === null) return null;
  if (m1(connection)) return models.filter(model => GEMMA_NAMES.has(model.id)).slice(0, 1);
  if (supa(connection) && models.some(model => model.id === SUPA)) return models.filter(model => model.id !== "supa");
  return models;
}

/**
 * 한 연결의 모델 이름들을 화면 이름이 같은 것끼리 한 줄로 묶는다(처음 나온 자리 순서). 증명된 별칭(Supa 의 supa·Inferact 두 이름, M1 Gemma 의 옛·새 이름)만
 * 같은 화면 이름이 되므로 다른 모델은 합쳐지지 않는다. 표시만 — 저장된 목록·순위의 이름은 그대로다.
 */
export function modelPickerModelGroups(connection: PickerConnection, ids: readonly string[]): { label: string; ids: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const label = modelPickerModelLabel(connection, id), members = groups.get(label);
    if (!members) groups.set(label, [id]); else if (!members.includes(id)) members.push(id);
  }
  return [...groups].map(([label, members]) => ({ label, ids: members }));
}

/** The proven aliases share one engine. Picker display identity only; domain voting identities are unchanged. */
export function modelPickerChoiceKey(choice: Choice, connections: readonly PickerConnection[]): string {
  const connection = connections.find(entry => entry.id === choice.provider);
  const model = connection && supa(connection) && choice.model === "supa" ? SUPA
    : connection && m1(connection) && GEMMA_NAMES.has(choice.model) ? GEMMA : choice.model;
  return JSON.stringify([choice.provider, model]);
}

function pickerGroupName(connection: PickerConnection): string {
  return modelPickerConnectionLabel(connection) || modelPickerConnectionDevice(connection) || connection.cliTool || "";
}

/** Group headers identify only the connection and transport; live slot/status stays on the option itself. */
function pickerGroupLabel(connection: PickerConnection, connections: readonly PickerConnection[]): string {
  const name = pickerGroupName(connection);
  if (!name) return "";
  const classification = connection.kind === "api" ? "API" : "CLI";
  const device = modelPickerConnectionDevice(connection);
  const needsDevice = connections.some(entry => entry.id !== connection.id
    && entry.kind === connection.kind
    && pickerGroupName(entry) === name);
  const usefulDevice = needsDevice && device !== "" && device !== name ? device : "";
  return [name, usefulDevice, classification].filter(Boolean).join(" · ");
}

function withPickerGroup<T extends Option>(option: T, connection: PickerConnection, connections: readonly PickerConnection[], force = false): T {
  if (!force && !option.group) return option;
  const group = pickerGroupLabel(connection, connections);
  return group ? { ...option, group } : option;
}

/** 선택지의 보이는 글자가 서버 이름이 아니라 사용자가 정한 이름인가(운영 콘솔 통합 — aiModelChoiceName 이 만든 선택지) */
const named = (option: Option) => !!option.text && option.text !== option.model && !option.text.startsWith(`${option.model} (`);

export function presentPickerOptions<T extends Option>(options: readonly T[], connections: readonly PickerConnection[], current: Choice | null): T[] {
  const result: T[] = [], seen = new Set<string>();
  for (const option of options) {
    const connection = connections.find(entry => entry.id === option.provider);
    if (!connection) { result.push(option); continue; }
    if (connection.kind === "cli" && connection.cliTool === "opencode"
      && !/^deepseek(?:[-_.:]|$)/i.test(option.model.slice(option.model.lastIndexOf("/") + 1))
      && !(current?.provider === option.provider && current.model === option.model)) continue;
    if (m1(connection)) {
      if (!GEMMA_NAMES.has(option.model)) continue;
      // Gemma 의 두 이름은 한 줄로 — 고른 값이 있으면 그 이름(폼 값 그대로), 없으면 지금 서버 목록에 있는 이름
      const wanted = current?.provider === option.provider && GEMMA_NAMES.has(current.model) ? current.model : null;
      const selected = (wanted ? options.find(entry => entry.provider === option.provider && entry.model === wanted) : undefined)
        ?? options.find(entry => entry.provider === option.provider && GEMMA_NAMES.has(entry.model) && !("saved" in entry && entry.saved))
        ?? option;
      const key = modelPickerChoiceKey(selected, connections);
      if (seen.has(key)) continue;
      seen.add(key);
      const grouped = withPickerGroup(selected, connection, connections, true);
      // 선택지가 이미 사용자가 정한 이름이면(aiTaskRankOptions — 모델 하나인 연결) 그 이름을 둔다. 서버 이름이면 Gemma 이름으로
      result.push(named(selected) ? grouped : { ...grouped, text: GEMMA_DISPLAY, label: `${modelPickerConnectionLabel(connection)} · ${GEMMA_DISPLAY}` });
      continue;
    }
    if (supa(connection) && (option.model === "supa" || option.model === SUPA)) {
      // Retain a selected legacy wire alias in this select, while rendering exactly one canonical model label.
      const wanted = current?.provider === option.provider && (current.model === "supa" || current.model === SUPA) ? current.model : SUPA;
      const selected = options.find(entry => entry.provider === option.provider && entry.model === wanted)
        ?? options.find(entry => entry.provider === option.provider && entry.model === SUPA)
        ?? option;
      const key = modelPickerChoiceKey(selected, connections);
      if (seen.has(key)) continue;
      seen.add(key);
      const grouped = withPickerGroup(selected, connection, connections, Boolean(option.group));
      result.push(named(selected) ? grouped : { ...grouped, text: SUPA, label: `${modelPickerConnectionLabel(connection)} · ${SUPA}` });
      continue;
    }
    result.push(withPickerGroup(option, connection, connections));
  }
  return result;
}

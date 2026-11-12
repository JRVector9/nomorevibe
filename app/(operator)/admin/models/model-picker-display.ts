import { aiConnectionLabel, aiConnectionModelGroupKey, aiConnectionModelIds, aiModelDisplayName, type AiConnectionView } from "@/lib/operations/admin-ai-tasks";
import { deviceDisplayMap, GEMMA_DISPLAY, GEMMA_MODEL as GEMMA, GEMMA_MODEL_NAMES as GEMMA_NAMES, SUPA_MODEL as SUPA } from "@/lib/operations/llm-display";

/** Presentation only. Execution identities, connection records and form bindings are never rewritten here. */
export type PickerConnection = Pick<AiConnectionView, "id" | "kind" | "cliTool"> & Partial<Pick<AiConnectionView, "label" | "baseUrl" | "deviceId" | "models" | "enabled"
  | "displayName" | "cliModels" | "cliCatalog" | "manualModels">>;
type Choice = { provider: string; model: string };
type Option = Choice & { label: string; group?: string; text?: string; saved?: boolean; off?: boolean };
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

/**
 * 같은 모델(별칭)이면 같은 열쇠 — 증명된 별칭(주소로 가린 M1 Gemma 의 옛·새 이름 · Supa 의 supa·Inferact 이름)과 일반 규칙
 * (서버가 알려 준 root · 서버 목록이 한 묶음인 연결의 적은 이름 — aiConnectionModelGroupKey). Picker display identity only; domain voting identities are unchanged.
 */
export function modelPickerChoiceKey(choice: Choice, connections: readonly PickerConnection[]): string {
  const connection = connections.find(entry => entry.id === choice.provider);
  if (!connection) return JSON.stringify([choice.provider, choice.model]);
  if (supa(connection) && (choice.model === "supa" || choice.model === SUPA)) return JSON.stringify([choice.provider, SUPA]);
  if (m1(connection) && GEMMA_NAMES.has(choice.model)) return JSON.stringify([choice.provider, GEMMA]);
  return JSON.stringify([choice.provider, aiConnectionModelGroupKey({ kind: connection.kind, models: connection.models ?? null, manualModels: connection.manualModels },
    choice.model)]);
}
/** 새로 고를 때 그 묶음에서 실을 이름 — 실행 쪽이 이미 쓰는 이름(Supa 는 Inferact 이름, 그 밖은 서버 목록의 첫 이름). 저장된 값은 바꾸지 않는다 */
function canonicalModel(connection: PickerConnection, ids: readonly string[]): string {
  if (supa(connection) && ids.includes(SUPA)) return SUPA;
  const listed = (connection.models ?? []).map(model => model.id);
  return ids.find(id => listed.includes(id)) ?? ids[0];
}
/** 연결이 내놓는 서로 다른 모델 수(별칭은 하나) — 1 이면 모델 이름 하나만, 여럿이면 「이름 · 구분」 */
export function modelPickerModelCount(connection: PickerConnection, extra: readonly string[] = []): number {
  const ids = [...aiConnectionModelIds({ kind: connection.kind, models: modelPickerConnectionModels(connection), cliModels: connection.cliModels ?? [],
    cliTool: connection.cliTool, cliCatalog: connection.cliCatalog, manualModels: connection.manualModels }), ...extra];
  return new Set(ids.map(id => modelPickerChoiceKey({ provider: connection.id, model: id }, [connection]))).size;
}
/** 고르는 상자에 보이는 이름 — 모델 목록과 같은 이름 하나(aiModelDisplayName). 한 연결이 서로 다른 모델을 여럿 내놓을 때만 「이름 · 서버 모델 이름」 */
export function modelPickerOptionName(connection: PickerConnection, model: string, extra: readonly string[] = []): string {
  const name = aiModelDisplayName({ label: connection.label ?? "", displayName: connection.displayName });
  return modelPickerModelCount(connection, [model, ...extra]) <= 1 ? name : `${name} · ${model}`;
}

/**
 * 고르는 상자의 선택지(2026-11-12 소유자 「모델 목록에 모델이 떠 있으면 여기에 바로 그 이름이 떠야」) — 모델 하나에 줄 하나, 보이는 글자는 모델 목록과 같은 이름.
 * - 같은 모델의 별칭(증명된 별칭 · root · 적은 이름)은 한 줄로 묶는다. 그 줄의 값은: 이 칸에 저장된 이름이 그 묶음이면 그 이름 그대로(저장 값을 바꾸지 않는다),
 *   아니면 실행 쪽이 쓰는 이름(canonicalModel).
 * - 한 연결이 서로 다른 모델을 여럿 내놓으면(CLI 의 여러 모델 · OpenCode) 「이름 · 서버 모델 이름」.
 * - OpenCode 는 DeepSeek 만(지금 이 칸 값은 남긴다), M1 Studio 는 Gemma 만 — 전과 같다.
 * - 지금 목록에 없는 저장된 값은 「이름 · 서버 모델 이름 (목록에 없음)」으로 남는다. 꺼진 연결은 「(꺼짐)」.
 * 묶음 머리(optgroup)는 두지 않는다 — 줄마다 이름이 이미 모델이다. 순서는 받은 선택지 차례(API 먼저, 이름순).
 */
export function presentPickerOptions<T extends Option>(options: readonly T[], connections: readonly PickerConnection[], current: Choice | null): T[] {
  const groups = new Map<string, { connection: PickerConnection | null; members: T[] }>();
  const order: string[] = [];
  const shown = options.flatMap(option => {
    const connection = connections.find(entry => entry.id === option.provider) ?? null;
    const mine = current?.provider === option.provider && current.model === option.model;
    if (connection?.kind === "cli" && connection.cliTool === "opencode"
      && !/^deepseek(?:[-_.:]|$)/i.test(option.model.slice(option.model.lastIndexOf("/") + 1)) && !mine) return [];
    if (connection && m1(connection) && !GEMMA_NAMES.has(option.model) && !mine) return [];
    return [{ option, connection, key: connection ? modelPickerChoiceKey(option, connections) : null }];
  });
  // 저장된 값이 지금 목록의 어느 모델의 별칭이면 그 줄에 든다(같은 모델). 아니면 따로 — 어느 이름이 사라졌는지 보여야 고칠 수 있다
  const listedKeys = new Set(shown.flatMap(entry => entry.key && !entry.option.saved ? [entry.key] : []));
  for (const { option, connection, key: choiceKey } of shown) {
    const key = choiceKey && (!option.saved || listedKeys.has(choiceKey)) ? choiceKey : JSON.stringify(["raw", option.provider, option.model]);
    const group = groups.get(key);
    if (group) group.members.push(option); else { groups.set(key, { connection, members: [option] }); order.push(key); }
  }
  return order.map(key => {
    const { connection, members } = groups.get(key)!;
    if (!connection) return members[0];
    const ids = members.map(member => member.model);
    const wanted = current?.provider === members[0].provider && ids.includes(current.model) ? current.model : null;
    const model = wanted ?? canonicalModel(connection, members.filter(member => !member.saved).map(member => member.model).concat(ids));
    const picked = members.find(member => member.model === model) ?? members[0];
    const base = aiModelDisplayName({ label: connection.label ?? "", displayName: connection.displayName });
    const missing = members.every(member => member.saved);
    const name = missing ? `${base} · ${picked.model} (목록에 없음)` : `${modelPickerOptionName(connection, picked.model)}${picked.off ? " (꺼짐)" : ""}`;
    return { ...picked, label: name, text: name, group: undefined };
  });
}

import { aiConnectionLabel, type AiConnectionView } from "@/lib/operations/admin-ai-tasks";

/** Presentation only. Execution identities, connection records and form bindings are never rewritten here. */
export type PickerConnection = Pick<AiConnectionView, "id" | "kind" | "cliTool"> & Partial<Pick<AiConnectionView, "label" | "baseUrl" | "deviceId" | "models">>;
type Choice = { provider: string; model: string };
type Option = Choice & { label: string; group?: string; text?: string };
const GEMMA = "mlx-community--gemma-4-26b-a4b-it-4bit";
const SUPA = "Inferact/Qwen3.8-27B-NVFP4";
const m1 = (connection: PickerConnection) => connection.kind === "api" && connection.deviceId === "m1-qwen"
  && connection.baseUrl === "https://m1-studio.tail02799e.ts.net/v1";
const supa = (connection: PickerConnection) => connection.kind === "api" && connection.deviceId === "supa-direct"
  && connection.baseUrl === "http://100.78.219.124:8000/v1";

export function modelPickerConnectionLabel(connection: PickerConnection): string {
  return aiConnectionLabel({ ...connection, label: connection.label ?? "" });
}
export function modelPickerConnectionDevice(connection: PickerConnection): string {
  return m1(connection) ? "M1 Studio" : connection.deviceId ?? "";
}
export function modelPickerModelLabel(connection: PickerConnection, model: string): string {
  return m1(connection) && model === GEMMA ? "Gemma 4 26B" : supa(connection) && model === "supa" ? SUPA : model;
}
/** Existing server-generated summaries are text only; never apply this to a form field or a stored record. */
export function modelPickerVisibleText(text: string, connections: readonly PickerConnection[]): string {
  return connections.some(m1) ? text.replaceAll("m1-qwen", "M1 Studio") : text;
}
export function modelPickerConnectionModels(connection: PickerConnection): AiConnectionView["models"] {
  const models = connection.models ?? null;
  if (models === null) return null;
  if (m1(connection)) return models.filter(model => model.id === GEMMA);
  if (supa(connection) && models.some(model => model.id === SUPA)) return models.filter(model => model.id !== "supa");
  return models;
}

/** The proven aliases share one engine. Picker display identity only; domain voting identities are unchanged. */
export function modelPickerChoiceKey(choice: Choice, connections: readonly PickerConnection[]): string {
  const connection = connections.find(entry => entry.id === choice.provider);
  const model = connection && supa(connection) && choice.model === "supa" ? SUPA : choice.model;
  return JSON.stringify([choice.provider, model]);
}

function pickerGroupName(connection: PickerConnection): string {
  if (m1(connection)) return modelPickerConnectionDevice(connection);
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

export function presentPickerOptions<T extends Option>(options: readonly T[], connections: readonly PickerConnection[], current: Choice | null): T[] {
  const result: T[] = [], seen = new Set<string>();
  for (const option of options) {
    const connection = connections.find(entry => entry.id === option.provider);
    if (!connection) { result.push(option); continue; }
    if (connection.kind === "cli" && connection.cliTool === "opencode"
      && !/^deepseek(?:[-_.:]|$)/i.test(option.model.slice(option.model.lastIndexOf("/") + 1))
      && !(current?.provider === option.provider && current.model === option.model)) continue;
    if (m1(connection)) {
      if (option.model !== GEMMA) continue;
      const grouped = withPickerGroup(option, connection, connections, true);
      result.push({ ...grouped, text: "Gemma 4 26B", label: "M1 Studio · Gemma 4 26B" });
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
      result.push({ ...grouped, text: SUPA, label: `${connection.label} · ${SUPA}` });
      continue;
    }
    result.push(withPickerGroup(option, connection, connections));
  }
  return result;
}

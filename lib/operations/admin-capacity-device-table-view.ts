import { routeModelBase, type StaleRouteCandidate } from "@/lib/llm/capacity-retire";
import { aiConnectionLabel } from "./admin-ai-tasks";
import type { DeviceSource, DeviceView } from "./admin-capacity-devices";
import { deviceRoleLabel } from "./admin-capacity-devices";
import type { AdminModelsObservation } from "./admin-models-observation";
import { deviceDisplay, isOrphanDevice, modelDisplayName, modelDisplayNames, sharedColumnGroupName, type DisplayConnection } from "./llm-display";

/**
 * 장비 한도 표(/admin/models/devices, 2026-11-09 개편 시안 #devices)의 줄 — 순수, DB 를 읽지 않는다. 서버 한 대가 한 줄이다.
 *
 * - kind = plain(한도 하나) · models(모델이 나뉜 장비: 부모 줄 = 전체 공유 한도, 아래 모델마다 한도·엔진 최대치 줄) · cli(작업마다 모델·강도를 고르는 CLI —
 *   작업 줄은 화면이 따로 끼운다) · orphan(연결도 쓰임도 없는 장비 — llm-display isOrphanDevice; 지우기만 된다).
 * - 모델이 나뉜 장비: 켜진 API 연결이 내놓는 모델(화면 이름으로 셋 이상의 별칭을 묶은 뒤) 둘 이상이거나, 저장된 모델 한도 줄이 있다.
 *   줄 = 켜진 API 연결이 내놓는 모델 ∪ 저장된 모델 한도·지금 점유가 있는 모델(DeviceView.models). 줄 이름은 그 모델을 내놓는 연결 이름이다.
 * - OpenCode CLI 연결은 모델을 그 연결이 정한다 — 일반 줄로 두고 모델 옆에 「고정」.
 * - 지우기: 연결이 없는 장비(isOrphanDevice)만. 쓰는 장비는 이유(연결 수·CLI·남은 쓰임·읽지 못함)를 단다. 실제 판정은 저장소가 다시 한다(retireCapacityDevice).
 */
export type DeviceTableKind = "plain" | "models" | "cli" | "orphan";
export type DeviceTableModelLine = {
  model: string;
  /** 그 모델을 내놓는 켜진 연결 이름(「 · 」) — 없으면 모델 화면 이름 */
  name: string; exposed: boolean;
  maxSlots: number | null; engineMax: number | null; active: number | null; waiting: number | null;
  /** 이 장비에서 이 모델로 가는 정책 경로 이름 */
  tasks: string[] };
export type DeviceTableRow = {
  deviceId: string; name: string; kind: DeviceTableKind;
  /** 이름 아래 작은 한 줄(「장비 m3-mlx · 모델 2개」, 「CLI · 작업마다 모델·강도」, 「연결 없음」) — 없으면 null */
  sub: string | null;
  models: string[]; modelFixed: boolean;
  limitSlots: number | null; engineMax: number | null; active: number | null; waiting: number | null;
  tasks: string[];
  version: number | null; source: DeviceSource; enabled: boolean;
  lines: DeviceTableModelLine[];
  /** 운영 한도 칸을 고칠 수 있는가 — 아니면 그 이유 */
  editable: boolean; editReason: string | null;
  /** 지우기 단추를 켤 수 있는가 — 아니면 그 이유(단추 title) */
  retirable: boolean; retireReason: string | null;
  issues: string[] };
export type DeviceTableInput = {
  devices: readonly DeviceView[];
  connections: readonly DisplayConnection[] | null;
  observation: Pick<AdminModelsObservation, "error" | "observedAt" | "configuredRoutes" | "groups" | "devices" | "rows"> | null;
  readOnly: boolean };

const unique = (items: readonly string[]) => [...new Set(items)];
const apiModels = (connection: DisplayConnection) => connection.kind === "api" ? (connection.models ?? []).map(model => model.id) : [];
const observationReadable = (observation: DeviceTableInput["observation"]) => !!observation && !observation.error && !!observation.observedAt;

function retireVerdict(device: DeviceView, mine: readonly DisplayConnection[], input: DeviceTableInput, orphan: boolean, cli: boolean): { retirable: boolean; reason: string | null } {
  if (input.readOnly) return { retirable: false, reason: "읽기 전용이라 지울 수 없습니다" };
  if (orphan) return { retirable: true, reason: null };
  if (!input.connections || !observationReadable(input.observation)) return { retirable: false, reason: "연결·장부를 읽지 못해 지워도 되는지 판정하지 않았습니다" };
  if (mine.length) return { retirable: false, reason: `연결 ${mine.length}개가 이 서버를 씁니다` };
  if (cli) return { retirable: false, reason: "CLI 도구 장비입니다" };
  return { retirable: false, reason: `점유·대기·최근 1시간 호출이 남아 있습니다${device.live && device.live.active + device.live.waiting > 0 ? ` (지금 ${device.live.active} · 대기 ${device.live.waiting})` : ""}` };
}

export function buildDeviceTableRows(input: DeviceTableInput): DeviceTableRow[] {
  const routes = input.observation?.configuredRoutes ?? [];
  return input.devices.map(device => {
    const mine = (input.connections ?? []).filter(connection => connection.deviceId === device.deviceId);
    const enabled = mine.filter(connection => connection.enabled);
    const display = deviceDisplay(device.deviceId, input.connections, input.observation);
    const orphan = isOrphanDevice(device.deviceId, input.connections, input.observation);
    const enabledCli = enabled.filter(connection => connection.kind === "cli");
    const opencode = enabledCli.length > 0 && enabledCli.every(connection => connection.cliTool === "opencode") && enabled.every(connection => connection.kind === "cli");
    const cli = !orphan && !opencode && (enabledCli.length > 0 ? enabled.every(connection => connection.kind === "cli") : !enabled.length && display.source === "cli");
    const exposed = unique(enabled.flatMap(apiModels));
    const saved = device.models ?? [];
    const kind: DeviceTableKind = orphan ? "orphan" : cli ? "cli"
      : modelDisplayNames(exposed).length >= 2 || saved.some(line => line.maxSlots !== null) ? "models" : "plain";
    const lineModels = kind === "models" ? unique([...exposed, ...saved.map(line => line.model)]).sort((a, b) => a < b ? -1 : a > b ? 1 : 0) : [];
    const lines: DeviceTableModelLine[] = lineModels.map(model => {
      const stored = saved.find(line => line.model === model);
      const owners = enabled.filter(connection => apiModels(connection).includes(model)).map(connection => aiConnectionLabel(connection));
      const tasks = unique(routes.filter(route => route.groupId === device.deviceId && (route.model === model || routeModelBase(route.model) === model))
        .map(route => deviceRoleLabel(route.routeId)));
      return { model, name: owners.length ? unique(owners).join(" · ") : modelDisplayName(model, exposed), exposed: owners.length > 0,
        maxSlots: stored?.maxSlots ?? null, engineMax: stored?.engineMax ?? null,
        active: stored?.active ?? (device.live ? 0 : null), waiting: stored?.waiting ?? (device.live ? 0 : null), tasks };
    });
    const sub = kind === "models" ? `장비 ${device.deviceId} · 모델 ${lines.length}개`
      : kind === "cli" ? "CLI · 작업마다 모델·강도"
      : kind === "orphan" ? "연결 없음"
      : display.name !== device.deviceId ? `장비 ${device.deviceId}` : null;
    const editReason = input.readOnly ? "읽기 전용입니다" : !device.enabled ? "꺼진 장비 — 세부 설정에서 켜 주세요" : orphan ? "연결이 없는 장비입니다" : null;
    const retire = retireVerdict(device, mine, input, orphan, cli || display.source === "cli");
    const groupName = kind === "models" ? sharedColumnGroupName(lines.filter(line => line.exposed).map(line => line.name)) : null;
    return { deviceId: device.deviceId, name: groupName ?? display.name, kind, sub,
      models: kind === "cli" ? [] : [...display.models], modelFixed: opencode,
      limitSlots: device.settings.limitSlots, engineMax: device.settings.physicalLimit,
      active: device.live?.active ?? null, waiting: device.live?.waiting ?? null,
      tasks: unique(device.roles.filter(role => role.inPolicy).map(role => role.label)),
      version: device.version, source: device.source, enabled: device.enabled, lines,
      editable: editReason === null, editReason, retirable: retire.retirable, retireReason: retire.reason, issues: device.issues };
  });
}


/** 「옛 정책 경로 정리」 한 줄 — 화면이 고르는 값(route = JSON [routeId, provider, model, groupId], pruneInputFromForm 과 짝)과 보이는 글 */
export type StaleRouteItem = { value: string; routeId: string; label: string; model: string; server: string; reason: string; detail: string };
export function staleRouteItems(candidates: readonly Pick<StaleRouteCandidate, "route" | "reason" | "deviceWithoutConnection" | "aliasHints">[],
  connections: readonly DisplayConnection[] | null, observation?: DeviceTableInput["observation"]): StaleRouteItem[] {
  return candidates.map(({ route, reason, deviceWithoutConnection, aliasHints }) => ({
    value: JSON.stringify([route.routeId, route.provider, route.model, route.groupId]),
    routeId: route.routeId, label: deviceRoleLabel(route.routeId), model: route.model,
    server: deviceDisplay(route.groupId, connections, observation).name,
    reason: deviceWithoutConnection ? "연결 없는 장비의 경로" : aliasHints.length ? "옛 모델 이름" : "연결이 이 모델을 내보내지 않음",
    detail: [reason, ...aliasHints].join("\n") }));
}

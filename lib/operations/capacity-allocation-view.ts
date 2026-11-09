import { AI_TASKS } from "@/lib/llm/ai-tasks";
import type { ModelCapacityDeviceState, ModelCapacityRouteQuota } from "@/lib/llm/capacity-devices";
import type { AdminModelsObservation } from "./admin-models-observation";
import { deviceDisplay, helperRouteOf, isLegacyRouteId, isOrphanDevice, isStalePolicyRoute, routeDisplayLabel, routeGroupOf, taskOfRoute, type DisplayConnection } from "./llm-display";
import { observationReadable } from "./llm-ops-view";

/**
 * 「칸 배분」(/admin/models/allocation, step 3 — 운영자 결정 2026-11-08) 화면 모형. DB 를 읽지 않는 순수 함수다.
 *
 * 줄 = 작업 영역(용량 경로 route 하나 — 2차 AI 검수 투표자 1·2·3 은 같은 route `second-review` 라 한 줄), 열 = 장비 행이 있고 켜진 장비(실시간 상태의
 * source = table). 칸은 지금 정책이 그 경로를 그 장비로 보낼 때(policy routes[].groupId) 또는 그 장비에 그 경로의 몫 줄이 저장돼 있을 때만 있다 —
 * 정책에서 빠진 경로의 저장된 몫도 칸으로 보여야 지울 수 있고, 장비를 저장할 때 조용히 사라지지 않는다.
 * 값은 장비 상태(readModelCapacityDeviceStates: lendIdle·routes[] 의 min/max·점유·대기·held)와 장부 관측(최근 1시간 정산)에서 온다 —
 * 같은 읽기 전용 스냅숏(readAdminModelsObservation) 하나다. 저장 CAS 의 판(version)도 그 상태의 장비 행 판이다.
 *
 * 이름(2026-11-09): 열 머리는 장비 id 가 아니라 그 장비를 쓰는 연결 이름과 그 아래 모델 이름(llm-display deviceDisplay)이고, 연결도 쓰임도 없는 장비(isOrphanDevice)는
 * 열을 만들지 않는다(장비 한도 화면에만 남는다). 줄은 보조 경로(local-assist-*)를 「보조」 갈래로 뒤에 모으고, 낡은 정책 경로(isStalePolicyRoute — 옛 경로 id,
 * 그 장비의 어느 연결도 내놓지 않고 순위·분산도 쓰지 않는 모델)만 있고 몫 줄·점유·정산도 없는 줄은 stale 로 표시해 화면이 숨긴다. 데이터는 지우지 않는다.
 *
 * 몫의 뜻(lib/llm/capacity-devices.ts 머리 주석): 보장(min) = 그 영역에 일이 있으면 비워 두는 칸, 상한(max) = 한 번에 쥘 수 있는 칸(비움 = 없음,
 * 0 = 이 장비에서 뺌), 빈 칸 빌려 쓰기(lend_idle, 기본 켬). 두 칸을 모두 비운 줄(보장 0·상한 없음)은 오늘과 같으므로 저장하지 않는다.
 */

export type AllocationCell = Readonly<{
  deviceId: string; routeId: string;
  /** 지금 정책이 이 경로를 이 장비로 보낸다. false = 정책에서 빠졌는데 몫 줄만 남아 있다 */
  mapped: boolean;
  /** 저장된 몫 줄(없으면 둘 다 null — 오늘과 같은 입장) */
  minSlots: number | null; maxSlots: number | null;
  /** 실시간: 이 경로가 이 장비에서 쥔 칸(예약+진행) · 현재 세대 대기 · 다른 경로가 비워 두는 이 경로의 못 채운 보장 · 지금 적용 상한 */
  active: number; waiting: number; held: number; cap: number | null;
  /** 장부 최근 1시간 정산(성공+실패+판정 없음) · 그중 실패 */
  settled1h: number; failed1h: number;
}>;
/** group: helper = LLM 보조 작업 경로(local-assist-*). stale = 낡은 정책 경로만 남은 줄(몫 줄·점유·정산 없음) — 화면은 숨기고 수만 알린다 */
export type AllocationRow = Readonly<{ routeId: string; label: string; group: "task" | "helper"; stale: boolean; cells: readonly (AllocationCell | null)[] }>;
export type AllocationDevice = Readonly<{
  deviceId: string;
  /** 보이는 이름 — 그 장비를 쓰는 연결 이름들(없으면 CLI 도구 이름, 그것도 없으면 장비 id). 장비 id 는 title 에만 */
  name: string;
  /** 그 장비의 LLM 모델(같은 엔진의 별칭은 하나로) — 이름 아래 한 줄 */
  models: readonly string[];
  limitSlots: number; version: number; lendIdle: boolean; active: number; waiting: number;
  /** 저장된 보장 합계 · 한도를 넘는가(DB 검사가 막으므로 저장된 값으로는 늘 false 여야 한다) */
  guaranteeSum: number; over: boolean;
  /** 저장된 몫 줄 수 */
  lines: number;
  /** 이 열에 칸이 있는 경로(저장 폼이 읽을 줄 — 숨긴 stale 줄은 빠진다) */
  routes: readonly string[];
}>;
/** policy_fallback = 장비 행이 없거나 꺼져 정책 대체 한도로 돈다 · unconfigured = 행도 대체 한도도 없어 그 장비로 가는 요청이 보류된다 */
export type AllocationSkipped = Readonly<{ deviceId: string; name: string; reason: "policy_fallback" | "unconfigured" }>;
export type AllocationView = Readonly<{
  observedAt: string | null; readable: boolean; policyVerified: boolean;
  devices: readonly AllocationDevice[]; rows: readonly AllocationRow[];
  /** 정책 경로가 가지만 장비 행이 없어(정책 대체 한도) 몫을 둘 수 없는 장비 */
  skipped: readonly AllocationSkipped[];
  /** 연결도 쓰임도 없어 열을 만들지 않은 장비(이름) — 장비 한도 화면에서 지우거나 고친다 */
  orphans: readonly string[];
  errors: readonly string[];
}>;
export type AllocationInput = Readonly<{
  observation: AdminModelsObservation;
  /** AI 연결(장비 이름·모델, 낡은 경로·손댈 것 없는 장비 판정). 못 읽었으면 null — 장비 id 를 쓰고 아무것도 숨기지 않는다 */
  connections?: readonly DisplayConnection[] | null;
  /** 지금 순위·분산 구성이 쓰는 모델 이름(낡은 경로 판정에서 「쓰는 중」으로 본다). 못 읽었으면 null — 옛 경로 id(-legacy)만 낡았다고 본다 */
  references?: ReadonlySet<string> | null;
}>;

/** 백엔드(parseModelCapacityRouteQuotasInput·routeQuotasToRecords)와 같은 순서 — 거절 경로의 quotas.<i> 가 이 순서의 i 다 */
export const compareRouteIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * 작업 영역 이름 — 작업 이름(여러 칸 작업은 칸을 함께 적는다: 「2차 AI 검수 (투표자 1·2·3)」), 보조 경로는 「보조 · 연결 확인」, 작업이 없으면 단계 이름,
 * 옛 경로는 「옛 경로 · …」, 그것도 없으면 route id(llm-display routeDisplayLabel)
 */
export function allocationAreaLabel(routeId: string): string {
  const task = taskOfRoute(routeId);
  if (task && task.slots > 1 && task.slotLabel) return `${task.label} (${task.slotLabel} ${Array.from({ length: task.slots }, (_, index) => index + 1).join("·")})`;
  return routeDisplayLabel(routeId);
}
/** 줄 순서 — 작업 목록 순, 그다음 모르는 경로, 보조 경로는 맨 뒤(작업 이름 순) */
const taskOrder = (routeId: string) => {
  if (helperRouteOf(routeId)) return AI_TASKS.length + 1;
  const task = taskOfRoute(routeId);
  const index = task ? AI_TASKS.indexOf(task) : -1;
  return index < 0 ? AI_TASKS.length : index;
};
/** 저장된 몫 줄 = 장비 상태 routes 중 min 이 있는 것(몫 줄 ∪ 살아 있는 행이 있는 경로 중 앞의 것) */
const quotaLines = (state: ModelCapacityDeviceState) => (state.routes ?? []).filter(route => route.minSlots !== null);

export function buildCapacityAllocationView({ observation, connections = null, references = null }: AllocationInput): AllocationView {
  const readable = observationReadable(observation);
  const errors: string[] = [];
  if (!readable) errors.push(observation.error ?? "운영 DB 실측을 읽지 못했습니다.");
  else if (!observation.devicesRead) errors.push("장비 상태(model_capacity_devices)를 읽지 못해 칸을 보이거나 나눌 수 없습니다. 새로고침해 주세요.");
  if (readable && !observation.policyVerified)
    errors.push("용량 정책을 확인하지 못해 어느 작업이 어느 장비로 가는지 모릅니다 — 저장된 몫만 보입니다(pipeline-control status 로 확인).");
  const policyRoutes = readable && observation.policyVerified ? observation.configuredRoutes ?? [] : [];
  const mapped = new Map<string, Set<string>>();
  for (const route of policyRoutes) mapped.set(route.groupId, (mapped.get(route.groupId) ?? new Set()).add(route.routeId));
  const states = readable ? observation.devices : [];
  const display = (deviceId: string) => deviceDisplay(deviceId, connections, observation);
  // 연결도 쓰임도 없는 장비 — 몫 줄이 남아 있으면 지울 수 있게 열로 둔다
  const orphan = (deviceId: string) => {
    const state = states.find(entry => entry.deviceId === deviceId);
    return isOrphanDevice(deviceId, connections, observation) && !(state && quotaLines(state).length);
  };
  const skipped: AllocationSkipped[] = observation.devicesRead ? [...mapped.keys()].filter(deviceId => !orphan(deviceId)).sort((a, b) => a.localeCompare(b))
    .flatMap((deviceId): AllocationSkipped[] => {
      const state = states.find(entry => entry.deviceId === deviceId), name = display(deviceId).name;
      return !state ? [{ deviceId, name, reason: "unconfigured" }] : state.source === "policy_fallback" ? [{ deviceId, name, reason: "policy_fallback" }] : [];
    }) : [];
  const candidates = states.filter(state => state.source === "table" && state.version !== null
    && ((mapped.get(state.deviceId)?.size ?? 0) > 0 || quotaLines(state).length > 0));
  const orphans = [...new Set([...candidates.map(state => state.deviceId), ...mapped.keys()].filter(orphan))].sort((a, b) => a.localeCompare(b)).map(id => display(id).name);
  const columns = candidates.filter(state => !orphan(state.deviceId))
    .sort((a, b) => (mapped.get(b.deviceId)?.size ?? 0) - (mapped.get(a.deviceId)?.size ?? 0) || a.deviceId.localeCompare(b.deviceId));
  const routeIds = [...new Set(columns.flatMap(state => [...mapped.get(state.deviceId) ?? [], ...quotaLines(state).map(line => line.routeId)]))]
    .sort((a, b) => taskOrder(a) - taskOrder(b) || (helperRouteOf(a) && helperRouteOf(b) ? allocationAreaLabel(a).localeCompare(allocationAreaLabel(b), "ko") : 0)
      || compareRouteIds(a, b));
  const metrics = readable ? observation.rows : [];
  const cellOf = (state: ModelCapacityDeviceState, routeId: string): AllocationCell | null => {
    const inPolicy = mapped.get(state.deviceId)?.has(routeId) ?? false;
    const live = (state.routes ?? []).find(route => route.routeId === routeId);
    const line = live && live.minSlots !== null ? live : undefined;
    if (!inPolicy && !line) return null;
    const ledger = metrics.filter(row => row.routeId === routeId && row.groupId === state.deviceId);
    return { deviceId: state.deviceId, routeId, mapped: inPolicy, minSlots: line?.minSlots ?? null, maxSlots: line ? line.maxSlots : null,
      active: live?.active ?? 0, waiting: live?.waiting ?? 0, held: live?.held ?? 0, cap: live?.cap ?? null,
      settled1h: ledger.reduce((sum, row) => sum + row.succeeded1h + row.failed1h + row.unclassified1h, 0),
      failed1h: ledger.reduce((sum, row) => sum + row.failed1h, 0) };
  };
  // 낡은 칸: 정책이 보내지만 그 정책 줄이 모두 낡았고(isStalePolicyRoute) 몫 줄·점유·대기·최근 1시간 정산이 없다
  const staleCell = (cell: AllocationCell) => cell.mapped && cell.minSlots === null && cell.maxSlots === null
    && cell.active + cell.waiting + cell.held + cell.settled1h + cell.failed1h === 0
    && policyRoutes.filter(route => route.routeId === cell.routeId && route.groupId === cell.deviceId)
      .every(route => references ? isStalePolicyRoute(route, connections, references) : isLegacyRouteId(route.routeId));
  const built = routeIds.map(routeId => {
    const cells = columns.map(state => cellOf(state, routeId));
    const present = cells.filter((cell): cell is AllocationCell => cell !== null);
    return { routeId, label: allocationAreaLabel(routeId), group: routeGroupOf(routeId), stale: present.length > 0 && present.every(staleCell), cells };
  });
  // 같은 이름의 보조 줄(같은 작업, 다른 백엔드)은 백엔드를 덧붙여 가른다
  const rows: AllocationRow[] = built.map(row => {
    const helper = helperRouteOf(row.routeId);
    return helper && built.some(other => other !== row && !other.stale && other.label === row.label) ? { ...row, label: `${row.label} (${helper.backendId})` } : row;
  });
  const devices: AllocationDevice[] = columns.map((state, index) => {
    const lines = quotaLines(state);
    const guaranteeSum = lines.reduce((sum, line) => sum + (line.minSlots ?? 0), 0);
    const { name, models } = display(state.deviceId);
    return { deviceId: state.deviceId, name, models, limitSlots: state.limitSlots, version: state.version!,
      lendIdle: state.lendIdle ?? true, active: state.active, waiting: state.waiting, guaranteeSum, over: guaranteeSum > state.limitSlots, lines: lines.length,
      routes: rows.filter(row => !row.stale && row.cells[index] !== null).map(row => row.routeId) };
  });
  return { observedAt: readable ? observation.observedAt : null, readable, policyVerified: readable && observation.policyVerified, devices, rows, skipped, orphans, errors };
}

// ── 폼 → 저장 입력 ─────────────────────────────────────────────────────────────────────────────────

/** saveModelCapacityRouteQuotas 의 입력(그 함수가 zod 로 다시 본다) */
export type RouteQuotasFormInput = { deviceId: string; expectedVersion: number; lendIdle: boolean; quotas: ModelCapacityRouteQuota[] };
export type RouteQuotasFormParse = { input: RouteQuotasFormInput | null; issues: string[] };
type FormLike = { get(name: string): FormDataEntryValue | null; getAll(name: string): FormDataEntryValue[] };
const text = (value: FormDataEntryValue | null | undefined) => typeof value === "string" ? value.trim() : "";
/** 칸 수는 0..256(장비 칸 수 상한) — 세 자리 정수만 받는다. 장비 칸 수와 견주는 검사는 저장 TX 안에서 잠근 행으로 한다 */
const SLOT_PATTERN = /^\d{1,3}$/;

/**
 * 장비 한 열의 저장 폼. 칸 이름: deviceId · expectedVersion(장비 행 판, CAS) · lendIdle(체크박스, 켬 = "on") · route(이 열의 경로, 여러 번)
 * · min:<route>(보장, 비우면 0) · max:<route>(상한, 비우면 없음; 0 = 이 장비에서 뺌). 보장 0·상한 없음 줄은 오늘과 같으므로 보내지 않는다.
 * 숫자 모양·보장 ≤ 상한만 여기서 본다 — 범위·칸 수·보장 합계는 저장(zod + 잠근 장비 행)이 본다. 줄은 경로 순(백엔드와 같은 순서)이다.
 */
export function routeQuotasInputFromForm(form: FormLike): RouteQuotasFormParse {
  const issues: string[] = [];
  const deviceId = text(form.get("deviceId"));
  if (!deviceId || deviceId.length > 120 || /[\u0000-\u001f\u007f]/.test(deviceId)) issues.push("장비 이름을 읽지 못했습니다. 새로고침해주세요.");
  const versionText = text(form.get("expectedVersion"));
  const expectedVersion = /^\d{1,15}$/.test(versionText) ? Number(versionText) : NaN;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) issues.push("판 번호(version)를 읽지 못했습니다. 새로고침해주세요.");
  const lendIdle = text(form.get("lendIdle")) === "on";
  const routes = [...new Set(form.getAll("route").map(entry => text(entry)).filter(Boolean))].sort(compareRouteIds);
  const quotas: ModelCapacityRouteQuota[] = [];
  for (const routeId of routes) {
    const label = allocationAreaLabel(routeId);
    const minRaw = text(form.get(`min:${routeId}`)), maxRaw = text(form.get(`max:${routeId}`));
    const minSlots = minRaw === "" ? 0 : SLOT_PATTERN.test(minRaw) ? Number(minRaw) : null;
    const maxSlots = maxRaw === "" ? null : SLOT_PATTERN.test(maxRaw) ? Number(maxRaw) : undefined;
    if (minSlots === null) issues.push(`${label}: 보장 칸은 0 이상의 정수로 적어주세요(비우면 0)`);
    if (maxSlots === undefined) issues.push(`${label}: 상한 칸은 0 이상의 정수로 적어주세요(비우면 상한 없음, 0 은 이 장비에서 뺌)`);
    if (minSlots === null || maxSlots === undefined) continue;
    if (maxSlots !== null && minSlots > maxSlots) { issues.push(`${label}: 보장 칸(${minSlots})이 상한 칸(${maxSlots})보다 많습니다`); continue; }
    if (minSlots === 0 && maxSlots === null) continue;
    quotas.push({ routeId, minSlots, maxSlots });
  }
  if (issues.length) return { input: null, issues };
  return { input: { deviceId, expectedVersion, lendIdle, quotas }, issues };
}

/** 몫 한 줄의 글(감사·저장 결과·확인 칸이 같은 말을 쓴다). 줄이 없으면 「없음」(= 오늘과 같음) */
export const routeQuotaText = (quota: Pick<ModelCapacityRouteQuota, "minSlots" | "maxSlots"> | null | undefined): string =>
  quota ? `보장 ${quota.minSlots} · 상한 ${quota.maxSlots === null ? "없음" : quota.maxSlots === 0 ? "0(뺌)" : quota.maxSlots}` : "없음";

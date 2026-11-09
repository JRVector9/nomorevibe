import type { ModelCapacityRoute } from "./capacity";

/**
 * 쓰지 않는 장비 은퇴·남은 정책 route 정리(2026-11-09)의 순수 판정 — DB 없이 시험한다. 읽기는 capacity-retire-repository.ts 가 한 TX 안에서 모은다.
 *
 * route 하나 = 정책 routes 의 한 줄(routeId·provider·model·providerBudgetId·groupId). 「쓰인다」의 근거는 셋이다 — 하나라도 있으면 지우지 않는다.
 * 1. 노출: 그 장비(groupId)에 묶인 연결(켜짐·꺼짐 모두)이 그 모델을 아직 내보낸다 — route id 가 작업(lib/llm/ai-tasks.ts)의 route 일 때만 막는다
 *    (`taskRouteIds`; 주지 않으면 모든 route 에서 막는다). 노출은 「운영자가 그 작업의 순위로 다시 고를 수 있다」는 뜻이라, 어느 작업도 만들지 않는
 *    route id(옛 `…-legacy` 등)는 노출만으로는 불릴 길이 없다 — 그런 route 는 2·3 의 근거로만 판정한다. 연결의 **저장된 원래 목록**에서 운영자가 뺀 모델(hiddenModels)만 뺀다 —
 *    화면의 별칭 묶기(model-picker-display: Supa 의 supa·Inferact, M1 의 옛·새 Gemma 이름)는 표시일 뿐이라 쓰지 않는다(표시가 숨긴 `supa` 도 노출이다).
 *    알려진 별칭은 판정을 바꾸지 않고 `aliasHints` 로만 알린다(옛 이름 route 를 새 이름이 대신하는지 운영자가 본다).
 * 2. 참조: 작업 순위(ai_task_models)·작업 풀(ai_task_pool_members)·모델 배정(model_helper_assignments)·켜진 서빙 계약(model_serving_contracts)이
 *    그 (routeId, provider, model) 을 부른다. 순위·풀은 작업의 route + 모델(연결로 가른 이름 `<모델>@<연결 8자>`·CLI 엔진 이름 `<모델>@cli-<hash>` 포함),
 *    계약은 (routeId, model)·CLI 계약 `cli:<provider>:<routeId>`·로컬 계약(backendId = providerBudgetId 이고 같은 모델)으로 맞춘다. provider 는 배정만 견주고 나머지는 보지 않는다(넓게 막는다).
 * 3. 장부: 그 (routeId, provider, model) 에 끝나지 않은 행(waiting·reserved·dispatched·indeterminate)이 있다.
 * 환경변수 로컬 계약(LOCAL_MODEL_SERVING_CONTRACTS)은 이 판정이 보지 못한다 — 2026-11-02 결정으로 실행 쪽은 표만 읽는다.
 */

export type CapacityRouteKey = Readonly<{ routeId: string; provider: string; model: string; groupId: string }>;
export type RetireConnection = Readonly<{ id: string; label: string; deviceId: string; enabled: boolean; kind: string;
  /** 저장된 원래 목록(API: models[].id, CLI: cli_models) */
  models: readonly string[]; hiddenModels: readonly string[] }>;
export type RetireRankRow = Readonly<{ task: string; slot: number; rank: number; connectionId: string; model: string; enabled: boolean;
  /** 작업의 용량 route(lib/llm/ai-tasks.ts). 없으면 null */
  routeId: string | null }>;
export type RetirePoolMember = Readonly<{ task: string; slot: number; position: number; connectionId: string; model: string; canonicalModel: string;
  deviceId: string; routeId: string | null }>;
export type RetireHelper = Readonly<{ assignmentId: string; deviceId: string; model: string; liveRouteId: string; liveProvider: string; shadowRouteId: string;
  mode: string }>;
export type RetireContract = Readonly<{ id: number; routeId: string; model: string; transport: string; provider: string | null; backendId: string | null;
  physicalGroup: string | null }>;
export type RetireLedgerOpen = Readonly<{ routeId: string; provider: string; model: string; groupId: string; state: string; count: number }>;
export type CapacityReferenceSnapshot = Readonly<{
  routes: readonly ModelCapacityRoute[];
  connections: readonly RetireConnection[]; ranks: readonly RetireRankRow[]; poolMembers: readonly RetirePoolMember[];
  helpers: readonly RetireHelper[]; contracts: readonly RetireContract[]; ledgerOpen: readonly RetireLedgerOpen[];
  /** 작업 순위·풀이 만들 수 있는 route id(노출이 막는 범위). 없으면 모든 route 에서 노출이 막는다 */
  taskRouteIds?: readonly string[] }>;

export type CapacityBlockerKind = "connection" | "exposed" | "rank" | "pool" | "helper" | "contract" | "ledger" | "cli";
export type CapacityBlocker = Readonly<{ kind: CapacityBlockerKind; detail: string }>;
export type StaleRouteCandidate = Readonly<{ route: ModelCapacityRoute; reason: string;
  /** 이 장비에 묶인 연결이 하나도 없다 — 장비째 지우려면 은퇴(retireCapacityDevice)를 쓴다 */
  deviceWithoutConnection: boolean; aliasHints: readonly string[] }>;
export type KeptRoute = Readonly<{ route: ModelCapacityRoute; blockers: readonly CapacityBlocker[] }>;
export type StaleRoutesResult = Readonly<{ candidates: readonly StaleRouteCandidate[]; kept: readonly KeptRoute[];
  /** 정책 route 는 있는데 묶인 연결이 없는 장비 */
  orphanDevices: readonly string[] }>;

export const capacityRouteKeyText = (route: Pick<CapacityRouteKey, "routeId" | "provider" | "model">) => `${route.routeId}|${route.provider}|${route.model}`;
const sameKey = (a: Pick<CapacityRouteKey, "routeId" | "provider" | "model">, b: Pick<CapacityRouteKey, "routeId" | "provider" | "model">) =>
  a.routeId === b.routeId && a.provider === b.provider && a.model === b.model;

/** 장부 이름의 연결·CLI 꼬리(`@<연결 id 8자>`·`@cli-<32 hex>`)를 뗀 모델 이름 */
const DERIVED_SUFFIX = /@(?:cli-[0-9a-f]{32}|[0-9a-f]{8})$/;
export function routeModelBase(model: string): string { return model.replace(DERIVED_SUFFIX, ""); }
/** 참조가 부르는 모델 이름(순위·연결 목록의 모델)이 이 route 의 장부 이름인가 — 같거나, 그 이름에서 만든 연결·CLI 이름(앞 120자) */
export function modelNamesRoute(referenceModel: string, routeModel: string): boolean {
  if (referenceModel === routeModel) return true;
  const base = routeModelBase(routeModel);
  if (base === routeModel) return false;
  return base === referenceModel || (base.length === 120 && referenceModel.startsWith(base));
}

/**
 * 알려진 별칭(같은 엔진의 다른 이름) — 표시용 묶음(app/(operator)/admin/models/model-picker-display.ts)과 같은 목록에 게이트웨이 시절의
 * `[라벨] 모델` 이름을 더한다. 판정에는 쓰지 않는다(힌트만).
 */
const KNOWN_ALIAS_GROUPS: readonly (readonly string[])[] = [["mlx-community--gemma-4-26b-a4b-it-4bit", "m1-gemma"], ["Inferact/Qwen3.8-27B-NVFP4", "supa"]];
const GATEWAY_LABEL = /^\[[^\]]{1,40}\] (.+)$/;
function aliasNames(model: string): string[] {
  const names = new Set<string>();
  const plain = model.match(GATEWAY_LABEL)?.[1];
  for (const name of plain ? [model, plain] : [model]) {
    if (name !== model) names.add(name);
    for (const group of KNOWN_ALIAS_GROUPS) if (group.includes(name)) for (const other of group) if (other !== model) names.add(other);
  }
  return [...names];
}

const visibleModels = (connection: RetireConnection) => connection.models.filter(model => !connection.hiddenModels.includes(model));

/**
 * CLI 공급자 route(`*-cli`) — 이 판정이 보지 못하는 곳(connect 에이전트의 분류 우선·예비 설정, 단계 풀·등록부 CLI 엔진)이 부른다.
 * 2026-11-09: `crawl-publish-classify / codex-cli / gpt-5.6-terra → openai-cli`(7일 15,737건)가 연결 행이 없다는 까닭만으로 정리 후보에 올랐다.
 * 그래서 CLI route 는 늘 「쓰는 중」으로 보고, 정리·장비 은퇴 어느 쪽도 지우지 않는다(필요하면 용량 정책 명령으로 뺀다).
 */
const isCliRoute = (route: Pick<ModelCapacityRoute, "provider">) => route.provider.endsWith("-cli");

/** route 하나가 쓰이는 근거(노출 제외 — 노출은 장비의 연결에 달렸다). 은퇴·정리가 같은 규칙을 쓴다. */
export function capacityRouteReferences(snapshot: CapacityReferenceSnapshot, route: ModelCapacityRoute): CapacityBlocker[] {
  const out: CapacityBlocker[] = [];
  if (isCliRoute(route)) out.push({ kind: "cli", detail: `${route.provider} · ${route.routeId} · ${route.model}` });
  for (const rank of snapshot.ranks)
    if (rank.routeId === route.routeId && modelNamesRoute(rank.model, route.model))
      out.push({ kind: "rank", detail: `${rank.task}#${rank.slot} ${rank.rank}순위 ${rank.model}${rank.enabled ? "" : "(꺼짐)"}` });
  for (const member of snapshot.poolMembers)
    if (member.routeId === route.routeId && (modelNamesRoute(member.model, route.model) || modelNamesRoute(member.canonicalModel, route.model)))
      out.push({ kind: "pool", detail: `${member.task}#${member.slot} ${member.position}번 ${member.model}` });
  for (const helper of snapshot.helpers)
    if (modelNamesRoute(helper.model, route.model) && ((helper.liveRouteId === route.routeId && helper.liveProvider === route.provider) || helper.shadowRouteId === route.routeId))
      out.push({ kind: "helper", detail: `${helper.assignmentId}(${helper.mode})` });
  for (const contract of snapshot.contracts) {
    const sameRoute = (contract.routeId === route.routeId || contract.routeId === `cli:${route.provider}:${route.routeId}`) && modelNamesRoute(contract.model, route.model);
    const localBackend = route.provider === "local-direct" && contract.backendId !== null && contract.backendId === route.providerBudgetId
      && modelNamesRoute(contract.model, route.model);
    if (sameRoute || localBackend) out.push({ kind: "contract", detail: `#${contract.id} ${contract.routeId} · ${contract.model}(${contract.transport})` });
  }
  for (const open of snapshot.ledgerOpen)
    if (sameKey(open, route)) out.push({ kind: "ledger", detail: `${open.state} ${open.count}건` });
  return out;
}

/** 장비의 연결이 이 route 의 모델을 내보내는가 — 저장된 목록 − 뺀 모델 */
function exposures(snapshot: CapacityReferenceSnapshot, route: ModelCapacityRoute): CapacityBlocker[] {
  if (snapshot.taskRouteIds && !snapshot.taskRouteIds.includes(route.routeId)) return [];
  return snapshot.connections.filter(connection => connection.deviceId === route.groupId && visibleModels(connection).some(model => modelNamesRoute(model, route.model)))
    .map(connection => ({ kind: "exposed" as const, detail: `${connection.label}${connection.enabled ? "" : "(꺼짐)"}` }));
}

/**
 * 지워도 되는 route(남은 별칭 등) 후보와 그 까닭, 지우면 안 되는 route 와 그 근거. 정책 route 순서대로. 은퇴 대상(연결 없는 장비)의 route 도 후보로 올리되
 * `deviceWithoutConnection` 으로 알린다(장비째 지우려면 은퇴를 쓴다).
 */
export function findStaleCapacityRoutes(snapshot: CapacityReferenceSnapshot): StaleRoutesResult {
  const candidates: StaleRouteCandidate[] = [], kept: KeptRoute[] = [];
  const devicesWithConnection = new Set(snapshot.connections.map(connection => connection.deviceId));
  for (const route of snapshot.routes) {
    const blockers = [...exposures(snapshot, route), ...capacityRouteReferences(snapshot, route)];
    if (blockers.length) { kept.push({ route, blockers }); continue; }
    const deviceWithoutConnection = !devicesWithConnection.has(route.groupId);
    const shown = snapshot.connections.filter(connection => connection.deviceId === route.groupId)
      .flatMap(connection => visibleModels(connection).map(model => ({ connection, model })));
    const aliasHints = aliasNames(route.model).flatMap(alias => shown.filter(entry => entry.model === alias)
      .map(entry => `같은 엔진의 다른 이름 ${alias}을(를) 연결 ${entry.connection.label}이(가) 내보냅니다 — 이 route 는 옛 이름입니다`));
    const reason = deviceWithoutConnection
      ? `장비 ${route.groupId}에 묶인 연결이 없고, 순위·풀·배정·켜진 계약 어디서도 부르지 않으며, 끝나지 않은 장부 행이 없습니다(장비째 지우려면 장비 은퇴)`
      : `장비 ${route.groupId}의 연결이 ${route.model}을(를) 내보내지 않고, 순위·풀·배정·켜진 계약 어디서도 부르지 않으며, 끝나지 않은 장부 행이 없습니다`;
    candidates.push({ route, reason, deviceWithoutConnection, aliasHints });
  }
  const orphanDevices = [...new Set(snapshot.routes.map(route => route.groupId).filter(groupId => !devicesWithConnection.has(groupId)))].sort();
  return { candidates, kept, orphanDevices };
}

/**
 * 장비 하나를 은퇴하지 못하게 막는 것: 그 장비에 묶인 연결(켜짐·꺼짐 모두)·그 장비의 작업 풀 칸·모델 배정·로컬 계약(physicalGroup)·끝나지 않은 장부 행(group_id),
 * 그리고 그 장비의 정책 route 를 부르는 순위·풀·배정·계약. 빈 목록이면 은퇴해도 된다.
 */
export function capacityDeviceRetireBlockers(snapshot: CapacityReferenceSnapshot, deviceId: string): CapacityBlocker[] {
  const out: CapacityBlocker[] = [];
  for (const connection of snapshot.connections) if (connection.deviceId === deviceId)
    out.push({ kind: "connection", detail: `${connection.label}${connection.enabled ? "" : "(꺼짐)"}` });
  for (const member of snapshot.poolMembers) if (member.deviceId === deviceId)
    out.push({ kind: "pool", detail: `${member.task}#${member.slot} ${member.position}번 ${member.model}` });
  for (const helper of snapshot.helpers) if (helper.deviceId === deviceId) out.push({ kind: "helper", detail: `${helper.assignmentId}(${helper.mode})` });
  for (const contract of snapshot.contracts) if (contract.physicalGroup === deviceId)
    out.push({ kind: "contract", detail: `#${contract.id} ${contract.routeId} · ${contract.model}(${contract.transport})` });
  for (const open of snapshot.ledgerOpen) if (open.groupId === deviceId)
    out.push({ kind: "ledger", detail: `${open.routeId} · ${open.model} ${open.state} ${open.count}건` });
  for (const route of snapshot.routes) if (route.groupId === deviceId)
    for (const blocker of capacityRouteReferences(snapshot, route)) if (blocker.kind !== "ledger") out.push(blocker);
  const seen = new Set<string>();
  return out.filter(blocker => { const key = `${blocker.kind}\u0000${blocker.detail}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

/** 거절 코드에 싣는 근거 글 — `kind=detail` 을 ` | ` 로 잇는다(admin-capacity-retire 가 한국어로 푼다) */
export const capacityBlockersText = (blockers: readonly CapacityBlocker[]) => blockers.map(blocker => `${blocker.kind}=${blocker.detail}`).join(" | ");

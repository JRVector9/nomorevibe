import { ADMIN_MODEL_STAGES } from "@/lib/llm/admin-model-stages";
import { modelRequestName, type ModelDefinition } from "@/lib/llm/model-registry";
import type { AdminModelsObservation, AdminModelMetrics, AdminModelRequest } from "./admin-models-observation";

export const modelIdentityKey = (row: { routeId: string; provider: string; model: string }) => JSON.stringify([row.routeId, row.provider, row.model]);

export function elapsedModelTime(at: string, observedAt: string | null): string {
  if (!observedAt) return "미확인";
  const seconds = Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(at)) / 1000));
  return seconds < 60 ? `${seconds}초` : seconds < 3600 ? `${Math.floor(seconds / 60)}분` : `${Math.floor(seconds / 3600)}시간 ${Math.floor(seconds % 3600 / 60)}분`;
}

export const MODEL_DASHBOARD_STAGES = [
  { id: "first-review", label: "1차 검수" }, { id: "second-review", label: "2차 검수" }, ...ADMIN_MODEL_STAGES,
];
export type ModelStageAssignment = { id: string; label: string; models: { provider: string; model: string }[] };
/** 관리 계약(model_serving_contracts) 한 줄의 표시용 요약 — 주소는 host:port 만, 키·토큰은 절대 들어오지 않는다. */
export type ModelContractLink = { routeId: string; model: string; host: string | null; transport: "direct" | "gateway" };
/** 서버 이름을 어디서 얻었는지(화면의 작은 글씨). null 이면 「장비 미확인」. */
export type ModelServerSource = "주소" | "등록부" | "같은 이름 항목" | "장비 그룹" | "이름표" | "주소로 추정" | "그룹 ID" | null;
export type ModelCard = { id: string; name: string; equipment: string; equipmentSource: ModelServerSource; definition?: ModelDefinition;
  /** 이 모델을 부르는 주소(host:port)들 — 관리 계약 endpoint 와 등록부 baseUrl. 키 없음. */
  hosts: string[]; contracts: ModelContractLink[];
  rows: AdminModelMetrics[]; requests: AdminModelRequest[]; stages: string[] };
/** 2026-10-30 결정: 미확인(indeterminate)은 점유가 아니므로 단계가 "멈춤"이 되지 않는다 — "미확인 · 사람 검토"로만 보인다. */
export type StageHealth = "정상" | "느림" | "미확인" | "접수 중지";
const routeStage: Record<string, string> = { "crawl-agent-review": "first-review", "review-gateway": "first-review", "review-cli": "first-review",
  "human-deepseek-review": "human-review", "product-audit": "audit-review", "korean-tagline": "product-tagline-ko",
  "search-profile": "product-search-profile", "search-verify": "product-search-verify", "intro-check": "product-intro-check" };
export const modelStageId = (route: string) => routeStage[route] ?? route;
export const modelStageLabel = (route: string) => MODEL_DASHBOARD_STAGES.find(stage => stage.id === modelStageId(route))?.label ?? "다른 모델 단계";
export function findModelDefinition(row: { provider: string; model: string }, models: readonly ModelDefinition[]) {
  const matches = models.filter(model => model.provider === row.provider && (row.model === model.key || row.model === modelRequestName(model)
    || (!row.model.startsWith("[") && row.model === model.model)));
  return matches.length === 1 ? matches[0] : undefined;
}
/**
 * 행의 서버 이름(2026-10-31 소유자 요청 "장비 미확인 뜨는 거 전부 장비 서버명 맞춰놓자"). 찾는 순서:
 * 1) 주소의 호스트가 이름 표에 있음(관리 계약 endpoint → 등록부 baseUrl), 2) 등록부 장비 값(이름 표 → 원문), 3) 제공 방식이 달라도 같은 모델
 * 이름의 유일한 등록부 항목(예: 1차 검수 abcllm 계약이 gpu3090 의 local-direct 항목과 같은 vLLM 을 쓴다)의 주소·장비, 4) 이 행이 쓰는 장비
 * 그룹(model_capacity_devices)이 이름 표에 있음, 5) 옛 게이트웨이 대괄호 라벨, 6) 이름 표에 없어도 엔진 직접 계약의 주소 host:port 원문,
 * 7) 정책 route 의 groupId 원문, 8) 그래도 없으면 「장비 미확인」. 표시용 이름이다 — 복구 판정(modelRecoveryBlocked)은 등록부 장비 값을 그대로 쓴다.
 *
 * 운영자가 이름을 붙이는 곳: 등록부 항목의 equipment(`/admin/models/contracts` 「모델 등록부 덮어쓰기」, MODEL_REGISTRY_CONFIG)이나 이 표.
 * 새 운영 주소가 생기면 SERVER_BY_HOST 에 host 를 더한다(포트는 보지 않는다).
 */
const SERVER_BY_HOST: Readonly<Record<string, string>> = {
  // Tailscale 주소(엔진): M3 Ultra 8010 oMLX(deepseek·gpt-oss)·8014 mlx-serve, Supa 8000 vLLM, gpu3090 8090 vLLM, M1 Studio mlx_lm.server
  "100.92.77.66": "M3 Ultra", "100.78.219.124": "Supa", "100.77.43.63": "gpu3090",
  // MagicDNS 호스트명
  "m3ultra.tail02799e.ts.net": "M3 Ultra", "m1-studio.tail02799e.ts.net": "M1 Studio", "9mini.tail02799e.ts.net": "mini",
  "onetwoday.tail02799e.ts.net": "Oracle Osaka",
  // 웹·워커가 도는 장비 자체(M3 의 launchd 엔진을 같은 장비에서 부를 때). mini 웹도 localhost 를 쓸 수 있으니 출처 「주소」를 함께 보인다.
  localhost: "M3 Ultra", "127.0.0.1": "M3 Ultra", "[::1]": "M3 Ultra",
};
const SERVER_BY_NAME: Readonly<Record<string, string>> = { m3: "M3 Ultra", mlx: "M3 Ultra", "m3-mlx": "M3 Ultra", "m3-deepseek": "M3 Ultra",
  m1: "M1 Studio", "m1-qwen": "M1 Studio", supa: "Supa", "supa-direct": "Supa", gpu3090: "gpu3090", "gpu3090-qwen": "gpu3090",
  connect: "connect(CLI)", "anthropic-cli": "connect(CLI)", "openai-cli": "connect(CLI)" };
const serverByName = (value: string | null | undefined) => value ? SERVER_BY_NAME[value.toLowerCase()] : undefined;
/** 주소의 host:port 만(사용자 정보·경로·query 제외). URL 이 아니면 null — 원문을 그대로 보이지 않는다(키가 섞일 수 있다). */
export function addressHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && parsed.host ? parsed.host : null; } catch { return null; }
}
function serverByHost(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try { return SERVER_BY_HOST[new URL(url).hostname]; } catch { return undefined; }
}
/** 관리 계약 행 → 표시용 요약. contract 의 endpoint 만 읽고 host:port 로 줄인다. apiKey 등 다른 필드는 읽지 않는다. */
export function modelContractLinks(rows: readonly { routeId: string; model: string; contract: unknown; transport: "direct" | "gateway" }[]): ModelContractLink[] {
  return rows.map(row => {
    const endpoint = row.contract && typeof row.contract === "object" ? (row.contract as { endpoint?: unknown }).endpoint : undefined;
    return { routeId: row.routeId, model: row.model, host: typeof endpoint === "string" ? addressHost(endpoint) : null, transport: row.transport };
  });
}
export function modelServer(identity: { provider: string; model: string }, definition: ModelDefinition | undefined,
  models: readonly ModelDefinition[], groups: readonly string[], contracts: readonly ModelContractLink[] = []): { name: string; source: ModelServerSource } {
  const sameName = definition ? undefined : (() => {
    const matches = identity.model.startsWith("[") ? [] : models.filter(model => model.model === identity.model);
    return matches.length === 1 ? matches[0] : undefined;
  })();
  const source = definition ?? sameName, sourceKind: ModelServerSource = definition ? "등록부" : "같은 이름 항목";
  const direct = contracts.filter(row => row.transport === "direct").map(row => row.host).filter((host): host is string => !!host);
  for (const row of contracts) { const name = serverByHost(row.host && `http://${row.host}`); if (name) return { name, source: "주소" }; }
  const fromBase = serverByHost(source?.baseUrl);
  if (fromBase) return { name: fromBase, source: definition ? "주소" : sourceKind };
  const equipment = serverByName(source?.equipment) ?? source?.equipment;
  if (equipment) return { name: equipment, source: sourceKind };
  const fromGroups = [...new Set(groups.map(serverByName).filter((name): name is string => !!name))];
  if (fromGroups.length === 1) return { name: fromGroups[0], source: "장비 그룹" };
  const label = identity.model.match(/^\[([^\]]+)\]/)?.[1];
  if (label) return { name: serverByName(label) ?? label, source: "이름표" };
  if (direct.length) return { name: [...new Set(direct)].join(" · "), source: "주소로 추정" };
  const rawGroups = [...new Set(groups.filter(Boolean))];
  if (rawGroups.length) return { name: rawGroups.sort().join(" · "), source: "그룹 ID" };
  return { name: "장비 미확인", source: null };
}
export function modelServerName(identity: { provider: string; model: string }, definition: ModelDefinition | undefined,
  models: readonly ModelDefinition[], groups: readonly string[], contracts: readonly ModelContractLink[] = []): string {
  return modelServer(identity, definition, models, groups, contracts).name;
}
/** 이 행의 전송 방식(한국어). 관리 계약이 있으면 그 transport, 없으면 제공자로 — 엔진 직접 / 게이트웨이 / CLI. */
export function modelTransportLabel(provider: string, contracts: readonly ModelContractLink[]): string {
  const kinds = [...new Set(contracts.map(row => row.transport))];
  if (kinds.length === 1) return kinds[0] === "direct" ? "엔진 직접(계약)" : "게이트웨이(계약)";
  if (kinds.length > 1) return "엔진 직접·게이트웨이(계약)";
  if (provider === "local-direct" || provider === "llama-server") return "엔진 직접";
  if (provider.endsWith("-cli")) return "CLI";
  return provider === "abcllm" ? "게이트웨이(env)" : "미확인";
}
export function buildModelCards(observation: AdminModelsObservation, models: readonly ModelDefinition[], assignments: ModelStageAssignment[] = [],
  contracts: readonly ModelContractLink[] = []): ModelCard[] {
  const cards = new Map<string, ModelCard>(), identities = new Map<string, { provider: string; model: string }>();
  const ensure = (identity: { provider: string; model: string }) => {
    const definition = findModelDefinition(identity, models), id = definition?.key ?? JSON.stringify([identity.provider, identity.model]);
    let card = cards.get(id);
    if (!card) {
      card = { id, definition, name: (definition?.model.startsWith("mlx-community--") ? definition.displayName.split(" · ").slice(1).join(" · ") : definition?.model) ?? identity.model.replace(/^\[[^\]]+\]\s*/, ""),
        equipment: "장비 미확인", equipmentSource: null, hosts: [], contracts: [], rows: [], requests: [], stages: [] }; cards.set(id, card); identities.set(id, identity);
    }
    return card;
  };
  for (const assignment of assignments) for (const identity of assignment.models) {
    if (!identity.model || identity.model === "미설정") continue;
    const card = ensure(identity); if (!card.stages.includes(assignment.id)) card.stages.push(assignment.id);
  }
  for (const row of observation.rows) { const card = ensure(row); card.rows.push(row);
    if (!card.stages.includes(modelStageId(row.routeId))) card.stages.push(modelStageId(row.routeId)); }
  for (const request of observation.requests) ensure(request).requests.push(request);
  for (const card of cards.values()) {
    const identity = identities.get(card.id)!, names = new Set([identity.model, card.definition?.model, card.definition && modelRequestName(card.definition)].filter(Boolean));
    // 계약은 (routeId, model) 로 저장된다 — 이 행이 쓰는 모델 이름과 같은 계약만. 키·토큰은 ModelContractLink 에 없다.
    card.contracts = contracts.filter(row => names.has(row.model));
    const server = modelServer(identity, card.definition, models, [...card.rows.map(row => row.groupId), ...card.requests.map(request => request.groupId)], card.contracts);
    card.equipment = server.name; card.equipmentSource = server.source;
    card.hosts = [...new Set([...card.contracts.map(row => row.host), addressHost(card.definition?.baseUrl)].filter((host): host is string => !!host))];
  }
  return [...cards.values()].sort((a, b) => b.rows.reduce((n, r) => n + r.indeterminate, 0) - a.rows.reduce((n, r) => n + r.indeterminate, 0));
}
export function stageUnknownRows(observation: AdminModelsObservation, rows: AdminModelMetrics[]) {
  const groups = new Set(rows.map(row => row.groupId));
  return observation.rows.filter(row => groups.has(row.groupId) && row.indeterminate > 0);
}
/** An unknown row in a stage's capacity group marks the stage 미확인 for human review; it occupies no slot, so it never stops the stage (2026-10-30). */
export function stageHealth(observation: AdminModelsObservation, rows: AdminModelMetrics[], requests: AdminModelRequest[]): StageHealth {
  if (observation.mode === "draining" || observation.mode === "disabled") return "접수 중지";
  if (observation.error || !observation.observedAt || !rows.length) return "미확인";
  if (stageUnknownRows(observation, rows).length > 0) return "미확인";
  const oldActive = requests.some(row => ["waiting", "reserved", "dispatched"].includes(row.state)
    && Date.parse(observation.observedAt!) - Date.parse(row.dispatchedAt ?? row.queuedAt) >= 5 * 60_000);
  if (oldActive || rows.some(row => row.failed1h > 0) || rows.some(row => row.waiting > 0)) return "느림";
  return rows.some(row => row.succeeded1h > 0 || row.dispatched > 0 || row.reserved > 0) ? "정상" : "미확인";
}
export function modelRecoveryBlocked(equipment: string, provider?: string) {
  if (provider && !["abcllm", "local-direct", "llama-server"].includes(provider)) return "이 제공자의 모델 종료·재시작 실행기가 등록되지 않았습니다.";
  if (equipment.toLowerCase() === "m1") return "M1 sudo 필요 · 사람이 장비에서 종료·복원해야 합니다.";
  if (equipment.toLowerCase() === "supa") return "Supa root 필요 · 관리자 접근과 종료·복원 프로필이 등록되지 않았습니다.";
  return undefined;
}
export const modelCardAnchor = (id: string) => `model-${encodeURIComponent(id)}`;
export function lastModelSuccess(rows: AdminModelMetrics[]) {
  return rows.map(row => row.lastSuccessAt).filter((at): at is string => !!at).sort().at(-1) ?? null;
}

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
export type ModelCard = { id: string; name: string; equipment: string; definition?: ModelDefinition;
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
 * 카드의 서버 이름(2026-10-31 소유자 요청 "장비 미확인 뜨는 거 전부 장비 서버명 맞춰놓자"). 찾는 순서:
 * 1) 등록부 항목의 주소(호스트) → 서버, 2) 등록부 장비 값, 3) 제공 방식이 달라도 같은 모델 이름의 유일한 항목(예: 1차 검수 abcllm 계약이
 * gpu3090 의 local-direct 항목과 같은 vLLM 을 쓴다), 4) 이 카드가 쓰는 장비 그룹(model_capacity_devices), 5) 옛 게이트웨이 대괄호 라벨.
 * 표시용 이름이다 — 복구 판정(modelRecoveryBlocked)은 등록부 장비 값을 그대로 쓴다.
 */
const SERVER_BY_HOST: Readonly<Record<string, string>> = { "100.92.77.66": "M3 Ultra", "100.78.219.124": "Supa", "100.77.43.63": "gpu3090",
  "m1-studio.tail02799e.ts.net": "M1 Studio" };
const SERVER_BY_NAME: Readonly<Record<string, string>> = { m3: "M3 Ultra", mlx: "M3 Ultra", "m3-mlx": "M3 Ultra", "m3-deepseek": "M3 Ultra",
  m1: "M1 Studio", "m1-qwen": "M1 Studio", supa: "Supa", "supa-direct": "Supa", gpu3090: "gpu3090", "gpu3090-qwen": "gpu3090",
  connect: "connect(CLI)", "anthropic-cli": "connect(CLI)", "openai-cli": "connect(CLI)" };
const serverByName = (value: string | null | undefined) => value ? SERVER_BY_NAME[value.toLowerCase()] : undefined;
function serverByHost(baseUrl: string | null | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try { return SERVER_BY_HOST[new URL(baseUrl).hostname]; } catch { return undefined; }
}
export function modelServerName(identity: { provider: string; model: string }, definition: ModelDefinition | undefined,
  models: readonly ModelDefinition[], groups: readonly string[]): string {
  const sameName = definition ? undefined : (() => {
    const matches = identity.model.startsWith("[") ? [] : models.filter(model => model.model === identity.model);
    return matches.length === 1 ? matches[0] : undefined;
  })();
  const source = definition ?? sameName;
  const fromGroups = [...new Set(groups.map(serverByName).filter((name): name is string => !!name))];
  return serverByHost(source?.baseUrl) ?? serverByName(source?.equipment) ?? source?.equipment
    ?? (fromGroups.length === 1 ? fromGroups[0] : undefined)
    ?? serverByName(identity.model.match(/^\[([^\]]+)\]/)?.[1]) ?? identity.model.match(/^\[([^\]]+)\]/)?.[1] ?? "장비 미확인";
}
export function buildModelCards(observation: AdminModelsObservation, models: readonly ModelDefinition[], assignments: ModelStageAssignment[] = []): ModelCard[] {
  const cards = new Map<string, ModelCard>(), identities = new Map<string, { provider: string; model: string }>();
  const ensure = (identity: { provider: string; model: string }) => {
    const definition = findModelDefinition(identity, models), id = definition?.key ?? JSON.stringify([identity.provider, identity.model]);
    let card = cards.get(id);
    if (!card) {
      card = { id, definition, name: (definition?.model.startsWith("mlx-community--") ? definition.displayName.split(" · ").slice(1).join(" · ") : definition?.model) ?? identity.model.replace(/^\[[^\]]+\]\s*/, ""),
        equipment: "장비 미확인", rows: [], requests: [], stages: [] }; cards.set(id, card); identities.set(id, identity);
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
  for (const card of cards.values()) card.equipment = modelServerName(identities.get(card.id)!, card.definition, models,
    [...card.rows.map(row => row.groupId), ...card.requests.map(request => request.groupId)]);
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

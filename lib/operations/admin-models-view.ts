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
export type StageHealth = "정상" | "느림" | "멈춤" | "미확인" | "접수 중지";
const routeStage: Record<string, string> = { "review-gateway": "first-review", "review-cli": "first-review",
  "human-deepseek-review": "human-review", "product-audit": "audit-review", "korean-tagline": "product-tagline-ko",
  "search-profile": "product-search-profile", "search-verify": "product-search-verify", "intro-check": "product-intro-check" };
export const modelStageId = (route: string) => routeStage[route] ?? route;
export const modelStageLabel = (route: string) => MODEL_DASHBOARD_STAGES.find(stage => stage.id === modelStageId(route))?.label ?? "다른 모델 단계";
export function findModelDefinition(row: { provider: string; model: string }, models: readonly ModelDefinition[]) {
  const matches = models.filter(model => model.provider === row.provider && (row.model === model.key || row.model === modelRequestName(model)
    || (!row.model.startsWith("[") && row.model === model.model)));
  return matches.length === 1 ? matches[0] : undefined;
}
export function buildModelCards(observation: AdminModelsObservation, models: readonly ModelDefinition[], assignments: ModelStageAssignment[] = []): ModelCard[] {
  const cards = new Map<string, ModelCard>();
  const ensure = (identity: { provider: string; model: string }) => {
    const definition = findModelDefinition(identity, models), id = definition?.key ?? JSON.stringify([identity.provider, identity.model]);
    let card = cards.get(id);
    if (!card) {
      card = { id, definition, name: (definition?.model.startsWith("mlx-community--") ? definition.displayName.split(" · ").slice(1).join(" · ") : definition?.model) ?? identity.model.replace(/^\[[^\]]+\]\s*/, ""),
        equipment: definition?.gatewayLabel ?? definition?.equipment ?? identity.model.match(/^\[([^\]]+)\]/)?.[1] ?? "장비 미확인",
        rows: [], requests: [], stages: [] }; cards.set(id, card);
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
  return [...cards.values()].sort((a, b) => b.rows.reduce((n, r) => n + r.indeterminate, 0) - a.rows.reduce((n, r) => n + r.indeterminate, 0));
}
/** Unknown blocks only the affected capacity group; a parallel healthy model can still serve its stage. */
export function stageHealth(observation: AdminModelsObservation, rows: AdminModelMetrics[], requests: AdminModelRequest[]): StageHealth {
  if (observation.mode === "draining" || observation.mode === "disabled") return "접수 중지";
  if (observation.error || !observation.observedAt || !rows.length) return "미확인";
  const unknown = rows.some(row => row.indeterminate > 0);
  const heldGroups = new Set(observation.groups.filter(group => group.limit !== null && group.held >= group.limit).map(group => group.groupId));
  if (unknown && rows.every(row => heldGroups.has(row.groupId))) return "멈춤";
  if (unknown) return "미확인";
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

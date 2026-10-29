import { DEFAULT_MODEL_DEFINITIONS, modelRequestName } from "@/lib/llm/model-registry";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { buildAdminModelsObservation, type AdminModelMetrics, type AdminModelRequest } from "@/lib/operations/admin-models-observation";
import { buildModelThroughput, type ModelCompletion } from "@/lib/operations/admin-models-throughput";
import type { ModelStageAssignment } from "@/lib/operations/admin-models-view";
export const redesignNow = "2026-10-29T07:00:00.000Z";
export const redesignModels = DEFAULT_MODEL_DEFINITIONS.filter(row => ["supa:review", "mlx:text", "m1:translation"].includes(row.key));
const identity = (key: string, routeId: string) => { const definition = redesignModels.find(row => row.key === key)!;
  return { routeId, provider: definition.provider, model: modelRequestName(definition), groupId: definition.equipment, providerBudgetId: definition.equipment }; };
export const redesignRoutes = [identity("supa:review", "first-review"), identity("mlx:text", "first-review"), identity("m1:translation", "product-translate")];
export const redesignPolicy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { supa: 1, mlx: 2, m1: 1 }, groupLimits: { supa: 1, mlx: 2, m1: 1 },
  poolLimits: { reviewer: 3, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 20, queueTtlMs: 60000, reservationTtlMs: 30000, routes: redesignRoutes };
export const redesignMetrics: AdminModelMetrics[] = redesignRoutes.map((row, index) => ({ ...row, succeeded1h: index === 1 ? 28 : index === 0 ? 12 : 0,
  failed1h: 0, withdrawn1h: 0, unclassified1h: 0, waiting: index === 2 ? 2 : 0, reserved: 0,
  dispatched: 0, indeterminate: index === 1 ? 0 : 1, lastSuccessAt: index === 2 ? null : "2026-10-29T06:58:00.000Z" }));
export const redesignRequests: AdminModelRequest[] = [0, 2].map((index, at) => ({ ...redesignRoutes[index], requestId: at === 0 ? "161d7780-5b1f-4ce8-be8d-baed927b28e8" : "29877f65-9f95-4efb-88f9-aea5f39a28b2",
  state: "indeterminate", queuedAt: "2026-10-29T06:40:00.000Z", dispatchedAt: "2026-10-29T06:40:00.000Z", stateSince: "2026-10-29T06:42:00.000Z",
  reservedUntil: null, ownerInstanceId: "fixture-worker", localEndRecorded: true }));
export const redesignAssignments: ModelStageAssignment[] = [{ id: "first-review", label: "1차 검수", models: redesignRoutes.slice(0, 2) },
  { id: "product-translate", label: "상품 번역", models: [redesignRoutes[2]] }];
export function redesignObservation() {
  const observation = buildAdminModelsObservation({ observedAt: redesignNow, control: { mode: "open", epoch: 1, revision: 7, policy: redesignPolicy,
    policyHash: modelCapacityPolicyHash(redesignPolicy), updatedAt: redesignNow }, metrics: redesignMetrics, requests: redesignRequests });
  const completions: ModelCompletion[] = redesignMetrics.slice(0, 2).flatMap((row, index) => Array.from({ length: row.succeeded1h }, (_, at) => ({ ...row, model: redesignModels.find(model => modelRequestName(model) === row.model)!.key,
    state: "settled", queuedAt: new Date(Date.parse(redesignNow) - (at * 60 + (index === 0 ? 40 : 18)) * 1000).toISOString(),
    settledAt: new Date(Date.parse(redesignNow) - at * 60000).toISOString(), responseOk: true })));
  return { ...observation, throughput: buildModelThroughput(completions, redesignNow) };
}

import { modelFamily, modelLimits, scopedModelDefinition } from "@/lib/llm/model-registry";
import { z } from "zod";
import { assistWorkTaskSchema, isAuditAssistTask } from "./work";
import { readActionAuditPolicy } from "@/lib/domain/products/automated-action-audit";
import type { LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { cliEngineRevision } from "@/lib/llm/cli-engine-config";
// PR 3b-E: 관리 계약 표(model_serving_contracts 의 local-model:<backendId> 행)가 env LOCAL_MODEL_SERVING_CONTRACTS 보다 먼저다
import { resolveLocalModelContract, tableLocalModelContract } from "@/lib/llm/local-model-contract-table";

const drainSchema = z.object({ backendId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
  tasks: z.array(z.lazy(() => assistWorkTaskSchema)).min(1).max(8), maxClaims: z.number().int().min(1).max(4) }).strict();
export type AssistBackendDrain = z.infer<typeof drainSchema> & { contract: LocalModelServingContract };

/** 장비 이름으로 기본 주소·모델·용량을 추측하지 않는다. 새 작업은 검증된 native 경로에서만 열린다. */
export function assistBackendDrains(env: Readonly<Record<string, string | undefined>> = process.env, lane: "regular" | "audit" = "regular"): AssistBackendDrain[] {
  if (!env.LLM_ASSIST_BACKENDS) return [];
  const drains = z.array(drainSchema).max(4).parse(JSON.parse(env.LLM_ASSIST_BACKENDS));
  if (new Set(drains.map(drain => drain.backendId)).size !== drains.length) throw new Error("duplicate_assist_backend");
  const auditEnabled = lane === "audit" && readActionAuditPolicy(env).enabled;
  const selected = env === process.env ? scopedModelDefinition(lane === "audit" ? "assist-audit" : "assist-primary") : null;
  if (selected?.cliEngine) {
    const eligible = drains.map(drain => ({
      ...drain,
      tasks: drain.tasks.filter(task => lane === "audit" ? isAuditAssistTask(task) && auditEnabled : !isAuditAssistTask(task)),
    })).filter(drain => drain.tasks.length);
    if (!eligible.length) return [];
    const baseUrl = selected.baseUrl?.replace(/\/+$/, "");
    if (!baseUrl) throw new Error("selected_assist_contract_missing");
    const endpoint = `${baseUrl}/chat/completions`;
    const revision = cliEngineRevision(selected.cliEngine);
    let contract: LocalModelServingContract | null | undefined;
    try {
      contract = tableLocalModelContract(endpoint, selected.model, revision);
    } catch {
      throw new Error("selected_assist_contract_missing");
    }
    if (!contract || contract.provider !== "local-direct" || contract.deploymentRevision !== revision
      || contract.model !== selected.model || contract.endpoint !== endpoint
      || contract.modelFamily !== selected.family) throw new Error("selected_assist_contract_missing");
    const tasks = [...new Set(eligible.flatMap(drain => drain.tasks))];
    return [{
      backendId: contract.backendId,
      tasks,
      maxClaims: Math.min(Math.max(...eligible.map(drain => drain.maxClaims)), modelLimits(lane === "audit" ? "assist-audit" : "assist-primary", env).concurrency),
      contract,
    }];
  }
  const configured = drains.map(drain => ({ ...drain, tasks: drain.tasks.filter(task => lane === "audit" ? isAuditAssistTask(task) && auditEnabled : !isAuditAssistTask(task)) }))
    .filter(drain => drain.tasks.length).map(drain => {
    const contract = resolveLocalModelContract(drain.backendId, env);
    if (!contract || ![modelFamily("assist-primary", env), modelFamily("assist-audit", env)].includes(contract.modelFamily)
      || drain.tasks.some(task => !isAuditAssistTask(task)) && contract.modelFamily !== modelFamily("assist-primary", env)) throw new Error("assist_qwen_or_audit_backend_required");
    return { ...drain, maxClaims: Math.min(drain.maxClaims, modelLimits(isAuditAssistTask(drain.tasks[0]) ? "assist-audit" : "assist-primary", env).concurrency), contract };
  });
  if (!selected) return configured;
  const matching = configured.filter(drain => selected.baseUrl && drain.contract.model === selected.model
    && drain.contract.endpoint === `${selected.baseUrl.replace(/\/+$/, "")}/chat/completions`);
  if (configured.length && !matching.length) throw new Error("selected_assist_contract_missing");
  return matching;
}

export function assistBackendKey(backendId: string, env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  if (!env.LLM_ASSIST_API_KEYS) return null;
  const keys = z.record(z.string(), z.string().min(1).max(4096)).parse(JSON.parse(env.LLM_ASSIST_API_KEYS));
  return keys[backendId] ?? null;
}

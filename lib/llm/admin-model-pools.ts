import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { ADMIN_MODEL_STAGES, adminStagePoolsSchema, type AdminStagePools, type AdminModelStage } from "./admin-model-stages";
import { MODEL_PURPOSE_ENV, readModelRegistry, setModelEnvironmentResolver, type ModelEnvironment, type ModelRegistry } from "./model-registry";

type Selection = { env: ModelEnvironment; selected: Record<string, string>; registry: ModelRegistry };
const scope = new AsyncLocalStorage<Selection>();
setModelEnvironmentResolver((env, purpose) => {
  if (env !== process.env) return env;
  const active = scope.getStore();
  if (!active) return env;
  const key = purpose ? active.selected[purpose] : undefined;
  if (!key) return purpose ? env : active.env;
  const variable = MODEL_PURPOSE_ENV[purpose as keyof typeof MODEL_PURPOSE_ENV];
  return variable ? { ...active.env, [`${variable}_KEY`]: key,
    ...(purpose === "direct-review" ? { AUDIT_SECOND_OPINION_URL: undefined } : {}), ABCLLM_BASE_URL: undefined } : active.env;
});

export function validateAdminStagePools(value: unknown, registry = readModelRegistry()): AdminStagePools {
  const pools = adminStagePoolsSchema.parse(value);
  for (const stage of ADMIN_MODEL_STAGES) for (const key of pools[stage.id] ?? []) {
    const model = registry.models.find(row => row.key === key);
    if (!model || model.provider !== stage.provider) throw new Error(`stage_model_adapter_mismatch:${stage.id}:${key}`);
    // Vision and native assist depend on independent verified contracts; never infer those from a name.
    if ((stage.id.startsWith("assist-") || stage.id === "screen-review") && !model.purposes.includes(stage.purpose)) throw new Error(`stage_model_contract_purpose_required:${stage.id}:${key}`);
  }
  return pools;
}

/** One immutable selection per job lease. Concurrent jobs cannot leak one another's model or endpoint. */
export function withAdminStagePools<T>(value: unknown, assignment: string, run: () => T): T {
  const registry = readModelRegistry(process.env), pools = validateAdminStagePools(value, registry);
  const selected: Record<string, string> = {};
  for (const stage of ADMIN_MODEL_STAGES) {
    const keys = pools[stage.id];
    if (!keys?.length) continue;
    const slot = createHash("sha256").update(`${assignment}:${stage.id}`).digest().readUInt32BE(0) % keys.length;
    selected[stage.id] = keys[slot];
  }
  if (!Object.keys(selected).length) return run();
  const configured: ModelRegistry = { ...registry, selections: { ...registry.selections, ...selected },
    models: registry.models.map(model => ({ ...model, purposes: [...new Set([...model.purposes,
      ...Object.entries(selected).filter(([, key]) => key === model.key).map(([purpose]) => purpose)])] })) };
  const env = { ...process.env, MODEL_REGISTRY_CONFIG: JSON.stringify(configured) };
  // Run the central registry's complete deadline, identity and purpose checks before opening the scope.
  readModelRegistry(env);
  return scope.run({ env, selected, registry: configured }, run);
}

/** A shared adapter can serve distinct administrative stages without sharing their saved choices. */
export function withAdminModelStage<T>(stageId: AdminModelStage, run: () => T): T {
  const active = scope.getStore(), stage = ADMIN_MODEL_STAGES.find(row => row.id === stageId);
  const key = active?.selected[stageId];
  if (!active || !stage || !key || stageId === stage.purpose) return run();
  const registry = { ...active.registry, selections: { ...active.registry.selections, [stage.purpose]: key },
    models: active.registry.models.map(model => model.key === key ? { ...model, purposes: [...new Set([...model.purposes, stage.purpose])] } : model) };
  const env = { ...active.env, MODEL_REGISTRY_CONFIG: JSON.stringify(registry) };
  readModelRegistry(env);
  return scope.run({ env, selected: { ...active.selected, [stage.purpose]: key }, registry }, run);
}

export const MODEL_POOL_JOBS = new Set(["human-deepseek-review", "held-qwen-retry", "split-confirm", "product-audit", "audit-qwen", "audit-second-opinion",
  "audit-screen-review", "second-review", "split-tiebreak",
  "reason-translate", "crawl-tagline", "product-translate", "product-tagline-ko", "product-search-profile", "product-search-verify",
  "product-intro-check", "product-llm-assist-review", "product-llm-assist-audit-review", "product-automated-action-audit"]);
/**
 * 잡 lease 마다 한 번 고정하는 관리자 단계 풀. 2026-10-31(PR 3a-C) 합성 잡을 나눠 잡 하나가 자기 단계 하나를 연다 — 갈림 판가름은 split-tiebreak 잡,
 * 갈림 확인은 split-confirm 잡(gate-split-confirm.ts 가 안에서도 같은 단계를 연다), 보류 재심사는 held-qwen-retry 잡, Qwen 직접 감사는 audit-qwen 잡.
 * 두 번째 의견·공개분 거르기는 audit-second-opinion-auto.ts 가 단계마다 스스로 연다. 사람 큐 위임(human-review)은 단계 id 가 purpose 와 같아 풀만 고른다.
 */
export async function withStoredAdminStagePools<T>(assignment: string, run: () => Promise<T>): Promise<T> {
  if (scope.getStore()) return run();
  const { getSettings } = await import("@/lib/crawl/settings");
  const { onPrimary } = await import("@/lib/db");
  const settings = await onPrimary(getSettings);
  return withAdminStagePools(settings.stageModelPools ?? {}, assignment, () => {
    if (assignment.startsWith("split-tiebreak:")) return withAdminModelStage("split-tiebreak", run);
    if (assignment.startsWith("split-confirm:")) return withAdminModelStage("split-confirm", run);
    if (assignment.startsWith("held-qwen-retry:")) return withAdminModelStage("held-review-retry", run);
    if (assignment.startsWith("audit-qwen:")) return withAdminModelStage("audit-review", run);
    return run();
  });
}

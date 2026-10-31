import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { ADMIN_MODEL_STAGES, adminStagePoolsSchema, type AdminStagePools, type AdminModelStage } from "./admin-model-stages";
import { MODEL_PURPOSE_ENV, modelRequestName, readModelRegistry, setModelEnvironmentResolver, type ModelEnvironment, type ModelRegistry } from "./model-registry";
import { assignmentTableEnabled } from "./assignment-flag";
import type { AssignmentStage, ModelAssignmentRow } from "./capacity-helpers";
import { ADMIN_STAGE_ASSIGNMENTS, chooseModelForItem } from "./stage-assignments";
import { ensureStageAssignments, noteAssignmentOnce, stageAssignmentRows } from "./stage-assignment-snapshot";

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

const stageSlot = (assignment: string, stageId: string) => createHash("sha256").update(`${assignment}:${stageId}`).digest().readUInt32BE(0);

/**
 * 배정 표(PR 3b-B)가 출처인 관리자 단계의 고른 등록부 key(순수 — rows 를 주입한다). ADMIN_STAGE_ASSIGNMENTS 로 대응하는 단계만, 그 단계의 live 행에서
 * 저장 풀과 같은 검사(등록부에 있고 공급자가 단계 adapter 와 같고, assist·화면 판별은 용도 계약이 있다)와 wire 모델 = 등록부 요청 이름을 지나는 행만 쓴다.
 * 고르기는 결정적인 chooseModelForItem: 저장 풀과 같은 hash 칸(sha256(assignment:stage))을 itemKey 로 — 가장 낮은 rank 의 행들 중 그 칸.
 * 「빈 grant 가 있는 첫 rank 1 행」은 이 길목이 표현하지 못한다(잡 lease 하나에 한 번 고르는 동기 scope 다) — 입장이 포화를 미룬다.
 * 쓸 행이 없는 단계는 빠진다(저장 풀 그대로).
 */
export function tableStageSelections(rowsFor: (stage: AssignmentStage) => readonly ModelAssignmentRow[] | null, assignment: string,
  registry: ModelRegistry): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const stage of ADMIN_MODEL_STAGES) {
    const target = ADMIN_STAGE_ASSIGNMENTS[stage.id];
    const rows = target ? rowsFor(target) : null;
    if (!rows?.length) continue;
    const fit = rows.filter(row => {
      const model = registry.models.find(entry => entry.key === row.registryKey);
      return !!model && model.provider === stage.provider && modelRequestName(model) === row.model
        && !((stage.id.startsWith("assist-") || stage.id === "screen-review") && !model.purposes.includes(stage.purpose));
    });
    if (fit.length < rows.length) noteAssignmentOnce(`assignment_stage_rows_unusable:${stage.id}`, { stage: target, unusable: rows.length - fit.length });
    const pick = chooseModelForItem(fit, stageSlot(assignment, stage.id) + 1);
    if (pick) selected[stage.id] = pick.registryKey;
  }
  return selected;
}

/** One immutable selection per job lease. Concurrent jobs cannot leak one another's model or endpoint. */
export function withAdminStagePools<T>(value: unknown, assignment: string, run: () => T): T {
  return runWithStagePools(value, assignment, run, {});
}

function runWithStagePools<T>(value: unknown, assignment: string, run: () => T, tableSelected: Readonly<Record<string, string>>): T {
  const registry = readModelRegistry(process.env), pools = validateAdminStagePools(value, registry);
  const selected: Record<string, string> = { ...tableSelected };
  for (const stage of ADMIN_MODEL_STAGES) {
    const keys = pools[stage.id];
    if (selected[stage.id] || !keys?.length) continue;
    const slot = stageSlot(assignment, stage.id) % keys.length;
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

export const MODEL_POOL_JOBS = new Set(["human-deepseek-review", "product-audit", "audit-screen-review", "second-review",
  "reason-translate", "crawl-tagline", "product-translate", "product-tagline-ko", "product-search-profile", "product-search-verify",
  "product-intro-check", "product-llm-assist-review", "product-llm-assist-audit-review", "product-automated-action-audit"]);
export async function withStoredAdminStagePools<T>(assignment: string, run: () => Promise<T>): Promise<T> {
  if (scope.getStore()) return run();
  const { getSettings } = await import("@/lib/crawl/settings");
  const { onPrimary } = await import("@/lib/db");
  const settings = await onPrimary(getSettings);
  // 배정 표(PR 3b-B, MODEL_ASSIGNMENT_TABLE): 대응하는 단계는 저장 풀 대신 표에서 고른다. 스위치가 꺼졌으면 빈 선택(오늘 그대로).
  let table: Record<string, string> = {};
  if (assignmentTableEnabled()) {
    await ensureStageAssignments();
    table = tableStageSelections(stageAssignmentRows, assignment, readModelRegistry(process.env));
  }
  return runWithStagePools(settings.stageModelPools ?? {}, assignment, () => {
    if (assignment.startsWith("second-review:")) return withAdminModelStage("split-tiebreak", () => withAdminModelStage("split-confirm", run));
    if (assignment.startsWith("human-deepseek-review:")) return withAdminModelStage("held-review-retry", run);
    if (assignment.startsWith("product-audit:")) return withAdminModelStage("audit-review", run);
    return run();
  }, table);
}

import { ADMIN_MODEL_STAGES, type AdminStagePools } from "@/lib/llm/admin-model-stages";
import { AI_TEXT_TASK_IDS } from "@/lib/llm/ai-tasks";
import type { TextTaskRankBinding } from "@/lib/llm/ai-task-rank-scope";
import type { ModelStageAssignment } from "./admin-models-view";
import type { ModelEnv, TextModelRoute } from "./pipeline-control";

type Stage = typeof ADMIN_MODEL_STAGES[number];
export type TextStageBindings = Partial<Record<TextModelRoute, readonly Pick<TextTaskRankBinding, "identity" | "provider">[] | null>>;

/** Display the same bound task ranks as execution. A registry purpose or retired stage pool is not a text-task default. */
export function adminModelStageView({ models, pools, bindings, legacyDefault }: {
  models: ModelEnv; pools: AdminStagePools | undefined; bindings: TextStageBindings;
  legacyDefault: (stage: Stage) => string | null;
}): { defaults: Record<string, string>; assignments: ModelStageAssignment[] } {
  const defaults: Record<string, string> = {};
  const assignments = ADMIN_MODEL_STAGES.map((stage): ModelStageAssignment => {
    if ((AI_TEXT_TASK_IDS as readonly string[]).includes(stage.id)) {
      const route = stage.id as TextModelRoute;
      const identities = models.pooled?.[route];
      defaults[stage.id] = identities?.[0] ?? (identities ? "실행 가능한 순위 없음" : "확인 못함");
      // Match the ledger identity to its actual binding provider. Never guess the catalog provider or a first registry match.
      const seen = new Set<string>();
      const ranked = (identities ?? []).flatMap(identity => (bindings[route] ?? []).filter(binding => binding.identity === identity)
        .map(binding => ({ provider: binding.provider, model: binding.identity }))).filter(model => {
        const key = `${model.provider}\0${model.model}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      return { id: stage.id, label: stage.label, models: ranked };
    }
    // A legacy reference default may be absent or ambiguous. Keep live ledger observations available in that case.
    let fallback: string | null = null;
    try { fallback = legacyDefault(stage); } catch { /* Unknown is preferable to inventing a registered default. */ }
    defaults[stage.id] = fallback || "확인 못함";
    const selected = pools?.[stage.id]?.length ? pools[stage.id]! : fallback && fallback !== "미설정" ? [fallback] : [];
    return { id: stage.id, label: stage.label, models: selected.map(model => ({ provider: stage.provider, model })) };
  });
  return { defaults, assignments };
}

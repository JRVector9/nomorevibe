import { withAdminStagePools } from "@/lib/llm/admin-model-pools";
import { modelForPurpose, readModelRegistry } from "@/lib/llm/model-registry";
import { deepseekReviewReady } from "@/lib/crawl/deepseek-review";

/** 사람 위임 모델 한 개의 자동 연결 확인(렌더 때) — 등록부 키·제공자와 /models 결과·소요. 한 화면이 probe:<provider>:<key> 관측으로 남긴다. */
export type HumanModelProbe = { key: string; provider: string; ready: boolean; ms: number };

/**
 * 설정된 위임 모델마다 추론과 같은 범위 해석기(withAdminStagePools)로 /models 를 확인한다. 풀이 비었으면 등록부의 human-review 모델 하나다.
 * 등록부에 human-review 모델이 유일하지 않으면(모델 선택 오류) 빈 배열 — 부르는 쪽이 옛 판정(deepseekReviewReady)으로 돌아간다.
 */
export async function configuredHumanModelsProbe(keys: readonly string[] = []): Promise<HumanModelProbe[]> {
  const models = readModelRegistry().models;
  let targets: readonly string[] = keys;
  if (!targets.length) { try { targets = [modelForPurpose("human-review").key]; } catch { return []; } }
  return Promise.all(targets.map(async key => {
    const started = Date.now();
    const ready = await (keys.length ? withAdminStagePools({ "human-review": [key] }, "admin-models-readiness", () => deepseekReviewReady()) : deepseekReviewReady()).catch(() => false);
    return { key, provider: models.find(model => model.key === key)?.provider ?? "local-direct", ready, ms: Date.now() - started };
  }));
}

/** Validate every configured delegate through the same scoped model/endpoint resolver as inference. */
export async function configuredHumanModelsReady(keys: readonly string[] = []): Promise<boolean> {
  if (!keys.length) return deepseekReviewReady();
  try {
    const results = await Promise.all(keys.map(key => withAdminStagePools({ "human-review": [key] }, "admin-models-readiness", () => deepseekReviewReady())));
    return results.every(Boolean);
  } catch { return false; }
}

/** Operator label for the human-review delegate: the saved pool, else the registry's human-review model. Never a fixed name. */
export function humanReviewModelDisplay(keys: readonly string[] = []): { modelLabel: string; modelLocation: string } {
  if (keys.length) {
    const models = readModelRegistry().models;
    return { modelLabel: "선택 모델", modelLocation: `사람 위임 검수 풀 · ${keys.map(key => models.find(model => model.key === key)?.displayName ?? key).join(", ")}` };
  }
  const model = modelForPurpose("human-review");
  return { modelLabel: model.displayName, modelLocation: `${model.key} · ${model.model}` };
}

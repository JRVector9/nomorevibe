import { firstReviewCandidates } from "@/lib/crawl/first-reviewers";
import { modelRequestName, readModelRegistry } from "@/lib/llm/model-registry";
import type { ModelOption } from "../settings/ModelRows";

/** 엔진 모델 이름은 운영자가 넣은 API의 GET /models 결과만 쓴다. 등록부에 적힌 모델 문자열은 선택지로 만들지 않는다. */
export function reviewModelOptions(engineModels: readonly string[] | null, direct: boolean): ModelOption[] {
  const registry = readModelRegistry().models;
  const candidates = firstReviewCandidates();
  const listed = (provider: string, model: string) => direct || candidates.some(row => row.provider === provider && row.model === model);
  return [
    ...(engineModels ?? []).map(model => ({ provider: "local-direct" as const, model, label: model })),
    ...registry.filter(model => (model.provider === "claude-cli" || model.provider === "grok-cli") && listed(model.provider, modelRequestName(model)))
      .map(model => ({ provider: model.provider, model: model.model, label: model.displayName })),
  ];
}

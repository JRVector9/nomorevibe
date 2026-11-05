import { readModelRegistry } from "@/lib/llm/model-registry";
/**
 * 같은 모델을 다른 연결에도 둔 순위의 장부 이름(`<모델>@<연결 id 앞 8자>`, lib/llm/ai-tasks.ts aiTaskAliasIdentity, PR B·C1)의 꼬리.
 * 장부·계약·결과 행의 model 은 이 이름이지만 같은 모델이다 — 같은 모델인가를 가를 때는 꼬리를 뗀다(SQL 짝: held-qwen-retry-policy.ts underlyingModelSql).
 */
export const AI_TASK_ALIAS_SUFFIX = /@[0-9a-f]{8}$/;
export const withoutAliasSuffix = (model: string): string => model.trim().replace(AI_TASK_ALIAS_SUFFIX, "");

/** The gateway exposes the same model with and without its routing prefix. 연결로 가른 장부 이름의 꼬리(@<연결 8자>)도 뗀다. */
export function canonicalReviewModel(model: string): string {
  return withoutAliasSuffix(model).replace(/^\[MLX\]\s*/i, "").toLowerCase();
}

export function sameReviewModel(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && canonicalReviewModel(a) === canonicalReviewModel(b));
}

/**
 * 앞의 자리 표시 대괄호 덩이([MLX]·[gpu3090]·[supa] …)를 모두 뗀 모델 이름 — 같은 가중치의 모델인가(독립 표인가)를 가를 때 쓴다.
 * 게이트웨이는 gpu3090 의 Qwen 을 '[gpu3090] qwen3.8-flash-next' 로, 보류 재심사·갈림 판가름은 'qwen3.8-flash-next' 로 부른다 —
 * '[MLX] ' 만 떼는 canonicalReviewModel 로는 둘을 다른 모델로 보아 같은 모델의 표가 독립 칸을 채운다. 칸·슬롯을 맞출 때는 sameReviewModel,
 * 1차와 같은 모델인지(되풀이 표인지) 가를 때는 sameUnderlyingModel 을 쓴다. SQL 짝은 held-qwen-retry-policy.ts underlyingModelSql.
 */
export function underlyingReviewModel(model: string): string {
  const definition = readModelRegistry().models.find(entry => entry.key === model.trim());
  return bareModelName(definition?.model ?? model).replace(/\+(?:vision(?:-shot2)?|prompt-v3)$/, "");
}

/**
 * 같은 가중치의 이름 — 앞의 자리 표시([supa] …)와 배포자 접두어(Inferact/ …)를 떼고 소문자로. 엔진에 직접 붙인 Supa 는
 * 'Inferact/Qwen3.8-27B-NVFP4', 게이트웨이는 '[supa] Qwen3.8-27B-NVFP4' 로 부른다(2026-10-29) — 둘은 같은 모델이다.
 * SQL 짝은 held-qwen-retry-policy.ts underlyingModelSql·audit-second-opinion-auto.ts bareModel.
 */
export function bareModelName(model: string): string {
  return withoutAliasSuffix(model).replace(/^\[[^\]]*\]\s*/, "").replace(/^[^/\s]+\//, "").toLowerCase();
}

export function sameUnderlyingModel(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && underlyingReviewModel(a) && underlyingReviewModel(a) === underlyingReviewModel(b));
}

/** Policy veto, NOT a statement that catalog entries have proven identical weights.
 * The observed OpenCode catalog exposes provider/tier aliases but no weight fingerprints.
 * Those aliases cannot supply independent votes for the same explicit DeepSeek model.
 */
const UNVERIFIED_REVIEW_FAMILIES: readonly (readonly string[])[] = [
  ['opencode/deepseek-v4.1-flash', 'opencode/deepseek-v4.1-flash-free', 'opencode-go/deepseek-v4.1-flash'],
  ['opencode/deepseek-v4-pro', 'opencode-go/deepseek-v4-pro'],
];
export function reviewIndependenceKey(model: string): string {
  const value = withoutAliasSuffix(model).toLowerCase();
  const family = UNVERIFIED_REVIEW_FAMILIES.findIndex(members => members.includes(value)
    || underlyingReviewModel(model) === underlyingReviewModel(members[0]));
  return family < 0 ? underlyingReviewModel(model) : `unverified-opencode-family:${family}`;
}
export function reviewModelsMayCountIndependently(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && !sameUnderlyingModel(a, b) && reviewIndependenceKey(a) !== reviewIndependenceKey(b));
}

export function sameReviewIndependence(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && reviewIndependenceKey(a) === reviewIndependenceKey(b));
}

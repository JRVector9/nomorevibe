/** The gateway exposes the same model with and without its routing prefix. */
export function canonicalReviewModel(model: string): string {
  return model.trim().replace(/^\[MLX\]\s*/i, "").toLowerCase();
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
  return model.trim().replace(/^\[[^\]]*\]\s*/, "").toLowerCase();
}

export function sameUnderlyingModel(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && underlyingReviewModel(a) && underlyingReviewModel(a) === underlyingReviewModel(b));
}

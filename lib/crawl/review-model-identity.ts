/** The gateway exposes the same model with and without its routing prefix. */
export function canonicalReviewModel(model: string): string {
  return model.trim().replace(/^\[MLX\]\s*/i, "").toLowerCase();
}

export function sameReviewModel(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && canonicalReviewModel(a) === canonicalReviewModel(b));
}

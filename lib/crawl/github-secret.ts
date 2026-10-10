/** 수집 자격(개인 토큰·GitHub App)이 함께 쓰는 것 — github-accounts.ts 와 github-apps.ts 가 서로를 불러오지 않게 따로 둔다 */
export type CoreQuota = { limit: number; used: number; remaining: number; reset: number };

export function collectorSecret(): string {
  const secret = process.env.GITHUB_COLLECTOR_SECRET;
  if (!secret || secret.length < 32) throw new Error("github_collector_secret_missing");
  return secret;
}

export function parseCoreQuota(input: unknown): CoreQuota | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const numbers = [value.limit, value.used, value.remaining, value.reset];
  if (!numbers.every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return null;
  return { limit: value.limit as number, used: value.used as number, remaining: value.remaining as number, reset: value.reset as number };
}

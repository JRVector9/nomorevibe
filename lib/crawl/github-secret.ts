/** 수집 자격(개인 토큰·GitHub App)이 함께 쓰는 것 — github-accounts.ts 와 github-apps.ts 가 서로를 불러오지 않게 따로 둔다 */
export type CoreQuota = { limit: number; used: number; remaining: number; reset: number };

export function collectorSecret(): string {
  const secret = process.env.GITHUB_COLLECTOR_SECRET;
  if (!secret || secret.length < 32) throw new Error("github_collector_secret_missing");
  return secret;
}

/**
 * 이 서버가 쓸 수집 자격(2026-10-19) — 서버마다 환경 변수로 자격 종류와 App 설치를 고른다.
 *  - GITHUB_COLLECTOR_SOURCES: env(GITHUB_TOKEN)·accounts(관리자 PAT)·apps(GitHub App) 중 쓸 것, 쉼표로
 *  - GITHUB_COLLECTOR_APP_INSTALLATIONS: 이 설치만 쓴다 / GITHUB_COLLECTOR_EXCLUDE_APP_INSTALLATIONS: 이 설치는 빼고 쓴다(둘 중 하나만)
 * 셋 다 없으면 null — 지금처럼 모든 자격을 쓴다. 넣은 값이 틀리면 조용히 전부 쓰지 않고 던진다(빈 값도 틀린 값이다).
 */
export type CollectorSource = "env" | "accounts" | "apps";
export type CollectorScope = { sources: ReadonlySet<CollectorSource>; onlyInstallations: number[] | null; excludedInstallations: number[] | null };
const COLLECTOR_SOURCES: readonly string[] = ["env", "accounts", "apps"] satisfies CollectorSource[];

export function collectorScope(env: Record<string, string | undefined> = process.env): CollectorScope | null {
  const sources = env.GITHUB_COLLECTOR_SOURCES;
  const only = env.GITHUB_COLLECTOR_APP_INSTALLATIONS;
  const excluded = env.GITHUB_COLLECTOR_EXCLUDE_APP_INSTALLATIONS;
  if (sources === undefined && only === undefined && excluded === undefined) return null;
  const invalid = (name: string) => new Error(`github_collector_scope_invalid:${name}`);
  const picked = sources === undefined ? COLLECTOR_SOURCES : sources.split(",").map(item => item.trim());
  if (!picked.every(item => COLLECTOR_SOURCES.includes(item))) throw invalid("GITHUB_COLLECTOR_SOURCES");
  const installations = (name: string, value: string | undefined) => {
    if (value === undefined) return null;
    const ids = value.split(",").map(item => item.trim());
    if (!ids.every(id => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)))) throw invalid(name);
    return ids.map(Number);
  };
  const scope = { sources: new Set(picked as CollectorSource[]),
    onlyInstallations: installations("GITHUB_COLLECTOR_APP_INSTALLATIONS", only),
    excludedInstallations: installations("GITHUB_COLLECTOR_EXCLUDE_APP_INSTALLATIONS", excluded) };
  // 허용과 제외를 같이 넣거나, App 을 쓰지 않는 서버에 설치를 고르면 뜻이 둘로 읽힌다
  if (scope.onlyInstallations && scope.excludedInstallations) throw invalid("GITHUB_COLLECTOR_APP_INSTALLATIONS");
  if ((scope.onlyInstallations || scope.excludedInstallations) && !scope.sources.has("apps")) throw invalid("GITHUB_COLLECTOR_SOURCES");
  return scope;
}

export function parseCoreQuota(input: unknown): CoreQuota | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const numbers = [value.limit, value.used, value.remaining, value.reset];
  if (!numbers.every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return null;
  return { limit: value.limit as number, used: value.used as number, remaining: value.remaining as number, reset: value.reset as number };
}

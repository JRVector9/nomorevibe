import { logger } from "@/lib/observability/logger";
import { readBodyStrictlyCapped } from "@/lib/net/fetch";
import { githubCooldown, githubResource, readGitHubCooldown, recordGitHubCooldown,
  readGitHubAuthCooldown, recordGitHubAuthCooldown } from "./github-quota";
import { collectorTokens, observeCollectorQuota, type CollectorToken } from "./github-accounts";

/**
 * GitHub API — 수집기가 쓰는 만큼만.
 *
 * 실패를 종류로 나눠 돌려준다. 잡이 세 경우를 다르게 다뤄야 하기 때문이다.
 * rate limit이면 이번 틱을 접고(다음 틱이 이어받는다), 404면 다시 시도할 이유가 없고
 * (지워졌거나 비공개로 바뀌었다), 나머지 오류만 백오프 재시도 대상이다.
 * 셋을 같게 다루면 큐가 막히거나 영원히 돈다.
 *
 * 여기서는 재시도하지 않는다 — 기다리는 일은 잡의 시간 예산 안에서 결정할 문제다.
 */

const API_ORIGIN = "https://api.github.com";
const GITHUB_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const AUTH_RETRY_DELAYS_MS = [100, 250] as const;
const AUTH_COOLDOWN_MS = 15 * 60_000;
type AuthReason = "expired" | "revoked" | "bad_credentials" | "unauthorized" | "blocked" | "cooldown";

export type GitHubFailure =
  | { kind: "rate_limited"; resetAt: Date | null }
  | { kind: "not_found" }
  | { kind: "transport" }
  | { kind: "invalid_response" }
  | { kind: "auth_unavailable"; reason: AuthReason; resetAt: Date | null }
  | { kind: "http"; status: number };

export type GitHubResult<T> = { ok: true; value: T } | { ok: false; error: GitHubFailure };

export type ConditionalRequest = { etag?: string | null; lastModified?: string | null };
export type GitHubHttpResult<T> =
  | {
      ok: true;
      status: 200;
      value: T;
      etag: string | null;
      lastModified: string | null;
      link: string | null;
    }
  | {
      ok: true;
      status: 304;
      etag: string | null;
      lastModified: string | null;
      link: string | null;
    }
  | { ok: false; error: GitHubFailure };

const rotation: Record<string, number> = {};

export async function githubRequest<T>(
  path: string,
  conditional: ConditionalRequest = {},
  /** body 가 있으면 JSON 으로 POST 한다(GraphQL) */
  options: { timeoutMs?: number; body?: unknown } = {},
): Promise<GitHubHttpResult<T>> {
  // Paths come from repository metadata and cursors; never let them change the API origin.
  let decoded: string;
  try { decoded = decodeURIComponent(path.split("?")[0]); }
  catch { return { ok: false, error: { kind: "invalid_response" } }; }
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\x00-\x20#]/.test(path)
    || decoded.split("/").some((part) => part === "." || part === "..")) {
    return { ok: false, error: { kind: "invalid_response" } };
  }
  const accounts = await collectorTokens();
  if (accounts.length === 0) throw new Error("GitHub 수집 토큰이 없습니다 — 인증된 토큰이 필요합니다");
  const resource = githubResource(path);
  const start = (rotation[resource] ?? 0) % accounts.length;
  rotation[resource] = start + 1;
  const deadline = Date.now() + Math.max(1, Math.min(options.timeoutMs ?? 10_000, 10_000));
  let earliestReset: Date | null = null;
  let authFailure: Extract<GitHubFailure, { kind: "auth_unavailable" }> | null = null;
  for (let offset = 0; offset < accounts.length; offset++) {
    const account = accounts[(start + offset) % accounts.length];
    let secondary = false;
    let sawUnauthorized = false;
    let result: GitHubHttpResult<T>;
    for (let attempt = 0; ; attempt++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return authFailure
        ? { ok: false, error: { ...authFailure, resetAt: new Date(Math.min(
          authFailure.resetAt?.getTime() ?? Infinity, Date.now() + 60_000)) } }
        : { ok: false, error: { kind: "transport" } };
      result = await githubRequestWithToken<T>(path, conditional, { timeoutMs: remainingMs, body: options.body }, account, () => { secondary = true; });
      if (!result.ok && result.error.kind === "http" && result.error.status === 403 && sawUnauthorized) {
        const resetAt = await recordGitHubAuthCooldown(account.token, new Date(Date.now() + AUTH_COOLDOWN_MS));
        logger.warn("github.auth_rejected", { accountId: account.userId, reason: "blocked" });
        result = { ok: false, error: { kind: "auth_unavailable", reason: "blocked", resetAt } };
        break;
      }
      if (result.ok || result.error.kind !== "auth_unavailable" || result.error.reason === "cooldown") break;
      sawUnauthorized = true;
      if (result.error.reason === "blocked" || attempt >= AUTH_RETRY_DELAYS_MS.length
        || deadline - Date.now() <= AUTH_RETRY_DELAYS_MS[attempt]) {
        const resetAt = await recordGitHubAuthCooldown(account.token, new Date(Date.now() + AUTH_COOLDOWN_MS));
        result = { ok: false, error: { ...result.error, resetAt } };
        break;
      }
      await new Promise(resolve => setTimeout(resolve, AUTH_RETRY_DELAYS_MS[attempt]));
    }
    if (!result.ok && result.error.kind === "auth_unavailable") {
      authFailure = result.error;
      continue;
    }
    if (!result.ok && result.error.kind === "rate_limited" && !secondary) {
      if (result.error.resetAt && (!earliestReset || result.error.resetAt < earliestReset)) earliestReset = result.error.resetAt;
      continue;
    }
    return result;
  }
  if (earliestReset === null && authFailure) return { ok: false, error: { ...authFailure,
    resetAt: new Date(Math.min(authFailure.resetAt?.getTime() ?? Infinity, Date.now() + 60_000)) } };
  return { ok: false, error: { kind: "rate_limited", resetAt: earliestReset } };
}

async function githubRequestWithToken<T>(
  path: string, conditional: ConditionalRequest, options: { timeoutMs?: number; body?: unknown },
  account: CollectorToken, onSecondary: () => void,
): Promise<GitHubHttpResult<T>> {
  const token = account.token;
  const resource = githubResource(path);
  const authUntil = await readGitHubAuthCooldown(token);
  if (authUntil) return { ok: false, error: { kind: "auth_unavailable", reason: "cooldown", resetAt: authUntil } };
  const waitingUntil = await readGitHubCooldown(token, resource);
  if (waitingUntil) return { ok: false, error: { kind: "rate_limited", resetAt: waitingUntil } };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "user-agent": "NoMoreVibe/1.0 (+https://nomorevibe.app)",
  };
  if (conditional.etag) headers["If-None-Match"] = conditional.etag;
  if (conditional.lastModified) headers["If-Modified-Since"] = conditional.lastModified;
  const post = options.body !== undefined;
  if (post) headers["Content-Type"] = "application/json";

  let res: Response;
  const signal = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 10_000, 10_000)));
  let url = `${API_ORIGIN}${path}`;
  const visited = new Set([url]);
  try {
    for (let redirects = 0; ; redirects++) {
      res = await fetch(url, { method: post ? "POST" : "GET", headers, body: post ? JSON.stringify(options.body) : undefined,
        redirect: "manual", signal });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      // GraphQL 은 옮겨 가지 않는다 — 본문을 다른 곳에 다시 보내지 않는다
      if (post || !location || redirects >= 3) return { ok: false, error: { kind: "invalid_response" } };
      let next: URL;
      try { next = new URL(location, url); }
      catch { return { ok: false, error: { kind: "invalid_response" } }; }
      // Repository renames legitimately redirect to /repositories/:id. Never send the token outside this API origin.
      if (next.origin !== API_ORIGIN || next.username || next.password || next.hash || visited.has(next.href)) {
        return { ok: false, error: { kind: "invalid_response" } };
      }
      const redirectCooldown = githubCooldown(res.status, res.headers);
      if (redirectCooldown) {
        const resetAt = await recordGitHubCooldown(token, resource, redirectCooldown);
        if (redirectCooldown.secondary) onSecondary();
        return { ok: false, error: { kind: "rate_limited", resetAt } };
      }
      visited.add(next.href);
      url = next.href;
    }
  } catch {
    return { ok: false, error: { kind: "transport" } };
  }

  try { await observeCollectorQuota(account.userId, res.headers); }
  catch { logger.warn("github.quota_observation_failed", { accountId: account.userId }); }
  // A successful response can consume the last primary request. Persist it while retaining its body.
  let cooldown = githubCooldown(res.status, res.headers);
  if (res.status === 403 && !cooldown?.secondary) {
    // GitHub also reports secondary limits in the error message without Retry-After.
    try {
      const body = await readBodyStrictlyCapped(res, GITHUB_RESPONSE_MAX_BYTES);
      const message = body ? (JSON.parse(body.toString("utf8")) as { message?: unknown }).message : null;
      cooldown = githubCooldown(res.status, res.headers, new Date(), typeof message === "string"
        && /secondary rate limit|abuse detection/i.test(message));
    } catch { /* The status remains an ordinary HTTP failure when the error body is invalid. */ }
  }
  const resetAt = cooldown ? await recordGitHubCooldown(token, resource, cooldown) : null;
  if (cooldown && (res.status === 403 || res.status === 429)) {
    if (cooldown.secondary) onSecondary();
    await res.body?.cancel().catch(() => {});
    logger.warn("github.rate_limited", { path, resetAt: resetAt?.toISOString(), secondary: cooldown.secondary });
    return { ok: false, error: { kind: "rate_limited", resetAt } };
  }

  if (res.status === 401) {
    let reason: AuthReason = "unauthorized";
    try {
      const body = await readBodyStrictlyCapped(res, GITHUB_RESPONSE_MAX_BYTES);
      const message = body ? (JSON.parse(body.toString("utf8")) as { message?: unknown }).message : null;
      if (typeof message === "string") {
        if (/expir/i.test(message)) reason = "expired";
        else if (/revok/i.test(message)) reason = "revoked";
        else if (/bad credentials/i.test(message)) reason = "bad_credentials";
      }
    } catch { /* Only a bounded reason code is recorded; raw response text is never logged. */ }
    logger.warn("github.auth_rejected", { accountId: account.userId, reason });
    return { ok: false, error: { kind: "auth_unavailable", reason, resetAt: null } };
  }

  const responseHeaders = {
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    link: res.headers.get("link"),
  };
  if (res.status === 304) return { ok: true, status: 304, ...responseHeaders };
  if (res.status === 204 && /\/contributors(?:\?|$)/.test(path)) {
    return { ok: true, status: 200, value: [] as T, ...responseHeaders };
  }
  if (res.ok) {
    let value: T;
    try {
      const body = await readBodyStrictlyCapped(res, GITHUB_RESPONSE_MAX_BYTES);
      if (body === null) return { ok: false, error: { kind: "invalid_response" } };
      value = JSON.parse(body.toString("utf8")) as T;
    } catch {
      return { ok: false, error: { kind: "invalid_response" } };
    }
    return {
      ok: true,
      status: 200,
      value,
      ...responseHeaders,
    };
  }

  if (res.status === 404) return { ok: false, error: { kind: "not_found" } };

  return { ok: false, error: { kind: "http", status: res.status } };
}

export type GraphqlError = { type?: string; path?: (string | number)[]; message?: string };
export type GitHubGraphqlResult<T> = { ok: true; data: T | null; errors: GraphqlError[] } | { ok: false; error: GitHubFailure };

/**
 * GraphQL 한 번 — 토큰 고르기·한도·인증 실패 처리는 githubRequest 와 같다(토큰을 돌려 가며, 기다림은 DB 에 함께 적는다).
 *
 * 별칭마다 따로 실패할 수 있어(없는 저장소는 그 별칭이 null 이고 errors 에 path 가 붙는다) data 와 errors 를 둘 다 돌려준다.
 * 한도가 바닥나면 GitHub 이 200 에 RATE_LIMITED 오류로 답하기도 한다 — 그때는 rate_limited 로 바꾼다
 * (기다릴 시각은 githubRequest 가 응답 머리 x-ratelimit-remaining: 0 으로 이미 적었다).
 */
export async function githubGraphql<T>(query: string, options: { timeoutMs?: number } = {}): Promise<GitHubGraphqlResult<T>> {
  const result = await githubRequest<{ data?: unknown; errors?: unknown }>("/graphql", {}, { ...options, body: { query } });
  if (!result.ok) return result;
  if (result.status !== 200 || !result.value || typeof result.value !== "object") return { ok: false, error: { kind: "invalid_response" } };
  const errors = (Array.isArray(result.value.errors) ? result.value.errors : [])
    .filter((error): error is GraphqlError => !!error && typeof error === "object");
  if (errors.some((error) => error.type === "RATE_LIMITED")) return { ok: false, error: { kind: "rate_limited", resetAt: null } };
  const data = result.value.data && typeof result.value.data === "object" ? result.value.data as T : null;
  if (!data && errors.length === 0) return { ok: false, error: { kind: "invalid_response" } };
  return { ok: true, data, errors };
}

async function request<T>(path: string): Promise<GitHubResult<T>> {
  const result = await githubRequest<T>(path);
  if (!result.ok) return result;
  if (result.status === 200) return { ok: true, value: result.value };
  return { ok: false, error: { kind: "http", status: 304 } };
}

/** 판정에 쓰는 레포 메타 원본. 가공하지 않고 그대로 보관한다 (기준이 바뀌면 다시 쓴다) */
export async function getRepo(repo: string): Promise<GitHubResult<Record<string, unknown>>> {
  const result = await request<Record<string, unknown>>(`/repos/${repo}`);
  if (!result.ok) return result;
  if (!result.value || typeof result.value.id !== "number"
    || !Number.isSafeInteger(result.value.id) || result.value.id <= 0) {
    return { ok: false, error: { kind: "invalid_response" } };
  }
  return result;
}

/** 검색 한 페이지의 최대 건수 */
export const SEARCH_PER_PAGE = 100;

/**
 * 검색이 돌려주는 최대 건수(1000건 = 10페이지).
 * 그 뒤 페이지는 422로 거절되므로 신호 하나를 여기까지만 본다.
 */
export const MAX_SEARCH_PAGES = 10;

export type CommitSearchResult = {
  items: { repository: { full_name: string }; sha?: string; html_url?: string; commit?: { message?: string } }[];
  incomplete_results?: boolean;
  total_count?: number;
};
export type RepositorySearchResult = {
  items: { full_name: string; homepage: string | null }[];
  incomplete_results?: boolean;
  total_count?: number;
};

/**
 * 커밋 검색.
 *
 * 정렬은 표본 분포를 크게 바꾼다 — 실측으로 같은 100건에서 고유 레포가 relevance 63개,
 * recent 2개였다. recent는 방금 활발히 커밋한 소수 레포에 몰린다.
 */
export async function searchCommits(params: {
  query: string;
  page: number;
  sort: "relevance" | "recent";
}): Promise<GitHubResult<CommitSearchResult>> {
  const search = new URLSearchParams({
    q: params.query,
    per_page: String(SEARCH_PER_PAGE),
    page: String(params.page),
  });
  // relevance는 정렬 파라미터를 붙이지 않는 것이 기본값이다
  if (params.sort === "recent") {
    search.set("sort", "committer-date");
    search.set("order", "desc");
  }
  return request<CommitSearchResult>(`/search/commits?${search}`);
}

/**
 * 레포 검색.
 *
 * 커밋 검색과 달리 결과에 레포 메타(homepage)가 실려 온다. 배포 URL이 없는 레포를 프론티어에
 * 넣기 전에 거를 수 있다는 뜻이다. 정렬 "recent"는 저장소 갱신(updated) 날짜 내림차순이다.
 */
export async function searchRepositories(params: {
  query: string;
  page: number;
  sort: "relevance" | "recent";
}): Promise<GitHubResult<RepositorySearchResult>> {
  const search = new URLSearchParams({
    q: params.query,
    per_page: String(SEARCH_PER_PAGE),
    page: String(params.page),
  });
  if (params.sort === "recent") {
    search.set("sort", "updated");
    search.set("order", "desc");
  }
  return request<RepositorySearchResult>(`/search/repositories?${search}`);
}

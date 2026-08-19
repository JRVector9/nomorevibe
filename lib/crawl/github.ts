import { logger } from "@/lib/observability/logger";
import { readBodyStrictlyCapped } from "@/lib/net/fetch";

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

export type GitHubFailure =
  | { kind: "rate_limited"; resetAt: Date | null }
  | { kind: "not_found" }
  | { kind: "transport" }
  | { kind: "invalid_response" }
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

/** 토큰이 없으면 시간당 60회라 수집이 성립하지 않는다 — 조용히 도는 것보다 멈추는 게 낫다 */
function requireToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN이 없습니다 — 수집기는 인증된 토큰이 필요합니다");
  return token;
}

export async function githubRequest<T>(
  path: string,
  conditional: ConditionalRequest = {},
): Promise<GitHubHttpResult<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${requireToken()}`,
    Accept: "application/vnd.github+json",
    "user-agent": "NoMoreVibe/1.0 (+https://nomorevibe.app)",
  };
  if (conditional.etag) headers["If-None-Match"] = conditional.etag;
  if (conditional.lastModified) headers["If-Modified-Since"] = conditional.lastModified;

  let res: Response;
  try {
    res = await fetch(`${API_ORIGIN}${path}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, error: { kind: "transport" } };
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

  /**
   * 한도 소진은 403이나 429로 온다. 남은 호출 수가 0이면 한도이고, 아니면 다른 이유의
   * 403(차단된 레포 등)이므로 구분한다.
   */
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (res.status === 429 || (res.status === 403 && remaining === "0")) {
    const resetSeconds = Number(res.headers.get("x-ratelimit-reset"));
    const resetAt = Number.isFinite(resetSeconds) && resetSeconds > 0 ? new Date(resetSeconds * 1000) : null;
    logger.warn("github.rate_limited", { path, resetAt });
    return { ok: false, error: { kind: "rate_limited", resetAt } };
  }

  return { ok: false, error: { kind: "http", status: res.status } };
}

async function request<T>(path: string): Promise<GitHubResult<T>> {
  const result = await githubRequest<T>(path);
  if (!result.ok) return result;
  if (result.status === 200) return { ok: true, value: result.value };
  return { ok: false, error: { kind: "http", status: 304 } };
}

/** 판정에 쓰는 레포 메타 원본. 가공하지 않고 그대로 보관한다 (기준이 바뀌면 다시 쓴다) */
export async function getRepo(repo: string): Promise<GitHubResult<Record<string, unknown>>> {
  return request<Record<string, unknown>>(`/repos/${repo}`);
}

/** 검색 한 페이지의 최대 건수 */
export const SEARCH_PER_PAGE = 100;

/**
 * 검색이 돌려주는 최대 건수(1000건 = 10페이지).
 * 그 뒤 페이지는 422로 거절되므로 신호 하나를 여기까지만 본다.
 */
export const MAX_SEARCH_PAGES = 10;

export type CommitSearchResult = { items: { repository: { full_name: string } }[] };

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

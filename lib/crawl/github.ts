import { logger } from "@/lib/observability/logger";

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

export type GitHubFailure =
  | { kind: "rate_limited"; resetAt: Date | null }
  | { kind: "not_found" }
  | { kind: "http"; status: number };

export type GitHubResult<T> = { ok: true; value: T } | { ok: false; error: GitHubFailure };

/** 토큰이 없으면 시간당 60회라 수집이 성립하지 않는다 — 조용히 도는 것보다 멈추는 게 낫다 */
function requireToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN이 없습니다 — 수집기는 인증된 토큰이 필요합니다");
  return token;
}

async function request<T>(path: string): Promise<GitHubResult<T>> {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    headers: {
      Authorization: `Bearer ${requireToken()}`,
      Accept: "application/vnd.github+json",
      "user-agent": "NoMoreVibe/1.0 (+https://nomorevibe.app)",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.ok) return { ok: true, value: (await res.json()) as T };

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

/** 판정에 쓰는 레포 메타 원본. 가공하지 않고 그대로 보관한다 (기준이 바뀌면 다시 쓴다) */
export async function getRepo(repo: string): Promise<GitHubResult<Record<string, unknown>>> {
  return request<Record<string, unknown>>(`/repos/${repo}`);
}

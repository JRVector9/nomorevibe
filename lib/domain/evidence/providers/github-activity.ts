import type { GitHubHttpResult } from "@/lib/crawl/github";

export type PushActivity = { count: number; since: string; observedAt: string };
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const PAGE_LIMIT = 10;

/** 공개 저장소의 7일 푸시를 끝까지 읽었을 때만 횟수를 반환한다. */
export async function fetchPushActivity(
  request: (path: string) => Promise<GitHubHttpResult<unknown>>,
  repositoryKey: string,
  now: Date,
  hasBudget: () => boolean,
  repositoryId?: number,
): Promise<PushActivity | null> {
  const until = now.getTime();
  if (!Number.isFinite(until) || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repositoryKey)) return null;
  const since = until - WEEK_MS;
  const resource = `/repos/${repositoryKey}/activity`;
  const numericResource = typeof repositoryId === "number" && Number.isSafeInteger(repositoryId) && repositoryId > 0
    ? `/repositories/${repositoryId}/activity` : null;
  let path = `${resource}?time_period=week&per_page=100&direction=desc`;
  const visited = new Set<string>();
  const pushes = new Set<number>();
  for (let page = 0; page < PAGE_LIMIT; page++) {
    if (!hasBudget() || visited.has(path)) return null;
    visited.add(path);
    let result: GitHubHttpResult<unknown>;
    try {
      result = await request(path);
    } catch {
      return null;
    }
    if (!result.ok || result.status !== 200 || !Array.isArray(result.value)) return null;
    for (const event of result.value) {
      if (!event || typeof event !== "object" || !Number.isSafeInteger(event.id)
        || typeof event.activity_type !== "string" || typeof event.timestamp !== "string"
        || !/^\d{4}-\d{2}-\d{2}T/.test(event.timestamp)) return null;
      const at = Date.parse(event.timestamp);
      if (!Number.isFinite(at)) return null;
      if ((event.activity_type === "push" || event.activity_type === "force_push") && at >= since && at <= until) {
        pushes.add(event.id);
      }
    }
    const next = result.link?.split(",").find(part => /rel="next"/.test(part));
    if (!next) return { count: pushes.size, since: new Date(since).toISOString(), observedAt: now.toISOString() };
    const target = next.match(/<([^>]+)>/)?.[1];
    if (!target) return null;
    try {
      const url = new URL(target);
      // 다른 저장소나 외부 주소의 커서는 인증된 요청으로 따라가지 않는다.
      if (url.origin !== "https://api.github.com" || (url.pathname !== resource && url.pathname !== numericResource)
        || url.username || url.password || url.hash) return null;
      path = url.pathname + url.search;
    } catch {
      return null;
    }
  }
  // 페이지 상한이나 작업 시간 때문에 중단한 집계를 완전한 횟수로 보이지 않는다.
  return null;
}

import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { getSettings } from "@/lib/crawl/settings";
import { parseFeed } from "@/lib/domain/evidence/providers/feeds";
import { fetchCapped, type CappedFetchResult } from "@/lib/net/fetch";
import { feedCandidates, npmCandidates, pageCandidate, sitemapChanges, sitemapUrls, type NewsCandidate } from "./normalize";
import { insertNewsItems } from "./repository";
import { NEWS_SOURCES, type NewsSource } from "./sources";

/**
 * AI 소식 수집. 한 시간에 한 번, 켜진 공식 출처를 모두 한 바퀴 돈다.
 *
 * 출처 하나가 실패해도 나머지는 계속한다 — 실패는 커서에 출처별로 남아 관리자 화면에 보인다.
 */
const CONCURRENCY = 4;
/** OpenAI 소식 피드 720KB, Qwen Code 릴리스 508KB (2026-09-11 실측) */
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
/** 사이트맵에서 새 글을 찾았을 때 한 회차에 여는 페이지 수 */
const PAGES_PER_SOURCE = 5;
const FEED_ACCEPT = "application/atom+xml, application/rss+xml, application/xml, text/xml";

export type NewsSourceState = {
  checkedAt: string;
  ok: boolean;
  error?: string;
  /** 이번 회차에 출처가 준 글 수 (거른 뒤) */
  found: number;
  /** 그중 처음 본 것 */
  added: number;
  /** sitemap: 이미 본 주소. 없으면 아직 기준선을 잡지 않은 것 */
  seen?: string[];
};
export type NewsCursor = { sources: Record<string, NewsSourceState> };

type Request = (url: string, options: { maxBytes: number; headers?: Record<string, string> }) => Promise<CappedFetchResult>;
type Collected = { ok: true; candidates: NewsCandidate[]; seen?: string[] } | { ok: false; error: string; seen?: string[] };

function failure(result: CappedFetchResult): string | null {
  if (!result.ok) return result.reason === "http" ? `http_${result.status}` : result.reason;
  return result.status === 200 ? null : `http_${result.status}`;
}

async function collectFeed(source: NewsSource, request: Request, now: Date): Promise<Collected> {
  const response = await request(source.url, { maxBytes: MAX_FEED_BYTES, headers: { accept: FEED_ACCEPT } });
  const error = failure(response);
  if (error || !response.ok) return { ok: false, error: error ?? "fetch_failed" };
  try {
    return { ok: true, candidates: feedCandidates(source, parseFeed(response.body.toString("utf8"), response.finalUrl, MAX_FEED_BYTES), now) };
  } catch (parseError) {
    return { ok: false, error: parseError instanceof Error ? parseError.message : "malformed feed" };
  }
}

async function collectNpm(source: NewsSource, request: Request, now: Date): Promise<Collected> {
  const response = await request(source.url, { maxBytes: MAX_FEED_BYTES, headers: { accept: "application/json" } });
  const error = failure(response);
  if (error || !response.ok) return { ok: false, error: error ?? "fetch_failed" };
  try {
    return { ok: true, candidates: npmCandidates(source, JSON.parse(response.body.toString("utf8")), now) };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

/**
 * 사이트맵에 새로 생긴 주소를 열어 제목을 읽는다.
 *
 * 연 페이지는 본 것으로 친다. 열지 못한 것은 다음 회차에 다시 연다 — 다만 4xx 는 영영
 * 열리지 않을 것이라 본 것으로 치고 넘어간다(한 회차에 여는 수가 정해져 있어 막히면 뒤가 밀린다).
 */
async function collectSitemap(source: NewsSource, previous: NewsSourceState | undefined, request: Request, now: Date): Promise<Collected> {
  const response = await request(source.url, { maxBytes: MAX_FEED_BYTES, headers: { accept: "application/xml, text/xml" } });
  const error = failure(response);
  if (error || !response.ok) return { ok: false, error: error ?? "fetch_failed", seen: previous?.seen };
  const urls = sitemapUrls(response.body.toString("utf8"), source);
  // 글이 하나도 없으면 사이트맵 구조가 바뀐 것이다. 빈 기준선을 잡으면 복구될 때 옛 글이 새 글로 쏟아진다
  if (!urls.length) return { ok: false, error: "empty_sitemap", seen: previous?.seen };

  const { fresh, rebaseline } = sitemapChanges(urls, previous?.seen);
  if (rebaseline) return { ok: true, candidates: [], seen: urls };

  const opened = new Set<string>();
  const candidates: NewsCandidate[] = [];
  for (const url of fresh.slice(0, PAGES_PER_SOURCE)) {
    const page = await request(url, { maxBytes: MAX_PAGE_BYTES, headers: { accept: "text/html" } });
    if (page.ok && page.status === 200) {
      const candidate = pageCandidate(source, url, page.body.toString("utf8"), now);
      if (candidate) candidates.push(candidate);
      opened.add(url);
    } else if (!page.ok && page.reason === "http" && page.status >= 400 && page.status < 500) {
      opened.add(url);
    }
  }
  const known = new Set(previous?.seen);
  // 사이트맵에서 빠진 주소는 버린다 — 기준선이 사이트맵 크기를 넘어 자라지 않는다
  return { ok: true, candidates, seen: urls.filter((url) => known.has(url) || opened.has(url)) };
}

async function collect(source: NewsSource, previous: NewsSourceState | undefined, request: Request, now: Date): Promise<Collected> {
  if (source.kind === "sitemap") return collectSitemap(source, previous, request, now);
  if (source.kind === "npm") return collectNpm(source, request, now);
  return collectFeed(source, request, now);
}

export async function refreshNews(
  ctx: JobContext<NewsCursor>,
  request: Request = fetchCapped,
): Promise<JobOutcome<NewsCursor>> {
  const settings = await getSettings();
  const disabled = new Set(settings.news.disabledSources);
  const queue = NEWS_SOURCES.filter((source) => !disabled.has(source.key));
  const cursor: NewsCursor = { sources: { ...(ctx.cursor?.sources ?? {}) } };
  let added = 0;
  let failed = 0;
  let unfinished = false;

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let source = queue.shift(); source; source = queue.shift()) {
      if (!ctx.hasBudget()) {
        unfinished = true;
        return;
      }
      const previous = cursor.sources[source.key];
      const now = new Date();
      const result = await collect(source, previous, request, now)
        .catch((error: unknown): Collected => ({ ok: false, error: error instanceof Error ? error.message : "collect_failed", seen: previous?.seen }));
      const inserted = result.ok ? await insertNewsItems(result.candidates, settings.news.autoApprove) : 0;
      added += inserted;
      if (!result.ok) failed += 1;
      cursor.sources[source.key] = {
        checkedAt: now.toISOString(),
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error.slice(0, 120) }),
        found: result.ok ? result.candidates.length : 0,
        added: inserted,
        ...(result.seen ? { seen: result.seen } : {}),
      };
    }
  }));

  ctx.log("news.refreshed", { added, failed, autoApprove: settings.news.autoApprove, unfinished });
  return { done: !unfinished, cursor };
}

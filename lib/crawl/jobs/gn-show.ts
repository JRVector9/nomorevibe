import { setTimeout as sleep } from "node:timers/promises";
import { getSettings } from "@/lib/crawl/settings";
import { enqueueDiscoveryBatch } from "@/lib/crawl/shared-discovery";
import { recordDiscoveryProgress } from "@/lib/crawl/discovery-progress";
import { entryRepository, feedArticleUrl, feedDiscoverySource, feedSources, GEEKNEWS_FEED, pageRepository, parseFeedEntries, selectFeedArticles,
  SHOW_GN_FEED, type FeedSource } from "@/lib/crawl/feed-sources";
import type { FeedPageTitleRule } from "@/lib/crawl/feed-source-schema";
import { fetchCapped, type CappedRequest } from "@/lib/net/fetch";
import type { JobContext, JobDegraded, JobOutcome } from "@/lib/jobs/runner";

/**
 * 글 목록 수집(잡 gn-show-seed) — 켜진 글 목록 수집원(lib/crawl/feed-sources.ts)을 차례로 읽어 저장소가 있는 글만 공통 관문으로 프론티어에 넣는다.
 * 첫 수집원은 GeekNews Show GN 이다(2026-11-11). Show GN 만 켜져 있으면 요청·커서·신호·로그가 예전과 같다(tests/crawl-gn-show.test.ts).
 * 화면에서 더한 수집원의 상태는 커서의 feeds.<id> 에 따로 있다 — Show GN 의 칸(seenUntil·pending)을 건드리지 않는다.
 */
export { GEEKNEWS_FEED };
export const MAX_TOPICS_PER_TICK = 20;
const REQUEST_INTERVAL_MS = 1_000;
const MAX_BYTES = 512 * 1024;
/** 화면에서 더한 수집원이 기억하는 본 글 주소 — 피드는 200개를 넘지 않는다 */
const SEEN_MAX = 500;
type PendingTopic = { id: string; repo?: string };
/** 화면에서 더한 수집원 하나의 상태 — 본 글 주소·아직 넣지 못한 글·마지막으로 피드를 읽은 시각 */
export type FeedCursorState = { seen: string[]; pending: PendingTopic[]; readAt?: string };
export type ShowGnCursor = {
  /** RSS에서 확인한 번호의 상한. 실패·상한 초과·수용 대기는 pending에 따로 남긴다 */
  seenUntil: number;
  pending: PendingTopic[];
  /** 화면에서 더한 글 목록 수집원의 상태(수집원 열쇠마다). 그런 수집원이 없으면 칸이 없다 */
  feeds?: Record<string, FeedCursorState>;
};

/** RSS에는 제품 주소가 없다. 외부 주소를 따라가지 않고 GeekNews 번호만 읽는다 */
export function showGnTopicIds(xml: string): string[] {
  return selectFeedArticles(parseFeedEntries(xml), SHOW_GN_FEED).articles.map(article => article.id);
}

/** 제목 영역과 작성자 본문만 본다. 댓글/추천/스크립트의 GitHub 링크는 후보 근거가 아니다 */
export function showGnRepository(html: string): { ok: true; repo: string | null } | { ok: false; reason: string } {
  return pageRepository(html, SHOW_GN_FEED.link as FeedPageTitleRule);
}

const failedEvent = (source: FeedSource) => source.legacy ? "crawl.show_gn_failed" : "crawl.feed_failed";
const seededEvent = (source: FeedSource) => source.legacy ? "crawl.show_gn_seeded" : "crawl.feed_seeded";
/** 화면에서 더한 수집원은 로그에 열쇠를 싣는다(관측 누적은 수만 더한다) */
const tagged = (source: FeedSource, fields: Record<string, unknown>) => source.legacy ? fields : { source: source.id, ...fields };

/** Show HN과 같은 job cursor/설정/프론티어. 수용 한도는 한국어 발굴과 같은 원자적 관문을 쓴다 */
export async function seedFromShowGN(ctx: JobContext<ShowGnCursor>, request?: CappedRequest): Promise<JobOutcome<ShowGnCursor>> {
  const settings = await getSettings();
  const sources = settings.enabled ? feedSources(settings.discover).filter(source => source.enabled) : [];
  if (!sources.length) return { done: true };
  const cursor: ShowGnCursor = ctx.cursor ? structuredClone(ctx.cursor) : { seenUntil: 0, pending: [] };
  // 지운 수집원의 상태는 버린다 — 남은 것이 없으면 칸을 없앤다(Show GN 만 있으면 커서 모양이 예전과 같다)
  if (cursor.feeds) {
    const configured = new Set((settings.discover.feeds ?? []).map(feed => feed.id));
    for (const id of Object.keys(cursor.feeds)) if (!configured.has(id)) delete cursor.feeds[id];
    if (!Object.keys(cursor.feeds).length) delete cursor.feeds;
  }
  let requests = 0;
  const load = async (url: string) => {
    if (requests) await sleep(REQUEST_INTERVAL_MS, undefined, { signal: ctx.signal });
    requests++;
    return fetchCapped(url, { maxBytes: MAX_BYTES, timeoutMs: Math.max(1, Math.min(10_000, (ctx.deadlineAt ?? Infinity) - Date.now())),
      signal: ctx.signal, request });
  };
  if (!ctx.hasBudget() || ctx.signal?.aborted) return { done: false, cursor };
  const stateOf = (source: FeedSource): { pending: PendingTopic[] } => source.legacy ? cursor
    : ((cursor.feeds ??= {})[source.id] ??= { seen: [], pending: [] });
  const readAt = (source: FeedSource) => source.legacy ? null : cursor.feeds?.[source.id]?.readAt ?? null;
  // Show GN 이 먼저, 그다음 오래 읽지 않은 수집원부터(같으면 우선순위)
  const ordered = [...sources].sort((a, b) => Number(b.legacy) - Number(a.legacy)
    || (Date.parse(readAt(a) ?? "") || 0) - (Date.parse(readAt(b) ?? "") || 0) || b.priority - a.priority);
  let feedFailure: JobDegraded | undefined;
  let failed = 0, lastFailure: string | undefined;
  let blocked = false, unfinished = false;
  for (const source of ordered) {
    if (blocked || !ctx.hasBudget() || ctx.signal?.aborted) { unfinished = true; break; }
    const result = await readSource(source);
    if (result.feedFailure) feedFailure ??= result.feedFailure;
    failed += result.failed; lastFailure = result.lastFailure ?? lastFailure;
    if (result.blocked) blocked = true;
  }
  const drained = sources.every(source => stateOf(source).pending.length === 0);
  if (feedFailure) return { done: false, cursor, degraded: feedFailure };
  return { done: drained && !unfinished, cursor, ...(failed ? { degraded: { code: "topic_failed", cause: lastFailure } } : {}) };

  async function readSource(source: FeedSource): Promise<{ feedFailure?: JobDegraded; failed: number; lastFailure?: string; blocked: boolean }> {
    const state = stateOf(source);
    const before = requests;
    let examined = 0, discovered = 0, existing = 0, skippedNoRepo = 0, sourceFailed = 0, returned = 0;
    let sourceLastFailure: string | undefined;
    let blockedBy: "queue_cap" | "rate_cap" | "measurement_unknown" | undefined;
    const last = readAt(source);
    const due = source.intervalMinutes === null || !last || Date.now() - Date.parse(last) >= source.intervalMinutes * 60_000 - 60_000;
    if (due) {
      const feed = await load(source.url);
      if (!feed.ok || feed.status !== 200) {
        const reason = feed.ok ? `http_${feed.status}` : feed.reason === "http" ? `http_${feed.status}` : feed.reason;
        ctx.log(failedEvent(source), tagged(source, { reason }));
        return { feedFailure: { code: "feed_fetch_failed", cause: reason }, failed: 0, blocked: false };
      }
      let articles: ReturnType<typeof selectFeedArticles>["articles"];
      try { articles = selectFeedArticles(parseFeedEntries(feed.body.toString("utf8")), source).articles; }
      catch {
        ctx.log(failedEvent(source), tagged(source, { reason: "invalid_feed" }));
        return { feedFailure: { code: "invalid_feed" }, failed: 0, blocked: false };
      }
      returned = articles.length;
      const pendingIds = new Set(state.pending.map(item => item.id));
      if (source.legacy) {
        cursor.pending.push(...articles.filter(article => Number(article.id) > cursor.seenUntil && !pendingIds.has(article.id)).map(article => ({ id: article.id })));
        cursor.seenUntil = Math.max(cursor.seenUntil, ...articles.map(article => Number(article.id)));
      } else {
        const own = state as FeedCursorState;
        const seen = new Set(own.seen);
        for (const article of articles) {
          if (seen.has(article.id) || pendingIds.has(article.id)) continue;
          seen.add(article.id); own.seen.push(article.id);
          if (source.link.kind === "page-title") { own.pending.push({ id: article.id }); continue; }
          // 피드 항목의 링크가 제품 링크면 글 페이지를 읽지 않는다 — 항목을 읽을 때 저장소를 정한다
          examined++;
          const repo = entryRepository(article);
          if (repo) own.pending.push({ id: article.id, repo }); else skippedNoRepo++;
        }
        own.seen = own.seen.slice(-SEEN_MAX);
        own.readAt = new Date().toISOString();
      }
      await ctx.save(cursor);
    }
    // 실패한 글 하나가 뒤 글을 막지 않는다. RSS에서 사라진 실패 글도 다음 틱에 재시도한다.
    for (const item of [...state.pending].slice(0, MAX_TOPICS_PER_TICK)) {
      if (!ctx.hasBudget() || ctx.signal?.aborted || ctx.deadlineAt !== undefined && Date.now() + REQUEST_INTERVAL_MS >= ctx.deadlineAt) break;
      if (!item.repo) {
        if (source.link.kind !== "page-title") { state.pending = state.pending.filter(row => row.id !== item.id); continue; }
        const page = await load(feedArticleUrl(source, item.id));
        const parsed = page.ok && page.status === 200 ? pageRepository(page.body.toString("utf8"), source.link) : null;
        const reason = parsed && !parsed.ok ? parsed.reason : !page.ok
          ? page.reason === "http" ? `http_${page.status}` : page.reason : page.status !== 200 ? `http_${page.status}` : undefined;
        if (!parsed?.ok) {
          sourceFailed++; sourceLastFailure = reason;
          ctx.log(failedEvent(source), tagged(source, { topicId: item.id, reason }));
          state.pending = [...state.pending.filter(row => row.id !== item.id), item];
          await ctx.save(cursor);
          continue;
        }
        examined++;
        if (!parsed.repo) {
          skippedNoRepo++;
          state.pending = state.pending.filter(row => row.id !== item.id);
          await ctx.save(cursor);
          continue;
        }
        item.repo = parsed.repo;
        // 수용 대기나 중단에도 이미 읽은 페이지를 다시 요청하지 않는다.
        await ctx.save(cursor);
      }
      const result = await enqueueDiscoveryBatch([{ repo: item.repo, signal: source.name, builder: null,
        priority: source.priority, discoverySource: feedDiscoverySource(source, item.id) }], settings.discover, ctx.lease);
      if (!result.processed) { blockedBy = result.blockedBy; break; }
      discovered += result.added; existing += result.processed - result.added;
      state.pending = state.pending.filter(row => row.id !== item.id);
      await ctx.save(cursor);
    }
    const drained = state.pending.length === 0;
    const sourceRequests = requests - before;
    if (due || sourceRequests || discovered || existing) {
      await recordDiscoveryProgress({ worker: process.env.SERVICE_INSTANCE_ID ?? "home-crawler", lane: source.legacy ? "geeknews" : "feed", signal: source.name,
        // RSS는 과거 구간 전체의 완료를 보장하지 않으므로 completedThrough를 쓰지 않는다.
        counts: { searchRequests: sourceRequests, pagesVisited: examined, returned, examined, discovered, existing, incomplete: sourceFailed },
        blockedBy: blockedBy ?? (sourceFailed ? "api_wait" : null) });
      ctx.log(seededEvent(source), tagged(source, { discovered, existing, examined, skippedNoRepo, failed: sourceFailed, requests: sourceRequests,
        pending: state.pending.length, drained }));
    }
    return { failed: sourceFailed, lastFailure: sourceLastFailure, blocked: blockedBy !== undefined };
  }
}

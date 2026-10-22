import { getSettings } from "@/lib/crawl/settings";
import { fetchCapped, type CappedRequest } from "@/lib/net/fetch";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { blueskyAtUri } from "./bluesky-link";
import {
  BLUESKY_BOT_POSTS, BLUESKY_LOOKUP_BATCH, BLUESKY_SEARCH_LIMIT, BLUESKY_TALK_WINDOW_MS, blueskyLookupUrl, blueskyResponseSchema, blueskySearchUrl,
  nextUntil, readBlueskyPosts, type BlueskyResponse, type BlueskyTalkPost,
} from "./bluesky-talk-source";
import {
  blueskyPostsToRecheck, heavyBlueskyAccounts, holdBotPosts, markBlueskyPostsGone, purgeGoneBlueskyPosts, recordBlueskyPosts,
} from "./bluesky-talk-store";
import { SOCIAL_RETENTION_MS } from "./hn-talk";
import { deleteExpiredSocialPosts } from "./repository";
import { TALK_VISIBLE_MS } from "./talk-score";

/**
 * Bluesky 화제 수집 — 최근 72시간 안에 GitHub 를 가리킨 Bluesky 게시물을 반응 수와 함께 모두 남긴다(SNS 화제, HN 과 같은 창).
 *
 * 2시간마다 한 회차, 요청은 회차당 BLUESKY_MAX_REQUESTS 번까지·요청 사이 0.5초 이상:
 * 1. 새 글 — 최신 한 쪽(q=*)을 읽고, 지난 회차 뒤로 100건이 넘게 올라왔으면 시간 창(q=github.com)을 밀어 내려간다(최대 10쪽).
 *    장애 뒤라 10쪽으로 모자라면 그 앞은 건너뛴다(truncated) — 아래 반응 큰 글 읽기가 그 사이의 반응 큰 글을 채운다.
 * 2. 반응 큰 글 — 창을 하루씩 셋으로 나눠 반응순(sort=top) 100건씩. 점수가 오르는 글을 다시 읽는다.
 * 3. 다시 묻기 — 이번에 돌아오지 않은 글을 getPosts 로 25건씩(최대 12번). 제품에 이어진 보이는 글(7일)을 먼저 묻는다.
 *    돌아오지 않으면 지워진 것으로 내리고(원문 삭제 존중), 내린 지 7일이 지나면 행째 지운다.
 * 4. 봇 — 창 안에 GitHub 링크 글이 15개 이상인 계정의 글을 숨긴다(bot_suspected). 라벨 붙은 글은 기록할 때 숨긴다(label:<값>).
 *
 * 저장은 하되 화면에는 보이는 글만 오른다: 봇·라벨 숨김은 관리자 /admin/talk "수집한 글 전부"에 까닭과 함께 남는다.
 */
/** 회차당 요청 상한 — 새 글 10 + 반응 큰 글 3 + 다시 묻기 12 = 25, 여유 5 */
export const BLUESKY_MAX_REQUESTS = 30;
const DISCOVERY_PAGES = 10;
const TOP_SLICES = 3;
const LOOKUP_REQUESTS = 12;
/** 요청 사이 최소 간격 — 초당 2번을 넘지 않는다 */
export const BLUESKY_REQUEST_GAP_MS = 500;
/** 지난 회차 끝과 겹쳐 읽는 폭 — 색인이 늦은 글을 놓치지 않게 */
const OVERLAP_MS = 10 * 60_000;
/** 원문 삭제로 내린 글을 행째 지우기까지 */
export const BLUESKY_GONE_PURGE_MS = 7 * 86_400_000;
/** 100건 한 쪽이 실측 40~170KB — 큰 카드·인용이 붙어도 넘지 않는 상한 */
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
/** 우리 쪽을 밝히는 평범한 User-Agent(연락처는 사이트 주소) */
export const BLUESKY_USER_AGENT = "nomorevibe/1.0 (+https://nomorevibe.com)";
/** 창·봇 기준은 관리자 화면 문구(talk-reasons.ts)도 읽어 bluesky-talk-source.ts 에 둔다 */
export { BLUESKY_BOT_POSTS, BLUESKY_TALK_WINDOW_MS };

export type BlueskyTalkCursor = { lastRunAt: string; /** 이 시각까지 올라온 새 글은 읽었다 */ through: string };
type Fetched = { ok: true; value: BlueskyResponse } | { ok: false; reason: string };
export type BlueskyTalkOptions = { request?: CappedRequest; now?: () => Date; sleep?: (ms: number) => Promise<void> };

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** 이 쪽 뒤에 글이 더 있나 — 검색은 가린 글을 빼고 주므로 쪽이 덜 차도 cursor 가 있으면 더 있다 */
const more = (response: BlueskyResponse) => Boolean(response.cursor) || response.posts.length >= BLUESKY_SEARCH_LIMIT;

export async function collectBlueskyTalk(ctx: JobContext<BlueskyTalkCursor>, options: BlueskyTalkOptions = {}): Promise<JobOutcome<BlueskyTalkCursor>> {
  const settings = await getSettings();
  if (!settings.enabled) return { done: true };
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? wait;

  const startedAt = now();
  const since = new Date(startedAt.getTime() - BLUESKY_TALK_WINDOW_MS);
  const previous = ctx.cursor?.through ? Date.parse(ctx.cursor.through) : NaN;
  const from = new Date(Math.max(since.getTime(), Number.isFinite(previous) ? previous - OVERLAP_MS : since.getTime()));

  let requests = 0, lastRequestAt = 0, rateLimited = false;
  /** 상한·간격·크기·시간 제한을 지키는 요청 하나 */
  async function fetchBluesky(url: string): Promise<Fetched> {
    if (rateLimited) return { ok: false, reason: "rate_limited" };
    if (requests >= BLUESKY_MAX_REQUESTS) return { ok: false, reason: "request_cap" };
    const gap = lastRequestAt + BLUESKY_REQUEST_GAP_MS - Date.now();
    if (requests > 0 && gap > 0) await sleep(gap);
    requests += 1;
    lastRequestAt = Date.now();
    const response = await fetchCapped(url, {
      maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS, request: options.request, signal: ctx.signal,
      headers: { "user-agent": BLUESKY_USER_AGENT, accept: "application/json" },
    });
    if (!response.ok) {
      if (response.reason === "http" && response.status === 429) rateLimited = true;
      return { ok: false, reason: response.reason === "http" ? `http_${response.status}` : response.reason };
    }
    if (response.status !== 200) return { ok: false, reason: `http_${response.status}` };
    try {
      const parsed = blueskyResponseSchema.safeParse(JSON.parse(response.body.toString("utf8")));
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: "invalid_response" };
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  }

  const found = new Map<string, BlueskyTalkPost>();
  let skipped = 0, pages = 0;
  const keep = (response: BlueskyResponse) => {
    const read = readBlueskyPosts(response, startedAt);
    skipped += read.skipped;
    for (const post of read.posts) found.set(post.externalId, post);
    return read.posts;
  };

  // 1. 새 글 — 최신 한 쪽, 모자라면 시간 창을 민다
  let discovered = false, truncated = false;
  /** 새 글을 읽지 못한 까닭 — 회차를 제 일 못 함으로 남긴다 */
  let discoveryFailure: string | null = null;
  const latest = await fetchBluesky(blueskySearchUrl({ sort: "latest" }));
  if (!latest.ok) {
    ctx.log("social.bluesky_talk_failed", { reason: latest.reason, stage: "latest", page: 0 });
    discoveryFailure = `최신 ${latest.reason}`;
  } else {
    pages += 1;
    const first = keep(latest.value);
    let until = nextUntil(first, null);
    // 다음 쪽 표시(cursor)가 없거나 지난 회차 끝까지 내려왔으면 새 글을 다 읽었다
    let covered = !more(latest.value) || !until || until <= from;
    let failed = false;
    while (!covered && pages < DISCOVERY_PAGES && ctx.hasBudget()) {
      const page = await fetchBluesky(blueskySearchUrl({ sort: "latest", since: from, until: until! }));
      if (!page.ok) {
        // 상한에 닿은 것은 오류가 아니다 — 남은 앞쪽을 건너뛴 회차(truncated)로 남는다
        if (page.reason === "request_cap") break;
        ctx.log("social.bluesky_talk_failed", { reason: page.reason, stage: "window", page: pages });
        discoveryFailure = `시간 창 ${page.reason} (${pages + 1}쪽)`;
        failed = true;
        break;
      }
      pages += 1;
      const posts = keep(page.value);
      const next = nextUntil(posts, until);
      covered = !more(page.value) || !next || next <= from;
      until = next;
    }
    discovered = !failed;
    truncated = !covered;
  }

  // 2. 반응 큰 글 — 하루씩 셋. 실패해도 다음 단계로 간다
  for (let slice = 0; slice < TOP_SLICES && ctx.hasBudget(); slice++) {
    const until = new Date(startedAt.getTime() - slice * 86_400_000);
    const top = await fetchBluesky(blueskySearchUrl({ sort: "top", since: new Date(Math.max(since.getTime(), until.getTime() - 86_400_000)), until }));
    if (!top.ok) {
      ctx.log("social.bluesky_talk_failed", { reason: top.reason, stage: "top", page: slice });
      break;
    }
    keep(top.value);
  }

  const posts = [...found.values()];
  const recorded = await recordBlueskyPosts(posts, startedAt, ctx.lease);

  // 3. 다시 묻기 — 검색이 막혀도 지운 글은 내린다
  const missing = await blueskyPostsToRecheck(since, new Date(startedAt.getTime() - TALK_VISIBLE_MS), startedAt, LOOKUP_REQUESTS * BLUESKY_LOOKUP_BATCH);
  let rechecked = 0, gone = 0, lookupFailed = false, lookupReason: string | null = null;
  const back: BlueskyTalkPost[] = [];
  for (let index = 0; index < missing.length; index += BLUESKY_LOOKUP_BATCH) {
    if (!ctx.hasBudget()) break;
    const batch = missing.slice(index, index + BLUESKY_LOOKUP_BATCH)
      .map(row => ({ id: row.id, uri: blueskyAtUri(row.external_id) }))
      .filter((row): row is { id: number; uri: string } => row.uri !== null);
    if (!batch.length) continue;
    const result = await fetchBluesky(blueskyLookupUrl(batch.map(row => row.uri)));
    if (!result.ok) {
      if (result.reason !== "request_cap") ctx.log("social.bluesky_talk_lookup_failed", { reason: result.reason });
      lookupFailed = result.reason !== "request_cap";
      lookupReason = result.reason;
      break;
    }
    rechecked += batch.length;
    const returned = readBlueskyPosts(result.value, startedAt).posts;
    back.push(...returned);
    // 모양이 틀려 읽지 못한 글도 돌아온 것이다 — at-uri 로 대조한다
    const alive = new Set(result.value.posts.map(raw => (raw as { uri?: unknown })?.uri).filter((uri): uri is string => typeof uri === "string"));
    gone += await markBlueskyPostsGone(batch.filter(row => !alive.has(row.uri)).map(row => row.id), startedAt, ctx.lease);
  }
  const refreshed = await recordBlueskyPosts(back, startedAt, ctx.lease);

  // 4. 봇 — 이번에 넣은 글까지 센다
  const heavy = await heavyBlueskyAccounts(since, BLUESKY_BOT_POSTS);
  const bots = await holdBotPosts(heavy, since, startedAt, ctx.lease);

  const expired = await deleteExpiredSocialPosts(new Date(startedAt.getTime() - SOCIAL_RETENTION_MS), ctx.lease);
  const purged = await purgeGoneBlueskyPosts(new Date(startedAt.getTime() - BLUESKY_GONE_PURGE_MS), ctx.lease);
  const complete = discovered && !truncated && !lookupFailed && !rateLimited;
  ctx.log("social.bluesky_talk_collected", {
    found: posts.length, unlinked: posts.filter(post => !post.repositoryKey).length, multi: posts.filter(post => post.candidates.length > 1).length,
    attributed: recorded.attributed + refreshed.attributed,
    skipped, inserted: recorded.inserted, updated: recorded.updated + refreshed.updated, observed: recorded.observed + refreshed.observed,
    held: recorded.held + refreshed.held, released: recorded.released + refreshed.released, heavy: heavy.length, bots,
    missing: missing.length, rechecked, gone, expired, purged, pages, requests, complete, truncated,
  });
  // 새 글을 못 읽은 회차는 끝 시각을 옮기지 않는다 — 다음 회차가 그 사이를 다시 읽는다. 성공도 아니다(러너가 성공 시각을 옮기지 않는다)
  if (!discovered) return { done: false, cursor: ctx.cursor, degraded: { code: "search_failed", detail: `Bluesky 검색 ${discoveryFailure ?? "실패"}` } };
  const cursor = { lastRunAt: startedAt.toISOString(), through: startedAt.toISOString() };
  await ctx.save(cursor);
  // 다시 묻기가 막히면 지워진 글을 내리지 못한다(원문 삭제 존중) — 새 글은 읽었어도 제 일을 다 하지 못한 회차다
  if (lookupFailed) return { done: true, cursor, degraded: { code: "lookup_failed", detail: `Bluesky 다시 묻기 ${lookupReason}` } };
  return { done: true, cursor };
}

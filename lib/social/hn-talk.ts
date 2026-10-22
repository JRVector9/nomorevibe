import { getSettings } from "@/lib/crawl/settings";
import { fetchCapped, type CappedRequest } from "@/lib/net/fetch";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import {
  HN_LOOKUP_BATCH, hnDiscoverUrl, hnLookupUrl, hnResponseSchema, hnTalkPost,
  type HnResponse, type HnTalkPost,
} from "./hn-talk-source";
import { deleteExpiredSocialPosts, markSocialPostsGone, postsMissingSince, recordSocialPosts } from "./repository";

/**
 * HN 화제 수집 — 최근 72시간 안에 GitHub 저장소를 가리킨 글을 점수와 함께 남긴다(SNS 화제·홍보 설계 T2).
 *
 * 30분마다 같은 창을 다시 읽는다. 창 안의 글은 매번 점수·댓글이 새로 오므로 따로 재조회하지 않는다.
 * 지난번에 본 글이 이번에 돌아오지 않으면 ID로 다시 묻고, 그래도 없으면 지워진 글로 내린다.
 * 검색이 돌려준 글은 저장소 모양이 아니어도 남긴다(관리자 /admin/talk 에서 모두 본다). 주소·제목이 없는 글만 버리고 그 수를 기록에 남긴다.
 */
export const HN_TALK_WINDOW_MS = 72 * 3_600_000;
/** 이보다 낮은 글은 화제 후보로도 남기지 않는다. 화면의 자격(30점 등)은 읽을 때 따로 건다 */
export const HN_TALK_MIN_POINTS = 10;
/** 관측 보관 — 상세 화제 기록을 남기는 기간과 같다(시안 Q3 권장, 처리방침 초안 90일) */
export const SOCIAL_RETENTION_MS = 90 * 86_400_000;
const MAX_PAGES = 5;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;

export type HnTalkCursor = { lastRunAt: string };

type Fetched = { ok: true; value: HnResponse } | { ok: false; reason: string };

async function fetchHn(url: string, request?: CappedRequest): Promise<Fetched> {
  const response = await fetchCapped(url, { maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS, request });
  if (!response.ok) return { ok: false, reason: response.reason === "http" ? `http_${response.status}` : response.reason };
  if (response.status !== 200) return { ok: false, reason: `http_${response.status}` };
  try {
    const parsed = hnResponseSchema.safeParse(JSON.parse(response.body.toString("utf8")));
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: "invalid_response" };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

/** 남길 글과 버린 수 — 주소·제목이 없는 글만 버린다 */
function read(response: HnResponse) {
  const posts = response.hits.map(hnTalkPost).filter((post): post is HnTalkPost => post !== null);
  return { posts, skipped: response.hits.length - posts.length };
}
/** 저장소 키 없이 남긴 글 수(github.io·gist·사용자 페이지 등) */
const unlinked = (posts: readonly HnTalkPost[]) => posts.filter(post => !post.repositoryKey).length;

export async function collectHnTalk(ctx: JobContext<HnTalkCursor>, request?: CappedRequest, now = () => new Date()): Promise<JobOutcome<HnTalkCursor>> {
  const settings = await getSettings();
  if (!settings.enabled) return { done: true };

  const startedAt = now();
  const since = new Date(startedAt.getTime() - HN_TALK_WINDOW_MS);
  const found: HnTalkPost[] = [];
  let pages = 0, skipped = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchHn(hnDiscoverUrl(Math.floor(since.getTime() / 1000), HN_TALK_MIN_POINTS, page), request);
    if (!result.ok) {
      ctx.log("social.hn_talk_failed", { reason: result.reason, page });
      // 검색이 막힌 회차는 성공이 아니다 — 러너가 성공 시각을 옮기지 않고 까닭을 남긴다(관리자 /admin/talk·조치할 일)
      return { done: false, cursor: ctx.cursor, degraded: { code: "search_failed", detail: `HN 검색 ${result.reason} (${page + 1}쪽)` } };
    }
    pages += 1;
    const kept = read(result.value);
    found.push(...kept.posts);
    skipped += kept.skipped;
    if (page >= result.value.nbPages - 1) break;
    if (!ctx.hasBudget()) {
      // 창을 다 못 읽은 회차는 기록만 하고 '돌아오지 않은 글' 판정은 하지 않는다
      const partial = await recordSocialPosts("hn", found, startedAt, ctx.lease);
      ctx.log("social.hn_talk_collected", { found: found.length, unlinked: unlinked(found), skipped, ...partial, pages, gone: 0, expired: 0, complete: false });
      return { done: false, cursor: ctx.cursor };
    }
  }

  const recorded = await recordSocialPosts("hn", found, startedAt, ctx.lease);

  // 지난번에 본 글이 창 안에 있는데 이번에 안 왔다 — ID로 다시 묻는다
  const missing = await postsMissingSince("hn", since, startedAt);
  let gone = 0, lookupFailed: string | null = null;
  for (let index = 0; index < missing.length; index += HN_LOOKUP_BATCH) {
    if (!ctx.hasBudget()) break;
    const batch = missing.slice(index, index + HN_LOOKUP_BATCH);
    const result = await fetchHn(hnLookupUrl(batch.map(post => post.externalId)), request);
    if (!result.ok) {
      ctx.log("social.hn_talk_lookup_failed", { reason: result.reason });
      lookupFailed = result.reason;
      break;
    }
    const back = new Set(result.value.hits.map(hit => hit.objectID));
    await recordSocialPosts("hn", read(result.value).posts, startedAt, ctx.lease);
    gone += await markSocialPostsGone(batch.filter(post => !back.has(post.externalId)).map(post => post.id), startedAt, ctx.lease);
  }

  const expired = await deleteExpiredSocialPosts(new Date(startedAt.getTime() - SOCIAL_RETENTION_MS), ctx.lease);
  ctx.log("social.hn_talk_collected", { found: found.length, unlinked: unlinked(found), skipped, ...recorded, pages, missing: missing.length, gone, expired, complete: true });
  const cursor = { lastRunAt: startedAt.toISOString() };
  await ctx.save(cursor);
  // 다시 묻기가 막히면 지워진 글을 내리지 못한다(원문 삭제 존중) — 새 글은 읽었어도 제 일을 다 하지 못한 회차다
  return lookupFailed ? { done: true, cursor, degraded: { code: "lookup_failed", detail: `HN 다시 묻기 ${lookupFailed}` } } : { done: true, cursor };
}

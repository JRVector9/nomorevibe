import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parseEntities } from "parse-entities";
import { setTimeout as sleep } from "node:timers/promises";
import { SHOW_GN_SIGNAL } from "@/lib/crawl/settings-schema";
import { getSettings } from "@/lib/crawl/settings";
import { enqueueDiscoveryBatch } from "@/lib/crawl/shared-discovery";
import { recordDiscoveryProgress } from "@/lib/crawl/discovery-progress";
import { fetchCapped, type CappedRequest } from "@/lib/net/fetch";
import { repoFromUrl } from "./hn-show";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";

export const GEEKNEWS_FEED = "https://news.hada.io/rss/news";
export const MAX_TOPICS_PER_TICK = 20;
const REQUEST_INTERVAL_MS = 1_000;
const MAX_BYTES = 512 * 1024;
const topicUrl = (id: string) => `https://news.hada.io/topic?id=${id}`;
type PendingTopic = { id: string; repo?: string };
export type ShowGnCursor = {
  /** RSS에서 확인한 번호의 상한. 실패·상한 초과·수용 대기는 pending에 따로 남긴다 */
  seenUntil: number;
  pending: PendingTopic[];
};

/** RSS에는 제품 주소가 없다. 외부 주소를 따라가지 않고 GeekNews 번호만 읽는다 */
export function showGnTopicIds(xml: string): string[] {
  const markup = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (/<!DOCTYPE|<!ENTITY/i.test(markup) || XMLValidator.validate(xml) !== true) throw new Error("invalid_feed");
  const data = new XMLParser({ ignoreAttributes: false, processEntities: false, parseTagValue: false,
    removeNSPrefix: true, trimValues: true }).parse(xml);
  if (data.feed === "") return [];
  if (!data.feed || typeof data.feed !== "object") throw new Error("invalid_feed");
  const entries = data.feed.entry ? [data.feed.entry].flat() : [];
  // 잘린 피드를 정상 완료로 오해하지 않는다.
  if (entries.length > 200) throw new Error("feed_entries_limit");
  const ids: string[] = [];
  for (const entry of entries) {
    const title = typeof entry.title === "string" ? entry.title : entry.title?.["#text"];
    if (typeof title !== "string" || !/^Show GN\s*:/i.test(parseEntities(title).trim())) continue;
    const links = [entry.id, ...[entry.link ?? []].flat().map(link => link?.["@_href"])];
    const id = links.flatMap(value => {
      try {
        const url = new URL(value);
        const id = url.searchParams.get("id");
        return url.origin === "https://news.hada.io" && url.pathname === "/topic" && /^\d{1,12}$/.test(id ?? "") ? [id!] : [];
      } catch { return []; }
    })[0];
    if (!id) throw new Error("invalid_topic_id");
    ids.push(id);
  }
  return [...new Set(ids)].sort((a, b) => Number(a) - Number(b));
}

function attribute(tag: string, name: string): string | null {
  // 속성값 속의 class/href 글자를 다른 속성으로 읽지 않는다.
  const attrs = /([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.matchAll(attrs)) if (match[1].toLowerCase() === name)
    return parseEntities(match[2] ?? match[3] ?? match[4] ?? "");
  return null;
}
function httpUrl(value: string | null): URL | null {
  try {
    const url = new URL(value ?? "");
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

/** 제목 영역과 작성자 본문만 본다. 댓글/추천/스크립트의 GitHub 링크는 후보 근거가 아니다 */
export function showGnRepository(html: string): { ok: true; repo: string | null } | { ok: false; reason: string } {
  const clean = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const stack: { title: boolean; contents: boolean }[] = [];
  const bodyRepos = new Map<string, string>();
  let product: URL | null = null;
  for (const match of clean.matchAll(/<\/?[a-z][^>]*>/gi)) {
    const tag = match[0];
    if (/^<\/(?:div|section)\b/i.test(tag)) { stack.pop(); continue; }
    if (/^<(?:div|section)\b/i.test(tag)) {
      const classes = (attribute(tag, "class") ?? "").split(/\s+/);
      const parent = stack.at(-1);
      stack.push({ title: parent?.title === true || classes.includes("topictitle") && classes.includes("link"),
        contents: parent?.contents === true || attribute(tag, "id") === "topic_contents" });
    }
    if (!/^<a\b/i.test(tag)) continue;
    const area = stack.at(-1);
    const href = httpUrl(attribute(tag, "href"));
    if (!href) continue;
    if (area?.title && (attribute(tag, "class") ?? "").split(/\s+/).includes("topic-title-link")) product = href;
    if (area?.contents) {
      const repo = repoFromUrl(href.href);
      if (repo) bodyRepos.set(repo.toLowerCase(), repo);
    }
  }
  if (!product) return { ok: false, reason: "title_link_missing" };
  const direct = repoFromUrl(product.href);
  if (direct) return { ok: true, repo: direct };
  const pagesOwner = /^([a-z0-9-]+)\.github\.io$/i.exec(product.hostname)?.[1];
  const project = product.pathname.split("/").filter(Boolean)[0];
  if (pagesOwner && project) return { ok: true, repo: bodyRepos.get(`${pagesOwner}/${project}`.toLowerCase()) ?? null };
  // 일반 사이트는 제목 링크의 호스트/프로젝트명과 같은 저장소 하나만 택한다.
  const hostName = product.hostname.replace(/^www\./, "").split(".")[0].toLowerCase();
  const related = [...bodyRepos.values()].filter(repo => repo.split("/")[1].toLowerCase() === hostName);
  return { ok: true, repo: related.length === 1 ? related[0] : null };
}

/** Show HN과 같은 job cursor/설정/프론티어. 수용 한도는 한국어 발굴과 같은 원자적 관문을 쓴다 */
export async function seedFromShowGN(ctx: JobContext<ShowGnCursor>, request?: CappedRequest): Promise<JobOutcome<ShowGnCursor>> {
  const settings = await getSettings();
  if (!settings.enabled || !settings.discover.showGn.enabled) return { done: true };
  const cursor: ShowGnCursor = ctx.cursor ? structuredClone(ctx.cursor) : { seenUntil: 0, pending: [] };
  let requests = 0, examined = 0, discovered = 0, existing = 0, skippedNoRepo = 0, failed = 0;
  let lastFailure: string | undefined;
  let blockedBy: "queue_cap" | "rate_cap" | "measurement_unknown" | undefined;
  const load = async (url: string) => {
    if (requests) await sleep(REQUEST_INTERVAL_MS, undefined, { signal: ctx.signal });
    requests++;
    return fetchCapped(url, { maxBytes: MAX_BYTES, timeoutMs: Math.max(1, Math.min(10_000, (ctx.deadlineAt ?? Infinity) - Date.now())),
      signal: ctx.signal, request });
  };
  if (!ctx.hasBudget() || ctx.signal?.aborted) return { done: false, cursor };
  const feed = await load(GEEKNEWS_FEED);
  if (!feed.ok || feed.status !== 200) {
    const reason = feed.ok ? `http_${feed.status}` : feed.reason === "http" ? `http_${feed.status}` : feed.reason;
    ctx.log("crawl.show_gn_failed", { reason });
    return { done: false, cursor, degraded: { code: "feed_fetch_failed", cause: reason } };
  }
  let ids: string[];
  try { ids = showGnTopicIds(feed.body.toString("utf8")); }
  catch {
    ctx.log("crawl.show_gn_failed", { reason: "invalid_feed" });
    return { done: false, cursor, degraded: { code: "invalid_feed" } };
  }
  const pendingIds = new Set(cursor.pending.map(item => item.id));
  cursor.pending.push(...ids.filter(id => Number(id) > cursor.seenUntil && !pendingIds.has(id)).map(id => ({ id })));
  cursor.seenUntil = Math.max(cursor.seenUntil, ...ids.map(Number));
  await ctx.save(cursor);
  // 실패한 글 하나가 뒤 글을 막지 않는다. RSS에서 사라진 실패 글도 다음 틱에 재시도한다.
  for (const item of [...cursor.pending].slice(0, MAX_TOPICS_PER_TICK)) {
    if (!ctx.hasBudget() || ctx.signal?.aborted || ctx.deadlineAt !== undefined && Date.now() + REQUEST_INTERVAL_MS >= ctx.deadlineAt) break;
    if (!item.repo) {
      const page = await load(topicUrl(item.id));
      const parsed = page.ok && page.status === 200 ? showGnRepository(page.body.toString("utf8")) : null;
      const reason = parsed && !parsed.ok ? parsed.reason : !page.ok
        ? page.reason === "http" ? `http_${page.status}` : page.reason : page.status !== 200 ? `http_${page.status}` : undefined;
      if (!parsed?.ok) {
        failed++; lastFailure = reason;
        ctx.log("crawl.show_gn_failed", { topicId: item.id, reason });
        cursor.pending = [...cursor.pending.filter(row => row.id !== item.id), item];
        await ctx.save(cursor);
        continue;
      }
      examined++;
      if (!parsed.repo) {
        skippedNoRepo++;
        cursor.pending = cursor.pending.filter(row => row.id !== item.id);
        await ctx.save(cursor);
        continue;
      }
      item.repo = parsed.repo;
      // 수용 대기나 중단에도 이미 읽은 페이지를 다시 요청하지 않는다.
      await ctx.save(cursor);
    }
    const result = await enqueueDiscoveryBatch([{ repo: item.repo, signal: SHOW_GN_SIGNAL, builder: null,
      priority: settings.discover.showGn.priority, discoverySource: { source: "geeknews", topicId: item.id, url: topicUrl(item.id) } }], settings.discover, ctx.lease);
    if (!result.processed) { blockedBy = result.blockedBy; break; }
    discovered += result.added; existing += result.processed - result.added;
    cursor.pending = cursor.pending.filter(row => row.id !== item.id);
    await ctx.save(cursor);
  }
  const drained = cursor.pending.length === 0;
  await recordDiscoveryProgress({ worker: process.env.SERVICE_INSTANCE_ID ?? "home-crawler", lane: "geeknews", signal: SHOW_GN_SIGNAL,
    // RSS는 과거 구간 전체의 완료를 보장하지 않으므로 completedThrough를 쓰지 않는다.
    counts: { searchRequests: requests, pagesVisited: examined, returned: ids.length, examined, discovered, existing, incomplete: failed },
    blockedBy: blockedBy ?? (failed ? "api_wait" : null) });
  ctx.log("crawl.show_gn_seeded", { discovered, existing, examined, skippedNoRepo, failed, requests, pending: cursor.pending.length, drained });
  return { done: drained, cursor, ...(failed ? { degraded: { code: "topic_failed", cause: lastFailure } } : {}) };
}

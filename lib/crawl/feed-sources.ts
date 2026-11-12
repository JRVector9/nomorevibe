import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parseEntities } from "parse-entities";
import type { DiscoverySource } from "@/lib/db/crawl-schema";
import { SHOW_GN_SIGNAL, type CrawlSettings } from "./settings-schema";
import type { FeedLinkRule, FeedPageTitleRule } from "./feed-source-schema";
import { repoFromUrl } from "./jobs/hn-show";

/**
 * 글 목록(RSS·Atom) 수집원 — 설정 한 줄이 「어느 피드를 읽어 어떤 글을 고르고 제품 링크를 어디서 찾나」를 말한다(2026-11-12 운영 콘솔 조각 4a).
 * 한 잡(gn-show-seed, lib/crawl/jobs/gn-show.ts)이 켜진 수집원을 차례로 돈다. 이 모듈은 설정 → 수집원, 피드 파싱, 글 고르기, 글 페이지에서 저장소 찾기를 맡는다.
 *
 * 첫 수집원은 2026-11-11 에 코드로 넣은 GeekNews Show GN 이다(SHOW_GN_FEED) — 주소·규칙은 코드에 그대로 두고, 켜짐·우선순위·AI 흔적은 예전처럼
 * discover.showGn 이 정한다. 신호 이름(Show GN)·커서(jobs.cursor 의 seenUntil·pending)·발굴 출처(geeknews 번호)가 예전과 같다(tests/crawl-gn-show.test.ts).
 * 화면에서 더한 수집원(discover.feeds)은 글 주소를 열쇠로 본 글을 기억한다(cursor.feeds.<id>).
 */

/** 글 열쇠 — id-param: 글 주소의 숫자 번호(GeekNews topic?id=N, 커서는 본 번호의 상한) · link: 글 주소 그대로(커서는 본 주소 목록) */
export type FeedArticleKey = { kind: "id-param"; origin: string; path: string; param: string } | { kind: "link" };
export type FeedSource = {
  id: string; name: string; url: string; titlePrefix: string; link: FeedLinkRule; article: FeedArticleKey;
  /** null = 글 목록 작업이 돌 때마다 읽는다(Show GN) */
  intervalMinutes: number | null;
  priority: number; enabled: boolean; requireEvidence: boolean;
  /** 코드에 있는 첫 수집원(Show GN) — 상태는 커서의 맨 위 칸(seenUntil·pending)이다 */
  legacy: boolean;
};

export const SHOW_GN_FEED_ID = "show-gn";
export const GEEKNEWS_FEED = "https://news.hada.io/rss/news";
/** GeekNews Show GN — 2026-11-11 추가 때의 주소·규칙 그대로(제목 「Show GN:」, 글 페이지의 topictitle 영역의 topic-title-link, 본문 topic_contents) */
export const SHOW_GN_FEED: Omit<FeedSource, "enabled" | "priority" | "requireEvidence"> = Object.freeze({
  id: SHOW_GN_FEED_ID, name: SHOW_GN_SIGNAL, url: GEEKNEWS_FEED, titlePrefix: "Show GN:",
  link: Object.freeze({ kind: "page-title", titleClass: "topictitle link", linkClass: "topic-title-link", bodyId: "topic_contents" }) as FeedLinkRule,
  article: Object.freeze({ kind: "id-param", origin: "https://news.hada.io", path: "/topic", param: "id" }) as FeedArticleKey,
  intervalMinutes: null, legacy: true,
});

/** 설정 → 수집원(첫 줄은 Show GN). 꺼진 것도 돌려준다 — 화면이 같이 그린다 */
export function feedSources(discover: Pick<CrawlSettings["discover"], "showGn" | "feeds">): FeedSource[] {
  return [
    { ...SHOW_GN_FEED, enabled: discover.showGn.enabled, priority: discover.showGn.priority, requireEvidence: discover.showGn.requireEvidence === true },
    ...(discover.feeds ?? []).map(feed => ({ id: feed.id, name: feed.name, url: feed.url, titlePrefix: feed.titlePrefix, link: feed.link,
      article: { kind: "link" } as const, intervalMinutes: feed.intervalMinutes, priority: feed.priority, enabled: feed.enabled,
      requireEvidence: feed.requireEvidence === true, legacy: false })),
  ];
}

/** 발굴 출처 — Show GN 은 예전 모양(geeknews 번호), 나머지는 수집원 열쇠와 글 주소 */
export function feedDiscoverySource(source: Pick<FeedSource, "id" | "legacy" | "article">, articleId: string): DiscoverySource {
  return source.legacy ? { source: "geeknews", topicId: articleId, url: feedArticleUrl(source, articleId) }
    : { source: "feed", feed: source.id, url: feedArticleUrl(source, articleId) };
}
export function feedArticleUrl(source: Pick<FeedSource, "article">, articleId: string): string {
  const key = source.article;
  return key.kind === "id-param" ? `${key.origin}${key.path}?${key.param}=${articleId}` : articleId;
}

// ── 피드 ───────────────────────────────────────────────────────────────

export type FeedEntry = { title: string; links: string[]; page: string | null; date: number | null; html: string | null };
type Raw = Record<string, unknown>;
const text = (value: unknown): string | null => typeof value === "string" ? value
  : value && typeof value === "object" && typeof (value as Raw)["#text"] === "string" ? (value as Raw)["#text"] as string : null;
const list = (value: unknown): unknown[] => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

function httpUrl(value: string | null | undefined): URL | null {
  try {
    const url = new URL(value ?? "");
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function entryOf(entry: unknown, atom: boolean): FeedEntry {
  const row = entry && typeof entry === "object" ? entry as Raw : {};
  const title = parseEntities(text(row.title) ?? "").trim();
  const hrefs = list(row.link).map(link => typeof link === "string" ? link
    : link && typeof link === "object" ? ({ href: (link as Raw)["@_href"], rel: (link as Raw)["@_rel"] }) : null);
  const atomLinks = hrefs.filter((link): link is { href: unknown; rel: unknown } => !!link && typeof link === "object");
  const id = text(row.id), guid = text(row.guid), plain = hrefs.filter((link): link is string => typeof link === "string");
  // Show GN 의 순서: <id> 다음 <link href> — 번호를 찾는 쪽(id-param)은 이 순서로 첫 맞는 주소를 쓴다
  const links = (atom ? [id, ...atomLinks.map(link => link.href)] : [...plain, guid]).filter((value): value is string => typeof value === "string");
  const alternate = atomLinks.find(link => link.rel === undefined || link.rel === "alternate")?.href;
  const page = [typeof alternate === "string" ? alternate : null, ...plain, guid, id].map(value => httpUrl(value)?.href ?? null).find(Boolean) ?? null;
  const dateText = [row.published, row.updated, row.pubDate, row.date].map(text).find(Boolean);
  const date = dateText ? Date.parse(dateText) : NaN;
  const body = [row.content, row.summary, row.description, row.encoded].map(text).find(Boolean);
  return { title, links, page, date: Number.isFinite(date) ? date : null, html: body ? parseEntities(body) : null };
}

/** 피드 글 목록(Atom · RSS 2.0 · RSS 1.0). 외부 엔티티·DOCTYPE·깨진 XML·200개를 넘는 잘린 피드는 던진다(invalid_feed·feed_entries_limit) */
export function parseFeedEntries(xml: string): FeedEntry[] {
  const markup = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (/<!DOCTYPE|<!ENTITY/i.test(markup) || XMLValidator.validate(xml) !== true) throw new Error("invalid_feed");
  const data = new XMLParser({ ignoreAttributes: false, processEntities: false, parseTagValue: false,
    removeNSPrefix: true, trimValues: true }).parse(xml) as Raw;
  let raw: unknown[];
  let atom = false;
  if (data.feed !== undefined) {
    if (data.feed === "") return [];
    if (!data.feed || typeof data.feed !== "object") throw new Error("invalid_feed");
    raw = list((data.feed as Raw).entry); atom = true;
  } else if (data.rss !== undefined || data.RDF !== undefined) {
    const root = (data.rss ?? data.RDF) as Raw | string;
    if (root === "") return [];
    if (!root || typeof root !== "object") throw new Error("invalid_feed");
    const channel = root.channel;
    // RSS 2.0 은 channel 안에, RSS 1.0(RDF)은 channel 옆에 item 이 있다
    raw = list(channel && typeof channel === "object" && (channel as Raw).item !== undefined ? (channel as Raw).item : root.item);
  } else throw new Error("invalid_feed");
  // 잘린 피드를 정상 완료로 오해하지 않는다.
  if (raw.length > 200) throw new Error("feed_entries_limit");
  return raw.map(entry => entryOf(entry, atom));
}

/** 고를 글 — 제목이 이 말로 시작(대소문자 무시, 콜론 앞 공백 허용). 비우면 모든 글. Show GN 의 /^Show GN\s*:/i 와 같다 */
export function titleMatches(title: string, prefix: string): boolean {
  const norm = (value: string) => value.trim().replace(/\s+:/g, ":").toLowerCase();
  const wanted = norm(prefix);
  return !wanted || norm(title).startsWith(wanted);
}

export type FeedArticle = { id: string; title: string; date: number | null; page: string; link: string | null; html: string | null };
/**
 * 피드 글 → 고른 글. id-param 은 번호가 없는 글을 만나면 던진다(invalid_topic_id — 피드 모양이 바뀐 것). link 는 주소 없는 글·다른 사이트의 글을 건너뛰고 센다.
 * 차례: 번호면 번호 오름차순(Show GN 그대로), 주소면 날짜 오름차순(날짜가 없는 글이 있으면 피드의 거꾸로 — 피드는 새 글이 먼저다).
 */
export function selectFeedArticles(entries: readonly FeedEntry[], source: Pick<FeedSource, "titlePrefix" | "article" | "link" | "url">):
  { articles: FeedArticle[]; selected: number; skipped: number } {
  const chosen = entries.filter(entry => titleMatches(entry.title, source.titlePrefix));
  const key = source.article;
  const out = new Map<string, FeedArticle>();
  let skipped = 0;
  const feedHost = httpUrl(source.url)?.hostname ?? null;
  for (const entry of chosen) {
    if (key.kind === "id-param") {
      const id = entry.links.flatMap(value => {
        try {
          const url = new URL(value);
          const found = url.searchParams.get(key.param);
          return url.origin === key.origin && url.pathname === key.path && /^\d{1,12}$/.test(found ?? "") ? [found!] : [];
        } catch { return []; }
      })[0];
      if (!id) throw new Error("invalid_topic_id");
      if (!out.has(id)) out.set(id, { id, title: entry.title, date: entry.date, page: feedArticleUrl(source, id), link: entry.page, html: entry.html });
      continue;
    }
    const page = entry.page;
    // 글 페이지를 읽는 수집원은 피드와 같은 사이트의 글만 연다(다른 사이트 주소를 따라가지 않는다)
    if (!page || (source.link.kind === "page-title" && new URL(page).hostname !== feedHost)) { skipped++; continue; }
    if (!out.has(page)) out.set(page, { id: page, title: entry.title, date: entry.date, page, link: page, html: entry.html });
  }
  const articles = [...out.values()];
  if (key.kind === "id-param") articles.sort((a, b) => Number(a.id) - Number(b.id));
  else if (articles.every(article => article.date !== null)) articles.sort((a, b) => a.date! - b.date!);
  else articles.reverse();
  return { articles, selected: chosen.length, skipped };
}

// ── 글 → 저장소 ────────────────────────────────────────────────────────

function attribute(tag: string, name: string): string | null {
  // 속성값 속의 class/href 글자를 다른 속성으로 읽지 않는다.
  const attrs = /([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.matchAll(attrs)) if (match[1].toLowerCase() === name)
    return parseEntities(match[2] ?? match[3] ?? match[4] ?? "");
  return null;
}
const classes = (value: string | null) => (value ?? "").split(/\s+/).filter(Boolean);

/** 제품 링크 → 저장소. 직접 GitHub 저장소면 그것, owner.github.io/<프로젝트>면 본문의 그 저장소, 일반 사이트면 본문에서 호스트 이름과 같은 저장소 하나만 */
export function productRepository(product: URL, bodyRepos: ReadonlyMap<string, string>): string | null {
  const direct = repoFromUrl(product.href);
  if (direct) return direct;
  const pagesOwner = /^([a-z0-9-]+)\.github\.io$/i.exec(product.hostname)?.[1];
  const project = product.pathname.split("/").filter(Boolean)[0];
  if (pagesOwner && project) return bodyRepos.get(`${pagesOwner}/${project}`.toLowerCase()) ?? null;
  // 일반 사이트는 제목 링크의 호스트/프로젝트명과 같은 저장소 하나만 택한다.
  const hostName = product.hostname.replace(/^www\./, "").split(".")[0].toLowerCase();
  const related = [...bodyRepos.values()].filter(repo => repo.split("/")[1].toLowerCase() === hostName);
  return related.length === 1 ? related[0] : null;
}

/** 글 페이지 → 저장소. 제목 영역(div·section)과 작성자 본문만 본다 — 댓글/추천/스크립트의 GitHub 링크는 후보 근거가 아니다 */
export function pageRepository(html: string, rule: FeedPageTitleRule): { ok: true; repo: string | null } | { ok: false; reason: string } {
  const titleClasses = classes(rule.titleClass), linkClasses = classes(rule.linkClass);
  const clean = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const stack: { title: boolean; contents: boolean }[] = [];
  const bodyRepos = new Map<string, string>();
  let product: URL | null = null;
  for (const match of clean.matchAll(/<\/?[a-z][^>]*>/gi)) {
    const tag = match[0];
    if (/^<\/(?:div|section)\b/i.test(tag)) { stack.pop(); continue; }
    if (/^<(?:div|section)\b/i.test(tag)) {
      const own = classes(attribute(tag, "class"));
      const parent = stack.at(-1);
      stack.push({ title: parent?.title === true || titleClasses.every(name => own.includes(name)),
        contents: parent?.contents === true || (rule.bodyId !== null && attribute(tag, "id") === rule.bodyId) });
    }
    if (!/^<a\b/i.test(tag)) continue;
    const area = stack.at(-1);
    const href = httpUrl(attribute(tag, "href"));
    if (!href) continue;
    if (area?.title && linkClasses.every(name => classes(attribute(tag, "class")).includes(name))) product = href;
    if (area?.contents) {
      const repo = repoFromUrl(href.href);
      if (repo) bodyRepos.set(repo.toLowerCase(), repo);
    }
  }
  if (!product) return { ok: false, reason: "title_link_missing" };
  return { ok: true, repo: productRepository(product, bodyRepos) };
}

/** 피드 항목의 링크가 제품 링크인 수집원 — 항목의 글(요약·본문)의 GitHub 링크를 본문으로 본다 */
export function entryRepository(article: Pick<FeedArticle, "link" | "html">): string | null {
  const product = httpUrl(article.link);
  if (!product) return null;
  const bodyRepos = new Map<string, string>();
  for (const match of (article.html ?? "").replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "").matchAll(/<a\b[^>]*>/gi)) {
    const href = httpUrl(attribute(match[0], "href"));
    const repo = href ? repoFromUrl(href.href) : null;
    if (repo) bodyRepos.set(repo.toLowerCase(), repo);
  }
  return productRepository(product, bodyRepos);
}

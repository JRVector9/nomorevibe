import { z } from "zod";
import { safeHttpUrl } from "@/lib/domain/evidence/contracts";
import type { FeedItem } from "@/lib/domain/evidence/providers/feeds";
import { extractPageMeta } from "@/lib/net/normalize";
import { DEFAULT_RELEASE_TAG, type NewsSource } from "./sources";

/** 저장하기 직전의 글 하나. 출처가 무엇이든 이 모양으로 모은다 */
export type NewsCandidate = {
  sourceKey: string;
  url: string;
  title: string;
  summary: string | null;
  publishedAt: Date;
};

const MAX_TITLE = 300;
const MAX_SUMMARY = 400;
/** 날짜만 있는 제목을 본문 첫 문장으로 바꿀 때의 길이 */
const DERIVED_TITLE = 90;
/** 한 출처에서 한 번에 받는 릴리스 수 — 피드는 최신 20건을 준다 */
const MAX_RELEASES = 10;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 앞날로 적힌 게시일은 지금으로 당긴다 — 예약 글이 목록 맨 위에 눌러앉지 않게 */
function publishedAtOrNow(value: Date | null, now: Date): Date {
  return value && value.getTime() <= now.getTime() ? value : now;
}

function firstSentence(text: string | null): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const sentence = trimmed.split(/(?<=[.!?。])\s/)[0];
  return clip(sentence, DERIVED_TITLE);
}

/**
 * 공식 발표 한 건.
 *
 * Z.ai 릴리스 노트는 제목이 날짜뿐이고 내용은 본문에 있다("2026-08-26"). 날짜만으로는
 * 무엇이 나왔는지 알 수 없으니 본문 첫 문장을 제목으로 쓴다.
 */
export function newsCandidate(source: NewsSource, item: FeedItem, now: Date): NewsCandidate | null {
  const url = item.canonicalUrl ?? anchoredUrl(item.link);
  if (!url) return null;
  const raw = item.title.trim();
  const title = DATE_ONLY.test(raw) ? firstSentence(item.summary) ?? `${source.name} 업데이트` : raw;
  return {
    sourceKey: source.key,
    url,
    title: clip(title, MAX_TITLE),
    summary: item.summary ? clip(item.summary, MAX_SUMMARY) : null,
    publishedAt: publishedAtOrNow(item.publishedAt, now),
  };
}

/**
 * #앵커가 붙은 원문 주소. 앵커를 뗀 주소가 공개 주소 검증을 통과할 때만 앵커를 다시 붙인다.
 * 한 페이지에 날짜별 앵커로 글을 싣는 곳(Z.ai 릴리스 노트)은 앵커가 곧 글이다.
 */
function anchoredUrl(link: string | null | undefined): string | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const anchor = url.hash;
  url.hash = "";
  const page = safeHttpUrl.safeParse(url.toString());
  return page.success && anchor ? `${page.data}${anchor}` : null;
}

/** GitHub 릴리스 주소의 태그 (/releases/tag/<tag>) */
function releaseTag(url: string): string | null {
  const match = /\/releases\/tag\/([^/?#]+)/.exec(url);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * 코딩 도구 릴리스 한 건. 제목을 "도구 이름 버전"으로 맞춘다.
 *
 * 저장소마다 제목이 제각각이다 — "v2.1.268", "Release v0.23.3", "@moonshot-ai/kimi-code@0.42.0".
 * 태그가 그 도구의 정식 릴리스 규칙에 맞을 때만 받는다. nightly·preview·alpha 는 버전 뒤에
 * 꼬리가 붙어 규칙에서 저절로 빠지고, 같은 저장소의 다른 제품(SDK·데스크톱)도 빠진다.
 */
export function releaseCandidate(source: NewsSource, item: FeedItem, now: Date): NewsCandidate | null {
  if (!item.canonicalUrl) return null;
  const tag = releaseTag(item.canonicalUrl);
  const version = tag ? (source.tagPattern ?? DEFAULT_RELEASE_TAG).exec(tag)?.[1] : undefined;
  if (!version) return null;
  const title = `${source.name} ${version}`;
  return {
    sourceKey: source.key,
    url: item.canonicalUrl,
    title: clip(title, MAX_TITLE),
    summary: item.summary ? clip(item.summary, MAX_SUMMARY) : null,
    publishedAt: publishedAtOrNow(item.publishedAt, now),
  };
}

export function feedCandidates(source: NewsSource, items: FeedItem[], now: Date): NewsCandidate[] {
  const pick = source.section === "release" ? releaseCandidate : newsCandidate;
  const candidates = items.flatMap((item) => pick(source, item, now) ?? []);
  return source.section === "release" ? candidates.slice(0, MAX_RELEASES) : candidates;
}

const npmDocument = z.object({ time: z.record(z.string(), z.string()) });

/** npm 레지스트리 문서의 정식 버전들. 최신부터 */
export function npmCandidates(source: NewsSource, document: unknown, now: Date): NewsCandidate[] {
  const parsed = npmDocument.safeParse(document);
  if (!parsed.success || !source.packageName) return [];
  return Object.entries(parsed.data.time)
    .filter(([version]) => /^\d+\.\d+\.\d+$/.test(version))
    .map(([version, at]) => ({ version, at: new Date(at) }))
    .filter((entry) => !Number.isNaN(entry.at.getTime()))
    .sort((left, right) => right.at.getTime() - left.at.getTime())
    .slice(0, MAX_RELEASES)
    .map(({ version, at }) => ({
      sourceKey: source.key,
      url: `https://www.npmjs.com/package/${source.packageName}/v/${version}`,
      title: `${source.name} ${version}`,
      summary: null,
      publishedAt: publishedAtOrNow(at, now),
    }));
}

const XML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

/** 사이트맵에서 출처의 글 경로 아래 주소만. 목록 페이지(경로 자체)와 다른 호스트는 뺀다 */
export function sitemapUrls(xml: string, source: NewsSource): string[] {
  const host = new URL(source.url).hostname;
  const found = new Set<string>();
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    let url: URL;
    try {
      url = new URL(match[1].replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity]));
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.hostname !== host) continue;
    const path = url.pathname.replace(/\/+$/, "");
    if (!source.paths?.some((prefix) => path.startsWith(prefix) && path.length > prefix.length)) continue;
    found.add(`${url.origin}${path}`);
  }
  return [...found];
}

/**
 * 사이트맵에서 새로 생긴 글.
 *
 * 처음 보는 출처는 지금 있는 것을 모두 기준선으로 삼고 아무것도 새 글로 치지 않는다 —
 * Anthropic은 글 400여 개에 게시일이 없어, 첫 회차에 전부 "방금 올라온 글"이 된다.
 * 기준선이 있는데 한꺼번에 많이 생기면 사이트맵이 한동안 잘려 있다 돌아온 것이다. 그때도
 * 다시 기준선을 잡는다 — 옛 글이 새 글로 쏟아지는 것보다 하나를 늦게 싣는 편이 낫다.
 */
export const SITEMAP_REBASELINE_AT = 20;

export function sitemapChanges(urls: string[], seen: readonly string[] | undefined): { fresh: string[]; rebaseline: boolean } {
  if (!seen) return { fresh: [], rebaseline: true };
  const known = new Set(seen);
  const fresh = urls.filter((url) => !known.has(url));
  return fresh.length > SITEMAP_REBASELINE_AT ? { fresh: [], rebaseline: true } : { fresh, rebaseline: false };
}

function metaPublished(html: string): Date | null {
  const found =
    html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i) ??
    html.match(/"datePublished"\s*:\s*"([^"]{8,40})"/);
  if (!found) return null;
  const at = new Date(found[1]);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** DeepSeek 은 게시일을 주소에 적는다: /news/news260910 → 2026-09-10 */
function slugDate(url: string): Date | null {
  const match = /news(\d{2})(\d{2})(\d{2})$/.exec(url);
  if (!match) return null;
  const at = new Date(`20${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** "제목 | DeepSeek API Docs", "제목 \ Anthropic" 에서 사이트 이름을 뗀다 */
function withoutSiteName(title: string, source: NewsSource): string {
  const parts = title.split(/\s+[|\\]\s+/);
  const tail = parts.at(-1)?.toLowerCase() ?? "";
  if (parts.length > 1 && (tail.includes(source.vendor.toLowerCase()) || tail.includes("docs"))) parts.pop();
  return parts.join(" | ").trim();
}

/** 사이트맵에서 찾은 새 글 페이지. 게시일이 없으면 처음 본 시각이다 */
export function pageCandidate(source: NewsSource, url: string, html: string, now: Date): NewsCandidate | null {
  const meta = extractPageMeta(html, url);
  const title = meta.title ? withoutSiteName(meta.title, source) : "";
  if (!title) return null;
  return {
    sourceKey: source.key,
    url,
    title: clip(title, MAX_TITLE),
    summary: meta.description ? clip(meta.description, MAX_SUMMARY) : null,
    publishedAt: publishedAtOrNow(metaPublished(html) ?? slugDate(url), now),
  };
}

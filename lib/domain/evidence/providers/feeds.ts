import { XMLParser, XMLValidator } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { safeHttpUrl } from "../contracts";
import { fetchCapped, type CappedFetchResult } from "@/lib/net/fetch";
import type { UpdateCandidate } from "../updates";

const MAX_FEED_BYTES = 512 * 1024;
const MAX_ITEMS = 20;
const MAX_DISCOVERED_FEEDS = 8;

export type FeedItem = {
  title: string;
  canonicalUrl: string | null;
  summary: string | null;
  externalId: string | null;
  publishedAt: Date | null;
};

function oneLine(value: unknown, max: number): string | null {
  if (value && typeof value === "object" && "#text" in value) {
    value = value["#text"];
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]{1,8});?/gi, (whole, hex) => decodePoint(Number.parseInt(hex, 16), whole))
    .replace(/&#(\d{1,9});?/g, (whole, decimal) => decodePoint(Number(decimal), whole))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function decodePoint(point: number, fallback: string): string {
  if (!Number.isInteger(point) || point <= 0 || point > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(point);
  } catch {
    return fallback;
  }
}

function decodeEntitiesFully(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 4; pass++) {
    const next = decodeEntities(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

/** 외부 feed 본문은 링크나 HTML을 보존하지 않고 bounded plain text로만 저장한다. */
export function sanitizeExternalSummary(input: unknown): string | null {
  const raw = typeof input === "string"
    ? input
    : input && typeof input === "object" && "#text" in input && typeof input["#text"] === "string"
      ? input["#text"]
      : null;
  if (raw === null) return null;
  const withoutActiveContent = decodeEntitiesFully(raw)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|form|iframe|object|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const text = withoutActiveContent.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 2_000) : null;
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    result[match[1].toLowerCase()] = decodeEntities(match[3]);
  }
  return result;
}

export function discoverFeedUrls(html: string, baseUrl: string): string[] {
  const found: string[] = [];
  for (const match of html.slice(0, 256 * 1024).matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const rel = attrs.rel?.toLowerCase().split(/\s+/) ?? [];
    const type = attrs.type?.toLowerCase() ?? "";
    if (!rel.includes("alternate") || !/(?:rss|atom|xml)/.test(type) || !attrs.href) continue;
    let resolved: string;
    try {
      resolved = new URL(attrs.href, baseUrl).toString();
    } catch {
      continue;
    }
    const safe = safeHttpUrl.safeParse(resolved);
    if (!safe.success || found.includes(safe.data)) continue;
    found.push(safe.data);
    if (found.length === MAX_DISCOVERED_FEEDS) break;
  }
  return found;
}

function array<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function safeUrl(value: unknown, baseUrl: string): string | null {
  const raw = oneLine(value, 1_000);
  if (!raw) return null;
  try {
    const parsed = safeHttpUrl.safeParse(new URL(raw, baseUrl).toString());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function date(value: unknown): Date | null {
  const raw = oneLine(value, 100);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function atomLink(value: unknown): unknown {
  const links = array(value as Record<string, unknown> | Array<Record<string, unknown>> | undefined);
  const preferred = links.find((link) => !link.rel || link.rel === "alternate") ?? links[0];
  return preferred?.href ?? null;
}

function rssItem(value: Record<string, unknown>, baseUrl: string): FeedItem | null {
  const title = oneLine(value.title, 500);
  if (!title) return null;
  return {
    title,
    canonicalUrl: safeUrl(value.link, baseUrl),
    summary: sanitizeExternalSummary(value.description ?? value["content:encoded"]),
    externalId: oneLine(value.guid, 500),
    publishedAt: date(value.pubDate ?? value.date),
  };
}

function atomItem(value: Record<string, unknown>, baseUrl: string): FeedItem | null {
  const title = oneLine(value.title, 500);
  if (!title) return null;
  return {
    title,
    canonicalUrl: safeUrl(atomLink(value.link), baseUrl),
    summary: sanitizeExternalSummary(value.summary ?? value.content),
    externalId: oneLine(value.id, 500),
    publishedAt: date(value.published ?? value.updated),
  };
}

export function parseFeed(xml: string, sourceUrl: string): FeedItem[] {
  if (Buffer.byteLength(xml, "utf8") > MAX_FEED_BYTES) throw new Error("feed too large");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("unsafe feed XML");
  if (XMLValidator.validate(xml) !== true) throw new Error("malformed feed");

  let document: Record<string, unknown>;
  try {
    document = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      removeNSPrefix: true,
      processEntities: false,
      trimValues: false,
    }).parse(xml) as Record<string, unknown>;
  } catch {
    throw new Error("malformed feed");
  }

  const rss = document.rss as { channel?: { item?: Record<string, unknown> | Array<Record<string, unknown>> } } | undefined;
  if (rss?.channel) {
    return array(rss.channel.item).slice(0, MAX_ITEMS).flatMap((item) => {
      const normalized = rssItem(item, sourceUrl);
      return normalized ? [normalized] : [];
    });
  }

  const feed = document.feed as { entry?: Record<string, unknown> | Array<Record<string, unknown>> } | undefined;
  if (feed) {
    return array(feed.entry).slice(0, MAX_ITEMS).flatMap((entry) => {
      const normalized = atomItem(entry, sourceUrl);
      return normalized ? [normalized] : [];
    });
  }
  throw new Error("malformed feed");
}

type FeedRequest = (
  url: string,
  options: { maxBytes: number; headers?: Record<string, string> },
) => Promise<CappedFetchResult>;

export async function fetchFeedEvidence(
  url: string,
  request: FeedRequest = fetchCapped,
): Promise<{ finalUrl: string; items: FeedItem[] } | null> {
  const result = await request(url, {
    maxBytes: MAX_FEED_BYTES,
    headers: { accept: "application/atom+xml, application/rss+xml, application/xml, text/xml" },
  });
  if (!result.ok) return null;
  try {
    return {
      finalUrl: result.finalUrl,
      items: parseFeed(result.body.toString("utf8"), result.finalUrl),
    };
  } catch {
    return null;
  }
}

function feedDedupeKey(item: FeedItem): string {
  const raw = item.externalId?.replace(/\s+/g, " ").trim();
  if (raw && Buffer.byteLength(raw, "utf8") <= 494) return `feed:${raw}`;
  const identity = JSON.stringify([item.canonicalUrl, item.title, item.publishedAt?.toISOString()]);
  return `feed:${createHash("sha256").update(identity).digest("hex")}`;
}

export function feedUpdateCandidates(items: FeedItem[], observedAt: Date): UpdateCandidate[] {
  return items.slice(0, MAX_ITEMS).map((item) => ({
    sourceKind: "feed",
    dedupeKey: feedDedupeKey(item),
    canonicalUrl: item.canonicalUrl,
    title: item.title,
    summary: item.summary,
    beforeAfter: null,
    publishedAt: item.publishedAt,
    observedAt,
  }));
}

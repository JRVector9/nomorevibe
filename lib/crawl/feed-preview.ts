import { setTimeout as sleep } from "node:timers/promises";
import { fetchCapped, type CappedRequest } from "@/lib/net/fetch";
import type { FeedLinkRule } from "./feed-source-schema";
import { entryRepository, pageRepository, parseFeedEntries, selectFeedArticles } from "./feed-sources";

/**
 * 수집원 미리 보기(「수집원 추가」 세 번째 걸음) — 주소를 한 번 읽어 무엇이 들어올지 센다. 아무것도 쓰지 않는다(프론티어·설정·커서 그대로).
 * 요청은 수집 잡과 같은 길(fetchCapped — 모든 hop 의 SSRF 검사·크기 상한·시간 상한)이고, 글 페이지는 최근 글부터 pageLimit 개만 1초 간격으로 읽는다.
 * 사이트만 있는 글은 지금처럼 받지 않는다 — 건수만 보인다.
 */
export type FeedPreviewSample = { title: string; page: string; repo: string | null; state: "repo" | "site" | "failed" };
export type FeedPreview =
  | { ok: true; entries: number; spanHours: number | null; selected: number; perDay: number | null; skipped: number;
    /** 저장소를 확인한 글 수(글 페이지를 읽었거나 항목에서 정함) */
    checked: number; repos: number; siteOnly: number; failed: number;
    /** 고른 글 중 이번에 읽지 않은 것(글 페이지 상한) */
    unchecked: number; samples: FeedPreviewSample[] }
  | { ok: false; reason: string };

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;
const REQUEST_INTERVAL_MS = 1_000;

export async function previewFeedSource(source: { url: string; titlePrefix: string; link: FeedLinkRule },
  options: { request?: CappedRequest; pageLimit?: number; signal?: AbortSignal } = {}): Promise<FeedPreview> {
  const pageLimit = Math.max(0, Math.min(12, options.pageLimit ?? 10));
  const feed = await fetchCapped(source.url, { maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS, signal: options.signal, request: options.request });
  if (!feed.ok) return { ok: false, reason: feed.reason === "http" ? `http_${feed.status}` : feed.reason };
  if (feed.status !== 200) return { ok: false, reason: `http_${feed.status}` };
  let entries: ReturnType<typeof parseFeedEntries>;
  let picked: ReturnType<typeof selectFeedArticles>;
  try {
    entries = parseFeedEntries(feed.body.toString("utf8"));
    picked = selectFeedArticles(entries, { ...source, article: { kind: "link" } });
  } catch (error) {
    return { ok: false, reason: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "invalid_feed" };
  }
  const dates = entries.map(entry => entry.date).filter((value): value is number => value !== null);
  const spanHours = dates.length >= 2 ? (Math.max(...dates) - Math.min(...dates)) / 3_600_000 : null;
  const perDay = spanHours !== null && spanHours >= 1 ? picked.selected / (spanHours / 24) : null;
  const samples: FeedPreviewSample[] = [];
  // 최근 글부터 본다 — 고른 글은 오래된 것부터 줄 서 있다
  const newest = [...picked.articles].reverse();
  let requests = 0;
  const toCheck = source.link.kind === "page-title" ? newest.slice(0, pageLimit) : newest;
  for (const article of toCheck) {
    if (source.link.kind === "entry-link") {
      const repo = entryRepository(article);
      samples.push({ title: article.title, page: article.page, repo, state: repo ? "repo" : "site" });
      continue;
    }
    if (requests) await sleep(REQUEST_INTERVAL_MS, undefined, { signal: options.signal });
    requests++;
    const page = await fetchCapped(article.page, { maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS, signal: options.signal, request: options.request });
    const parsed = page.ok && page.status === 200 ? pageRepository(page.body.toString("utf8"), source.link) : null;
    samples.push(parsed?.ok ? { title: article.title, page: article.page, repo: parsed.repo, state: parsed.repo ? "repo" : "site" }
      : { title: article.title, page: article.page, repo: null, state: "failed" });
  }
  const count = (state: FeedPreviewSample["state"]) => samples.filter(sample => sample.state === state).length;
  return { ok: true, entries: entries.length, spanHours, selected: picked.articles.length, perDay, skipped: picked.skipped, checked: samples.length,
    repos: count("repo"), siteOnly: count("site"), failed: count("failed"), unchecked: picked.articles.length - samples.length, samples: samples.slice(0, 12) };
}

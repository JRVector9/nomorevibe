import { feedSources } from "@/lib/crawl/feed-sources";
import { ORACLE_KOREAN_SIGNAL } from "@/lib/crawl/korean-discovery/apply";
import { SHOW_HN_SIGNAL, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { sourceDefs, type SourceDef } from "./sources-model";

/**
 * 크롤 설정 → 수집원 정의(조각 4a) — 이름·신호·잡은 코드의 신호 정의에서 온다: 검색 신호 라벨(discover.queries), Show HN 신호,
 * 글 목록 수집원(첫 줄 Show GN, lib/crawl/feed-sources.ts), 한국어 발굴 신호(korean-discovery/apply.ts). DB 를 읽지 않는다.
 */
export function sourcesFromSettings(settings: CrawlSettings): SourceDef[] {
  const feeds = feedSources(settings.discover);
  return sourceDefs({ queries: settings.discover.queries, showHn: settings.discover.showHn, showHnSignal: SHOW_HN_SIGNAL, koreanSignal: ORACLE_KOREAN_SIGNAL,
    feeds: feeds.map(feed => ({ id: feed.id, url: feed.url, titlePrefix: feed.titlePrefix, link: feed.link, intervalMinutes: feed.intervalMinutes,
      priority: feed.priority, enabled: feed.enabled, requireEvidence: feed.requireEvidence, legacy: feed.legacy })),
    feedNames: Object.fromEntries(feeds.map(feed => [feed.id, feed.name])) });
}

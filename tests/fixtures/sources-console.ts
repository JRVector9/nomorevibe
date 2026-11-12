import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import type { SourcesRead } from "@/lib/operations/sources-read";
import { sourcesFromSettings } from "@/lib/operations/sources-defs";
import type { SignalStateRow } from "@/lib/operations/sources-model";

/**
 * 수집·작업 화면(조각 4a)의 고정 읽기 — 시안 probe(2026-11-12 found24·funnel7·jobs)의 모양을 줄였다.
 * 지금 시각 2026-11-12T03:00:00Z. 소개 검수는 LLM 작업이라 이 화면에 없다 — 대신 원본 수집을 사람이 멈춰 둔 것으로 둔다.
 */
export const SOURCES_NOW = "2026-11-12T03:00:00.000Z";
const ago = (minutes: number) => new Date(Date.parse(SOURCES_NOW) - minutes * 60_000).toISOString();

export function sourcesFixtureSettings(): CrawlSettings {
  const settings = structuredClone(DEFAULT_CRAWL_SETTINGS);
  settings.enabled = true;
  settings.discover.feeds = [{ id: "lobste-rs-1a2b3c", name: "Lobsters Show", url: "https://lobste.rs/t/show.rss", titlePrefix: "Show Lobsters:",
    link: { kind: "entry-link" }, intervalMinutes: 60, priority: 90, enabled: false }];
  return settings;
}

export const SOURCES_FUNNEL: SignalStateRow[] = [
  { signal: "Claude 커밋 트레일러", state: "published", n7: 6_000, n24: 700 },
  { signal: "Claude 커밋 트레일러", state: "rejected", n7: 60_000, n24: 7_000 },
  { signal: "Claude 커밋 트레일러", state: "none", n7: 20_000, n24: 3_000 },
  { signal: "Codex 커밋 트레일러", state: "published", n7: 2_580, n24: 300 },
  { signal: "Codex 커밋 트레일러", state: "rejected", n7: 24_212, n24: 2_199 },
  { signal: "Show HN", state: "rejected", n7: 217, n24: 40 },
  { signal: "Show HN", state: "needs_review", n7: 7, n24: 2 },
  { signal: "Show HN", state: "approved", n7: 4, n24: 1 },
  { signal: "Show HN", state: "published", n7: 35, n24: 5 },
  { signal: "Show HN", state: "new", n7: 2, n24: 2 },
  { signal: "Show GN", state: "published", n7: 1, n24: 1 },
  { signal: "Show GN", state: "none", n7: 1, n24: 1 },
  { signal: "review-source-refresh", state: "needs_review", n7: 12, n24: 3 },
];

export function sourcesFixtureRead(): SourcesRead {
  const settings = sourcesFixtureSettings();
  const job = (name: string, patch: Partial<SourcesRead["jobs"] extends (infer T)[] | null ? T : never> = {}) => ({ name, lastRunAt: ago(1), lastSuccessAt: ago(1),
    lastError: null, notBefore: null, nextScheduledAt: ago(-1), lockedAt: null, ...patch });
  return {
    checkedAt: SOURCES_NOW, settings, defs: sourcesFromSettings(settings), funnel: { rows: SOURCES_FUNNEL, measuredAt: ago(2) },
    jobs: [job("crawl-seed", { lastSuccessAt: ago(0.5) }), job("hn-show-seed", { lastSuccessAt: ago(20) }), job("gn-show-seed", { lastSuccessAt: ago(20) }),
      job("crawl-ko-apply"), job("crawl-fetch", { notBefore: "2126-11-04T00:00:00.000Z" }), job("crawl-judge", { lastSuccessAt: ago(4) }),
      job("uptime-ping"), job("product-embedding"), job("product-search-refresh"),
      job("product-evidence-refresh", { lastError: "[57014] canceling statement due to statement timeout" }),
      job("bluesky-talk", { lastSuccessAt: ago(100) }), job("product-stars-refresh", { lastSuccessAt: ago(4) })],
    pauses: [{ job: "crawl-fetch", actor: "JR", at: "2026-11-04T01:00:00.000Z", reason: "원본 서버 점검" }],
    degraded: [{ job: "hn-talk", code: "search_failed", detail: "HTTP 503", streak: 3, since: ago(90) }],
    intervals: { overrides: { "crawl-judge": 600_000 }, revision: 42 },
    waiting: { "crawl-fetch": 120, "crawl-judge": 0, "uptime-ping": 3_234, "product-evidence-refresh": 2_116 },
    embedding: { public: 78_930, embedded: 78_919, measuredAt: ago(3) },
    servers: [{ name: "임베딩", ok: true }, { name: "재정렬", ok: false, error: "연결 실패" }],
    versions: { "crawl-fetch": 31_000 }, feedReads: {},
  };
}

/**
 * 크롤 설정 화면의 계산 — 서버 페이지(요약·목차)와 클라이언트 폼이 함께 쓴다.
 * "use client" 모듈의 함수는 서버에서 부를 수 없어서 따로 둔다.
 */
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { JOB_CATALOG } from "@/lib/jobs/catalog";

/** GitHub 검색 한도 — 분당 30회 */
const SEARCH_LIMIT_PER_HOUR = 30 * 60;
/** 수집(crawl-seed)이 도는 간격(분) — 틱당 페이지가 곧 틱당 검색 횟수다 */
export const SEED_INTERVAL_MINUTES = (JOB_CATALOG.find((job) => job.name === "crawl-seed")?.intervalMs ?? 600_000) / 60_000;

/** 틱당 페이지 → 시간당 검색 수와 한도 대비 */
export function searchUsage(pagesPerTick: number): { perHour: number; percent: string } {
  const perHour = Math.round((60 / SEED_INTERVAL_MINUTES) * pagesPerTick);
  return { perHour, percent: `${((perHour / SEARCH_LIMIT_PER_HOUR) * 100).toFixed(1)}%` };
}

export const LIST_KEYS = ["blockedHomepageDomains", "thirdPartyHosts", "stubPageTitles", "excludedRepoPatterns", "heldRepoPatterns"] as const;
export type ListKey = (typeof LIST_KEYS)[number];

/** 코드 기본값에 있는데 저장된 목록에 없는 것 — 새 기본값이 저장된 값에 막혀 닿지 못한 것이다 */
export function missingDefaults(key: ListKey, items: readonly string[]): string[] {
  return DEFAULT_CRAWL_SETTINGS.judge[key].filter((item) => !items.includes(item));
}

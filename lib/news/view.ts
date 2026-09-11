import type { NewsFilter, PublicNewsItem } from "./repository";
import { NEWS_VENDORS, type NewsSection } from "./sources";

/** 목록 한 줄. 같은 도구가 같은 날 낸 릴리스는 최신 것 아래로 접힌다 */
export type NewsRow = { item: PublicNewsItem; more: PublicNewsItem[] };
export type NewsDay = { day: string; label: string; rows: NewsRow[] };

const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
const DAY_LABEL = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "long" });

export const kstDay = (at: Date) => DAY.format(at);

/**
 * 릴리스를 접는다.
 *
 * Claude Code 는 하루에도 두세 번 낸다. 한 줄씩 늘어놓으면 회사 발표가 릴리스 번호 사이에
 * 묻힌다 — 같은 도구·같은 날(KST)은 최신 것 한 줄에 "N건 더"로 모은다. 발표는 접지 않는다.
 * 입력은 최신부터 정렬돼 있어야 한다. 첫 번째가 대표가 된다.
 */
export function foldReleases(items: PublicNewsItem[]): NewsRow[] {
  const rows: NewsRow[] = [];
  const byDay = new Map<string, NewsRow>();
  for (const item of items) {
    if (item.section !== "release") {
      rows.push({ item, more: [] });
      continue;
    }
    const key = `${item.sourceKey}:${kstDay(item.publishedAt)}`;
    const existing = byDay.get(key);
    if (existing) {
      existing.more.push(item);
      continue;
    }
    const row = { item, more: [] };
    byDay.set(key, row);
    rows.push(row);
  }
  return rows;
}

/** 날짜(KST)별로 묶는다. 순서는 그대로 */
export function groupByDay(rows: NewsRow[]): NewsDay[] {
  const days: NewsDay[] = [];
  for (const row of rows) {
    const day = kstDay(row.item.publishedAt);
    const last = days.at(-1);
    if (last?.day === day) last.rows.push(row);
    else days.push({ day, label: DAY_LABEL.format(row.item.publishedAt), rows: [row] });
  }
  return days;
}

/**
 * 주소의 거르기(?company=openai&kind=news). 모르는 값은 버린다 — 전체로 보인다.
 * 소식 페이지와 두 피드가 같은 규칙을 쓴다. 피드를 받아 가는 쪽이 페이지 주소를 그대로 옮겨 쓸 수 있게.
 */
export function parseNewsFilter(params: { company?: string | null; kind?: string | null }): NewsFilter {
  const vendor = NEWS_VENDORS.find((entry) => entry.slug === params.company)?.name;
  const section: NewsSection | undefined = params.kind === "news" || params.kind === "release" ? params.kind : undefined;
  return { ...(vendor ? { vendor } : {}), ...(section ? { section } : {}) };
}

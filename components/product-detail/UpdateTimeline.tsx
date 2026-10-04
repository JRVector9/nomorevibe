"use client";

import { useState } from "react";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { formatDate, safeExternalUrl } from "./format";

type Filter = "all" | "maker" | "automatic";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "전체" },
  { key: "maker", label: "메이커" },
  { key: "automatic", label: "자동 감지" },
];
/** 처음에 보여 주는 줄 수 — PostHog 는 30일에 179건이라 다 펼치면 페이지가 그것으로 가득 찬다 */
const FIRST = 8;
const DAY = 86_400_000;

function monthDay(date: Date): string {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric" }).format(date);
}

/** 최근 30일 안의 건수 — 발행일이 없으면 처음 본 날로 센다 */
function countRecent(updates: ProductDetailView["updates"]): number {
  const since = Date.now() - 30 * DAY;
  return updates.filter((update) => (update.publishedAt ?? update.observedAt).getTime() >= since).length;
}

/** 업데이트 — 한 건이 한 줄(날짜 · 제목 · 출처). 처음엔 여덟 줄, 나머지는 '모두 보기'로 */
export function UpdateTimeline({ updates }: { updates: ProductDetailView["updates"] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState(false);
  const visible = updates.filter((update) => (
    filter === "all" || (filter === "maker" ? update.sourceKind === "maker" : update.sourceKind !== "maker")
  ));
  const recent = countRecent(updates);
  const rows = expanded ? visible : visible.slice(0, FIRST);

  return (
    <section aria-labelledby="updates-title" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="updates-title" className="m-0 flex items-baseline gap-2 text-[13px] font-semibold tracking-[0.02em] text-fg-3">
          업데이트
          <span className="font-normal tabular-nums">
            {recent > 0 ? `최근 30일 ${recent.toLocaleString("ko-KR")}건` : `${updates.length.toLocaleString("ko-KR")}건`}
          </span>
        </h2>
        <div className="inline-flex gap-0.5 rounded-full bg-bg-soft p-0.5" role="tablist" aria-label="업데이트 출처 필터">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              onClick={() => setFilter(item.key)}
              aria-selected={filter === item.key}
              className={`inline-flex h-10 items-center rounded-full px-3.5 text-[13px] ${
                filter === item.key ? "bg-bg-card font-medium text-fg shadow-[0_1px_4px_rgba(0,0,0,0.08)]" : "text-fg-3 hover:text-fg"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="m-0 text-[14px] text-fg-2">
          {updates.length === 0 ? "아직 감지된 업데이트가 없습니다. GitHub 릴리스가 나오면 여기에 보입니다." : "이 출처의 업데이트는 없습니다."}
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col border-t border-line p-0">
          {rows.map((update) => {
            const sourceUrl = safeExternalUrl(update.canonicalUrl);
            const date = update.publishedAt ?? update.observedAt;
            return (
              <li key={update.id} className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3.5 border-b border-line py-[9px]">
                <time dateTime={date.toISOString()} title={formatDate(date)} className="text-[13px] text-fg-3 tabular-nums">{monthDay(date)}</time>
                {sourceUrl
                  ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="truncate text-[13px] text-fg hover:underline">{update.title}</a>
                  : <span className="truncate text-[13px] text-fg">{update.title}</span>}
                <span className="whitespace-nowrap text-[13px] text-fg-3">
                  {update.sourceKind === "github_release" ? "GitHub 릴리스" : update.sourceLabel}{sourceUrl ? " ↗" : ""}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {visible.length > FIRST && (
        <button type="button" onClick={() => setExpanded((value) => !value)} className="inline-flex min-h-11 items-center self-start text-[13px] text-accent-ink hover:underline">
          {expanded ? "접기" : `${visible.length.toLocaleString("ko-KR")}건 모두 보기 ›`}
        </button>
      )}
    </section>
  );
}

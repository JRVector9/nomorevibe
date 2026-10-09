"use client";

import { useState } from "react";
import { formatCount } from "@/lib/format/number";
import { formatPublicDate } from "@/lib/format/time";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { safeExternalUrl } from "./format";

type Filter = "all" | "maker" | "automatic";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "전체" },
  { key: "maker", label: "메이커" },
  { key: "automatic", label: "자동 감지" },
];
/** 처음에 보여 주는 줄 수 — PostHog 는 30일에 179건이라 다 펼치면 페이지가 그것으로 가득 찬다 */
const FIRST = 8;
const DAY = 86_400_000;

/** 최근 30일 안의 건수 — 발행일이 없으면 처음 본 날로 센다 */
function countRecent(updates: ProductDetailView["updates"], now: Date): number {
  const since = now.getTime() - 30 * DAY;
  return updates.filter((update) => (update.publishedAt ?? update.observedAt).getTime() >= since).length;
}

/**
 * 업데이트 — 한 건이 한 줄(날짜 · 제목 · 출처). 처음엔 여덟 줄, 나머지는 '모두 보기'로.
 * now 는 서버가 읽은 시각이다 — 날짜의 '올해'와 30일 셈을 서버·브라우저가 같게 낸다.
 */
export function UpdateTimeline({ updates, now }: { updates: ProductDetailView["updates"]; now: Date }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState(false);
  const visible = updates.filter((update) => (
    filter === "all" || (filter === "maker" ? update.sourceKind === "maker" : update.sourceKind !== "maker")
  ));
  const recent = countRecent(updates, now);
  const rows = expanded ? visible : visible.slice(0, FIRST);
  // 해가 다른 날짜("2025년 10월 8일")가 보이면 날짜 칸을 넓힌다 — 줄마다 같은 너비라야 제목이 한 줄로 맞는다
  const wide = rows.some((update) => formatPublicDate(update.publishedAt ?? update.observedAt, now).includes("년"));

  return (
    <section aria-labelledby="updates-title" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="updates-title" className="m-0 flex items-baseline gap-2 text-[13px] font-semibold tracking-[0.02em] text-fg-2">
          업데이트
          <span className="font-normal tabular-nums">
            {recent > 0 ? `최근 30일 ${formatCount(recent)}건` : `${formatCount(updates.length)}건`}
          </span>
        </h2>
        {/* 필터도 누르는 단추라 다른 단추처럼 44px */}
        <div className="inline-flex gap-0.5 rounded-full bg-bg-soft p-0.5" role="tablist" aria-label="업데이트 출처 필터">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              onClick={() => setFilter(item.key)}
              aria-selected={filter === item.key}
              className={`inline-flex h-11 items-center rounded-full px-3.5 text-[13px] ${
                filter === item.key ? "bg-bg-card font-medium text-fg shadow-[0_1px_4px_rgba(0,0,0,0.08)]" : "text-fg-2 hover:text-fg"
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
              <li key={update.id} className={`grid ${wide ? "grid-cols-[112px_minmax(0,1fr)_auto]" : "grid-cols-[64px_minmax(0,1fr)_auto]"} items-center gap-3.5 border-b border-line py-[9px]`}>
                <time dateTime={date.toISOString()} className="text-[13px] text-fg-2 tabular-nums">{formatPublicDate(date, now)}</time>
                {sourceUrl
                  ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="truncate text-[13px] text-fg hover:underline">{update.title}</a>
                  : <span className="truncate text-[13px] text-fg">{update.title}</span>}
                <span className="whitespace-nowrap text-[13px] text-fg-2">
                  {update.sourceKind === "github_release" ? "GitHub 릴리스" : update.sourceLabel}{sourceUrl ? " ↗" : ""}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {visible.length > FIRST && (
        <button type="button" onClick={() => setExpanded((value) => !value)} className="inline-flex min-h-11 items-center self-start text-[13px] text-accent-ink hover:underline">
          {expanded ? "접기" : `${formatCount(visible.length)}건 모두 보기 ›`}
        </button>
      )}
    </section>
  );
}

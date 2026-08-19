"use client";

import { useState } from "react";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { formatDate, safeExternalUrl } from "./format";
import { SourceBadge } from "./SourceBadge";

type Filter = "all" | "maker" | "automatic";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "전체" },
  { key: "maker", label: "메이커" },
  { key: "automatic", label: "자동 감지" },
];

export function UpdateTimeline({ updates }: { updates: ProductDetailView["updates"] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const visible = updates.filter((update) => (
    filter === "all" || (filter === "maker" ? update.sourceKind === "maker" : update.sourceKind !== "maker")
  ));

  return (
    <section className="rounded-[12px] border border-line bg-bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-extrabold text-fg">업데이트</h2>
          <p className="mt-1 text-[13px] leading-5 text-fg-3">메이커 소식과 자동 감지 내역을 한곳에서 확인합니다.</p>
        </div>
        <div className="flex gap-1 rounded-[10px] bg-bg-soft p-1" aria-label="업데이트 출처 필터">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              aria-pressed={filter === item.key}
              className={`min-h-11 rounded-[8px] px-3 text-[13px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                filter === item.key ? "bg-bg-card text-accent shadow-sm" : "text-fg-3 hover:text-fg"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="mt-5 rounded-[10px] bg-bg-soft px-4 py-6 text-center text-[13px] text-fg-3">표시할 업데이트가 없습니다.</p>
      ) : (
        <div className="mt-5 space-y-3">
          {visible.map((update) => {
            const sourceUrl = safeExternalUrl(update.canonicalUrl);
            return (
              <article key={update.id} className="rounded-[10px] border border-line px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <SourceBadge label={update.sourceLabel} />
                  <time className="text-[13px] text-fg-3">{formatDate(update.publishedAt ?? update.observedAt)}</time>
                </div>
                <h3 className="mt-3 font-extrabold leading-6 text-[14px] text-fg">{update.title}</h3>
                {update.summary && <p className="mt-1.5 text-[14px] leading-6 text-fg-2">{update.summary}</p>}
                {update.beforeAfter && (
                  <p className="mt-3 overflow-hidden text-ellipsis rounded-[8px] bg-bg-soft px-3 py-2 font-mono text-[13px] text-fg-3">
                    {JSON.stringify(update.beforeAfter).slice(0, 500)}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px]">
                  {update.makerEditedAt && <span className="text-fg-3">메이커가 {formatDate(update.makerEditedAt)} 수정</span>}
                  {sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent hover:underline">원문 보기 ↗</a>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

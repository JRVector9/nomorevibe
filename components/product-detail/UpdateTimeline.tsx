"use client";

import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber, formatDate } from "@/lib/i18n/format";
import type { TimelineSummary } from "./client-data";
import { safeExternalUrl } from "./format";

/**
 * 업데이트 — 출처를 섞어 최신 세 줄(날짜 · 제목 · 출처)만 표시한다.
 * 세 줄과 건수(전체·최근 30일)는 서버가 정해 넘긴다(client-data.ts timelineSummary) — 나머지 업데이트는 브라우저로 보내지 않는다.
 * now 는 서버가 읽은 시각이다 — 날짜의 '올해'를 서버·브라우저가 같게 낸다.
 */
export function UpdateTimeline({ summary: { rows, total, recent }, now }: { summary: TimelineSummary; now: Date }) {
  const t = useTranslations("detail");
  const locale = useLocale();
  // 해가 다른 날짜("2025년 10월 8일")가 보이면 날짜 칸을 넓힌다 — 줄마다 같은 너비라야 제목이 한 줄로 맞는다
  const year = new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" });
  const wide = locale !== "ko" || rows.some((update) => year.format(update.publishedAt ?? update.observedAt) !== year.format(now));

  return (
    <section aria-labelledby="updates-title" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="updates-title" className="m-0 flex items-baseline gap-2 text-[13px] font-semibold tracking-[0.02em] text-fg-2">
          {t("updates.title")}
          <span className="font-normal tabular-nums">
            {recent > 0 ? t("updates.recent", { count: formatNumber(recent, locale) }) : t("updates.count", { count: formatNumber(total, locale) })}
          </span>
        </h2>
        <span className="text-[13px] text-fg-2">{t("updates.filter.all")}</span>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 text-[14px] text-fg-2">{t("updates.empty")}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col border-t border-line p-0">
          {rows.map((update) => {
            const sourceUrl = safeExternalUrl(update.canonicalUrl);
            const date = update.publishedAt ?? update.observedAt;
            return (
              <li key={update.id} className={`grid ${wide ? "grid-cols-[112px_minmax(0,1fr)_auto]" : "grid-cols-[64px_minmax(0,1fr)_auto]"} items-center gap-3.5 border-b border-line py-[9px]`}>
                <time dateTime={date.toISOString()} className="text-[13px] text-fg-2 tabular-nums">{formatDate(date, now, locale)}</time>
                {sourceUrl
                  ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="truncate text-[13px] text-fg hover:underline">{update.title}</a>
                  : <span className="truncate text-[13px] text-fg">{update.title}</span>}
                <span className="whitespace-nowrap text-[13px] text-fg-2">
                  {update.sourceKind === "github_release" ? t("updates.release") : t(update.sourceKind === "maker" ? "updates.maker" : "updates.automatic")}{sourceUrl ? " ↗" : ""}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

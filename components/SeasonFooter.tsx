import Link from "next/link";
import { seasonLabel } from "@/lib/domain/ranking/season-label";
import { RANKING_STALE_MS, type SeasonSummary } from "@/lib/domain/ranking/view";
import { createTranslator, type Dictionary } from "@/lib/i18n/messages";
import { browse as koreanBrowse } from "@/messages/ko/browse";
import { formatNumber, formatDateTime, formatRelativeTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { translatedSeason } from "./home/i18n";
import { localePath } from "@/lib/i18n/routing";

/**
 * 푸터의 시즌 한 줄.
 *
 * 현재 시즌이 언제부터 언제까지이고, 경계가 처리됐는지, 공개 순위 스냅샷이 얼마나 묵었는지.
 * 목록을 보는 동안 필요한 정보가 아니라 "지금 어떤 규칙으로 세고 있나"를 확인할 때 찾는
 * 것이라 푸터에 둔다. 카드가 아니라 푸터 글자 크기(13px)로 맞춘다.
 * 순위에 오른 제품이 없는 시즌은 슬롯(app/@seasonfooter/page.tsx)이 이 줄을 아예 그리지 않는다(UX-09).
 */
function remainingTime(endsAt: Date, now: Date, locale: Locale, t: Translator<"browse">): string {
  const milliseconds = endsAt.getTime() - now.getTime();
  if (milliseconds <= 0) return t("season.boundaryPending");
  const hours = Math.ceil(milliseconds / 3_600_000);
  return hours < 24 ? t("season.hoursRemaining", { count: formatNumber(hours,locale) }) : t("season.daysRemaining", { count: formatNumber(Math.ceil(hours/24),locale) });
}

function snapshotAge(refreshedAt: Date | null, now: Date, locale: Locale, t: Translator<"browse">): string {
  if (!refreshedAt) return t("season.snapshotPending");
  const age = Math.max(0, now.getTime()-refreshedAt.getTime());
  return `${t("season.snapshot", { time: formatRelativeTime(refreshedAt,now,locale) })}${age > RANKING_STALE_MS ? ` · ${t("season.stale")}` : ""}`;
}

export function SeasonFooter({
  season,
  latestClosed,
  now,
  locale = "ko",
  messages,
}: {
  locale?: Locale;
  messages?: Dictionary["browse"];
  season: SeasonSummary;
  /** 순위에 오른 제품이 있는 지난 시즌만 — 빈 시즌으로는 보내지 않는다 */
  latestClosed: SeasonSummary | null;
  now: Date;
}) {
  const t = createTranslator("browse", messages ?? koreanBrowse);
  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-4">
      <span className="font-bold text-fg">{translatedSeason(season.key,seasonLabel(season.key),t)}</span>
      <span className="text-fg-2">
        {formatDateTime(season.startsAt,now,locale)} – {formatDateTime(season.endsAt,now,locale)}
      </span>
      <span className="font-semibold text-accent">{remainingTime(season.endsAt,now,locale,t)}</span>
      <span>{snapshotAge(season.refreshedAt,now,locale,t)}</span>
      <div className="ml-auto flex gap-3 font-semibold">
        <Link prefetch={false} href={localePath(locale,`/rankings/${season.key}`)} className="inline-flex min-h-11 items-center text-accent hover:underline">{t("season.currentRanking")}</Link>
        {latestClosed && (
          <Link prefetch={false} href={localePath(locale,`/rankings/${latestClosed.key}`)} className="inline-flex min-h-11 items-center text-fg-2 hover:text-fg">{t("season.previous")}</Link>
        )}
      </div>
    </div>
  );
}

import type { StarGrowthSnapshot } from "@/lib/domain/products/star-growth";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { formatNumber } from "@/lib/i18n/format";
import { formatCount } from "@/lib/format/number";

export const STAR_GROWTH_TITLE = "최근 8시간 스타 급상승";

export function starGrowthNote(snapshot: StarGrowthSnapshot | null, locale: Locale = "ko", t?: Translator<"browse">) {
  const min = snapshot?.policy?.minStars ?? 50;
  const max = (snapshot?.policy?.maxStarsExclusive ?? 2000) - 1;
  return t ? t("growth.note", { min: formatNumber(min, locale), max: formatNumber(max, locale) })
    : `스타 ${formatCount(min)}~${formatCount(max)}개 · 직전 8시간 회차 대비 증가량순 · 8시간마다 갱신`;
}


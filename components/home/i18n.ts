import { CATEGORIES } from "@/lib/domain/products/categories";
import type { Translator, MessageSchemas } from "@/lib/i18n/messages";

/** Unknown user-provided category text stays intact. */
export function translatedCategory(category: string, t: Translator<"labels">): string {
  return CATEGORIES.some((key) => key === category)
    ? t(`category.${category}` as Extract<keyof MessageSchemas["labels"], `category.${string}`>) : category;
}

/** Presentation only; persisted season keys and KST boundaries never change. */
export function translatedSeason(key: string, fallback: string, t: Translator<"browse">): string {
  const match = /^(\d{4})-(?:W(\d{2})|(\d{2}))(?:-transition-\d{4}(\d{2})(\d{2}))?$/.exec(key);
  if (!match) return fallback;
  const [,year,week,month,fromMonth,fromDay] = match;
  const period = week ? t("season.weekLabel", {year,week:String(Number(week))}) : t("season.monthLabel", {year,month:String(Number(month))});
  return fromMonth ? t("season.transitionLabel", {period,month:String(Number(fromMonth)),day:String(Number(fromDay))}) : period;
}

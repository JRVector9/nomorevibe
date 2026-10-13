import { CATEGORIES } from "@/lib/domain/products/categories";
import type { Translator, MessageSchemas } from "@/lib/i18n/messages";

/** Unknown user-provided category text stays intact. */
export function translatedCategory(category: string, t: Translator<"labels">): string {
  return CATEGORIES.some((key) => key === category)
    ? t(`category.${category}` as Extract<keyof MessageSchemas["labels"], `category.${string}`>) : category;
}

/** Presentation only; persisted season keys and KST boundaries never change. */
export function translatedSeason(key: string, fallback: string, t: Translator<"browse">): string {
  const week = /^(\d{4})-W(\d{2})$/.exec(key);
  if (week) return t("season.weekLabel", { year: week[1], week: String(Number(week[2])) });
  const month = /^(\d{4})-(\d{2})$/.exec(key);
  return month ? t("season.monthLabel", { year: month[1], month: String(Number(month[2])) }) : fallback;
}

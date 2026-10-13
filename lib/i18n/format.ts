import { LOCALE_CONFIG, type Locale } from "./locales";
import { formatAgo, formatPublicDate, formatPublicDateTime, toDate, type TimeInput } from "@/lib/format/time";

/** Formatting never changes the shared KST ranking or observation boundaries. */
export function formatNumber(value: number | null | undefined, locale: Locale, empty = "—"): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat(LOCALE_CONFIG[locale].intl).format(value) : empty;
}

function publicDate(value: TimeInput, now: TimeInput, locale: Locale, withTime: boolean): string {
  const date = toDate(value), base = toDate(now);
  if (!date || !base) return "—";
  if (locale === "ko") return withTime ? formatPublicDateTime(date, base) : formatPublicDate(date, base);
  const year = new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" });
  return new Intl.DateTimeFormat(LOCALE_CONFIG[locale].intl, {
    timeZone: "Asia/Seoul", month: "short", day: "numeric",
    ...(year.format(date) === year.format(base) ? {} : { year: "numeric" }),
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
  }).format(date);
}

export const formatDate = (value: TimeInput, now: TimeInput, locale: Locale): string => publicDate(value, now, locale, false);
export const formatDateTime = (value: TimeInput, now: TimeInput, locale: Locale): string => publicDate(value, now, locale, true);

/** Callers serialize the same server now for initial server and client rendering. */
export function formatRelativeTime(value: TimeInput, now: TimeInput, locale: Locale): string {
  const date = toDate(value), base = toDate(now);
  if (!date || !base) return "—";
  if (locale === "ko") return formatAgo(date, base);
  const seconds = Math.trunc((date.getTime() - base.getTime()) / 1_000);
  const size = Math.abs(seconds);
  const unit = size < 3_600 ? "minute" : size < 86_400 ? "hour" : "day";
  const divisor = unit === "minute" ? 60 : unit === "hour" ? 3_600 : 86_400;
  return new Intl.RelativeTimeFormat(LOCALE_CONFIG[locale].intl, { numeric: "auto" })
    .format(size < 60 ? 0 : Math.sign(seconds) * Math.floor(size / divisor), size < 60 ? "second" : unit);
}

"use client";

import Link from "next/link";
import type { StarGrowthSnapshot } from "@/lib/domain/products/star-growth";
import { formatNumber, formatDateTime } from "@/lib/i18n/format";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";

export { STAR_GROWTH_TITLE, starGrowthNote } from "./star-growth-copy";

const REASONS = {
  "run-not-closed": "growth.notClosed", "run-failed": "growth.failed", "missing-baseline": "growth.baseline",
  "baseline-not-closed": "growth.baselineNotClosed", "invalid-policy": "growth.invalidPolicy", "invalid-cycle": "growth.invalidCycle",
  "cycle-changed": "growth.changed", "filtered-out": "growth.filteredOut", "no-comparable-observations": "growth.noComparable",
} as const;

/** Home and full list expose the same closed cycle and unavailable-data state. */
export function StarGrowthSummary({ snapshot, now }: { snapshot: StarGrowthSnapshot | null; now: Date | string }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const count = (n: number) => formatNumber(n, locale);
  if (!snapshot) return <p className="row-note" role="status">{t("growth.unavailable")} <Link prefetch={false} href={localePath(locale, "/rising")}>{t("growth.refresh")}</Link></p>;
  const countsKnown = snapshot.targetCount !== null && snapshot.successCount !== null && snapshot.failureCount !== null;
  const rate = countsKnown && snapshot.targetCount! > 0 ? Math.round(snapshot.successCount! / snapshot.targetCount! * 100) : null;
  const expired = snapshot.reason === "cycle-changed" || snapshot.reason === "invalid-cycle";
  const message = snapshot.reason === "missing-run" ? t(snapshot.status === "warming" ? "growth.warming" : "growth.missingRun")
    : snapshot.reason === "below-threshold" ? t("growth.noGains", { count: count(snapshot.comparableCount) })
      : snapshot.reason && snapshot.reason in REASONS ? t(REASONS[snapshot.reason as keyof typeof REASONS]) : null;
  return <>
    <p className="row-note">{t("growth.cycle", { asOf: formatDateTime(snapshot.asOf, now, locale), next: formatDateTime(snapshot.nextCycle, now, locale) })}</p>
    <p className="row-note">{countsKnown ? t("growth.counts", { success: count(snapshot.successCount!), target: count(snapshot.targetCount!), rate: rate === null ? "" : ` (${count(rate)}%)`, failure: count(snapshot.failureCount!) }) : t("growth.unknownCounts")}</p>
    {message && <p className="row-note" role="status">{message}{expired && <> <Link prefetch={false} href={localePath(locale, "/rising")}>{t("growth.refresh")}</Link></>}</p>}
  </>;
}

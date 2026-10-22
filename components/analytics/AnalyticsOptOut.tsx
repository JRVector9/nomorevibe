"use client";

import { useSyncExternalStore } from "react";
import { analyticsSnapshot, setAnalyticsOptOut, subscribeAnalytics, type AnalyticsSnapshot } from "@/lib/analytics/client";
import { useTranslations } from "@/lib/i18n/context";

const serverSnapshot = (): AnalyticsSnapshot | null => null;

/** 상태 문구 키 — 켜짐·끔·브라우저 신호·지역·쓰지 않음 */
export function optOutStatusKey(snapshot: AnalyticsSnapshot, enabled: boolean) {
  if (!enabled || snapshot.reason === "disabled") return "analytics.statusDisabled" as const;
  switch (snapshot.reason) {
    case "opt_out": return "analytics.statusOptOut" as const;
    case "gpc": return "analytics.statusGpc" as const;
    case "dnt": return "analytics.statusDnt" as const;
    case "region": return "analytics.statusRegion" as const;
    default: return snapshot.status === "on" ? "analytics.statusOn" as const : null;
  }
}

/**
 * 방문 분석 끄기·다시 켜기(2026-10-22) — 이 브라우저에만 기억한다(localStorage). 누르면 그 자리에서 분석이 멈춘다.
 *
 * - footer: 켜져 있으면 '끄기', 이 단추로 껐으면 '다시 켜기'. 브라우저 신호·지역으로 꺼져 있으면 아무것도 그리지 않는다.
 * - policy: 지금 상태를 한 줄로 알리고 같은 단추를 둔다.
 * 서버 HTML 에는 그리지 않는다 — 상태는 브라우저에서만 안다.
 */
export function AnalyticsOptOut({ variant, enabled }: { variant: "footer" | "policy"; enabled: boolean }) {
  const t = useTranslations("common");
  const snapshot = useSyncExternalStore(subscribeAnalytics, analyticsSnapshot, serverSnapshot);
  if (!snapshot) return null;
  const canOptOut = enabled && snapshot.status === "on";
  const canOptIn = enabled && snapshot.reason === "opt_out";
  const button = canOptOut || canOptIn ? (
    <button type="button" className={variant === "footer" ? "footer-analytics" : "min-h-11 rounded-lg border border-line px-4 text-[14px] font-semibold"} aria-pressed={canOptIn}
      onClick={() => setAnalyticsOptOut(canOptOut)}>
      {canOptOut ? t("analytics.optOut") : t("analytics.optIn")}
    </button>
  ) : null;
  if (variant === "footer") return button;
  const status = optOutStatusKey(snapshot, enabled);
  if (!status && !button) return null;
  return (
    <p className="analytics-control flex flex-wrap items-center gap-x-3 gap-y-2" role="status">
      {status && <span>{t(status)}</span>}
      {button}
    </p>
  );
}

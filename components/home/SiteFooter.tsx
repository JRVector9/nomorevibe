import Link from "next/link";
import { BRAND } from "@/lib/copy/brand";
import { createTranslator, type Dictionary } from "@/lib/i18n/messages";
import type { Locale } from "@/lib/i18n/locales";
import { localePath } from "@/lib/i18n/routing";
import { AnalyticsOptOut } from "@/components/analytics/AnalyticsOptOut";
import "./chrome.css";

export function SiteFooter({ children, locale, messages, analyticsEnabled = false }: {
  children: React.ReactNode; locale: Locale; messages: Dictionary["common"]; analyticsEnabled?: boolean;
}) {
  const t = createTranslator("common", messages);
  return (
    <footer className="nmb-footer">
      <div className="wrap">
        {children}
        <div className="footer">
          <div>
            <span className="footer-brand">{BRAND}</span>
            {t("footer.slogan")}
          </div>
          <div className="footer-right">
            <Link prefetch={false} href={localePath(locale, "/?metric=all")}>{t("footer.metrics")}</Link>
            <Link href={localePath(locale, "/launch")}>{t("navigation.launch")}</Link>
            <Link prefetch={false} href={localePath(locale, "/policy#listing")}>{t("footer.listingPolicy")}</Link>
            {/* 방문 분석 끄기 — 정책 화면 #analytics 에도 같은 단추가 있다 */}
            <AnalyticsOptOut variant="footer" enabled={analyticsEnabled} />
          </div>
        </div>
      </div>
    </footer>
  );
}

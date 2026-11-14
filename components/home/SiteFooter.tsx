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
    <footer className="nmb-footer" data-track-nav="footer">
      <TrapLink />
      <div className="wrap">
        {children}
        <div className="footer">
          <div>
            <span className="footer-brand">{BRAND}</span>
            {t("footer.slogan")}
          </div>
          <div className="footer-right">
            <Link prefetch={false} href={localePath(locale, "/?metric=all")}>{t("footer.metrics")}</Link>
            <Link prefetch={false} href={localePath(locale, "/launch")}>{t("navigation.launch")}</Link>
            <Link prefetch={false} href={localePath(locale, "/policy#listing")}>{t("footer.listingPolicy")}</Link>
            {/* 방문 분석 끄기 — 정책 화면 #analytics 에도 같은 단추가 있다 */}
            <AnalyticsOptOut variant="footer" enabled={analyticsEnabled} />
          </div>
        </div>
      </div>
    </footer>
  );
}

/** 함정 링크가 가리키는 주소 — app/api/catalog/[[...path]]/route.ts. /api/ 는 robots.txt 에서 Disallow 다 */
export const TRAP_PATH = "/api/catalog/export.json";

/**
 * 사람 눈과 보조 기술에는 보이지 않는 링크. robots.txt 를 무시하고 모든 링크를 따라가는 수집기만 이 주소를 부른다.
 * next/link 가 아니라 평범한 a — 미리 가져오기(prefetch)로 사람의 브라우저가 부르지 않게. 화면 밖에 두고 탭 순서에서 뺀다.
 */
function TrapLink() {
  return (
    <a href={TRAP_PATH} rel="nofollow" aria-hidden="true" tabIndex={-1} data-nmv-trap=""
      style={{ position: "absolute", left: "-10000px", top: "auto", width: 1, height: 1, overflow: "hidden" }}>
      catalog export
    </a>
  );
}

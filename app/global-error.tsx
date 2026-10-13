"use client";

import { BRAND, pageTitle } from "@/lib/copy/brand";
import { usePathname } from "next/navigation";
import { DEFAULT_LOCALE, LOCALE_CONFIG } from "@/lib/i18n/locales";
import { localePath, pathLocale } from "@/lib/i18n/routing";
import { createTranslator } from "@/lib/i18n/messages";
import { globalError as ko } from "@/messages/ko/global-error";
import { globalError as en } from "@/messages/en/global-error";
import { globalError as zhHans } from "@/messages/zh-Hans/global-error";
import { globalError as zhHant } from "@/messages/zh-Hant/global-error";
import "./globals.css";

// Only this six-message failure slice is bundled for all locales. The failed root
// cannot pass its server-selected catalog; the router still provides pathname.
const messages = { ko, en, "zh-Hans": zhHans, "zh-Hant": zhHant };

/**
 * 루트 레이아웃까지 무너졌을 때의 화면(2026-10-08 UX 감사 UX-10).
 *
 * 레이아웃을 대신하므로 html·body 와 전역 스타일(색 토큰·다크 모드)을 직접 가져온다. 헤더·푸터도 없다 —
 * 그것을 그리다 무너졌을 수 있다. 홈 링크는 앱 이동이 아니라 새로 불러오기(<a>)다. 클라이언트 컴포넌트라
 * metadata 를 내보낼 수 없어 React 의 <title> 로 제목을 단다.
 */
export default function GlobalError({ error, retry }: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const locale = pathLocale(usePathname()) ?? DEFAULT_LOCALE;
  const t = createTranslator("globalError", messages[locale]);
  return (
    <html lang={LOCALE_CONFIG[locale].htmlLang}>
      <body className="flex min-h-screen flex-col font-sans">
        <title>{pageTitle(t("title"))}</title>
        <main className="wrap">
          <div className="pb-16 pt-16">
            <p className="text-[18px] font-semibold tracking-tight">{BRAND}</p>
            <h1 className="mt-6 text-[26px] font-semibold tracking-tight">{t("heading")}</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-fg-2">
              {t("description")}
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => retry()} className="h-11 rounded-full bg-fg px-6 text-[15px] font-medium text-bg-card hover:opacity-90">
                {t("retry")}
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- 레이아웃이 무너진 상태라 앱 이동 대신 새로 불러온다 */}
              <a href={localePath(locale, "/")} className="inline-flex min-h-11 items-center px-2 text-[15px] font-medium text-accent-ink underline underline-offset-4">
                {t("home")}
              </a>
            </div>
            {error.digest && <p className="mt-6 text-[13px] text-fg-2">{t("reference", { digest: error.digest })}</p>}
          </div>
        </main>
      </body>
    </html>
  );
}

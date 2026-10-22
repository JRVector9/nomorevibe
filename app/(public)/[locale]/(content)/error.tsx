"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import { TrackOnMount } from "@/components/analytics/TrackOnMount";

/**
 * 화면을 그리다 난 오류 — Next 기본 영어 화면 대신(2026-10-08 UX 감사 UX-10).
 *
 * 헤더·푸터(루트 레이아웃)는 그대로 두고 본문 자리만 바꾼다. DB 가 잠깐 끊긴 것처럼 다시 하면 풀리는 일이 많아
 * '다시 시도'(retry — 화면을 다시 받아 그린다)를 앞에 둔다. 서버 오류의 내용은 방문자에게 보이지 않고 digest 만 온다 —
 * 그 값으로 서버 로그를 찾는다.
 * 방문 분석에는 코드만 보낸다(서버에서 난 것인지·브라우저에서 난 것인지) — 메시지·digest 는 보내지 않는다.
 */
export default function RouteError({ error, retry }: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("common");
  return (
    <main className="wrap">
      <TrackOnMount name="app_error" params={{ error_code: error.digest ? "server_render" : "client_render", page_type: "other" }} />
      <div className="pb-16 pt-12">
        <h1 className="text-[26px] font-semibold tracking-tight">{t("error.heading")}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-fg-2">
          {t("error.description")}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => retry()} className="h-11 rounded-full bg-fg px-6 text-[15px] font-medium text-bg-card hover:opacity-90">
            {t("error.retry")}
          </button>
          <Link prefetch={false} href={localePath(locale, "/")} className="inline-flex min-h-11 items-center px-2 text-[15px] font-medium text-accent-ink underline underline-offset-4">
            {t("navigation.homeLink")}
          </Link>
        </div>
        {error.digest && <p className="mt-6 text-[13px] text-fg-2">{t("error.reference", { digest: error.digest })}</p>}
      </div>
    </main>
  );
}

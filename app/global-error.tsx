"use client";

import { BRAND, pageTitle } from "@/lib/copy/brand";
import "./globals.css";

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
  return (
    <html lang="ko">
      <body className="flex min-h-screen flex-col font-sans">
        <title>{pageTitle("오류")}</title>
        <main className="wrap">
          <div className="pb-16 pt-16">
            <p className="text-[18px] font-semibold tracking-tight">{BRAND}</p>
            <h1 className="mt-6 text-[26px] font-semibold tracking-tight">사이트를 불러오지 못했습니다</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-fg-2">
              잠깐 생긴 문제일 수 있습니다. 다시 시도해 보시고, 계속되면 잠시 후 다시 들러 주세요.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => retry()} className="h-11 rounded-full bg-fg px-6 text-[15px] font-medium text-bg-card hover:opacity-90">
                다시 시도
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- 레이아웃이 무너진 상태라 앱 이동 대신 새로 불러온다 */}
              <a href="/" className="inline-flex min-h-11 items-center px-2 text-[15px] font-medium text-accent-ink underline underline-offset-4">
                홈으로 가기
              </a>
            </div>
            {error.digest && <p className="mt-6 text-[13px] text-fg-2">오류 번호 {error.digest}</p>}
          </div>
        </main>
      </body>
    </html>
  );
}

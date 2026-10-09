"use client";

import Link from "next/link";

/**
 * 화면을 그리다 난 오류 — Next 기본 영어 화면 대신(2026-10-08 UX 감사 UX-10).
 *
 * 헤더·푸터(루트 레이아웃)는 그대로 두고 본문 자리만 바꾼다. DB 가 잠깐 끊긴 것처럼 다시 하면 풀리는 일이 많아
 * '다시 시도'(retry — 화면을 다시 받아 그린다)를 앞에 둔다. 서버 오류의 내용은 방문자에게 보이지 않고 digest 만 온다 —
 * 그 값으로 서버 로그를 찾는다.
 */
export default function RouteError({ error, retry }: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="wrap">
      <div className="pb-16 pt-12">
        <h1 className="text-[26px] font-semibold tracking-tight">화면을 불러오지 못했습니다</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-fg-2">
          잠깐 생긴 문제일 수 있습니다. 다시 시도해 보시고, 계속되면 잠시 후 다시 들러 주세요.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => retry()} className="h-11 rounded-full bg-fg px-6 text-[15px] font-medium text-bg-card hover:opacity-90">
            다시 시도
          </button>
          <Link prefetch={false} href="/" className="inline-flex min-h-11 items-center px-2 text-[15px] font-medium text-accent-ink underline underline-offset-4">
            홈으로 가기
          </Link>
        </div>
        {error.digest && <p className="mt-6 text-[13px] text-fg-2">오류 번호 {error.digest}</p>}
      </div>
    </main>
  );
}

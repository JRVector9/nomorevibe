"use client";

import Script from "next/script";
import { Suspense, useEffect, useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { analyticsSnapshot, lastPageTitle, startAnalytics, subscribeAnalytics, trackPageView } from "@/lib/analytics/client";

/** 이동한 뒤 새 제목이 들어오기를 이만큼 기다린다 — 제목(metadata)은 화면보다 늦게 올 수 있다 */
export const TITLE_WAIT_MS = 1_000;

/**
 * 제목이 바뀌면(또는 기다림이 끝나면) 한 번 부른다. 이미 바뀌어 있으면 바로.
 * 돌려준 함수로 취소한다(다음 이동이 먼저 오면 앞의 것은 보내지 않는다).
 */
export function afterTitleSettles(previousTitle: string | null, run: () => void, waitMs = TITLE_WAIT_MS): () => void {
  if (previousTitle === null || document.title !== previousTitle) {
    const frame = window.setTimeout(run, 0);
    return () => window.clearTimeout(frame);
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    observer.disconnect();
    window.clearTimeout(timer);
    run();
  };
  const observer = new MutationObserver(() => { if (document.title !== previousTitle) finish(); });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  const timer = window.setTimeout(finish, waitMs);
  return () => { done = true; observer.disconnect(); window.clearTimeout(timer); };
}

/** 첫 화면과 App Router 이동마다 page_view — 주소·허용 질의가 바뀔 때 */
function PageViews() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => afterTitleSettles(lastPageTitle(), () => trackPageView({ pathname, search: search ? `?${search}` : "" })),
    [pathname, search]);
  return null;
}

/**
 * gtag.js 로더(2026-10-22) — 공개 화면 틀(PublicShell)에만 있다. 측정 ID 는 서버가 실행 중 환경에서 읽어 넘긴다.
 * 동의를 먼저 보고(lib/analytics/consent.ts) 꺼진 방문자에게는 스크립트를 아예 불러오지 않는다.
 * 분석을 껐다가 다시 켜면(정책 화면·푸터) 그때 불러온다.
 */
export function AnalyticsLoader({ measurementId, debug, devLog }: { measurementId: string | null; debug: boolean; devLog: boolean }) {
  const loadScript = useSyncExternalStore(subscribeAnalytics, () => analyticsSnapshot().status === "on", () => false);
  useEffect(() => { startAnalytics({ measurementId, debug, devLog }); }, [measurementId, debug, devLog]);
  return (
    <>
      {loadScript && measurementId && (
        <Script id="nmv-gtag" strategy="afterInteractive" src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`} />
      )}
      <Suspense fallback={null}><PageViews /></Suspense>
    </>
  );
}

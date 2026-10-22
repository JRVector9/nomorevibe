"use client";

import { Suspense, useEffect, useState, useSyncExternalStore, type ComponentType } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { analyticsSnapshot, setAnalyticsSnapshot, subscribeAnalytics, trackPageView } from "@/lib/analytics/client";

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

/** 마지막으로 page_view 를 부른 화면의 제목 */
let lastTitle: string | null = null;

/** 첫 화면과 App Router 이동마다 page_view — 주소·질의가 바뀔 때 */
function PageViews() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => afterTitleSettles(lastTitle, () => {
    lastTitle = document.title;
    trackPageView({ pathname, search: search ? `?${search}` : "" });
  }), [pathname, search]);
  return null;
}

type Runtime = typeof import("@/lib/analytics/runtime");

/**
 * gtag.js 로더(2026-10-22) — 공개 화면 틀(PublicShell)에만 있다. 측정 ID 는 서버가 실행 중 환경에서 읽어 넘긴다.
 * 실제 일(lib/analytics/runtime.tsx)은 여기서 import() 로 따로 받는다 — GA 가 꺼진 화면의 첫 로드 JS 에 들어가지 않는다.
 * 동의를 먼저 보고(lib/analytics/consent.ts) 꺼진 방문자에게는 gtag.js 를 아예 불러오지 않는다.
 * 분석을 껐다가 다시 켜면(정책 화면·푸터) 그때 불러온다.
 */
export function AnalyticsLoader({ measurementId, debug, devLog }: { measurementId: string | null; debug: boolean; devLog: boolean }) {
  const [Gtag, setGtag] = useState<ComponentType<{ measurementId: string }> | null>(null);
  const on = useSyncExternalStore(subscribeAnalytics, () => analyticsSnapshot().status === "on", () => false);
  useEffect(() => {
    let live = true;
    import("@/lib/analytics/runtime").then((runtime: Runtime) => {
      if (!live) return;
      runtime.startAnalytics({ measurementId, debug, devLog });
      setGtag(() => runtime.GtagScript);
    }).catch(() => {
      // 묶음을 받지 못하면(네트워크·배포 교체) 이 화면에서는 분석을 쉰다
      setAnalyticsSnapshot({ status: "off", reason: "disabled" });
    });
    return () => { live = false; };
  }, [measurementId, debug, devLog]);
  return (
    <>
      {on && Gtag && measurementId && <Gtag measurementId={measurementId} />}
      <Suspense fallback={null}><PageViews /></Suspense>
    </>
  );
}

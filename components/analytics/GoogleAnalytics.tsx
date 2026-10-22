import { Suspense } from "react";
import { analyticsConfig } from "@/lib/analytics/config";
import { analyticsUserIdEnabled } from "@/lib/analytics/identity";
import { analyticsUserIdForPage } from "@/lib/analytics/page-user";
import { AnalyticsLoader } from "./AnalyticsLoader";

/**
 * 공개 화면의 방문 분석 자리(2026-10-22) — 공개 화면 틀(components/home/PublicShell.tsx)에서만 그린다.
 * 관리자(app/(operator))·API·/go·로그인 콜백은 이 틀을 쓰지 않으므로 처음부터 없다.
 *
 * 측정 ID 는 요청마다 실행 중 환경(GA_MEASUREMENT_ID)에서 읽는다 — 공개 화면은 요청 머리글(언어)을 읽어 늘 요청 때 그린다.
 * 꺼져 있으면 아무것도 그리지 않는다. 개발 중 GA_DEBUG=1 이면 보냈을 이벤트를 콘솔에 찍는 로더만 둔다.
 */
export function GoogleAnalytics() {
  const { measurementId, debug } = analyticsConfig();
  const devLog = !measurementId && debug && process.env.NODE_ENV !== "production";
  if (!measurementId && !devLog) return null;
  // 가명 user_id(PR C, ANALYTICS_USER_ID_SECRET)가 켜져 있을 때만 로그인을 확인한다 — 틀(헤더·본문)을 기다리게 하지 않게 따로 흘려보낸다
  if (measurementId && analyticsUserIdEnabled()) {
    return <Suspense fallback={null}><SignedInLoader measurementId={measurementId} debug={debug} /></Suspense>;
  }
  return <AnalyticsLoader measurementId={measurementId} debug={debug} devLog={devLog} />;
}

/** 로그인한 사람이면 가명 user_id 를 실어 로더를 그린다(lib/analytics/page-user.ts) */
async function SignedInLoader({ measurementId, debug }: { measurementId: string; debug: boolean }) {
  return <AnalyticsLoader measurementId={measurementId} debug={debug} devLog={false} userId={await analyticsUserIdForPage()} />;
}

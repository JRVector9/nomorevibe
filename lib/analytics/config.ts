/**
 * 방문 분석(Google Analytics 4) 설정 — 서버가 실행 중에 환경 변수를 읽는다(2026-10-22).
 *
 * - GA_MEASUREMENT_ID: `G-XXXXXXXXXX`. 비어 있거나 꼴이 틀리면 기능이 꺼지고 아무것도 불러오지 않는다.
 * - GA_DEBUG=1: GA DebugView 에 보이게 debug_mode 를 켠다. GA 가 꺼진 개발 환경에서는 보냈을 이벤트를 콘솔에 찍는다.
 *
 * NEXT_PUBLIC_ 변수를 쓰지 않는다 — 웹 이미지는 CI 에서 비밀 없이 굽고 Dokploy 가 실행 때 환경을 넣는다.
 * 빌드 때 값이 박히면 운영에서 켤 수가 없다. 그래서 서버 컴포넌트(components/analytics/GoogleAnalytics.tsx)가
 * 요청마다 읽어 브라우저 로더에 넘긴다. 측정 ID 는 비밀이 아니다(페이지 소스에 그대로 보인다).
 *
 * 서버 발신(Measurement Protocol)이 같은 함수를 쓴다 — server-only 를 걸지 않아 스크립트·작업에서도 읽힌다.
 */

/** GA4 측정 ID 꼴 — G- 뒤 대문자·숫자 */
const MEASUREMENT_ID = /^G-[A-Z0-9]{4,20}$/;

export type AnalyticsConfig = {
  /** 꺼져 있으면 null */
  measurementId: string | null;
  debug: boolean;
};

type Env = Readonly<Record<string, string | undefined>>;

export function parseMeasurementId(value: string | undefined): string | null {
  const id = value?.trim().toUpperCase();
  return id && MEASUREMENT_ID.test(id) ? id : null;
}

export function analyticsConfig(env: Env = process.env): AnalyticsConfig {
  return {
    measurementId: parseMeasurementId(env.GA_MEASUREMENT_ID),
    debug: env.GA_DEBUG?.trim() === "1",
  };
}

export function analyticsEnabled(env: Env = process.env): boolean {
  return analyticsConfig(env).measurementId !== null;
}

/** GA4 화면 주소로 받는 곳 — 설정 실수로 다른 곳을 가리키는 바로가기를 만들지 않는다 */
const GA_ORIGIN = "https://analytics.google.com";

/** `GA_PROPERTY_URL`(예: https://analytics.google.com/analytics/web/#/p123456789/reports/intelligenthome). 없거나 GA 주소가 아니면 null */
export function analyticsPropertyUrl(value = process.env.GA_PROPERTY_URL): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.origin === GA_ORIGIN && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 운영센터의 Google Analytics 바로가기(docs/operations/2026-10-22-google-analytics.md).
 * 방문·여정·전환은 GA 에서 본다 — 이 화면은 숫자를 다시 세지 않는다. 주소가 없으면 그리지 않는다.
 */
export function AnalyticsLinkCard({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <p className="dash-card dash-12 ops-human-line" aria-label="Google Analytics">
      방문·여정·전환(GA4)
      <a href={url} target="_blank" rel="noopener noreferrer">Google Analytics 열기 ↗</a>
    </p>
  );
}

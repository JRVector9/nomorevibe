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

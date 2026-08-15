/**
 * 사이트 정식 origin.
 * 리버스 프록시 뒤에서는 req.url이 내부 호스트(localhost:3000 등)로 재구성되므로
 * NEXT_PUBLIC_SITE_URL을 우선 사용하고, 없을 때만 요청 origin으로 폴백한다.
 */
export function siteOrigin(req?: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  if (req) return new URL(req.url).origin;
  return "http://localhost:3000";
}

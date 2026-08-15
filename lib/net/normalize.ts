import net from "node:net";

/**
 * URL 정규화 — 중복 등록 방지의 기준값을 만든다.
 * 소문자 호스트 + www. 제거 + 후행 슬래시 제거 + https 강제 + 쿼리/해시 제거.
 *
 * 순수 함수(네트워크·DB 무관). allowPrivate는 로컬 테스트에서 http/localhost를 살리기 위한 스위치.
 */
export function normalizeUrl(input: string, allowPrivate = false): string | null {
  let raw = input.trim();
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) {
    // 스킴이 있는데 http(s)가 아니면 거부한다.
    // (그냥 https://를 덧붙이면 file:///etc/passwd → https://file///etc/passwd 처럼 변형된다)
    if (!/^https?$/i.test(scheme[1])) return null;
  } else {
    raw = `https://${raw}`;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;

  let host = u.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);

  let path = u.pathname.replace(/\/+$/, "");
  if (path === "/") path = "";

  // 비표준 포트는 유지 (로컬 테스트의 localhost:8899 등)
  const port = u.port && u.port !== "443" && u.port !== "80" ? `:${u.port}` : "";
  const keepScheme = allowPrivate && (host === "localhost" || net.isIP(host));
  const protocol = keepScheme ? u.protocol : "https:";
  return `${protocol}//${host}${port}${path}`;
}

/** http(s) 스킴만 허용 — javascript:/data: URI가 링크 href로 흘러가는 것을 막는다 */
export function normalizeHttpUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** 이름 → slug 기본형 (충돌 해소는 repository가 담당) */
export function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/[\s-]+/g, "-")
      .slice(0, 60)
      .replace(/^-|-$/g, "") || "product"
  );
}

/** HTML에서 og:image 추출 (상대경로면 절대경로로 변환) */
export function extractOgImage(html: string, baseUrl: string): string | null {
  const m =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (!m) return null;
  try {
    return new URL(m[1], baseUrl).toString();
  } catch {
    return null;
  }
}

/** HTML에서 검증 메타태그 값 추출 */
export function extractVerifyMeta(html: string, metaName: string): string | null {
  const pattern = metaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m =
    html.match(new RegExp(`<meta[^>]+name=["']${pattern}["'][^>]+content=["']([^"']+)["']`, "i")) ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${pattern}["']`, "i"));
  return m ? m[1] : null;
}

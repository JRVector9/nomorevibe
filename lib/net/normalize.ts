import net from "node:net";

/**
 * 호스트명 라벨 규칙 — 영숫자로 시작·끝나고 내부에만 하이픈이 올 수 있다.
 * 밑줄은 규격상 호스트명에 쓸 수 없지만 실제로 동작하는 사이트가 있어 허용한다.
 * 여기서 지나치게 엄격하면 멀쩡한 제품을 거부하게 되고, 어차피 해석되지 않는
 * 호스트는 뒤따르는 DNS 조회에서 걸러진다.
 */
const HOST_LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/;

/** IP 리터럴이거나 형식이 올바른 DNS 이름인지 */
export function isValidHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (net.isIP(host) !== 0) return true;
  // IPv6는 URL에서 대괄호로 감싸인 형태로 나온다
  if (host.startsWith("[") && host.endsWith("]")) return net.isIP(host.slice(1, -1)) !== 0;
  return host.split(".").every((label) => label.length <= 63 && HOST_LABEL.test(label));
}

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
  // 루트 도메인 표기의 후행 점을 제거한다.
  // 안 하면 example.com. 과 example.com 이 같은 사이트인데 별개 제품으로 등록된다.
  if (host.endsWith(".") && host.length > 1) host = host.slice(0, -1);
  if (host.startsWith("www.")) host = host.slice(4);
  if (!isValidHostname(host)) return null;

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

/**
 * 실체 참조를 되돌린다 — 남겨두면 그 글자가 그대로 제품 이름이 된다.
 *
 * 숫자 참조까지 봐야 한다. 실제 수집에서 `DRYL &#x2014; the AI-native…`가 그대로 들어와
 * slug가 `dryl-x2014-…`가 됐다. 이름 있는 참조만 알던 때 놓친 것이다.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,6});/gi, (whole, hex) => fromCodePoint(parseInt(hex, 16), whole))
    .replace(/&#(\d{1,7});/g, (whole, dec) => fromCodePoint(Number(dec), whole))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

/** 범위를 벗어난 코드포인트는 원문 그대로 둔다 — 깨진 참조 하나로 제목 전체를 잃지 않는다 */
function fromCodePoint(code: number, whole: string): string {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return whole;
  try {
    return String.fromCodePoint(code);
  } catch {
    return whole;
  }
}

/** 속성 순서가 어느 쪽이든 잡는다 (content가 앞에 오는 페이지가 흔하다) */
function metaContent(html: string, attribute: "property" | "name", key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found =
    html.match(new RegExp(`<meta[^>]+${attribute}=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i")) ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attribute}=["']${escaped}["']`, "i"));
  if (!found) return null;
  const value = decodeEntities(found[1]).replace(/\s+/g, " ").trim();
  return value || null;
}

/** 배포 페이지에서 뽑은 것 — 수집한 제품의 이름·소개는 여기서 나온다 */
export type PageMeta = {
  title: string | null;
  description: string | null;
  ogImage: string | null;
  /** 문서 생성기 이름 (감지된 경우) — 문서 사이트인지 가르는 데 쓴다 */
  generator: string | null;
};

/**
 * 문서 생성기 감지.
 *
 * 찾을 이름은 밖에서 받는다. 예전에는 이 파일에 목록을 박아두고 설정에도 같은 목록을
 * 뒀는데, 어드민에서 새 생성기를 추가해도 감지 쪽이 모르니 아무 일도 일어나지 않았다.
 * 목록은 설정 하나가 갖고, 여기서는 찾기만 한다.
 *
 * generator 메타태그가 가장 확실하지만 실측에서 23건 중 4건만 달고 있었다. 태그가 없어도
 * 자산 경로에는 남는다(pkgdown.js, /assets/js/docusaurus…) — 본문 텍스트는 보지 않는다.
 * "docusaurus로 만들었습니다"라고 적어둔 제품 소개까지 문서로 볼 수는 없다.
 */
export function detectSiteGenerator(html: string, generators: readonly string[]): string | null {
  if (generators.length === 0) return null;
  // head 언저리만 본다. 본문까지 훑으면 단어 하나로 오탐이 난다
  const head = html.slice(0, 50_000);
  const names = generators.map((g) => g.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  const declared = metaContent(head, "name", "generator")?.toLowerCase();
  if (declared) {
    const known = generators.find((g) => declared.includes(g.toLowerCase()));
    if (known) return known.toLowerCase();
  }

  const asset = head.match(new RegExp(`(?:src|href)=["'][^"']*\\b(${names.join("|")})\\b`, "i"));
  return asset ? asset[1].toLowerCase() : null;
}

/**
 * 페이지 메타 추출.
 *
 * og:* 를 먼저 본다. 공유용으로 사람이 손보는 값이라 <title>보다 제품 이름에 가깝다
 * ("Home | 내 서비스" 같은 것이 <title>에는 흔하다).
 * 없으면 없는 대로 null을 남긴다 — 여기서 지어내면 발행 단계에서 무엇이 사실이고
 * 무엇이 추정인지 가를 수 없게 된다.
 */
export function extractPageMeta(
  html: string,
  baseUrl: string,
  docsGenerators: readonly string[] = [],
): PageMeta {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title =
    metaContent(html, "property", "og:title") ??
    (titleTag ? decodeEntities(titleTag[1]).replace(/\s+/g, " ").trim() || null : null);

  return {
    // 저장 상한을 넘기지 않게 자른다. 이름은 120자, 소개는 200자가 상한이다
    title: title ? title.slice(0, 300) : null,
    description:
      (metaContent(html, "property", "og:description") ?? metaContent(html, "name", "description"))?.slice(
        0,
        500,
      ) ?? null,
    ogImage: extractOgImage(html, baseUrl),
    generator: detectSiteGenerator(html, docsGenerators),
  };
}

/** HTML에서 검증 메타태그 값 추출 */
export function extractVerifyMeta(html: string, metaName: string): string | null {
  const pattern = metaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m =
    html.match(new RegExp(`<meta[^>]+name=["']${pattern}["'][^>]+content=["']([^"']+)["']`, "i")) ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${pattern}["']`, "i"));
  return m ? m[1] : null;
}

import { isLocaleExcludedPath, pathLocale, stripLocale } from "@/lib/i18n/routing";
import { BRAND } from "@/lib/copy/brand";

/**
 * 과다 호출 차단(2026-11-16 사람 지시) — DB 없이 쓰는 순수 부분: 기본값·셀 경로·차단 응답.
 * 세는 일과 차단 기록은 lib/http/crawl-burst.ts 가 한다.
 *
 * 기본값 근거(운영과 같은 next build 의 standalone 서버 + 시험 DB, Playwright Desktop Chrome, 2026-11-16 실측 — PR #977 본문 표):
 *  - 상세 한 장을 처음 열면 세는 요청은 5번(문서 1 + /api/session·details·reactions·feedback), README 가 있는 설치형은 6번.
 *    같은 화면의 정적 자원 29~32개(/_next/static·그림·아이콘)는 세지 않는다. 홈 7번, 인기 2번, 홈 → 상세 누름 11번.
 *  - 빠른 사람(상세 5장을 6.8초에) 26번 — 상세가 모두 설치형이어도 30번. 회사·통신사 공유 IP 에서 그런 사람 둘이 같은 10초에 보면 60번이라
 *    대표 출발점(10초 50번)으로는 둘째 사람이 막힌다. 그래서 80번: 빠른 두 사람 60번 + 다른 화면 여유 20번. 초당 8번 넘게 계속 부르는 수집기는 10초 안에 막힌다.
 *  - 스킬(nomorevibe-skill)·Claude-User 같은 「사람이 에이전트에 입력해 쓰는 접근」은 한 흐름이 3번 안팎이라 걸리지 않는다(2026-11-15 원칙).
 */
export type CrawlBurstSettings = { burstLimit: number; burstWindowSeconds: number; burstBlockSeconds: number };
export const CRAWL_BURST_DEFAULTS: Readonly<CrawlBurstSettings> = Object.freeze({
  /** 같은 공인 IP 가 창 안에 부를 수 있는 공개 화면·공개 API 읽기 수. 넘으면 차단. 0 이면 끔 */
  burstLimit: 80,
  /** 세는 창(초) */
  burstWindowSeconds: 10,
  /** 넘은 IP 를 막는 시간(초) — 사람 지시 「30분 제한」 */
  burstBlockSeconds: 1_800,
});

/** 상세 세 경로는 slug·경로와 관계없이 IP 하나의 통에 합산한다. */
export type DetailApiSettings = { detailReadLimit: number; detailReadWindowSeconds: number; detailBurstLimit: number; detailBurstWindowSeconds: number };
export const DETAIL_API_DEFAULTS: Readonly<DetailApiSettings> = Object.freeze({
  detailReadLimit: 60, detailReadWindowSeconds: 600, detailBurstLimit: 20, detailBurstWindowSeconds: 10,
});
export const isDetailApiRoute = (route: string) => ["products.details", "products.readme", "products.timeline"].includes(route);
export const detailReadKey = (ip: string) => `detail-read:${ip}`;
export const detailBurstKey = (ip: string) => `detail-burst:${ip}`;

/** 사람 지시 원문 그대로 */
export const CRAWL_PROHIBITED_MESSAGE = "이 사이트는 크롤링을 금지합니다. 법적 조치를 취할 수 있습니다.";
export const CRAWL_PROHIBITED_MESSAGE_EN = "This site prohibits crawling. Legal action may be taken.";

export const crawlBurstKey = (ip: string) => `burst:${ip}`;

type PathRequest = { method: string; nextUrl: { pathname: string } };

/**
 * 세는 요청인가 — 공개 화면(HTML·RSC 이동)만. 공개 API 읽기는 guardPublicApiRead 가 따로 센다.
 * 세지 않는 것: GET/HEAD 가 아닌 요청(서버 액션·폼), /api·/admin·/_next·/badge·/go 같은 기계 경로와 그림·글꼴·아이콘 파일
 * (isLocaleExcludedPath — 상세 한 번에 그림 수십 개), 상세 공유 카드(share-card.png).
 */
export function countsTowardCrawlBurst(req: PathRequest): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const pathname = req.nextUrl.pathname;
  const logical = stripLocale(pathname);
  if (isLocaleExcludedPath(logical)) return false;
  if (logical.startsWith("/.") || logical.endsWith("/share-card.png")) return false;
  return true;
}

const NO_STORE = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } as const;

function remainingKo(seconds: number): string {
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ""}`;
}
function remainingEn(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
const clock = (at: Date, timeZone: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

export type CrawlBlockedInput = { kind: "page" | "api"; retryAfterSeconds: number; method?: string; pathname?: string; now?: Date };

/**
 * 막힌 동안의 응답 — 429 + Retry-After(남은 초), 캐시 금지(엣지가 담으면 다른 방문자까지 막힌다).
 * 화면이면 짧은 HTML(사이트 기본 색·글꼴), API 면 JSON(error: crawling_prohibited). 문구는 사람 지시 그대로, 남은 시간을 함께 알린다.
 */
export function crawlBlockedResponse(input: CrawlBlockedInput): Response {
  const seconds = Math.max(1, Math.ceil(input.retryAfterSeconds));
  const now = input.now ?? new Date();
  const retryAt = new Date(now.getTime() + seconds * 1000);
  const headers = { ...NO_STORE, "Retry-After": String(seconds) };
  if (input.kind === "api") {
    return Response.json({
      error: "crawling_prohibited",
      message: `${CRAWL_PROHIBITED_MESSAGE} ${remainingKo(seconds)} 뒤에 다시 이용할 수 있습니다.`,
      message_en: `${CRAWL_PROHIBITED_MESSAGE_EN} Try again in ${remainingEn(seconds)}.`,
      retryAfterSeconds: seconds,
      retryAt: retryAt.toISOString(),
    }, { status: 429, headers });
  }
  const html = crawlBlockedHtml(seconds, retryAt, input.pathname ?? "/");
  return new Response(input.method === "HEAD" ? null : html, {
    status: 429,
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function crawlBlockedHtml(seconds: number, retryAt: Date, pathname: string): string {
  const korean = pathLocale(pathname) === null || pathLocale(pathname) === "ko";
  const ko = `<p class="lead" lang="ko">짧은 시간에 너무 많은 요청이 와서 이 주소(IP)의 접근을 잠시 막았습니다.</p>
    <p class="time" lang="ko">남은 시간 <strong>약 ${escapeHtml(remainingKo(seconds))}</strong> · 한국 시각 ${escapeHtml(clock(retryAt, "Asia/Seoul", "ko-KR"))}부터 다시 이용할 수 있습니다.</p>`;
  const en = `<p class="lead" lang="en">${escapeHtml(CRAWL_PROHIBITED_MESSAGE_EN)} Too many requests came from this address (IP) in a short time, so access is paused.</p>
    <p class="time" lang="en">Time left <strong>about ${escapeHtml(remainingEn(seconds))}</strong> · available again at ${escapeHtml(clock(retryAt, "UTC", "en-GB"))} UTC.</p>`;
  return `<!doctype html>
<html lang="${korean ? "ko" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>요청이 너무 많습니다 — ${BRAND}</title>
<style>
  :root { color-scheme: light dark; --bg: #f5f5f7; --card: #ffffff; --border: #e8e8ed; --text: #1d1d1f; --text-2: #6e6e73; --accent: #c0323a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --card: #161d2e; --border: #263049; --text: #e6e8ee; --text-2: #9aa3b5; --accent: #ff6b70; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Apple SD Gothic Neo", "Pretendard", system-ui, "Helvetica Neue", sans-serif;
    line-height: 1.6; word-break: keep-all; overflow-wrap: anywhere; }
  main { width: 100%; max-width: 560px; background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 28px 24px; }
  .brand { margin: 0 0 18px; display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 16px; letter-spacing: -0.01em; }
  .brand span { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
  h1 span { display: inline-block; }
  .code { margin: 0 0 6px; font-size: 13px; color: var(--text-2); }
  h1 { margin: 0 0 14px; font-size: 21px; line-height: 1.45; letter-spacing: -0.02em; color: var(--accent); }
  p { margin: 0 0 10px; font-size: 15px; }
  .time { color: var(--text-2); }
  .time strong { color: var(--text); }
  hr { border: 0; border-top: 1px solid var(--border); margin: 18px 0; }
</style>
</head>
<body>
<main>
  <p class="brand"><span aria-hidden="true"></span>${BRAND}</p>
  <p class="code">429 · Too Many Requests</p>
  <h1 lang="ko">${CRAWL_PROHIBITED_MESSAGE.split(/(?<=\.) /).map((sentence) => `<span>${escapeHtml(sentence)}</span>`).join(" ")}</h1>
  ${korean ? `${ko}\n  <hr>\n  ${en}` : `${en}\n  <hr>\n  ${ko}`}
</main>
</body>
</html>
`;
}

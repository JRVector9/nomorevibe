import net from "node:net";
import { z } from "zod";
import { isPrivateHostname, isPrivateIp } from "@/lib/net/ssrf";
import { TEXT_SAMPLE_LIMIT } from "@/lib/net/normalize";

/**
 * 화면 판별(2026-10-22) — 크롤러가 글을 읽지 못한(JS 로 그리는) 감사 항목을 브라우저로 그려 본다. 화면 서버(scripts/screen-render/server.ts,
 * m1-studio)와 워커(lib/screen-review/render-client.ts, reviewer)가 같이 쓰는 약속이다. DB·모델 모듈을 끌어오지 않는다 — 화면 서버는 DB 를 모른다.
 * 설계: docs/operations/2026-10-22-screen-review-design.md
 */

/** 약속의 판 — 다르면 워커가 답을 받지 않는다(render_invalid) */
export const SCREEN_RENDER_PROTOCOL = 1;
/** 첫 화면 크기 — 보류 918건 재판정(2026-10-22, 글 2026-10-21.v2+shot1)을 잰 그 크기 */
export const SCREEN_VIEWPORT = { width: 1280, height: 800 } as const;
/** 그린 뒤 글의 상한 — 크롤러의 본문 표본(pageText)과 같은 6,000자 */
export const SCREEN_TEXT_LIMIT = TEXT_SAMPLE_LIMIT;
/** 스크린샷(JPEG)의 상한 — 1280×800 품질 70 은 보통 100~300KB 다 */
export const SCREEN_MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
/** base64 로 실은 스크린샷의 상한 */
export const SCREEN_MAX_SCREENSHOT_BASE64 = Math.ceil(SCREEN_MAX_SCREENSHOT_BYTES / 3) * 4;
/** 그릴 주소의 길이 상한 */
export const SCREEN_URL_MAX = 2048;
/** 그릴 주소·하위 요청이 쓸 수 있는 포트 — 기본 80·443 만(SCREEN_RENDER_PORTS 로 바꾼다) */
export const SCREEN_DEFAULT_PORTS: readonly number[] = [80, 443];

/**
 * 이름만 보고 막는 호스트 — 사설 이름(localhost·.local·.internal), 점 없는 한 낱말(검색 도메인·MagicDNS 로 사설망에 풀린다),
 * Tailscale MagicDNS(.ts.net)·집 안 이름(.home.arpa·.lan). 진짜 판정은 DNS 로 푼 IP 다(egress-proxy.ts) — 이것은 먼저 거르는 문이다
 */
export function blockedHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!name) return true;
  if (net.isIP(name)) return false;
  return isPrivateHostname(name) || name.endsWith(".localhost") || !name.includes(".") || name.endsWith(".ts.net")
    || name.endsWith(".home.arpa") || name.endsWith(".lan");
}

/** IPv6 주소를 정규형(압축·소문자)으로 — 사설 판정(isPrivateIp)은 앞머리로 보므로 0:0:0:0:0:ffff:7f00:1 같은 풀어 쓴 꼴을 먼저 접는다 */
function canonicalV6(ip: string): string {
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return ip.toLowerCase();
  }
}

/**
 * 나가면 안 되는 IP — lib/net/ssrf.ts isPrivateIp(사설·루프백·링크로컬·CGNAT/Tailscale 100.64/10·메타데이터·예약·멀티캐스트,
 * fc00::/7·fe80::/10·v4 매핑 등)에 더해, IPv4 를 품은 IPv6(::/96 호환형·6to4 2002::/16·Teredo 2001::/32)와 해석할 수 없는 값도 막는다
 */
export function blockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIp(ip);
  if (family !== 6) return true;
  const v6 = canonicalV6(ip);
  if (isPrivateIp(v6)) return true;
  return /^::[0-9a-f]/.test(v6) || v6.startsWith("2002:") || v6.startsWith("2001::") || v6.startsWith("2001:0:");
}

/** 그 포트를 쓸 수 있는가 — 빈 포트는 스킴의 기본값 */
export function urlPort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

/**
 * 그릴 수 있는 주소인가 — http(s)·계정 정보 없음·길이 상한·허용 포트·이름으로 막는 호스트·사설 IP 리터럴이 아님.
 * 통과해도 DNS 가 사설로 풀리면 egress 프록시가 막는다(서버가 다시 본다)
 */
export function renderableUrl(raw: string, ports: readonly number[] = SCREEN_DEFAULT_PORTS): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > SCREEN_URL_MAX) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!ports.includes(urlPort(url))) return null;
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (net.isIP(host) ? blockedAddress(host) : blockedHostname(host)) return null;
  return url;
}

/** 쉼표로 적은 포트 목록 — 1~65535 정수만, 비었거나 틀리면 기본값 */
export function parsePorts(raw: string | undefined): number[] {
  const ports = (raw ?? "").split(",").map((part) => part.trim()).filter(Boolean).map(Number);
  return ports.length && ports.every((port) => Number.isInteger(port) && port > 0 && port < 65536) ? [...new Set(ports)] : [...SCREEN_DEFAULT_PORTS];
}

export const renderRequestSchema = z.object({ url: z.string().min(1).max(SCREEN_URL_MAX) }).strict();
export type RenderRequest = z.infer<typeof renderRequestSchema>;

/**
 * 페이지 탓의 실패 — 워커는 그 항목의 실패로 센다(두 번까지 다시 그린다).
 *  unsafe_url: 그릴 수 없는 주소 · blocked: 첫 문서(또는 그리로 가는 넘겨주기)가 사설·금지 목적지라 egress 가 막음 ·
 *  navigation_failed: 닿지 않음(DNS·연결·TLS) · http_status: 첫 문서가 4xx/5xx(봇 차단 화면을 판정하지 않는다) ·
 *  timeout: 그리기 상한을 넘겨 브라우저를 죽임 · screenshot_failed · browser_failed: 브라우저가 뜨지 않거나 죽음 · budget: 요청 수·바이트 상한
 */
export const RENDER_PAGE_ERRORS = ["unsafe_url", "blocked", "navigation_failed", "http_status", "timeout", "screenshot_failed", "browser_failed",
  "budget"] as const;
export type RenderPageError = (typeof RENDER_PAGE_ERRORS)[number];

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const egressSummarySchema = z.object({ requests: count, bytes: count, blocked: count }).strict();
export type EgressSummary = z.infer<typeof egressSummarySchema>;

export const renderSuccessSchema = z.object({
  ok: z.literal(true), protocol: z.literal(SCREEN_RENDER_PROTOCOL),
  finalUrl: z.string().max(4096), status: z.number().int().min(100).max(599).nullable(),
  /** 그린 뒤 보이는 글(document.body.innerText) — 공백을 접고 6,000자까지 */
  text: z.string().max(SCREEN_TEXT_LIMIT),
  /** 자르기 전 길이 */
  textLength: count,
  /** 첫 화면 JPEG(base64) */
  screenshot: z.string().min(4).max(SCREEN_MAX_SCREENSHOT_BASE64),
  renderMs: count, egress: egressSummarySchema,
}).strict();
export const renderFailureSchema = z.object({
  ok: z.literal(false), protocol: z.literal(SCREEN_RENDER_PROTOCOL), error: z.enum(RENDER_PAGE_ERRORS),
  status: z.number().int().min(100).max(599).nullable(), renderMs: count, egress: egressSummarySchema.nullable(),
}).strict();
export const renderResponseSchema = z.discriminatedUnion("ok", [renderSuccessSchema, renderFailureSchema]);
export type RenderSuccess = z.infer<typeof renderSuccessSchema>;
export type RenderFailure = z.infer<typeof renderFailureSchema>;
export type RenderResponse = z.infer<typeof renderResponseSchema>;

/** 글꼴 자체 점검 — 한글·가나·간체자가 두부(빈 네모)가 아니게 그려지는가 */
export const fontCheckSchema = z.object({ ko: z.boolean(), ja: z.boolean(), zh: z.boolean() }).strict();
export type FontCheck = z.infer<typeof fontCheckSchema>;
export const fontsComplete = (fonts: FontCheck | null): boolean => Boolean(fonts && fonts.ko && fonts.ja && fonts.zh);

export const renderHealthSchema = z.object({
  ok: z.boolean(), protocol: z.literal(SCREEN_RENDER_PROTOCOL), version: z.string().max(80),
  /** Chromium 샌드박스를 켰는가 — 꺼져 있으면 운영에 쓰지 않는다 */
  sandbox: z.boolean(), busy: count, maxConcurrent: count, fonts: fontCheckSchema.nullable(), startedAt: z.string().max(40),
}).strict();
export type RenderHealth = z.infer<typeof renderHealthSchema>;

/** 서버가 거절할 때의 본문 — 고정 코드만 싣는다 */
export const RENDER_SERVICE_ERRORS = ["unauthorized", "forbidden", "bad_request", "busy", "fonts_missing", "not_ready", "not_found"] as const;
export type RenderServiceError = (typeof RENDER_SERVICE_ERRORS)[number];
export const renderServiceErrorSchema = z.object({ error: z.enum(RENDER_SERVICE_ERRORS) }).strict();

/** JPEG 의 첫 세 바이트 */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

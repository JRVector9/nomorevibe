import { randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
import type { BrowserServer, BrowserType, LaunchOptions, Page, Response } from "@playwright/test";
import { startEgressProxy, type EgressProxy, type EgressProxyOptions, type EgressStats } from "./egress-proxy";
import { blockedAddress, blockedHostname, renderableUrl, SCREEN_DEFAULT_PORTS, SCREEN_MAX_SCREENSHOT_BYTES, SCREEN_TEXT_LIMIT, SCREEN_VIEWPORT,
  urlPort, type FontCheck, type RenderPageError } from "./protocol";

/**
 * 화면 서버의 그리기 하나 — 그리기마다 새 Chromium 을 띄워(사이트끼리 캐시·쿠키·프로세스를 나누지 않는다) 끝나면 프로세스 묶음째 없앤다.
 *
 * 지키는 것(docs/operations/2026-10-22-screen-review-design.md 보안 절):
 *  - 바깥 길은 그리기마다 띄우는 egress 프록시 하나(egress-proxy.ts) — 인증(무작위 비밀)·루프백 우회 끔(<-loopback>)·브라우저의 직접 DNS 막음
 *    (--host-resolver-rules)·QUIC 끔·WebRTC 는 프록시 밖 UDP 금지. 요청 가로채기(route)가 한 번 더 스킴·이름·IP 리터럴·포트·요청 수를 본다.
 *  - Chromium 샌드박스를 켠다(Playwright 의 기본은 끔이다 — chromiumSandbox:true 로 켠다). 서버는 root 로 뜨지 않는다(server.ts).
 *  - 내려받기·권한·서비스 워커·팝업·대화상자는 받지 않는다. 브라우저 환경변수는 비운다(서버의 비밀이 브라우저 프로세스에 가지 않게).
 *  - 시간 상한(deadlineMs, 기본 40초) — 넘으면 BrowserServer.kill()(Playwright 가 프로세스 묶음째 SIGKILL) 하고 timeout 으로 돌려준다.
 *    실측(2026-10-22 보류 918건): 그리기 중앙값 3.6초·p95 21.5초·최대 240초(한 건이 걸려 멈췄다 — 이 상한이 그것을 막는다).
 *  - 첫 문서가 막혔거나(사설로 넘겨줌 포함) 4xx/5xx 면 화면을 판정하지 않는다(blocked·http_status) — 막힘 화면·봇 차단 화면을 모델이 보지 않게.
 */

export type ScreenBrowserType = Pick<BrowserType, "launchServer" | "connect">;

export type RenderOptions = {
  /** 시험의 가짜 브라우저 — 없으면 @playwright/test 의 chromium */
  browserType?: ScreenBrowserType;
  /** Chromium 샌드박스 — 운영은 늘 켠다 */
  sandbox: boolean;
  executablePath?: string;
  ports?: readonly number[];
  deadlineMs?: number;
  navigationTimeoutMs?: number;
  idleWaitMs?: number;
  settleMs?: number;
  screenshotTimeoutMs?: number;
  maxRequests?: number;
  maxBytes?: number;
  userAgent?: string;
  /** 시험: 진짜 정책 그대로 두고 DNS·연결만 바꾼다 */
  egress?: Pick<EgressProxyOptions, "lookup" | "dial">;
  signal?: AbortSignal;
  /** 시험: 브라우저를 죽였을 때 */
  onKill?: () => void;
  /** 브라우저가 뜨지 않거나 죽은 까닭 — 서버가 기록에 남긴다(페이지 글은 싣지 않는다) */
  onError?: (error: unknown) => void;
};

export type RenderOutcome =
  | { ok: true; finalUrl: string; status: number | null; text: string; textLength: number; screenshot: Buffer; renderMs: number; egress: EgressStats }
  | { ok: false; error: RenderPageError; status: number | null; renderMs: number; egress: EgressStats | null };

export const RENDER_DEFAULTS = { deadlineMs: 40_000, navigationTimeoutMs: 20_000, idleWaitMs: 5_000, settleMs: 1_500, screenshotTimeoutMs: 10_000,
  maxRequests: 400, maxBytes: 40 * 1024 * 1024 };
/** 브라우저 이름 — 흔한 Chrome 꼴에 누구인지 덧붙인다(HeadlessChrome 을 막는 사이트가 많다) */
export const SCREEN_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 "
  + "NoMoreVibe/1.0 (+https://nomorevibe.com)";

/**
 * Chromium 을 단단히 묶는 인자 — 배경 통신(업데이트·동기화·지표·안전 확인)을 끄고, 브라우저가 스스로 DNS 를 풀지 못하게 하고(프록시만 푼다),
 * QUIC(UDP)·WebRTC 의 프록시 밖 UDP 를 끈다. --disable-features 는 주지 않는다 — Chromium 은 같은 스위치의 마지막 값만 읽어 Playwright 가
 * 넣는 목록(MediaRouter·OptimizationHints·Translate 등을 이미 끈다)을 덮어 버린다
 */
export function chromiumArgs(platform: NodeJS.Platform = process.platform): string[] {
  return [
    "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-domain-reliability",
    "--disable-sync", "--disable-breakpad", "--disable-client-side-phishing-detection", "--no-pings", "--no-first-run",
    "--disable-quic", "--dns-prefetch-disable",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    "--deny-permission-prompts", "--mute-audio", "--disable-print-preview", "--disable-speech-api",
    ...(platform === "linux" ? ["--disable-dev-shm-usage"] : []),
  ];
}

/**
 * 브라우저에 넘기는 환경 — 서버의 비밀(토큰 등)을 물려주지 않는다. HOME 은 그 사용자의 진짜 집(passwd)이다: 리눅스 fontconfig 는
 * $HOME/.local/share/fonts 에서 글꼴을 찾으므로 HOME 을 바꾸면 사용자 글꼴(Noto CJK)이 사라져 두부가 그려진다(2026-10-22 gpu3090 에서 확인)
 */
function browserEnv(): Record<string, string> {
  const env: Record<string, string> = { HOME: os.userInfo().homedir, PATH: process.env.PATH ?? "/usr/bin:/bin", TZ: "UTC", LANG: "en_US.UTF-8" };
  for (const name of ["TMPDIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "FONTCONFIG_FILE", "FONTCONFIG_PATH"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

/** 보이는 글을 접는다 — 제어 문자를 빼고, 공백·빈 줄을 줄이고, 6,000자에서 자른다(서로게이트 쌍을 가르지 않는다) */
export function normalizeRenderedText(raw: string): { text: string; length: number } {
  const folded = raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  let text = folded.slice(0, SCREEN_TEXT_LIMIT);
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  return { text: text.trim(), length: folded.length };
}

async function defaultBrowserType(): Promise<ScreenBrowserType> {
  const { chromium } = await import("@playwright/test");
  return chromium;
}

const parse = (raw: string): URL | null => { try { return new URL(raw); } catch { return null; } };

function launchOptions(options: RenderOptions, proxy: EgressProxy, credentials: { username: string; password: string }): LaunchOptions {
  return {
    headless: true, chromiumSandbox: options.sandbox, ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    proxy: { server: proxy.url, bypass: "<-loopback>", username: credentials.username, password: credentials.password },
    args: chromiumArgs(), env: browserEnv(), timeout: 15_000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  };
}

/**
 * 요청 가로채기 — 프록시보다 앞에서 한 번 더 본다: http(s)·data·blob 만, 이름으로 막는 호스트·사설 IP 리터럴·허용 밖 포트는 끊고,
 * 영상·소리(media)는 받지 않는다. 요청 수 상한도 센다(프록시도 따로 센다)
 */
async function guardRequests(page: Page, ports: readonly number[], maxRequests: number): Promise<{ count: () => number; blocked: () => number;
  navigationBlocked: () => boolean }> {
  let requests = 0, blocked = 0, navigationBlocked = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = parse(request.url());
    requests += 1;
    const abort = () => {
      blocked += 1;
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigationBlocked = true;
      return route.abort("blockedbyclient");
    };
    if (!url || requests > maxRequests) return abort();
    if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    if (url.protocol !== "http:" && url.protocol !== "https:") return abort();
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if ((net.isIP(host) ? blockedAddress(host) : blockedHostname(host)) || !ports.includes(urlPort(url))) return abort();
    if (request.resourceType() === "media") return route.abort("blockedbyclient");
    return route.continue();
  });
  return { count: () => requests, blocked: () => blocked, navigationBlocked: () => navigationBlocked };
}

/** 한 페이지를 그린다 — 실패는 던지지 않고 고정 코드로 돌려준다 */
export async function renderPage(raw: string, options: RenderOptions): Promise<RenderOutcome> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const ports = options.ports ?? SCREEN_DEFAULT_PORTS;
  const url = renderableUrl(raw, ports);
  if (!url) return { ok: false, error: "unsafe_url", status: null, renderMs: elapsed(), egress: null };
  const settings = {
    deadlineMs: options.deadlineMs ?? RENDER_DEFAULTS.deadlineMs, navigationTimeoutMs: options.navigationTimeoutMs ?? RENDER_DEFAULTS.navigationTimeoutMs,
    idleWaitMs: options.idleWaitMs ?? RENDER_DEFAULTS.idleWaitMs, settleMs: options.settleMs ?? RENDER_DEFAULTS.settleMs,
    screenshotTimeoutMs: options.screenshotTimeoutMs ?? RENDER_DEFAULTS.screenshotTimeoutMs,
    maxRequests: options.maxRequests ?? RENDER_DEFAULTS.maxRequests, maxBytes: options.maxBytes ?? RENDER_DEFAULTS.maxBytes,
  };
  const credentials = { username: "nmv", password: randomBytes(18).toString("base64url") };
  const proxy = await startEgressProxy({ ...options.egress, ports, maxRequests: settings.maxRequests, maxBytes: settings.maxBytes, credentials });
  const state: { server: BrowserServer | null; timedOut: boolean; killed: boolean } = { server: null, timedOut: false, killed: false };
  const kill = async () => {
    if (state.killed || !state.server) return;
    state.killed = true;
    options.onKill?.();
    await state.server.kill().catch(() => {});
  };
  const fail = (error: RenderPageError, status: number | null = null): RenderOutcome =>
    ({ ok: false, error, status, renderMs: elapsed(), egress: proxy.stats });

  const work = async (): Promise<RenderOutcome> => {
    const browserType = options.browserType ?? await defaultBrowserType();
    state.server = await browserType.launchServer(launchOptions(options, proxy, credentials));
    if (state.timedOut) { await kill(); return fail("timeout"); }
    const browser = await browserType.connect(state.server.wsEndpoint(), { timeout: 10_000 });
    const context = await browser.newContext({
      viewport: { ...SCREEN_VIEWPORT }, deviceScaleFactor: 1, userAgent: options.userAgent ?? SCREEN_USER_AGENT, locale: "en-US", timezoneId: "UTC",
      acceptDownloads: false, serviceWorkers: "block", permissions: [], javaScriptEnabled: true, ignoreHTTPSErrors: false, bypassCSP: false,
      colorScheme: "light", reducedMotion: "reduce", extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
    });
    const page = await context.newPage();
    // 팝업·새 창은 닫는다 — 첫 화면만 본다
    context.on("page", (other) => { if (other !== page) void other.close().catch(() => {}); });
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
    page.on("download", (download) => void download.cancel().catch(() => {}));
    const guard = await guardRequests(page, ports, settings.maxRequests);
    // 첫 문서(넘겨주기·JS 이동 포함)의 마지막 응답 — 막힘·오류 화면을 판정하지 않게
    const main: { last: Response | null } = { last: null };
    page.on("response", (response) => {
      try {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) main.last = response;
      } catch { /* 프레임 없는 응답(서비스 워커 — 막아 두었다) */ }
    });
    // 첫 문서(또는 그리로 가는 이동)가 막혔는가 — 가로채기가 끊은 이동이거나, 프록시가 이름·IP·포트로 막은 것이 있다
    const egressBlocked = () => guard.navigationBlocked()
      || (proxy.stats.reasons.host ?? 0) + (proxy.stats.reasons.address ?? 0) + (proxy.stats.reasons.port ?? 0) > 0;
    const overBudget = () => (proxy.stats.reasons.budget_bytes ?? 0) + (proxy.stats.reasons.budget_requests ?? 0) > 0;
    let response: Response | null;
    try {
      response = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs });
    } catch (error) {
      if (egressBlocked()) return fail("blocked");
      if (overBudget()) return fail("budget");
      return fail(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "navigation_failed");
    }
    const judgeMain = (main: Response | null): RenderOutcome | null => {
      if (!main) return fail("navigation_failed");
      if (main.headers()["x-nmv-egress"] === "blocked") return fail("blocked", main.status());
      if (main.status() >= 400) return fail("http_status", main.status());
      return null;
    };
    const first = judgeMain(response);
    if (first) return first;
    await page.waitForLoadState("networkidle", { timeout: settings.idleWaitMs }).catch(() => {});
    await page.waitForTimeout(settings.settleMs);
    // 다 그린 뒤 다시 본다 — 첫 문서 뒤에 JS·meta refresh 로 막힌 곳이나 오류 화면으로 옮겨 갔으면 판정하지 않는다
    const finalUrl = page.url();
    const final = parse(finalUrl);
    if (!final || (final.protocol !== "http:" && final.protocol !== "https:")) return fail(egressBlocked() ? "blocked" : "navigation_failed");
    const later = judgeMain(main.last ?? response);
    if (later) return later;
    if (overBudget()) return fail("budget");
    const visible = await page.evaluate("document.body ? document.body.innerText : ''").catch(() => "");
    const { text, length } = normalizeRenderedText(typeof visible === "string" ? visible : "");
    let screenshot: Buffer;
    try {
      screenshot = await page.screenshot({ type: "jpeg", quality: 70, timeout: settings.screenshotTimeoutMs, animations: "disabled", caret: "hide",
        scale: "css" });
    } catch {
      return fail("screenshot_failed");
    }
    if (!screenshot.length || screenshot.length > SCREEN_MAX_SCREENSHOT_BYTES) return fail("screenshot_failed");
    const status = (main.last ?? response)?.status() ?? null;
    return { ok: true, finalUrl, status, text, textLength: length, screenshot, renderMs: elapsed(), egress: proxy.stats };
  };

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), settings.deadlineMs);
    if (options.signal) {
      onAbort = () => resolve("timeout");
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    const result = await Promise.race([work().catch((error): RenderOutcome => {
      if (!state.timedOut) options.onError?.(error);
      return fail("browser_failed");
    }), stop]);
    if (result === "timeout") {
      state.timedOut = true;
      await kill();
      return fail("timeout");
    }
    return result;
  } finally {
    clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    if (state.server && !state.killed) {
      // 정상 종료를 5초까지 기다리고, 안 되면 죽인다
      const server = state.server;
      const closed = await Promise.race([server.close().then(() => true, () => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))]);
      if (!closed) await kill();
    }
    await proxy.close();
  }
}

/** 캔버스에 그려 보는 글 — 없는 글자(U+10FFFD)·빈 그림과 같은 모양이면 그 글꼴이 없다 */
const FONT_PROBE = `(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 64; canvas.height = 64;
  const g = canvas.getContext("2d");
  const draw = (text) => {
    g.clearRect(0, 0, 64, 64);
    g.fillStyle = "#000"; g.font = "40px sans-serif"; g.textBaseline = "top";
    g.fillText(text, 4, 4);
    const data = g.getImageData(0, 0, 64, 64).data;
    let out = "";
    for (let index = 3; index < data.length; index += 4) out += data[index] > 127 ? "1" : "0";
    return out;
  };
  const missing = draw("\\u{10FFFD}"), blank = draw("");
  const has = (text) => { const shape = draw(text); return shape !== missing && shape !== blank; };
  return { ko: has("\\uD55C"), ja: has("\\u3042"), zh: has("\\u4EEC") };
})()`;

/**
 * 글꼴 자체 점검 — 네트워크 없이(빈 페이지) 캔버스에 한글·가나·간체자를 그려, 없는 글자(U+10FFFD)·빈 그림과 같으면 그 글꼴이 없다고 본다.
 * 리눅스는 없는 글자가 모두 같은 두부로 그려져 잘 가려진다. macOS 는 시스템 글꼴(Apple SD Gothic Neo·Hiragino·PingFang)이 늘 있다.
 */
export async function checkFonts(options: Pick<RenderOptions, "browserType" | "sandbox" | "executablePath" | "onError"> & { deadlineMs?: number }):
  Promise<FontCheck | null> {
  // 이 점검은 어디에도 나가지 않는다 — 모든 요청을 막는 프록시(포트 목록 비움)에 묶는다
  const credentials = { username: "nmv", password: randomBytes(18).toString("base64url") };
  const proxy = await startEgressProxy({ ports: [], credentials });
  const holder: { server: BrowserServer | null } = { server: null };
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async () => {
      const browserType = options.browserType ?? await defaultBrowserType();
      holder.server = await browserType.launchServer(launchOptions({ sandbox: options.sandbox, executablePath: options.executablePath }, proxy, credentials));
      const browser = await browserType.connect(holder.server.wsEndpoint(), { timeout: 10_000 });
      const page = await browser.newPage();
      await page.setContent("<!doctype html><meta charset=utf-8><body></body>");
      // 글로 넘긴다 — tsx(esbuild)가 함수에 넣는 __name 도우미가 브라우저에는 없다
      return page.evaluate(FONT_PROBE) as Promise<FontCheck>;
    })();
    const fonts = await Promise.race([work, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), options.deadlineMs ?? 30_000); })]);
    return fonts;
  } catch (error) {
    options.onError?.(error);
    return null;
  } finally {
    clearTimeout(timer);
    await holder.server?.kill().catch(() => {});
    await proxy.close();
  }
}

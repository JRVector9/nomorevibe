import http from "node:http";
import net from "node:net";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserServer } from "@playwright/test";
import { chromiumArgs, checkFonts, normalizeRenderedText, renderPage, type ScreenBrowserType } from "@/lib/screen-review/renderer";
import { isJpeg } from "@/lib/screen-review/protocol";

/**
 * 화면 서버의 그리기(renderer.ts). 앞 묶음은 가짜 브라우저로 시간 상한·죽이기·실패 코드를 본다(CI 에서 돈다).
 * 뒤 묶음은 진짜 Chromium(Playwright 가 받은 headless shell)으로 SPA 를 그리고 사설 목적지가 막히는지 본다 — 브라우저가 없는 곳(CI)에서는 건너뛴다.
 * 바깥 사이트에는 나가지 않는다: 공개 IP 93.184.216.34 를 로컬 서버로 잇는다(정책은 진짜 그대로).
 */

const never = <T>() => new Promise<T>(() => {});

/** 가짜 브라우저 — goto 가 영영 끝나지 않는다(걸린 페이지) */
function hangingBrowser(record: { killed: number; closed: number; launched: number }, options: { hangLaunchMs?: number } = {}): ScreenBrowserType {
  const page = {
    on: () => {}, route: async () => {}, goto: () => never(), url: () => "about:blank", waitForLoadState: async () => {}, waitForTimeout: async () => {},
  };
  const server = { wsEndpoint: () => "ws://fake", kill: async () => { record.killed += 1; }, close: async () => { record.closed += 1; } };
  return {
    launchServer: async () => {
      record.launched += 1;
      if (options.hangLaunchMs) await new Promise((resolve) => setTimeout(resolve, options.hangLaunchMs));
      return server as unknown as BrowserServer;
    },
    connect: async () => ({ newContext: async () => ({ newPage: async () => page, on: () => {} }) }),
  } as unknown as ScreenBrowserType;
}

describe("시간 상한·죽이기(가짜 브라우저)", () => {
  it("걸린 페이지는 상한에서 브라우저를 죽이고 timeout 으로 돌려준다 — 닫기를 기다리지 않는다", async () => {
    const record = { killed: 0, closed: 0, launched: 0 };
    let killedHook = 0;
    const started = Date.now();
    const result = await renderPage("https://example.com/", { sandbox: true, browserType: hangingBrowser(record), deadlineMs: 150,
      onKill: () => { killedHook += 1; } });
    expect(result).toMatchObject({ ok: false, error: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(record).toMatchObject({ killed: 1, closed: 0, launched: 1 });
    expect(killedHook).toBe(1);
  });

  it("브라우저가 늦게 뜨면(상한 뒤) 뜨자마자 죽인다", async () => {
    const record = { killed: 0, closed: 0, launched: 0 };
    const result = await renderPage("https://example.com/", { sandbox: true, browserType: hangingBrowser(record, { hangLaunchMs: 300 }), deadlineMs: 100 });
    expect(result).toMatchObject({ ok: false, error: "timeout" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(record.killed).toBe(1);
  });

  it("부른 쪽이 멈추면(신호) 곧바로 죽인다", async () => {
    const record = { killed: 0, closed: 0, launched: 0 };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await renderPage("https://example.com/", { sandbox: true, browserType: hangingBrowser(record), deadlineMs: 10_000, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: "timeout" });
    expect(record.killed).toBe(1);
  });

  it("브라우저가 뜨지 않으면 browser_failed — 까닭은 onError 로만", async () => {
    const errors: unknown[] = [];
    const browserType = { launchServer: async () => { throw new Error("no usable sandbox"); }, connect: async () => { throw new Error("x"); } } as unknown as ScreenBrowserType;
    const result = await renderPage("https://example.com/", { sandbox: true, browserType, onError: (error) => errors.push(error) });
    expect(result).toMatchObject({ ok: false, error: "browser_failed" });
    expect(errors).toHaveLength(1);
  });

  it("그릴 수 없는 주소는 브라우저를 띄우지 않는다", async () => {
    const record = { killed: 0, closed: 0, launched: 0 };
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/", "http://100.100.1.1/", "file:///etc/passwd", "https://example.com:8443/"]) {
      expect(await renderPage(url, { sandbox: true, browserType: hangingBrowser(record) }), url).toMatchObject({ ok: false, error: "unsafe_url", egress: null });
    }
    expect(record.launched).toBe(0);
  });

  it("Chromium 인자 — 직접 DNS·QUIC·프록시 밖 UDP 를 끄고, 샌드박스를 끄는 인자는 넣지 않는다", () => {
    const args = chromiumArgs("darwin");
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
    expect(args).toContain("--disable-quic");
    expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(args.some((arg) => arg.includes("no-sandbox") || arg.startsWith("--disable-features"))).toBe(false);
    expect(chromiumArgs("linux")).toContain("--disable-dev-shm-usage");
  });

  it("보이는 글은 제어 문자를 빼고 공백을 접어 6,000자에서 자른다", () => {
    expect(normalizeRenderedText("  Hello\t\t world \r\n\n\n\n\nnext\u0000\u0007 ").text).toBe("Hello world\n\nnext");
    const long = normalizeRenderedText(`${"가".repeat(5_999)}😀tail`);
    expect(long.text.length).toBe(5_999);
    expect(long.length).toBe(6_005);
  });
});

/** Playwright 가 받은 headless shell — 없으면 진짜 브라우저 시험은 건너뛴다(CI) */
function localChromium(): string | null {
  if (process.env.SCREEN_TEST_CHROMIUM) return existsSync(process.env.SCREEN_TEST_CHROMIUM) ? process.env.SCREEN_TEST_CHROMIUM : null;
  const root = path.join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse()) {
    const candidate = path.join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
const executablePath = localChromium();
// 우분투 23.10+ 는 비특권 사용자 이름공간을 막아 Chromium 샌드박스가 뜨지 않는다 — 이 시험만 끈다(운영 서버는 끄면 뜨지 않는다)
const sandbox = process.env.SCREEN_TEST_SANDBOX === "1";
const PUBLIC = "93.184.216.34";

describe.skipIf(!executablePath)("진짜 Chromium", () => {
  let origin: http.Server, port = 0;
  const seen: string[] = [];
  const dialed: string[] = [];
  let rebind = 0;
  beforeAll(async () => {
    origin = http.createServer((req, res) => {
      seen.push(`${req.headers.host}${req.url}`);
      const html = (body: string) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(`<!doctype html><meta charset=utf-8>${body}`); };
      if (req.url === "/spa") {
        return html(`<title>SPA</title><div id=app>loading</div>
          <img src="http://169.254.169.254/latest/meta-data/a.png"><img src="http://tail.example/b.png"><img src="http://meta.example/c.png">
          <script>setTimeout(() => { document.getElementById("app").textContent = "Acme 앱 — 지금 시작하기"; fetch("http://100.64.1.1/api").catch(() => {}); }, 200)</script>`);
      }
      if (req.url === "/redirect-private") { res.writeHead(302, { location: "http://10.0.0.1/admin" }); return res.end(); }
      if (req.url === "/js-private") return html(`<p>moving</p><script>setTimeout(() => { location.href = "http://192.168.50.241:18081/"; }, 100)</script>`);
      if (req.url === "/rebind") return html(`<p id=s>start</p><script>fetch("/api").then(r => r.text()).then(t => { document.getElementById("s").textContent = t; }, () => { document.getElementById("s").textContent = "fetch blocked"; })</script>`);
      if (req.url === "/api") { res.writeHead(200); return res.end("SECRET-FROM-API"); }
      if (req.url === "/forbidden") { res.writeHead(403, { "content-type": "text/html" }); return res.end("<h1>Just a moment...</h1>"); }
      if (req.url === "/hang") return html(`<p>busy</p><script>setTimeout(() => { for (;;) {} }, 50)</script>`);
      if (req.url === "/popup") return html(`<p>popup</p><script>window.open("http://public.example/spa"); alert("hi")</script>`);
      res.writeHead(404); res.end();
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    port = (origin.address() as net.AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>((resolve) => origin.close(() => resolve())); });

  const egress = {
    lookup: async (host: string) => {
      if (host === "public.example") return [{ address: PUBLIC, family: 4 }];
      if (host === "tail.example") return [{ address: "100.100.1.2", family: 4 }];
      if (host === "meta.example") return [{ address: "169.254.169.254", family: 4 }];
      if (host === "rebind.example") return [{ address: ++rebind === 1 ? PUBLIC : "10.0.0.7", family: 4 }];
      throw new Error("ENOTFOUND");
    },
    dial: (address: string, dialPort: number) => {
      dialed.push(`${address}:${dialPort}`);
      if (address !== PUBLIC) throw new Error(`dialed a non-public address ${address}`);
      return net.connect({ host: "127.0.0.1", port });
    },
  };
  const render = (url: string, extra: Partial<Parameters<typeof renderPage>[1]> = {}) =>
    renderPage(url, { sandbox, executablePath: executablePath!, egress, settleMs: 300, idleWaitMs: 2_000, ...extra });

  it("SPA 를 그려 보이는 글·첫 화면 JPEG 를 돌려주고, 하위 자원의 169.254/100.64/사설 이름은 나가지 않는다", async () => {
    seen.length = 0; dialed.length = 0;
    const result = await render("http://public.example/spa");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("Acme 앱 — 지금 시작하기");
    expect(result.status).toBe(200);
    expect(isJpeg(result.screenshot)).toBe(true);
    expect(seen).toEqual(["public.example/spa"]);
    expect(dialed.every((entry) => entry.startsWith(`${PUBLIC}:`))).toBe(true);
    expect(result.egress.blockedTargets.some((target) => target.startsWith("tail.example:80") || target.startsWith("meta.example:80"))).toBe(true);
  }, 30_000);

  it("사설 IP 로 넘겨주면(302) 판정하지 않고 blocked", async () => {
    dialed.length = 0;
    expect(await render("http://public.example/redirect-private")).toMatchObject({ ok: false, error: "blocked" });
    expect(dialed).toEqual([`${PUBLIC}:80`]);
  }, 30_000);

  it("그린 뒤 JS 로 사설 주소에 옮겨 가도 blocked", async () => {
    expect(await render("http://public.example/js-private", { settleMs: 800 })).toMatchObject({ ok: false, error: "blocked" });
  }, 30_000);

  it("DNS 리바인딩 — 첫 문서 뒤 같은 이름이 사설로 바뀌면 그 요청은 나가지 않는다", async () => {
    seen.length = 0; rebind = 0;
    const result = await render("http://rebind.example/rebind", { settleMs: 800 });
    expect(seen).toEqual(["rebind.example/rebind"]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.text).not.toContain("SECRET-FROM-API");
    expect(result.ok && result.egress.blockedTargets).toEqual(["rebind.example:80 address"]);
  }, 30_000);

  it("첫 문서가 4xx 면 봇 차단 화면을 판정하지 않는다", async () => {
    expect(await render("http://public.example/forbidden")).toMatchObject({ ok: false, error: "http_status", status: 403 });
  }, 30_000);

  it("팝업·대화상자가 그리기를 막지 않는다", async () => {
    const result = await render("http://public.example/popup");
    expect(result.ok && result.text).toContain("popup");
  }, 30_000);

  it("JS 가 멈춘 페이지는 상한에서 프로세스 묶음째 죽인다", async () => {
    const pids: number[] = [];
    const { chromium } = await import("@playwright/test");
    const browserType: ScreenBrowserType = {
      launchServer: async (options) => { const server = await chromium.launchServer(options); pids.push(server.process().pid!); return server; },
      connect: (endpoint, options) => chromium.connect(endpoint, options),
    } as ScreenBrowserType;
    let killed = 0;
    const result = await render("http://public.example/hang", { browserType, deadlineMs: 4_000, settleMs: 3_000, onKill: () => { killed += 1; } });
    expect(result).toMatchObject({ ok: false, error: "timeout" });
    expect(killed).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(pids).toHaveLength(1);
    expect(alive(pids[0])).toBe(false);
  }, 30_000);

  it("글꼴 점검 — CJK 글꼴이 없으면 두부를 가려낸다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nmv-fonts-"));
    const config = path.join(dir, "fonts.conf");
    // DejaVu 만 보이는 fontconfig — 한글·가나·한자가 없다
    writeFileSync(config, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/usr/share/fonts/truetype/dejavu</dir><cachedir>${dir}</cachedir></fontconfig>`);
    const before = process.env.FONTCONFIG_FILE;
    process.env.FONTCONFIG_FILE = config;
    try {
      expect(await checkFonts({ sandbox, executablePath: executablePath! })).toEqual({ ko: false, ja: false, zh: false });
    } finally {
      if (before === undefined) delete process.env.FONTCONFIG_FILE; else process.env.FONTCONFIG_FILE = before;
    }
  }, 30_000);
});

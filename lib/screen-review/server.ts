import http from "node:http";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { egressSummary } from "./egress-proxy";
import type { RenderOutcome } from "./renderer";
import { fontsComplete, renderableUrl, renderRequestSchema, SCREEN_RENDER_PROTOCOL, type FontCheck, type RenderHealth, type RenderResponse,
  type RenderServiceError } from "./protocol";

/**
 * 화면 서버의 HTTP 쪽 — scripts/screen-render/server.ts 가 띄운다. 워커(reviewer)만 부른다.
 *  - POST /v1/render {url}: 그리기 하나 → 200 과 그린 결과(RenderResponse — 페이지 탓 실패도 200 의 ok:false)
 *  - GET /v1/health: 판·샌드박스·글꼴 점검·지금 그리는 수
 * 문: Bearer 토큰(상수 시간 비교) → 부르는 IP 허용 목록(있으면) → 주소 검사 → 동시 그리기 상한(넘으면 429 — 줄을 세우지 않는다) →
 * 글꼴 점검이 다 맞을 때만 그린다(503 fonts_missing — 두부 화면을 모델이 보지 않게). 본문 4KB·머리 10초·요청 90초 상한.
 */

export type RenderServiceOptions = {
  token: string;
  /** 부를 수 있는 IP(Tailscale 의 M3·mini 등) — 비면 토큰만 본다 */
  allowFrom?: readonly string[];
  maxConcurrent: number;
  ports: readonly number[];
  version: string;
  sandbox: boolean;
  render: (url: string, signal: AbortSignal) => Promise<RenderOutcome>;
  /** 글꼴 점검 결과 — null 이면 아직 못 했다(not_ready) */
  fonts: () => FontCheck | null;
};

const BODY_LIMIT = 4 * 1024;

function sameToken(header: string | undefined, token: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7)), expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** ::ffff:100.1.2.3 → 100.1.2.3 */
const plainIp = (address: string | undefined) => (address ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");

export function createRenderService(options: RenderServiceOptions): http.Server & { busy: () => number } {
  if (options.token.length < 32) throw new Error("render_token_too_short");
  const startedAt = new Date().toISOString();
  let busy = 0;
  const allow = new Set((options.allowFrom ?? []).map((ip) => ip.trim()).filter((ip) => net.isIP(ip)));

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  const refuse = (res: http.ServerResponse, status: number, error: RenderServiceError) => send(res, status, { error });

  const server = http.createServer(async (req, res) => {
    if (allow.size && !allow.has(plainIp(req.socket.remoteAddress))) return refuse(res, 403, "forbidden");
    if (!sameToken(req.headers.authorization, options.token)) return refuse(res, 401, "unauthorized");
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/v1/health") {
      const fonts = options.fonts();
      const health: RenderHealth = { ok: fontsComplete(fonts) && options.sandbox, protocol: SCREEN_RENDER_PROTOCOL, version: options.version.slice(0, 80),
        sandbox: options.sandbox, busy, maxConcurrent: options.maxConcurrent, fonts, startedAt };
      return send(res, 200, health);
    }
    if (req.method !== "POST" || path !== "/v1/render") return refuse(res, 404, "not_found");
    let raw = "";
    let size = 0;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > BODY_LIMIT) return refuse(res, 400, "bad_request");
        raw += (chunk as Buffer).toString("utf8");
      }
    } catch { return; }
    let url: string;
    try {
      const parsed = renderRequestSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return refuse(res, 400, "bad_request");
      url = parsed.data.url;
    } catch { return refuse(res, 400, "bad_request"); }
    if (!renderableUrl(url, options.ports)) return refuse(res, 400, "bad_request");
    const fonts = options.fonts();
    if (!fonts) return refuse(res, 503, "not_ready");
    if (!fontsComplete(fonts)) return refuse(res, 503, "fonts_missing");
    if (busy >= options.maxConcurrent) return refuse(res, 429, "busy");
    busy += 1;
    // 부른 쪽이 끊으면 그리기도 멈춘다(브라우저를 죽인다)
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", onClose);
    try {
      const outcome = await options.render(url, controller.signal);
      const body: RenderResponse = outcome.ok
        ? { ok: true, protocol: SCREEN_RENDER_PROTOCOL, finalUrl: outcome.finalUrl.slice(0, 4096), status: outcome.status, text: outcome.text,
          textLength: outcome.textLength, screenshot: outcome.screenshot.toString("base64"), renderMs: outcome.renderMs, egress: egressSummary(outcome.egress) }
        : { ok: false, protocol: SCREEN_RENDER_PROTOCOL, error: outcome.error, status: outcome.status, renderMs: outcome.renderMs,
          egress: outcome.egress ? egressSummary(outcome.egress) : null };
      if (!res.destroyed) send(res, 200, body);
    } catch {
      if (!res.destroyed) send(res, 200, { ok: false, protocol: SCREEN_RENDER_PROTOCOL, error: "browser_failed", status: null, renderMs: 0, egress: null });
    } finally {
      busy -= 1;
      res.off("close", onClose);
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 90_000;
  server.keepAliveTimeout = 5_000;
  return Object.assign(server, { busy: () => busy });
}

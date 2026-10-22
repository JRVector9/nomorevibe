/**
 * 화면 서버 — m1-studio 에서 전용 사용자(nmvrender)의 launchd 데몬으로 돈다(scripts/ops/screen-render.sh install).
 * 워커(reviewer)가 Tailscale 로 부른다. DB·모델 비밀을 모른다. 설계: docs/operations/2026-10-22-screen-review-design.md
 *
 * 환경:
 *   SCREEN_RENDER_HOST        들을 주소(그 Mac 의 Tailscale IP). 0.0.0.0·:: 는 SCREEN_RENDER_ALLOW_ANY_HOST=1 일 때만
 *   SCREEN_RENDER_PORT        기본 8790
 *   SCREEN_RENDER_TOKEN_FILE  Bearer 토큰 파일(32자 이상, 그 사용자만 읽기) — 없으면 SCREEN_RENDER_TOKEN
 *   SCREEN_RENDER_ALLOW_FROM  부를 수 있는 IP(쉼표) — M3·mini 의 Tailscale IP
 *   SCREEN_RENDER_CONCURRENCY 동시 그리기(기본 2, 최대 4)
 *   SCREEN_RENDER_PORTS       그릴 수 있는 포트(기본 80,443)
 *   SCREEN_RENDER_CHROMIUM    Chromium 실행 파일(없으면 Playwright 가 받은 것)
 *   SCREEN_RENDER_SANDBOX=0   샌드박스 끔 — SCREEN_RENDER_ALLOW_NO_SANDBOX=1 과 함께일 때만(시험용, 운영 금지)
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { checkFonts, renderPage } from "@/lib/screen-review/renderer";
import { createRenderService } from "@/lib/screen-review/server";
import { parsePorts, type FontCheck } from "@/lib/screen-review/protocol";

const env = process.env;
const fail = (message: string): never => {
  console.error(JSON.stringify({ event: "screen_render.refused", message }));
  process.exit(1);
};

if (typeof process.getuid === "function" && process.getuid() === 0) fail("root 로 띄우지 않는다 — 전용 사용자로 띄운다");
const host = env.SCREEN_RENDER_HOST?.trim() ?? "";
if (!net.isIP(host)) fail("SCREEN_RENDER_HOST 에 들을 IP 를 적는다(Tailscale IP)");
if ((host === "0.0.0.0" || host === "::") && env.SCREEN_RENDER_ALLOW_ANY_HOST !== "1") fail("모든 주소에서 듣지 않는다");
const port = Number(env.SCREEN_RENDER_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail("SCREEN_RENDER_PORT");
const token = (env.SCREEN_RENDER_TOKEN_FILE ? readFileSync(env.SCREEN_RENDER_TOKEN_FILE, "utf8") : env.SCREEN_RENDER_TOKEN ?? "").trim();
if (token.length < 32) fail("토큰은 32자 이상");
const sandbox = env.SCREEN_RENDER_SANDBOX !== "0";
if (!sandbox && env.SCREEN_RENDER_ALLOW_NO_SANDBOX !== "1") fail("샌드박스를 끄려면 SCREEN_RENDER_ALLOW_NO_SANDBOX=1 — 운영 금지");
const concurrency = Math.min(4, Math.max(1, Number(env.SCREEN_RENDER_CONCURRENCY ?? 2) || 2));
const ports = parsePorts(env.SCREEN_RENDER_PORTS);
const executablePath = env.SCREEN_RENDER_CHROMIUM?.trim() || undefined;
const version = (env.SCREEN_RENDER_VERSION ?? "dev").slice(0, 80);

let fonts: FontCheck | null = null;
const service = createRenderService({
  token, maxConcurrent: concurrency, ports, version, sandbox,
  allowFrom: (env.SCREEN_RENDER_ALLOW_FROM ?? "").split(",").map((ip) => ip.trim()).filter(Boolean),
  fonts: () => fonts,
  render: async (url, signal) => {
    const startedAt = Date.now();
    const outcome = await renderPage(url, { sandbox, executablePath, ports, signal });
    // 기록에는 고정 값만 — 주소는 호스트까지(경로·질의 없음)
    console.log(JSON.stringify({ event: "screen_render.done", host: new URL(url).host, ok: outcome.ok, error: outcome.ok ? null : outcome.error,
      ms: Date.now() - startedAt, requests: outcome.egress?.requests ?? 0, blocked: outcome.egress?.blocked ?? 0 }));
    return outcome;
  },
});

service.listen(port, host, () => console.log(JSON.stringify({ event: "screen_render.listening", host, port, sandbox, concurrency, ports, version })));
// 글꼴 점검 — 끝나기 전에는 그리지 않는다(503 not_ready). 6시간마다 다시 본다(글꼴을 지웠거나 OS 가 바뀌었을 때)
const recheck = async () => {
  fonts = await checkFonts({ sandbox, executablePath });
  console.log(JSON.stringify({ event: "screen_render.fonts", fonts }));
};
void recheck();
setInterval(() => void recheck(), 6 * 3600_000).unref();

const stop = () => {
  service.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

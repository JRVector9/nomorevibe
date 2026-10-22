import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { EgressStats } from "@/lib/screen-review/egress-proxy";
import type { RenderOutcome } from "@/lib/screen-review/renderer";
import { createRenderService, type RenderServiceOptions } from "@/lib/screen-review/server";
import { renderHealthSchema, renderResponseSchema, type FontCheck } from "@/lib/screen-review/protocol";

/** 화면 서버의 HTTP 쪽(server.ts) — 그리기는 가짜로 바꾸고 문(토큰·IP·주소·동시 상한·글꼴)과 답 모양을 본다 */
const TOKEN = "x".repeat(48);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]);
const stats: EgressStats = { requests: 9, bytes: 1_000, blocked: 2, reasons: { address: 2 }, blockedTargets: ["10.0.0.1:80 address"] };
const servers: ReturnType<typeof createRenderService>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())); });

async function start(over: Partial<RenderServiceOptions> = {}) {
  const fonts: { value: FontCheck | null } = { value: { ko: true, ja: true, zh: true } };
  const service = createRenderService({ token: TOKEN, maxConcurrent: 1, ports: [80, 443], version: "test", sandbox: true, fonts: () => fonts.value,
    render: async (): Promise<RenderOutcome> => ({ ok: true, finalUrl: "https://demo.example/", status: 200, text: "Acme", textLength: 4, screenshot: JPEG,
      renderMs: 10, egress: stats }), ...over });
  servers.push(service);
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(service.address() as net.AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) => fetch(`${base}${path}`, { ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...init.headers } });
  const render = (url: string, token: string | null = TOKEN) => call("/v1/render", { method: "POST", body: JSON.stringify({ url }) }, token);
  return { service, fonts, call, render };
}

describe("화면 서버", () => {
  it("토큰이 없거나 틀리면 401, 허용 목록 밖 IP 는 403", async () => {
    const open = await start();
    expect((await open.render("https://demo.example/", null)).status).toBe(401);
    expect((await open.render("https://demo.example/", "y".repeat(48))).status).toBe(401);
    expect((await open.render("https://demo.example/", TOKEN.slice(1))).status).toBe(401);
    const closed = await start({ allowFrom: ["100.70.1.2"] });
    expect((await closed.render("https://demo.example/")).status).toBe(403);
    const allowed = await start({ allowFrom: ["127.0.0.1"] });
    expect((await allowed.render("https://demo.example/")).status).toBe(200);
  });

  it("주소가 그릴 수 없거나 본문이 틀리면 400 — 그리기를 부르지 않는다", async () => {
    let rendered = 0;
    const { call, render } = await start({ render: async () => { rendered += 1; throw new Error("unreachable"); } });
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/", "http://100.100.100.100/", "file:///etc/passwd", "https://demo.example:8443/",
      "http://localhost:3000/"]) expect((await render(url)).status, url).toBe(400);
    expect((await call("/v1/render", { method: "POST", body: "{" })).status).toBe(400);
    expect((await call("/v1/render", { method: "POST", body: JSON.stringify({ url: "https://demo.example/", extra: 1 }) })).status).toBe(400);
    expect((await call("/v1/render", { method: "POST", body: JSON.stringify({ url: `https://demo.example/${"a".repeat(5_000)}` }) })).status).toBe(400);
    expect((await call("/v1/render", { method: "GET" })).status).toBe(404);
    expect(rendered).toBe(0);
  });

  it("글꼴 점검 전에는 503 not_ready, 글꼴이 모자라면 503 fonts_missing", async () => {
    const { fonts, render } = await start();
    fonts.value = null;
    let res = await render("https://demo.example/");
    expect([res.status, await res.json()]).toEqual([503, { error: "not_ready" }]);
    fonts.value = { ko: true, ja: false, zh: true };
    res = await render("https://demo.example/");
    expect([res.status, await res.json()]).toEqual([503, { error: "fonts_missing" }]);
  });

  it("동시 그리기 상한을 넘으면 줄을 세우지 않고 429", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { render } = await start({ render: async () => {
      await gate;
      return { ok: true, finalUrl: "https://demo.example/", status: 200, text: "", textLength: 0, screenshot: JPEG, renderMs: 1, egress: stats };
    } });
    const first = render("https://demo.example/");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await render("https://demo.example/");
    expect([second.status, await second.json()]).toEqual([429, { error: "busy" }]);
    release();
    expect((await first).status).toBe(200);
  });

  it("그린 결과는 약속 모양 — 막은 목적지 이름은 싣지 않는다. 페이지 탓 실패도 200 의 ok:false", async () => {
    const { render, call } = await start();
    const res = await render("https://demo.example/");
    const body = renderResponseSchema.parse(await res.json());
    expect(body).toEqual({ ok: true, protocol: 1, finalUrl: "https://demo.example/", status: 200, text: "Acme", textLength: 4,
      screenshot: JPEG.toString("base64"), renderMs: 10, egress: { requests: 9, bytes: 1_000, blocked: 2 } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const health = renderHealthSchema.parse(await (await call("/v1/health")).json());
    expect(health).toMatchObject({ ok: true, protocol: 1, version: "test", sandbox: true, busy: 0, maxConcurrent: 1, fonts: { ko: true, ja: true, zh: true } });
    const failing = await start({ render: async () => ({ ok: false, error: "blocked", status: 403, renderMs: 5, egress: stats }) });
    expect(renderResponseSchema.parse(await (await failing.render("https://demo.example/")).json()))
      .toEqual({ ok: false, protocol: 1, error: "blocked", status: 403, renderMs: 5, egress: { requests: 9, bytes: 1_000, blocked: 2 } });
    const crashing = await start({ render: async () => { throw new Error("boom"); } });
    expect(await (await crashing.render("https://demo.example/")).json()).toMatchObject({ ok: false, error: "browser_failed" });
  });

  it("샌드박스가 꺼져 있으면 상태가 ok 가 아니다", async () => {
    const { call } = await start({ sandbox: false });
    expect(await (await call("/v1/health")).json()).toMatchObject({ ok: false, sandbox: false });
  });

  it("부른 쪽이 끊으면 그리기 신호를 멈춘다(브라우저를 죽인다)", async () => {
    let aborted = false;
    const { call } = await start({ render: (_url, signal) => new Promise<RenderOutcome>((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve({ ok: false, error: "timeout", status: null, renderMs: 0, egress: null }); });
    }) });
    const controller = new AbortController();
    const pending = call("/v1/render", { method: "POST", body: JSON.stringify({ url: "https://demo.example/" }), signal: controller.signal }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(aborted).toBe(false);
    controller.abort();
    await pending;
    for (let index = 0; index < 50 && !aborted; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborted).toBe(true);
  });

  it("토큰이 짧으면 띄우지 않는다", () => {
    expect(() => createRenderService({ token: "short", maxConcurrent: 1, ports: [443], version: "x", sandbox: true, fonts: () => null,
      render: async () => ({ ok: false, error: "timeout", status: null, renderMs: 0, egress: null }) })).toThrow("render_token_too_short");
  });
});

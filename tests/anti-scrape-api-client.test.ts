import { describe, expect, it, vi } from "vitest";
import { createSessionFetch } from "@/lib/anti-scrape/client";
import { isSessionRead } from "@/lib/anti-scrape/paths";
const ORIGIN = "https://nomorevibe.test";
const enabled = (mode = "enforce", expiresAt: number | null = null) => Response.json({ enabled: true, siteKey: "1x00000000000000000000AA", mode, expiresAt });

describe("브라우저 공개 API 세션", () => {
  it("타임라인 GET·HEAD는 세션 읽기 목록에 있고 쓰기·다른 경로는 제외", () => {
    for (const method of ["GET", "HEAD"]) expect(isSessionRead("/api/products/a/timeline", method)).toBe(true);
    for (const method of ["POST", "PUT", "DELETE"]) expect(isSessionRead("/api/products/a/timeline", method)).toBe(false);
    expect(isSessionRead("/api/products/a/timeline/extra", "GET")).toBe(false);
  });
  it("타임라인 읽기 전에 브라우저가 세션을 발급", async () => {
    const calls: string[] = [];
    const raw = vi.fn<typeof fetch>(async (input, init) => {
      calls.push(String(input) + (init?.method ?? "GET"));
      if (String(input).endsWith("/api/session")) return init?.method === "POST" ? Response.json({ expiresAt: Date.now() + 1800_000 }) : enabled();
      return Response.json({ rows: [] });
    });
    const solve = vi.fn().mockResolvedValue("XXXX.DUMMY.TOKEN.XXXX");
    expect((await createSessionFetch(raw, ORIGIN, solve)("/api/products/a/timeline")).status).toBe(200);
    expect(calls).toEqual([`${ORIGIN}/api/sessionGET`, `${ORIGIN}/api/sessionPOST`, "/api/products/a/timelineGET"]);
    expect(solve).toHaveBeenCalledTimes(1);
  });
  it("첫 병렬 API는 config·Turnstile·발급을 한 번만 실행하고 기존 입력을 보존", async () => {
    const calls: string[] = [];
    const raw = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input); calls.push(path + (init?.method ?? "GET"));
      if (path.endsWith("/api/session")) return init?.method === "POST" ? Response.json({ expiresAt: Date.now() + 1800_000 }) : enabled();
      return Response.json({ items: [] });
    });
    const solve = vi.fn().mockResolvedValue("XXXX.DUMMY.TOKEN.XXXX");
    const wrapped = createSessionFetch(raw, ORIGIN, solve);
    await Promise.all([wrapped("/api/product-cards?slugs=a"), wrapped("/api/products/a/details")]);
    expect(solve).toHaveBeenCalledTimes(1); expect(calls.slice(0, 2)).toEqual([`${ORIGIN}/api/sessionGET`, `${ORIGIN}/api/sessionPOST`]);
    await wrapped("/api/products/a/readme", { headers: { accept: "application/json" } });
    expect(solve).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenLastCalledWith("/api/products/a/readme", { headers: { accept: "application/json" } });
  });
  it("꺼진 관문은 위젯을 실행하지 않고, 기록 모드 실패도 화면 읽기를 계속", async () => {
    for (const config of [{ enabled: false }, { enabled: true, mode: "observe", siteKey: "2x00000000000000000000AB" }]) {
      const raw = vi.fn<typeof fetch>(async input => String(input).endsWith("/api/session") ? Response.json(config) : Response.json({ items: [] }));
      const solve = vi.fn().mockRejectedValue(new Error("failed"));
      expect((await createSessionFetch(raw, ORIGIN, solve)("/api/product-cards")).status).toBe(200);
      expect(solve).toHaveBeenCalledTimes(config.enabled ? 1 : 0);
    }
  });
  it("차단 모드 위젯 실패는 API를 보내지 않고 다음 요청에서 다시 시도 가능", async () => {
    const raw = vi.fn<typeof fetch>(async () => enabled());
    const solve = vi.fn().mockRejectedValue(new Error("failed"));
    const wrapped = createSessionFetch(raw, ORIGIN, solve);
    await expect(wrapped("/api/product-cards")).rejects.toThrow("failed");
    expect(raw.mock.calls.every(([path]) => String(path).endsWith("/api/session"))).toBe(true);
    await expect(wrapped("/api/product-cards")).rejects.toThrow("failed");
    expect(solve).toHaveBeenCalledTimes(2);
  });
  it("만료 401은 한 번 갱신·재시도, 그 외 401·429는 재발급 안 함", async () => {
    let apiCalls = 0;
    const raw = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/api/session")) return init?.method === "POST" ? Response.json({ expiresAt: Date.now() + 1800_000 }) : enabled("enforce", Date.now() + 1800_000);
      apiCalls++;
      return Response.json({ error: "api_session_required" }, { status: 401 });
    });
    const solve = vi.fn().mockResolvedValue("XXXX.DUMMY.TOKEN.XXXX");
    expect((await createSessionFetch(raw, ORIGIN, solve)("/api/product-cards")).status).toBe(401);
    expect(apiCalls).toBe(2); expect(solve).toHaveBeenCalledTimes(1);
    for (const status of [401, 403, 429]) {
      raw.mockImplementation(async input => String(input).endsWith("/api/session") ? enabled("enforce", Date.now() + 1800_000) : Response.json({ error: "other_error" }, { status }));
      solve.mockClear();
      expect((await createSessionFetch(raw, ORIGIN, solve)("/api/product-cards")).status).toBe(status);
      expect(solve).not.toHaveBeenCalled();
    }
  });
  it("POST Request 본문도 재시도 전에 복제하므로 읽은 본문 오류 없음", async () => {
    const bodies: string[] = [];
    const raw = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/api/session")) return init?.method === "POST" ? Response.json({ expiresAt: Date.now() + 1800_000 }) : enabled("enforce", Date.now() + 1800_000);
      bodies.push(await (input as Request).text());
      return bodies.length === 1 ? Response.json({ error: "api_session_required" }, { status: 401 }) : Response.json({ items: [] });
    });
    const wrapped = createSessionFetch(raw, ORIGIN, async () => "XXXX.DUMMY.TOKEN.XXXX");
    expect((await wrapped(new Request(`${ORIGIN}/api/product-summaries`, { method: "POST", body: '{"slugs":["a"]}' }))).status).toBe(200);
    expect(bodies).toEqual(['{"slugs":["a"]}', '{"slugs":["a"]}']);
  });
  it("외부 출처·관리자·메이커 인증·쓰기·일반 요청을 그대로 넘긴다", async () => {
    const raw = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    const wrapped = createSessionFetch(raw, ORIGIN);
    for (const path of ["https://outside.test/api/product-cards", "/api/me", "/api/products/a/media", "/api/products/a/profile", "/api/products/a/links", "/api/products/a/provenance"]) await wrapped(path);
    await wrapped("/api/products/a/feedback", { method: "POST", body: "{}" });
    expect(raw).toHaveBeenCalledTimes(7);
    expect(isSessionRead("/api/products/a/hero", "GET")).toBe(true);
    expect(isSessionRead("/api/products/a/details", "PUT")).toBe(false);
  });
});

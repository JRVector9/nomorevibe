import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";

const ctx = { params: Promise.resolve({}) };
const req = (method = "POST") => new Request("https://nomorevibe.app/api/products", { method });

describe("withRoute — 라우트 에러 경계", () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("정상 응답을 그대로 통과시키고 요청 ID를 붙인다", async () => {
    const handler = withRoute("test.ok", async () => NextResponse.json({ ok: true }, { status: 201 }));
    const res = await handler(req(), ctx);

    expect(res.status).toBe(201);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("예외를 500으로 바꾸되 내부 정보를 응답에 흘리지 않는다", async () => {
    const handler = withRoute("test.boom", async () => {
      throw new Error("DB 커넥션 문자열: postgres://user:pw@host");
    });
    const res = await handler(req(), ctx);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(body.request_id).toBeTruthy();
    // 사용자가 제보할 때 이 ID로 로그를 찾을 수 있어야 한다
    expect(res.headers.get("x-request-id")).toBe(body.request_id);
  });

  it("예외 원인은 로그에 남긴다", async () => {
    const handler = withRoute("test.boom", async () => {
      throw new Error("연결 거부됨");
    });
    await handler(req(), ctx);

    const logged = stderr.mock.calls.map((c: unknown[]) => c[0] as string).join("");
    expect(logged).toContain("http.unhandled");
    expect(logged).toContain("연결 거부됨");
    expect(JSON.parse(logged.trim())).toMatchObject({ level: "error", route: "test.boom" });
  });

  it("4xx는 warn, 5xx 응답은 error로 기록한다", async () => {
    await withRoute("test.bad", async () => NextResponse.json({}, { status: 400 }))(req(), ctx);
    expect(stdout.mock.calls.some((c: unknown[]) => (c[0] as string).includes('"level":"warn"'))).toBe(true);

    stderr.mockClear();
    await withRoute("test.fail", async () => NextResponse.json({}, { status: 503 }))(req(), ctx);
    expect(stderr.mock.calls.some((c: unknown[]) => (c[0] as string).includes('"level":"error"'))).toBe(true);
  });

  it("소요 시간을 기록한다", async () => {
    await withRoute("test.slow", async () => {
      await new Promise((r) => setTimeout(r, 12));
      return NextResponse.json({});
    })(req(), ctx);

    const line = JSON.parse((stdout.mock.calls[0][0] as string).trim());
    expect(line.durationMs).toBeGreaterThanOrEqual(10);
  });
});

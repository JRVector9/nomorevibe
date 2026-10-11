import { beforeEach, describe, expect, it, vi } from "vitest";

/** 소개 수정 요청 접수 라우트(UX-18) — 한도·본문·글 길이를 보고, 내려달라는 요청 길은 타지 않는다. DB 는 부르지 않는다 */
const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(), request: vi.fn(), takedown: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit, clientIp: () => "203.0.113.9", trustedClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/domain/products/intro-requests", () => ({ requestIntroCorrection: mocks.request }));
vi.mock("@/lib/domain/products/takedown", () => ({ takedownRequesterHash: () => "f".repeat(64), requestTakedown: mocks.takedown }));

const { POST } = await import("@/app/api/products/[slug]/intro-request/route");
const { INTRO_REQUEST_MAX, INTRO_REQUEST_RECEIVED } = await import("@/lib/domain/products/takedown-view");

const post = (body: string, slug = "hwp") =>
  POST(new Request(`https://nomorevibe.test/api/products/${slug}/intro-request`, { method: "POST", body }), { params: Promise.resolve({ slug }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue(true);
  mocks.request.mockResolvedValue({ ok: true, value: { id: 1 } });
});

describe("소개 수정 요청 라우트", () => {
  it("글을 받아 보낸이 해시와 함께 넘기고, 받았다는 말을 돌려준다", async () => {
    const res = await post(JSON.stringify({ message: "  설치형 CLI 입니다. 웹 서비스가 아닙니다  " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: "hwp", received: true, message: INTRO_REQUEST_RECEIVED });
    expect(mocks.request).toHaveBeenCalledWith("hwp", "설치형 CLI 입니다. 웹 서비스가 아닙니다", "f".repeat(64));
    expect(mocks.rateLimit).toHaveBeenCalledWith("intro-request:hwp:203.0.113.9", 5, 60 * 60 * 1000);
    // 내려달라는 요청 표는 건드리지 않는다 — noindex·CDN 지우기가 걸리지 않게
    expect(mocks.takedown).not.toHaveBeenCalled();
  });

  it("글이 없거나 짧거나 길면 400 이고 저장하지 않는다", async () => {
    for (const body of ["", "{}", JSON.stringify({ message: "   " }), JSON.stringify({ message: "짧음" }),
      JSON.stringify({ message: "가".repeat(INTRO_REQUEST_MAX + 1) }), JSON.stringify({ message: 42 }), "null", "[]"]) {
      const res = await post(body);
      expect(res.status, body).toBe(400);
      expect((await res.json()).error).toEqual(expect.any(String));
    }
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("갈래(kind)는 받지 않는다 — 내려달라는 갈래를 실어 보내도 소개 수정 요청으로만 받는다", async () => {
    const res = await post(JSON.stringify({ message: "소개가 틀렸습니다", kind: "owner", reason: "내려 주세요" }));
    expect(res.status).toBe(200);
    expect(mocks.request).toHaveBeenCalledWith("hwp", "소개가 틀렸습니다", expect.any(String));
    expect(mocks.takedown).not.toHaveBeenCalled();
  });

  it("JSON 이 아니면 400", async () => {
    const res = await post("{message:");
    expect(res.status).toBe(400);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("한도를 넘기면 본문을 읽기 전에 429", async () => {
    mocks.rateLimit.mockResolvedValue(false);
    const res = await post(JSON.stringify({ message: "소개가 틀렸습니다" }));
    expect(res.status).toBe(429);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("도메인 실패는 그대로 상태 코드로 — 없는 제품 404, 주인 있는 제품 403", async () => {
    mocks.request.mockResolvedValueOnce({ ok: false, error: { kind: "not_found" } });
    expect((await post(JSON.stringify({ message: "소개가 틀렸습니다" }))).status).toBe(404);
    mocks.request.mockResolvedValueOnce({ ok: false, error: { kind: "forbidden", message: "주인이 있는 제품입니다" } });
    const res = await post(JSON.stringify({ message: "소개가 틀렸습니다" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("주인이 있는 제품입니다");
  });
});

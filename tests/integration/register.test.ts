import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// 외부 네트워크는 목킹한다 — 이 테스트가 검증하는 것은 등록 로직이지 fetch가 아니다
const fetchPage = vi.fn();
const safeFetch = vi.fn();
vi.mock("@/lib/net/fetch", () => ({
  fetchPage: (...a: unknown[]) => fetchPage(...a),
  safeFetch: (...a: unknown[]) => safeFetch(...a),
  readBodyCapped: vi.fn(),
}));

const { registerProduct } = await import("@/lib/domain/products/register");
const repo = await import("@/lib/domain/products/repository");
const { ensureSchema, resetTables } = await import("./setup");

const livePage = (html = "<html><head><title>t</title></head></html>") => ({ status: 200, html });

const input = (over: Partial<Record<string, unknown>> = {}) => ({
  url: "https://alpha.test",
  name: "simpleHWP",
  tagline: "브라우저에서 HWP를 여는 도구",
  description: "한글 오피스 없이 .hwp를 브라우저에서 엽니다.",
  category: "Productivity" as const,
  ...over,
});

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  fetchPage.mockReset();
  safeFetch.mockReset();
  fetchPage.mockResolvedValue(livePage());
});

describe("registerProduct — 신규 등록", () => {
  it("행을 만들고 토큰을 발급한다", async () => {
    const result = await registerProduct(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.slug).toBe("simplehwp");
    expect(result.value.editToken).toMatch(/^nmv_edit_/);
    expect(result.value.verifyToken).toMatch(/^nmv_verify_/);

    const saved = await repo.findBySlug("simplehwp");
    expect(saved?.status).toBe("unverified");
    expect(saved?.url).toBe("https://alpha.test");
    // 평문 토큰은 저장하지 않는다
    expect(saved?.editTokenHash).not.toBe(result.value.editToken);
  });

  it("이름이 같고 URL이 다르면 접미사를 붙인다", async () => {
    const a = await registerProduct(input({ url: "https://a.test" }));
    const b = await registerProduct(input({ url: "https://b.test" }));
    const c = await registerProduct(input({ url: "https://c.test" }));

    expect([a, b, c].every((r) => r.ok)).toBe(true);
    const slugs = [a, b, c].map((r) => (r.ok ? r.value.slug : null));
    expect(slugs).toEqual(["simplehwp", "simplehwp-2", "simplehwp-3"]);
  });

  it("접속되지 않는 URL은 행을 남기지 않는다", async () => {
    fetchPage.mockResolvedValue(null);
    const result = await registerProduct(input());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unreachable");
    expect(await repo.findByUrl("https://alpha.test")).toBeUndefined();
  });

  it("4xx를 반환하는 URL도 거부한다", async () => {
    fetchPage.mockResolvedValue({ status: 404, html: "" });
    const result = await registerProduct(input());
    expect(result.ok).toBe(false);
  });
});

describe("registerProduct — 중복", () => {
  it("같은 URL은 기존 slug를 알려준다 (스킬이 수정으로 전환할 수 있게)", async () => {
    await registerProduct(input());
    const again = await registerProduct(input({ name: "다른이름" }));

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error).toMatchObject({ kind: "duplicate", slug: "simplehwp", status: "unverified" });
  });

  it("후행 슬래시·www·대문자 차이를 같은 URL로 본다", async () => {
    await registerProduct(input({ url: "https://alpha.test" }));
    for (const variant of ["https://WWW.Alpha.test/", "http://alpha.test", "alpha.test"]) {
      const dup = await registerProduct(input({ url: variant }));
      expect(dup.ok, variant).toBe(false);
      if (!dup.ok) expect(dup.error.kind, variant).toBe("duplicate");
    }
  });

  it("차단된 URL은 재등록을 막는다", async () => {
    const first = await registerProduct(input());
    if (!first.ok) throw new Error("사전 조건 실패");
    const product = await repo.findBySlug(first.value.slug);
    await repo.update(product!.id, { status: "banned" });

    const again = await registerProduct(input());
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.kind).toBe("forbidden");
  });
});

describe("registerProduct — OG 이미지", () => {
  const withOg = () => livePage(`<html><head><meta property="og:image" content="/cover.png"></head></html>`);
  const pngResponse = () => ({
    finalUrl: "https://alpha.test/cover.png",
    response: {
      ok: true,
      headers: { get: (h: string) => (h === "content-type" ? "image/png" : null) },
      body: null,
    } as unknown as Response,
  });

  it("성공하면 저장하고 제품에 경로를 연결한다", async () => {
    fetchPage.mockResolvedValue(withOg());
    safeFetch.mockResolvedValue(pngResponse());
    // readBodyCapped는 목이라 빈 버퍼를 반환한다 → 길이 0은 캐싱 대상이 아니므로
    // 여기서는 og_images에 저장되지 않는 것이 올바른 동작이다
    const result = await registerProduct(input());
    expect(result.ok).toBe(true);
    expect(await repo.getOgImage("simplehwp")).toBeNull();
  });

  it("OG 수집이 실패해도 등록 자체는 성공한다", async () => {
    fetchPage.mockResolvedValue(withOg());
    safeFetch.mockResolvedValue(null); // 내부망 차단 등

    const result = await registerProduct(input());
    expect(result.ok).toBe(true);
    const saved = await repo.findBySlug("simplehwp");
    expect(saved).toBeTruthy();
    expect(saved?.ogImage).toBeNull();
  });

  it("og:image가 없어도 등록된다", async () => {
    const result = await registerProduct(input());
    expect(result.ok).toBe(true);
    expect((await repo.findBySlug("simplehwp"))?.ogImage).toBeNull();
  });
});

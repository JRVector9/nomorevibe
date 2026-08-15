import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const fetchPage = vi.fn();
const safeFetch = vi.fn();
vi.mock("@/lib/net/fetch", () => ({
  fetchPage: (...a: unknown[]) => fetchPage(...a),
  safeFetch: (...a: unknown[]) => safeFetch(...a),
  readBodyCapped: vi.fn(),
}));

const { registerProduct } = await import("@/lib/domain/products/register");
const { verifyProduct } = await import("@/lib/domain/products/verify");
const { updateProduct, deleteProduct, banProduct } = await import("@/lib/domain/products/manage");
const repo = await import("@/lib/domain/products/repository");
const { VERIFY_META_NAME } = await import("@/lib/domain/products/verify-contract");
const { ensureSchema, resetTables } = await import("./setup");

const base = {
  url: "https://alpha.test",
  name: "simpleHWP",
  tagline: "브라우저에서 HWP를 여는 도구",
  description: "한글 오피스 없이 .hwp를 브라우저에서 엽니다.",
  category: "Productivity" as const,
};

/** 등록 후 slug와 토큰을 돌려준다 */
async function seed() {
  fetchPage.mockResolvedValue({ status: 200, html: "<html></html>" });
  const result = await registerProduct(base);
  if (!result.ok) throw new Error("사전 조건: 등록 실패");
  return result.value;
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  fetchPage.mockReset();
  safeFetch.mockReset();
});

describe("verifyProduct — 상태 전이", () => {
  it("well-known 파일 내용이 일치하면 verified가 된다", async () => {
    const { slug, verifyToken } = await seed();
    // 첫 호출이 well-known 파일 조회다
    fetchPage.mockResolvedValueOnce({ status: 200, html: `${verifyToken}\n` });

    const result = await verifyProduct(slug);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.method).toBe("file");

    const saved = await repo.findBySlug(slug);
    expect(saved?.status).toBe("verified");
    expect(saved?.verifiedAt).toBeInstanceOf(Date);
  });

  it("파일이 없으면 메타태그로 넘어간다", async () => {
    const { slug, verifyToken } = await seed();
    fetchPage
      .mockResolvedValueOnce({ status: 404, html: "" })
      .mockResolvedValueOnce({
        status: 200,
        html: `<meta name="${VERIFY_META_NAME}" content="${verifyToken}">`,
      });

    const result = await verifyProduct(slug);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.method).toBe("meta");
  });

  it("토큰이 다르면 실패하고 상태를 바꾸지 않는다", async () => {
    const { slug } = await seed();
    fetchPage.mockResolvedValue({ status: 200, html: "nmv_verify_남의토큰" });

    const result = await verifyProduct(slug);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("verification_failed");
    expect((await repo.findBySlug(slug))?.status).toBe("unverified");
  });

  it("이미 검증된 제품은 네트워크를 다시 타지 않는다", async () => {
    const { slug, verifyToken } = await seed();
    fetchPage.mockResolvedValueOnce({ status: 200, html: verifyToken });
    await verifyProduct(slug);

    fetchPage.mockClear();
    const again = await verifyProduct(slug);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.already).toBe(true);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("차단된 제품은 검증할 수 없다", async () => {
    const { slug } = await seed();
    await banProduct(slug);
    const result = await verifyProduct(slug);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });
});

describe("updateProduct — 수정 자격", () => {
  it("올바른 키로 값을 바꾼다", async () => {
    const { slug, editToken } = await seed();
    const result = await updateProduct(slug, { editToken }, { tagline: "새 소개" });

    expect(result.ok).toBe(true);
    expect((await repo.findBySlug(slug))?.tagline).toBe("새 소개");
  });

  it("틀린 키는 값을 바꾸지 못한다", async () => {
    const { slug } = await seed();
    const before = await repo.findBySlug(slug);

    const result = await updateProduct(slug, { editToken: "nmv_edit_위조" }, { tagline: "탈취" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("forbidden");
    expect((await repo.findBySlug(slug))?.tagline).toBe(before?.tagline);
  });

  it("키가 없으면 forbidden이 아니라 unauthorized다 (401과 403을 가른다)", async () => {
    const { slug } = await seed();
    const result = await updateProduct(slug, { editToken: null }, { tagline: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unauthorized");
  });

  it("없는 제품은 not_found다", async () => {
    const result = await updateProduct("존재하지않음", { editToken: "nmv_edit_x" }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });
});

describe("deleteProduct / banProduct", () => {
  it("삭제는 제품과 OG 이미지를 함께 지운다", async () => {
    const { slug, editToken } = await seed();
    await repo.putOgImage(slug, "image/png", Buffer.from([1, 2, 3]));
    expect(await repo.getOgImage(slug)).not.toBeNull();

    const result = await deleteProduct(slug, { editToken });
    expect(result.ok).toBe(true);
    expect(await repo.findBySlug(slug)).toBeUndefined();
    expect(await repo.getOgImage(slug)).toBeNull();
  });

  it("차단은 행을 남겨 같은 URL의 재등록까지 막는다", async () => {
    const { slug } = await seed();
    await banProduct(slug);

    const saved = await repo.findBySlug(slug);
    expect(saved?.status).toBe("banned");
    // 행이 남아 있어야 URL unique 제약이 재등록을 막는다
    expect(saved).toBeTruthy();
  });
});

describe("공개 목록", () => {
  it("검증된 제품만 노출한다", async () => {
    const { slug, verifyToken } = await seed();
    expect(await repo.listProducts({ statuses: ["verified"], limit: 10 })).toHaveLength(0);

    fetchPage.mockResolvedValueOnce({ status: 200, html: verifyToken });
    await verifyProduct(slug);

    const listed = await repo.listProducts({ statuses: ["verified"], limit: 10 });
    expect(listed.map((p) => p.slug)).toEqual([slug]);
  });
});

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const fetchPage = vi.fn();
vi.mock("@/lib/net/fetch", () => ({
  fetchPage: (...a: unknown[]) => fetchPage(...a),
  safeFetch: vi.fn().mockResolvedValue(null),
  readBodyCapped: vi.fn(),
}));

const repo = await import("@/lib/domain/products/repository");
const { getPublicList, getRankedList, isUnclaimed, builderClaimOf } = await import(
  "@/lib/domain/products/view"
);
const { registerProduct } = await import("@/lib/domain/products/register");
const { verifyProduct } = await import("@/lib/domain/products/verify");
const { ensureSchema, resetTables } = await import("./setup");

/** 수집기가 넣을 형태의 제품을 직접 만든다 (수집기 자체는 PR-A2) */
async function seedProduct(over: { slug: string; url: string; name: string; builder?: string }) {
  await repo.insert({
    slug: over.slug,
    url: over.url,
    name: over.name,
    tagline: "수집된 소개",
    description: "공개 저장소에서 찾은 제품입니다.",
    category: "Other",
    builder: over.builder ?? "Claude Code",
    stack: [],
    status: "seeded",
    source: "crawler",
    verifyToken: `nmv_verify_${over.slug}`,
    editTokenHash: "x".repeat(64),
  });
}

/** 메이커가 스킬로 등록하고 검증까지 마친 제품 */
async function verifiedProduct(url: string, name: string) {
  fetchPage.mockResolvedValue({ status: 200, html: "<html></html>" });
  const result = await registerProduct({
    url,
    name,
    tagline: "메이커가 쓴 소개",
    description: "메이커가 직접 등록한 제품입니다.",
    category: "Productivity",
    builder: "Codex",
  });
  if (!result.ok) throw new Error("사전 조건 실패");
  fetchPage.mockResolvedValueOnce({ status: 200, html: result.value.verifyToken });
  await verifyProduct(result.value.slug);
  return result.value.slug;
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  fetchPage.mockReset();
});

describe("seeded 노출 정책", () => {
  it("공개 목록에 검증된 제품과 함께 뜬다", async () => {
    await seedProduct({ slug: "found-app", url: "https://found.test", name: "FoundApp" });
    const verified = await verifiedProduct("https://mine.test", "MyApp");

    const list = await getPublicList(50);
    expect(list.map((p) => p.slug).sort()).toEqual([verified, "found-app"].sort());
  });

  it("검증된 제품이 미클레임보다 위에 온다", async () => {
    // 미클레임을 먼저 넣어 날짜상 더 오래되지 않게 한다
    const verified = await verifiedProduct("https://mine.test", "MyApp");
    await seedProduct({ slug: "found-app", url: "https://found.test", name: "FoundApp" });

    const list = await getPublicList(50);
    // 날짜만으로 섞으면 나중에 들어온 미클레임이 위로 온다 — 그러면 안 된다
    expect(list[0].slug).toBe(verified);
    expect(list[1].slug).toBe("found-app");
  });

  it("랭킹 대상에서는 빠진다", async () => {
    await seedProduct({ slug: "found-app", url: "https://found.test", name: "FoundApp" });
    const verified = await verifiedProduct("https://mine.test", "MyApp");

    const ranked = await getRankedList(50);
    expect(ranked.map((p) => p.slug)).toEqual([verified]);
  });

  it("미검증(주인이 검증 중)은 목록에 뜨지 않는다 — 미클레임과 다르다", async () => {
    fetchPage.mockResolvedValue({ status: 200, html: "<html></html>" });
    await registerProduct({
      url: "https://pending.test",
      name: "Pending",
      tagline: "x",
      description: "x",
      category: "Other",
    });

    expect(await getPublicList(50)).toHaveLength(0);
  });

  it("차단된 제품은 seeded여도 목록에서 사라진다", async () => {
    await seedProduct({ slug: "spam", url: "https://spam.test", name: "Spam" });
    const product = await repo.findBySlug("spam");
    await repo.update(product!.id, { status: "banned" });

    expect(await getPublicList(50)).toHaveLength(0);
  });
});

describe("신뢰 표기", () => {
  it("미클레임의 만든 AI는 우리 추정이다", async () => {
    await seedProduct({ slug: "found-app", url: "https://found.test", name: "FoundApp" });
    const [item] = await getPublicList(50);

    expect(item.unclaimed).toBe(true);
    expect(item.builderClaim).toBe("guessed");
  });

  it("메이커가 등록한 제품은 메이커 신고다", async () => {
    const slug = await verifiedProduct("https://mine.test", "MyApp");
    const [item] = await getPublicList(50);

    expect(item.slug).toBe(slug);
    expect(item.unclaimed).toBe(false);
    expect(item.builderClaim).toBe("reported");
  });

  it("클레임하면 우리 추정에서 메이커 신고로 바뀐다", async () => {
    await seedProduct({ slug: "found-app", url: "https://found.test", name: "FoundApp" });
    const before = await repo.findBySlug("found-app");
    expect(builderClaimOf(before!)).toBe("guessed");

    // 클레임 플로우(PR-A4)가 할 일: 소유권 확인 후 claimedAt 기록
    await repo.update(before!.id, { claimedAt: new Date(), status: "verified" });

    const after = await repo.findBySlug("found-app");
    expect(isUnclaimed(after!)).toBe(false);
    expect(builderClaimOf(after!)).toBe("reported");
  });

  it("수집 출처는 클레임 후에도 남는다", async () => {
    await seedProduct({ slug: "found-app", url: "https://found.test", name: "FoundApp" });
    const product = await repo.findBySlug("found-app");
    await repo.update(product!.id, { claimedAt: new Date(), status: "verified" });

    expect((await repo.findBySlug("found-app"))?.source).toBe("crawler");
  });
});

describe("기본값", () => {
  it("스킬로 등록하면 source가 skill이고 주인이 있는 상태다", async () => {
    fetchPage.mockResolvedValue({ status: 200, html: "<html></html>" });
    const result = await registerProduct({
      url: "https://mine.test",
      name: "MyApp",
      tagline: "x",
      description: "x",
      category: "Other",
    });
    if (!result.ok) throw new Error("등록 실패");

    const saved = await repo.findBySlug(result.value.slug);
    expect(saved?.source).toBe("skill");
    expect(saved?.claimedAt).toBeNull();
    expect(isUnclaimed(saved!)).toBe(false);
  });
});

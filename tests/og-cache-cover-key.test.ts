import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 표지 주소 보호(2026-11-15 사람 결정, PR #964) — 표지는 보호 API 가 내준 `/api/og-cache/<slug>.<열쇠>` 로만 받는다.
 * slug 만 아는 옛 주소 `/api/og-cache/<slug>` 는 표지 대신 그 제품의 공유 카드(이름·요약)로 302, 틀린 열쇠·내린 제품은 404.
 * 상세의 공유 그림인 공유 카드는 상세가 열리는 제품이면 나온다(검증 전 포함).
 */

const mocks = vi.hoisted(() => ({ og: vi.fn(), identity: vi.fn(), png: vi.fn(), translations: vi.fn() }));
vi.mock("@/lib/domain/products/repository", () => ({ getOgImage: mocks.og }));
vi.mock("@/lib/domain/products/detail-view", () => ({ getProductIdentity: mocks.identity }));
vi.mock("@/lib/domain/products/public-reads", () => ({ publicRead: (_kind: string, _key: unknown[], load: () => Promise<unknown>) => load() }));
vi.mock("@/lib/db", () => ({ db: {}, onReplica: <T>(load: () => Promise<T>) => load() }));
vi.mock("@/lib/me/share-card", () => ({ shareCardPng: mocks.png }));
vi.mock("@/lib/i18n/products", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readTranslationsForProducts: mocks.translations,
}));

const SECRET = "test-visitor-hash-secret-0123456789abcdef";
process.env.VISITOR_HASH_SECRET = SECRET;

const { coverKey, coverKeyMatches, parseCoverSegment, protectedCoverUrl } = await import("@/lib/domain/products/cover-url");
const { GET: ogCache } = await import("@/app/api/og-cache/[slug]/route");
const { GET: shareCard } = await import("@/app/(public)/[locale]/(content)/p/[slug]/share-card.png/route");

const product = (extra: Record<string, unknown> = {}) => ({
  id: 7, slug: "tiny-cron", name: "tiny-cron", tagline: "Turns plain words into cron", taglineKo: "자연어 일정을 cron 식으로",
  status: "seeded", source: "crawler", claimedAt: null, auditHoldAt: null, category: "Dev", ogImage: "/api/og-cache/tiny-cron", ...extra,
});
const callOg = (segment: string, query = "") =>
  ogCache(new Request(`https://nomorevibe.test/api/og-cache/${segment}${query}`), { params: Promise.resolve({ slug: segment }) });
const cover = async () => ({ data: await sharp({ create: { width: 800, height: 420, channels: 3, background: "#225588" } }).png().toBuffer(), contentType: "image/png" });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VISITOR_HASH_SECRET = SECRET;
  mocks.identity.mockResolvedValue(product());
  mocks.translations.mockResolvedValue([]);
  mocks.png.mockResolvedValue(Buffer.from("PNG"));
});

describe("보호 표지 주소(cover-url.ts)", () => {
  it("slug 주소를 <slug>.<열쇠> 로 바꾸고 쿼리는 그대로 — 열쇠는 비밀이 바뀌면 달라지고 slug 만으로는 만들 수 없다", () => {
    const key = coverKey("tiny-cron")!;
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(protectedCoverUrl("/api/og-cache/tiny-cron")).toBe(`/api/og-cache/tiny-cron.${key}`);
    expect(protectedCoverUrl("/api/og-cache/tiny-cron?thumbnail=og&w=1200&h=630&v=3"))
      .toBe(`/api/og-cache/tiny-cron.${key}?thumbnail=og&w=1200&h=630&v=3`);
    // 이미 보호 주소면 그대로, 바깥 주소는 그대로, 없으면 null
    expect(protectedCoverUrl(`/api/og-cache/tiny-cron.${key}`)).toBe(`/api/og-cache/tiny-cron.${key}`);
    expect(protectedCoverUrl("https://cdn.example/x.png")).toBe("https://cdn.example/x.png");
    expect(protectedCoverUrl(null)).toBeNull();
    expect(protectedCoverUrl("/api/og-cache/../etc")).toBeNull();
    expect(coverKey("tiny-cron", "another-secret-of-at-least-32-characters!!")).not.toBe(key);
    expect(coverKey("other-slug")).not.toBe(key);
  });

  it("비밀이 없거나 짧으면 표지 주소를 내주지 않는다(null)", () => {
    delete process.env.VISITOR_HASH_SECRET;
    expect(protectedCoverUrl("/api/og-cache/tiny-cron")).toBeNull();
    process.env.VISITOR_HASH_SECRET = "short";
    expect(protectedCoverUrl("/api/og-cache/tiny-cron")).toBeNull();
    expect(coverKeyMatches("tiny-cron", "0".repeat(32))).toBe(false);
  });

  it("경로 한 칸 읽기 — 옛 주소·보호 주소·webp, 틀린 모양은 null", () => {
    const key = "0123456789abcdef0123456789abcdef";
    expect(parseCoverSegment("tiny-cron")).toEqual({ slug: "tiny-cron", key: null, webp: false });
    expect(parseCoverSegment("tiny-cron.webp")).toEqual({ slug: "tiny-cron", key: null, webp: true });
    expect(parseCoverSegment(`tiny-cron.${key}`)).toEqual({ slug: "tiny-cron", key, webp: false });
    expect(parseCoverSegment(`tiny-cron.${key}.webp`)).toEqual({ slug: "tiny-cron", key, webp: true });
    expect(parseCoverSegment("Bad_Slug")).toBeNull();
    expect(parseCoverSegment("tiny-cron.nothex")).toBeNull();
  });
});

describe("/api/og-cache 경로", () => {
  it.each(["tiny-cron", "tiny-cron.webp"])("옛 slug 주소(%s)는 표지를 주지 않고 공유 카드로 302 — 캐시 헤더·태그는 그대로", async (segment) => {
    const response = await callOg(segment, "?size=640");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/p/tiny-cron/share-card.png");
    expect(response.headers.get("cache-control")).toContain("s-maxage=86400");
    expect(response.headers.get("cache-tag")).toBe("og-tiny-cron,p-tiny-cron");
    expect(mocks.og).not.toHaveBeenCalled();
  });

  it("보호 주소(열쇠 맞음)는 표지 그림 — JPEG 미리보기와 WebP 사본", async () => {
    mocks.og.mockResolvedValue(await cover());
    const key = coverKey("tiny-cron")!;
    const jpeg = await callOg(`tiny-cron.${key}`);
    expect(jpeg.status).toBe(200);
    expect(jpeg.headers.get("content-type")).toBe("image/jpeg");
    expect(jpeg.headers.get("cache-control")).toContain("s-maxage=86400");
    expect(jpeg.headers.get("cache-tag")).toBe("og-tiny-cron,p-tiny-cron");
    expect((await sharp(Buffer.from(await jpeg.arrayBuffer())).metadata()).format).toBe("jpeg");
    const webp = await callOg(`tiny-cron.${key}.webp`, "?size=320");
    expect(webp.status).toBe(200);
    expect((await sharp(Buffer.from(await webp.arrayBuffer())).metadata()).width).toBe(320);
  });

  it("틀린 열쇠·다른 제품의 열쇠는 404 — 그림을 읽지도 않는다", async () => {
    mocks.og.mockResolvedValue(await cover());
    expect((await callOg(`tiny-cron.${"0".repeat(32)}`)).status).toBe(404);
    expect((await callOg(`tiny-cron.${coverKey("other-slug")}.webp`)).status).toBe(404);
    expect((await callOg("tiny-cron.nothex")).status).toBe(400);
    expect(mocks.og).not.toHaveBeenCalled();
  });

  it("내린·없는 제품은 열쇠가 맞아도 404(태그를 달아 다시 올라오면 지워진다)", async () => {
    mocks.og.mockResolvedValue(await cover());
    mocks.identity.mockResolvedValue(null);
    const response = await callOg(`gone-one.${coverKey("gone-one")}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-tag")).toBe("og-gone-one,p-gone-one");
    expect(mocks.og).not.toHaveBeenCalled();
  });
});

describe("공유 카드 경로 — 상세가 열리는 제품이면 나온다", () => {
  const callCard = (locale: string, slug: string) =>
    shareCard(new Request(`https://nomorevibe.test/p/${slug}/share-card.png`), { params: Promise.resolve({ locale, slug }) });

  it.each([{ status: "seeded" }, { status: "unverified" }, { auditHoldAt: new Date() }])("%o → 200 PNG(이름·요약), p-<slug> 태그", async (extra) => {
    mocks.identity.mockResolvedValue(product(extra));
    const response = await callCard("ko", "tiny-cron");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-tag")).toBe("p-tiny-cron");
    expect(mocks.png).toHaveBeenCalledWith(expect.objectContaining({ name: "tiny-cron", tagline: "자연어 일정을 cron 식으로" }), "ko");
  });

  it("없는·내린 제품과 모르는 언어는 404", async () => {
    mocks.identity.mockResolvedValue(null);
    const missing = await callCard("ko", "tiny-cron");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-tag")).toBe("p-tiny-cron");
    mocks.identity.mockResolvedValue(product());
    expect((await callCard("xx", "tiny-cron")).status).toBe(404);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductDetailView, PublicProduct } from "@/lib/domain/products/detail-view";

/**
 * 상세의 머리·소개·미리보기·운영자 값(detailPageData, 2026-11-15 공개 HTML 이름·요약만) — /api/products/[slug]/details 가 함께 돌려준다.
 * 내부 id 는 로그인 운영자 확인·팔로가 켜졌을 때만 싣고, 주인이 확인된 제품에는 운영자 상자 값을 싣지 않는다.
 * DB 는 부르지 않는다 — 화제 공개 스위치·화제 순위·메이커 팔로 열쇠만 바꿔 끼운다.
 */
const mocks = vi.hoisted(() => ({ talkVisibility: vi.fn(), productTalk: vi.fn(), makerFollowKey: vi.fn() }));
vi.mock("@/lib/social/flags", async (original) => ({ ...await original<typeof import("@/lib/social/flags")>(), talkVisibility: mocks.talkVisibility }));
vi.mock("@/lib/social/talk", async (original) => ({ ...await original<typeof import("@/lib/social/talk")>(), productTalk: mocks.productTalk }));
vi.mock("@/components/me/FollowSlot", async (original) => ({ ...await original<typeof import("@/components/me/FollowSlot")>(), makerFollowKey: mocks.makerFollowKey }));

const { detailPageData } = await import("@/lib/domain/products/detail-page-data");

const product = {
  id: 95_292, slug: "lcu", url: "https://lcu.example", accessMode: "website", name: "LCU", tagline: "League client helper", taglineSource: "ai_readme",
  description: "A long description of the helper for the client", category: "Dev", builder: null, stack: ["TypeScript"], ogImage: "/api/og-cache/lcu", makerName: "maker",
  repoUrl: "https://github.com/0xpolarzero/lcu", status: "seeded", source: "crawler", claimedAt: null, verifiedAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-11-01T00:00:00Z"), stars: 4_900, starsAt: null, starsPrevious: null, starsPreviousAt: null,
  auditHoldAt: null, repoGone: false, aiEvidence: true, takedownPending: false, taglineKo: "리그 클라이언트 도우미", translationName: "LCU", translationEligible: true,
} as unknown as PublicProduct;

function view(over: Partial<ProductDetailView> = {}, subject: PublicProduct = product): ProductDetailView {
  return {
    product: subject, unclaimed: true, risingRank: 3,
    health: { uptime30d: null, latencyMs: null, checkedAt: null, down: false },
    profile: null, readmeExcerpt: null, media: [],
    repository: { provider: "github", sourceUrl: "https://github.com/amontlabs/lcu", state: "ok", observedAt: null, lastSuccessAt: null, lastFailureAt: null,
      facts: { repositoryUrl: "https://github.com/amontlabs/lcu", languages: [{ name: "TypeScript", bytes: 3, percent: 60 }, { name: "Rust", bytes: 2, percent: 30 }, { name: "C", bytes: 1, percent: 10 }] } },
    ...over,
  } as unknown as ProductDetailView;
}

beforeEach(() => {
  mocks.talkVisibility.mockReset().mockResolvedValue({ visible: false, preview: false });
  mocks.productTalk.mockReset().mockResolvedValue(null);
  mocks.makerFollowKey.mockReset().mockResolvedValue("github:amontlabs");
});
afterEach(() => vi.unstubAllEnvs());

describe("detailPageData — 내부 id", () => {
  it("로그인 기능이 꺼져 있으면 내부 id 를 어디에도 싣지 않는다 — 팔로 값도 없다", async () => {
    vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "false");
    const data = await detailPageData(view(), product);
    expect(JSON.stringify(data)).not.toContain("95292");
    expect(data.hero.follow).toBeNull();
    expect(data.aside.ownerContact).toEqual({ productId: undefined, installable: false, authEnabled: false, githubEnabled: false });
    expect(mocks.makerFollowKey).not.toHaveBeenCalled();
  });

  it("로그인 기능이 켜졌을 때만 운영자 확인·팔로 단추가 쓰는 내부 id 를 싣는다", async () => {
    vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
    vi.stubEnv("GITHUB_STAR_ENABLED", "true");
    const data = await detailPageData(view(), product);
    expect(data.aside.ownerContact).toEqual({ productId: 95_292, installable: false, authEnabled: true, githubEnabled: true });
    // 메이커 팔로는 지금 주인(GitHub 이 넘겨준 정식 주소의 계정) 열쇠로
    expect(data.hero.follow).toEqual({ productKey: "95292", maker: { key: "github:amontlabs", login: "amontlabs" } });
    expect(mocks.makerFollowKey).toHaveBeenCalledWith(95_292, product.repoUrl, "amontlabs");
    // 열쇠가 지금 주인과 다르면(null) 메이커 단추는 없다
    mocks.makerFollowKey.mockResolvedValue(null);
    expect((await detailPageData(view(), product)).hero.follow).toEqual({ productKey: "95292", maker: null });
  });
});

describe("detailPageData — 운영자 상자", () => {
  it("주인이 확인된 제품에는 운영자 연락 값이 없다", async () => {
    vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
    const data = await detailPageData(view({ unclaimed: false }), { ...product, status: "verified" } as PublicProduct);
    expect(data.aside.ownerContact).toBeNull();
    expect(JSON.stringify(data.aside)).not.toContain("95292");
  });

  it("주인 없는 제품도 GitHub 저장소가 아니면 운영자 상자가 없다, 설치형이면 그렇다고", async () => {
    const gitlab = { ...product, repoUrl: "https://gitlab.com/acme/lcu" } as PublicProduct;
    expect((await detailPageData(view({ repository: null }, gitlab), gitlab)).aside.ownerContact).toBeNull();
    const installable = { ...product, accessMode: "installable" } as PublicProduct;
    expect((await detailPageData(view({}, installable), installable)).aside.ownerContact).toMatchObject({ installable: true });
  });

  it("검증 전 제품은 안내를 붙인다", async () => {
    expect((await detailPageData(view(), product)).aside.unverified).toBe(false);
    const unverified = { ...product, status: "unverified" } as PublicProduct;
    expect((await detailPageData(view({}, unverified), unverified)).aside.unverified).toBe(true);
  });
});

describe("detailPageData — 머리·소개", () => {
  it("운영 주체는 옛 등록 주소가 아니라 GitHub 이 넘겨준 지금 계정, 언어는 위 둘, 원본 수집 값·상태는 싣지 않는다", async () => {
    const data = await detailPageData(view(), product);
    expect(data.hero.owner).toEqual({ login: "amontlabs" });
    expect(data.hero.languages).toEqual(["TypeScript", "Rust"]);
    expect(data.hero.risingRank).toBe(3);
    expect(data.hero.talkRank).toBeNull();
    expect(data.hero).not.toHaveProperty("status");
    for (const key of ['"status":', '"source":', '"builderClaim":', '"makerName":', '"translationName":', '"normalizedFacts":']) expect(JSON.stringify(data)).not.toContain(key);
    // 저장소를 아직 읽지 않았으면 등록한 주소의 계정
    expect((await detailPageData(view({ repository: null }), product)).hero.owner).toEqual({ login: "0xpolarzero" });
  });

  it("화제 순위는 공개됐고 자격이 있을 때만", async () => {
    mocks.talkVisibility.mockResolvedValue({ visible: true, preview: false });
    mocks.productTalk.mockResolvedValue({ qualifies: true, rank: 4 });
    expect((await detailPageData(view(), product)).hero.talkRank).toBe(4);
    mocks.productTalk.mockResolvedValue({ qualifies: false, rank: 40 });
    expect((await detailPageData(view(), product)).hero.talkRank).toBeNull();
    mocks.productTalk.mockRejectedValue(new Error("db"));
    expect((await detailPageData(view(), product)).hero.talkRank).toBeNull();
  });

  it("개인 GitHub 스타 단추는 기능이 켜졌고 저장소가 살아 있는 GitHub 저장소일 때만", async () => {
    vi.stubEnv("GITHUB_STAR_ENABLED", "true");
    expect((await detailPageData(view(), product)).hero.githubStar).toBe(true);
    const gone = { ...product, repoGone: true } as PublicProduct;
    expect((await detailPageData(view({}, gone), gone)).hero.githubStar).toBe(false);
    vi.stubEnv("GITHUB_STAR_ENABLED", "false");
    expect((await detailPageData(view(), product)).hero.githubStar).toBe(false);
  });

  it("소개 글은 한 줄 소개와 다를 때만, 고른 번역이 준비됐으면 그 글과 원문", async () => {
    const same = { ...product, description: ` ${product.tagline} ` } as PublicProduct;
    expect((await detailPageData(view({}, same), same)).intro).toMatchObject({ text: null, makerSource: false });
    const own = await detailPageData(view({ unclaimed: false }), product);
    expect(own.intro).toMatchObject({ text: "A long description of the helper for the client\n\n출처: nomorevibe.com", textLang: "en", descriptionTranslation: null, makerSource: true,
      repo: "https://github.com/0xpolarzero/lcu", repoGone: false });
    const translated = { ...product, descriptionTranslation: { text: "도우미의 긴 설명", lang: "ko", translated: true, ready: true, pending: false,
      sourceHash: "h", sourceLocale: "en", provenance: "machine" } } as PublicProduct;
    expect((await detailPageData(view({}, translated), translated)).intro).toMatchObject({ text: "도우미의 긴 설명\n\n출처: nomorevibe.com", textLang: "ko",
      descriptionTranslation: { machine: true, pending: false, translated: true, sourceLocale: "en", original: "A long description of the helper for the client" }, makerSource: false });
  });
});


it("각 언어 소개 응답에 출처 한 줄만 붙이고 DB에서 온 객체는 바꾸지 않는다", async () => {
  const lines = { ko: "출처", en: "Source", ja: "出典", "zh-Hans": "来源", "zh-Hant": "來源" } as const;
  for (const [locale, label] of Object.entries(lines)) {
    const before = JSON.stringify(product);
    const text = `${label}: nomorevibe.com`;
    const data = await detailPageData(view(), product, locale as keyof typeof lines);
    expect(data.intro.text?.endsWith(text)).toBe(true);
    expect(data.intro.text?.split(text)).toHaveLength(2);
    expect(JSON.stringify(product)).toBe(before);
    const existing = { ...product, description: data.intro.text! };
    expect((await detailPageData(view({}, existing), existing, locale as keyof typeof lines)).intro.text).toBe(data.intro.text);
  }
});

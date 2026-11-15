import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 카드 채우기 API(/api/product-cards?slugs=, 2026-11-15 공개 HTML 이름·요약만, 문서 4.1·7장) —
 * 화면에 있는 카드 slug 를 한 번에(최대 60) 받아 이름 밖의 칸을 돌려준다. 없는 slug·공개 목록 밖(내려간·보류·검증 전·닿지 않는) 제품은 빠진다.
 * DB 는 부르지 않는다 — 목록 행 읽기(listProductRows)와 지표만 바꿔 끼우고, 공개 조건은 실제 getPublicListBySlugs 가 정한다.
 */
const mocks = vi.hoisted(() => ({
  rateLimitWindow: vi.fn(),
  listProductRows: vi.fn(),
}));
vi.mock("@/lib/rate-limit", async (original) => ({ ...await original<typeof import("@/lib/rate-limit")>(), rateLimitWindow: mocks.rateLimitWindow }));
vi.mock("@/lib/domain/products/repository", async (original) => ({
  ...await original<typeof import("@/lib/domain/products/repository")>(), listProductRows: mocks.listProductRows,
}));
vi.mock("@/lib/domain/products/clicks", async (original) => ({ ...await original<Record<string, unknown>>(), clickMetrics: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("@/lib/domain/products/health", async (original) => ({ ...await original<Record<string, unknown>>(), healthFor: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("@/lib/domain/products/activity", async (original) => ({ ...await original<Record<string, unknown>>(), withProductActivity: async <T>(items: T[]) => items }));
vi.mock("@/lib/db", async (original) => ({ ...await original<Record<string, unknown>>(), onReplica: async (load: () => Promise<unknown>) => load() }));

process.env.VISITOR_HASH_SECRET = "test-visitor-hash-secret-0123456789abcdef";
const cardsModule = await import("@/app/api/product-cards/route");
const GET = (req: Request) => cardsModule.GET(req, { params: Promise.resolve({}) } as never);

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const request = (query: string, ua = BROWSER) => new Request(`https://nomorevibe.test/api/product-cards?${query}`,
  { headers: { "user-agent": ua, "x-forwarded-for": "198.51.100.23" } });

/** listProductRows 행 — 공개 목록 조건을 통과한 것만 DB 가 돌려준다 */
const row = (slug: string) => ({
  id: slug.length * 1000, slug, name: slug.toUpperCase(), status: "seeded", tagline: `${slug} tagline`, taglineSource: "ai_readme", taglineKo: `${slug} 소개`,
  category: "Dev", accessMode: "website", aiLevel: 2, source: "crawler", claimedAt: null, builder: null, stack: [], ogImage: `/api/og-cache/${slug}?thumbnail=og&w=1200&h=630`,
  makerName: "maker", repoUrl: `https://github.com/owner-${slug}/repo`, repoRenamedTo: null, repoGone: false,
  stars: 120, starsAt: new Date("2026-11-14T00:00:00Z"), starsPrevious: 100, starsPreviousAt: new Date("2026-11-13T00:00:00Z"),
  verifiedAt: null, createdAt: new Date("2026-11-01T00:00:00Z"),
});

let counter = 0;
beforeEach(() => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  vi.stubEnv("TRUST_CF_CONNECTING_IP", "0");
  mocks.rateLimitWindow.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 600 });
  // 공개 목록에 있는 제품은 alpha·beta 뿐 — 그 밖(없는·내려간)은 DB 조건에서 빠진다
  mocks.listProductRows.mockReset().mockImplementation(async (options: { slugs: string[] }) =>
    options.slugs.filter((slug) => slug === "alpha" || slug === "beta").map(row));
  counter += 1;
});

/** 30초 공개 읽기 캐시가 시험끼리 섞이지 않게 slug 를 시험마다 다르게 */
const unique = (slug: string) => `${slug}`;

describe("slugs= 카드 채우기", () => {
  it("공개 목록 조건(검증·시드, 닿지 않는 것 제외)으로 한 번만 읽고, 없는·내려간 slug 는 응답에 없다", async () => {
    const response = await GET(request(`slugs=beta,gone-${counter},alpha,missing-${counter}&locale=ko`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.listProductRows).toHaveBeenCalledTimes(1);
    expect(mocks.listProductRows).toHaveBeenCalledWith(expect.objectContaining({ statuses: ["verified", "seeded"], excludeDown: true }));
    const { items } = await response.json();
    expect(items.map((item: { slug: string }) => item.slug).sort()).toEqual(["alpha", "beta"]);
  });

  it("이름은 빼고 카드가 그리는 칸만 — 내부 id·저장소 주소·메이커·상태는 없다. full=1 이면 이름까지(저장 보기)", async () => {
    const text = await (await GET(request(`slugs=alpha,x${counter}&locale=ko`))).text();
    for (const key of ['"name":', '"repoUrl":', '"makerName":', '"status":', '"unclaimed":', '"builderClaim":', '"stack":', '"id":']) expect(text).not.toContain(key);
    const [item] = JSON.parse(text).items;
    expect(item).toMatchObject({ slug: "alpha", category: "Dev", aiLevel: 2, stars: 120, owner: { login: "owner-alpha" } });
    // 표지는 slug 만으로는 만들 수 없는 보호 주소(<slug>.<열쇠>)로만 — slug 주소는 응답에 없다(cover-url.ts)
    expect(item.ogImage).toMatch(/^\/api\/og-cache\/alpha\.[0-9a-f]{32}\?thumbnail=og&w=1200&h=630$/);
    expect(text).not.toContain('"/api/og-cache/alpha?');
    const full = await (await GET(request(`slugs=alpha,y${counter}&full=1&locale=ko`))).json();
    expect(full.items[0]).toMatchObject({ slug: "alpha", name: "ALPHA" });
  });

  it("메이커가 밝힌 만든 도구는 서버 카드처럼 채운다(PR #964 검토) — 추정(주인 없는 수집분)은 싣지 않는다", async () => {
    mocks.listProductRows.mockImplementation(async (options: { slugs: string[] }) => options.slugs.map((slug) => ({
      ...row(slug), builder: "Claude Code", ...(slug.startsWith("claimed") ? { source: "maker", claimedAt: new Date("2026-11-02T00:00:00Z") } : {}),
    })));
    const { items } = await (await GET(request(`slugs=claimed-${counter},crawled-${counter}&locale=ko`))).json();
    const bySlug = new Map(items.map((item: { slug: string }) => [item.slug, item]));
    expect(bySlug.get(`claimed-${counter}`)).toMatchObject({ builder: "Claude Code", builderClaim: "reported" });
    expect(bySlug.get(`crawled-${counter}`)).not.toHaveProperty("builder");
    expect(bySlug.get(`crawled-${counter}`)).not.toHaveProperty("builderClaim");
  });

  it("최대 60개 — 61개는 400 이고 읽지 않는다. 중복은 하나로, 모양이 틀린 slug 는 읽지 않는다", async () => {
    const many = Array.from({ length: 61 }, (_, index) => `p${index}-${counter}`);
    const refused = await GET(request(`slugs=${many.join(",")}`));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "too_many_slugs", max: 60 });
    expect(mocks.listProductRows).not.toHaveBeenCalled();
    const sixty = many.slice(0, 60);
    expect((await GET(request(`slugs=${[...sixty, sixty[0]].join(",")}`))).status).toBe(200);
    expect(mocks.listProductRows.mock.calls[0][0].slugs).toHaveLength(60);
    await GET(request(`slugs=${unique("alpha")},Bad Slug!,../etc,${"a".repeat(81)}&z=${counter}`));
    expect(mocks.listProductRows.mock.calls.at(-1)![0].slugs).toEqual(["alpha"]);
  });

  it("공개 API 읽기 관문 — 수집 도구·학습 봇·다른 사이트는 403, 한도를 넘으면 429, 그 전에 읽지 않는다", async () => {
    for (const ua of ["curl/8.7.1", "python-requests/2.32.3", "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"]) {
      expect((await GET(request("slugs=alpha", ua))).status).toBe(403);
    }
    const cross = new Request("https://nomorevibe.test/api/product-cards?slugs=alpha", { headers: { "user-agent": BROWSER, "x-forwarded-for": "198.51.100.23", "sec-fetch-site": "cross-site" } });
    expect((await GET(cross)).status).toBe(403);
    mocks.rateLimitWindow.mockResolvedValue({ allowed: false, count: 301, retryAfterSeconds: 120 });
    expect((await GET(request("slugs=alpha"))).status).toBe(429);
    expect(mocks.listProductRows).not.toHaveBeenCalled();
  });
});

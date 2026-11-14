import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductDetailView, PublicProduct } from "@/lib/domain/products/detail-view";

/**
 * 공개 HTML 줄이기(2026-11-14) — 서버 HTML 에서 뺀 README 전문·상세 부가 자료를 브라우저가 받는 같은 출처 API.
 * 공개 API 읽기 관문(수집 도구·학습 봇 거절, 다른 사이트 요청 거절, IP 별 읽기 한도)을 그대로 거치고, 화면이 읽는 칸만 돌려준다.
 * DB 는 부르지 않는다 — 한도 표와 상세 조회만 바꿔 끼운다.
 */
const mocks = vi.hoisted(() => ({
  rateLimitWindow: vi.fn(),
  getProductIdentity: vi.fn(),
  getProductDetail: vi.fn(),
  getReadmeContent: vi.fn(),
}));
vi.mock("@/lib/rate-limit", async (original) => ({
  ...await original<typeof import("@/lib/rate-limit")>(),
  rateLimitWindow: mocks.rateLimitWindow,
}));
vi.mock("@/lib/domain/products/detail-view", async (original) => ({
  ...await original<typeof import("@/lib/domain/products/detail-view")>(),
  getProductIdentity: mocks.getProductIdentity,
  getProductDetail: mocks.getProductDetail,
}));
vi.mock("@/lib/domain/products/readme-content", () => ({ getReadmeContent: mocks.getReadmeContent }));

const readmeRoute = await import("@/app/api/products/[slug]/readme/route");
const detailsRoute = await import("@/app/api/products/[slug]/details/route");
const { reviveDetailExtras } = await import("@/lib/domain/products/detail-extras");

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PUBLIC_IP = "198.51.100.23";

function request(path: string, init: { ua?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  headers.set("user-agent", init.ua ?? BROWSER);
  headers.set("x-forwarded-for", PUBLIC_IP);
  return new Request(`https://nomorevibe.test${path}`, { headers });
}
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

const product = {
  id: 95_292, slug: "ggml", url: "https://ggml.example", accessMode: "website", name: "ggml", tagline: "Tensor library", taglineSource: "ai_readme",
  description: "Long description", category: "Dev", builder: null, stack: ["C"], ogImage: null, makerName: "maker", repoUrl: "https://github.com/ggml-org/ggml",
  status: "seeded", source: "crawler", claimedAt: null, verifiedAt: null, createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-11-01T00:00:00Z"),
  stars: 197, starsAt: null, starsPrevious: null, starsPreviousAt: null, auditHoldAt: null, repoGone: false, aiEvidence: true, takedownPending: false,
  taglineKo: null, translationName: "ggml", translationEligible: true,
} as unknown as PublicProduct;

const related = {
  id: 7, slug: "other", name: "Other", tagline: "Other tool", taglineSource: "maker", taglineKo: "다른 도구", category: "Dev", accessMode: "website",
  builder: "x", builderClaim: "guessed", stack: [], ogImage: null, makerName: "m", repoUrl: "https://github.com/a/b", listedAt: new Date("2026-11-01T00:00:00Z"),
  status: "seeded", unclaimed: true, stars: 10, starsAt: null, starsPrevious: null, starsPreviousAt: null, aiLevel: null,
};

const detail = {
  product, unclaimed: true, rank: null,
  visits: { validVisits: 0, uniqueVisitors: null, uniqueChangePercent: null, collectionStartedAt: null, collecting: true, periodDays: 30 },
  health: { uptime30d: null, latencyMs: null, checkedAt: new Date("2026-11-14T00:00:00Z"), lastCheckSucceeded: true, down: false },
  profile: null, links: [], repository: null,
  license: { state: "missing", label: "라이선스 확인 안 됨", maker: null, observed: null },
  media: [], agents: [], observedAgentFacts: [], skills: [],
  updates: Array.from({ length: 5 }, (_, index) => ({ id: index, sourceKind: "github_release", sourceLabel: "자동 감지", canonicalUrl: null, title: `v${index}`,
    summary: "secret-ish summary", beforeAfter: null, publishedAt: new Date("2026-11-10T00:00:00Z"), observedAt: new Date("2026-11-10T00:00:00Z"), makerEditedAt: null })),
  freshness: [{ kind: "repository", provider: "github", state: "current", label: "최신", lastSuccessAt: new Date("2026-11-14T00:00:00Z"), lastFailureAt: null,
    nextAttemptAt: new Date(), normalizedFacts: { _githubCollection: { etag: "raw" } } }],
  risingRank: null, related: [related], relatedBasis: "category", relatedTotal: null, readmeExcerpt: "excerpt", aiLevel: { checked: true, level: null },
} as unknown as ProductDetailView;

beforeEach(() => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  vi.stubEnv("TRUST_CF_CONNECTING_IP", "0");
  mocks.rateLimitWindow.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 600 });
  mocks.getProductIdentity.mockReset().mockResolvedValue(product);
  mocks.getProductDetail.mockReset().mockResolvedValue(detail);
  mocks.getReadmeContent.mockReset().mockResolvedValue({ state: "available", markdown: "# ggml\n\nTensor library body.\n",
    sourceUrl: "https://github.com/ggml-org/ggml#readme", repositoryRootUrl: "https://github.com/ggml-org/ggml/blob/master/" });
});

const routes = [
  ["readme", (req: Request) => readmeRoute.GET(req, params("ggml"))],
  ["details", (req: Request) => detailsRoute.GET(req, params("ggml"))],
] as const;

describe("README 전문·부가 자료 API — 공개 API 읽기 관문을 그대로", () => {
  it.each(routes)("%s: 수집 도구·학습 봇·다른 사이트 요청은 403, 한도를 넘으면 429", async (name, call) => {
    for (const ua of ["curl/8.7.1", "python-requests/2.32.3", "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"]) {
      expect((await call(request(`/api/products/ggml/${name}`, { ua }))).status).toBe(403);
    }
    expect((await call(request(`/api/products/ggml/${name}`, { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    mocks.rateLimitWindow.mockResolvedValue({ allowed: false, count: 301, retryAfterSeconds: 120 });
    const limited = await call(request(`/api/products/ggml/${name}`));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("120");
    expect(mocks.getProductDetail).not.toHaveBeenCalled();
    expect(mocks.getReadmeContent).not.toHaveBeenCalled();
  });

  it.each(routes)("%s: 엣지·브라우저에 담지 않는다", async (name, call) => {
    const response = await call(request(`/api/products/ggml/${name}`, { headers: { "sec-fetch-site": "same-origin" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("README API", () => {
  it("README 앞부분과 원문 주소만 — 제품 칸은 돌려주지 않는다", async () => {
    const body = await (await readmeRoute.GET(request("/api/products/ggml/readme"), params("ggml"))).json();
    expect(body).toEqual({ state: "available", markdown: "# ggml\n\nTensor library body.\n", truncated: false, empty: false,
      sourceUrl: "https://github.com/ggml-org/ggml#readme", repositoryRootUrl: "https://github.com/ggml-org/ggml/blob/master/" });
  });

  it("못 읽으면 상태와 원문 주소, 저장소가 없으면 none, 없는 제품은 404", async () => {
    mocks.getReadmeContent.mockResolvedValueOnce({ state: "too_large", sourceUrl: "https://github.com/ggml-org/ggml#readme" });
    expect(await (await readmeRoute.GET(request("/api/products/ggml/readme"), params("ggml"))).json())
      .toEqual({ state: "too_large", sourceUrl: "https://github.com/ggml-org/ggml#readme" });
    mocks.getProductIdentity.mockResolvedValueOnce({ ...product, repoUrl: null });
    expect(await (await readmeRoute.GET(request("/api/products/other/readme"), params("other"))).json()).toEqual({ state: "none" });
    mocks.getProductIdentity.mockResolvedValueOnce(null);
    expect((await readmeRoute.GET(request("/api/products/missing/readme"), params("missing"))).status).toBe(404);
  });
});

describe("부가 자료 API", () => {
  // 정보 카드의 '운영자 미확인' 표시(unclaimed)·사실 칸의 등록일(createdAt)·저장소 링크(repoUrl)는 화면이 그리는 값이라 남는다
  it("부품이 읽는 칸만 — 내부 id·상태·설명·원본 수집 값·업데이트 요약은 없다", async () => {
    const response = await detailsRoute.GET(request("/api/products/ggml/details?locale=ko"), params("ggml"));
    const text = await response.text();
    for (const key of ['"status":', '"description":', '"normalizedFacts":', '"summary":', '"builderClaim":', '"source":', '"translationName":'])
      expect(text).not.toContain(key);
    expect(text).not.toMatch(/"id":(?:95292|7)\b/);
    const body = JSON.parse(text, reviveDetailExtras);
    expect(Object.keys(body.facts.product).sort()).toEqual(["accessMode", "createdAt", "repoGone", "repoUrl"]);
    expect(body.facts.product.createdAt).toBeInstanceOf(Date);
    expect(Object.keys(body.info.product).sort()).toEqual(["accessMode", "category", "makerName", "repoGone", "repoUrl", "slug", "stack", "url"]);
    expect(body.info.freshness).toEqual([{ provider: "github", lastSuccessAt: new Date("2026-11-14T00:00:00Z") }]);
    expect(body.timeline.rows).toHaveLength(3);
    expect(body.timeline.total).toBe(5);
    expect(Object.keys(body.related.items[0]).sort()).toEqual(["accessMode", "aiLevel", "category", "listedAt", "name", "ogImage", "slug", "stars", "starsAt",
      "starsPrevious", "starsPreviousAt", "tagline", "taglineKo", "taglineSource"]);
  });

  it("모르는 언어는 기본 언어, 없는 제품은 404", async () => {
    expect((await detailsRoute.GET(request("/api/products/ggml/details?locale=xx"), params("ggml"))).status).toBe(200);
    mocks.getProductDetail.mockResolvedValueOnce(null);
    expect((await detailsRoute.GET(request("/api/products/missing/details"), params("missing"))).status).toBe(404);
  });
});

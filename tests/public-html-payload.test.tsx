import Link from "next/link";
import { Fragment, Suspense, isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicProduct } from "@/lib/domain/products/detail-view";
import type { PopularProduct } from "@/lib/domain/products/popular";
import type { ProductListItem } from "@/lib/domain/products/view";

/**
 * 공개 HTML 은 제품 이름·요약만(2026-11-15 사람 결정, docs/tasks/2026-11-15-public-html-name-summary.md 7장) — 허용 목록 시험.
 *
 * 대역 제품의 숨길 칸마다 표식 값(SENTINEL_*·987654·sentinel.example…)을 넣고, 4.2의 화면·generateMetadata·JSON-LD·feed.xml·og 카드 데이터를
 * 그린 결과에 표식이 0개이고 이름·요약은 있음을 본다. 브라우저 부품 속성(RSC 데이터)에 실린 제품 객체(slug 를 가진 객체)는
 * 허용 칸(slug·name·summary·lang)만 가져야 한다. DB 없이 실제 화면 부품을 대역 값으로 그린다.
 *
 * RSC 를 흉내 낸다: 서버 부품은 펼치고, "use client" 파일의 부품(vitest.config.ts 가 경계 표시를 단다)과 next/link 는 경계로 보고
 * 그 속성을 JSON 으로 모은다 — Next 가 HTML 안 self.__next_f 로 싣는 값이다. 브라우저 부품의 첫 그림(SSR)은 이 속성만으로 그린다.
 *  - clientJson: 브라우저 부품 속성의 JSON(= RSC 데이터의 값)
 *  - text: 서버가 그린 글자와 속성 값(= 서버 HTML 의 글자)
 */

/**
 * 브라우저 부품 속성 안 제품 객체(slug 를 가진 객체)에 허용하는 칸 — 제품 값은 slug·name·summary·lang 뿐이고,
 * 나머지는 그리기 설정(차례·제목 단계·채울 목록 주소·팔로 단추 글자 등)이다. 새 칸이 생기면 이 목록에 일부러 더해야 한다.
 */
const ALLOWED_PRODUCT_KEYS = new Set(["slug", "name", "summary", "lang",
  "rank", "priority", "headingLevel", "fillFrom", "trailing", "followLabels"]);

/** 숨길 칸의 표식 — 어느 하나라도 서버 HTML·RSC 데이터·메타·JSON-LD·피드·og 데이터에 보이면 실패 */
const SENTINELS = [
  "SENTINEL", "sentinel.example", "sentinel-owner", "987654", "987,654", "987653", "987,653", "987001", "987,001", "987002", "987,002",
  "987003", "987,003", "987004", "987,004", "og-cache", "github.com/",
];
const NAMES = ["Fixture 1", "Fixture 4"];

type Flight = { clientJson: string[]; text: string[]; boundaries: string[] };

const CONTEXT = Symbol.for("react.context");
const MEMO = Symbol.for("react.memo");
const FORWARD_REF = Symbol.for("react.forward_ref");

function isClient(type: unknown): boolean {
  return type === Link || (typeof type === "function" && (type as { $$nmvClientBoundary?: boolean }).$$nmvClientBoundary === true);
}

function serializeProps(props: Record<string, unknown>, nested: unknown[]): string {
  return JSON.stringify(props, (_key, value: unknown) => {
    if (isValidElement(value)) { nested.push(value); return "$element"; }
    if (typeof value === "function") return "$function";
    return value;
  });
}

async function walk(node: unknown, out: Flight): Promise<void> {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") { out.text.push(String(node)); return; }
  if (Array.isArray(node)) { for (const child of node) await walk(child, out); return; }
  if (node instanceof Promise) { await walk(await node, out); return; }
  if (!isValidElement(node)) return;
  const element = node as ReactElement<Record<string, unknown>>;
  const { type, props } = element;
  if (isClient(type)) {
    const nested: unknown[] = [];
    out.boundaries.push(typeof type === "function" ? type.name : "Link");
    out.clientJson.push(serializeProps(props, nested));
    for (const child of [props.children].flat()) if (typeof child === "string" || typeof child === "number") out.text.push(String(child));
    for (const child of nested) await walk(child, out);
    return;
  }
  if (typeof type === "string") {
    for (const [key, value] of Object.entries(props)) {
      if (key === "children") continue;
      if (key === "dangerouslySetInnerHTML") out.text.push(String((value as { __html?: string })?.__html ?? ""));
      else if (typeof value === "string") out.text.push(value);
    }
    await walk(props.children, out);
    return;
  }
  if (type === Fragment) { await walk(props.children, out); return; }
  if (type === Suspense) { await walk(props.fallback, out); await walk(props.children, out); return; }
  if (typeof type === "function") { await walk((type as (props: unknown) => unknown)(props), out); return; }
  const exotic = type as unknown as { $$typeof?: symbol; type?: unknown; render?: (props: unknown, ref: unknown) => unknown };
  if (exotic.$$typeof === CONTEXT) { await walk(props.children, out); return; }
  if (exotic.$$typeof === MEMO) { await walk({ ...element, type: exotic.type }, out); return; }
  if (exotic.$$typeof === FORWARD_REF && exotic.render) { await walk(exotic.render(props, null), out); return; }
  await walk(props.children, out);
}

async function flight(node: unknown): Promise<Flight & { json: string; html: string }> {
  const out: Flight = { clientJson: [], text: [], boundaries: [] };
  await walk(node, out);
  return { ...out, json: out.clientJson.join("\n"), html: out.text.join(" ") };
}

/** 브라우저 부품 속성 안의 제품 객체(slug 를 가진 객체)에서 허용 목록 밖의 칸 */
function extraProductKeys(json: string): string[] {
  const extra = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.slug === "string") for (const key of Object.keys(record)) if (!ALLOWED_PRODUCT_KEYS.has(key)) extra.add(key);
      Object.values(record).forEach(visit);
    }
  };
  for (const line of json.split("\n")) if (line) visit(JSON.parse(line));
  return [...extra];
}

const leaked = (text: string) => SENTINELS.filter((sentinel) => text.includes(sentinel));

/** 화면이 허용 목록을 지키는가 — 표식 0개, 제품 객체는 허용 칸만 */
function expectNameSummaryOnly(page: { html: string; json: string }) {
  expect(leaked(page.html)).toEqual([]);
  expect(leaked(page.json)).toEqual([]);
  expect(extraProductKeys(page.json)).toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------
// 대역 값 — 숨길 칸마다 표식

const NOW = new Date("2026-11-14T12:00:00Z");
const SENTINEL_PRODUCT = {
  category: "SENTINEL_CAT", accessMode: "installable", builder: "SENTINEL_BUILDER", builderClaim: "reported", stack: ["SENTINEL_STACK"],
  ogImage: "/api/og-cache/sentinel-og.png", makerName: "SENTINEL_MAKER", repoUrl: "https://github.com/sentinel-owner/sentinel-repo", repoRenamedTo: null,
  url: "https://sentinel.example/site", status: "seeded", unclaimed: true, stars: 987654, starsAt: new Date("2026-11-14T00:00:00Z"),
  starsPrevious: 987653, starsPreviousAt: new Date("2026-11-13T00:00:00Z"), health: { down: true, since: null },
  activity: { updatedAt: null, pushedAt: "2026-11-12T00:00:00.000Z", pushCount: 987654, pushObservedAt: "2026-11-13T00:00:00.000Z" }, aiLevel: 3,
  listedAt: new Date("2026-11-01T00:00:00Z"), repoCreatedAt: new Date("2026-11-10T00:00:00Z"), taglineSource: "ai_readme",
  description: "SENTINEL_DESCRIPTION long text", ownerType: "Organization",
} as const;

function row(index: number, over: Partial<ProductListItem> = {}): ProductListItem {
  return {
    ...SENTINEL_PRODUCT, id: 987_000 + index, translationName: `Fixture ${index}`, slug: `fixture-${index}`, name: `Fixture ${index}`,
    tagline: `Tagline number ${index} for the card`, taglineKo: `카드 소개 ${index}`, ...over,
  } as unknown as ProductListItem;
}

const growth = { gain: 987654, stars: 987653, baselineStars: 1, observedAt: "2026-11-14T06:00:00.000Z", baselineObservedAt: "2026-11-13T22:00:00.000Z" };
const snapshot = { status: "ready", reason: null, asOf: "2026-11-14T07:00:00.000Z", nextCycle: "2026-11-14T15:00:00.000Z", baselineAsOf: "2026-11-13T23:00:00.000Z",
  runId: 4, runStatus: "closed", closedAt: "2026-11-14T07:00:00.000Z", policyVersion: "growth-8h-v1", policy: null, targetCount: 80, successCount: 80, failureCount: 0,
  firstObservedAt: null, lastObservedAt: null, baseline: null, comparableCount: 2 };

const mocks = vi.hoisted(() => ({
  getPublicList: vi.fn(),
  getStarGrowthPage: vi.fn(),
  getNewThisWeek: vi.fn(),
  countNewThisWeek: vi.fn(),
  getPopularGroups: vi.fn(),
  getPopularPage: vi.fn(),
  getPopularFacets: vi.fn(),
  getHomePulse: vi.fn(),
  getProductIdentity: vi.fn(),
  getProductDetail: vi.fn(),
  getPublicListBySlugs: vi.fn(),
  searchRelevance: vi.fn(),
  relevanceWindow: vi.fn(),
  listRecentlyDiscovered: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), after: () => {}, connection: async () => {} }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: vi.fn().mockResolvedValue({ agentEvidence: { displayObservedFacts: true } }) }));
vi.mock("@/lib/news/repository", () => ({ listHomeNews: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/social/home-talk", () => ({ loadHomeTalk: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/social/flags", () => ({ talkVisibility: vi.fn().mockResolvedValue({ visible: false, preview: false }), talkPublicEnabled: () => false }));
vi.mock("@/lib/domain/products/popular", () => ({
  getPopularGroups: mocks.getPopularGroups, getPopularPage: mocks.getPopularPage, getPopularFacets: mocks.getPopularFacets,
}));
vi.mock("@/lib/domain/products/star-growth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), getStarGrowthPage: mocks.getStarGrowthPage,
}));
vi.mock("@/lib/domain/products/repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiLevelCounts: vi.fn().mockResolvedValue([{ level: 1, count: 987003 }]),
  categoryCounts: vi.fn().mockResolvedValue({ Dev: 987001, Data: 987004 }),
  countProducts: vi.fn().mockResolvedValue(987002),
  listRecentlyDiscovered: mocks.listRecentlyDiscovered,
  RISING_MAX_STARS: 2000,
}));
vi.mock("@/lib/domain/products/search-log", () => ({ recordSearch: vi.fn(), popularSearches: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/domain/products/admin-models-search", () => ({
  resolveSearchQuery: async (query?: string) => ({ queries: query ? [query] : [], translated: null }),
  warmQueryTranslation: vi.fn(),
}));
vi.mock("@/lib/domain/products/relevance", () => ({ searchRelevance: mocks.searchRelevance, relevanceWindow: mocks.relevanceWindow }));
vi.mock("@/lib/domain/products/view", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUnclaimedList: vi.fn().mockResolvedValue([]),
  getPublicList: mocks.getPublicList,
  getPublicListBySlugs: mocks.getPublicListBySlugs,
  getNewThisWeek: mocks.getNewThisWeek,
  countNewThisWeek: mocks.countNewThisWeek,
}));
vi.mock("@/lib/domain/products/home-pulse", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getHomePulse: mocks.getHomePulse,
}));
vi.mock("@/lib/domain/ranking/view", () => ({
  getCurrentSeason: vi.fn().mockResolvedValue(null),
  getSeasonRanking: vi.fn().mockResolvedValue({ items: [] }),
}));
vi.mock("@/lib/domain/products/detail-view", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProductIdentity: mocks.getProductIdentity,
  getProductDetail: mocks.getProductDetail,
}));
vi.mock("@/lib/domain/github-installations/bindings", () => ({ getProductGithubBinding: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/i18n/products", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readTranslationsForProducts: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  onReplica: async (load: () => Promise<unknown>) => load(),
}));
vi.mock("@/lib/domain/products/translations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readProductTranslationReadiness: vi.fn().mockResolvedValue([]),
}));

const { HomeContent, generateMetadata: homeMetadata } = await import("@/app/(public)/[locale]/(content)/page");
const { default: PopularPage } = await import("@/app/(public)/[locale]/(content)/popular/page");
const { default: RisingPage } = await import("@/app/(public)/[locale]/(content)/rising/page");
const { default: ProductPage, generateMetadata: productMetadata } = await import("@/app/(public)/[locale]/(content)/p/[slug]/page");
const { PublicNotFound } = await import("@/components/home/PublicNotFound");
const { GET: feed } = await import("@/app/feed.xml/route");
const { shareCardData } = await import("@/lib/me/share");
const { emptyHomePulse } = await import("@/lib/domain/products/home-pulse");

const detailProduct = {
  ...SENTINEL_PRODUCT, id: 987_999, slug: "ggml", name: "ggml", tagline: "Tensor library for machine learning", taglineKo: "머신러닝용 텐서 라이브러리",
  translationName: "ggml", translationEligible: true, source: "crawler", claimedAt: null, verifiedAt: null, auditHoldAt: null, repoGone: false,
  aiEvidence: true, takedownPending: false, createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-11-01T00:00:00Z"),
} as unknown as PublicProduct;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPublicList.mockImplementation(async (limit: number, options: { offset?: number } = {}) =>
    Array.from({ length: limit }, (_, index) => row((options.offset ?? 0) + index + 1)));
  mocks.getPublicListBySlugs.mockImplementation(async (slugs: string[]) => slugs.map((slug) => row(Number(slug.split("-")[1]))));
  mocks.searchRelevance.mockResolvedValue({ head: [], total: 30, semantic: false, reranked: false, plan: [], translated: null });
  mocks.relevanceWindow.mockImplementation(async (_ranked: unknown, _plan: unknown, _filters: unknown, offset: number, limit: number) =>
    Array.from({ length: limit }, (_, index) => `fixture-${offset + index + 1}`));
  mocks.getNewThisWeek.mockImplementation(async (limit: number, _since: Date, _until: Date, offset = 0) =>
    Array.from({ length: Math.min(limit, 3) }, (_, index) => row(offset + 11 + index)));
  mocks.countNewThisWeek.mockResolvedValue(40);
  mocks.getStarGrowthPage.mockImplementation(async (options: { page?: string } = {}) => ({
    items: [row(21), row(22)].map((item) => ({ ...item, starGrowth: growth })),
    total: 40, page: Number(options.page ?? 1), pages: 3, pageSize: 15, offset: 0, facets: null, snapshot,
  }));
  const popular = (index: number): PopularProduct => row(index) as unknown as PopularProduct;
  mocks.getPopularGroups.mockResolvedValue([{ key: "rising", total: 987654, items: [popular(41), popular(42)] }]);
  mocks.getPopularPage.mockImplementation(async (_tier: string, _filters: unknown, _sort: string, page = 1) => ({
    items: Array.from({ length: 15 }, (_, index) => popular(100 + index + 1)), total: 987002, totals: [987004, 0, 0, 0], page, pages: 3, pageSize: 15,
  }));
  mocks.getPopularFacets.mockResolvedValue({ categories: [{ category: "Dev", count: 987001 }], all: 987002, ai: 987003, personal: 987004 });
  mocks.getHomePulse.mockResolvedValue({ ...emptyHomePulse(NOW),
    active: [{ slug: "fixture-61", name: "Fixture 61", category: "SENTINEL_CAT", releases: 987653, stars: 987654, ogImage: "/api/og-cache/sentinel.png" }],
    categories: [{ key: "Dev", total: 987001, born: 987004 }] });
  mocks.getProductIdentity.mockResolvedValue(detailProduct);
  mocks.getProductDetail.mockRejectedValue(new Error("상세 본문은 서버에서 detail 을 읽지 않는다"));
  mocks.listRecentlyDiscovered.mockResolvedValue([{ ...row(71), createdAt: NOW }, { ...row(72), createdAt: NOW }]);
});

describe("홈·분야·검색 — 서버 HTML 은 첫 쪽 카드의 이름·요약·링크뿐", () => {
  it("홈 기본: 표식 0개, 제품 객체는 slug·이름·요약만, 첫 쪽 카드·급상승 띠·활발한 목록의 이름은 있다", async () => {
    const page = await flight(await HomeContent({ params: {} }));
    expectNameSummaryOnly(page);
    for (const name of [...NAMES, "Fixture 21", "Fixture 61"]) expect(page.html + page.json).toContain(name);
    expect(page.json).toContain("카드 소개 1");
    // 첫 쪽(9장)만 — 10번째 카드는 없다
    expect(page.json).not.toContain("Fixture 10\"");
    expect(page.boundaries).toEqual(expect.arrayContaining(["TeaserProjectCard", "TeaserCompactCard", "BrowseFilters", "IntroLine", "ActiveRows"]));
  });

  it("더 보기(?shown=18): 첫 쪽 뒤 카드는 서버 HTML 에 없고 빈 틀(list=home)만, 그 주소는 noindex,follow", async () => {
    const page = await flight(await HomeContent({ params: { shown: "18" } }));
    expectNameSummaryOnly(page);
    expect(page.json).toContain("Fixture 9");
    expect(page.json).not.toContain("Fixture 10\"");
    expect(page.json).not.toContain("Fixture 18");
    expect(page.json).toMatch(/"fillFrom":"[^"]*list=home[^"]*offset=9[^"]*limit=9/);
    const metadata = await homeMetadata({ searchParams: Promise.resolve({ shown: "18" }) } as never, Promise.resolve({}) as never);
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it("분야 화면(category=Dev): 분야 목록도 첫 쪽만, 분야별 수·공개 수는 서버 HTML 에 없다", async () => {
    const page = await flight(await HomeContent({ params: { category: "Dev" } }));
    expectNameSummaryOnly(page);
    expect(page.json).toContain("Fixture 1");
  });

  it("검색(?q=): 순위 계산은 그대로, 출력만 이름·요약 — 늘린 쪽도 서버가 이름·요약으로 그린다", async () => {
    const page = await flight(await HomeContent({ params: { q: "fixture", shown: "18" } }));
    expectNameSummaryOnly(page);
    expect(mocks.searchRelevance).toHaveBeenCalled();
    expect(page.json).toContain("Fixture 18");
  });

  it("저장 보기(?saved=1): 후보 카드를 서버 HTML 에 싣지 않는다", async () => {
    const page = await flight(await HomeContent({ params: { saved: "1" } }));
    expectNameSummaryOnly(page);
    expect(page.boundaries).toContain("SavedOnlyGrid");
    expect(page.json).not.toContain("Fixture 1\"");
  });

  it("이번 주 새로 나온(?new=1): 첫 쪽은 이름·요약, 2쪽은 빈 틀(list=new-page)", async () => {
    const first = await flight(await HomeContent({ params: { new: "1" } }));
    expectNameSummaryOnly(first);
    expect(first.json).toContain("Fixture 11");
    const second = await flight(await HomeContent({ params: { new: "1", page: "2" } }));
    expectNameSummaryOnly(second);
    expect(second.json).not.toContain("Fixture");
    expect(second.json).toContain("list=new-page&page=2");
  });
});

describe("/popular·/rising — 첫 쪽 앞줄만 이름·요약, 2쪽부터 빈 틀", () => {
  it("/popular 목록·카드 보기: 표식 0개(순위 수·구간 수·알약 수 포함), 앞 5줄 이름만", async () => {
    for (const view of ["list", "cards"]) {
      const page = await flight(await PopularPage({ searchParams: Promise.resolve({ view }) }));
      expectNameSummaryOnly(page);
      expect(page.json).toContain("Fixture 105");
      expect(page.json).not.toContain("Fixture 106");
      expect(page.json).toContain("from=0");
    }
  });

  it("/popular 2쪽: 줄 없이 빈 틀", async () => {
    const page = await flight(await PopularPage({ searchParams: Promise.resolve({ page: "2" }) }));
    expectNameSummaryOnly(page);
    expect(page.json).not.toContain("Fixture");
    expect(page.boundaries).toContain("LazyPopularRest");
  });

  it("/rising 1쪽은 이름·요약, 2쪽은 빈 틀 — 8시간 증가 수는 어디에도 없다", async () => {
    const first = await flight(await RisingPage({ searchParams: Promise.resolve({}) }));
    expectNameSummaryOnly(first);
    expect(first.json).toContain("Fixture 21");
    const second = await flight(await RisingPage({ searchParams: Promise.resolve({ page: "2" }) }));
    expectNameSummaryOnly(second);
    expect(second.json).not.toContain("Fixture");
  });
});

describe("상세 — h1 이름·요약·빵부스러기 홈›이름·JSON-LD(이름·요약)만", () => {
  it("본문: 표식 0개, 분야·소유자·스타·README·사이트 주소·표지·내부 id 없음", async () => {
    const page = await flight(await ProductPage({ params: Promise.resolve({ slug: "ggml" }) }));
    expectNameSummaryOnly(page);
    expect(page.html).toContain("ggml");
    expect(page.html).toContain("머신러닝용 텐서 라이브러리");
    expect(page.json).not.toMatch(/987999/);
    expect(mocks.getProductDetail).not.toHaveBeenCalled();
  });

  it("JSON-LD: WebPage+CreativeWork(이름·요약)+빵부스러기 홈›이름", async () => {
    const page = await flight(await ProductPage({ params: Promise.resolve({ slug: "ggml" }) }));
    const script = page.text.find((text) => text.includes('"@context"'))!;
    const [webPage, breadcrumb] = JSON.parse(script);
    expect(webPage["@type"]).toBe("WebPage");
    expect(webPage.mainEntity).toEqual({ "@type": "CreativeWork", name: "ggml", description: "머신러닝용 텐서 라이브러리",
      image: expect.stringMatching(/\/p\/ggml\/share-card\.png$/) });
    expect(breadcrumb.itemListElement.map((item: { name: string }) => item.name)).toEqual(["발견하기", "ggml"]);
    expect(leaked(script)).toEqual([]);
  });

  it("generateMetadata: 제목=이름, 설명=요약, og:image·twitter:image 는 이름·요약 공유 카드(share-card.png) — 표지·og-cache 0개", async () => {
    const metadata = await productMetadata({ params: Promise.resolve({ slug: "ggml" }) });
    const text = JSON.stringify(metadata);
    expect(metadata.openGraph?.images).toEqual([{ url: "/p/ggml/share-card.png", width: 1200, height: 630, alt: "ggml" }]);
    expect(metadata.twitter?.images).toEqual(["/p/ggml/share-card.png"]);
    expect(text).not.toContain("og-cache");
    expect(text).not.toContain("sentinel-og");
    expect(leaked(text)).toEqual([]);
    expect(metadata.description).toBe("머신러닝용 텐서 라이브러리");
  });

  it("서버 HTML(본문·RSC·JSON-LD·메타) 어디에도 /api/og-cache/ 주소가 0개 — JSON-LD image 도 공유 카드", async () => {
    const page = await flight(await ProductPage({ params: Promise.resolve({ slug: "ggml" }) }));
    const metadata = JSON.stringify(await productMetadata({ params: Promise.resolve({ slug: "ggml" }) }));
    const all = [page.html, page.json, metadata].join("\n");
    expect(all.match(/\/api\/og-cache\//g) ?? []).toHaveLength(0);
    const script = page.text.find((text) => text.includes('"@context"'))!;
    const [webPage] = JSON.parse(script);
    expect(webPage.mainEntity.image).toMatch(/\/p\/ggml\/share-card\.png$/);
  });
});

describe("피드·og 카드·없는 주소", () => {
  it("feed.xml: 이름·요약·주소·시각만", async () => {
    const xml = await (await feed(new Request("https://nomorevibe.test/feed.xml"), { params: Promise.resolve({}) } as never)).text();
    expect(leaked(xml)).toEqual([]);
    expect(xml).toContain("Fixture 71");
    expect(xml).toContain("카드 소개 71");
    expect(xml).not.toContain("<category");
  });

  it("og 카드 데이터: 이름·요약·사이트 표기만(칩·날짜 없음)", async () => {
    const data = await shareCardData("ggml", "ko");
    expect(Object.keys(data!).sort()).toEqual(["brandLine", "name", "tagline", "url"]);
    expect(leaked(JSON.stringify(data))).toEqual([]);
    expect(data!.tagline).toBe("머신러닝용 텐서 라이브러리");
  });

  it("없는 주소 화면(모든 공개 화면의 404 경계): 제품 값 없음", async () => {
    const page = await flight(await PublicNotFound({ locale: "ko" }));
    expectNameSummaryOnly(page);
    expect(page.json).not.toContain("Fixture");
  });
});

describe("바깥으로 나가는 문(2026-11-15 /go 서명 토큰) — 서버 HTML·RSC 에 /go 주소·바깥 주소 0개", () => {
  /** 토큰 붙은 /go 주소와 바깥 주소는 보호 API(/api/products/[slug]/details)로만 받는다 — slug 만으로 바깥 주소를 얻지 못한다 */
  const OUTBOUND = ["/go/", "?t=", "github.com/", SENTINEL_PRODUCT.url, SENTINEL_PRODUCT.repoUrl, "sentinel.example"];
  const outbound = (page: { html: string; json: string }) =>
    OUTBOUND.map((needle) => [needle, (page.html + "\n" + page.json).split(needle).length - 1] as const).filter(([, count]) => count > 0);

  it("상세·홈·분야·검색·/popular·/rising·더 보기 모두 0개", async () => {
    const pages = {
      detail: await flight(await ProductPage({ params: Promise.resolve({ slug: "ggml" }) })),
      home: await flight(await HomeContent({ params: {} })),
      category: await flight(await HomeContent({ params: { category: "Dev" } })),
      search: await flight(await HomeContent({ params: { q: "fixture", shown: "18" } })),
      more: await flight(await HomeContent({ params: { shown: "18" } })),
      popular: await flight(await PopularPage({ searchParams: Promise.resolve({ view: "cards" }) })),
      rising: await flight(await RisingPage({ searchParams: Promise.resolve({}) })),
    };
    for (const [name, page] of Object.entries(pages)) expect(outbound(page), name).toEqual([]);
    // 상세 화면은 바깥 단추를 받는 자리(DetailHeroSlots)만 둔다
    expect(pages.detail.html).toContain("ggml");
  });
});

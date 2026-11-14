import Link from "next/link";
import { Fragment, Suspense, isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductDetailView, PublicProduct } from "@/lib/domain/products/detail-view";
import type { PopularProduct } from "@/lib/domain/products/popular";
import type { ProductListItem } from "@/lib/domain/products/view";

/**
 * 공개 화면 HTML 줄이기(2026-11-14) — 서버 HTML 안 RSC 데이터에 제품 값이 JSON 으로 실리지 않는지 본다.
 * DB 없이 실제 화면 부품(홈·/popular·상세)을 대역 값으로 그린다.
 *
 * RSC 를 흉내 낸다: 서버 부품은 펼치고, "use client" 파일의 부품(vitest.config.ts 가 경계 표시를 단다)과 next/link 는 경계로 보고
 * 그 속성을 JSON 으로 모은다 — Next 가 HTML 안 self.__next_f 로 싣는 값이다. 경계 속성 안의 부품(children 등)은 서버가 그린 글자로 다시 펼친다.
 *  - clientJson: 브라우저 부품 속성의 JSON(= RSC 데이터의 값)
 *  - text: 서버가 그린 글자와 속성 값(= 서버 HTML 의 글자)
 */

/** RSC 데이터·브라우저 부품 속성에 실리면 안 되는 운영·식별 칸 */
const FORBIDDEN = ["id", "repoUrl", "status", "builderClaim", "taglineSource", "starsPreviousAt", "starsPrevious", "starsAt", "listedAt",
  "makerName", "unclaimed", "pushedAt", "repoRenamedTo", "createdAt", "source", "claimedAt", "verifiedAt", "description"] as const;

type Flight = { clientJson: string[]; text: string[]; boundaries: string[] };

const CONTEXT = Symbol.for("react.context");
const MEMO = Symbol.for("react.memo");
const FORWARD_REF = Symbol.for("react.forward_ref");

function isClient(type: unknown): boolean {
  return type === Link || (typeof type === "function" && (type as { $$nmvClientBoundary?: boolean }).$$nmvClientBoundary === true);
}

/** 브라우저 부품의 속성을 RSC 처럼 JSON 으로 — 그 안의 부품은 서버가 그린 것이라 따로 펼친다 */
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
    // 브라우저 부품이 그대로 그리는 글자 자식(링크 글자 등)은 서버 HTML 에도 있다
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

const forbiddenKeys = (json: string) => FORBIDDEN.filter((field) => json.includes(`"${field}":`));

/** 제품 행처럼 보이는 객체 — slug 와 함께 소개·별·분야 같은 값을 가진 것(저장 단추의 slug·이름은 아니다) */
function productObjects(json: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.slug === "string" && ("tagline" in record || "stars" in record || "category" in record)) found.push(record);
      Object.values(record).forEach(visit);
    }
  };
  for (const line of json.split("\n")) if (line) visit(JSON.parse(line));
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// 대역 값 — 공개 목록 행 그대로(금지 칸을 모두 가진다)

const NOW = new Date("2026-11-14T12:00:00Z");
function row(index: number, over: Partial<ProductListItem> = {}): ProductListItem & { starGrowth?: unknown } {
  return {
    id: 95_290 + index, translationName: `Fixture ${index}`, slug: `fixture-${index}`, name: `Fixture ${index}`, tagline: `Tagline number ${index} for the card`,
    taglineSource: "ai_readme", taglineKo: `카드 소개 ${index}`, category: "Dev", accessMode: "website", builder: "Claude Code", builderClaim: "guessed",
    stack: ["TypeScript"], ogImage: null, makerName: `maker-${index}`, repoUrl: `https://github.com/org-${index}/repo-${index}`, repoRenamedTo: null,
    listedAt: new Date("2026-11-01T00:00:00Z"), status: "seeded", unclaimed: true, stars: 100 + index, starsAt: new Date("2026-11-14T00:00:00Z"),
    starsPrevious: 90 + index, starsPreviousAt: new Date("2026-11-13T00:00:00Z"), health: { down: false, since: null },
    activity: { updatedAt: null, pushedAt: "2026-11-12T00:00:00.000Z", pushCount: 3, pushObservedAt: "2026-11-13T00:00:00.000Z" }, aiLevel: 2,
    ...over,
  } as ProductListItem;
}

const mocks = vi.hoisted(() => ({
  getPublicList: vi.fn(),
  getStarGrowthPage: vi.fn(),
  getNewThisWeek: vi.fn(),
  getPopularGroups: vi.fn(),
  getPopularPage: vi.fn(),
  getPopularFacets: vi.fn(),
  getHomePulse: vi.fn(),
  getProductIdentity: vi.fn(),
  getProductDetail: vi.fn(),
  getReadmeContent: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), after: () => {}, connection: async () => {} }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: vi.fn().mockResolvedValue({ agentEvidence: { displayObservedFacts: true } }) }));
vi.mock("@/lib/news/repository", () => ({ listHomeNews: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/social/home-talk", () => ({ loadHomeTalk: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/social/flags", () => ({ talkVisibility: vi.fn().mockResolvedValue({ visible: false, preview: false }) }));
vi.mock("@/lib/domain/products/popular", () => ({
  getPopularGroups: mocks.getPopularGroups, getPopularPage: mocks.getPopularPage, getPopularFacets: mocks.getPopularFacets,
}));
vi.mock("@/lib/domain/products/star-growth", () => ({ getStarGrowthPage: mocks.getStarGrowthPage }));
vi.mock("@/lib/domain/products/repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiLevelCounts: vi.fn().mockResolvedValue([]),
  categoryCounts: vi.fn().mockResolvedValue({ Dev: 7, Data: 3 }),
  countProducts: vi.fn().mockResolvedValue(12),
  RISING_MAX_STARS: 2000,
}));
vi.mock("@/lib/domain/products/search-log", () => ({ recordSearch: vi.fn(), popularSearches: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/domain/products/search-translation", () => ({
  resolveSearchQuery: async (query?: string) => ({ queries: query ? [query] : [], translated: null }),
  normalizeQuery: (query: string) => query.trim().toLowerCase(),
}));
vi.mock("@/lib/domain/products/relevance", () => ({
  searchRelevance: vi.fn().mockResolvedValue({ head: [], total: 0, semantic: false, reranked: false, plan: [], translated: null }),
  relevanceWindow: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/domain/products/view", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUnclaimedList: vi.fn().mockResolvedValue([]),
  getPublicList: mocks.getPublicList,
  getPublicListBySlugs: vi.fn().mockResolvedValue([]),
  getNewThisWeek: mocks.getNewThisWeek,
  countNewThisWeek: vi.fn().mockResolvedValue(0),
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
vi.mock("@/lib/domain/products/readme-content", () => ({ getReadmeContent: mocks.getReadmeContent }));
vi.mock("@/lib/domain/github-installations/bindings", () => ({ getProductGithubBinding: vi.fn().mockResolvedValue(null) }));

const { HomeContent } = await import("@/app/(public)/[locale]/(content)/page");
const { default: PopularPage } = await import("@/app/(public)/[locale]/(content)/popular/page");
const { default: ProductPage } = await import("@/app/(public)/[locale]/(content)/p/[slug]/page");
const { emptyHomePulse } = await import("@/lib/domain/products/home-pulse");

/** README 원문 — 앞부분(발췌)과 뒷부분(전문에만 있는 글) */
const README_LEAD = "Fixture tool turns meeting notes into tidy summaries. It runs locally and keeps your data on your machine.";
const README_TAIL_MARKER = "UNIQUE-FULL-README-TAIL contributors should open a pull request against the develop branch";
const README_MARKDOWN = `# Fixture\n\n${README_LEAD}\n\n## Install\n\n${"Install it with npm and run the command line tool. ".repeat(40)}\n\n## Contributing\n\n${README_TAIL_MARKER}.\n`;
const STORED_EXCERPT = `${README_LEAD}\n\n${"Install it with npm and run the command line tool. ".repeat(9).trim()}`;

const detailProduct: PublicProduct = {
  id: 95_292, slug: "ggml", url: "https://ggml.example", accessMode: "website", name: "ggml", tagline: "Tensor library for machine learning",
  taglineSource: "ai_readme", description: "A tensor library description that differs from the tagline.", category: "Dev", builder: null,
  stack: ["C"], ogImage: null, makerName: "maker-x", repoUrl: "https://github.com/ggml-org/ggml", status: "seeded", source: "crawler",
  claimedAt: null, verifiedAt: null, createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-11-01T00:00:00Z"),
  stars: 197, starsAt: new Date("2026-11-14T00:00:00Z"), starsPrevious: 190, starsPreviousAt: new Date("2026-11-13T00:00:00Z"),
  auditHoldAt: null, repoGone: false, aiEvidence: true, takedownPending: false, taglineKo: "머신러닝용 텐서 라이브러리", translationName: "ggml", translationEligible: true,
} as PublicProduct;

const detailView = {
  product: detailProduct, unclaimed: true, rank: null,
  visits: { validVisits: 4, uniqueVisitors: 3, uniqueChangePercent: null, collectionStartedAt: null, collecting: false, periodDays: 30 },
  health: { uptime30d: 99, latencyMs: 120, checkedAt: new Date("2026-11-14T11:00:00Z"), lastCheckSucceeded: true, down: false },
  profile: null, links: [],
  repository: { provider: "github", sourceUrl: "https://github.com/ggml-org/ggml", state: "current", observedAt: NOW, lastSuccessAt: NOW, lastFailureAt: null,
    facts: { repositoryKey: "ggml-org/ggml", repositoryUrl: "https://github.com/ggml-org/ggml", createdAt: "2023-01-01T00:00:00.000Z", pushedAt: "2026-11-12T00:00:00.000Z",
      updatedAt: null, stars: 197, forks: 10, public: true, archived: false, fork: false, homepage: null, contributors: { count: 5, incomplete: false, cap: null },
      license: { value: "MIT License", spdxId: "MIT", url: null, sourceLabel: "GitHub에서 확인" }, languages: [{ name: "C", bytes: 10, percent: 80 }, { name: "C++", bytes: 2, percent: 20 }],
      latestRelease: null, relationshipState: null } },
  license: { state: "observed_only", label: "GitHub에서 확인", maker: null, observed: { value: "MIT License", spdxId: "MIT", url: null, sourceLabel: "GitHub에서 확인" } },
  media: [], updates: [], agents: [], observedAgentFacts: [], skills: [],
  freshness: [{ kind: "repository", provider: "github", state: "current", label: "최신", lastSuccessAt: NOW, lastFailureAt: null, nextAttemptAt: NOW,
    normalizedFacts: { _githubCollection: { etag: "raw" } } }],
  risingRank: null, related: [row(31), row(32)], relatedBasis: "category", relatedTotal: null,
  readmeExcerpt: STORED_EXCERPT, aiLevel: { checked: true, level: 2 },
} as unknown as ProductDetailView;

beforeEach(() => {
  mocks.getPublicList.mockResolvedValue([1, 2, 3, 4].map((index) => row(index)));
  mocks.getNewThisWeek.mockResolvedValue([row(11, { repoCreatedAt: new Date("2026-11-10T00:00:00Z") }), row(12)]);
  mocks.getStarGrowthPage.mockResolvedValue({
    items: [row(21), row(22)].map((item) => ({ ...item, starGrowth: { gain: 12, stars: 150, baselineStars: 138, observedAt: "2026-11-14T06:00:00.000Z", baselineObservedAt: "2026-11-13T22:00:00.000Z" } })),
    total: 2, page: 1, pages: 1, pageSize: 5, offset: 0, facets: null,
    snapshot: { status: "ready", reason: null, asOf: "2026-11-14T07:00:00.000Z", nextCycle: "2026-11-14T15:00:00.000Z", baselineAsOf: "2026-11-13T23:00:00.000Z",
      runId: 4, runStatus: "closed", closedAt: "2026-11-14T07:00:00.000Z", policyVersion: "growth-8h-v1", policy: null, targetCount: 80, successCount: 80, failureCount: 0,
      firstObservedAt: null, lastObservedAt: null, baseline: { runId: 3, asOf: "2026-11-13T23:00:00.000Z", status: "closed", policyVersion: "growth-8h-v1",
        targetCount: 80, successCount: 80, failureCount: 0, firstObservedAt: null, lastObservedAt: null, closedAt: null }, comparableCount: 2 },
  });
  const popular = (index: number): PopularProduct => ({ ...row(index), stars: 5_000 + index, ownerType: "User" } as unknown as PopularProduct);
  mocks.getPopularGroups.mockResolvedValue([{ key: "rising", total: 2, items: [popular(41), popular(42)] }]);
  mocks.getPopularPage.mockResolvedValue({ items: [popular(51), popular(52)], total: 2, totals: [2, 0, 0, 0], page: 1, pages: 1, pageSize: 15 });
  mocks.getPopularFacets.mockResolvedValue({ categories: [{ category: "Dev", count: 2 }], all: 2, ai: 2, personal: 2 });
  mocks.getHomePulse.mockResolvedValue({ ...emptyHomePulse(NOW), active: [{ slug: "fixture-61", name: "Fixture 61", category: "Dev", releases: 3, stars: 300, ogImage: null }] });
  mocks.getProductIdentity.mockResolvedValue(detailProduct);
  mocks.getProductDetail.mockResolvedValue(detailView);
  mocks.getReadmeContent.mockResolvedValue({ state: "available", markdown: README_MARKDOWN, sourceUrl: "https://github.com/ggml-org/ggml#readme",
    repositoryRootUrl: "https://github.com/ggml-org/ggml/blob/master/" });
});

describe("홈·목록 — 카드는 서버가 글자로 그리고 제품 행을 RSC 데이터에 싣지 않는다", () => {
  it("홈: 브라우저 부품 속성에 금지 칸(내부 id·저장소 주소·상태·판정 근거·관측 시각…)과 제품 행이 없다", async () => {
    const page = await flight(await HomeContent({ params: {} }));
    expect(forbiddenKeys(page.json)).toEqual([]);
    expect(productObjects(page.json)).toEqual([]);
    // 화면은 그대로 그린다 — 목록·지금 뜨는·새로 나온·많이 쓰이는·가장 활발한(서버 HTML 글자)
    for (const name of ["Fixture 1", "Fixture 4", "Fixture 11", "Fixture 21", "Fixture 41", "Fixture 61"]) expect(page.html).toContain(name);
    // 집계 창에는 가장 활발한 목록 대신 수만, 회차의 실행 번호 없이
    expect(page.json).not.toContain('"active":');
    expect(page.json).not.toContain('"runId":');
  });

  it("검색 결과도 같다", async () => {
    const page = await flight(await HomeContent({ params: { q: "fixture", sort: "recent" } }));
    expect(forbiddenKeys(page.json)).toEqual([]);
    expect(productObjects(page.json)).toEqual([]);
    expect(page.html).toContain("Fixture 2");
  });

  it("/popular 목록·카드 보기", async () => {
    for (const view of ["list", "cards"]) {
      const page = await flight(await PopularPage({ searchParams: Promise.resolve({ view }) }));
      expect(forbiddenKeys(page.json)).toEqual([]);
      expect(productObjects(page.json)).toEqual([]);
      expect(page.html).toContain("Fixture 51");
    }
  });
});

describe("상세 — README 발췌만 서버 HTML 글자로, 전문·부가 자료는 같은 출처 API 로", () => {
  it("README 전문은 서버 HTML·RSC 데이터 어디에도 없고, 발췌는 한 번만 짧게 있다", async () => {
    const page = await flight(await ProductPage({ params: Promise.resolve({ slug: "ggml" }) }));
    expect(page.html).not.toContain("UNIQUE-FULL-README-TAIL");
    expect(page.json).not.toContain("UNIQUE-FULL-README-TAIL");
    // 발췌는 서버 HTML 에 한 번 — 브라우저 부품 속성(JSON)으로 다시 싣지 않는다
    expect(page.html.split(README_LEAD).length - 1).toBe(1);
    expect(page.json).not.toContain(README_LEAD);
    const excerpt = page.text.find((text) => text.startsWith(README_LEAD))!;
    expect(excerpt.length).toBeGreaterThan(README_LEAD.length);
    expect(excerpt.length).toBeLessThanOrEqual(320);
  });

  it("제목·한 줄 소개·분야·최소 JSON-LD 는 서버 HTML 에 남고, 브라우저 부품 속성에는 금지 칸·제품 행이 없다", async () => {
    const page = await flight(await ProductPage({ params: Promise.resolve({ slug: "ggml" }) }));
    expect(page.html).toContain("ggml");
    expect(page.html).toContain("머신러닝용 텐서 라이브러리");
    expect(page.html).toContain("개발 도구");
    expect(page.html).toContain('"@context":"https://schema.org"');
    expect(forbiddenKeys(page.json)).toEqual([]);
    expect(productObjects(page.json)).toEqual([]);
    // 같은 분야 카드·사실 칸(지표)·라이선스는 서버 HTML 에 없다 — 브라우저가 부가 자료 API 로 받는다
    expect(page.html).not.toContain("Fixture 31");
    expect(page.html).not.toContain("MIT");
  });
});

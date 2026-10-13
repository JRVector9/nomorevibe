import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-10-08 점검 SEO-04(정식 주소)·A11Y-05(제목 단계)·A11Y-03(문장 안 링크)·UX-06(부제)·PERF-03(목록 첫 줄).
 * 화면 조합만 본다 — DB·모델 서버에는 닿지 않는다(tests/home-unclaimed.test.tsx 와 같은 대역).
 */
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), after: () => {} }));

const mocks = vi.hoisted(() => ({
  getPublicList: vi.fn(),
  countProducts: vi.fn(),
  getCurrentSeason: vi.fn(),
}));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: vi.fn().mockResolvedValue({ agentEvidence: { displayObservedFacts: true } }) }));
vi.mock("@/lib/news/repository", () => ({ listHomeNews: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/domain/products/popular", () => ({ getPopularGroups: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/domain/products/repository", () => ({
  aiLevelCounts: vi.fn().mockResolvedValue([]),
  categoryCounts: vi.fn().mockResolvedValue({}),
  countProducts: mocks.countProducts,
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
vi.mock("@/lib/domain/products/view", () => ({
  getUnclaimedList: vi.fn().mockResolvedValue([]),
  getVerifiedList: vi.fn().mockResolvedValue([]),
  getPublicList: mocks.getPublicList,
  getPublicListBySlugs: vi.fn().mockResolvedValue([]),
  getNewThisWeek: vi.fn().mockResolvedValue([]),
  NEW_THIS_WEEK_MIN_STARS: 50,
}));
vi.mock("@/lib/domain/products/home-pulse", async () => ({
  ...(await vi.importActual<typeof import("@/lib/domain/products/home-pulse")>("@/lib/domain/products/home-pulse")),
  getHomePulse: vi.fn().mockRejectedValue(new Error("not in unit tests")),
}));
vi.mock("@/lib/domain/ranking/view", () => ({
  getAllTimeRanking: vi.fn().mockResolvedValue([]),
  getCurrentSeason: mocks.getCurrentSeason,
  getSeasonRanking: vi.fn().mockResolvedValue({ items: [] }),
}));

import { generateMetadata as categoryMetadata } from "@/app/(public)/[locale]/(content)/c/[category]/page";
import { generateMetadata, HomeContent } from "@/app/(public)/[locale]/(content)/page";
import { IntroLine } from "@/components/home/IntroLine";
import { emptyHomePulse } from "@/lib/domain/products/home-pulse";
import type { ProductListItem } from "@/lib/domain/products/view";

const OG = "/api/og-cache/p?thumbnail=og&w=1200&h=630&v=1";
function product(slug: string): ProductListItem {
  return {
    slug, name: slug, tagline: `${slug} tagline`, taglineSource: "maker", category: "Dev", builder: null, builderClaim: "reported",
    stack: [], ogImage: OG.replace("/p?", `/${slug}?`), makerName: null, repoUrl: null, listedAt: new Date("2026-08-20T00:00:00Z"),
    status: "verified", unclaimed: false,
  };
}
const rss = { "application/rss+xml": "http://localhost:3000/feed.xml" };
const home = (params: Record<string, string>) => generateMetadata({ searchParams: Promise.resolve(params) });
const category = (slug: string, params: Record<string, string> = {}) =>
  categoryMetadata({ params: Promise.resolve({ category: slug }), searchParams: Promise.resolve(params) });
/** 제목 태그를 문서 차례대로 — h1·h2·h3… 의 숫자만 */
const headingLevels = (html: string) => [...html.matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]));
const skipsLevel = (levels: number[]) => levels.some((level, index) => index > 0 && level > levels[index - 1] + 1);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSeason.mockResolvedValue(null);
  mocks.countProducts.mockResolvedValue(4);
  mocks.getPublicList.mockResolvedValue(["a", "b", "c", "d"].map(product));
});

describe("정식 주소 (SEO-04)", () => {
  it("보기 조건이 붙은 홈은 홈을 정식 주소로 — 레이아웃의 RSS 알림은 지우지 않는다", async () => {
    const variants: Record<string, string>[] = [{ sort: "recent" }, { ai: "1" }, { shown: "36" }, { saved: "1" }, { personal: "1" }, { q: "  " }];
    for (const params of variants) {
      expect(await home(params)).toEqual({ title: "nomorevibe — AI로 만든 것들, 세상에 나오다.", alternates: { canonical: "/", types: rss } });
    }
  });

  it("검색 결과는 정식 주소 없이 색인하지 않는다", async () => {
    expect(await home({ q: "pdf", sort: "recent" })).toEqual({ title: "“pdf” 검색 결과 — nomorevibe", robots: { index: false, follow: true } });
  });

  it("분야 화면은 /c/<분야>가 정식 주소, 분야 안 검색은 색인하지 않는다", async () => {
    expect(await category("dev")).toMatchObject({ alternates: { canonical: "/c/dev", types: rss } });
    expect(await category("dev", { sort: "recent", ai: "1" })).toMatchObject({ alternates: { canonical: "/c/dev" } });
    const searched = await category("dev", { q: "pdf" });
    expect(searched.robots).toEqual({ index: false, follow: true });
    expect(searched.alternates).toBeUndefined();
    expect(String(searched.title)).toContain("pdf");
  });
});

describe("검색·분야 화면의 제목 단계 (A11Y-05)", () => {
  it("검색 결과 h1 다음 카드 제목은 h2 — 단계를 건너뛰지 않는다", async () => {
    const html = renderToStaticMarkup(await HomeContent({ params: { q: "pdf", sort: "recent" } }));
    expect(html).toContain('<h1 id="projects-title" class="row-title">“pdf” 검색 결과</h1>');
    expect(html).toContain('<h2 class="project-title">');
    expect(skipsLevel(headingLevels(html))).toBe(false);
  });

  it("0건이면 빈 화면 제목 h2, 고를 거리 h3", async () => {
    mocks.getPublicList.mockResolvedValue([]);
    mocks.countProducts.mockResolvedValue(0);
    const html = renderToStaticMarkup(await HomeContent({ params: { q: "zzzz", sort: "recent" } }));
    expect(html).toContain("<h2>“zzzz”에 맞는 프로젝트가 없습니다</h2>");
    expect(html).toContain("<h3>이런 검색어는 어떠세요</h3>");
    expect(skipsLevel(headingLevels(html))).toBe(false);
  });

  it("홈은 목록 제목 h2 아래 카드 h3 그대로", async () => {
    const html = renderToStaticMarkup(await HomeContent({ params: { sort: "recent" } }));
    expect(html).toContain('<h3 class="project-title">');
    expect(html).not.toContain('<h2 class="project-title">');
  });
});

describe("목록 첫 줄 그림 (PERF-03)", () => {
  it("목록이 화면 첫 그림이면(검색) 앞 세 장만 먼저 받는다", async () => {
    const html = renderToStaticMarkup(await HomeContent({ params: { q: "pdf", sort: "recent" } }));
    const loading = [...html.matchAll(/<img [^>]*class="tile-preview"[^>]*>/g)].map((match) => match[0].match(/loading="(\w+)"/)?.[1]);
    expect(loading).toEqual(["eager", "eager", "eager", "lazy"]);
  });
});

describe("홈 부제 (UX-06)", () => {
  it("타이틀 아래 무엇을 모았고 표시가 무슨 뜻인지 한 줄, 게재 기준 링크", () => {
    const html = renderToStaticMarkup(createElement(IntroLine, { pulse: emptyHomePulse(new Date("2026-10-11T00:00:00Z")), total: 10, state: { sort: "weekly" } }));
    expect(html).toContain('<p class="intro-sub">');
    expect(html).toContain("공개 저장소에서 찾아 모은 프로젝트");
    expect(html).toContain("✓는 메이커가 도메인을 확인한 곳에만");
    expect(html).toContain('href="/policy#listing">어떻게 고르나요</a>');
  });
});

describe("문장 안 링크는 색만으로 가르지 않는다 (A11Y-03)", () => {
  it("홈 '집계 기준'·소개 숫자·빈 화면·부제 링크에 밑줄", () => {
    const css = readFileSync("app/home.css", "utf8");
    for (const selector of [".row-note a", ".intro-stats a", ".empty-state p a", ".intro-sub a"]) {
      const rule = css.match(new RegExp(`^${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
      expect(rule, selector).toContain("text-decoration: underline");
    }
  });
});

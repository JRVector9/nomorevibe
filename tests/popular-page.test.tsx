import type { ResolvingMetadata } from "next";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMarkup } from "@/components/cards/markup-loader";
import type { PopularCountsResponse } from "@/app/api/browse-counts/route";
import type { PopularFacets, PopularProduct } from "@/lib/domain/products/popular";

const { getPopularPage, getPopularFacets } = vi.hoisted(() => ({ getPopularPage: vi.fn(), getPopularFacets: vi.fn() }));
vi.mock("@/lib/domain/products/popular", () => ({ getPopularPage, getPopularFacets }));

/**
 * 2026-11-15 공개 HTML 이름·요약만 — 서버 HTML 에는 첫 쪽 앞줄의 차례·이름·요약·링크만 있고, 커버·@소유자·분야·스타는 그 쪽 목록 API
 * (/api/product-cards?list=popular-page&…&from=0)로, 구간·알약·제목의 수는 /api/browse-counts?part=popular 로 화면 JS 가 채운다.
 * 받은 값을 바꿔 끼워 받기 전(서버 HTML)과 받은 뒤 모양을 함께 본다. 기본은 받는 중(undefined).
 */
const fills = vi.hoisted(() => ({
  cards: undefined as Map<string, unknown> | undefined,
  fillFrom: [] as (string | undefined)[],
  counts: undefined as PopularCountsResponse | null | undefined,
  countQueries: [] as (string | null)[],
}));
vi.mock("@/components/cards/CardEnrich", async (original) => ({
  ...await original<typeof import("@/components/cards/CardEnrich")>(),
  useCardFill: (slug: string, fillFrom?: string) => { fills.fillFrom.push(fillFrom); return fills.cards ? fills.cards.get(slug) ?? null : undefined; },
}));
vi.mock("@/components/home/browse-counts", async (original) => ({
  ...await original<typeof import("@/components/home/browse-counts")>(),
  useCountsQuery: (query: string | null) => { fills.countQueries.push(query); return fills.counts; },
}));

import PopularPage, { generateMetadata } from "@/app/(public)/[locale]/(content)/popular/page";
import { cardItem } from "@/components/cards/card-item";
import { STAR_TIERS } from "@/lib/domain/products/stars";

const product = (over: Partial<PopularProduct> = {}): PopularProduct => ({
  slug: "lcu", name: "LCU", tagline: "League client helper", taglineKo: "리그 클라이언트 도우미", taglineSource: "ai_readme", category: "Dev",
  repoUrl: "https://github.com/a/lcu", repoRenamedTo: null, ogImage: "/api/og-cache/lcu", stars: 4_900, ownerType: "User",
  starsAt: "2026-10-08 04:38:13", starsPrevious: 4_850, starsPreviousAt: "2026-10-07 02:00:00",
  accessMode: "installable", aiLevel: 2, makerName: null, ...over,
});
const FACETS: PopularFacets = { categories: [{ category: "Dev", count: 337 }, { category: "Data", count: 29 }], all: 366, ai: 291, personal: 120 };
const COUNTS: PopularCountsResponse = { totals: [1_234, 56, 7, 0], total: 1_234, facets: FACETS };
const page = (over: Record<string, unknown> = {}) => ({
  items: [product(), product({ slug: "b", name: "B", ownerType: "Organization", aiLevel: null, accessMode: "website" })],
  total: 1_234, totals: [1_234, 56, 7, 0], page: 1, pages: 83, pageSize: 15, ...over,
});
/** 목록 API 가 주는 값 — 카드 칸(card-item.ts)에 계정 종류와 쪽 안 순위 */
const fillsFor = (rows: PopularProduct[], first = 1) => new Map(rows.map((row, index) => {
  const item: Record<string, unknown> = { ...cardItem(row as never, "ko"), ownerType: row.ownerType, rank: first + index };
  delete item.name;
  return [row.slug, item];
}));

async function render(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await PopularPage({ searchParams: Promise.resolve(params) }));
}

beforeAll(async () => { await loadMarkup(); });

beforeEach(() => {
  getPopularPage.mockReset().mockImplementation(async (_tier: string, _filters: unknown, _sort: string, at: number) => page({ page: at }));
  getPopularFacets.mockReset().mockResolvedValue(FACETS);
  fills.cards = undefined;
  fills.fillFrom.length = 0;
  fills.counts = COUNTS;
  fills.countQueries.length = 0;
});

describe("/popular 목록 보기 — 발견하기 부품으로(2026-10-11 시안 보완안)", () => {
  it("같은 조건의 동시 요청과 보기 전환은 목록·집계를 다시 읽지 않는다", async () => {
    await Promise.all([render({ page: "2" }), render({ page: "2", view: "cards" })]);
    expect(getPopularPage).toHaveBeenCalledOnce();
    expect(getPopularFacets).toHaveBeenCalledOnce();

    await render({ page: "3" });
    expect(getPopularPage).toHaveBeenCalledTimes(2);
    expect(getPopularFacets).toHaveBeenCalledOnce();
    await render({ page: "3", personal: "1" });
    expect(getPopularPage).toHaveBeenCalledTimes(3);
    expect(getPopularFacets).toHaveBeenCalledTimes(2);
  });

  it("실패한 목록은 저장하지 않아 다음 요청에서 다시 읽고 회복한다", async () => {
    getPopularPage.mockRejectedValueOnce(new Error("db down"));
    expect(await render()).toContain("목록을 불러오지 못했습니다");
    expect(await render()).toContain('class="popular-list"');
    expect(getPopularPage).toHaveBeenCalledTimes(2);
  });

  it("keeps a successful list when optional facet counts fail, without showing zero counts", async () => {
    getPopularFacets.mockRejectedValueOnce(new Error("facet timeout"));
    const html = await render();
    expect(html).toContain('class="popular-list"');
    expect(html).toContain("LCU");
    expect(html).not.toContain("목록을 불러오지 못했습니다");
    expect(html).not.toContain('class="chip-count"');
    expect(await render()).toContain('class="chip-count"');
    expect(getPopularPage).toHaveBeenCalledOnce();
    expect(getPopularFacets).toHaveBeenCalledTimes(2);
  });

  it("서버 HTML 의 줄은 순위 · 커버 자리 · 이름 · 한국어 소개 · 빈 자리 · 저장뿐 — @소유자·분야·계정·스타는 없다", async () => {
    const html = await render({ tier: "rising" });
    const row = html.match(/<li class="popular-row" aria-busy="true">([\s\S]*?)<\/li>/)![1];
    const order = ["popular-rank", "project-tile", "card-link", "popular-description", "popular-row-meta", "star-metric", "cover-saved"].map((mark) => row.indexOf(mark));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
    expect(row).toContain('<span class="popular-rank"><span aria-hidden="true">1</span><span class="sr-only">1위</span></span>');
    expect(row).toContain('href="/p/lcu"');
    expect(row).toContain("리그 클라이언트 도우미");
    expect(row).toContain('aria-label="LCU 저장"');
    for (const hidden of ["card-owner", "github.com", "/api/og-cache/", "개발 도구", "개인", "★", "4,900", "+50", "tile-flag-ai", "직접 설치"]) expect(row).not.toContain(hidden);
    expect(html).not.toContain("<span>조직</span>");
    // 앞줄의 나머지 칸은 그 쪽 목록 API 한 번(처음부터, from=0)으로 채운다
    expect(new Set(fills.fillFrom)).toEqual(new Set(["list=popular-page&tier=rising&from=0"]));
  });

  it("목록 API 로 채운 줄은 순위 · 카드 커버 · 이름 · @소유자 · 한국어 소개 · 분야·계정 · ★와 증감 · 저장을 둔다", async () => {
    fills.cards = fillsFor(page().items);
    const html = await render({ tier: "rising" });
    const row = html.match(/<li class="popular-row">([\s\S]*?)<\/li>/)![1];
    const order = ["popular-rank", "project-tile", "card-link", "card-owner", "popular-description", "popular-row-meta", "star-metric", "cover-saved"]
      .map((mark) => row.indexOf(mark));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
    // 좁은 화면은 커버 위 숫자로 같은 순위를 보인다
    expect(row).toContain('<span class="popular-rank"><span aria-hidden="true">1</span><span class="sr-only">1위</span></span>');
    expect(row).toContain('<span class="popular-thumb-rank">1</span>');
    // 커버는 발견하기 카드와 같은 ProjectTile — 직접 설치·AI 표시를 함께 단다
    expect(row).toContain("tile-flag-ai");
    expect(row).toContain("직접 설치");
    expect(row).toContain('href="https://github.com/a"');
    expect(row).toContain("리그 클라이언트 도우미");
    expect(row).toContain("<span>개발 도구</span><span>개인</span>");
    expect(row).toContain("★ 4,900");
    expect(row).toContain("+50");
    expect(row).toContain('aria-label="LCU 저장"');
    expect(html).toContain('<span class="popular-rank"><span aria-hidden="true">2</span><span class="sr-only">2위</span></span>');
    expect(html).toContain("<span>조직</span>");
    expect(html).toContain("1–2위 / 1,234");
    expect(html).not.toContain("aria-busy");
  });

  it("목록 API 에 없는 줄은 빈 자리를 거두고 이름·요약·링크만 남긴다", async () => {
    fills.cards = new Map();
    const html = await render();
    const row = html.match(/<li class="popular-row">([\s\S]*?)<\/li>/)![1];
    expect(row).toContain("LCU");
    expect(row).not.toContain("fill-line");
  });

  it("카드 보기는 발견하기 카드(ProjectCard)에 순위를 단다", async () => {
    const html = await render({ view: "cards" });
    expect(html).not.toContain('class="popular-list"');
    expect(html.match(/class="project-card"/g)).toHaveLength(2);
    expect(html).toContain('<span class="project-rank"><span aria-hidden="true">1</span><span class="sr-only">1위</span></span>');
    fills.cards = fillsFor(page().items);
    const filled = await render({ view: "cards" });
    expect(filled.match(/class="project-card"/g)).toHaveLength(2);
    expect(filled).toContain('<span class="project-rank"><span aria-hidden="true">2</span><span class="sr-only">2위</span></span>');
    expect(filled).toContain("★ 4,900");
  });

  it("첫 쪽은 앞 5줄만 서버 HTML 에 이름·요약으로, 2쪽부터는 줄 없이 빈 틀만 — 뒷줄은 화면 가까이 오면 API 로 받는다(2026-11-15 공개 HTML 이름·요약만)", async () => {
    const rows = Array.from({ length: 7 }, (_, index) => product({ slug: `row-${index + 1}`, name: `Row ${index + 1}` }));
    getPopularPage.mockImplementation(async (_tier: string, _filters: unknown, _sort: string, at: number) => page({ items: rows, page: at }));
    const html = await render({ tier: "rising", ai: "made" });
    const list = html.match(/<ol class="popular-list">([\s\S]*?)<\/ol>/)![1];
    expect(list.match(/<li class="popular-row"/g)).toHaveLength(5);
    expect(list).toContain("Row 5");
    // 뒷줄의 이름·주소는 서버 HTML 에 없다 — 받기 전 자리(aria-hidden)만 같은 <ol> 안에
    expect(html).not.toContain("Row 6");
    expect(html).not.toContain("/p/row-7");
    expect(list).toMatch(/<li aria-hidden="true" aria-busy="true" style="min-height:252px"><\/li>$/);
    // 쪽 안내는 그 쪽 전체(1–7위)를 말한다
    expect(html).toContain("1–7위 / 1,234");

    const cards = await render({ tier: "rising", ai: "made", view: "cards" });
    expect(cards.match(/class="project-card"/g)).toHaveLength(5);
    expect(cards).not.toContain("Row 6");
    expect(cards).toContain('<div aria-hidden="true" aria-busy="true" style="min-height:360px;grid-column:1 / -1"></div>');

    const second = await render({ tier: "rising", ai: "made", page: "2" });
    const frame = second.match(/<ol class="popular-list">([\s\S]*?)<\/ol>/)![1];
    expect(frame).toBe('<li aria-hidden="true" aria-busy="true" style="min-height:882px"></li>');
    expect(second).not.toMatch(/Row \d/);
    expect(second).not.toContain("/p/row-");
    expect(second).toContain("16–22위 / 1,234");
    expect(second).toContain('href="/popular?tier=rising&amp;ai=made&amp;page=3"');
  });

  it("구간 탭은 발견하기 탭 모양에 수를 달고, 지금 거르기를 지킨 채 첫 쪽으로 간다", async () => {
    const html = await render({ tier: "rising", ai: "made", page: "2" });
    const tabs = html.match(/<nav class="tabs popular-tier-tabs"[\s\S]*?<\/nav>/)![0];
    expect([...tabs.matchAll(/>(\d[천만]\+) <span class="tab-count">(.*?)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(["2천+ 1,234", "5천+ 56", "1만+ 7", "3만+ 0"]);
    expect(tabs.match(/aria-current="page"/g)).toHaveLength(1);
    expect(tabs).toContain('href="/popular?tier=noticed&amp;ai=made"');
    expect(html).not.toMatch(/떠오르는|대형/);
    // 수는 화면 JS 가 같은 조건으로 받는다 — 서버 HTML 에는 글자 없는 자리
    expect(new Set(fills.countQueries)).toEqual(new Set(["part=popular&tier=rising&ai=made&page=2"]));
    fills.counts = undefined;
    const pending = await render({ tier: "rising", ai: "made", page: "2" });
    const pendingTabs = pending.match(/<nav class="tabs popular-tier-tabs"[\s\S]*?<\/nav>/)![0];
    expect(pendingTabs.match(/<span class="tab-count"><span class="fill-line"/g)).toHaveLength(4);
    expect(pending).not.toContain("1,234");
  });

  it("거르기 칩은 누르면 나올 수를 달고, 고른 칩은 진하게·다시 누르면 푼다", async () => {
    const html = await render({ ai: "made", category: "data" });
    expect(getPopularPage).toHaveBeenCalledWith("rising", { personal: false, ai: true, category: "Data" }, "stars", 1);
    expect(getPopularFacets).toHaveBeenCalledWith("rising", { personal: false, ai: true, category: "Data" });
    expect(html).toMatch(/<a class="chip chip-dark" aria-current="true" href="\/popular\?tier=rising&amp;category=data">AI로 제작 <span class="chip-count">291<\/span><\/a>/);
    expect(html).toMatch(/<a class="chip" href="\/popular\?tier=rising&amp;personal=1&amp;ai=made&amp;category=data">개인 계정만 <span class="chip-count">120<\/span><\/a>/);
    expect(html).toMatch(/<a class="chip" href="\/popular\?tier=rising&amp;ai=made">전체 <span class="chip-count">366<\/span><\/a>/);
    expect(html).toMatch(/<a class="chip chip-dark" aria-current="true" href="\/popular\?tier=rising&amp;ai=made">데이터 <span class="chip-count">29<\/span><\/a>/);
    expect(html).toContain('href="/popular?tier=rising&amp;ai=made&amp;category=dev"');
    expect(html).toContain("★ 2천–5천 미만 · 데이터 1,234개");
    expect(html).toMatch(/<a class="clear-filters show" href="\/popular\?tier=rising">필터 초기화<\/a>/);
    // 수를 받지 못하면 칩은 수 없이, 제목 수는 줄표
    fills.counts = null;
    const failed = await render({ ai: "made", category: "data" });
    expect(failed).not.toContain('class="chip-count"');
    expect(failed).toContain("★ 2천–5천 미만 · 데이터 —개");
  });

  it("정렬·보기 단추는 지금 상태를 지키고, 거르기가 없으면 초기화 링크가 없다", async () => {
    const html = await render({ sort: "rising" });
    expect(getPopularPage).toHaveBeenCalledWith("rising", { personal: false, ai: false, category: null }, "rising", 1);
    expect(html).toMatch(/<a class="tab active" aria-current="true" href="\/popular\?tier=rising&amp;sort=rising">요즘 많이 는 순<\/a>/);
    expect(html).toContain('href="/popular?tier=rising">스타 많은 순</a>');
    expect(html).toContain('aria-label="카드로 보기"');
    expect(html).toContain('href="/popular?tier=rising&amp;sort=rising&amp;view=cards"');
    expect(html).toContain("하루 평균으로 많이 는 순");
    expect(html).not.toContain("필터 초기화");
  });

  it("맞는 것이 없으면 안내 하나만, 쪽 넘김은 두지 않는다", async () => {
    getPopularPage.mockResolvedValue(page({ items: [], total: 0, totals: [0, 0, 0, 0], page: 1, pages: 1 }));
    const html = await render({ category: "data" });
    expect(html).toContain("이 조건에 맞는 프로젝트가 없습니다.");
    expect(html).not.toContain('class="popular-list"');
    expect(html).not.toContain("페이지 이동");
  });

  it("읽지 못하면 목록 대신 알림", async () => {
    getPopularPage.mockRejectedValue(new Error("db down"));
    const html = await render();
    expect(html).toContain('role="status"');
    expect(html).toContain("목록을 불러오지 못했습니다");
  });
});

describe("스타 구간 이름(UX-35)", () => {
  it("구간 이름은 범위로만 쓴다", () => {
    expect(STAR_TIERS.map((t) => t.label)).toEqual(["2천+", "5천+", "1만+", "3만+"]);
    const UNIT = { 천: 1_000, 만: 10_000 } as const;
    for (const tier of STAR_TIERS) {
      const [, n, unit] = /^(\d+)(천|만)\+$/.exec(tier.label)!;
      expect(Number(n) * UNIT[unit as keyof typeof UNIT], tier.key).toBe(tier.min);
    }
  });

  it("제목은 브랜드 표기 하나로", async () => {
    expect((await generateMetadata({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve({}) }, Promise.resolve({ openGraph: null } as Awaited<ResolvingMetadata>))).title).toBe("많이 쓰이는 프로젝트 — nomorevibe");
  });
});

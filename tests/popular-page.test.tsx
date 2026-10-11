import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PopularFacets, PopularProduct } from "@/lib/domain/products/popular";

const { getPopularPage, getPopularFacets } = vi.hoisted(() => ({ getPopularPage: vi.fn(), getPopularFacets: vi.fn() }));
vi.mock("@/lib/domain/products/popular", () => ({ getPopularPage, getPopularFacets }));

import PopularPage, { metadata } from "@/app/popular/page";
import { STAR_TIERS } from "@/lib/domain/products/stars";

const product = (over: Partial<PopularProduct> = {}): PopularProduct => ({
  slug: "lcu", name: "LCU", tagline: "League client helper", taglineKo: "리그 클라이언트 도우미", taglineSource: "ai_readme", category: "Dev",
  repoUrl: "https://github.com/a/lcu", repoRenamedTo: null, ogImage: "/api/og-cache/lcu", stars: 4_900, ownerType: "User",
  starsAt: "2026-10-08 04:38:13", starsPrevious: 4_850, starsPreviousAt: "2026-10-07 02:00:00",
  accessMode: "installable", aiLevel: 2, makerName: null, ...over,
});
const FACETS: PopularFacets = { categories: [{ category: "Dev", count: 337 }, { category: "Data", count: 29 }], all: 366, ai: 291, personal: 120 };
const page = (over: Record<string, unknown> = {}) => ({
  items: [product(), product({ slug: "b", name: "B", ownerType: "Organization", aiLevel: null, accessMode: "website" })],
  total: 1_234, totals: [1_234, 56, 7, 0], page: 2, pages: 83, pageSize: 15, ...over,
});

async function render(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await PopularPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  getPopularPage.mockReset().mockResolvedValue(page());
  getPopularFacets.mockReset().mockResolvedValue(FACETS);
});

describe("/popular 목록 보기 — 발견하기 부품으로(2026-10-11 시안 보완안)", () => {
  it("줄마다 순위 · 카드 커버 · 이름 · @소유자 · 한국어 소개 · 분야·계정 · ★와 증감 · 저장을 둔다", async () => {
    const html = await render({ tier: "rising", page: "2" });
    const row = html.match(/<li class="popular-row">([\s\S]*?)<\/li>/)![1];
    const order = ["popular-rank", "project-tile", "card-link", "card-owner", "popular-description", "popular-row-meta", "star-metric", "cover-saved"]
      .map((mark) => row.indexOf(mark));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
    // 둘째 쪽이라 16위부터 — 좁은 화면은 커버 위 숫자로 같은 순위를 보인다
    expect(row).toContain('<span class="popular-rank">16<span class="sr-only">위</span></span>');
    expect(row).toContain('<span class="popular-thumb-rank">16</span>');
    // 커버는 발견하기 카드와 같은 ProjectTile — 직접 설치·AI 표시를 함께 단다
    expect(row).toContain("tile-flag-ai");
    expect(row).toContain("직접 설치");
    expect(row).toContain('href="https://github.com/a"');
    expect(row).toContain("리그 클라이언트 도우미");
    expect(row).toContain("<span>개발 도구</span><span>개인</span>");
    expect(row).toContain("★ 4,900");
    expect(row).toContain("+50");
    expect(row).toContain('aria-label="LCU 저장"');
    expect(html).toContain('<span class="popular-rank">17<span class="sr-only">위</span></span>');
    expect(html).toContain("<span>조직</span>");
    expect(html).toContain("16–17위 / 1,234");
  });

  it("카드 보기는 발견하기 카드(ProjectCard)에 순위를 단다", async () => {
    const html = await render({ view: "cards" });
    expect(html).not.toContain('class="popular-list"');
    expect(html.match(/class="project-card"/g)).toHaveLength(2);
    expect(html).toContain('<span class="project-rank">16<span class="sr-only">위</span></span>');
  });

  it("구간 탭은 발견하기 탭 모양에 수를 달고, 지금 거르기를 지킨 채 첫 쪽으로 간다", async () => {
    const html = await render({ tier: "rising", ai: "made", page: "2" });
    const tabs = html.match(/<nav class="tabs popular-tier-tabs"[\s\S]*?<\/nav>/)![0];
    expect([...tabs.matchAll(/>(\d[천만]\+) <span class="tab-count">(.*?)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(["2천+ 1,234", "5천+ 56", "1만+ 7", "3만+ 0"]);
    expect(tabs.match(/aria-current="page"/g)).toHaveLength(1);
    expect(tabs).toContain('href="/popular?tier=noticed&amp;ai=made"');
    expect(html).not.toMatch(/떠오르는|대형/);
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

  it("제목은 브랜드 표기 하나로", () => {
    expect(metadata.title).toBe("많이 쓰이는 프로젝트 — nomorevibe");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PopularProduct } from "@/lib/domain/products/popular";

const { getPopularPage } = vi.hoisted(() => ({ getPopularPage: vi.fn() }));
vi.mock("@/lib/domain/products/popular", () => ({ getPopularPage }));
// 개인 계정 필터는 앱 라우터(useRouter·useSearchParams)가 있어야 그린다 — 이 테스트는 목록 모양만 본다
vi.mock("@/components/home/PopularFilter", () => ({ PopularFilter: () => null }));

import PopularPage, { metadata } from "@/app/popular/page";
import { PopularCards } from "@/app/popular/PopularCards";
import { TierTabs } from "@/app/popular/TierTabs";
import { STAR_TIERS } from "@/lib/domain/products/stars";

const product = (over: Partial<PopularProduct> = {}): PopularProduct => ({
  slug: "lcu", name: "LCU", tagline: "League client helper", taglineKo: null, taglineSource: "ai_readme", category: "Dev",
  repoUrl: "https://github.com/a/lcu", repoRenamedTo: null, ogImage: null, stars: 4_900, ownerType: "User",
  starsAt: "2026-10-08 04:38:13", starsPrevious: 4_850, starsPreviousAt: "2026-10-07 02:00:00", ...over,
});

async function render(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await PopularPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => getPopularPage.mockReset());

describe("/popular 좁은 화면 카드 행(UX-23)", () => {
  it("한 줄에 순위·아이콘·이름·★수·증감, 그 아래 소개를 둔다", () => {
    const html = renderToStaticMarkup(<PopularCards items={[product()]} first={16} />);
    const row = html.match(/<li class="popular-card">([\s\S]*?)<\/li>/)![1];
    // 순서가 곧 한 줄의 배치다(popular.css 의 격자 칸 순서)
    const order = ["popular-card-rank", "rounded-[10px]", "popular-card-name", "star-metric", "popular-card-intro"].map((mark) => row.indexOf(mark));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
    expect(row).toContain('<span class="popular-card-rank">16</span>');
    expect(row).toContain('href="/p/lcu"');
    expect(row).toContain("★ 4,900");
    expect(row).toContain("+50");
    // 소개는 ProductTagline 으로, 좁은 행이라 출처 줄은 끈다
    expect(row).toContain('<p class="popular-description" title="League client helper">League client helper</p>');
    expect(row).not.toContain("AI가 요약");
  });

  it("표와 카드 목록을 함께 내보내고 같은 순위를 쓴다 — 화면 너비가 하나를 고른다", async () => {
    getPopularPage.mockResolvedValue({ items: [product(), product({ slug: "b", name: "B" })], total: 1_234, totals: [1_234, 56, 7, 0], page: 2, pages: 83 });
    const html = await render({ tier: "rising", page: "2" });

    expect(html).toContain('class="popular-table"');
    expect(html).toContain('class="popular-cards"');
    expect(html.match(/<li class="popular-card">/g)).toHaveLength(2);
    expect(html).toContain("<td>16</td>");
    expect(html).toContain('<span class="popular-card-rank">17</span>');
    // 표는 넓으니 소개 출처를 밝힌다
    expect(html).toContain("AI가 요약 · README에서");
  });

  it("비었으면 표·카드 대신 안내 하나만 둔다", async () => {
    getPopularPage.mockResolvedValue({ items: [], total: 0, totals: [3, 0, 0, 0], page: 1, pages: 1 });
    const html = await render({ tier: "large" });

    expect(html).not.toContain('class="popular-table"');
    expect(html).not.toContain('class="popular-cards"');
    expect(html.match(/아직 없음/g)).toHaveLength(1);
  });
});

describe("스타 구간 이름(UX-35)", () => {
  it("구간 이름은 범위로만 쓴다", () => {
    expect(STAR_TIERS.map((t) => t.label)).toEqual(["2천+", "5천+", "1만+", "3만+"]);
    // 이름의 수가 구간의 아래 끝이다
    const UNIT = { 천: 1_000, 만: 10_000 } as const;
    for (const tier of STAR_TIERS) {
      const [, n, unit] = /^(\d+)(천|만)\+$/.exec(tier.label)!;
      expect(Number(n) * UNIT[unit as keyof typeof UNIT], tier.key).toBe(tier.min);
    }
  });

  it("탭·표 제목·탭 수가 새 이름과 쉼표 수로 나온다", async () => {
    getPopularPage.mockResolvedValue({ items: [product()], total: 1_234, totals: [1_234, 56, 7, 0], page: 1, pages: 83 });
    const html = await render();

    const tabs = html.match(/<nav class="popular-tabs"[\s\S]*?<\/nav>/)![0];
    expect([...tabs.matchAll(/<strong>(.*?)<\/strong><b>(.*?)<\/b>/g)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(["2천+ 1,234", "5천+ 56", "1만+ 7", "3만+ 0"]);
    expect(html).not.toMatch(/떠오르는|>인기<|대형/);
    expect(html).toContain("<h2>스타 2천–5천 미만 <span>1,234개</span></h2>");
    // 확인일은 공개 날짜 형식("10월 8일" 또는 해가 다르면 연도까지), 기계용 값은 dateTime 에
    expect(html).toMatch(/<time dateTime="2026-10-08">(2026년 )?10월 8일<\/time>/);
  });

  it("고른 구간 칩만 현재 페이지로 표시한다", () => {
    const html = renderToStaticMarkup(<TierTabs current="popular" personal totals={[1, 2, 3, 4]} />);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page" href="\/popular\?tier=popular&amp;personal=1"><strong>1만\+<\/strong>/);
  });

  it("제목은 브랜드 표기 하나로", () => {
    expect(metadata.title).toBe("많이 쓰이는 프로젝트 — nomorevibe");
  });
});

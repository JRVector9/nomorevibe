import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PopularProduct } from "@/lib/domain/products/popular";

const { getPopularGroups } = vi.hoisted(() => ({ getPopularGroups: vi.fn() }));
vi.mock("@/lib/domain/products/popular", () => ({ getPopularGroups }));
// 개인 계정 거르기는 앱 라우터가 있어야 그린다 — 이 테스트는 구간 카드만 본다
vi.mock("@/components/home/PopularFilter", () => ({ PopularFilter: () => null }));

import { PopularTiers } from "@/components/home/PopularTiers";
import { STAR_TIERS } from "@/lib/domain/products/stars";

const product = (slug: string, over: Partial<PopularProduct> = {}): PopularProduct => ({
  slug, name: `Name ${slug} with a long title that used to be cut`, tagline: "English intro", taglineKo: `${slug} 한국어 소개`, taglineSource: "ai_readme",
  category: "Security", repoUrl: `https://github.com/acme/${slug}`, repoRenamedTo: null, ogImage: `/api/og-cache/${slug}`, stars: 4_993, ownerType: "Organization",
  starsAt: "2026-10-11 01:00:00", starsPrevious: 4_990, starsPreviousAt: "2026-10-10 01:00:00", accessMode: "website", aiLevel: 1, makerName: null, ...over,
});
const groups = STAR_TIERS.map((tier, index) => ({ ...tier, total: [526, 331, 293, 177][index], items: [1, 2, 3].map((n) => product(`${tier.key}-${n}`)) }));

beforeEach(() => {
  getPopularGroups.mockReset().mockResolvedValue(groups);
});

describe("홈 '많이 쓰이는 프로젝트' — 구간 탭 + 발견하기 카드(2026-10-11 시안 안 C)", () => {
  it("구간을 발견하기 탭 모양으로 고르고 수를 붙인다 — 첫 구간이 골라져 있다", async () => {
    const html = renderToStaticMarkup(await PopularTiers({}));
    const tabs = html.match(/<div class="tabs" role="tablist"[\s\S]*?<\/div>/)![0];
    expect([...tabs.matchAll(/role="tab"[^>]*aria-selected="(true|false)"[^>]*>(.*?) <span class="tab-count">(.*?)<\/span>/g)].map((m) => `${m[2]} ${m[3]} ${m[1]}`))
      .toEqual(["2천+ 526 true", "5천+ 331 false", "1만+ 293 false", "3만+ 177 false"]);
    expect(tabs.match(/tabindex="0"/g)).toHaveLength(1);
  });

  it("구간마다 카드 3장을 그려 두고 고른 판만 보인다 — 다른 판은 hidden", async () => {
    const html = renderToStaticMarkup(await PopularTiers({}));
    const panels = [...html.matchAll(/<div role="tabpanel"[^>]*>/g)].map((m) => m[0]);
    expect(panels).toHaveLength(4);
    expect(panels.map((panel) => panel.includes("hidden"))).toEqual([false, true, true, true]);
    expect(html.match(/class="project-card"/g)).toHaveLength(12);
  });

  it("카드는 이름을 자르지 않고 한국어 소개·미리보기 커버·순위·저장을 보인다", async () => {
    const html = renderToStaticMarkup(await PopularTiers({}));
    const card = html.match(/<article class="project-card">([\s\S]*?)<\/article>/)![1];
    expect(card).toContain('<span class="project-rank">1<span class="sr-only">위</span></span>');
    expect(card).toContain("Name rising-1 with a long title that used to be cut");
    expect(card).toContain("rising-1 한국어 소개");
    expect(card).toContain('class="tile-preview"');
    expect(card).toContain("tile-flag-ai");
    expect(card).toContain('aria-label="Name rising-1 with a long title that used to be cut 저장"');
    expect(card).toContain("보안");
  });

  it("'모두 보기'는 고른 구간의 /popular 로 — 개인 계정만이면 그 거르기를 지킨다", async () => {
    expect(renderToStaticMarkup(await PopularTiers({}))).toContain('<a class="row-more" href="/popular?tier=rising">2천+ 526개 모두 보기 ›</a>');
    expect(renderToStaticMarkup(await PopularTiers({ personal: true }))).toContain('href="/popular?tier=rising&amp;personal=1"');
    expect(getPopularGroups).toHaveBeenLastCalledWith(true);
  });

  it("읽지 못하면 구획 안에 알림 하나", async () => {
    getPopularGroups.mockImplementation(async () => { throw new Error("db down"); });
    const html = renderToStaticMarkup(await PopularTiers({}));
    expect(html).toContain("목록을 불러오지 못했습니다");
  });
});

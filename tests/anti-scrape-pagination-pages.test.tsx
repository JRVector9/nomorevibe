import type { ResolvingMetadata } from "next";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { popular, facets, growth } = vi.hoisted(() => ({ popular: vi.fn(), facets: vi.fn(), growth: vi.fn() }));
vi.mock("@/lib/domain/products/popular", () => ({ getPopularPage: popular, getPopularFacets: facets }));
vi.mock("@/lib/domain/products/star-growth", async (original) => ({ ...await original<object>(), getStarGrowthPage: growth }));
import HomePage, { generateMetadata as homeMetadata, HomeScreen } from "@/app/(public)/[locale]/(content)/page";
import CategoryPage, { generateMetadata as categoryMetadata } from "@/app/(public)/[locale]/(content)/c/[category]/page";
import PopularPage, { generateMetadata as popularMetadata } from "@/app/(public)/[locale]/(content)/popular/page";
import RisingPage, { generateMetadata as risingMetadata } from "@/app/(public)/[locale]/(content)/rising/page";

const parent = Promise.resolve({}) as ResolvingMetadata;
beforeEach(() => {
  vi.stubEnv("PUBLIC_LIST_MAX_PAGES", "100");
  popular.mockReset().mockImplementation(async (_tier, _filters, _sort, page) => ({ items: [], total: 2000, totals: [2000, 0, 0, 0], page, pages: 134, pageSize: 15 }));
  facets.mockReset().mockResolvedValue({ categories: [], all: 2000, ai: 0, personal: 0 });
  growth.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("anti-scrape pagination page entry points", () => {
  it("keeps normal popular pages and their next links working at the inclusive boundary", async () => {
    for (const page of ["1", "2", "100"]) {
      const html = renderToStaticMarkup(await PopularPage({ searchParams: Promise.resolve({ page }) }));
      expect(html).not.toContain("목록 탐색 범위를");
      expect(html).toContain(`page=${Number(page) + 1}`);
    }
    expect(popular).toHaveBeenCalledTimes(3);
    expect(popular.mock.calls.map(call => call[3])).toEqual([1, 2, 100]);
  });

  it("renders a helpful notice for every list entry without loading popular/growth data", async () => {
    const screens = [
      HomePage({ searchParams: Promise.resolve({ shown: "901", q: "PDF" }) }),
      HomeScreen({ params: { new: "1", page: "101" } }),
      CategoryPage({ params: Promise.resolve({ category: "dev" }), searchParams: Promise.resolve({ shown: "901" }) }),
      PopularPage({ searchParams: Promise.resolve({ page: "101" }) }),
      RisingPage({ searchParams: Promise.resolve({ page: "101" }) }),
    ];
    const html = await Promise.all(screens.map(async screen => renderToStaticMarkup(await screen)));
    for (const result of html) {
      expect(result).toContain("목록 탐색 범위를 벗어났습니다");
      expect(result).toContain("첫 쪽으로 돌아가기");
    }
    expect(html[0]).toContain('href="/?q=PDF"');
    expect(html[2]).toContain('href="/c/dev?category=Dev"');
    expect(popular).not.toHaveBeenCalled();
    expect(facets).not.toHaveBeenCalled();
    expect(growth).not.toHaveBeenCalled();
  });

  it("keeps canonical and normal robots behavior, adding noindex only to blocked lists", async () => {
    for (const deep of [false, true]) {
      const page = deep ? "101" : "2";
      const shown = deep ? "901" : "18";
      const cases = [
        await homeMetadata({ searchParams: Promise.resolve({ shown }) }, parent),
        await categoryMetadata({ params: Promise.resolve({ category: "dev" }), searchParams: Promise.resolve({ shown }) }, parent),
        await popularMetadata({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve({ page }) }, parent),
        await risingMetadata({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve({ page }) }, parent),
      ];
      expect(cases.map(meta => new URL(String(meta.alternates?.canonical)).pathname)).toEqual([
        "/", "/c/dev", "/popular", "/rising",
      ]);
      for (const meta of cases) expect(meta.robots).toEqual(deep ? { index: false, follow: true } : undefined);
    }
    expect((await homeMetadata({ searchParams: Promise.resolve({ q: "PDF" }) }, parent)).robots).toEqual({ index: false, follow: true });
  });

  it("malformed input renders the notice instead of triggering errors or queries", async () => {
    for (const page of ["-1", "Infinity", "2x", ["1", "101"]]) {
      expect(renderToStaticMarkup(await PopularPage({ searchParams: Promise.resolve({ page }) }))).toContain("목록 탐색 범위");
    }
    expect(popular).not.toHaveBeenCalled();
  });
});

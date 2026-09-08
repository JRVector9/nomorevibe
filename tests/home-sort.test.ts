import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowseFilters, hrefWith, parseHomeSort, parseShown } from "@/components/BrowseFilters";

describe("home sort", () => {
  it("defaults to weekly and keeps the old popular URL compatible", () => {
    expect(parseHomeSort(undefined)).toBe("weekly");
    expect(parseHomeSort("popular")).toBe("weekly");
    expect(parseHomeSort("featured")).toBe("weekly");
  });

  it("accepts the public sorts including products with repository links", () => {
    expect(parseHomeSort("trending")).toBe("trending");
    expect(parseHomeSort("recent")).toBe("recent");
    expect(parseHomeSort("newest")).toBe("recent");
    expect(parseHomeSort("all-time")).toBe("all-time");
    expect(parseHomeSort("open")).toBe("open");
    expect(parseHomeSort("unknown")).toBe("weekly");
  });

  it("preserves category and query while omitting only the weekly sort", () => {
    const html = renderToStaticMarkup(createElement(BrowseFilters, {
      state: { sort: "recent", category: "Dev", query: "ai tool" },
      counts: { Dev: 1 },
      total: 1,
      builders: ["Claude Code"],
      resultCount: 1,
    }));

    expect(html).toContain('href="/?category=Dev&amp;q=ai+tool"');
    expect(html).toContain('href="/?sort=all-time&amp;category=Dev&amp;q=ai+tool"');
    expect(html).toContain('href="/?sort=open&amp;category=Dev&amp;q=ai+tool"');
    expect(html).toContain("추천");
    expect(html).toContain("관심 많은 순");
    expect(html).toContain("저장소 있음");
  });

  it("keeps the expanded list count in the address and drops it when filters change", () => {
    expect(parseShown(undefined)).toBe(6);
    expect(parseShown("18")).toBe(18);
    expect(parseShown("3")).toBe(6);
    expect(parseShown("1000")).toBe(100);
    expect(hrefWith({ sort: "weekly", shown: 18 })).toBe("/?shown=18");
    expect(hrefWith({ sort: "weekly", shown: 18 }, { sort: "recent" })).toBe("/?sort=recent");
    expect(hrefWith({ sort: "recent", shown: 18 }, { shown: 30 })).toBe("/?sort=recent&shown=30");
  });

  it("uses 추천 for the default season sort instead of a weekly cadence label", () => {
    const html = renderToStaticMarkup(createElement(BrowseFilters, {
      state: { sort: "weekly" },
      counts: {},
      total: 0,
      builders: [],
      resultCount: 0,
    }));

    expect(html).toContain("추천");
    expect(html).not.toContain("이번 주");
  });
});

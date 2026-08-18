import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowseFilters, parseHomeSort } from "@/components/BrowseFilters";

describe("home sort", () => {
  it("defaults to weekly and keeps the old popular URL compatible", () => {
    expect(parseHomeSort(undefined)).toBe("weekly");
    expect(parseHomeSort("popular")).toBe("weekly");
  });

  it("accepts only the four public sorts", () => {
    expect(parseHomeSort("trending")).toBe("trending");
    expect(parseHomeSort("recent")).toBe("recent");
    expect(parseHomeSort("all-time")).toBe("all-time");
    expect(parseHomeSort("unknown")).toBe("weekly");
  });

  it("preserves category and query while omitting only the weekly sort", () => {
    const html = renderToStaticMarkup(createElement(BrowseFilters, {
      state: { sort: "recent", category: "Dev", query: "ai tool" },
      counts: { Dev: 1 },
      total: 1,
    }));

    expect(html).toContain('href="/?category=Dev&amp;q=ai+tool"');
    expect(html).toContain('href="/?sort=trending&amp;category=Dev&amp;q=ai+tool"');
  });

  it("uses a cadence-neutral label for the default season sort", () => {
    const html = renderToStaticMarkup(createElement(BrowseFilters, {
      state: { sort: "weekly" },
      counts: {},
      total: 0,
    }));

    expect(html).toContain("이번 시즌");
    expect(html).not.toContain("이번 주");
  });
});

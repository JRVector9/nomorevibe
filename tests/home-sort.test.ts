import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowseFilters, hrefWith, parseHomeSort, parseShown } from "@/components/BrowseFilters";

describe("home sort", () => {
  it("도구 흔적 필터는 정렬·분야·더 보기에서 유지하고 초기화하면 지운다", () => {
    const state = { sort: "recent" as const, observedTool: "Claude Code", shown: 18 };
    expect(hrefWith(state, { shown: 27 })).toBe("/?sort=recent&observedTool=Claude+Code&shown=27");
    expect(hrefWith(state, { category: "Dev" })).toBe("/?sort=recent&category=Dev&observedTool=Claude+Code");
    expect(hrefWith(state, { observedTool: "Codex" })).toBe("/?sort=recent&observedTool=Codex");
    const html = renderToStaticMarkup(createElement(BrowseFilters, { state, counts: {}, total: 12, resultCount: 2 }));
    expect(html).toContain("검색 결과 2개");
    expect(html).toContain('class="clear-filters show" href="/?sort=recent"');
  });
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

  it("preserves category and query with an explicit weekly sort when searching", () => {
    const html = renderToStaticMarkup(createElement(BrowseFilters, {
      state: { sort: "recent", category: "Dev", query: "ai tool" },
      counts: { Dev: 1 },
      total: 1,
      resultCount: 1,
    }));

    expect(html).toContain('href="/?sort=weekly&amp;category=Dev&amp;q=ai+tool"');
    expect(html).toContain('href="/?sort=all-time&amp;category=Dev&amp;q=ai+tool"');
    expect(html).toContain("추천");
    expect(html).toContain("관심 많은 순");
    // '저장소 있음' 탭은 내렸다 — 주소 ?sort=open 은 parseHomeSort 가 계속 받는다
    expect(html).not.toContain("저장소 있음");
  });

  it("keeps the expanded list count in the address and drops it when filters change", () => {
    expect(parseShown(undefined)).toBe(9);
    expect(parseShown("18")).toBe(18);
    expect(parseShown("3")).toBe(9);
    expect(parseShown("1000")).toBe(1000);
    expect(parseShown("108")).toBe(108);
    expect(parseShown("Infinity")).toBe(9);
    expect(parseShown("9007199254740992")).toBe(9);
    expect(hrefWith({ sort: "weekly", shown: 18 })).toBe("/?shown=18");
    expect(hrefWith({ sort: "weekly", query: "directory", shown: 99 }, { shown: 108 })).toBe("/?sort=weekly&q=directory&shown=108");
    expect(hrefWith({ sort: "weekly", shown: 18 }, { sort: "recent" })).toBe("/?sort=recent");
    expect(hrefWith({ sort: "recent", shown: 18 }, { shown: 30 })).toBe("/?sort=recent&shown=30");
  });

  it("순위 탭이 다른 목록을 대신 보여줄 때는 그 목록의 이름을 쓰고, 필터가 걸리면 검색 결과다", () => {
    const html = renderToStaticMarkup(createElement(BrowseFilters, {
      state: { sort: "weekly" }, counts: {}, total: 0, resultCount: 7, listLabel: "스타 증가 순",
    }));
    expect(html).toContain("스타 증가 순 7개");
    expect(html).not.toContain("에디터 추천");

    const narrowed = renderToStaticMarkup(createElement(BrowseFilters, {
      state: { sort: "weekly", category: "Dev" }, counts: { Dev: 1 }, total: 1, resultCount: 1, listLabel: "스타 증가 순",
    }));
    expect(narrowed).toContain("검색 결과 1개");
  });

  it("uses 추천 for the default season sort instead of a weekly cadence label", () => {
    const html = renderToStaticMarkup(createElement(BrowseFilters, {
      state: { sort: "weekly" },
      counts: {},
      total: 0,
      resultCount: 0,
    }));

    expect(html).toContain("추천");
    expect(html).not.toContain("이번 주");
  });
});

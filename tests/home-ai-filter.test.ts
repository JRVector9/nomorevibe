import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowseFilters } from "@/components/BrowseFilters";
import { aiFilterCounts, aiLevelTotals, categoryCountsForAi, hrefWith, resultLine, type AiLevelCount } from "@/components/home/browse-state";

/** 홈 '만든 방식' 필터(2026-10-10 운영자 결정) — 'AI로 제작' 하나가 1·2·3단계를 모두 보인다, 주소 ?ai=made */

const rows: AiLevelCount[] = [
  { category: "Dev", level: 1, count: 200 },
  { category: "Dev", level: 2, count: 1_034 },
  { category: "Dev", level: 3, count: 500 },
  { category: "Finance", level: 2, count: 12 },
  { category: "Finance", level: 3, count: 7 },
];
const counts = { Dev: 9_157, Finance: 285, Design: 40 };

const render = (props: Partial<Parameters<typeof BrowseFilters>[0]> & Pick<Parameters<typeof BrowseFilters>[0], "state">) =>
  renderToStaticMarkup(createElement(BrowseFilters, { counts, aiCounts: rows, total: 9_482, resultCount: 1_246, ...props }));

describe("만든 방식 주소", () => {
  it("ai 를 주소에 쓰고 바꾸면 더 보기(shown)를 처음으로 돌린다", () => {
    const state = { sort: "recent" as const, shown: 27 };
    expect(hrefWith(state, { ai: "made" })).toBe("/?sort=recent&ai=made");
    expect(hrefWith({ sort: "weekly" }, { ai: "made" })).toBe("/?ai=made");
    // 다른 필터·정렬·더 보기에서는 유지한다
    const filtered = { sort: "recent" as const, ai: "made" as const, shown: 18 };
    expect(hrefWith(filtered, { shown: 27 })).toBe("/?sort=recent&ai=made&shown=27");
    expect(hrefWith(filtered, { category: "Dev" })).toBe("/c/dev?sort=recent&ai=made");
    expect(hrefWith(filtered, { sort: "all-time" })).toBe("/?sort=all-time&ai=made");
    expect(hrefWith({ ...filtered, query: "가계부" })).toBe("/?sort=recent&ai=made&q=%EA%B0%80%EA%B3%84%EB%B6%80&shown=18");
    expect(hrefWith(filtered, { ai: undefined })).toBe("/?sort=recent");
  });

  it("결과 줄에 필터 이름을 분야와 함께 쓴다", () => {
    expect(resultLine({ sort: "recent", ai: "made" }, 1_234)).toBe("AI로 제작 1,234개");
    expect(resultLine({ sort: "recent", category: "Dev", ai: "made" }, 1_234)).toBe("개발 도구 · AI로 제작 1,234개");
    expect(resultLine({ sort: "weekly", ai: "made" }, 40, { listLabel: "지금 뜨는" })).toBe("AI로 제작 · 지금 뜨는 40개");
    // 검색 중에는 지금처럼 검색 결과 수
    expect(resultLine({ sort: "recent", ai: "made", query: "가계부" }, 4)).toBe("검색 결과 4개");
  });
});

describe("만든 방식 칩의 수", () => {
  it("AI로 제작은 1·2·3단계를 모두 더하고 분야를 고르면 그 분야만", () => {
    expect(aiFilterCounts(rows)).toEqual({ made: 1_753 });
    expect(aiFilterCounts(rows, "Finance")).toEqual({ made: 19 });
    expect(aiFilterCounts(rows, "Design")).toEqual({ made: 0 });
    expect(aiFilterCounts([])).toEqual({ made: 0 });
  });

  it("만든 방식을 고르면 분야 알약은 단계가 있는 제품의 수", () => {
    expect(categoryCountsForAi(rows, "made")).toEqual({ Dev: 1_734, Finance: 19 });
  });

  it("'데이터와 집계 기준'의 단계별 수", () => {
    expect(aiLevelTotals(rows)).toEqual({ 1: 200, 2: 1_046, 3: 507 });
    expect(aiLevelTotals(null)).toBeNull();
  });
});

describe("만든 방식 칩", () => {
  it("칩 하나를 '만든 방식' 묶음으로 수와 함께 보이고, 누르면 걸고 다시 누르면 푼다", () => {
    const plain = render({ state: { sort: "recent" } });
    expect(plain).toContain('aria-label="만든 방식"');
    expect(plain).toContain('<a class="chip" href="/?sort=recent&amp;ai=made">AI로 제작 <span class="chip-count">1,753</span></a>');
    expect(plain).not.toContain("AI 도구 설정");

    const made = render({ state: { sort: "recent", ai: "made" } });
    expect(made).toContain('<a class="chip chip-dark" aria-current="true" href="/?sort=recent">AI로 제작 <span class="chip-count">1,753</span></a>');
    // 분야 알약은 단계가 있는 제품의 수, 차례와 목록은 전체 수대로(디자인 0개도 남는다)
    expect(made).toContain('href="/c/dev?sort=recent&amp;ai=made">개발 도구 <span class="chip-count">1,734</span>');
    expect(made).toMatch(/href="\/c\/design\?sort=recent&amp;ai=made">[^<]+<span class="chip-count">0<\/span>/);
    expect(made).toContain("AI로 제작 1,246개");
    // 초기화는 만든 방식도 지운다, 공개 전체 수는 걸린 동안 숨긴다
    expect(made).toContain('class="clear-filters show" href="/?sort=recent"');
    expect(made).not.toContain("공개 9,482개");
  });

  it("분야를 고르면 칩의 수는 그 분야 안의 수", () => {
    const html = render({ state: { sort: "recent", category: "Finance" } });
    expect(html).toContain('href="/c/finance?sort=recent&amp;ai=made">AI로 제작 <span class="chip-count">19</span>');
  });

  it("검색어·도구로 좁히면 분야 알약처럼 수를 숨기고, 수를 못 읽었으면 칩만 둔다", () => {
    for (const state of [{ sort: "relevance" as const, query: "가계부" }, { sort: "recent" as const, builder: "Cursor" }]) {
      const html = render({ state });
      expect(html, JSON.stringify(state)).toContain("AI로 제작");
      expect(html, JSON.stringify(state)).not.toContain("chip-count");
    }
    const missing = render({ state: { sort: "recent", ai: "made" }, aiCounts: null });
    expect(missing).toContain("AI로 제작");
    // 단계별 분야 수를 모르면 전체 수를 쓰지 않는다 — 누른 목록과 다른 수가 된다
    expect(missing).not.toContain("chip-count");
  });
});

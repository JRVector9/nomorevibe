import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowseFilters } from "@/components/BrowseFilters";
import { aiFilterCounts, aiLevelTotals, categoryCountsForAi, hrefWith, resultLine, type AiLevelCount } from "@/components/home/browse-state";

/** AI로 제작 탭은 기존 1·2·3단계 근거를 쓴다. 예전 ai 주소는 탭 전환 때 해제한다. */

const rows: AiLevelCount[] = [
  { category: "Dev", level: 1, count: 200 },
  { category: "Dev", level: 2, count: 1_034 },
  { category: "Dev", level: 3, count: 500 },
  { category: "Finance", level: 2, count: 12 },
  { category: "Finance", level: 3, count: 7 },
];
const counts = { Dev: 9_157, Finance: 285, Design: 40 };

const render = (props: Partial<Parameters<typeof BrowseFilters>[0]> & Pick<Parameters<typeof BrowseFilters>[0], "state">) =>
  renderToStaticMarkup(createElement(BrowseFilters, { counts, total: 9_482, resultCount: 1_246, ...props }));

describe("만든 방식 주소", () => {
  it("ai 를 주소에 쓰고 바꾸면 더 보기(shown)를 처음으로 돌린다", () => {
    const state = { sort: "recent" as const, shown: 27 };
    expect(hrefWith(state, { ai: "made" })).toBe("/?sort=recent&ai=made");
    expect(hrefWith({ sort: "ai" }, { ai: "made" })).toBe("/?ai=made");
    // 다른 필터·더 보기에서는 유지하고, 탭 전환은 AI 조건을 해제한다
    const filtered = { sort: "recent" as const, ai: "made" as const, shown: 18 };
    expect(hrefWith(filtered, { shown: 27 })).toBe("/?sort=recent&ai=made&shown=27");
    expect(hrefWith(filtered, { category: "Dev" })).toBe("/c/dev?sort=recent&ai=made");
    expect(hrefWith(filtered, { sort: "all-time" })).toBe("/?sort=all-time");
    expect(hrefWith(filtered, { sort: "ai" })).toBe("/");
    expect(hrefWith({ ...filtered, query: "가계부" })).toBe("/?sort=recent&ai=made&q=%EA%B0%80%EA%B3%84%EB%B6%80&shown=18");
    expect(hrefWith(filtered, { ai: undefined })).toBe("/?sort=recent");
  });

  it("결과 줄에 필터 이름을 분야와 함께 쓴다", () => {
    expect(resultLine({ sort: "recent", ai: "made" }, 1_234)).toBe("AI로 제작 1,234개");
    expect(resultLine({ sort: "recent", category: "Dev", ai: "made" }, 1_234)).toBe("개발 도구 · AI로 제작 1,234개");
    expect(resultLine({ sort: "ai", ai: "made" }, 40, { listLabel: "지금 뜨는" })).toBe("AI로 제작 · 지금 뜨는 40개");
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

describe("만든 방식 탭", () => {
  it("AI로 제작 탭으로 통합하고 기본 자격은 별도 칩이나 초기화로 보이지 않는다", () => {
    const plain = render({ state: { sort: "recent" } });
    expect(plain).not.toContain('class="chips chips-ai"');
    expect(plain).toMatch(/aria-selected="false"[^>]*>AI로 제작<\/a>/);
    expect(plain).not.toContain("AI 도구 설정");

    const made = render({ state: { sort: "ai" }, counts: categoryCountsForAi(rows, "made"), categoryOrderCounts: counts });
    expect(made).toMatch(/aria-selected="true"[^>]*>AI로 제작<\/a>/);
    // 분야 알약은 서버가 전달한 현재 AI 목록의 수, 순서는 공개 전체 수를 쓴다.
    expect(made).toContain('href="/c/dev">개발 도구 <span class="chip-count">1,734</span>');
    expect(made).toContain('<span class="chip" aria-disabled="true">디자인 <span class="chip-count">0</span></span>');
    expect(made).toContain("AI로 제작 1,246개");
    expect(made).not.toContain("필터 초기화");
    expect(made).toContain("공개 9,482개");
  });

  it("분야를 고른 채 세 탭으로 이동하고 AI 제약은 탭 조건으로만 쓴다", () => {
    const html = render({ state: { sort: "ai", category: "Finance" } });
    expect(html).toMatch(/class="tab active"[^>]*href="\/c\/finance">AI로 제작<\/a>/);
    expect(html).toContain('href="/c/finance?sort=recent"');
    expect(html).toContain('href="/c/finance?sort=all-time"');
    expect(html).not.toContain("ai=made");
  });

  it("검색어·도구로 좁히면 분야 수를 숨기고 조회 실패도 0으로 쓰지 않는다", () => {
    for (const state of [{ sort: "relevance" as const, query: "가계부" }, { sort: "recent" as const, builder: "Cursor" }]) {
      const html = render({ state });
      expect(html, JSON.stringify(state)).toContain("AI로 제작");
      expect(html, JSON.stringify(state)).not.toContain("chip-count");
    }
    const missing = render({ state: { sort: "ai" }, countsKnown: false });
    expect(missing).toContain("AI로 제작");
    // 단계별 분야 수를 모르면 전체 수를 쓰지 않는다 — 누른 목록과 다른 수가 된다
    expect(missing).not.toContain("chip-count");
  });
});

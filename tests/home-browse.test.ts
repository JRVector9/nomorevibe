import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowseFilters, chipCategories } from "@/components/BrowseFilters";
import {
  browseTitle,
  categoryHref,
  categoryRedirect,
  categorySlug,
  formatResultCount,
  hrefWith,
  metricHref,
  parseCategory,
  resultLine,
  sortLabel,
} from "@/components/home/browse-state";
import { isPublicSuggestion } from "@/lib/domain/products/search-log";

describe("분야 주소 (UX-40, 계약 C4)", () => {
  it("분야는 대소문자·앞뒤 빈칸을 가리지 않고 읽고, 모르는 값은 null", () => {
    expect(parseCategory("finance")).toBe("Finance");
    expect(parseCategory("Finance")).toBe("Finance");
    expect(parseCategory(" FINANCE ")).toBe("Finance");
    expect(parseCategory("dev")).toBe("Dev");
    expect(parseCategory("fintech")).toBeNull();
    expect(parseCategory("")).toBeNull();
    expect(parseCategory(undefined)).toBeNull();
    expect(categorySlug("Finance")).toBe("finance");
  });

  it("옛 주소 ?category= 는 /c/<소문자> 로 — 나머지 조건은 그대로 따라간다", () => {
    expect(categoryRedirect({ category: "finance" })).toBe("/c/finance");
    expect(categoryRedirect({ category: "Finance", sort: "recent", q: "가계부" })).toBe("/c/finance?sort=recent&q=%EA%B0%80%EA%B3%84%EB%B6%80");
    // 같은 키가 둘이면 분야는 첫 값, 다른 조건은 둘 다 남긴다
    expect(categoryRedirect({ category: ["DEV", "Finance"], builder: ["Codex", "Claude"] })).toBe("/c/dev?builder=Codex&builder=Claude");
    // 모르는 분야도 /c/<값> 으로 — 거기서 '없는 분야입니다'를 보인다
    expect(categoryRedirect({ category: "Fin Tech" })).toBe("/c/fin%20tech");
    expect(categoryRedirect({ sort: "recent" })).toBeNull();
    expect(categoryRedirect({ category: "  " })).toBeNull();
  });

  it("분야가 걸린 주소는 /c/<분야> 아래로 만들고, 분야를 풀면 홈으로 돌아온다", () => {
    expect(hrefWith({ sort: "weekly", category: "Finance" })).toBe("/c/finance");
    expect(hrefWith({ sort: "recent", category: "Dev", query: "ai" }, { shown: 18 })).toBe("/c/dev?sort=recent&q=ai&shown=18");
    expect(hrefWith({ sort: "recent", category: "Dev" }, { category: undefined })).toBe("/?sort=recent");
    expect(categoryHref("Finance")).toBe("/c/finance");
    expect(categoryHref("Dev", { sort: "recent" })).toBe("/c/dev?sort=recent");
    expect(metricHref({ sort: "weekly", category: "Dev" }, "born")).toBe("/c/dev?metric=born");
    expect(metricHref({ sort: "weekly" }, "born")).toBe("/?metric=born");
  });

  it("탭 제목은 검색어·분야로 정한다(UX-39)", () => {
    expect(browseTitle({ query: "가계부" })).toBe("“가계부” 검색 결과 — nomorevibe");
    expect(browseTitle({ category: "Finance" })).toBe("금융 프로젝트 — nomorevibe");
    expect(browseTitle({ query: "가계부", category: "Finance" })).toBe("“가계부” 검색 결과 · 금융 프로젝트 — nomorevibe");
    expect(browseTitle({})).toBe("nomorevibe — AI로 만든 것들, 세상에 나오다.");
  });
});

describe("결과 수 (UX-24·27)", () => {
  it("관련도순 검색 수는 100개부터 '약 n'으로, 그 아래와 정확한 수는 쉼표만", () => {
    expect(formatResultCount(1_779, true)).toBe("약 1,800");
    expect(formatResultCount(1_812, true)).toBe("약 1,800");
    expect(formatResultCount(36_155, true)).toBe("약 36,000");
    expect(formatResultCount(100, true)).toBe("약 100");
    expect(formatResultCount(99, true)).toBe("99");
    expect(formatResultCount(7, true)).toBe("7");
    expect(formatResultCount(1_779)).toBe("1,779");
  });

  it("검색은 '관련 결과 약 n개'(관련도순) 또는 '검색 결과 n개', 필터만 걸리면 필터 이름, 아무것도 없으면 정렬 이름", () => {
    expect(resultLine({ sort: "relevance", query: "calender" }, 1_779, { approximate: true })).toBe("관련 결과 약 1,800개");
    expect(resultLine({ sort: "recent", query: "calender" }, 1_779)).toBe("검색 결과 1,779개");
    expect(resultLine({ sort: "weekly", category: "Dev" }, 9_157)).toBe("개발 도구 9,157개");
    expect(resultLine({ sort: "recent", category: "Dev", observedTool: "Claude Code" }, 1_234)).toBe("개발 도구 · Claude Code 1,234개");
    expect(resultLine({ sort: "weekly" }, 2_126, { listLabel: "지금 뜨는" })).toBe("지금 뜨는 2,126개");
    // 분야 알약(전체 수)과 다른 까닭 — 대신 보여 주는 목록의 이름을 붙인다
    expect(resultLine({ sort: "weekly", category: "Finance" }, 4, { listLabel: "지금 뜨는" })).toBe("금융 · 지금 뜨는 4개");
    expect(resultLine({ sort: "weekly", query: "가계부" }, 4, { listLabel: "지금 뜨는" })).toBe("검색 결과 4개");
    expect(resultLine({ sort: "recent" }, 36_300)).toBe("최신 36,300개");
  });

  it("순위가 서기 전 '추천' 탭은 스타가 는 목록이라 '지금 뜨는'이라 부른다(UX-35)", () => {
    expect(sortLabel("weekly", false)).toBe("지금 뜨는");
    expect(sortLabel("weekly", true)).toBe("추천");
    expect(sortLabel("relevance")).toBe("관련도");
    expect(sortLabel("all-time", false)).toBe("관심 많은 순");
  });
});

describe("분야 알약 (UX-12, 계약 C3)", () => {
  const counts = { Dev: 9_157, Profile: 2_577, Finance: 285, Design: 0 };

  it("개인 프로필은 알약에 없고 나머지는 개수 순 — 고른 분야는 0개여도 남는다", () => {
    expect(chipCategories(counts)).toEqual(["Dev", "Finance"]);
    expect(chipCategories(counts, "Design")).toEqual(["Dev", "Finance", "Design"]);
    expect(chipCategories(counts, "Profile")).toEqual(["Dev", "Finance"]);
  });

  it("검색 중에는 '관련도' 탭이 맨 앞에서 켜지고 분야 수는 숨긴다", () => {
    const html = renderToStaticMarkup(createElement(BrowseFilters, {
      state: { sort: "relevance", query: "가계부" }, counts, total: 11_734, resultCount: 285, approximate: true,
    }));
    expect(html.indexOf("관련도")).toBeLessThan(html.indexOf("추천"));
    expect(html).toMatch(/class="tab active"[^>]*aria-selected="true"[^>]*>관련도</);
    expect(html).not.toContain("chip-count");
    expect(html).not.toContain("개인프로필");
    expect(html).toContain("관련 결과 약 290개");
    // 검색어를 지우면 관련도도 함께 내린다 — 검색어 없는 관련도 순서는 없다
    expect(html).toContain('class="clear-filters show" href="/"');
  });

  it("검색어가 없으면 관련도 탭이 없고 분야 수를 쉼표로 보인다", () => {
    const html = renderToStaticMarkup(createElement(BrowseFilters, {
      state: { sort: "recent" }, counts, total: 11_734, resultCount: 11_734,
    }));
    expect(html).not.toContain("관련도");
    expect(html).toContain('<span class="chip-count">9,157</span>');
    expect(html).toContain("최신 11,734개 · 공개 11,734개");
    expect(html).toContain('href="/c/dev?sort=recent"');
    expect(html).not.toContain("category=");
  });
});

describe("0건 화면의 추천 검색어 (UX-24)", () => {
  it("남이 친 말 중 사람을 가리킬 수 있는 꼴은 공개 화면에 싣지 않는다", () => {
    expect(isPublicSuggestion("가계부")).toBe(true);
    expect(isPublicSuggestion("todo app")).toBe(true);
    expect(isPublicSuggestion("C++ 학습")).toBe(true);
    expect(isPublicSuggestion("2048 game")).toBe(true);
    expect(isPublicSuggestion("me@example.com")).toBe(false);
    expect(isPublicSuggestion("example.com")).toBe(false);
    expect(isPublicSuggestion("https://x.dev")).toBe(false);
    expect(isPublicSuggestion("@CatalogueOwner")).toBe(false);
    expect(isPublicSuggestion("010 1234 5678")).toBe(false);
    expect(isPublicSuggestion("a")).toBe(false);
    expect(isPublicSuggestion("아주 긴 문장으로 친 검색어는 남의 글이다")).toBe(false);
    expect(isPublicSuggestion("<script>")).toBe(false);
  });
});

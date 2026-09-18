import { expect, it } from "vitest";
import { hasSearchQuery, searchQueries } from "@/lib/domain/products/search";
import { normalizeQuery } from "@/lib/domain/products/search-translation";
import { parseQueryTranslation } from "@/lib/crawl/translate";

it("질의문은 다듬고 빈 것은 버린다", () => {
  expect(searchQueries("  회의록 요약  ")).toEqual(["회의록 요약"]);
  expect(searchQueries(["회의록 요약", "  ", "meeting summary"])).toEqual(["회의록 요약", "meeting summary"]);
  expect(searchQueries(undefined)).toEqual([]);
  expect(hasSearchQuery("   ")).toBe(false);
  expect(hasSearchQuery(["", "pdf"])).toBe(true);
  // 200자 넘는 글은 검색어가 아니라 붙여넣기다
  expect(searchQueries("가".repeat(300))[0]).toHaveLength(200);
});

it("같은 뜻인데 공백·대소문자만 다른 말은 같은 열쇠가 된다", () => {
  expect(normalizeQuery("  PDF   합치는  도구 ")).toBe("pdf 합치는 도구");
  expect(normalizeQuery("Merge PDF")).toBe(normalizeQuery("merge  pdf"));
});

it("번역 답에서 낱말만 받는다", () => {
  expect(parseQueryTranslation("merge pdf")).toBe("merge pdf");
  expect(parseQueryTranslation("<think>고민</think>\nmeeting summary\n")).toBe("meeting summary");
  // 문장으로 답하면 낱말 넷까지만 — websearch_to_tsquery 가 전부 AND 로 묶어서다
  expect(parseQueryTranslation('"Remove image background from photos"')).toBe("remove image background from");
  // 한글이 남았거나 비면 쓰지 않는다
  expect(parseQueryTranslation("배경 제거")).toBe(null);
  expect(parseQueryTranslation("")).toBe(null);
  expect(parseQueryTranslation("...")).toBe(null);
});

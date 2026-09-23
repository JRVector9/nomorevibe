import { expect, it } from "vitest";
import { hasSearchQuery, searchQueries } from "@/lib/domain/products/search";
import { normalizeQuery, queryTranslationKey } from "@/lib/domain/products/search-translation";
import { parseQueryTranslation, queryTranslationPhrases, textHash } from "@/lib/crawl/translate";

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
  // 문장으로 답하면 표현마다 낱말 다섯까지만 — 넓힌 검색도 하나만 빠지는 것을 봐준다
  expect(parseQueryTranslation('"Remove the image background from photos"')).toBe("remove the image background from");
  // 한글이 남았거나 비면 쓰지 않는다
  expect(parseQueryTranslation("배경 제거")).toBe(null);
  expect(parseQueryTranslation("")).toBe(null);
  expect(parseQueryTranslation("...")).toBe(null);
});

it("번역은 두 표현까지 받는다 — 흔한 말과 개념을 다 담은 말", () => {
  expect(parseQueryTranslation("daycare management | daycare center management")).toBe("daycare management | daycare center management");
  // 같으면 하나로, 셋이면 둘까지, 둘째 줄의 설명은 읽지 않는다
  expect(parseQueryTranslation("merge pdf | merge pdf")).toBe("merge pdf");
  expect(parseQueryTranslation("a1 b1 | a2 b2 | a3 b3")).toBe("a1 b1 | a2 b2");
  expect(parseQueryTranslation("shopping list | 장보기\nThe user wants a list app.")).toBe("shopping list");
  expect(queryTranslationPhrases("daycare management | daycare center management")).toEqual(["daycare management", "daycare center management"]);
  // 첫 판의 한 줄짜리도 그대로 읽힌다
  expect(queryTranslationPhrases("meeting summary")).toEqual(["meeting summary"]);
});

it("번역 캐시 열쇠에는 지시문 판이 들어 있다 — 옛 지시문으로 옮긴 말을 다시 쓰지 않는다", () => {
  expect(queryTranslationKey("  PDF   합치는 도구")).toBe(queryTranslationKey("pdf 합치는 도구"));
  expect(queryTranslationKey("pdf 합치는 도구")).not.toBe(textHash(normalizeQuery("pdf 합치는 도구")));
});

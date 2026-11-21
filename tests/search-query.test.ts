import { expect, it } from "vitest";
import { hasSearchQuery, searchQueries } from "@/lib/domain/products/search";
import { multilingualQuerySourceLocale, MULTILINGUAL_QUERY_PROMPT_VERSION } from "@/lib/domain/products/search-query-language";
import { multilingualQueryTranslationTarget, normalizeQuery, queryTranslationKey } from "@/lib/domain/products/search-translation";
import { glossaryHints, parseQueryTranslation, queryExpansions, queryTranslationPhrases, textHash, websearchQueryGatewayWire } from "@/lib/crawl/translate";

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

it("한국식 영어 낱말은 질의에 든 것만 뜻을 덧붙인다 — 긴 말이 먼저", () => {
  expect(glossaryHints("헬스장 출석 체크")).toBe("\nIn Korean: '헬스장' means a gym.");
  expect(glossaryHints("노트북 가격 비교")).toContain("'노트북' means a laptop computer");
  expect(glossaryHints("회의록 요약")).toBe("");
});

it("영어로 옮기면 엉뚱한 것이 걸리는 말은 정해 둔 영어로도 찾는다", () => {
  expect(queryExpansions("드라마 추천")).toEqual(["tv series"]);
  expect(queryExpansions("헬스장 출석 체크")).toEqual(["gym"]);
  expect(queryExpansions("회의록 요약")).toEqual([]);
});

it("용어표 낱말이 든 질의만 번역 캐시 열쇠가 바뀐다 — 다른 질의의 번역은 그대로 쓴다", () => {
  expect(queryTranslationKey("회의록 요약")).toBe(textHash(JSON.stringify(["search-keywords-v3", "ko", "en", 2, null, "회의록 요약"])));
  expect(queryTranslationKey("드라마 추천")).toBe(textHash(JSON.stringify(["search-keywords-v3", "ko", "en", 2, 1, "드라마 추천"])));
});

it.each([
  ["Notion 회의록 日本語", "ko"],
  ["PDFを結合するツール", "ja"],
  ["PDF ｽｷｬﾝ", "ja"],
  ["代码 编辑器 GitHub", "zh-Hans"],
  ["程式碼 編輯器 GitHub", "zh-Hant"],
  ["GitHub 筆記", "han"],
  ["音声認識", "han"],
  ["代码 程式碼", "han"],
  ["GitHub PDF", null],
] as const)("detects search language from %s", (query, locale) => {
  expect(multilingualQuerySourceLocale(query)).toBe(locale);
});

it("separates new Chinese keys while retaining the original Chinese key and format", () => {
  const query = "VSCode 代码 编辑器";
  expect(queryTranslationKey(query)).toBe(textHash(JSON.stringify(["search-keywords-v3", "zh-Hans", "en", 1, null, "vscode 代码 编辑器"])));
  expect(multilingualQueryTranslationTarget(query)?.cacheKey).toBe(multilingualQueryTranslationTarget("vscode  代码 编辑器")?.cacheKey);
  expect(multilingualQueryTranslationTarget(query)?.cacheKey).not.toBe(queryTranslationKey(query));
  expect(multilingualQueryTranslationTarget("VSCode 코드 편집기")).toBeNull();
  const wire = JSON.parse(websearchQueryGatewayWire({ query, sourceLocale: "zh-Hans", promptVersion: MULTILINGUAL_QUERY_PROMPT_VERSION }, "fixture"));
  expect(wire.messages[0].content).toContain("Preserve product and technology names");
  expect(wire.messages[1].content).toBe(JSON.stringify({ sourceLocale: "zh-Hans", query }));
  expect(parseQueryTranslation("VSCode C++ editor | VSCode C++ IDE | editor")).toBe("vscode c++ editor | vscode c++ ide");
});

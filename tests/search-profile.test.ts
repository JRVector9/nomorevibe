import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanKeywords, keywordText, parseKeywords, profileEvidence, writeKeywords } from "@/lib/domain/products/search-profile";
import { canRetryProfileGeneration } from "@/lib/domain/products/search-profile-retry";

const product = {
  name: "Coche", url: "https://coche.test", category: "Productivity", tagline: "Shopping list", description: "Shopping list",
  searchTopics: null, searchPageText: null, searchReadme: "A local-first shopping list that syncs across devices. ".repeat(10),
};

describe("키워드 다듬기", () => {
  it("겹치는 것·제품 이름·너무 긴 것을 빼고 여덟 개까지", () => {
    const values = ["shopping list", "Shopping List", "Coche", "x", "a".repeat(61),
      ...Array.from({ length: 10 }, (_, i) => `keyword ${i}`)];
    const kept = cleanKeywords(values, "Coche");
    expect(kept[0]).toBe("shopping list");
    expect(kept).not.toContain("Coche");
    expect(kept).toHaveLength(8);
  });

  it("배열이 아니거나 글이 아닌 것은 버린다", () => {
    expect(cleanKeywords("shopping", "x")).toEqual([]);
    expect(cleanKeywords([1, null, "  grocery   list "], "x")).toEqual(["grocery list"]);
  });
});

describe("답 읽기", () => {
  it("영어·한국어 키워드를 받는다", () => {
    expect(parseKeywords('{"keywords_en":["shopping list"],"keywords_ko":["장보기 목록"]}', "Coche"))
      .toEqual({ ok: true, en: ["shopping list"], ko: ["장보기 목록"] });
  });

  it("키 이름이 달라도 한글이 든 배열을 한국어로 본다 — 게이트웨이가 키를 강제하지 않는다", () => {
    expect(parseKeywords('{"ko":["장보기"],"english":["grocery list"]}', "Coche"))
      .toEqual({ ok: true, en: ["grocery list"], ko: ["장보기"] });
  });

  it("한국어 칸에 영어 칸과 같은 말이 있으면 한 번만 둔다", () => {
    expect(parseKeywords('{"keywords_en":["AI CRM","sales pipeline"],"keywords_ko":["영업 관리","ai crm","MCP 앱"]}', "Coche"))
      .toEqual({ ok: true, en: ["AI CRM", "sales pipeline"], ko: ["영업 관리", "MCP 앱"] });
  });

  it("JSON 이 아니면 실패다", () => {
    expect(parseKeywords("잘 모르겠습니다", "Coche")).toEqual({ ok: false, error: "invalid_output" });
  });

  it.each(['{}', '{"keywords_en":[]}', '{"keywords_en":"oops","keywords_ko":[]}',
    '{"keywords_en":[null],"keywords_ko":[]}', '{"first":[],"second":[],"third":[]}'])
    ("언어 배열이 없거나 잘못된 응답은 성공으로 저장하지 않는다: %s", (content) => {
      expect(parseKeywords(content, "Coche")).toEqual({ ok: false, error: "invalid_output" });
    });

  it("명시적으로 빈 두 언어 배열은 유효하다", () => {
    expect(parseKeywords('{"keywords_en":[],"keywords_ko":[]}', "Coche"))
      .toEqual({ ok: true, en: [], ko: [] });
  });

  it("색인 글은 영어와 한국어를 한 줄로, 없으면 null", () => {
    expect(keywordText(["grocery list"], ["장보기"])).toBe("grocery list · 장보기");
    expect(keywordText([], [])).toBeNull();
  });
});

describe("증거", () => {
  it("본문·README 가 거의 없으면 얇다고 적는다 — 모델이 이름·소개에 있는 말로만 좁힌다", () => {
    expect(profileEvidence({ ...product, searchReadme: null }, null).evidenceLevel).toBe("thin");
    expect(profileEvidence(product, null).evidenceLevel).toBe("rich");
  });

  it("설명이 소개와 같으면 한 번만 준다", () => {
    expect(profileEvidence(product, null)).not.toHaveProperty("description");
    expect(profileEvidence({ ...product, description: "Groceries for families" }, null).description).toBe("Groceries for families");
  });
});

describe("gateway transport and output failures", () => {
  beforeEach(() => vi.stubEnv("ABCLLM_API_KEY", "fixture-key"));
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    '<html>upstream proxy response</html>',
    'null',
    '{"choices":[]}',
    '{"choices":{"0":{"message":{"content":"{\\\"keywords_en\\\":[],\\\"keywords_ko\\\":[]}"}}}}',
    '{"choices":[{"message":null}]}',
    '{"choices":[{"message":{"content":{"keywords_en":[],"keywords_ko":[]}}}]}',
  ])("keeps a malformed HTTP 200 response under the quality attempt cap: %s", async body => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
    const result = await writeKeywords(profileEvidence(product, null), { timeoutMs: 1_000, request });
    expect(result).toEqual({ ok: false, error: "invalid_output" });
    if (!result.ok) expect(canRetryProfileGeneration(result.error, 5)).toBe(false);
  });

  it("keeps an actual fetch network exception retryable", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const result = await writeKeywords(profileEvidence(product, null), { timeoutMs: 1_000, request });
    expect(result).toEqual({ ok: false, error: "network" });
    if (!result.ok) expect(canRetryProfileGeneration(result.error, 5)).toBe(true);
  });

  it("keeps a broken response body stream as a transport failure", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new TypeError("terminated")); } });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
    expect(await writeKeywords(profileEvidence(product, null), { timeoutMs: 1_000, request }))
      .toEqual({ ok: false, error: "network" });
  });

  it("still accepts a valid HTTP 200 keyword envelope", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: {
      content: '{"keywords_en":["shopping list"],"keywords_ko":["장보기 목록"]}',
    } }] }));
    expect(await writeKeywords(profileEvidence(product, null), { timeoutMs: 1_000, request }))
      .toEqual({ ok: true, en: ["shopping list"], ko: ["장보기 목록"] });
  });
});

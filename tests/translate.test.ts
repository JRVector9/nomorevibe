import { afterEach, describe, expect, it, vi } from "vitest";
import { needsKorean, parseTranslations, reasonTranslationGatewayWire, textHash, translateToKorean } from "@/lib/crawl/translate";

// These legacy transport units do not open a database; actual disabled SQL is covered separately.
vi.mock("@/lib/llm/capacity-repository", () => ({
  readModelCapacityCallerControl: async () => ({ mode: "disabled", epoch: 1, revision: 1, policyHash: null, policy: null }),
}));

const EN = "The URL serves a documentation site for a Ruby gem installed via `gem install archunit` (product.pageText).";

describe("needsKorean — 옮길 글인가", () => {
  it("영어는 옮기고, 한국어는 두고, 한국어 제목을 인용한 영어는 옮긴다", () => {
    expect(needsKorean(EN)).toBe(true);
    expect(needsKorean("제품이 아니라 문서·소개 페이지다")).toBe(false);
    expect(needsKorean("The page title is '오구오구' but the page only shows a login form for staff members.")).toBe(true);
    expect(needsKorean("   ")).toBe(false);
  });
});

describe("textHash — 원문 그대로의 해시", () => {
  it("같은 글은 같고, 한 글자·공백 하나만 달라도 다르다", () => {
    expect(textHash(EN)).toBe(textHash(`${EN}`));
    expect(textHash(EN)).not.toBe(textHash(EN.replace("Ruby", "ruby")));
    expect(textHash(EN)).not.toBe(textHash(`${EN} `));
    expect(textHash(EN)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseTranslations — 받은 번역을 그대로 믿지 않는다", () => {
  it("개수가 맞으면 받고, 생각 태그는 걷어낸다", () => {
    expect(parseTranslations('<think>…</think>["문서 사이트다","로그인 벽이다"]', [EN, EN])).toEqual({ ok: true, translations: ["문서 사이트다", "로그인 벽이다"] });
  });

  it("개수가 다르거나 JSON 이 아니면 전부 실패다", () => {
    expect(parseTranslations('["하나만"]', [EN, EN])).toEqual({ ok: false, error: "invalid_output" });
    expect(parseTranslations("번역할 수 없습니다", [EN])).toEqual({ ok: false, error: "invalid_output" });
  });

  it("영어를 되돌려주거나 빈 항목은 그 항목만 실패로 둔다 — 나머지는 저장한다", () => {
    expect(parseTranslations(JSON.stringify([EN, "", "문서 사이트다"]), [EN, EN, EN])).toEqual({ ok: true, translations: [null, null, "문서 사이트다"] });
  });

  it("원문이 짧은 기호·코드뿐이면 한글이 없어도 받는다", () => {
    expect(parseTranslations('["`gem install x`"]', ["`gem install x`"])).toEqual({ ok: true, translations: ["`gem install x`"] });
  });
});

describe("translateToKorean — 옛 게이트웨이 경로", () => {
  afterEach(() => vi.unstubAllEnvs());

  // 게이트웨이(abcLLM)는 2026-10-30 제거됐다 — 키가 있든 없든, 어떤 응답을 줄 fetch 를 넘겨도 보내지 않고 no_key 로 끝낸다.
  it.each([undefined, "test-key"])("키(%j)와 상관없이 부르지 않는다", async key => {
    vi.stubEnv("ABCLLM_API_KEY", key);
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    for (const request of [
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '["문서 사이트다"]' } }] }))),
      vi.fn(async () => new Response("", { status: 429 })), vi.fn(async () => new Response("", { status: 403 })),
      vi.fn(async () => { throw timeout; }),
    ]) {
      expect(await translateToKorean([EN], 1_000, request as typeof fetch)).toEqual({ ok: false, error: "no_key" });
      expect(request).not.toHaveBeenCalled();
    }
  });

  // 2026-11-02(PR B): 등록부 기본값(M1 Gemma)은 없어졌다 — 모델은 「작업 ↔ 모델」 순위가 고르고, wire 는 받은 이름을 그대로 싣는다
  it("엔진 직접 경로가 보낼 글은 스트리밍을 끄고 순위가 고른 모델을 그대로 담으며 키를 싣지 않는다", () => {
    vi.stubEnv("ABCLLM_API_KEY", "test-key");
    const model = "mlx-community--gemma-4-26b-a4b-it-4bit";
    const wire = reasonTranslationGatewayWire([EN], model), body = JSON.parse(wire);
    expect(body).toMatchObject({ model, stream: false });
    expect(JSON.parse(body.messages[1].content)).toEqual([EN]);
    expect(wire).not.toContain("test-key");
  });
});

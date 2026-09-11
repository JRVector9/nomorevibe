import { afterEach, describe, expect, it, vi } from "vitest";
import { needsKorean, parseTranslations, textHash, translateToKorean } from "@/lib/crawl/translate";

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

describe("translateToKorean — 게이트웨이 호출", () => {
  const original = process.env.ABCLLM_API_KEY;
  afterEach(() => { if (original === undefined) delete process.env.ABCLLM_API_KEY; else process.env.ABCLLM_API_KEY = original; });

  it("키가 없으면 부르지 않는다", async () => {
    delete process.env.ABCLLM_API_KEY;
    const request = vi.fn();
    expect(await translateToKorean([EN], 1_000, request)).toEqual({ ok: false, error: "no_key" });
    expect(request).not.toHaveBeenCalled();
  });

  it("스트리밍을 끄고 gpt-oss-120b 로 부르며 키를 헤더로만 보낸다", async () => {
    process.env.ABCLLM_API_KEY = "test-key";
    const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '["문서 사이트다"]' } }] })));
    expect(await translateToKorean([EN], 1_000, request as typeof fetch)).toEqual({ ok: true, translations: ["문서 사이트다"] });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toBe("https://abcllm-api.brut.bot/v1/chat/completions");
    expect(body).toMatchObject({ model: "[MLX] gpt-oss-120b", stream: false });
    expect(JSON.parse(body.messages[1].content)).toEqual([EN]);
    expect(String(init.body)).not.toContain("test-key");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  it("막히거나 늦으면 사유를 남긴다", async () => {
    process.env.ABCLLM_API_KEY = "test-key";
    expect(await translateToKorean([EN], 1_000, (async () => new Response("", { status: 429 })) as typeof fetch)).toEqual({ ok: false, error: "rate_limit" });
    expect(await translateToKorean([EN], 1_000, (async () => new Response("", { status: 403 })) as typeof fetch)).toEqual({ ok: false, error: "http_403" });
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect(await translateToKorean([EN], 1_000, (async () => { throw timeout; }) as typeof fetch)).toEqual({ ok: false, error: "timeout" });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { compactTranslationNoise, diagnoseTranslationOutput, needsKorean, parseTranslations, reasonTranslationGatewayWire, textHash,
  translateToKorean } from "@/lib/crawl/translate";

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

// 2026-11-11: 운영 invalid_output 62건(하루)의 원문은 ASCII 큰따옴표가 중앙값 8개였다 — 이스케이프하지 않은 인용 따옴표로 깨진 JSON 을 조심스럽게 다시 읽는다
describe("parseTranslations — 깨진 JSON 배열의 조심스러운 다시 읽기", () => {
  const QUOTED = 'The page title is "Acme Docs" and the README says "run npm install" before anything else works.';
  it("원문 하나: [\" 와 \"] 사이 전부를 그 번역으로 받고, 표준 이스케이프만 푼다", () => {
    expect(parseTranslations('["페이지 제목은 "Acme Docs"이고 README는 "run npm install"을 먼저 하라고 한다"]', [QUOTED]))
      .toEqual({ ok: true, translations: ['페이지 제목은 "Acme Docs"이고 README는 "run npm install"을 먼저 하라고 한다'] });
    expect(parseTranslations('<think>x</think>\n```json\n["제목은 "A" \\u0041\\n다음 줄\\\\끝"]\n```', [QUOTED]))
      .toEqual({ ok: true, translations: ['제목은 "A" A\n다음 줄\\끝'] });
    // JSON 이 허락하지 않는 날 줄바꿈도 그 원문의 글이다
    expect(parseTranslations('["첫 줄\n둘째 줄 "인용""]', [QUOTED])).toEqual({ ok: true, translations: ['첫 줄\n둘째 줄 "인용"'] });
    // 원문 하나에는 섞일 다른 원문이 없다 — 안의 ", " 도 한 번역의 글이다
    expect(parseTranslations('["키워드 "foo", "bar"를 쓴다"]', [QUOTED])).toEqual({ ok: true, translations: ['키워드 "foo", "bar"를 쓴다'] });
  });
  it("원문 여럿: 이스케이프되지 않은 \", \" 경계가 정확히 (원문 수 − 1)개일 때만 나눈다", () => {
    expect(parseTranslations('["제목은 "Acme"이다", "README는 "run"을 말한다"]', [QUOTED, QUOTED]))
      .toEqual({ ok: true, translations: ['제목은 "Acme"이다', 'README는 "run"을 말한다'] });
    expect(parseTranslations('[\n  "제목은 "A"이다",\n  "둘째 "B" 사유"\n]', [QUOTED, QUOTED]))
      .toEqual({ ok: true, translations: ['제목은 "A"이다', '둘째 "B" 사유'] });
    // 이스케이프된 따옴표(\")는 경계가 아니다
    expect(parseTranslations('["첫째 \\", \\" 사유 "x"", "둘째"]', [QUOTED, "short"]))
      .toEqual({ ok: true, translations: ['첫째 ", " 사유 "x"', "둘째"] });
  });
  it("경계가 모자라거나 남으면(어느 따옴표가 경계인지 모름) 예전처럼 전부 실패다", () => {
    expect(parseTranslations('["키워드 "foo", "bar"를 쓴다", "둘째 "x" 사유"]', [QUOTED, QUOTED])).toEqual({ ok: false, error: "invalid_output" });
    expect(parseTranslations('["하나로 "합친" 번역"]', [QUOTED, QUOTED])).toEqual({ ok: false, error: "invalid_output" });
    expect(parseTranslations('["a "b"", "c "d"", "e"]', [QUOTED, QUOTED])).toEqual({ ok: false, error: "invalid_output" });
  });
  it("다시 읽어도 검사는 같다 — 한글 없는 영어 항목은 그 항목만 null, 잘린 답·배열 아닌 답은 실패", () => {
    expect(parseTranslations('["The page title is "Acme" and nothing else is translated here.", "둘째 "x" 사유"]', [QUOTED, QUOTED]))
      .toEqual({ ok: true, translations: [null, '둘째 "x" 사유'] });
    expect(parseTranslations('["  ", "둘째 "x""]', [QUOTED, QUOTED])).toEqual({ ok: true, translations: [null, '둘째 "x"'] });
    // 마지막 따옴표가 이스케이프됐다 — 끝나지 않은(잘린) 문자열이다
    expect(parseTranslations('["잘린 "번역\\"]', [QUOTED])).toEqual({ ok: false, error: "invalid_output" });
    expect(parseTranslations('["잘린 "번역', [QUOTED])).toEqual({ ok: false, error: "invalid_output" });
    expect(parseTranslations('[{"text": "객체 "x""}]', [QUOTED])).toEqual({ ok: false, error: "invalid_output" });
    expect(parseTranslations('["a", 1 "b"]', [QUOTED, QUOTED])).toEqual({ ok: false, error: "invalid_output" });
  });
});

describe("diagnoseTranslationOutput — invalid_output 의 까닭(운영 로그)", () => {
  it("JSON 오류 위치는 content 기준이고, 앞 200자·위치 앞뒤를 남긴다", () => {
    const content = `<think>생각</think>${'["a "b"", "c "d"", "e"]'}`;
    const diagnostic = diagnoseTranslationOutput(content, 2);
    expect(diagnostic).toMatchObject({ cause: "json_error", length: content.length, sources: 2, items: null, head: content });
    expect(diagnostic.errorPosition).toBe(content.indexOf('b"'));
    expect(diagnostic.error).toMatch(/position \d+/);
    expect(diagnostic.around).toContain('"a "b"');
    expect(diagnoseTranslationOutput("x".repeat(500), 1)).toMatchObject({ cause: "no_array", length: 500, head: "x".repeat(200), errorPosition: null });
    expect(diagnoseTranslationOutput('["하나만"]', 2)).toMatchObject({ cause: "count_mismatch", items: 1 });
    expect(diagnoseTranslationOutput('x [1, 2] y', 1)).toMatchObject({ cause: "count_mismatch", items: 2 });
  });
});

describe("reason translation prompt — 따옴표 규칙", () => {
  it("인용은 “ ” · 「」 로, 큰따옴표는 이스케이프하라는 줄을 더하고 원래 규칙은 그대로 둔다", () => {
    const system = (JSON.parse(reasonTranslationGatewayWire(["Source"], "m")) as { messages: { content: string }[] }).messages[0].content;
    expect(system).toContain("따옴표 안에 인용된 원문은 번역하지 않고 그대로 둔다");
    expect(system).toContain("입력과 같은 개수의 문자열로 된 JSON 배열 하나만 출력한다.");
    expect(system).toContain("“ ” 또는 「」");
    expect(system).toContain('\\" 로 이스케이프');
  });
});

describe("compactTranslationNoise — 옮길 필요 없는 덩어리는 줄여 보낸다", () => {
  // 운영 2026-11-10: 페이지의 base64 를 옮겨 적은 2,000자 사유가 매번 45초를 넘겨 결과 미확정 23건을 남겼다
  const base64 = "z///f//36em/nN479tWRZrXn0YjVx7K4Mh1m9cyiECTBnACJsChkCXbHVrCVeW8NEgLPogVjKXC9ckGcxK5KKPJ5b+i7t7fF33y3t6dn396hG4QFGH8CFBUXRQ";
  it("base64 꼴 덩어리와 같은 글자 반복은 「…」로 줄이고 앞뒤 글은 둔다", () => {
    expect(compactTranslationNoise(`The page text is unreadable binary data ('${base64}').`)).toBe("The page text is unreadable binary data ('…').");
    expect(compactTranslationNoise(`tail ${"q".repeat(300)} end`)).toBe("tail … end");
  });
  it("파일 경로·저장소 이름처럼 긴 낱말 덩어리는 건드리지 않는다", () => {
    const path = "The repo ships agents/claude-code/skills/backend/govkit-adr-author/SKILL.md and MesozoicLabs/VelociraptorMongoliensis-Anatomical-v0.";
    expect(compactTranslationNoise(path)).toBe(path);
    expect(compactTranslationNoise("sha256 " + "a1b2c3d4".repeat(8))).toBe("sha256 " + "a1b2c3d4".repeat(8));
  });
  it("사유 번역 요청은 줄인 글을 보내고 출력 상한도 줄인 글로 잰다 — 원문 해시는 그대로다", () => {
    const original = `Unreadable ('${base64.repeat(15)}')`;
    const wire = JSON.parse(reasonTranslationGatewayWire([original], "m1-gemma"));
    expect(JSON.parse(wire.messages[1].content)).toEqual(["Unreadable ('…')"]);
    expect(wire.max_tokens).toBe(400 + Math.ceil("Unreadable ('…')".length * 1.2));
    expect(textHash(original)).not.toBe(textHash("Unreadable ('…')"));
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

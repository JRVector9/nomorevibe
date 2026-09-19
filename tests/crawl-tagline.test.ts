import { describe, it, expect, vi } from "vitest";
import { parseTagline, taglineEvidence, taglineHash, tidyTagline, writeTagline, type TaglineEvidence } from "@/lib/crawl/tagline";

const evidence = (over: Partial<TaglineEvidence> = {}): TaglineEvidence => ({
  name: "Sho't Right", url: "https://shotright.test", topics: [], language: "TypeScript",
  pageTitle: "Sho't Right", pageText: "바를 등록하면 손님이 찾을 수 있습니다. ".repeat(10), readme: "", ...over,
});

const reply = (content: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }) as unknown as Response;

describe("한 줄 소개 다듬기", () => {
  it("마침표를 떼고 공백을 하나로 줄인다", () => {
    expect(tidyTagline("  바를 등록하면   손님이 찾습니다.  ")).toBe("바를 등록하면 손님이 찾습니다");
  });

  it("100자를 넘으면 끊을 자리(쉼표)에서 끊는다 — 모델은 길이 규칙을 지키지 않는다", () => {
    const line = tidyTagline("Track your vinyl collection and wishlist, searching by artist or genre and adding records via the music player");
    expect(line).toBe("Track your vinyl collection and wishlist");
  });

  it("끊을 자리가 없으면 문장을 그대로 둔다 — 뜻이 중간에 끊긴 글보다 낫다", () => {
    const long = `${"list your venue so people can find it ".repeat(3)}today`;
    expect(long.length).toBeGreaterThan(100);
    expect(tidyTagline(long)).toBe(long);
  });

  it("칸에 넣지 못할 만큼 길면 마지막 수단으로 낱말 경계에서 자른다", () => {
    const source = `${"list your venue so people can find it ".repeat(8)}end`;
    const line = tidyTagline(source);
    expect(line.length).toBeLessThanOrEqual(200);
    // 낱말 한가운데가 아니다 — 자른 자리 다음 글자가 공백이다
    expect(source[line.length]).toBe(" ");
  });

  it("띄어쓰기가 없는 글도 끊을 자리가 있으면 거기서 끊는다", () => {
    expect(tidyTagline(`${"가".repeat(99)}, ${"나".repeat(10)}`)).toBe("가".repeat(99));
  });
});

describe("답 읽기", () => {
  it("키 이름이 달라도 첫 문자열을 쓴다 — 게이트웨이가 스키마를 강제하지 않는다", () => {
    const result = parseTagline('{"product_description":"바를 등록하면 손님이 찾습니다.","source":"page"}', evidence());
    expect(result).toEqual({ ok: true, tagline: "바를 등록하면 손님이 찾습니다", source: "page" });
  });

  it("생각을 걷어내고 JSON 만 읽는다", () => {
    const result = parseTagline('<think>고민</think>\n{"tagline":"한 줄","source":"page"}', evidence());
    expect(result).toMatchObject({ ok: true, tagline: "한 줄" });
  });

  it("README 를 주지 않았는데 README 에서 왔다고 하면 페이지로 고친다", () => {
    expect(parseTagline('{"tagline":"한 줄","source":"readme"}', evidence({ readme: "" })))
      .toMatchObject({ source: "page" });
  });

  it("페이지 글이 거의 없으면 근거는 README 다", () => {
    expect(parseTagline('{"tagline":"한 줄","source":"page"}', evidence({ pageText: "짧다", readme: "긴 README" })))
      .toMatchObject({ source: "readme" });
  });

  it("증거로 알 수 없다는 답(빈 줄)은 그대로 받는다 — 그 후보는 사람이 본다", () => {
    expect(parseTagline('{"tagline":"","source":"page"}', evidence())).toEqual({ ok: true, tagline: "", source: "page" });
  });

  it("JSON 이 아니면 실패다", () => {
    expect(parseTagline("죄송합니다, 만들 수 없습니다", evidence())).toEqual({ ok: false, error: "invalid_output" });
  });
});

describe("증거 뽑기", () => {
  const document = {
    productUrl: "https://my-app.test",
    repoMeta: { language: "TypeScript", topics: ["cli", "ai"] },
    pageMeta: { title: "My App", textSample: "x".repeat(5_000), readmeSample: "y".repeat(1_000) },
  };

  it("페이지 글 2,000자·README 600자까지만 본다", () => {
    const facts = taglineEvidence("someone/my-app", document);
    expect(facts).toMatchObject({ name: "My App", language: "TypeScript", topics: ["cli", "ai"] });
    expect(facts.pageText).toHaveLength(2_000);
    expect(facts.readme).toHaveLength(600);
  });

  it("제목이 없으면 레포 이름을 이름으로 쓴다", () => {
    expect(taglineEvidence("someone/my-app", { ...document, pageMeta: {} })).toMatchObject({ name: "my-app", pageTitle: null });
  });

  it("원본이 바뀌면 해시가 달라진다 — 지은 줄을 다시 짓는 기준이다", () => {
    const first = taglineHash(taglineEvidence("someone/my-app", document));
    const changed = { ...document, pageMeta: { ...document.pageMeta, textSample: "다른 글" } };
    expect(taglineHash(taglineEvidence("someone/my-app", changed))).not.toBe(first);
  });
});

describe("게이트웨이 호출", () => {
  it("스트리밍을 끄고 증거를 요약하지 않게 보낸다", async () => {
    vi.stubEnv("ABCLLM_API_KEY", "test-key");
    const request = vi.fn().mockResolvedValue(reply('{"tagline":"바를 등록하면 손님이 찾습니다","source":"page"}'));

    const result = await writeTagline(evidence(), { timeoutMs: 1_000, request });

    expect(result).toMatchObject({ ok: true, tagline: "바를 등록하면 손님이 찾습니다" });
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body).toMatchObject({ stream: false, temperature: 0, context_strategy: "raw" });
    // 증거 안의 꺾쇠는 구분자를 끝내지 못한다
    expect(body.messages[1].content).not.toContain("</untrusted_evidence_json>\n<");
    vi.unstubAllEnvs();
  });

  it("없는 모델과 막힌 호출을 이름으로 가른다", async () => {
    vi.stubEnv("ABCLLM_API_KEY", "test-key");
    const gone = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    expect(await writeTagline(evidence(), { timeoutMs: 1_000, request: gone })).toEqual({ ok: false, error: "model_unavailable" });
    vi.unstubAllEnvs();
  });

  it("키가 없으면 부르지 않는다", async () => {
    vi.stubEnv("ABCLLM_API_KEY", "");
    const request = vi.fn();
    expect(await writeTagline(evidence(), { timeoutMs: 1_000, request })).toEqual({ ok: false, error: "no_key" });
    expect(request).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

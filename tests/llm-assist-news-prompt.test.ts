import { describe, expect, it } from "vitest";
import { ASSIST_SCHEMA_VERSION, validateAssistOutcome } from "@/lib/domain/llm-assist/contracts";
import { assistPromptHash, buildAssistMessages } from "@/lib/domain/llm-assist/prompts";
import { buildNewsLocalizationInput } from "@/lib/news/localization-contract";

const input = buildNewsLocalizationInput({ id: 1, url: "https://example.com/news", title: "OpenAI preview",
  summary: "OpenAI released a preview.", revision: "2026-10-25 01:02:03.123456",
  observedAt: "2026-10-25 01:02:03.123456", state: "approved" });
const outcome = { schema_version: ASSIST_SCHEMA_VERSION, task: "news", evidence_quality: { status: "sufficient", limitations: ["none"] },
  evidence: [{ source_id: input.sources[0].sourceId, quote: "OpenAI released a preview.", supports: ["/state/names/0/original"] }],
  state: { names: [{ original: "OpenAI", korean: "오픈AI" }], prices: [], quantities: [], dates: [],
    release: { stage: "preview", availability: "available", scope: [] }, qualifications: [],
    draft: { title: "OpenAI 프리뷰", summary: "OpenAI가 프리뷰를 공개했다." } },
  action: { proposal: "publish_translation_candidate", reason_ko: "원문의 이름과 공개 범위를 보존한 번역 후보입니다.", missing_items: [] } };

describe("뉴스 고유명사와 원문 인용 안내", () => {
  it("모든 고유명사의 원문을 제목 또는 요약에 남기도록 실제 메시지에서 안내한다", () => {
    const instructions = buildAssistMessages(input)[1].content.split("\n\n출력 계약:")[0];
    expect(instructions).toContain("news-name-quote-2026-10-25.1");
    expect(instructions).toMatch(/names\.original[^.]*고유명사만/u);
    expect(instructions).toMatch(/모든 original[^.]*draft\.title[^.]*draft\.summary[^.]*원문 그대로/u);
    expect(instructions).toMatch(/OpenAI[^.]*오픈AI만[^.]*대체하지/u);
  });

  it("실제 sourceId와 단일 source.text의 연속 인용을 복사하도록 안내하고 원문도 그대로 전달한다", () => {
    const content = buildAssistMessages(input)[1].content, instructions = content.split("\n\n출력 계약:")[0];
    expect(instructions).toMatch(/evidence\.source_id[^.]*sourceId[^.]*그대로 복사/u);
    expect(instructions).toMatch(/단일 source\.text[^.]*연속된 부분문자열[^.]*그대로 복사/u);
    expect(instructions).toMatch(/source_id[^.]*만들[^.]*번역[^.]*말줄임표[^.]*이어 붙이지/u);
    expect(JSON.parse(content.split("\n\n[비신뢰 근거]\n")[1])).toEqual(input.sources);
  });

  it("원문 OpenAI 보존은 통과하고 한국어 표기로만 바꾸면 기존 guard가 거절한다", () => {
    expect(validateAssistOutcome(input, outcome).ok).toBe(true);
    expect(validateAssistOutcome(input, { ...outcome, state: { ...outcome.state,
      draft: { title: "오픈AI 프리뷰", summary: "오픈AI가 프리뷰를 공개했다." } } }))
      .toEqual({ ok: false, error: "original_name_missing" });
  });

  it.each([
    { source_id: "invented-source", quote: "OpenAI released a preview." },
    { source_id: input.sources[0].sourceId, quote: "오픈AI가 프리뷰를 공개했다." },
    { source_id: input.sources[0].sourceId, quote: "OpenAI…preview" },
    { source_id: input.sources[0].sourceId, quote: "released OpenAI" },
  ])("새 안내가 기존의 잘못된 source 또는 인용 거절을 바꾸지 않는다: $quote", changed => {
    expect(validateAssistOutcome(input, { ...outcome, evidence: [{ ...outcome.evidence[0], ...changed }] }))
      .toEqual({ ok: false, error: "invalid_evidence_quote" });
  });

  it("뉴스 외 네 업무의 실제 prompt hash는 변경하지 않는다", () => {
    expect(Object.fromEntries((["uptime", "repo", "intro", "audit"] as const).map(task => [task, assistPromptHash(task)]))).toEqual({
      uptime: "a9345c8892920d3d2af39bf576ce840559b7e5450f7a7c703b0e4ece78a7f83d",
      repo: "1be5ab4e2f55729041d7b6c4422b2a9280104b80d259592291556590eab1aad3",
      intro: "08bd33b4291f8533099181bb90c3412c23003da22a4acb3a75adc80d14d3e037",
      audit: "0c4c546176d67b28e6169b22d98b1bb4b7b9edf54fa7b4969b9574394f3878e3",
    });
  });
});

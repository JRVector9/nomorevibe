import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
import { FIRST_REVIEW_RANK_STAGE, rankOptions, rankReadiness, validateRanks } from "@/lib/operations/admin-first-review-ranks";
import { RankSelects } from "@/app/(operator)/admin/models/RankSelects";

const slotNames = [{ provider: "primaryProvider0", model: "primaryModel0" }, { provider: "firstAdditionalProvider0", model: "firstAdditionalModel0" },
  { provider: "firstAdditionalProvider1", model: "firstAdditionalModel1" }];
// 세 서버가 엔진 API 로 내놓는 모델(readServedContractModels 결과 모양). gpu3090 의 qwen 은 이미 1차 검수 계약이 있다
const served = [
  { routeId: "crawl-agent-review", storedModel: "qwen3.8-flash-next", servedIds: ["qwen3.8-flash-next"], reason: null, host: "10.0.0.3:8000", equipment: "gpu3090" },
  { routeId: "second-review", storedModel: "gpt-oss-120b", servedIds: ["gpt-oss-120b"], reason: null, host: "10.0.0.5:8080", equipment: "M3" },
  { routeId: "reason-translate", storedModel: "gemma-4-26b", servedIds: ["gemma-4-26b", "gemma-4-26b-alt"], reason: null, host: "10.0.0.7:8080", equipment: null },
  { routeId: "product-translate", storedModel: "down", servedIds: null, reason: "timeout", host: "10.0.0.9:8080", equipment: "M1" },
];
const contracts = [{ routeId: "crawl-agent-review", model: "qwen3.8-flash-next", contract: { provider: "abcllm" }, transport: "direct" }];
const options = rankOptions(FIRST_REVIEW_RANK_STAGE, { served, contracts, registry: DEFAULT_MODEL_DEFINITIONS,
  current: [{ provider: "abcllm", model: "qwen3.8-flash-next" }, { provider: "abcllm", model: "retired-model" }] });

describe("1차 AI 검수 순위 선택지(엔진 API 실측 + CLI)", () => {
  it("모든 서버가 내놓는 모델을 「장비 · 모델」로, CLI 모델(grok-cli 포함)과 함께 보인다", () => {
    const labels = options.map(row => `${row.provider}|${row.label}`);
    expect(labels).toEqual(expect.arrayContaining(["abcllm|gpu3090 · qwen3.8-flash-next", "local-direct|M3 · gpt-oss-120b",
      "local-direct|10.0.0.7:8080 · gemma-4-26b", "local-direct|10.0.0.7:8080 · gemma-4-26b-alt", "grok-cli|grok-cli · grok-4.7",
      "claude-cli|claude-cli · sonnet", "abcllm|저장된 값 · retired-model (저장된 값 · 지금 목록에 없음)"]));
    // 응답하지 못한 서버는 지어내지 않는다. codex-cli 는 1차 심사자로 받지 않는다
    expect(options.some(row => row.server.includes("M1"))).toBe(false);
    expect(options.some(row => (row.provider as string) === "codex-cli")).toBe(false);
  });
});

describe("순위 검증", () => {
  const a = { provider: "abcllm" as const, model: "qwen3.8-flash-next" }, g = { provider: "grok-cli" as const, model: "grok-4.7" };
  it("빈 칸 뒤 순위·받지 않는 제공자를 거절하고 반복 모델은 허용한다", () => {
    expect(validateRanks(FIRST_REVIEW_RANK_STAGE, [a, null, g])).toEqual(["2순위를 비우고 그 뒤 순위만 고를 수 없습니다. 2순위부터 차례로 골라주세요."]);
    expect(validateRanks(FIRST_REVIEW_RANK_STAGE, [a, g, a])).toEqual([]);
    expect(validateRanks(FIRST_REVIEW_RANK_STAGE, [a, { provider: "codex-cli" as never, model: "spark" }, null]))
      .toEqual(["2순위: 1차 AI 검수에서 쓸 수 없는 제공자입니다(codex-cli)."]);
    expect(validateRanks(FIRST_REVIEW_RANK_STAGE, [a, g, null])).toEqual([]);
    expect(validateRanks(FIRST_REVIEW_RANK_STAGE, [null, null, null])).toEqual([]);
  });
  it("준비 확인: 연결 계약·용량 경로·장비 한도 중 없는 것을 순위마다 알린다", () => {
    const capacity = { mode: "open", routes: [{ routeId: "crawl-agent-review", provider: "abcllm", model: a.model, groupId: "gpu3090-qwen" },
      { routeId: "crawl-agent-review", provider: "grok-cli", model: g.model, groupId: "grok" }], devices: new Map([["gpu3090-qwen", true], ["grok", false]]), groupLimits: {} };
    expect(rankReadiness(FIRST_REVIEW_RANK_STAGE, [a, g, null], { contracts, capacity })).toEqual(["2순위 grok-cli · grok-4.7: 장비 grok가 꺼져 있습니다. 장비 화면에서 켜야 이 순위가 쓰입니다."]);
    expect(rankReadiness(FIRST_REVIEW_RANK_STAGE, [a, g, null], { contracts, capacity: { ...capacity, routes: capacity.routes.slice(0, 1) } }))
      .toEqual([expect.stringContaining("2순위 grok-cli · grok-4.7: 용량 정책에 crawl-agent-review / grok-cli / grok-4.7 경로가 없습니다")]);
    expect(rankReadiness(FIRST_REVIEW_RANK_STAGE, [{ provider: "local-direct", model: "gpt-oss-120b" }, null, null], { contracts, capacity: { ...capacity, mode: "disabled" } }))
      .toEqual([expect.stringContaining("1차 AI 검수(crawl-agent-review) 연결 계약이 없습니다")]);
  });
});

describe("RankSelects 구성 요소", () => {
  const render = (value: Parameters<typeof RankSelects>[0]["value"]) => renderToStaticMarkup(createElement(RankSelects,
    { stage: FIRST_REVIEW_RANK_STAGE, options, value, slotNames, onChange: () => {} }));
  it("1·2·3순위 드롭다운에 「없음」과 모든 선택지를 두고, 고른 값은 저장 칸 이름으로 보낸다", () => {
    const html = render([{ provider: "abcllm", model: "qwen3.8-flash-next" }, { provider: "grok-cli", model: "grok-4.7" }, null]);
    for (const rank of [1, 2, 3]) expect(html).toContain(`aria-label="1차 AI 검수 ${rank}순위"`);
    expect(html.match(/<option value=""( selected="")?>없음<\/option>/g)).toHaveLength(3);
    expect(html).toContain("gpu3090 · qwen3.8-flash-next (abcllm)");
    expect(html).toContain('name="primaryProvider0" value="abcllm"');
    expect(html).toContain('name="firstAdditionalModel0" value="grok-4.7"');
    expect(html).not.toContain('name="firstAdditionalModel1"');
    // 다른 칸에서 고른 모델은 이 칸에서 고를 수 없다 — 3순위 칸에서 grok 과 qwen 선택지는 막혀 있다
    expect((html.match(/<option value="grok-cli\/grok-4.7" disabled="">/g) ?? []).length).toBe(2);
    expect(html).not.toContain('role="alert"');
  });
  it("앞 순위를 비운 선택을 한국어 오류로 보인다", () => {
    const html = render([{ provider: "abcllm", model: "qwen3.8-flash-next" }, null, { provider: "grok-cli", model: "grok-4.7" }]);
    expect(html).toContain('role="alert"');
    expect(html).toContain("2순위를 비우고 그 뒤 순위만 고를 수 없습니다.");
  });
});

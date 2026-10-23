import { describe, expect, it } from "vitest";
import { localModelResponseFacts, readLocalModelTerminal, requestReservedLocalModel } from "@/lib/llm/local-model-terminal";
import type { LocalModelDispatch } from "@/lib/llm/local-model-capacity-contract";
import type { LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";

const contract = { responseModel: "exact", totalTokenBound: 100 };
const body = (extra: object = {}) => JSON.stringify({ model: "exact", choices: [{ finish_reason: "stop", message: { content: "not valid business JSON" } }], ...extra });
describe("직접 서버 종료 근거", () => {
  it("업무 JSON 형식과 원격 생성 종료를 분리하고 미확인 비용을 0으로 만들지 않는다", () => {
    expect(localModelResponseFacts(body(), contract)).toEqual({ finishReason: "stop", actualUsage: null, provenance: "unknown" });
    expect(localModelResponseFacts(body({ usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }), contract))
      .toMatchObject({ actualUsage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 }, provenance: "upstream_reported" });
  });
  it("다른 모델·불완전 종료·C 초과·손상 봉투는 원격 종료 증인이 아니다", () => {
    expect(localModelResponseFacts(body({ model: "different" }), contract)).toBeNull();
    expect(localModelResponseFacts(body({ choices: [{ finish_reason: null }] }), contract)).toBeNull();
    expect(localModelResponseFacts(body({ usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 } }), contract)).toBeNull();
    expect(localModelResponseFacts("{", contract)).toBeNull();
  });
  it("직렬화한 모양은 terminal도 실제 dispatch capability도 아니다", async () => {
    expect(readLocalModelTerminal({ kind: "local_model_terminal" })).toBeNull();
    await expect(requestReservedLocalModel({} as LocalModelDispatch, {} as LocalModelServingContract, "http://invalid", {})).rejects.toThrow();
  });
});

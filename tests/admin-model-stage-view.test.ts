import { describe, expect, it, vi } from "vitest";
import { AI_TEXT_TASK_IDS } from "@/lib/llm/ai-tasks";
import { DEFAULT_MODEL_DEFINITIONS, modelForPurpose, modelRequestName } from "@/lib/llm/model-registry";
import { adminModelStageView } from "@/lib/operations/admin-model-stage-view";
import type { ModelEnv } from "@/lib/operations/pipeline-control";

const env = (pooled: ModelEnv["pooled"]): ModelEnv => ({ translate: "retired-scalar", productTranslate: "retired-scalar", tagline: "retired-scalar",
  profile: "retired-scalar", verify: "retired-scalar", introCheck: "sonnet", pooled });

describe("models-page stage defaults and assignments", () => {
  it("renders ranked text models even when a legacy registry purpose is ambiguous", () => {
    const registry = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: [
      { ...DEFAULT_MODEL_DEFINITIONS[0], purposes: ["crawl-tagline"] },
      { ...DEFAULT_MODEL_DEFINITIONS[1], purposes: ["crawl-tagline"] },
    ] }) };
    expect(() => modelForPurpose("crawl-tagline", registry)).toThrow("model_purpose_not_unique:crawl-tagline");
    const legacyDefault = vi.fn(stage => modelRequestName(modelForPurpose(stage.purpose, registry)));
    const view = adminModelStageView({ models: env({ "crawl-tagline": ["ranked-name", "ranked-fallback"] }),
      pools: { "crawl-tagline": ["retired:pool"] }, bindings: { "crawl-tagline": [
        { identity: "ranked-name", provider: "local-direct" }, { identity: "ranked-fallback", provider: "abcllm" },
      ] }, legacyDefault });
    expect(view.defaults["crawl-tagline"]).toBe("ranked-name");
    expect(view.assignments.find(stage => stage.id === "crawl-tagline")?.models).toEqual([
      { provider: "local-direct", model: "ranked-name" }, { provider: "abcllm", model: "ranked-fallback" },
    ]);
    expect(legacyDefault.mock.calls.every(([stage]) => !(AI_TEXT_TASK_IDS as readonly string[]).includes(stage.id))).toBe(true);
  });

  it("keeps empty and unread ranks distinct, without falling back to retired pools or scalar env values", () => {
    const view = adminModelStageView({ models: env({ "crawl-tagline": [] }), pools: { "crawl-tagline": ["retired:pool"] },
      bindings: {}, legacyDefault: () => "registry-default" });
    expect(view.defaults["crawl-tagline"]).toBe("실행 가능한 순위 없음");
    expect(view.defaults["reason-translate"]).toBe("확인 못함");
    for (const id of AI_TEXT_TASK_IDS) expect(view.assignments.find(stage => stage.id === id)?.models).toEqual([]);
  });

  it("does not guess the provider when a pooled identity cannot be matched to its task binding", () => {
    const view = adminModelStageView({ models: env({ "crawl-tagline": ["known-name"] }), pools: {}, bindings: { "crawl-tagline": null },
      legacyDefault: () => null });
    expect(view.defaults["crawl-tagline"]).toBe("known-name");
    expect(view.assignments.find(stage => stage.id === "crawl-tagline")?.models).toEqual([]);
  });

  it("isolates missing legacy reference defaults while preserving explicitly saved legacy pools", () => {
    const view = adminModelStageView({ models: env({}), pools: { "audit-review": ["gpu3090:review"] }, bindings: {},
      legacyDefault: stage => { if (stage.id === "screen-review") return "미설정"; throw new Error("model_purpose_not_unique"); } });
    expect(view.defaults["direct-review"]).toBe("확인 못함");
    expect(view.assignments.find(stage => stage.id === "direct-review")?.models).toEqual([]);
    expect(view.assignments.find(stage => stage.id === "screen-review")?.models).toEqual([]);
    expect(view.assignments.find(stage => stage.id === "audit-review")?.models).toEqual([{ provider: "local-direct", model: "gpu3090:review" }]);
  });
});

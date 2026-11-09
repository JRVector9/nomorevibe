import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RankSelects } from "@/app/(operator)/admin/models/RankSelects";
import { aiTaskReasoningEfforts } from "@/lib/llm/ai-task-reasoning";
import { aiTask } from "@/lib/llm/ai-tasks";
import { AI_RANK_SLOT_NAMES, aiRankSavedOptions, aiTaskRankOptions, aiTaskRanksInputFromForm, validateAiTaskRanks,
  type AiConnectionView } from "@/lib/operations/admin-ai-tasks";
import { rankForm } from "@/lib/operations/flow-rank-editor";

const id = "11111111-1111-4111-8111-111111111111", model = "opencode/deepseek-v4.1-flash";
const connection: AiConnectionView = { id, label: "OpenCode", kind: "cli", cliTool: "opencode", cliModels: [model], cliVersion: "1.19.5", cliCatalog: { cliVersion: "1.19.5", observedAt: "2026-11-05T00:00:00Z", models: [{ id: model, label: model, variants: ["low", "high", "max"], maxModelLen: 1048576 }] },
  baseUrl: null, host: null, hasKey: false, models: null, modelsReadAt: null, modelsError: null, deviceId: "opencode-cli", capacitySlots: 1,
  contextTokens: null, enabled: true, version: 1, note: null, updatedBy: "test", updatedAt: "2026-11-05T00:00:00Z" };

describe("CLI rank reasoning", () => {
  it("offers only registered CLI models and catalog-confirmed variants on review and text tasks", () => {
    const options = aiTaskRankOptions(aiTask("first-review")!, [connection], []);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ model, reasoningEfforts: ["low", "high", "max"] });
    expect(aiTaskRankOptions(aiTask("crawl-tagline")!, [connection], [])).toEqual(options);
    expect(aiTaskRankOptions(aiTask("product-embedding")!, [connection], [])).toEqual([]);
    expect(aiTaskReasoningEfforts("first-review", "opencode", "opencode/deepseek-v4-pro")).toEqual([]);
    expect(aiTaskReasoningEfforts("first-review", "opencode", "catalog/model", ["high", "max"])).toEqual(["high", "max"]);
    expect(aiTaskRankOptions(aiTask("first-review")!, [{ ...connection, cliCatalog: null }], [])).toEqual([]);
    expect(aiTaskReasoningEfforts("first-review", "opencode", "unverified/model")).toEqual([]);
    // 소개 검수 Claude CLI 는 단계 풀 key 의 저장 강도를 --effort 로 넘긴다(2026-11-09) — 순위 저장은 여전히 막혀 있다
    expect(aiTaskReasoningEfforts("product-intro-check", "claude", "opus")).toEqual(["low", "medium", "high"]);
    expect(aiTaskReasoningEfforts("product-intro-check", "claude", "haiku")).toEqual([]);
    for (const [grokModel, efforts] of [
      ["grok-4.7", ["low", "medium", "high", "xhigh"]], ["grok-4.6", ["low", "medium", "high", "xhigh"]],
      ["grok-4.5", ["low", "medium", "high"]], ["unverified-grok", []],
    ] as const) expect(aiTaskReasoningEfforts("first-review", "grok", grokModel)).toEqual(efforts);
  });
  it("round trips the shared drawer form and rejects unsupported effort values", () => {
    const form = rankForm({ task: "first-review", slot: 1, revision: "a".repeat(64) }, [{ provider: id, model, reasoningEffort: "high" }]);
    const parsed = aiTaskRanksInputFromForm(form);
    expect(parsed.issues).toEqual([]);
    expect(parsed.input?.ranks[0]).toEqual({ provider: id, model, reasoningEffort: "high" });
    expect(validateAiTaskRanks("first-review", 1, parsed.input!.ranks, { connections: [connection], rows: [] })).toEqual([]);
    expect(validateAiTaskRanks("first-review", 1, [{ provider: id, model, reasoningEffort: "medium" }], { connections: [connection], rows: [] }))
      .toEqual([expect.stringContaining("실행할 수 없습니다")]);
  });
  it("preserves unrelated stored options, clears explicit default and keeps legacy omitted values", () => {
    const old = { custom: { keep: true }, reasoningEffort: "high" };
    expect(aiRankSavedOptions({ provider: id, model, reasoningEffort: "max" }, old)).toEqual({ custom: { keep: true }, reasoningEffort: "max" });
    expect(aiRankSavedOptions({ provider: id, model, reasoningEffort: "" }, old)).toEqual({ custom: { keep: true } });
    expect(aiRankSavedOptions({ provider: id, model }, old)).toEqual(old);
    expect(old.reasoningEffort).toBe("high");
  });
  it("renders the same effort control in shared rank selects without unsupported medium", () => {
    const html = renderToStaticMarkup(createElement(RankSelects, { stage: { id: "first-review", label: "AI 1차", slots: 3 },
      options: aiTaskRankOptions(aiTask("first-review")!, [connection], []), value: [{ provider: id, model, reasoningEffort: "high" }],
      slotNames: AI_RANK_SLOT_NAMES, onChange: () => {}, validate: () => [], note: null }));
    expect(html).toContain('aria-label="AI 1차 1순위 추론 강도"');
    expect(html).toContain('name="rank1ReasoningEffort" value="high"');
    expect(html).toContain('<option value="high" selected="">high</option>');
    expect(html).not.toContain('<option value="medium">');
  });
  it("can clear a stale unsupported saved effort instead of trapping the operator", () => {
    const html = renderToStaticMarkup(createElement(RankSelects, { stage: { id: "text", label: "소개", slots: 1 },
      options: [{ provider: id, model: "api-model", label: "API", reasoningEfforts: [] }], value: [{ provider: id, model: "api-model", reasoningEffort: "old-value" }],
      slotNames: AI_RANK_SLOT_NAMES, onChange: () => {}, validate: () => [], note: null }));
    expect(html).toContain('<option value="">설정 해제</option>');
    expect(html).toContain('<option value="old-value" disabled="" selected="">');
    expect(html).toMatch(/aria-label="소개 1순위 추론 강도" class=/);
  });

});

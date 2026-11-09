import { afterEach, describe, expect, it } from "vitest";
import { setAiTaskModelsForTest, type AiTaskModelSnapshotRow } from "@/lib/llm/ai-task-models-snapshot";
import { setReviewRanksForTest } from "@/lib/crawl/review-task-ranks";
import { RECHECK_TASK_LABEL, recheckReviewerPlan, recheckReviewerPlanText } from "@/lib/crawl/published-recheck";
import { cliRankRow } from "./fake-cli-path";

/**
 * 공개분 변경 재판정의 모델 설정(2026-11-09 운영자 결정) — 「작업 ↔ 모델」의 발행분 감사 · 변경 재판정(product-audit) 1·2·3순위. 1차 순위와 나뉜다.
 * 감사 경로의 장부 binding(product_audit_cli)이 받는 OpenCode(원격 호스트)·Claude 만 부른다.
 */
const KEY = "k".repeat(40);
const opencode = (rank: number, model: string, over: Partial<AiTaskModelSnapshotRow["connection"]> = {}, options: Record<string, unknown> = {}): AiTaskModelSnapshotRow => {
  const row = cliRankRow("product-audit", model, { rank, cliTool: "opencode", label: "M3 OpenCode", connectionId: "0a0b0c0d-0000-4000-8000-000000000001" });
  return Object.freeze({ ...row, options: Object.freeze(options), connection: Object.freeze({ ...row.connection, baseUrl: "http://m3.test:4096/v1", apiKey: KEY, ...over }) });
};
const claude = (rank: number, model: string, enabled = true) => cliRankRow("product-audit", model, { rank, cliTool: "claude", label: "Claude CLI", enabled,
  connectionId: "0a0b0c0d-0000-4000-8000-000000000002" });

afterEach(() => { setAiTaskModelsForTest(null); setReviewRanksForTest(null); });

describe("재판정 심사자 — 발행분 감사 · 변경 재판정 순위", () => {
  it("1·2·3순위 차례로 OpenCode·Claude 를 내고, 1차 순위는 읽지 않는다", () => {
    setReviewRanksForTest({ first: [{ provider: "grok-cli", model: "grok-4.7" }] });
    setAiTaskModelsForTest([opencode(1, "opencode-go/deepseek-v4.1-flash", {}, { reasoningEffort: "high" }), claude(2, "sonnet"),
      cliRankRow("first-review", "sonnet", { cliTool: "claude" })]);
    const plan = recheckReviewerPlan();
    expect(plan.status).toBe("ok");
    expect(plan.reviewers).toEqual([
      { rank: 1, provider: "opencode-cli", model: "opencode-go/deepseek-v4.1-flash", connectionId: "0a0b0c0d-0000-4000-8000-000000000001",
        connectionLabel: "M3 OpenCode", reasoningEffort: "high" },
      { rank: 2, provider: "claude-cli", model: "sonnet", connectionId: "0a0b0c0d-0000-4000-8000-000000000002", connectionLabel: "Claude CLI" },
    ]);
    expect(plan.skipped).toEqual([]);
    expect(recheckReviewerPlanText(plan)).toBeNull();
  });

  it("꺼진 순위·꺼진 연결·받지 않는 CLI·열 수 없는 호스트는 까닭과 함께 건너뛴다", () => {
    setAiTaskModelsForTest([claude(1, "opus", false), opencode(2, "m-off", { enabled: false }), cliRankRow("product-audit", "grok-4.7", { rank: 3, cliTool: "grok" }),
      opencode(3, "m-nokey", { apiKey: null })]);
    const plan = recheckReviewerPlan();
    expect(plan.reviewers).toEqual([]);
    expect(plan.skipped.map((row) => [row.rank, row.model, row.reason])).toEqual([
      [1, "opus", "순위 꺼짐"], [2, "m-off", "연결 꺼짐"], [3, "grok-4.7", "감사 경로는 OpenCode·Claude CLI 연결만 받습니다"],
      [3, "m-nokey", "연결의 호스트 주소·키를 열 수 없거나 추론 강도가 맞지 않습니다"]]);
    expect(recheckReviewerPlanText(plan)).toBe(`「${RECHECK_TASK_LABEL}」 순위를 모두 부를 수 없습니다 — 묻지 않고 올리기만 합니다`);
  });

  it("순위가 없으면 부르지 않고 그 까닭을 말한다 — 1차 순위로 대신 부르지 않는다", () => {
    setReviewRanksForTest({ first: [{ provider: "claude-cli", model: "sonnet" }] });
    setAiTaskModelsForTest([cliRankRow("first-review", "sonnet", { cliTool: "claude" })]);
    const plan = recheckReviewerPlan();
    expect(plan).toMatchObject({ status: "no_task_models", reviewers: [] });
    expect(RECHECK_TASK_LABEL).toBe("발행분 감사 · 변경 재판정");
    expect(recheckReviewerPlanText(plan)).toBe("「발행분 감사 · 변경 재판정」 순위 없음 — 작업 ↔ 모델에서 1순위를 저장할 때까지 묻지 않고 올리기만 합니다");
  });
});

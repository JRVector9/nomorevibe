import { afterEach, describe, expect, it } from "vitest";
import { setAiTaskModelsForTest, type AiTaskModelSnapshotRow } from "@/lib/llm/ai-task-models-snapshot";
import { recheckDirectEndpoint, recheckReviewerPlan, recheckReviewerRefusal } from "@/lib/crawl/published-recheck";

/**
 * 2026-11-12 검수 F4(gpt-6.1-sol 재현): 변경 재판정(product-audit)이 연결의 「쓸 수 있는 작업」(allowedTasks)을 보지 않았다 — 순위를 저장한 뒤
 * 연결을 좁혀도 계획이 그 순위를 넣고, 이미 잡은 API 심사자도 주소를 계속 받았다. 공통 글·심사 묶기(aiConnectionTaskAllowed)와 같은 규칙이어야 한다.
 * 합성 고정값만 쓴다(키·주소는 가짜).
 */
const row = (rank: number, allowedTasks: readonly string[]): AiTaskModelSnapshotRow => ({
  task: "product-audit", slot: 1, rank, model: `recheck-model-${rank}`, enabled: true, options: {},
  connection: {
    id: `00000000-0000-4000-8000-00000000000${rank}`, label: `recheck-connection-${rank}`,
    kind: "api", baseUrl: `http://recheck-${rank}.test/v1`, cliTool: null,
    deviceId: `recheck-device-${rank}`, enabled: true, models: null, contextTokens: null,
    apiKey: null, keyUnreadable: false, allowedTasks,
  },
});

afterEach(() => setAiTaskModelsForTest(null));

describe("product-audit recheck respects a connection's allowedTasks", () => {
  it("skips a restricted first rank (with its reason) and offers the allowed second rank", () => {
    setAiTaskModelsForTest([row(1, ["reason-translate"]), row(2, ["product-audit"])]);
    const plan = recheckReviewerPlan();
    expect(plan.reviewers.map(reviewer => reviewer.rank)).toEqual([2]);
    expect(plan.skipped).toEqual([expect.objectContaining({ rank: 1, reason: expect.stringContaining("쓸 수 있는 작업") })]);
  });

  it("an empty allowedTasks list still means every task", () => {
    setAiTaskModelsForTest([row(1, [])]);
    expect(recheckReviewerPlan().reviewers.map(reviewer => reviewer.rank)).toEqual([1]);
  });

  it("refuses a captured API reviewer after its connection is restricted, and names why", () => {
    setAiTaskModelsForTest([row(1, ["product-audit"])]);
    const reviewer = recheckReviewerPlan().reviewers[0];
    expect(recheckDirectEndpoint(reviewer)).toEqual({ baseUrl: "http://recheck-1.test/v1", apiKey: null });
    expect(recheckReviewerRefusal(reviewer)).toBeNull();
    setAiTaskModelsForTest([row(1, ["reason-translate"])]);
    expect(recheckDirectEndpoint(reviewer)).toBeNull();
    expect(recheckReviewerRefusal(reviewer)).toBe("connection_task_not_allowed");
  });
});

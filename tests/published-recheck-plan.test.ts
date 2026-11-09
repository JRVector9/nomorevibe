import { afterEach, describe, expect, it } from "vitest";
import { setAiTaskModelsForTest, type AiTaskModelSnapshotRow } from "@/lib/llm/ai-task-models-snapshot";
import { setReviewRanksForTest } from "@/lib/crawl/review-task-ranks";
import { RECHECK_TASK_LABEL, recheckDirectEndpoint, recheckReviewerPlan, recheckReviewerPlanText } from "@/lib/crawl/published-recheck";
import { claimRecheckItem, clearRecheckRankPause, noteRecheckItemRankRefused, noteRecheckRankPaused, RECHECK_ITEM_SKIP_MS, RECHECK_RANK_PAUSE_MS,
  recheckItemRankRefused, recheckLaneOf, recheckRankPaused, recheckSkips, recheckTurn, releaseRecheckItem, resetRecheckLanes } from "@/lib/crawl/published-recheck-lanes";
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
const GPU = "0a0b0c0d-0000-4000-8000-000000000003", M3 = "0a0b0c0d-0000-4000-8000-000000000004";
/** API 연결 순위(감사 직접 경로) — 주소·키는 연결의 것 */
const api = (rank: number, model: string, over: Partial<AiTaskModelSnapshotRow["connection"]> = {}): AiTaskModelSnapshotRow => Object.freeze({ task: "product-audit",
  slot: 1, rank, model, enabled: true, options: Object.freeze({}), connection: Object.freeze({ id: GPU, label: "gpu3090-qwen", kind: "api" as const,
    baseUrl: "http://gpu.test:8090/v1", cliTool: null, deviceId: "gpu3090-qwen", enabled: true, models: [{ id: model, maxModelLen: 131072 }], contextTokens: null,
    apiKey: KEY, keyUnreadable: false, ...over }) });

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
      [1, "opus", "순위 꺼짐"], [2, "m-off", "연결 꺼짐"], [3, "grok-4.7", "감사 경로는 OpenCode·Claude CLI·API 연결만 받습니다"],
      [3, "m-nokey", "연결의 호스트 주소·키를 열 수 없거나 추론 강도가 맞지 않습니다"]]);
    expect(recheckReviewerPlanText(plan)).toBe(`「${RECHECK_TASK_LABEL}」 순위를 모두 부를 수 없습니다 — 묻지 않고 올리기만 합니다`);
  });

  it("2026-11-09 API 연결 순위는 감사 직접 경로(local-direct)로 내고 주소를 싣는다 — 키는 계획에 싣지 않고 부를 때 순위에서 읽는다", () => {
    setAiTaskModelsForTest([api(1, "qwen3.8-flash-next"), claude(2, "sonnet"), api(3, "gpt-oss-120b", { id: M3, label: "m3-mlx", baseUrl: "http://m3.test:8010/v1", apiKey: null })]);
    const plan = recheckReviewerPlan();
    expect(plan.reviewers).toEqual([
      { rank: 1, provider: "local-direct", model: "qwen3.8-flash-next", connectionId: GPU, connectionLabel: "gpu3090-qwen", baseUrl: "http://gpu.test:8090/v1" },
      { rank: 2, provider: "claude-cli", model: "sonnet", connectionId: "0a0b0c0d-0000-4000-8000-000000000002", connectionLabel: "Claude CLI" },
      { rank: 3, provider: "local-direct", model: "gpt-oss-120b", connectionId: M3, connectionLabel: "m3-mlx", baseUrl: "http://m3.test:8010/v1" },
    ]);
    expect(JSON.stringify(plan)).not.toContain(KEY);
    expect(recheckDirectEndpoint(plan.reviewers[0])).toEqual({ baseUrl: "http://gpu.test:8090/v1", apiKey: KEY });
    expect(recheckDirectEndpoint(plan.reviewers[2])).toEqual({ baseUrl: "http://m3.test:8010/v1", apiKey: null });
    // 순위가 그 사이 바뀌었으면(다른 모델) 부르지 않는다
    expect(recheckDirectEndpoint({ ...plan.reviewers[0], model: "other" })).toBeNull();
    // 주소가 없거나 저장한 키를 열 수 없는 API 연결은 까닭과 함께 건너뛴다
    setAiTaskModelsForTest([api(1, "a", { baseUrl: null }), api(2, "b", { keyUnreadable: true, apiKey: null })]);
    expect(recheckReviewerPlan().skipped.map((row) => [row.rank, row.reason])).toEqual([[1, "연결 주소가 없습니다"],
      [2, "연결에 저장한 키를 열 수 없습니다(암호 상자 키 확인)"]]);
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

describe("두 묻기 줄의 순위 차례(published-recheck-lanes.ts)", () => {
  const cli1 = { rank: 1, provider: "opencode-cli", connectionId: "c1", model: "deepseek" };
  const api2 = { rank: 2, provider: "local-direct", connectionId: "a2", model: "qwen" };
  const cli3 = { rank: 3, provider: "claude-cli", connectionId: "c3", model: "sonnet" };
  afterEach(() => resetRecheckLanes());

  it("차례는 쉬지 않는 가장 앞 순위다 — 자기 줄은 이 틱에 멈춘 것만, 다른 줄은 그 줄이 적은 쉼만 건너뛴다", () => {
    const plan = [cli1, api2, cli3];
    expect(recheckLaneOf(api2)).toBe("api");
    expect(recheckLaneOf(cli1)).toBe("cli");
    // 처음에는 둘 다 1순위(CLI) 차례 — API 줄은 감사 잡에 맡긴다
    expect(recheckTurn(plan, "cli", new Set())).toBe(cli1);
    expect(recheckTurn(plan, "api", new Set())).toBe(cli1);
    // 감사 잡의 1순위가 열리지 않았다 — 감사 잡은 이 틱에 2순위(API)를 보고, API 줄도 쉼 기록으로 2순위가 제 차례다
    noteRecheckRankPaused(cli1, "capacity", 1_000);
    expect(recheckTurn(plan, "cli", new Set([1]), 1_000)).toBe(api2);
    expect(recheckTurn(plan, "api", new Set(), 1_000)).toBe(api2);
    // 자기 줄은 쉼 기록을 보지 않는다 — 다음 틱의 감사 잡은 1순위를 다시 물어본다
    expect(recheckTurn(plan, "cli", new Set(), 1_000)).toBe(cli1);
    // API 순위도 열리지 않으면 3순위(CLI)
    expect(recheckTurn(plan, "api", new Set([2]), 1_000)).toBe(cli3);
    noteRecheckRankPaused(api2, "provider_contract_unavailable", 1_000);
    expect(recheckTurn(plan, "cli", new Set([1]), 1_000)).toBe(cli3);
    // 쉼은 RECHECK_RANK_PAUSE_MS 뒤 저절로 풀리고, 답을 받으면 지운다
    expect(recheckRankPaused(cli1, 1_000 + RECHECK_RANK_PAUSE_MS)).toBe(false);
    expect(recheckRankPaused(api2, 1_000 + RECHECK_RANK_PAUSE_MS - 1)).toBe(true);
    clearRecheckRankPause(api2);
    expect(recheckRankPaused(api2, 1_001)).toBe(false);
    // 모두 쉬면 차례가 없다
    expect(recheckTurn([cli1], "cli", new Set([1]))).toBeNull();
  });

  it("도메인 증명이 거절한 항목은 그 항목에서만 그 순위를 건너뛴다 — 두 줄 모두 그 항목은 다음 순위로, 다른 항목은 그대로", () => {
    noteRecheckItemRankRefused(7, api2, 1_000);
    expect(recheckTurn([api2, cli3], "api", new Set(), 1_000, 7)).toBe(cli3);
    expect(recheckTurn([api2, cli3], "cli", new Set(), 1_000, 7)).toBe(cli3);
    expect(recheckTurn([api2, cli3], "cli", new Set(), 1_000, 8)).toBe(api2);
    // 순위 전체의 쉼이 아니다
    expect(recheckSkips(api2, "cli", new Set(), 1_000)).toBe(false);
    expect(recheckSkips(api2, "cli", new Set(), 1_000, 7)).toBe(true);
    expect(recheckItemRankRefused(7, api2, 1_000 + RECHECK_ITEM_SKIP_MS - 1)).toBe(true);
    expect(recheckItemRankRefused(7, api2, 1_000 + RECHECK_ITEM_SKIP_MS)).toBe(false);
  });

  it("묻는 동안 항목을 잡아 두 줄이 같은 항목을 함께 묻지 않는다", () => {
    expect(claimRecheckItem(7)).toBe(true);
    expect(claimRecheckItem(7)).toBe(false);
    releaseRecheckItem(7);
    expect(claimRecheckItem(7)).toBe(true);
  });
});

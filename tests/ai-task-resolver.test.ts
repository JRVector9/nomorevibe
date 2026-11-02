import { afterEach, describe, expect, it } from "vitest";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { activeTextTaskRank, textTaskModel, TextTaskRankMissingError } from "@/lib/llm/ai-task-rank-scope";
import { resolveTextTaskRanks, textRankStatusFromCounts, TextTaskRanks } from "@/lib/llm/ai-task-resolver";
import { aiTaskAliasIdentity, AI_TASK_RANK_DEGRADED_CODES } from "@/lib/llm/ai-tasks";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { setServingContractSnapshotForTest, textRouteAccess } from "@/lib/llm/serving-contract-store";
import { applyAllSkippedBlock } from "@/lib/operations/worker-progress-query";
import { pinTextRanks, TEST_CONNECTION_ID, textContract, textRankRow } from "./text-task-ranks-fixture";

/**
 * PR B 공통 실행 resolver — 「작업 ↔ 모델」 순위를 그 연결을 가리키는 계약에 묶고(장부 이름·provider·연결의 키), 한 틱의 순위 대체를 한다.
 * 순위가 없거나 모두 쓸 수 없으면 기본값으로 대신 부르지 않고 그 까닭을 돌려준다.
 */
afterEach(() => { setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null); });

const SECOND = "0b0c0d0e-0000-4000-8000-0000000000aa";
const SECOND_BASE = "http://second.test:8000/v1";

describe("resolveTextTaskRanks — 순위 → 계약", () => {
  it("스냅숏을 한 번도 읽지 못했으면 task_models_unreadable, 읽었는데 순위가 없으면 no_task_models", () => {
    setAiTaskModelsForTest(null);
    expect(resolveTextTaskRanks("crawl-tagline").status).toBe("task_models_unreadable");
    pinTextRanks({ "reason-translate": "gpt-oss-120b" });
    expect(resolveTextTaskRanks("crawl-tagline")).toMatchObject({ status: "no_task_models", candidates: [] });
  });

  it("연결 주소·엔진 모델이 같은 직접 계약에 묶는다 — 장부 이름 = 계약 행 열쇠, 키 = 연결의 키", () => {
    setServingContractSnapshotForTest([textContract("crawl-tagline", "qwen3.6-35b")]);
    setAiTaskModelsForTest([textRankRow("crawl-tagline", "qwen3.6-35b", { apiKey: "connection-key" })]);
    const [candidate] = resolveTextTaskRanks("crawl-tagline").candidates;
    expect(candidate.unusable).toBeNull();
    expect(candidate.binding).toMatchObject({ routeId: "crawl-tagline", rank: 1, identity: "qwen3.6-35b", engineModel: "qwen3.6-35b",
      provider: "abcllm", bearer: "connection-key", connectionId: TEST_CONNECTION_ID });
  });

  it.each([
    ["다른 서버를 가리키는 계약", () => [textContract("crawl-tagline", "qwen3.6-35b", { baseUrl: SECOND_BASE })], {}, "no_direct_contract"],
    ["게이트웨이 전송 계약", () => [textContract("crawl-tagline", "qwen3.6-35b", { transport: "gateway" })], {}, "no_direct_contract"],
    ["모양이 틀린 계약", () => [{ ...textContract("crawl-tagline", "qwen3.6-35b"), contract: {} }], {}, "no_direct_contract"],
    ["게이트웨이 인증 계약", () => [textContract("crawl-tagline", "qwen3.6-35b", { auth: "gateway" })], {}, "gateway_auth"],
    ["꺼진 연결", () => [textContract("crawl-tagline", "qwen3.6-35b")], { connectionEnabled: false }, "connection_disabled"],
    ["열리지 않는 연결 키", () => [textContract("crawl-tagline", "qwen3.6-35b")], { keyUnreadable: true }, "stored_key_unreadable"],
    ["꺼진 순위", () => [textContract("crawl-tagline", "qwen3.6-35b")], { enabled: false }, "rank_disabled"],
  ] as const)("%s는 쓸 수 없다(까닭 %s)", (_name, contracts, options, code) => {
    setServingContractSnapshotForTest(contracts());
    setAiTaskModelsForTest([textRankRow("crawl-tagline", "qwen3.6-35b", options)]);
    const [candidate] = resolveTextTaskRanks("crawl-tagline").candidates;
    expect(candidate).toMatchObject({ binding: null, unusable: code });
  });

  it("계약 행의 키가 열리지 않아도 연결의 키로 연다(보내는 키는 연결의 것)", () => {
    setServingContractSnapshotForTest([textContract("crawl-tagline", "qwen3.6-35b", { auth: "stored", apiKey: null })]);
    setAiTaskModelsForTest([textRankRow("crawl-tagline", "qwen3.6-35b", { apiKey: "connection-key" })]);
    expect(resolveTextTaskRanks("crawl-tagline").candidates[0].binding?.bearer).toBe("connection-key");
  });

  it("같은 모델을 두 연결에 두면 2순위는 연결로 가른 장부 이름의 계약(engineModel)에 묶인다", () => {
    const alias = aiTaskAliasIdentity("qwen3.6-35b", SECOND)!;
    expect(alias).toBe(`qwen3.6-35b@${SECOND.slice(0, 8)}`);
    setServingContractSnapshotForTest([textContract("crawl-tagline", "qwen3.6-35b"),
      textContract("crawl-tagline", alias, { baseUrl: SECOND_BASE, engineModel: "qwen3.6-35b" })]);
    setAiTaskModelsForTest([textRankRow("crawl-tagline", "qwen3.6-35b"),
      textRankRow("crawl-tagline", "qwen3.6-35b", { rank: 2, connectionId: SECOND, baseUrl: SECOND_BASE, label: "second" })]);
    const bindings = resolveTextTaskRanks("crawl-tagline").candidates.map(candidate => candidate.binding);
    expect(bindings.map(binding => [binding?.rank, binding?.identity, binding?.engineModel])).toEqual([[1, "qwen3.6-35b", "qwen3.6-35b"], [2, alias, "qwen3.6-35b"]]);
  });
});

describe("TextTaskRanks — 한 틱의 순위 대체", () => {
  const twoRanks = () => {
    setServingContractSnapshotForTest([textContract("product-search-profile", "gpt-oss-120b"),
      textContract("product-search-profile", "qwen3.6-35b", { baseUrl: SECOND_BASE })]);
    setAiTaskModelsForTest([textRankRow("product-search-profile", "gpt-oss-120b"),
      textRankRow("product-search-profile", "qwen3.6-35b", { rank: 2, connectionId: SECOND, baseUrl: SECOND_BASE, label: "second" })]);
    return new TextTaskRanks(resolveTextTaskRanks("product-search-profile"));
  };

  it("그 모델만의 미룸이면 같은 일을 다음 순위로 넘기고 1순위는 이 틱 동안 쉰다", async () => {
    const ranks = twoRanks();
    const seen: string[] = [];
    const first = await ranks.run(async binding => {
      seen.push(textTaskModel("product-search-profile"));
      if (binding.rank === 1) throw new ModelCapacityDeferredError("unmapped");
      return "done";
    });
    expect(first).toMatchObject({ kind: "served", value: "done", binding: { rank: 2 } });
    expect(seen).toEqual(["gpt-oss-120b", "qwen3.6-35b"]);
    // 다음 일은 쉬는 1순위를 건너뛴다
    const next = await ranks.run(async binding => binding.rank);
    expect(next).toMatchObject({ kind: "served", value: 2 });
    expect(ranks.summary()).toEqual({ ranks: 2, "served.2": 2, "unusable.1.unmapped": 1 });
    expect(ranks.saturated()).toBe(false);
  });

  it("이 일만의 미룸·전역 미룸은 다음 순위로 넘기지 않고 그대로 던진다", async () => {
    for (const reason of ["work_busy", "draining"] as const) {
      const ranks = twoRanks();
      const tried: number[] = [];
      await expect(ranks.run(async binding => { tried.push(binding.rank); throw new ModelCapacityDeferredError(reason); })).rejects.toMatchObject({ reason });
      expect(tried).toEqual([1]);
    }
  });

  it("모든 순위가 쉬면 unusable — 포화가 섞였으면 saturated, degraded 에는 순위마다 까닭이 한국어로 남는다", async () => {
    const ranks = twoRanks();
    const outcome = await ranks.run(async binding => { throw new ModelCapacityDeferredError(binding.rank === 1 ? "device_unconfigured" : "capacity"); });
    expect(outcome).toEqual({ kind: "unusable" });
    expect(ranks.exhausted).toBe(true);
    expect(ranks.saturated()).toBe(true);
    const degraded = ranks.degraded();
    expect(degraded.code).toBe("all_ranks_unusable");
    expect(degraded.detail).toContain("1순위 test-engine · gpt-oss-120b: 장비 행이 없음");
    expect(degraded.detail).toContain("2순위 second · qwen3.6-35b: 포화");
  });

  it("엔진이 내려갔음이 증명되면(연결 거절 연속) 그 순위만 쉰다 — 모든 순위가 엔진 까닭이면 engineDown", async () => {
    const ranks = twoRanks();
    const [first, second] = ranks.bindings();
    expect(ranks.failed(first, "network")).toBe(false);
    expect(ranks.failed(first, "network")).toBe(false);
    expect(ranks.failed(first, "network")).toBe(true);
    expect(ranks.usable().map(binding => binding.rank)).toEqual([2]);
    expect(ranks.engineDown()).toBeNull();
    expect(ranks.failed(second, "no_key")).toBe(true);
    expect(ranks.engineDown()).toBe("network");
  });

  it("prefer 로 이어받을 순위를 먼저 본다", async () => {
    const ranks = twoRanks();
    expect(await ranks.run(async binding => binding.rank, { prefer: "qwen3.6-35b" })).toMatchObject({ value: 2 });
  });

  it("순위가 없으면 일을 시작하기 전에 no_task_models — 기본값으로 대신 부르지 않는다", () => {
    pinTextRanks({});
    const ranks = new TextTaskRanks(resolveTextTaskRanks("crawl-tagline"));
    expect(ranks.earlyDegraded()).toMatchObject({ code: "no_task_models" });
    expect(ranks.earlyDegraded()?.detail).toContain("기본값");
  });

  it("범위 밖에서 text 경로의 모델을 물으면 던진다 — 환경변수 상수로 떨어지지 않는다", () => {
    expect(() => textTaskModel("crawl-tagline")).toThrow(TextTaskRankMissingError);
    expect(activeTextTaskRank("crawl-tagline")).toBeNull();
  });

  it("범위 안의 textRouteAccess 는 연결의 키를 보낸다(계약 행의 키가 아니다)", async () => {
    setServingContractSnapshotForTest([textContract("crawl-tagline", "qwen3.6-35b", { auth: "stored", apiKey: "contract-key" })]);
    setAiTaskModelsForTest([textRankRow("crawl-tagline", "qwen3.6-35b", { apiKey: "connection-key" })]);
    const ranks = new TextTaskRanks(resolveTextTaskRanks("crawl-tagline"));
    expect(textRouteAccess("crawl-tagline", "qwen3.6-35b")).toEqual({ block: null, bearer: "contract-key" });
    const inside = await ranks.run(async () => textRouteAccess("crawl-tagline", "qwen3.6-35b"));
    expect(inside).toMatchObject({ kind: "served", value: { block: null, bearer: "connection-key" } });
  });
});

describe("관측 → 화면", () => {
  it("ai_task.ranks 숫자 칸을 순위 사정으로 읽는다(모양이 틀린 칸은 버린다)", () => {
    expect(textRankStatusFromCounts("crawl-tagline", "2026-11-02T00:00:00.000Z",
      { ranks: 2, "served.2": 5, "unusable.1.unmapped": 3, "served.x": 1, "unusable.9.capacity": 1, other: "x" })).toMatchObject({
      ranks: 2, served: { 2: 5 }, unusable: [{ rank: 1, code: "unmapped", count: 3 }] });
  });

  it("text 잡의 순위 degraded 는 진행 감시가 재시작하지 않는다(설정의 일)", () => {
    const now = new Date("2026-11-02T00:00:00Z");
    for (const code of AI_TASK_RANK_DEGRADED_CODES) {
      const stage = applyAllSkippedBlock({ job: "crawl-tagline", reason: "no_progress", restartEligible: true },
        [{ key: "job:crawl-tagline", value: { degraded: { code, detail: "d", streak: 2 } }, observedAt: now }], now);
      expect(stage).toMatchObject({ restartEligible: false, skipBlock: { code, detail: "d", streak: 2 } });
    }
    const other = applyAllSkippedBlock({ job: "crawl-tagline", reason: "no_progress", restartEligible: true },
      [{ key: "job:crawl-tagline", value: { degraded: { code: "agent_review_all_skipped" } }, observedAt: now }], now);
    expect(other.restartEligible).toBe(true);
  });
});

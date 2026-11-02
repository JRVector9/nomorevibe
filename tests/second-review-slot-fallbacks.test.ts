import { afterEach, expect, it } from "vitest";
import { secondReviewFallbacks, secondReviewFallbacksFor, secondReviewVoters, secondReviewVotersDegraded,
  withoutTakenModels } from "@/lib/crawl/second-review-voters";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { setServingContractSnapshotForTest, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { cliDbContract } from "@/lib/llm/cli-db-contracts";
import { cliContractRouteId } from "@/lib/llm/cli-serving-contract";
import { pinReviewRanks } from "./review-task-ranks-fixture";
import { TEST_TEXT_BASE_URL, textRankRow } from "./text-task-ranks-fixture";
import { cliRankRow } from "./fake-cli-path";

/**
 * 2차 투표자·대체(PR C1): 투표자 칸마다 따로 1·2·3순위가 있고, 칸마다 쓸 수 있는 가장 높은 순위가 표를 낸다. 실패·대기한 표의 대체는 그 첫 표(root) 모델이 든
 * 칸의 다음 순위에서만 고른다(secondReviewFallbacksFor) — 다른 칸의 모델은 들지 않는다. 부르는 쪽은 이미 표를 낸·지금 투표자인 모델을 다시 뺀다(withoutTakenModels).
 * 옛 설정(secondReview.voters·fallbacks)은 읽지 않는다.
 */
type Reviewer = { provider: string; model: string };
const abc = (model: string): Reviewer => ({ provider: "abcllm", model });
// 옛 설정은 일부러 다른 모델을 적는다 — 결과에 나오면 안 된다
const legacy: CrawlSettings = { ...DEFAULT_CRAWL_SETTINGS, secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview,
  voters: [{ provider: "abcllm", model: "legacy-voter" }], fallbacks: [{ provider: "abcllm", model: "legacy-backup" }] } };
afterEach(() => { pinReviewRanks(null); setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null); });

it("투표자는 칸마다 1순위, 대체는 그 칸의 다음 순위에서만 고른다 — 옛 설정은 읽지 않는다", () => {
  pinReviewRanks({ second: [[abc("a"), abc("b"), abc("c")], [abc("d"), abc("e")]] });
  expect(secondReviewVoters(legacy)).toEqual([abc("a"), abc("d")]);
  // 목록 검사용 대체(투표자 밖의 순위 모두)
  expect(secondReviewFallbacks(legacy)).toEqual([abc("b"), abc("c"), abc("e")]);
  expect(secondReviewFallbacksFor(legacy, "a")).toEqual([abc("b"), abc("c")]);
  expect(secondReviewFallbacksFor(legacy, "d")).toEqual([abc("e")]);
  // 대체가 다시 실패하면 그 다음 순위
  expect(secondReviewFallbacksFor(legacy, "b")).toEqual([abc("c")]);
  // 같은 가중치의 다른 이름([MLX] 자리 표시·연결로 가른 장부 이름)도 같은 칸이다
  expect(secondReviewFallbacksFor(legacy, "[MLX] A")).toEqual([abc("b"), abc("c")]);
  expect(secondReviewFallbacksFor(legacy, "d@0a1b2c3d")).toEqual([abc("e")]);
  // 순위에서 빠진 모델·root 없음은 대체가 없다(옛 설정의 대체로 돌아가지 않는다)
  for (const root of ["legacy-voter", "", null, undefined]) expect(secondReviewFallbacksFor(legacy, root)).toEqual([]);
  expect(secondReviewVotersDegraded()).toBeNull();
});

it("다른 칸에도 있는 모델은 이 칸의 대체가 되지 않는다 — 한 모델이 한 항목에 두 표를 내지 않는다", () => {
  // 두 칸에 든 모델(저장이 막지만 옛 행·가져오기)은 앞 칸의 것이다 — 앞 칸의 대체 차례에만 들고 뒤 칸에는 들지 않는다
  pinReviewRanks({ second: [[abc("a"), abc("e"), abc("b")], [abc("d"), abc("e")]] });
  expect(secondReviewFallbacksFor(legacy, "a")).toEqual([abc("e"), abc("b")]);
  expect(secondReviewFallbacksFor(legacy, "d")).toEqual([]);
  // 뒤 칸에서 표를 내는 모델이 앞 칸의 아래 순위에도 있으면 그 모델은 표를 내는 칸의 것이다
  pinReviewRanks({ second: [[abc("a"), abc("d")], [abc("d"), abc("e")]] });
  expect(secondReviewFallbacksFor(legacy, "d")).toEqual([abc("e")]);
  expect(secondReviewFallbacksFor(legacy, "a")).toEqual([]);
  expect(secondReviewVoters(legacy)).toEqual([abc("a"), abc("d")]);
  // 두 칸에 같은 모델이 1순위면 앞 칸만 표를 낸다
  pinReviewRanks({ second: [[abc("a"), abc("b")], [abc("[MLX] a"), abc("c")]] });
  expect(secondReviewVoters(legacy)).toEqual([abc("a")]);
});

it("런타임 가드: 이미 표를 낸·지금 투표자인 모델(같은 가중치의 다른 이름 포함)은 대체 후보에서 뺀다", () => {
  const candidates = [abc("b"), { provider: "claude-cli", model: "opus" }, abc("c@0a1b2c3d"), abc("d")];
  expect(withoutTakenModels(candidates, ["[MLX] B", null, undefined, "", "c"])).toEqual([{ provider: "claude-cli", model: "opus" }, abc("d")]);
  expect(withoutTakenModels(candidates, [])).toEqual(candidates);
  // 같은 칸의 대체 차례 + 가드 = 실제 고르기(recordSecondReview·fallbackWaitingSecondReview 와 같은 식)
  pinReviewRanks({ second: [[abc("a"), abc("b"), abc("c")], [abc("d")]] });
  const taken = [...secondReviewVoters(legacy).map(voter => voter.model), "b"];
  expect(withoutTakenModels(secondReviewFallbacksFor(legacy, "a"), taken)).toEqual([abc("c")]);
});

// 묶기를 거치는 실제 순위(연결 → 계약): 쓸 수 없는 순위는 투표자도 대체도 되지 않는다
const ai2Contract = (model: string): StoredServingContract => ({ routeId: "second-review", model, auth: "none", apiKey: null, transport: "direct",
  contract: { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "second-review", provider: "abcllm", model, responseModel: model,
    deploymentRevision: `test-${model}`, endpoint: `${TEST_TEXT_BASE_URL}/chat/completions`, totalTokenBound: 32_768 } });
const cliContractRow = (model: string): StoredServingContract => {
  const routeId = cliContractRouteId("claude-cli", "second-review");
  return { routeId, model, auth: "none", apiKey: null, transport: "direct",
    contract: { ...cliDbContract("second-review", "claude-cli", model, "claude 9.9.9")!, routeId } };
};

it("쓸 수 없는 순위(CLI 계약 없음)는 건너뛰고, 1순위를 쓸 수 없으면 2순위가 표를 낸다", () => {
  setServingContractSnapshotForTest([ai2Contract("qwen"), ai2Contract("gemma")]);
  setAiTaskModelsForTest([textRankRow("second-review", "qwen"), cliRankRow("second-review", "opus", { rank: 2, cliTool: "claude" }),
    textRankRow("second-review", "gemma", { rank: 3 })]);
  expect(secondReviewVoters(legacy)).toEqual([abc("qwen")]);
  // CLI 순위는 장부 이름을 알아 목록에는 남지만(지금 심사자의 기록) 고르기는 비켜 간다
  expect(secondReviewFallbacks(legacy)).toEqual([{ provider: "claude-cli", model: "opus" }, abc("gemma")]);
  expect(secondReviewFallbacksFor(legacy, "qwen")).toEqual([abc("gemma")]);
  // 순위 저장이 만든 CLI 계약 행이 있으면(이 프로세스는 버전을 아직 보지 않았다 — probe_pending) 쓸 수 있는 순위다
  setServingContractSnapshotForTest([ai2Contract("qwen"), ai2Contract("gemma"), cliContractRow("opus")]);
  expect(secondReviewFallbacksFor(legacy, "qwen")).toEqual([{ provider: "claude-cli", model: "opus" }, abc("gemma")]);

  // 1순위 CLI 의 계약이 없으면 그 칸은 2순위가 표를 내고, 대체는 그 뒤 순위다
  setServingContractSnapshotForTest([ai2Contract("qwen"), ai2Contract("gemma")]);
  setAiTaskModelsForTest([cliRankRow("second-review", "opus", { cliTool: "claude" }), textRankRow("second-review", "qwen", { rank: 2 }),
    textRankRow("second-review", "gemma", { rank: 3 })]);
  expect(secondReviewVoters(legacy)).toEqual([abc("qwen")]);
  expect(secondReviewFallbacksFor(legacy, "qwen")).toEqual([abc("gemma")]);
  expect(secondReviewVotersDegraded()).toBeNull();

  // 모든 순위를 쓸 수 없으면 투표자가 없고 2차는 제 일 못 함이다
  setServingContractSnapshotForTest([]);
  expect(secondReviewVoters(legacy)).toEqual([]);
  expect(secondReviewVotersDegraded()).toMatchObject({ code: "all_ranks_unusable" });
});

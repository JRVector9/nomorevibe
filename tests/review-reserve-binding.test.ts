import { afterEach, beforeEach, expect, it } from "vitest";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { setAiTaskExecutionConfigsForTest } from "@/lib/llm/ai-task-execution-snapshot";
import { setServingContractSnapshotForTest, textRouteAccess, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { taskPoolEngineKey } from "@/lib/llm/ai-task-pool-identity";
import { firstReviewRankCandidates, firstReviewRanks, reviewRankFor } from "@/lib/crawl/review-task-ranks";
import { textRankRow } from "./text-task-ranks-fixture";
import { cliDbContract } from "@/lib/llm/cli-db-contracts";
import { cliContractRouteId } from "@/lib/llm/cli-serving-contract";

/**
 * 2026-11-12 검수 F3(gpt-6.1-sol 재현): 1차 「동시에」에서 예비 순위는 고를 수 있는데, 전송 준비가 구성원만 찾았다 — CLI 준비(reviewRankFor)는 예비의
 * 연결·추론 강도를 잃고(OpenCode 는 순위 없음으로 거절), API 키 조회(textRouteAccess → reviewRankConnection)는 pool 이면 저장된 순위를 지워 예비가
 * stored_key_unreadable 로 막혔다. 고르기와 전송 준비는 같은 집합(구성원 + 켜진 예비)을 읽어야 하고, 예비를 끄면 예비는 들지 않는다.
 * 합성 고정값만 쓴다 — 실제 키·주소를 읽지 않는다.
 */
const memberRank = textRankRow("first-review", "pool-member");
const reserveRank = Object.freeze({
  ...textRankRow("first-review", "pool-reserve", {
    baseUrl: "http://reserve.test:8000/v1", connectionId: "0b0c0d0e-0000-4000-8000-000000000002",
    apiKey: "synthetic-reserve-token",
  }), options: Object.freeze({ reasoningEffort: "high" }),
});
const contract = (model: string, endpoint: string, auth: "none" | "stored"): StoredServingContract => ({
  routeId: "crawl-agent-review", model, transport: "direct", auth, apiKey: null,
  contract: { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm", model,
    responseModel: model, deploymentRevision: "reserve-fixture", endpoint: `${endpoint}/chat/completions`, totalTokenBound: 32768 },
});
const execution = (reserveRanks: boolean) => [{ task: "first-review", slot: 1, mode: "workload_pool" as const, revision: 1,
  updatedAt: null, reserveRanks, members: [{ memberId: "0b0c0d0e-0000-4000-8000-000000000003", position: 1,
    connectionId: memberRank.connection.id, model: memberRank.model, options: {}, canonicalModel: memberRank.model,
    deviceId: memberRank.connection.deviceId, engineKey: taskPoolEngineKey(memberRank.connection, memberRank.model),
    maxSlots: 1, connection: memberRank.connection }] }];
const cliReserve = () => {
  const cliRank = Object.freeze({ ...reserveRank, model: "pool-reserve-cli", connection: Object.freeze({
    ...reserveRank.connection, kind: "cli" as const, baseUrl: null, cliTool: "claude", apiKey: null,
  }) });
  const storedRoute = cliContractRouteId("claude-cli", "crawl-agent-review");
  setAiTaskModelsForTest([cliRank]);
  setServingContractSnapshotForTest([
    contract(memberRank.model, memberRank.connection.baseUrl!, "none"),
    { routeId: storedRoute, model: cliRank.model, auth: "none", apiKey: null, transport: "direct",
      contract: { ...cliDbContract("crawl-agent-review", "claude-cli", cliRank.model, "2.1.0 (Claude Code)")!, routeId: storedRoute } },
  ]);
  return cliRank;
};
beforeEach(() => {
  setAiTaskModelsForTest([reserveRank]);
  setServingContractSnapshotForTest([
    contract(memberRank.model, memberRank.connection.baseUrl!, "none"),
    contract(reserveRank.model, reserveRank.connection.baseUrl!, "stored"),
  ]);
  setAiTaskExecutionConfigsForTest(execution(true));
});
afterEach(() => {
  setAiTaskModelsForTest(null); setAiTaskExecutionConfigsForTest(null); setServingContractSnapshotForTest(null);
});

it("an eligible first-review CLI reserve keeps the saved rank, connection and options used to prepare its transport", () => {
  const cliRank = cliReserve();
  expect(firstReviewRanks().reserve).toEqual([{ provider: "claude-cli", model: cliRank.model }]);
  expect(reviewRankFor("crawl-agent-review", "claude-cli", cliRank.model)).toMatchObject({
    model: cliRank.model, options: { reasoningEffort: "high" }, connection: { id: cliRank.connection.id },
  });
  // 고르기와 같은 집합 — 구성원 먼저, 다음 예비
  expect(firstReviewRankCandidates().map(candidate => candidate.binding?.identity)).toEqual([memberRank.model, cliRank.model]);
  // 구성원은 예전처럼 그 구성원의 순위다
  expect(reviewRankFor("crawl-agent-review", "abcllm", memberRank.model)).toMatchObject({ model: memberRank.model, connection: { id: memberRank.connection.id } });
});

it("an eligible first-review API reserve sends with its connection's key even when the contract row key does not open", () => {
  expect(firstReviewRanks().reserveCandidates[0]).toMatchObject({ unusable: null });
  // 막힘만 본다 — 실패해도 bearer 를 출력하지 않는다
  expect(textRouteAccess("crawl-agent-review", reserveRank.model, "abcllm").block).toBeNull();
});

it("with the reserve switched off the saved ranks are not activated: no reserve rank, and the contract rule stands", () => {
  setAiTaskExecutionConfigsForTest(execution(false));
  expect(firstReviewRanks().reserve).toEqual([]);
  expect(reviewRankFor("crawl-agent-review", "abcllm", reserveRank.model)).toBeNull();
  expect(textRouteAccess("crawl-agent-review", reserveRank.model, "abcllm").block).toBe("stored_key_unreadable");
  cliReserve();
  setAiTaskExecutionConfigsForTest(execution(false));
  expect(reviewRankFor("crawl-agent-review", "claude-cli", "pool-reserve-cli")).toBeNull();
});

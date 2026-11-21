import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import "@/lib/crawl/second-review-serving-contract";
import { ai2CallReroutesOnCapacityWait, prepareAi2GatewayCall } from "@/lib/crawl/agent-review-gateway";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { abcllmContract, contractRow, reviewInput, totalBoundContract } from "./total-bound-direct-fixture";

/**
 * 2차 줄 대기 대체(capacity_wait_timeout)를 받는 표인가 — 실제 준비 호출(prepareAi2GatewayCall)로 다섯 경우를 고정한다(PR #1014 리뷰).
 * 오늘 운영 2차 순위는 모두 abcllm 계약이라 그 표는 줄에서 기다린다 — 이 시험이 그 운영 동작을 지킨다. 다르게 하려면 소유자 결정이 먼저다.
 * 장비 칸이 있는 직접 계약 둘(ai2-direct-openai-chat-v1·direct-openai-chat-v1)은 loopback tokenizer 로 실제 사전 확인을 거친다. 운영 값이 아니다.
 */
const MODEL = "fixture-model";
let origin = "";
const tokenizer = createServer((request, response) => {
  request.resume();
  response.end(JSON.stringify({ count: 10, tokens: Array.from({ length: 10 }, (_, index) => index + 1), max_model_len: 50_000 }));
});
beforeAll(async () => {
  await new Promise<void>(resolve => tokenizer.listen(0, "127.0.0.1", resolve));
  const address = tokenizer.address(); if (!address || typeof address === "string") throw new Error("local_address");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { tokenizer.closeAllConnections(); await new Promise(resolve => tokenizer.close(resolve)); });
afterEach(() => setServingContractSnapshotForTest(null));

const directContract = (protocol: "ai2-direct-openai-chat-v1" | "direct-openai-chat-v1") => ({ version: 1, protocol, routeId: "second-review",
  provider: "local-direct", model: MODEL, responseModel: "served-fixture", deploymentRevision: "fixture-direct", endpoint: `${origin}/v1/chat/completions`,
  tokenizerEndpoint: `${origin}/tokenize`, backendId: "fixture-backend", physicalGroup: "fixture-device", totalTokenBound: 50_000,
  requestTokenBound: 32_000, maxOutputTokens: 4096 });
async function prepared(contract: Record<string, unknown>, provider: "abcllm" | "local-direct") {
  setServingContractSnapshotForTest([contractRow(contract)]);
  const call = await prepareAi2GatewayCall(reviewInput(), { model: MODEL, provider, timeoutMs: 5_000 });
  if (call.kind !== "prepared") throw new Error(`prepared_required:${JSON.stringify(contract.protocol)}`);
  return call;
}

it("a vote prepared on today's abcllm contract keeps waiting — no 15-second reroute", async () => {
  expect(ai2CallReroutesOnCapacityWait(await prepared(abcllmContract("second-review", { endpoint: `${origin}/v1/chat/completions` }), "abcllm"))).toBe(false);
  // 같은 엔진의 2차 requestBudget(tokenizer 확인)이 있는 abcllm 계약도 같다
  expect(ai2CallReroutesOnCapacityWait(await prepared(abcllmContract("second-review", { endpoint: `${origin}/v1/chat/completions`, totalTokenBound: 50_000,
    extra: { requestBudget: { requestTokenBound: 32_000, maxOutputTokens: 4096, tokenizerEndpoint: `${origin}/tokenize`, tokenizerModel: MODEL } } }), "abcllm"))).toBe(false);
});

it("a vote prepared on the relabelled total-bound contract keeps waiting, with or without a tokenizer block", async () => {
  expect(ai2CallReroutesOnCapacityWait(await prepared(totalBoundContract("second-review", { endpoint: `${origin}/v1/chat/completions` }), "local-direct"))).toBe(false);
  expect(ai2CallReroutesOnCapacityWait(await prepared(totalBoundContract("second-review", { endpoint: `${origin}/v1/chat/completions`, totalTokenBound: 50_000,
    extra: { maxOutputTokens: 4096, tokenizer: { endpoint: `${origin}/tokenize`, requestTokenBound: 32_000 } } }), "local-direct"))).toBe(false);
});

it.each(["ai2-direct-openai-chat-v1", "direct-openai-chat-v1"] as const)("a vote prepared on the device-named direct contract (%s) is rerouted", async protocol => {
  expect(ai2CallReroutesOnCapacityWait(await prepared(directContract(protocol), "local-direct"))).toBe(true);
});

it("a value this module did not prepare (a copy of a prepared call) is never rerouted", async () => {
  const call = await prepared(directContract("direct-openai-chat-v1"), "local-direct");
  expect(ai2CallReroutesOnCapacityWait(call)).toBe(true);
  expect(ai2CallReroutesOnCapacityWait({ ...call })).toBe(false);
});

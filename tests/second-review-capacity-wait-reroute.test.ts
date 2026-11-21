import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import "@/lib/crawl/second-review-serving-contract";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { itemBindingHash, type Ai2ItemBinding } from "@/lib/jobs/items/types";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { setRuntimeSettingsForTest } from "@/lib/operations/runtime-settings-store";
import { abcllmContract, contractRow, reviewInput, totalBoundContract } from "./total-bound-direct-fixture";

const ledger = vi.hoisted(() => ({ pending: vi.fn(), request: vi.fn(), fallback: vi.fn() }));
vi.mock("@/lib/llm/capacity-repository", async original => ({ ...await original<typeof import("@/lib/llm/capacity-repository")>(),
  findOwnPendingModelRequest: ledger.pending, requestAi2ItemModelSlot: ledger.request }));
vi.mock("@/lib/crawl/second-review-ownership", async original => ({ ...await original<typeof import("@/lib/crawl/second-review-ownership")>(),
  fallbackWaitingSecondReview: ledger.fallback }));
import { SecondReviewModelReservationRequired } from "@/lib/crawl/second-review-ownership";
import { claimSecondReviewModelCapacity } from "@/lib/crawl/second-review-model-capacity";

/**
 * 2차 줄 대기 넘김(capacity_wait_timeout)은 계약 모양을 묻지 않는다(2026-11-21 소유자 결정 「15초가 아니라 심사 대기 시간을 넘긴 것을 넘기게 해」).
 * 실제 준비 호출(prepareAi2GatewayCall)로 다섯 계약 모양을 만들고, 장부의 대기·포화 응답만 바꿔 넣어 claimSecondReviewModelCapacity 가 고르는 길을 본다.
 * 예전(#1014)에는 abcllm 계약·openai-chat-total-bound-v1 의 표가 줄에서 기다렸고 direct-openai-chat-v1 표만 15초 뒤 넘어갔다 — 이 시험이 그 차이를 없앤 것을 지킨다.
 * 기다린 시간 자체(2차 심사 대기 시간 · 대기 만료를 넘어 이어 세기)는 장부 TX 가 재므로 실제 PostgreSQL 시험(tests/integration/second-review-capacity-wait-fallback.test.ts)이 본다.
 * 장비 칸이 있는 직접 계약 둘은 loopback tokenizer 로 실제 사전 확인을 거친다. 운영 값이 아니다.
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
beforeEach(() => {
  vi.resetAllMocks();
  ledger.fallback.mockResolvedValue(true);
  ledger.request.mockResolvedValue({ kind: "deferred", reason: "capacity" });
});
afterEach(() => { setServingContractSnapshotForTest(null); setRuntimeSettingsForTest(null); });

const directContract = (protocol: "ai2-direct-openai-chat-v1" | "direct-openai-chat-v1") => ({ version: 1, protocol, routeId: "second-review",
  provider: "local-direct", model: MODEL, responseModel: "served-fixture", deploymentRevision: "fixture-direct", endpoint: `${origin}/v1/chat/completions`,
  tokenizerEndpoint: `${origin}/tokenize`, backendId: "fixture-backend", physicalGroup: "fixture-device", totalTokenBound: 50_000,
  requestTokenBound: 32_000, maxOutputTokens: 4096 });
const SHAPES: readonly (readonly [string, "abcllm" | "local-direct", () => Record<string, unknown>])[] = [
  ["abcllm-raw-total-bound-v1 (today's production AI2 ranks)", "abcllm", () => abcllmContract("second-review", { endpoint: `${origin}/v1/chat/completions` })],
  ["abcllm-raw-total-bound-v1 with a tokenizer requestBudget", "abcllm", () => abcllmContract("second-review", { endpoint: `${origin}/v1/chat/completions`,
    totalTokenBound: 50_000, extra: { requestBudget: { requestTokenBound: 32_000, maxOutputTokens: 4096, tokenizerEndpoint: `${origin}/tokenize`, tokenizerModel: MODEL } } })],
  ["openai-chat-total-bound-v1", "local-direct", () => totalBoundContract("second-review", { endpoint: `${origin}/v1/chat/completions` })],
  ["ai2-direct-openai-chat-v1", "local-direct", () => directContract("ai2-direct-openai-chat-v1")],
  ["direct-openai-chat-v1", "local-direct", () => directContract("direct-openai-chat-v1")],
];
const owner = { instanceId: "ai2-wait-reroute-unit", bootId: randomUUID() };
function intentFor(provider: "abcllm" | "local-direct") {
  const input = reviewInput();
  const binding: Ai2ItemBinding = { stage: "ai2", secondReviewId: 8, candidateId: 3, source: { kind: "first_attempt", firstAttemptId: 7 },
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: "c".repeat(64), promptVersion: REVIEW_PROMPT_VERSION,
    rulesVersion: REVIEW_RULES_VERSION, reviewer: { provider, model: MODEL }, generationKey: "d".repeat(64), vote: 8, fallbackForId: null };
  return new SecondReviewModelReservationRequired({ binding, input, rowIdentityHash: "b".repeat(64), failureCount: 0, owner });
}
/** 계약을 스냅숏에 넣고, 이 표가 이미 줄에 선(waiting) 장부 요청을 하나 갖게 한다 — 장부는 포화(capacity)로 거절한다 */
function waitingOnFullModel(contract: Record<string, unknown>, provider: "abcllm" | "local-direct") {
  setServingContractSnapshotForTest([contractRow(contract)]);
  const intent = intentFor(provider), requestId = randomUUID();
  ledger.pending.mockResolvedValue({ requestId, state: "waiting" });
  return { intent, requestId, workKey: `ai2:3:8:${itemBindingHash(intent.intent.binding)}` };
}

it.each(SHAPES)("a vote on %s waiting on a full model is offered to the next rank once the review wait time is on", async (_name, provider, contract) => {
  setRuntimeSettingsForTest({ version: 1, jobs: { "second-review": { reviewWaitMs: 45_000 } } });
  const { intent, requestId, workKey } = waitingOnFullModel(contract(), provider);
  // 준비가 「준비됨」이어야 이 길이다(준비 실패는 사전 확인 실패 넘김 primary_preflight_failed — 대상 밖). 같은 대기 요청 ID 로 장부에 다시 묻고, 그 요청으로 넘김 TX 를 연다
  expect(await claimSecondReviewModelCapacity(intent)).toEqual({ kind: "capacity_fallback" });
  expect(ledger.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId, provider, model: MODEL, workKey }), { candidateId: 3, vote: 8 });
  expect(ledger.fallback).toHaveBeenCalledExactlyOnceWith(intent, requestId);
});

it.each(SHAPES)("a vote on %s keeps waiting while the review wait time is 0 (the default)", async (_name, provider, contract) => {
  setRuntimeSettingsForTest({});
  const { intent } = waitingOnFullModel(contract(), provider);
  await expect(claimSecondReviewModelCapacity(intent)).rejects.toMatchObject({ reason: "capacity" });
  expect(ledger.request).toHaveBeenCalledOnce(); expect(ledger.fallback).not.toHaveBeenCalled();
});

it("a refused handoff (not waited long enough, no usable next rank, ...) keeps the capacity deferral for every shape", async () => {
  setRuntimeSettingsForTest({ version: 1, jobs: { "second-review": { reviewWaitMs: 45_000 } } });
  for (const [, provider, contract] of SHAPES) {
    ledger.fallback.mockReset().mockResolvedValue(false);
    const { intent, requestId } = waitingOnFullModel(contract(), provider);
    await expect(claimSecondReviewModelCapacity(intent)).rejects.toMatchObject({ reason: "capacity" });
    expect(ledger.fallback).toHaveBeenCalledExactlyOnceWith(intent, requestId);
  }
});

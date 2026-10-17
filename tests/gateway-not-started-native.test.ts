import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createReviewInput, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { itemBindingHash, type Ai1ItemBinding, type Ai2ItemBinding } from "@/lib/jobs/items/types";
import { ai1DispatchBindingHash, ai1ItemDispatchBindingHash, ai1ItemModelDispatchSchema, ai1ModelDispatchSchema,
  ai2DispatchBindingHash, ai2ModelDispatchSchema, gatewayNotStartedEvidenceSchema } from "@/lib/llm/capacity";
import { prepareAi1GatewayCall, prepareAi2GatewayCall, readGatewayNotStarted, reviewWithReservedAi1Gateway,
  reviewWithReservedAi1ItemGateway, reviewWithReservedAi2Gateway, settleAi1GatewayNotStarted, settleAi1ItemGatewayNotStarted,
  settleAi2GatewayNotStarted, type PreparedAi1GatewayCall, type PreparedAi2GatewayCall } from "@/lib/crawl/agent-review-gateway";
import type { Ai1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
import type { Ai2GatewayServingContract } from "@/lib/crawl/second-review-serving-contract";

/**
 * F2 결함 1(게이트웨이판 D5): fetch 를 부르기 전에 포기한 native 호출만 not_started 증인을 낸다. 실제 HTTP 수신 0 을 로컬 서버로 센다.
 * fetch 를 부른 뒤(요청 수신 뒤 abort)는 기존 테스트(agent-review-gateway-capacity·second-review-gateway-native)가 증인 없음을 지킨다.
 */
const fixture = vi.hoisted(() => ({ ai1: null as Ai1GatewayServingContract | null, ai2: null as Ai2GatewayServingContract | null }));
vi.mock("@/lib/crawl/agent-review-serving-contract", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-serving-contract")>(),
  resolveAi1GatewayServingContract: () => fixture.ai1,
}));
vi.mock("@/lib/crawl/second-review-serving-contract", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/second-review-serving-contract")>(),
  resolveAi2GatewayServingContract: () => fixture.ai2,
}));
const model = "[MLX] f2-model";
const outcome = { decision: "approve", reason: "A working task tracker is shown.", evidenceIds: ["product"], confidence: 0.86 };
function input(): ReviewInput {
  const now = new Date("2026-10-17T00:00:00.000Z");
  return createReviewInput({ repo: "native/f2", productUrl: "https://f2.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "native/f2", productUrl: "https://f2.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "F2" }, pageStatus: 200, fetchedAt: now } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
const handle = () => ({ requestId: randomUUID(), owner: { instanceId: "f2-unit", bootId: randomUUID() }, token: randomUUID(),
  epoch: 1, revision: 1, policyHash: "a".repeat(64) });
function ai1Call(value: ReviewInput) {
  const call = prepareAi1GatewayCall(value, { model, timeoutMs: 2_000 });
  if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
  return call;
}
function ai2Call(value: ReviewInput) {
  const call = prepareAi2GatewayCall(value, { model, timeoutMs: 2_000 });
  if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
  return call;
}
function ai1Dispatch(value: ReviewInput, call: PreparedAi1GatewayCall) {
  const binding = { kind: "ai1_legacy_gateway" as const, version: 1 as const, logicalWorkKey: "ai1:1", candidateId: 1, attemptId: 2,
    inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash, reviewPolicyHash: value.policyHash,
    promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion,
    provider: "abcllm" as const, model, routeId: "crawl-agent-review" as const, stageEpoch: 1,
    wireHash: call.wireHash, servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound,
    chargedTokens: call.totalTokenBound, job: { name: "crawl-agent-review" as const, token: randomUUID(), requestedVersion: 1 } };
  return ai1ModelDispatchSchema.parse({ ...handle(), binding, bindingHash: ai1DispatchBindingHash(binding) });
}
function ai1ItemDispatch(value: ReviewInput, call: PreparedAi1GatewayCall) {
  const base = handle();
  const review: Ai1ItemBinding = { stage: "ai1", candidateId: 1, inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash,
    policyHash: value.policyHash, promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion,
    reviewer: { provider: "abcllm", model } };
  const binding = { kind: "ai1_item_gateway" as const, version: 1 as const, logicalWorkKey: "ai1:1", attemptId: 2, review,
    item: { workKey: "ai1:1", owner: base.owner, token: randomUUID(), stageEpoch: 1, itemEpoch: 1, bindingHash: itemBindingHash(review) },
    routeId: "crawl-agent-review" as const, provider: "abcllm" as const, model, wireHash: call.wireHash,
    servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound };
  return ai1ItemModelDispatchSchema.parse({ ...base, binding, bindingHash: ai1ItemDispatchBindingHash(binding) });
}
function ai2Dispatch(value: ReviewInput, call: PreparedAi2GatewayCall) {
  const base = handle();
  const review: Ai2ItemBinding = { stage: "ai2", candidateId: 1, secondReviewId: 3, vote: 3, fallbackForId: null,
    inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash, policyHash: "b".repeat(64), generationKey: "c".repeat(64),
    source: { kind: "first_attempt", firstAttemptId: 2 }, promptVersion: value.snapshot.policy.promptVersion,
    rulesVersion: value.snapshot.policy.rulesVersion, reviewer: { provider: "abcllm", model } };
  const binding = { kind: "ai2_item_gateway" as const, version: 1 as const, logicalWorkKey: "ai2:1:3", review,
    rowIdentityHash: "d".repeat(64), failureCount: 0, inputPolicyHash: value.policyHash,
    item: { workKey: "ai2:3", owner: base.owner, token: randomUUID(), stageEpoch: 1, itemEpoch: 1, bindingHash: itemBindingHash(review) },
    provider: "abcllm" as const, model, routeId: "second-review" as const, wireHash: call.wireHash,
    servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound };
  return ai2ModelDispatchSchema.parse({ ...base, binding, bindingHash: ai2DispatchBindingHash(binding) });
}
async function server(run: (posts: string[]) => Promise<void>) {
  const posts: string[] = [];
  const envelope = { id: "f2", object: "chat.completion", created: 1, model: "native-model",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(outcome) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, usage_provenance: "upstream_reported" };
  const http = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => { posts.push(body); response.end(JSON.stringify(envelope)); });
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  fixture.ai1 = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm", model,
    responseModel: "native-model", endpoint, deploymentRevision: "local-test-only", totalTokenBound: 8_000 };
  fixture.ai2 = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "second-review", provider: "abcllm", model,
    responseModel: "native-model", endpoint, deploymentRevision: "local-test-only", totalTokenBound: 8_000 };
  try { await run(posts); }
  finally {
    fixture.ai1 = null; fixture.ai2 = null; http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
}
afterEach(() => { fixture.ai1 = null; fixture.ai2 = null; vi.unstubAllEnvs(); });
const aborted = () => { const controller = new AbortController(); controller.abort(); return controller.signal; };

it("AI1: an already-aborted caller never calls fetch and receives an original not_started witness bound to the exact dispatch", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async posts => {
    const value = input(), call = ai1Call(value), owned = ai1Dispatch(value, call);
    const response = await reviewWithReservedAi1Gateway(value, owned, call, { signal: aborted() });
    expect(response.result).toEqual({ ok: false, error: "cancelled" }); expect(response.terminal).toBeNull();
    const evidence = readGatewayNotStarted(response.notStarted);
    expect(evidence).toEqual({ version: 1, kind: "gateway_not_started", dispatch: owned });
    expect(gatewayNotStartedEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(readGatewayNotStarted(structuredClone(response.notStarted))).toBeNull();
    expect(readGatewayNotStarted(JSON.parse(JSON.stringify(response.notStarted)))).toBeNull();
    // one-use: 같은 dispatch 는 같은 준비로도 새 준비로도 다시 보낼 수 없다
    await expect(reviewWithReservedAi1Gateway(value, owned, call)).rejects.toThrow("ai1_gateway_call_mismatch");
    await expect(reviewWithReservedAi1Gateway(value, owned, ai1Call(value))).rejects.toThrow("ai1_gateway_call_mismatch");
    expect(settleAi1GatewayNotStarted(call, owned)).toBeNull();
    expect(posts).toHaveLength(0);
  });
});

it("AI1 item and AI2: an already-aborted caller gets not_started without any POST", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async posts => {
    const value = input(), call = ai1Call(value), item = ai1ItemDispatch(value, call);
    const first = await reviewWithReservedAi1ItemGateway(value, item, call, { signal: aborted() });
    expect(first).toMatchObject({ result: { ok: false, error: "cancelled" }, terminal: null });
    expect(readGatewayNotStarted(first.notStarted)).toEqual({ version: 1, kind: "gateway_not_started", dispatch: item });
    await expect(reviewWithReservedAi1ItemGateway(value, item, ai1Call(value))).rejects.toThrow("ai1_item_gateway_call_mismatch");
    const second = ai2Call(value), vote = ai2Dispatch(value, second);
    const result = await reviewWithReservedAi2Gateway(value, vote, second, { signal: aborted() });
    expect(result).toMatchObject({ result: { ok: false, error: "cancelled" }, terminal: null });
    expect(readGatewayNotStarted(result.notStarted)).toEqual({ version: 1, kind: "gateway_not_started", dispatch: vote });
    await expect(reviewWithReservedAi2Gateway(value, vote, ai2Call(value))).rejects.toThrow("ai2_gateway_call_mismatch");
    expect(posts).toHaveLength(0);
  });
});

it("a key removed after preparation keeps not_configured and proves no send", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async posts => {
    const value = input(), call = ai1Call(value), owned = ai1Dispatch(value, call);
    vi.stubEnv("ABCLLM_API_KEY", "");
    const response = await reviewWithReservedAi1Gateway(value, owned, call);
    expect(response.result).toEqual({ ok: false, error: "not_configured" });
    expect(readGatewayNotStarted(response.notStarted)?.dispatch).toEqual(owned);
    expect(posts).toHaveLength(0);
  });
});

it("abandon-side settlement consumes only an unused preparation; after a real send it proves nothing", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async posts => {
    const value = input(), call = ai1Call(value), owned = ai1Dispatch(value, call);
    const witness = settleAi1GatewayNotStarted(call, owned);
    expect(readGatewayNotStarted(witness)).toEqual({ version: 1, kind: "gateway_not_started", dispatch: owned });
    await expect(reviewWithReservedAi1Gateway(value, owned, call)).rejects.toThrow("ai1_gateway_call_mismatch");
    await expect(reviewWithReservedAi1Gateway(value, owned, ai1Call(value))).rejects.toThrow("ai1_gateway_call_mismatch");
    expect(posts).toHaveLength(0);
    const sent = ai1Call(value), real = ai1Dispatch(value, sent);
    expect((await reviewWithReservedAi1Gateway(value, real, sent)).result.ok).toBe(true);
    expect(settleAi1GatewayNotStarted(sent, real)).toBeNull();
    expect(posts).toHaveLength(1);
    // binding 이 이 준비의 wire 를 묶지 않으면 증인을 내지 않는다
    const other = ai1Call(value), foreign = ai1Dispatch(value, other);
    const wrong = ai1ModelDispatchSchema.parse({ ...foreign, binding: { ...foreign.binding, wireHash: "e".repeat(64) },
      bindingHash: ai1DispatchBindingHash({ ...foreign.binding, wireHash: "e".repeat(64) }) });
    expect(() => settleAi1GatewayNotStarted(other, wrong)).toThrow("ai1_gateway_call_mismatch");
    expect(readGatewayNotStarted(settleAi1GatewayNotStarted(other, foreign))?.dispatch).toEqual(foreign);
  });
});

it("abandon-side settlement for AI1 item and AI2 dispatches is one-use per request", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async posts => {
    const value = input(), call = ai1Call(value), item = ai1ItemDispatch(value, call);
    expect(readGatewayNotStarted(settleAi1ItemGatewayNotStarted(call, item))?.dispatch).toEqual(item);
    expect(settleAi1ItemGatewayNotStarted(call, item)).toBeNull();
    expect(() => settleAi1ItemGatewayNotStarted(ai1Call(value), item)).toThrow("ai1_item_gateway_call_mismatch");
    const second = ai2Call(value), vote = ai2Dispatch(value, second);
    expect(readGatewayNotStarted(settleAi2GatewayNotStarted(second, vote))?.dispatch).toEqual(vote);
    expect(() => settleAi2GatewayNotStarted(ai2Call(value), vote)).toThrow("ai2_gateway_call_mismatch");
    await expect(reviewWithReservedAi2Gateway(value, vote, second)).rejects.toThrow("ai2_gateway_call_mismatch");
    expect(posts).toHaveLength(0);
  });
});

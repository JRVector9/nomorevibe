import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ai1DispatchBindingHash, ai1DispatchBindingSchema, websearchQueryDispatchBindingHash, websearchQueryInputHash, websearchQueryLogicalWorkKey,
  type Ai1DispatchBinding, type WebsearchQueryDispatchBinding, type WebsearchQueryMember } from "@/lib/llm/capacity";
import { ai1DirectServingContractSchema, ai1GatewayServingContractHash, ai1GatewayServingContractSchema,
  type Ai1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
import { ai2DirectServingContractSchema, ai2GatewayServingContractHash, type Ai2GatewayServingContract } from "@/lib/crawl/second-review-serving-contract";
import { servingContractHash, validateAdminServingContract } from "@/lib/operations/admin-serving-contracts";

/**
 * PR 3b-C 는 provider 를 넓히고 공통 direct-openai-chat-v1 모양을 들였을 뿐, 저장된 계약·binding 의 hash 는 한 바이트도 바꾸지 않는다.
 * 아래 기대값은 이 PR 직전 코드(origin/claude/stage-lanes 54feb111)로 같은 fixture 를 계산한 값이다 — 칸 순서가 뒤섞인 입력도
 * 스키마 순서로 파싱돼 같은 hash 가 된다. 운영 값이 아니다(모양만 맞춘 고정 fixture).
 */
const BEFORE = {
  ai1: "bf4fb12a99e3a0512e9b6741b86b74f553cb0b40d93ff975e6d454660358ff03",
  ai1Direct: "f65a35f8a9184c57c8525d6df84463b9ab912e10a723cfa41c7740cd42c658c0",
  ai2Legacy: "44159ede961737aafc9474f409c9d576a2c6e1a8b6ba3127a1c34bec4eb94715",
  ai2Budget: "dfb279292d624c5e591585d53acb64f67e09ca45f81a12e5b401b708cec7a38f",
  ai2Direct: "717f00969f06fdcda2662621c4601f8f7581b81407458dca8db7b3e2289fe2d6",
  ai1Binding: "fdb88df78af95e03b70a276411428d1697c1bbfd694660ec5e2865090234b519",
  websearchBinding: "650e133eb91d2b0c341f58772b57f1f6f0148d8fcca55115f39488481388d22c",
} as const;
const ai1 = { totalTokenBound: 131072, endpoint: "https://gateway.example/v1/chat/completions", deploymentRevision: "gateway=abc123;engine=vllm-0.9;C=131072",
  responseModel: "openai/gpt-oss-120b", model: "[MLX] gpt-oss-120b", provider: "abcllm", routeId: "crawl-agent-review", protocol: "abcllm-raw-total-bound-v1", version: 1 };
// The engine-connect shape saved on 2026-10-31 (direct-<equipment>-<engine model>-C<bound>, provider abcllm, admin transport direct).
const ai1Direct = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm", model: "Inferact/Qwen3.8-27B-NVFP4",
  responseModel: "local-llm", deploymentRevision: "direct-gpu3090-Inferact/Qwen3.8-27B-NVFP4-C131072", endpoint: "http://gpu3090.local:8000/v1/chat/completions", totalTokenBound: 131072 };
const ai2Legacy = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "second-review", provider: "abcllm", model: "[MLX] gpt-oss-120b",
  responseModel: "openai/gpt-oss-120b", deploymentRevision: "gateway=abc123", endpoint: "https://gateway.example/v1/chat/completions", totalTokenBound: 131072 };
const ai2Budget = { ...ai2Legacy, requestBudget: { tokenizerModel: "local-engine", tokenizerEndpoint: "http://engine.example:8000/tokenize", maxOutputTokens: 4096, requestTokenBound: 32000 } };
const ai2Direct = { maxOutputTokens: 4096, requestTokenBound: 32000, totalTokenBound: 50000, physicalGroup: "gpu3090", backendId: "gpu3090-qwen",
  tokenizerEndpoint: "http://gpu3090.local:8000/tokenize", endpoint: "http://gpu3090.local:8000/v1/chat/completions", deploymentRevision: "vllm-0.9;C=50000",
  responseModel: "local-llm", model: "Inferact/Qwen3.8-27B-NVFP4", provider: "local-direct", routeId: "second-review", protocol: "ai2-direct-openai-chat-v1", version: 1 };
const h = "a".repeat(64), b = "b".repeat(64);
const ai1Binding = { kind: "ai1_legacy_gateway", version: 1, logicalWorkKey: "ai1:42", candidateId: 42, attemptId: 7, inputHash: h, sourceRevisionHash: b,
  reviewPolicyHash: h, promptVersion: "prompt-v9", rulesVersion: "rules-v4", provider: "abcllm", model: "[MLX] gpt-oss-120b", routeId: "crawl-agent-review",
  stageEpoch: 3, wireHash: b, servingContractHash: h, totalTokenBound: 131072, chargedTokens: 131072,
  job: { name: "crawl-agent-review", token: "11111111-2222-4333-8444-555555555555", requestedVersion: 9 } } as const;
const member: WebsearchQueryMember = { cacheKey: h, sourceLocale: "ko", queryHash: b, promptVersion: 2, glossaryVersion: 1, cache: { kind: "absent" } };
const wsInput = { member, model: "[MLX] gpt-oss-120b" };
const wsBinding = { ...wsInput, kind: "websearch_query_gateway", version: 1, logicalWorkKey: websearchQueryLogicalWorkKey(member),
  inputHash: websearchQueryInputHash(wsInput), provider: "abcllm", routeId: "search-query-translate", wireHash: b, servingContractHash: h,
  totalTokenBound: 8192, chargedTokens: 8192, process: { instanceId: "web-1", bootId: "11111111-2222-4333-8444-555555555555", release: "r1" } } as const;
const adminHash = (route: string, contract: unknown) => {
  const checked = validateAdminServingContract(route, contract);
  if (!checked.ok) throw new Error(checked.reason);
  return servingContractHash(checked.contract);
};

it("keeps every stored gateway, engine-connect and AI2 direct contract hash byte-identical", () => {
  expect(ai1GatewayServingContractHash(ai1 as Ai1GatewayServingContract)).toBe(BEFORE.ai1);
  expect(ai1GatewayServingContractHash(ai1Direct as Ai1GatewayServingContract)).toBe(BEFORE.ai1Direct);
  expect(ai2GatewayServingContractHash(ai2Legacy as Ai2GatewayServingContract)).toBe(BEFORE.ai2Legacy);
  expect(ai2GatewayServingContractHash(ai2Budget as Ai2GatewayServingContract)).toBe(BEFORE.ai2Budget);
  expect(ai2GatewayServingContractHash(ai2Direct as Ai2GatewayServingContract)).toBe(BEFORE.ai2Direct);
  // model_serving_contracts.contract_hash: the admin save hashes the route schema's parse, which the union keeps for raw rows.
  expect(adminHash("crawl-agent-review", ai1)).toBe(BEFORE.ai1);
  expect(adminHash("crawl-agent-review", ai1Direct)).toBe(BEFORE.ai1Direct);
  expect(adminHash("second-review", ai2Budget)).toBe(BEFORE.ai2Budget);
  // The AI2 alias still parses the stored protocol name and keeps its field order.
  expect(ai2DirectServingContractSchema.parse(ai2Direct).protocol).toBe("ai2-direct-openai-chat-v1");
  expect(Object.keys(ai2DirectServingContractSchema.parse(ai2Direct))).toEqual(["version", "protocol", "routeId", "provider", "model", "responseModel",
    "deploymentRevision", "endpoint", "tokenizerEndpoint", "backendId", "physicalGroup", "totalTokenBound", "requestTokenBound", "maxOutputTokens"]);
});

it("keeps stored abcllm dispatch binding hashes byte-identical after the provider enum widening", () => {
  expect(ai1DispatchBindingHash(ai1Binding as unknown as Ai1DispatchBinding)).toBe(BEFORE.ai1Binding);
  expect(websearchQueryDispatchBindingHash(wsBinding as unknown as WebsearchQueryDispatchBinding)).toBe(BEFORE.websearchBinding);
  // The widened enum accepts local-direct; anything else still fails closed.
  expect(ai1DispatchBindingSchema.safeParse({ ...ai1Binding, provider: "local-direct" }).success).toBe(true);
  expect(ai1DispatchBindingSchema.safeParse({ ...ai1Binding, provider: "claude-cli" }).success).toBe(false);
});

it("gives AI1 the same direct-openai-chat-v1 shape as AI2 and accepts both AI1 shapes in the route schema", () => {
  const direct = { ...ai2Direct, routeId: "crawl-agent-review", protocol: "direct-openai-chat-v1" };
  const parsed = ai1GatewayServingContractSchema.parse(direct);
  expect(parsed).toEqual(ai1DirectServingContractSchema.parse(direct));
  expect(Object.keys(parsed)).toEqual(Object.keys(ai2DirectServingContractSchema.parse(ai2Direct)));
  expect(ai1GatewayServingContractHash(parsed)).toBe(createHash("sha256").update(JSON.stringify(parsed)).digest("hex"));
  // AI2's legacy protocol name stays AI2's; AI1 has only the shared name. The AI2 alias accepts the shared name too.
  expect(ai1GatewayServingContractSchema.safeParse({ ...direct, protocol: "ai2-direct-openai-chat-v1" }).success).toBe(false);
  expect(ai2DirectServingContractSchema.safeParse({ ...ai2Direct, protocol: "direct-openai-chat-v1" }).success).toBe(true);
  expect(validateAdminServingContract("crawl-agent-review", direct)).toMatchObject({ ok: true });
  // A raw AI1 contract may now name local-direct (an engine served without the gateway) — still the same raw shape and order.
  expect(Object.keys(ai1GatewayServingContractSchema.parse({ ...ai1Direct, provider: "local-direct" }))).toEqual(Object.keys(ai1GatewayServingContractSchema.parse(ai1)));
  expect(ai1GatewayServingContractSchema.safeParse({ ...ai1, provider: "claude-cli" }).success).toBe(false);
  // The direct tokenizer must be the chat endpoint's origin.
  expect(ai1GatewayServingContractSchema.safeParse({ ...direct, tokenizerEndpoint: "http://other.local:8000/tokenize" }).success).toBe(false);
});

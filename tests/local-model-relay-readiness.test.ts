import { describe, expect, it } from "vitest";
import { relayNativeReadinessVerifier, relayUpstreamModels } from "../scripts/local-model-relay/readiness";
import { localModelContractHash, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import type { RelayReadinessContext } from "../scripts/local-model-relay/protocol";

// The registry's default M1 relay entry; Qwen is the old M1 id that must no longer pass.
const GEMMA = "mlx-community--gemma-4-26b-a4b-it-4bit", QWEN = "qwen3.8-flash-next";
const contract: LocalModelServingContract = { version: 1, protocol: "local-openai-chat-v1", backendId: "m1-gemma", provider: "local-direct",
  physicalGroup: "m1", endpoint: "http://100.64.0.2:8792/v1/chat/completions", model: GEMMA, responseModel: GEMMA,
  modelFamily: "gemma4-26b", deploymentRevision: "m1-test-q4", contextWindowTokens: 32000, totalTokenBound: 32000,
  maxOutputTokens: 1024, maxInputBytes: 100000, capabilities: { vision: true, jsonSchema: true },
  thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } };
const context: RelayReadinessContext = { upstreamModels: [contract.model], model: contract.model, deploymentRevision: contract.deploymentRevision, relayRevision: "a".repeat(40),
  activeRequestId: null, indeterminate: false, lastReceipt: { protocol: 1, requestId: "7ba847b7-6e18-4750-8312-2315859dcb98",
    relayGeneration: "generation", relayRevision: "a".repeat(40), deploymentRevision: contract.deploymentRevision, requestModel: contract.model,
    requestHash: "b".repeat(64), startedAt: "2026-10-23T00:00:00Z", endedAt: "2026-10-23T00:00:01Z", state: "response_complete",
    upstreamStatus: 200, responseHash: "c".repeat(64), responseBytes: 123, error: null,
    terminal: { models: [contract.model], finishReasons: ["stop"], usage: { total_tokens: 100 }, streamDone: false, observerComplete: true } } };
const env = { LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([contract]),
  LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: JSON.stringify({ [contract.backendId]: localModelContractHash(contract) }) };
describe("실행 entry의 native 준비 확인", () => {
  it("exact readback hash와 실제 같은 deployment의 정상 응답을 모두 요구한다", () => {
    expect(relayNativeReadinessVerifier(contract.endpoint, env)(context).ready).toBe(true);
    expect(relayNativeReadinessVerifier(contract.endpoint, {})(context).ready).toBe(false);
    expect(relayNativeReadinessVerifier(contract.endpoint, { ...env, LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: "{}" })(context).ready).toBe(false);
  });
  it("배포 변경·unknown·실제 관측 누락은 준비로 승격하지 않는다", () => {
    const verify = relayNativeReadinessVerifier(contract.endpoint, env);
    for (const changed of [{ ...context, deploymentRevision: "new" }, { ...context, indeterminate: true },
      { ...context, activeRequestId: "running" }, { ...context, lastReceipt: null }]) expect(verify(changed).ready).toBe(false);
    expect(verify({ ...context, lastReceipt: { ...context.lastReceipt!, terminal: { ...context.lastReceipt!.terminal!, usage: { total_tokens: 32001 } } } }).ready).toBe(false);
  });
});

it("requires a fresh exact upstream model id, never an alias or missing observation", () => {
  const verify = relayNativeReadinessVerifier(contract.endpoint, env);
  for (const upstreamModels of [undefined, null, [], ["different-model"], [QWEN], ["[m1] " + contract.model]])
    expect(verify({ ...context, upstreamModels }).ready).toBe(false);
  expect(verify({ ...context, upstreamModels: [contract.model] }).ready).toBe(true);
});
it("uses the configured Gemma identity and family from the same registry", () => {
  const model = "mlx-community--gemma-4-26b-a4b-it-4bit";
  const gemma = { ...contract, model, responseModel: model, modelFamily: "gemma4-26b" };
  const configuration = { LOCAL_MODEL_RELAY_MODEL: model, LOCAL_MODEL_RELAY_MODEL_FAMILY: gemma.modelFamily,
    LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([gemma]),
    LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: JSON.stringify({ [gemma.backendId]: localModelContractHash(gemma) }) };
  const observation = { ...context, model, upstreamModels: [model], lastReceipt: { ...context.lastReceipt!, requestModel: model,
    terminal: { ...context.lastReceipt!.terminal!, models: [model] } } };
  expect(relayNativeReadinessVerifier(gemma.endpoint, configuration)(observation).ready).toBe(true);
  expect(relayNativeReadinessVerifier(gemma.endpoint, configuration)({ ...observation, upstreamModels: [QWEN] }).ready).toBe(false);
  expect(relayNativeReadinessVerifier(gemma.endpoint, { ...configuration, LOCAL_MODEL_RELAY_MODEL_FAMILY: QWEN })(observation).ready).toBe(false);
});
it("reads only bounded successful upstream model lists with no redirect", async () => {
  for (const body of [{ data: [{ id: contract.model }] }, { data: [] }, { data: [{}] }, { data: "bad" }]) {
    const request: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:8000/v1/models"); expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify(body));
    };
    expect(await relayUpstreamModels("test-only-token", request)).toEqual(Array.isArray(body.data) && body.data.length && "id" in body.data[0] ? [contract.model] : null);
  }
  expect(await relayUpstreamModels("test-only-token", async () => new Response("x".repeat(100001)))).toBeNull();
  expect(await relayUpstreamModels("test-only-token", async () => new Response("{}", { status: 503 }))).toBeNull();
  expect(await relayUpstreamModels("test-only-token", async () => { throw Error("offline"); })).toBeNull();
});

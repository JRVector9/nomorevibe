import { describe, expect, it } from "vitest";
import { relayNativeReadinessVerifier } from "../scripts/local-model-relay/readiness";
import { localModelContractHash, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import type { RelayReadinessContext } from "../scripts/local-model-relay/protocol";

const contract: LocalModelServingContract = { version: 1, protocol: "local-openai-chat-v1", backendId: "m1-qwen", provider: "local-direct",
  physicalGroup: "m1", endpoint: "http://100.64.0.2:8792/v1/chat/completions", model: "qwen3.8-flash-next", responseModel: "qwen3.8-flash-next",
  modelFamily: "qwen3.8-flash-next", deploymentRevision: "m1-test-q4", contextWindowTokens: 32000, totalTokenBound: 32000,
  maxOutputTokens: 1024, maxInputBytes: 100000, capabilities: { vision: true, jsonSchema: true },
  thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } };
const context: RelayReadinessContext = { model: contract.model, deploymentRevision: contract.deploymentRevision, relayRevision: "a".repeat(40),
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

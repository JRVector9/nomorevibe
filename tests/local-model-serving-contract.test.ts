import { describe, expect, it } from "vitest";
import { localModelContractHash, localModelServingContractSchema, localModelServingContractsSchema,
  localModelThinkingFields, resolveLocalModelServingContract, sameLocalModelFamily, validateLocalModelRequest,
  type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";

const contract: LocalModelServingContract = { version: 1, protocol: "local-openai-chat-v1", backendId: "gpu-qwen", provider: "local-direct",
  physicalGroup: "gpu3090", endpoint: "http://127.0.0.1:8090/v1/chat/completions", model: "qwen3.8-flash-next",
  responseModel: "qwen3.8-flash-next", modelFamily: "qwen3.8-flash-next", deploymentRevision: "frozen-test-1",
  contextWindowTokens: 50000, totalTokenBound: 50000, maxOutputTokens: 1024, maxInputBytes: 65536,
  capabilities: { vision: true, jsonSchema: true }, thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" },
  termination: { kind: "response_only" } };

describe("local serving contract", () => {
  it("rejects invented lower C, credential URLs, unknown wire and incompatible thinking", () => {
    for (const invalid of [{ ...contract, totalTokenBound: 1024 }, { ...contract, maxOutputTokens: 60000 },
      { ...contract, endpoint: "http://user:secret@localhost:8090/v1/chat/completions" },
      { ...contract, endpoint: "http://localhost:8090/admin" }, { ...contract, protocol: "abcllm-raw-total-bound-v1" },
      { ...contract, provider: "abcllm" }, { ...contract, thinking: { mode: "low", parameter: "enable_thinking" } },
      { ...contract, termination: { kind: "provider_hard_deadline" } }, { ...contract, apiKey: "must-not-be-stored" }]) {
      expect(localModelServingContractSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it("does not infer readiness or a default backend from missing or invalid config", () => {
    expect(resolveLocalModelServingContract("gpu-qwen", {})).toBeNull();
    expect(resolveLocalModelServingContract("gpu-qwen", { LOCAL_MODEL_SERVING_CONTRACTS: "{" })).toBeNull();
    const env = { LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([contract]) };
    expect(resolveLocalModelServingContract("unknown", env)).toBeNull();
    expect(resolveLocalModelServingContract("gpu-qwen", env)).toEqual(contract);
    expect(localModelServingContractsSchema.safeParse([contract, contract]).success).toBe(false);
    expect(localModelServingContractsSchema.safeParse([contract, { ...contract, backendId: "alias", physicalGroup: "other" }]).success).toBe(false);
  });
  it("hashes physical/backend/quantization settings while keeping model family independent of device", () => {
    const m1 = { ...contract, backendId: "m1-qwen", physicalGroup: "m1", deploymentRevision: "m1-q4e" };
    expect(sameLocalModelFamily(contract, m1)).toBe(true);
    expect(localModelContractHash(contract)).not.toBe(localModelContractHash(m1));
    expect(localModelContractHash(contract)).toBe(localModelContractHash(Object.fromEntries(Object.entries(contract).reverse()) as LocalModelServingContract));
    expect(localModelContractHash({ ...contract, capabilities: { ...contract.capabilities, vision: false } })).not.toBe(localModelContractHash(contract));
  });
  it("maps only the actual backend thinking controls and refuses unsupported requests", () => {
    expect(localModelThinkingFields(contract)).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(localModelThinkingFields({ ...contract, thinking: { mode: "disabled", parameter: "enable_thinking" } })).toEqual({ enable_thinking: false });
    expect(localModelThinkingFields({ ...contract, thinking: { mode: "low", parameter: "reasoning_effort" } })).toEqual({ reasoning_effort: "low" });
    const request = { model: contract.model, inputBytes: 1000, estimatedInputTokens: 500, maxOutputTokens: 100 };
    expect(validateLocalModelRequest(contract, request)).toEqual({ ok: true });
    for (const invalid of [{ ...request, model: "alias" }, { ...request, inputBytes: 70000 }, { ...request, estimatedInputTokens: 50000 },
      { ...request, maxOutputTokens: 0 }, { ...request, maxOutputTokens: NaN }]) expect(validateLocalModelRequest(contract, invalid).ok).toBe(false);
    expect(validateLocalModelRequest({ ...contract, capabilities: { vision: false, jsonSchema: true } }, { ...request, vision: true }).ok).toBe(false);
  });
});

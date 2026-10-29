import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
import { ai2DirectServingContractsFromConfig, ai2ServingContractMatches, selectAi2ServingContract,
  type Ai2DirectServingContract } from "@/lib/crawl/second-review-serving-contract";
import { sameUnderlyingModel } from "@/lib/crawl/review-model-identity";

afterEach(() => vi.unstubAllEnvs());
it("selects separate native device contracts with the same wire model only by equipment key", () => {
  const gpu: Ai2DirectServingContract = { version: 1, protocol: "ai2-direct-openai-chat-v1", routeId: "second-review", provider: "local-direct",
    model: "same-model", responseModel: "same-model", deploymentRevision: "gpu-revision", endpoint: "http://gpu.example/v1/chat/completions",
    tokenizerEndpoint: "http://gpu.example/tokenize", backendId: "gpu", physicalGroup: "gpu", totalTokenBound: 98304,
    requestTokenBound: 32000, maxOutputTokens: 10000 };
  const m1 = { ...gpu, endpoint: "http://m1.example/v1/chat/completions", tokenizerEndpoint: "http://m1.example/tokenize",
    backendId: "m1", physicalGroup: "m1", deploymentRevision: "m1-revision" };
  vi.stubEnv("MODEL_REGISTRY_CONFIG", JSON.stringify({ version: 1, models: [
    { ...DEFAULT_MODEL_DEFINITIONS[0], model: "same-model", baseUrl: "http://gpu.example/v1" },
    { ...DEFAULT_MODEL_DEFINITIONS[0], key: "m1:review", equipment: "m1", model: "same-model", baseUrl: "http://m1.example/v1" },
  ] }));
  const contracts = [...ai2DirectServingContractsFromConfig(JSON.stringify({ version: 1, contracts: [gpu, m1] })).values()];
  expect(contracts).toHaveLength(2);
  expect(selectAi2ServingContract(contracts, "gpu3090:review", "local-direct")).toEqual(gpu);
  expect(selectAi2ServingContract(contracts, "m1:review", "local-direct")).toEqual(m1);
  expect(selectAi2ServingContract(contracts, "same-model", "local-direct")).toBeNull();
  expect(selectAi2ServingContract(contracts, "m1:review", "abcllm")).toBeNull();
  expect(ai2ServingContractMatches(gpu, "m1:review")).toBe(false);
  expect(ai2ServingContractMatches({ ...gpu, maxOutputTokens: 10001 }, "gpu3090:review")).toBe(false);
  expect(ai2DirectServingContractsFromConfig(JSON.stringify({ version: 1, contracts: [{ ...gpu, maxOutputTokens: 9000 }] })).size).toBe(1);
  expect(ai2DirectServingContractsFromConfig(JSON.stringify({ version: 1, contracts: [{ ...gpu, maxOutputTokens: 32001 }] })).size).toBe(0);
  expect(sameUnderlyingModel("gpu3090:review", "m1:review")).toBe(true);
  expect(sameUnderlyingModel("gpu3090:review", "[m1] same-model")).toBe(true);
});

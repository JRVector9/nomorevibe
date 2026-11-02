import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
import { ai2DirectServingContractSchema, ai2GatewayServingContractSchema, ai2ServingContractMatches, resolveAi2GatewayServingContract,
  selectAi2ServingContract, type Ai2DirectServingContract } from "@/lib/crawl/second-review-serving-contract";
import { sameUnderlyingModel } from "@/lib/crawl/review-model-identity";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";

afterEach(() => { vi.unstubAllEnvs(); setServingContractSnapshotForTest(null); });
const gpu: Ai2DirectServingContract = { version: 1, protocol: "ai2-direct-openai-chat-v1", routeId: "second-review", provider: "local-direct",
  model: "same-model", responseModel: "same-model", deploymentRevision: "gpu-revision", endpoint: "http://gpu.example/v1/chat/completions",
  tokenizerEndpoint: "http://gpu.example/tokenize", backendId: "gpu", physicalGroup: "gpu", totalTokenBound: 98304,
  requestTokenBound: 32000, maxOutputTokens: 10000 };
const m1 = { ...gpu, endpoint: "http://m1.example/v1/chat/completions", tokenizerEndpoint: "http://m1.example/tokenize",
  backendId: "m1", physicalGroup: "m1", deploymentRevision: "m1-revision" };

it("selects separate native device contracts with the same wire model only by equipment key", () => {
  vi.stubEnv("MODEL_REGISTRY_CONFIG", JSON.stringify({ version: 1, models: [
    { ...DEFAULT_MODEL_DEFINITIONS[0], model: "same-model", baseUrl: "http://gpu.example/v1" },
    { ...DEFAULT_MODEL_DEFINITIONS[0], key: "m1:review", equipment: "m1", model: "same-model", baseUrl: "http://m1.example/v1" },
  ] }));
  const contracts = [gpu, m1].map(value => ai2DirectServingContractSchema.parse(value));
  expect(contracts).toHaveLength(2);
  expect(selectAi2ServingContract(contracts, "gpu3090:review", "local-direct")).toEqual(gpu);
  expect(selectAi2ServingContract(contracts, "m1:review", "local-direct")).toEqual(m1);
  expect(selectAi2ServingContract(contracts, "same-model", "local-direct")).toBeNull();
  expect(selectAi2ServingContract(contracts, "m1:review", "abcllm")).toBeNull();
  expect(ai2ServingContractMatches(gpu, "m1:review")).toBe(false);
  expect(ai2ServingContractMatches({ ...gpu, maxOutputTokens: 10001 }, "gpu3090:review")).toBe(false);
  // 계약 모양 검사(예전 env 해석 자리): 출력 상한은 요청 상한 32,000 을 넘지 못한다
  expect(ai2DirectServingContractSchema.safeParse({ ...gpu, maxOutputTokens: 9000 }).success).toBe(true);
  expect(ai2DirectServingContractSchema.safeParse({ ...gpu, maxOutputTokens: 32001 }).success).toBe(false);
  expect(sameUnderlyingModel("gpu3090:review", "m1:review")).toBe(true);
  expect(sameUnderlyingModel("gpu3090:review", "[m1] same-model")).toBe(true);
});

it("AI2 계약은 DB 행만 읽는다 — 직접 계약(local-direct)과 abcllm 형(engineModel 포함) 둘 다 받고 env AI2_DIRECT_SERVING_CONTRACTS 는 읽지 않는다", () => {
  vi.stubEnv("AI2_DIRECT_SERVING_CONTRACTS", JSON.stringify({ version: 1, contracts: [gpu] }));
  setServingContractSnapshotForTest([]);
  expect(resolveAi2GatewayServingContract("same-model", "local-direct")).toBeNull();

  const raw = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "second-review", provider: "abcllm", model: "qwen-review@0a1b2c3d",
    engineModel: "qwen-review", responseModel: "qwen-review", deploymentRevision: "rev-1", endpoint: "http://engine.example/v1/chat/completions",
    totalTokenBound: 65536 };
  expect(ai2GatewayServingContractSchema.safeParse(raw).success).toBe(true);
  setServingContractSnapshotForTest([
    { routeId: "second-review", model: gpu.model, contract: gpu, auth: "none", apiKey: null, transport: "direct" },
    { routeId: "second-review", model: raw.model, contract: raw, auth: "none", apiKey: null, transport: "direct" },
  ]);
  expect(resolveAi2GatewayServingContract("same-model", "local-direct")).toEqual(gpu);
  expect(resolveAi2GatewayServingContract("qwen-review@0a1b2c3d", "abcllm")).toMatchObject({ provider: "abcllm", engineModel: "qwen-review" });
  // 공급자가 다르면 열지 않는다
  expect(resolveAi2GatewayServingContract("same-model", "abcllm")).toBeNull();
  expect(resolveAi2GatewayServingContract("qwen-review@0a1b2c3d", "local-direct")).toBeNull();
});

import { afterEach, expect, it } from "vitest";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { localModelContractHash, localModelServingContractSchema, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { verifiedLocalModelContract } from "@/lib/llm/local-model-capacity";
import { localModelCapacityReadiness } from "@/lib/llm/local-model-capacity-readiness";
import { localModelContractRouteId, tableLocalModelContract } from "@/lib/llm/local-model-contract-table";

/** PR 3b-C: local-openai-chat-v1 계약을 관리 화면 계약 표에서 먼저 읽고, 그 주소·모델의 행이 없을 때만 env 를 예전과 똑같이 본다. */
const contract = localModelServingContractSchema.parse({ version: 1, protocol: "local-openai-chat-v1", backendId: "fixture-gpu",
  provider: "local-direct", physicalGroup: "shared-device", endpoint: "http://fixture.invalid/v1/chat/completions", model: "qwen", responseModel: "qwen",
  modelFamily: "qwen3.8-flash-next", deploymentRevision: "pinned", contextWindowTokens: 8192, totalTokenBound: 8192,
  maxOutputTokens: 512, maxInputBytes: 100_000, capabilities: { vision: true, jsonSchema: true },
  thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } });
const env = (value: LocalModelServingContract = contract) => ({ LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([value]),
  LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: JSON.stringify({ [value.backendId]: localModelContractHash(value) }),
  LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ [value.physicalGroup]: 1 }) });
const row = (value: Record<string, unknown>, routeId = localModelContractRouteId(String(value.backendId))) =>
  ({ routeId, model: String(value.model), contract: { ...value, routeId }, auth: "none" as const, apiKey: null, transport: "direct" as const });
const policy = { version: 1 as const, maxWaiting: 20, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "local-audit", provider: "local-direct", model: "qwen", providerBudgetId: "fixture-gpu", groupId: "shared-device" }] };
afterEach(() => setServingContractSnapshotForTest(null));

it("keeps the env-only behaviour identical when the table has no local contract row", () => {
  for (const rows of [null, [], [{ routeId: "crawl-agent-review", model: "qwen", contract: { protocol: "abcllm-raw-total-bound-v1" },
    auth: "gateway" as const, apiKey: null }]]) {
    setServingContractSnapshotForTest(rows);
    expect(tableLocalModelContract(contract.endpoint, contract.model)).toBeUndefined();
    expect(verifiedLocalModelContract(contract.endpoint, contract.model, env())).toEqual(contract);
    // Unverified env stays closed, exactly as before.
    expect(verifiedLocalModelContract(contract.endpoint, contract.model, { ...env(), LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: undefined })).toBeNull();
    expect(verifiedLocalModelContract(contract.endpoint, contract.model, {})).toBeNull();
  }
});

it("reads a table row first, with the same contract hash as the env declaration and no env needed", () => {
  setServingContractSnapshotForTest([row(contract)]);
  const read = verifiedLocalModelContract(contract.endpoint, contract.model, {});
  expect(read).toEqual(contract);
  expect(localModelContractHash(read!)).toBe(localModelContractHash(contract));
  // The table row replaces a different env declaration of the same address and model.
  const older = { ...contract, deploymentRevision: "older-env" };
  expect(verifiedLocalModelContract(contract.endpoint, contract.model, env(older))).toEqual(contract);
  // Another address or model still falls back to env.
  const other = { ...contract, backendId: "other-gpu", endpoint: "http://other.invalid/v1/chat/completions" };
  expect(verifiedLocalModelContract(other.endpoint, other.model, env(other))).toEqual(other);
  expect(localModelCapacityReadiness(policy, { LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ "shared-device": 1 }) }).localRoutes)
    .toEqual([{ routeId: "local-audit", backendId: "fixture-gpu", physicalGroup: "shared-device", ready: true }]);
});

it("closes a malformed, misplaced or conflicting table row instead of falling back to env", () => {
  for (const rows of [
    [row({ ...contract, totalTokenBound: 4096 })],
    [row(contract, "local-model:another-backend")],
    [row({ ...contract, provider: "abcllm" })],
    [row(contract), row({ ...contract, backendId: "twin-gpu", physicalGroup: "other-device" })],
  ]) {
    setServingContractSnapshotForTest(rows);
    expect(verifiedLocalModelContract(contract.endpoint, contract.model, env())).toBeNull();
  }
});

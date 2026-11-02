import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
import { aiTaskAliasIdentity } from "@/lib/llm/ai-tasks";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { pinTextRanks, textContract, textRankRow } from "./text-task-ranks-fixture";
vi.mock("@/lib/llm/text-capacity-admission", () => ({ assertTextModelAdmission: async () => {} }));
const servers: http.Server[] = [];
const GPU_CONNECTION = "0b0c0d0e-0000-4000-8000-0000000030a0";
afterEach(async () => {
  vi.unstubAllEnvs();
  pinTextRanks(null); setServingContractSnapshotForTest(null);
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
async function start() {
  const requests: { url: string; model: unknown; maxTokens: unknown }[] = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    requests.push({ url: request.url!, model: data.model, maxTokens: data.max_tokens });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: '["Doc manages documents"]' } }] }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_listen_failed");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}
/**
 * The legacy gateway sender is gone (2026-10-30) and product-translate has no env selector any more (2026-10-31): the registry
 * (purposes, selections) alone describes M1 translation, and the legacy sender reaches neither device.
 * 2026-11-02(PR B): 실제로 부르는 연결·모델은 「작업 ↔ 모델」 순위가 고른다 — 같은 모델 이름을 GPU3090 도 내놓아도 순위의 연결(M1)을 가리키는
 * 계약에 묶이고, 등록부·환경변수는 그것을 바꾸지 않는다. wire 의 max_tokens 는 경로 한도만 본다(장비 정의의 상한은 읽지 않는다).
 */
it.each([
  ["registry purpose", {}, {}],
  ["registry selection", { selections: { "product-translate": "m1:translation" } }, {}],
  ["ignored env key", {}, { PRODUCT_TRANSLATION_MODEL_KEY: "gpu3090:review" }],
  ["ignored env label", {}, { PRODUCT_TRANSLATION_MODEL: "[supa] Qwen3.8-27B-NVFP4" }],
] as const)("routes M1 translation by %s to M1 when GPU3090 offers qwen3.8-flash-next too", async (_label, registryExtra, env) => {
  const m1 = await start(), gpu = await start();
  vi.stubEnv("ABCLLM_BASE_URL", undefined);
  vi.stubEnv("ABCLLM_API_KEY", "ignored-gateway-key");
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL_KEY", undefined);
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", undefined);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("MODEL_REGISTRY_CONFIG", JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(model =>
    model.key === "gpu3090:review" ? { ...model, model: "qwen3.8-flash-next", baseUrl: gpu.baseUrl }
      : model.key === "m1:translation" ? { ...model, model: "qwen3.8-flash-next", baseUrl: m1.baseUrl, maxTokens: 700 } : model), ...registryExtra }));
  // 순위: 제품 번역 1순위 = M1 연결의 qwen3.8-flash-next. GPU3090 연결에도 같은 모델의 계약이 있다(연결로 가른 장부 이름).
  const gpuIdentity = aiTaskAliasIdentity("qwen3.8-flash-next", GPU_CONNECTION)!;
  setServingContractSnapshotForTest([textContract("product-translate", "qwen3.8-flash-next", { baseUrl: m1.baseUrl }),
    textContract("product-translate", gpuIdentity, { baseUrl: gpu.baseUrl, engineModel: "qwen3.8-flash-next" })]);
  pinTextRanks([textRankRow("product-translate", "qwen3.8-flash-next", { baseUrl: m1.baseUrl, label: "m1", deviceId: "m1" })]);
  vi.resetModules();
  const { productTranslationGatewayWire, translateProductFields } = await import("@/lib/crawl/translate");
  const { configuredModelRoute } = await import("@/lib/llm/model-registry");
  const { qwenDirectConfig } = await import("@/lib/crawl/qwen-direct-review");
  const { TextTaskRanks } = await import("@/lib/llm/ai-task-resolver");
  const { textTaskModel } = await import("@/lib/llm/ai-task-rank-scope");
  expect(qwenDirectConfig()?.baseUrl).toBe(gpu.baseUrl);
  const items = [{ name: "Doc", text: "문서 관리 도구", locale: "en" as const, field: "tagline" as const }];
  expect(configuredModelRoute("product-translate")).toMatchObject({ key: "m1:translation", equipment: "m1", requestModel: "[m1] qwen3.8-flash-next",
    baseUrl: m1.baseUrl });
  const ranks = await TextTaskRanks.open("product-translate");
  expect(ranks.bindings()).toEqual([expect.objectContaining({ rank: 1, identity: "qwen3.8-flash-next", engineModel: "qwen3.8-flash-next", deviceId: "m1" })]);
  const served = await ranks.run(async () => {
    const model = textTaskModel("product-translate");
    // The wire the engine contract path sends carries the rank's model and the route's output budget.
    expect(JSON.parse(productTranslationGatewayWire(items, model))).toMatchObject({ model: "qwen3.8-flash-next", max_tokens: 616 });
    return translateProductFields(items, 1000, undefined, undefined, model);
  });
  expect(served).toMatchObject({ kind: "served", value: { ok: false, error: "no_key" } });
  expect(m1.requests).toEqual([]);
  expect(gpu.requests).toEqual([]);
});

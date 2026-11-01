import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
vi.mock("@/lib/llm/text-capacity-admission", () => ({ assertTextModelAdmission: async () => {} }));
const servers: http.Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
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
 * (purposes, selections) alone routes M1 translation, and the legacy sender reaches neither device.
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
  vi.resetModules();
  const { PRODUCT_TRANSLATE_MODEL, productTranslationGatewayWire, translateProductFields } = await import("@/lib/crawl/translate");
  const { configuredModelRoute } = await import("@/lib/llm/model-registry");
  const { qwenDirectConfig } = await import("@/lib/crawl/qwen-direct-review");
  expect(qwenDirectConfig()?.baseUrl).toBe(gpu.baseUrl);
  const items = [{ name: "Doc", text: "문서 관리 도구", locale: "en" as const, field: "tagline" as const }];
  expect(configuredModelRoute("product-translate")).toMatchObject({ key: "m1:translation", equipment: "m1", requestModel: "[m1] qwen3.8-flash-next",
    baseUrl: m1.baseUrl });
  // The wire the engine contract path sends carries M1's request name and M1's output ceiling.
  expect(PRODUCT_TRANSLATE_MODEL).toBe("[m1] qwen3.8-flash-next");
  expect(JSON.parse(productTranslationGatewayWire(items, PRODUCT_TRANSLATE_MODEL))).toMatchObject({ model: "[m1] qwen3.8-flash-next", max_tokens: 616 });
  expect(await translateProductFields(items, 1000)).toEqual({ ok: false, error: "no_key" });
  expect(m1.requests).toEqual([]);
  expect(gpu.requests).toEqual([]);
});

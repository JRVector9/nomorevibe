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
it("sends M1 translation to the selected equipment endpoint when GPU3090 offers the identical model name", async () => {
  const m1 = await start(), gpu = await start();
  vi.stubEnv("ABCLLM_BASE_URL", undefined);
  vi.stubEnv("ABCLLM_API_KEY", "local-fixture-only");
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", undefined);
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL_KEY", "m1:translation");
  vi.stubEnv("MODEL_REGISTRY_CONFIG", JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(model =>
    model.key === "gpu3090:review" ? { ...model, model: "same-model", baseUrl: gpu.baseUrl }
      : model.key === "m1:translation" ? { ...model, model: "same-model", baseUrl: m1.baseUrl, maxTokens: 700 } : model) }));
  vi.resetModules();
  const { translateProductFields } = await import("@/lib/crawl/translate");
  const { qwenDirectConfig } = await import("@/lib/crawl/qwen-direct-review");
  expect(qwenDirectConfig()?.baseUrl).toBe(gpu.baseUrl);
  const result = await translateProductFields([{ name: "Doc", text: "문서 관리 도구", locale: "en", field: "tagline" }], 1000);
  expect(result.ok).toBe(true);
  expect(m1.requests).toEqual([{ url: "/v1/chat/completions", model: "[m1] same-model", maxTokens: 616 }]);
  expect(gpu.requests).toEqual([]);
});

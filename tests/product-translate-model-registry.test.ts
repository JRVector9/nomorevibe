import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_DEFINITIONS, configuredModel, configuredModelDefinition, configuredModelRoute,
  type ModelDefinition } from "@/lib/llm/model-registry";

vi.mock("@/lib/llm/text-capacity-admission", () => ({ assertTextModelAdmission: async () => {} }));

const GEMMA = "mlx-community--gemma-4-26b-a4b-it-4bit";
const m1 = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === "m1:translation")!;
const supa = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === "supa:review")!;
const gpu = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === "gpu3090:review")!;
const registry = (models: readonly ModelDefinition[], extra: object = {}) => ({ MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models, ...extra }) });
/** The full default registry with some entries replaced by key and new entries appended, as an operator edit would be. */
const edited = (changes: readonly ModelDefinition[]) => [...DEFAULT_MODEL_DEFINITIONS.map(model => changes.find(change => change.key === model.key) ?? model),
  ...changes.filter(change => !DEFAULT_MODEL_DEFINITIONS.some(model => model.key === change.key))];
/** The same weights on M1 (gateway label m1), Supa (label supa) and GPU3090 (direct, no label). */
const triplets = (purposes: { supa?: string[] } = {}) => [
  { ...m1, model: "shared-weights", family: "shared" },
  { ...supa, key: "supa:translation", model: "shared-weights", family: "shared", purposes: purposes.supa ?? ["ai1-preset"] },
  { ...gpu, model: "shared-weights", family: "shared" },
];

const servers: http.Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe("product translation reads model, equipment and route from the registry", () => {
  it("defaults to the actual M1 Gemma entry through the M1 gateway label", () => {
    expect(configuredModelRoute("product-translate", {})).toEqual({ routeId: "product-translate", key: "m1:translation", equipment: "m1",
      provider: "abcllm", requestModel: `[m1] ${GEMMA}`, baseUrl: m1.baseUrl });
    expect(configuredModelRoute("product-translate", { PRODUCT_TRANSLATION_MODEL_KEY: "m1:translation", PRODUCT_TRANSLATION_MODEL: "[m1] obsolete" }).requestModel)
      .toBe(`[m1] ${GEMMA}`);
  });

  it("replaces the stale [m1] Qwen route with the model the registry assigns to M1", () => {
    expect(configuredModel("product-translate", { PRODUCT_TRANSLATION_MODEL: "[m1] qwen3.8-flash-next" })).toBe(`[m1] ${GEMMA}`);
    expect(configuredModelDefinition("product-translate", { PRODUCT_TRANSLATION_MODEL: "[m1] qwen3.8-flash-next" }).key).toBe("m1:translation");
    // A label for other equipment is an explicit route choice and stays as given (compatibility), never silently moved to M1.
    expect(configuredModel("product-translate", { PRODUCT_TRANSLATION_MODEL: "[supa] unregistered-model" })).toBe("[supa] unregistered-model");
    expect(configuredModel("product-translate", { PRODUCT_TRANSLATION_MODEL: "[other] unregistered-model" })).toBe("[other] unregistered-model");
  });

  it("resolves a model name shared by several devices by the registry route, and fails closed when the route is ambiguous", () => {
    const routed = registry(triplets());
    expect(configuredModelRoute("product-translate", { ...routed, PRODUCT_TRANSLATION_MODEL: "shared-weights" })).toMatchObject({
      key: "m1:translation", equipment: "m1", requestModel: "[m1] shared-weights" });
    expect(configuredModel("product-translate", { ...routed, PRODUCT_TRANSLATION_MODEL: "[supa] shared-weights" })).toBe("[supa] shared-weights");
    const twoServers = registry(triplets({ supa: ["product-translate"] }));
    expect(() => configuredModel("product-translate", { ...twoServers, PRODUCT_TRANSLATION_MODEL: "shared-weights" })).toThrow("ambiguous_model_identity");
    const selected = registry(triplets({ supa: ["product-translate"] }), { selections: { "product-translate": "supa:translation" } });
    expect(configuredModelRoute("product-translate", { ...selected, PRODUCT_TRANSLATION_MODEL: "shared-weights" })).toMatchObject({
      key: "supa:translation", equipment: "supa", requestModel: "[supa] shared-weights" });
    expect(configuredModelRoute("product-translate", selected).equipment).toBe("supa");
  });
});

async function server() {
  const models: unknown[] = [];
  const instance = http.createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    models.push(JSON.parse(body).model);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: '["Doc manages documents"]' } }] }));
  });
  servers.push(instance);
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("fixture_listen_failed");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, models };
}
const items = [{ name: "Doc", text: "문서 관리 도구", locale: "en" as const, field: "tagline" as const }];

async function translateWith(env: Record<string, string | undefined>) {
  vi.stubEnv("ABCLLM_API_KEY", "local-fixture-only");
  vi.stubEnv("ABCLLM_BASE_URL", undefined);
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL_KEY", undefined);
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", undefined);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  const translate = await import("@/lib/crawl/translate");
  return { constant: translate.PRODUCT_TRANSLATION_MODEL, result: await translate.translateProductFields(items, 1000) };
}

describe("product translation HTTP follows the registry device route", () => {
  it.each([
    ["registry purpose", {}, "m1"],
    ["bare shared name", { PRODUCT_TRANSLATION_MODEL: "shared-weights" }, "m1"],
    ["equipment key", { PRODUCT_TRANSLATION_MODEL_KEY: "supa:translation" }, "supa"],
  ] as const)("sends only to the designated device by %s", async (_label, env, device) => {
    const m1Server = await server(), supaServer = await server();
    const models = triplets({ supa: ["ai1-preset", "product-translate"] }).map(model => model.equipment === "m1" ? { ...model, baseUrl: m1Server.baseUrl }
      : model.equipment === "supa" ? { ...model, baseUrl: supaServer.baseUrl } : model);
    const selections = { "product-translate": "m1:translation" };
    const outcome = await translateWith({ ...registry(edited(models), { selections }), ...env });
    expect(outcome.result.ok).toBe(true);
    expect(outcome.constant).toBe(`[${device}] shared-weights`);
    expect(m1Server.models).toEqual(device === "m1" ? ["[m1] shared-weights"] : []);
    expect(supaServer.models).toEqual(device === "supa" ? ["[supa] shared-weights"] : []);
  });

  it("picks up a changed registry model id and address without code changes", async () => {
    const first = await server(), second = await server();
    const before = await translateWith(registry(edited([{ ...m1, baseUrl: first.baseUrl }])));
    expect(before.constant).toBe(`[m1] ${GEMMA}`);
    const after = await translateWith(registry(edited([{ ...m1, model: "gemma-next-id", family: "gemma-next", baseUrl: second.baseUrl }])));
    expect(after.constant).toBe("[m1] gemma-next-id");
    expect([first.models, second.models]).toEqual([[`[m1] ${GEMMA}`], ["[m1] gemma-next-id"]]);
  });
});

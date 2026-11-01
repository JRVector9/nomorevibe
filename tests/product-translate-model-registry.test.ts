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
  const defaultRoute = { routeId: "product-translate", key: "m1:translation", equipment: "m1",
    provider: "abcllm", requestModel: `[m1] ${GEMMA}`, baseUrl: m1.baseUrl };
  it("defaults to the actual M1 Gemma entry through the M1 gateway label", () => {
    expect(configuredModelRoute("product-translate", {})).toEqual(defaultRoute);
    // The removed env selectors (2026-10-31) neither pick nor break the route.
    expect(configuredModelRoute("product-translate", { PRODUCT_TRANSLATION_MODEL_KEY: "m1:translation", PRODUCT_TRANSLATION_MODEL: "[m1] obsolete" }))
      .toEqual(defaultRoute);
    expect(configuredModelRoute("product-translate", { PRODUCT_TRANSLATION_MODEL_KEY: "supa:review" })).toEqual(defaultRoute);
  });

  it("keeps the model the registry assigns to M1 whatever a stale PRODUCT_TRANSLATION_MODEL says", () => {
    expect(configuredModel("product-translate", { PRODUCT_TRANSLATION_MODEL: "[m1] qwen3.8-flash-next" })).toBe(`[m1] ${GEMMA}`);
    expect(configuredModelDefinition("product-translate", { PRODUCT_TRANSLATION_MODEL: "[m1] qwen3.8-flash-next" }).key).toBe("m1:translation");
    // A label for other equipment no longer moves the route either; only the registry or an admin stage pool does.
    expect(configuredModel("product-translate", { PRODUCT_TRANSLATION_MODEL: "[supa] unregistered-model" })).toBe(`[m1] ${GEMMA}`);
    expect(configuredModel("product-translate", { PRODUCT_TRANSLATION_MODEL: "[other] unregistered-model" })).toBe(`[m1] ${GEMMA}`);
  });

  it("resolves a model name shared by several devices by the registry route, and fails closed when the route is ambiguous", () => {
    const routed = registry(triplets());
    expect(configuredModelRoute("product-translate", { ...routed, PRODUCT_TRANSLATION_MODEL: "[supa] shared-weights" })).toMatchObject({
      key: "m1:translation", equipment: "m1", requestModel: "[m1] shared-weights" });
    const twoServers = registry(triplets({ supa: ["product-translate"] }));
    expect(() => configuredModel("product-translate", { ...twoServers, PRODUCT_TRANSLATION_MODEL: "[m1] shared-weights" }))
      .toThrow("model_purpose_not_unique:product-translate");
    const selected = registry(triplets({ supa: ["product-translate"] }), { selections: { "product-translate": "supa:translation" } });
    expect(configuredModelRoute("product-translate", { ...selected, PRODUCT_TRANSLATION_MODEL_KEY: "m1:translation" })).toMatchObject({
      key: "supa:translation", equipment: "supa", requestModel: "[supa] shared-weights" });
    expect(configuredModelRoute("product-translate", selected).equipment).toBe("supa");
  });

  it("follows the admin stage pool selection inside a job scope and ignores the removed env there too", async () => {
    vi.stubEnv("MODEL_REGISTRY_CONFIG", registry(triplets()).MODEL_REGISTRY_CONFIG);
    vi.stubEnv("PRODUCT_TRANSLATION_MODEL_KEY", "m1:translation");
    vi.stubEnv("PRODUCT_TRANSLATION_MODEL", "[m1] shared-weights");
    vi.resetModules();
    const { withAdminStagePools } = await import("@/lib/llm/admin-model-pools");
    const scoped = await import("@/lib/llm/model-registry");
    expect(scoped.configuredModelRoute("product-translate")).toMatchObject({ key: "m1:translation", requestModel: "[m1] shared-weights" });
    expect(withAdminStagePools({ "product-translate": ["supa:translation"] }, "fixture", () => ({
      route: scoped.configuredModelRoute("product-translate"), scoped: scoped.scopedModel("product-translate", "[m1] shared-weights") })))
      .toEqual({ route: { routeId: "product-translate", key: "supa:translation", equipment: "supa", provider: "abcllm",
        requestModel: "[supa] shared-weights", baseUrl: supa.baseUrl }, scoped: "[supa] shared-weights" });
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
  vi.stubEnv("ABCLLM_API_KEY", "ignored-gateway-key");
  vi.stubEnv("ABCLLM_BASE_URL", undefined);
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL_KEY", undefined);
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", undefined);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  const translate = await import("@/lib/crawl/translate");
  const { configuredModelRoute: route } = await import("@/lib/llm/model-registry");
  return { constant: translate.PRODUCT_TRANSLATE_MODEL, route: route("product-translate"),
    wire: JSON.parse(translate.productTranslationGatewayWire(items, translate.PRODUCT_TRANSLATE_MODEL)) as { model: string },
    result: await translate.translateProductFields(items, 1000) };
}

/**
 * The legacy gateway sender is gone (2026-10-30): it sends to no device, whatever the registry address says. The registry still
 * names the device and model the engine contract path serves (the contract endpoint itself comes from the admin contract).
 */
describe("product translation follows the registry device route and the legacy sender reaches no device", () => {
  it.each([
    ["registry purpose", {}, {}, "m1"],
    ["ignored bare shared name", {}, { PRODUCT_TRANSLATION_MODEL: "shared-weights" }, "m1"],
    ["ignored equipment key", {}, { PRODUCT_TRANSLATION_MODEL_KEY: "supa:translation" }, "m1"],
    ["registry selection", { "product-translate": "supa:translation" }, { PRODUCT_TRANSLATION_MODEL_KEY: "m1:translation" }, "supa"],
  ] as const)("selects only the designated device by %s", async (_label, selection, env, device) => {
    const m1Server = await server(), supaServer = await server();
    const models = triplets({ supa: ["ai1-preset", "product-translate"] }).map(model => model.equipment === "m1" ? { ...model, baseUrl: m1Server.baseUrl }
      : model.equipment === "supa" ? { ...model, baseUrl: supaServer.baseUrl } : model);
    const selections = { "product-translate": "m1:translation", ...selection };
    const outcome = await translateWith({ ...registry(edited(models), { selections }), ...env });
    expect(outcome.result).toEqual({ ok: false, error: "no_key" });
    expect(outcome.constant).toBe(`[${device}] shared-weights`);
    expect(outcome.wire.model).toBe(`[${device}] shared-weights`);
    expect(outcome.route).toMatchObject({ key: `${device}:translation`, equipment: device,
      baseUrl: device === "m1" ? m1Server.baseUrl : supaServer.baseUrl });
    expect([m1Server.models, supaServer.models]).toEqual([[], []]);
  });

  it("picks up a changed registry model id and address without code changes", async () => {
    const first = await server(), second = await server();
    const before = await translateWith(registry(edited([{ ...m1, baseUrl: first.baseUrl }])));
    expect(before.constant).toBe(`[m1] ${GEMMA}`);
    expect(before.route.baseUrl).toBe(first.baseUrl);
    const after = await translateWith(registry(edited([{ ...m1, model: "gemma-next-id", family: "gemma-next", baseUrl: second.baseUrl }])));
    expect(after.constant).toBe("[m1] gemma-next-id");
    expect([after.route.baseUrl, after.wire.model]).toEqual([second.baseUrl, "[m1] gemma-next-id"]);
    expect([before.result, after.result]).toEqual([{ ok: false, error: "no_key" }, { ok: false, error: "no_key" }]);
    expect([first.models, second.models]).toEqual([[], []]);
  });
});

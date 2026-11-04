import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_DEFINITIONS, configuredModel, configuredModelDefinition, configuredModelRoute,
  type ModelDefinition } from "@/lib/llm/model-registry";
import { aiTaskAliasIdentity } from "@/lib/llm/ai-tasks";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { inTextRank, pinTextRanks, TEST_CONNECTION_ID, textContract, textRankRow } from "./text-task-ranks-fixture";


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
  { ...m1, model: "shared-weights", family: "shared", gatewayLabel: "m1" },
  { ...supa, key: "supa:translation", model: "shared-weights", family: "shared", gatewayLabel: "supa", purposes: purposes.supa ?? ["ai1-preset"] },
  { ...gpu, model: "shared-weights", family: "shared" },
];

const servers: http.Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  pinTextRanks(null); setServingContractSnapshotForTest(null);
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

/**
 * 2026-11-02(PR B): 제품 번역 잡이 부르는 연결·모델은 「작업 ↔ 모델」 순위가 고른다. 아래 등록부 항목(용도·선택)은 관리 화면의 기본값 설명으로
 * 남아 있을 뿐 잡의 모델을 정하지 않는다 — 등록부 함수 자체의 규칙(옛 env 무시·모호하면 닫힘)만 본다.
 */
describe("the registry's product-translate entry (description only — the job reads its rank)", () => {
  const defaultRoute = { routeId: "product-translate", key: "m1:translation", equipment: "m1",
    provider: "abcllm", requestModel: GEMMA, baseUrl: m1.baseUrl };
  it("defaults to the actual M1 Gemma entry through the direct M1 engine", () => {
    expect(configuredModelRoute("product-translate", {})).toEqual(defaultRoute);
    // The removed env selectors (2026-10-31) neither pick nor break the route.
    expect(configuredModelRoute("product-translate", { PRODUCT_TRANSLATION_MODEL_KEY: "m1:translation", PRODUCT_TRANSLATION_MODEL: "[m1] obsolete" }))
      .toEqual(defaultRoute);
    expect(configuredModelRoute("product-translate", { PRODUCT_TRANSLATION_MODEL_KEY: "supa:review" })).toEqual(defaultRoute);
  });

  it("keeps the model the registry assigns to M1 whatever a stale PRODUCT_TRANSLATION_MODEL says", () => {
    expect(configuredModel("product-translate", { PRODUCT_TRANSLATION_MODEL: "[m1] qwen3.8-flash-next" })).toBe(GEMMA);
    expect(configuredModelDefinition("product-translate", { PRODUCT_TRANSLATION_MODEL: "[m1] qwen3.8-flash-next" }).key).toBe("m1:translation");
    // A label for other equipment no longer moves the route either; only the registry or an admin stage pool does.
    expect(configuredModel("product-translate", { PRODUCT_TRANSLATION_MODEL: "[supa] unregistered-model" })).toBe(GEMMA);
    expect(configuredModel("product-translate", { PRODUCT_TRANSLATION_MODEL: "[other] unregistered-model" })).toBe(GEMMA);
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

  // 예전: 관리자 단계 풀(stageModelPools.product-translate)이 잡 범위에서 모델을 골랐다. PR B 에서 이 잡은 단계 풀을 열지 않고 순위만 읽는다.
  it("opens no admin stage pool for the product job, and its model inside a pool scope is still the rank's", async () => {
    vi.stubEnv("MODEL_REGISTRY_CONFIG", registry(triplets()).MODEL_REGISTRY_CONFIG);
    vi.stubEnv("PRODUCT_TRANSLATION_MODEL_KEY", "m1:translation");
    vi.stubEnv("PRODUCT_TRANSLATION_MODEL", "[m1] shared-weights");
    vi.resetModules();
    const { MODEL_POOL_JOBS, withAdminStagePools } = await import("@/lib/llm/admin-model-pools");
    const { textTaskModel } = await import("@/lib/llm/ai-task-rank-scope");
    expect(MODEL_POOL_JOBS.has("product-translate")).toBe(false);
    expect(withAdminStagePools({ "product-translate": ["supa:translation"] }, "fixture", () =>
      inTextRank("product-translate", "rank-weights", () => textTaskModel("product-translate")))).toBe("rank-weights");
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
const SUPA_CONNECTION = "0b0c0d0e-0000-4000-8000-00000000a5a0";
const SUPA_IDENTITY = aiTaskAliasIdentity("shared-weights", SUPA_CONNECTION)!;

/** 순위를 고정하고(연결 하나·모델 하나) 그 순위로 부른다 — 묶인 순위, 장부 이름·wire·옛 sender 의 결과, 등록부가 고른 경로를 돌려준다. */
async function translateWith(env: Record<string, string | undefined>, rank: Parameters<typeof textRankRow>[2] & { model: string }) {
  vi.stubEnv("ABCLLM_API_KEY", "ignored-gateway-key");
  vi.stubEnv("ABCLLM_BASE_URL", undefined);
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL_KEY", undefined);
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", undefined);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  pinTextRanks([textRankRow("product-translate", rank.model, rank)]);
  vi.resetModules();
  const translate = await import("@/lib/crawl/translate");
  const { configuredModelRoute: route } = await import("@/lib/llm/model-registry");
  const { TextTaskRanks } = await import("@/lib/llm/ai-task-resolver");
  const { textTaskModel } = await import("@/lib/llm/ai-task-rank-scope");
  const { prepareProductTranslationGatewayCall } = await import("@/lib/crawl/agent-review-gateway");
  const ranks = await TextTaskRanks.open("product-translate");
  const served = await ranks.run(async binding => {
    const model = textTaskModel("product-translate");
    return { binding, model, prepared: prepareProductTranslationGatewayCall(items, { model, timeoutMs: 1000 }).kind,
      wire: JSON.parse(translate.productTranslationGatewayWire(items, binding.engineModel)) as { model: string },
      result: await translate.translateProductFields(items, 1000, undefined, undefined, model) };
  });
  if (served.kind !== "served") throw new Error("unit_rank_unusable");
  return { ...served.value, route: route("product-translate"), constant: "PRODUCT_TRANSLATE_MODEL" in translate };
}
/** 두 장비(M1·Supa)에 같은 가중치 — 연결마다 그 주소를 가리키는 엔진 직접 계약(Supa 는 연결로 가른 장부 이름). */
function pinDeviceContracts(m1Base: string, supaBase: string) {
  setServingContractSnapshotForTest([textContract("product-translate", "shared-weights", { baseUrl: m1Base }),
    textContract("product-translate", SUPA_IDENTITY, { baseUrl: supaBase, engineModel: "shared-weights" })]);
}

/**
 * The legacy gateway sender is gone (2026-10-30): it sends to no device, whatever the registry address says.
 * 2026-11-02(PR B): 부르는 장비는 순위의 연결이 정한다(그 연결 주소를 가리키는 계약에 묶인다) — 등록부의 용도·선택·옛 env 는 장비를 옮기지 않는다.
 * 예전 시험은 등록부가 장비를 고르는 것을 보았다. 그 길은 없앴으므로 같은 뜻(지정한 장비만, 옛 sender 는 어디에도 닿지 않음)을 순위로 본다.
 */
describe("product translation follows its rank's connection and the legacy sender reaches no device", () => {
  it.each([
    ["rank on m1 with the registry purpose", {}, {}, "m1"],
    ["rank on supa despite the registry purpose on m1", {}, {}, "supa"],
    ["rank on m1 with an ignored bare shared name", {}, { PRODUCT_TRANSLATION_MODEL: "shared-weights" }, "m1"],
    ["rank on m1 with an ignored equipment key", {}, { PRODUCT_TRANSLATION_MODEL_KEY: "supa:translation" }, "m1"],
    ["rank on m1 despite a registry selection on supa", { "product-translate": "supa:translation" }, { PRODUCT_TRANSLATION_MODEL_KEY: "m1:translation" }, "m1"],
  ] as const)("selects only the designated device by %s", async (_label, selection, env, device) => {
    const m1Server = await server(), supaServer = await server();
    const models = triplets({ supa: ["ai1-preset", "product-translate"] }).map(model => model.equipment === "m1" ? { ...model, baseUrl: m1Server.baseUrl }
      : model.equipment === "supa" ? { ...model, baseUrl: supaServer.baseUrl } : model);
    const selections = { "product-translate": "m1:translation", ...selection };
    pinDeviceContracts(m1Server.baseUrl, supaServer.baseUrl);
    const outcome = await translateWith({ ...registry(edited(models), { selections }), ...env }, device === "m1"
      ? { model: "shared-weights", baseUrl: m1Server.baseUrl, deviceId: "m1", label: "m1" }
      : { model: "shared-weights", baseUrl: supaServer.baseUrl, deviceId: "supa", label: "supa", connectionId: SUPA_CONNECTION });
    expect(outcome.result).toEqual({ ok: false, error: "no_key" });
    expect(outcome.constant).toBe(false);
    expect(outcome.binding).toMatchObject({ deviceId: device, connectionId: device === "m1" ? TEST_CONNECTION_ID : SUPA_CONNECTION,
      identity: device === "m1" ? "shared-weights" : SUPA_IDENTITY, engineModel: "shared-weights" });
    expect(outcome.model).toBe(outcome.binding.identity);
    expect(outcome.prepared).toBe("prepared");
    expect(outcome.wire.model).toBe("shared-weights");
    // 등록부는 제 규칙대로 장비를 적지만(관리 화면 기본값) 잡의 장비를 옮기지 않는다
    expect(outcome.route).toMatchObject({ equipment: "product-translate" in selection ? "supa" : "m1" });
    expect([m1Server.models, supaServer.models]).toEqual([[], []]);
  });

  it("picks up a changed rank model and connection address without code changes", async () => {
    const first = await server(), second = await server();
    setServingContractSnapshotForTest([textContract("product-translate", GEMMA, { baseUrl: first.baseUrl })]);
    const before = await translateWith(registry(edited([{ ...m1, baseUrl: first.baseUrl }])), { model: GEMMA, baseUrl: first.baseUrl });
    expect(before.binding).toMatchObject({ identity: GEMMA, engineModel: GEMMA });
    setServingContractSnapshotForTest([textContract("product-translate", "gemma-next-id", { baseUrl: second.baseUrl })]);
    const after = await translateWith(registry(edited([{ ...m1, baseUrl: first.baseUrl }])), { model: "gemma-next-id", baseUrl: second.baseUrl });
    expect(after.binding).toMatchObject({ identity: "gemma-next-id", engineModel: "gemma-next-id" });
    expect([after.wire.model, after.prepared]).toEqual(["gemma-next-id", "prepared"]);
    expect([before.result, after.result]).toEqual([{ ok: false, error: "no_key" }, { ok: false, error: "no_key" }]);
    expect([first.models, second.models]).toEqual([[], []]);
  });
});

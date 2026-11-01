import { afterEach, beforeEach, expect, it, vi } from "vitest";

const admission = vi.hoisted(() => vi.fn<(value: {routeId: string; model: string}) => Promise<void>>(async () => {}));
vi.mock("@/lib/llm/text-capacity-admission", () => ({ assertTextModelAdmission: admission }));

beforeEach(() => {
  vi.resetModules();
  admission.mockClear();
  vi.stubEnv("ABCLLM_MODEL", "shared-text-fixture");
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", undefined);
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL_KEY", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const GEMMA = "[m1] mlx-community--gemma-4-26b-a4b-it-4bit", SUPA = "[supa] Qwen3.8-27B-NVFP4";
const items = [{ name: "Doc", text: "문서를 관리하는 도구", locale: "en" as const, field: "tagline" as const }];
function recorder() {
  const bodies: Record<string, unknown>[] = [];
  const request = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(["Doc manages documents"]) } }] }));
  }) as typeof fetch;
  return { bodies, request };
}
/** The legacy gateway senders are gone (2026-10-30): none of them reaches admission or HTTP, whatever model it is given. */
async function legacySendsNothing(translate: typeof import("@/lib/crawl/translate"), productModel?: string) {
  const recorded = recorder();
  expect(await translate.translateProductFields(items, 1000, recorded.request, undefined, productModel)).toEqual({ ok: false, error: "no_key" });
  expect(await translate.translateToKorean(["Manage documents"], 1000, recorded.request)).toEqual({ ok: false, error: "no_key" });
  expect(await translate.translateTaglinesToKorean([{ name: "Doc", tagline: "Manage documents" }], 1000, recorded.request))
    .toEqual({ ok: false, error: "no_key" });
  expect(await translate.translateQueryToEnglish("문서 도구", 1000, recorded.request)).toEqual({ ok: false, error: "no_key" });
  expect(recorded.bodies).toEqual([]); expect(admission).not.toHaveBeenCalled();
}

it.each([undefined, "   ", "configured-product-fixture", SUPA])("selects M1 Gemma from the registry and ignores the removed product env (%j)", async override => {
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", override);
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL_KEY", override?.trim() ? "supa:review" : undefined);
  const translate = await import("@/lib/crawl/translate");
  expect(translate.PRODUCT_TRANSLATE_MODEL).toBe(GEMMA);
  expect(JSON.parse(translate.productTranslationGatewayWire(items, translate.PRODUCT_TRANSLATE_MODEL)).model).toBe(GEMMA);
  await legacySendsNothing(translate);
});

it("changes only product-field translation through the admin stage pool and preserves the exact non-model wire", async () => {
  const { withAdminStagePools } = await import("@/lib/llm/admin-model-pools");
  const { scopedModel } = await import("@/lib/llm/model-registry");
  const translate = await import("@/lib/crawl/translate");
  const selected = await withAdminStagePools({ "product-translate": ["supa:review"] }, "fixture", async () => {
    await legacySendsNothing(translate);
    return [scopedModel("product-translate", translate.PRODUCT_TRANSLATE_MODEL), scopedModel("reason-translate", translate.TRANSLATE_MODEL),
      scopedModel("product-tagline-ko", translate.KOREAN_TAGLINE_MODEL), scopedModel("search-query-translate", translate.SEARCH_QUERY_MODEL)];
  });
  expect(selected).toEqual([SUPA, "shared-text-fixture", "shared-text-fixture", "shared-text-fixture"]);
  // Outside the job scope the shared import-time choice is untouched.
  expect([translate.PRODUCT_TRANSLATE_MODEL, translate.TRANSLATE_MODEL]).toEqual([GEMMA, "shared-text-fixture"]);
  // Only the model and its model-specific system prompt differ; the ordered input and every transport field are exact.
  const pooled = JSON.parse(translate.productTranslationGatewayWire(items, SUPA)), base = JSON.parse(translate.productTranslationGatewayWire(items, GEMMA));
  expect(pooled.model).toBe(SUPA);
  expect({ ...pooled, model: base.model, messages: [base.messages[0], pooled.messages[1]] }).toEqual(base);
});

it("passes an explicit product model to neither admission nor legacy HTTP and does not mutate the shared choice", async () => {
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", "configured-product-fixture");
  const translate = await import("@/lib/crawl/translate");
  await legacySendsNothing(translate, "comparison-fixture");
  expect(JSON.parse(translate.productTranslationGatewayWire(items, "comparison-fixture")).model).toBe("comparison-fixture");
  expect(translate.TRANSLATE_MODEL).toBe("shared-text-fixture");
  expect(translate.PRODUCT_TRANSLATE_MODEL).toBe(GEMMA);
});

it("keeps per-purpose translation selections aligned with the request models of each wire", async () => {
  vi.stubEnv("ABCLLM_MODEL", undefined);
  const { DEFAULT_MODEL_DEFINITIONS } = await import("@/lib/llm/model-registry");
  vi.stubEnv("MODEL_REGISTRY_CONFIG", JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(model =>
    model.key === "m1:translation" ? { ...model, purposes: [...model.purposes, "product-tagline-ko", "search-query-translate"] } : model),
    selections: { "product-tagline-ko": "m1:translation", "search-query-translate": "m1:translation" } }));
  const translate = await import("@/lib/crawl/translate");
  expect([translate.PRODUCT_TRANSLATE_MODEL, translate.TRANSLATE_MODEL, translate.KOREAN_TAGLINE_MODEL, translate.SEARCH_QUERY_MODEL])
    .toEqual([GEMMA, GEMMA, GEMMA, GEMMA]);
  const wires = [translate.productTranslationGatewayWire(items, translate.PRODUCT_TRANSLATE_MODEL),
    translate.reasonTranslationGatewayWire(["Manage documents"], translate.TRANSLATE_MODEL),
    translate.productTaglineKoGatewayWire([{ name: "Doc", tagline: "Manage documents" }], translate.KOREAN_TAGLINE_MODEL),
    translate.websearchQueryGatewayWire({ sourceLocale: "ko", query: "문서 도구" }, translate.SEARCH_QUERY_MODEL)];
  expect(wires.map(wire => JSON.parse(wire).model)).toEqual([GEMMA, GEMMA, GEMMA, GEMMA]);
  await legacySendsNothing(translate);
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const admission = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/llm/text-capacity-admission", () => ({ assertTextModelAdmission: admission }));

beforeEach(() => {
  vi.resetModules();
  admission.mockClear();
  vi.stubEnv("ABCLLM_API_KEY", "local-fixture-only");
  vi.stubEnv("ABCLLM_MODEL", "shared-text-fixture");
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const items = [{ name: "Doc", text: "문서를 관리하는 도구", locale: "en" as const, field: "tagline" as const }];
function recorder() {
  const bodies: Record<string, unknown>[] = [];
  const request = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(["Doc manages documents"]) } }] }));
  }) as typeof fetch;
  return { bodies, request };
}

it.each([undefined, "   "])("keeps the existing shared model when the product override is absent or blank (%j)", async override => {
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", override);
  const { PRODUCT_TRANSLATION_MODEL, translateProductFields } = await import("@/lib/crawl/translate");
  const recorded = recorder();
  expect(PRODUCT_TRANSLATION_MODEL).toBe("shared-text-fixture");
  expect((await translateProductFields(items, 1000, recorded.request)).ok).toBe(true);
  expect(recorded.bodies[0].model).toBe("shared-text-fixture");
});

it("changes only product-field translation and preserves the exact non-model wire", async () => {
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", " product-text-fixture ");
  const { translateProductFields, translateToKorean, translateTaglinesToKorean, translateQueryToEnglish,
    productTranslationGatewayWire } = await import("@/lib/crawl/translate");
  const recorded = recorder();
  expect((await translateProductFields(items, 1000, recorded.request)).ok).toBe(true);
  expect(JSON.stringify(recorded.bodies[0])).toBe(productTranslationGatewayWire(items, "product-text-fixture"));
  expect(admission).toHaveBeenNthCalledWith(1, { routeId: "product-translate", model: "product-text-fixture" });
  await translateToKorean(["Manage documents"], 1000, recorded.request);
  await translateTaglinesToKorean([{ name: "Doc", tagline: "Manage documents" }], 1000, recorded.request);
  await translateQueryToEnglish("문서 도구", 1000, recorded.request);
  expect(recorded.bodies.map(body => body.model)).toEqual([
    "product-text-fixture", "shared-text-fixture", "shared-text-fixture", "shared-text-fixture",
  ]);
});

it("passes an explicit product model to both admission and legacy HTTP without mutating the shared choice", async () => {
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", "configured-product-fixture");
  const { TRANSLATE_MODEL, PRODUCT_TRANSLATION_MODEL, translateProductFields } = await import("@/lib/crawl/translate");
  const recorded = recorder();
  await translateProductFields(items, 1000, recorded.request, undefined, "comparison-fixture");
  expect(recorded.bodies[0].model).toBe("comparison-fixture");
  expect(admission).toHaveBeenCalledWith({ routeId: "product-translate", model: "comparison-fixture" });
  expect(TRANSLATE_MODEL).toBe("shared-text-fixture");
  expect(PRODUCT_TRANSLATION_MODEL).toBe("configured-product-fixture");
});

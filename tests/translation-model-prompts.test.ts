import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { productTaglineKoGatewayWire, productTranslationGatewayWire,
  translateProductFields, translateTaglinesToKorean } from "@/lib/crawl/translate";
import { prepareProductTaglineKoGatewayCall, prepareProductTranslationGatewayCall } from "@/lib/crawl/agent-review-gateway";
import { checkKoreanTagline } from "@/lib/domain/products/korean-tagline";
import { checkProductTranslation } from "@/lib/domain/products/translation-policy";

vi.mock("@/lib/llm/text-capacity-admission", () => ({ assertTextModelAdmission: vi.fn() }));
vi.mock("@/lib/llm/product-translation-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/product-translation-serving-contract")>(),
  resolveProductTranslationServingContract: (model: string) => ({ version: 1, protocol: "abcllm-product-translation-total-bound-v1",
    routeId: "product-translate", provider: "abcllm", model, responseModel: model,
    endpoint: "http://127.0.0.1:1/v1/chat/completions", deploymentRevision: "local-fixture", totalTokenBound: 32768 }),
}));
vi.mock("@/lib/llm/product-tagline-ko-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/product-tagline-ko-serving-contract")>(),
  resolveProductTaglineKoServingContract: (model: string) => ({ version: 1, protocol: "abcllm-product-tagline-ko-total-bound-v1",
    routeId: "product-tagline-ko", provider: "abcllm", model, responseModel: model,
    endpoint: "http://127.0.0.1:1/v1/chat/completions", deploymentRevision: "local-fixture", totalTokenBound: 32768 }),
}));

beforeEach(() => { vi.stubEnv("ABCLLM_API_KEY", "local-fixture-only"); });
afterEach(() => vi.unstubAllEnvs());
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const products = [
  { name: "Files", locale: "en" as const, field: "description" as const, text: "문서를 정리하는 도구" },
  { name: "Notes", locale: "zh-Hant" as const, field: "tagline" as const, text: "A tool that manages notes" },
];
const taglines = [{ name: "Files", tagline: "A document manager" }, { name: "Notes", tagline: "A note manager" }];
const routes = ["product-translate", "product-tagline-ko"] as const;
const wireFor = (route: typeof routes[number], model: string) => route === "product-translate"
  ? productTranslationGatewayWire(products, model) : productTaglineKoGatewayWire(taglines, model);
function response(content: string, record?: (wire: string) => void): typeof fetch {
  return (async (_url, init) => {
    record?.(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  }) as typeof fetch;
}
const run = (route: typeof routes[number], model: string, request: typeof fetch) => route === "product-translate"
  ? translateProductFields(products, 1000, request, undefined, model)
  : translateTaglinesToKorean(taglines, 1000, request, undefined, model);

it.each([
  ["[MLX] gpt-oss-120b", false], ["openai/gpt-oss-20b", false],
  ["[supa] Qwen3.8-27B-NVFP4", true], ["Qwen/Qwen3.8-27B", true],
  ["[MLX] deepseek-v4.1-flash", false], ["unknown-qwen-lookalike", false],
] as const)("keeps legacy and reserved wire identical for %s, with a Qwen-only task suffix", async (model, qwen) => {
  for (const route of routes) {
    const original = JSON.parse(wireFor(route, "unknown-fixture"));
    const expected = wireFor(route, model), body = JSON.parse(expected);
    const system = body.messages[0].content as string;
    expect({ ...body, model: original.model, messages: [original.messages[0], body.messages[1]] }).toEqual(original);
    if (qwen) {
      expect(system.startsWith(original.messages[0].content + "\n\n")).toBe(true);
      expect(system).not.toContain("{count}");
      // Full systems for two items, from the separately frozen v2.1 experiment snapshot.
      expect(sha(system)).toBe(route === "product-translate"
        ? "47d493f090499c57120810f103c878f12afc14c6ca475d46d89ecfe20d9c7e1c"
        : "8e4c66ebee8fc42faeea32b42f1c03944acf9545acec055ec19f38a3d5342ccd");
    } else expect(system).toBe(original.messages[0].content);
    let actual = "";
    expect(await run(route, model, response('["Translated first","Translated second"]', wire => { actual = wire; })))
      .toEqual({ ok: true, outputs: ["Translated first", "Translated second"] });
    expect(actual).toBe(expected);
    const prepared = route === "product-translate" ? prepareProductTranslationGatewayCall(products, { model, timeoutMs: 1000 })
      : prepareProductTaglineKoGatewayCall(taglines, { model, timeoutMs: 1000 });
    expect(prepared).toMatchObject({ kind: "prepared", model, wireHash: sha(expected) });
  }
});

it("leaves reason and live search query wires unchanged across GPT-OSS and Qwen", async () => {
  const recordings: Record<string, unknown>[][] = [];
  for (const model of ["[MLX] gpt-oss-120b", "[supa] Qwen3.8-27B-NVFP4"]) {
    vi.resetModules(); vi.stubEnv("ABCLLM_MODEL", model);
    const { translateToKorean, translateQueryToEnglish } = await import("@/lib/crawl/translate");
    const bodies: Record<string, unknown>[] = [];
    const request = response('["문서를 관리하는 도구"]', wire => bodies.push(JSON.parse(wire)));
    await translateToKorean(["A tool that manages documents"], 1000, request);
    await translateQueryToEnglish("문서 관리", 1000, request);
    recordings.push(bodies.map(body => ({ ...body, model: "same-model-for-comparison" })));
  }
  expect(recordings[1]).toEqual(recordings[0]);
});

it.each(routes)("does not make invalid nested or duplicate arrays usable on %s", async route => {
  const model = "[supa] Qwen3.8-27B-NVFP4";
  for (const content of ['[["First","Second"]]', '["First","Second"]["First","Second"]'])
    expect(await run(route, model, response(content))).toEqual({ ok: false, error: "invalid_output" });
  // The existing parser maps non-string elements to empty strings; the existing field guards still reject them.
  const nested = await run(route, model, response('[["First"],["Second"]]'));
  expect(nested).toEqual({ ok: true, outputs: ["", ""] });
  if (!nested.ok) throw new Error("fixture_expected_empty_elements");
  for (const output of nested.outputs) expect(route === "product-translate"
    ? checkProductTranslation(output, { id: 1, name: "Files", tagline: "A document manager" }, "en", "tagline")
    : checkKoreanTagline(output, taglines[0])).toEqual({ ok: false, reason: "empty" });
});

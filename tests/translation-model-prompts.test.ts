import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { productTaglineKoGatewayWire, productTranslationGatewayWire,
  translateProductFields, translateTaglinesToKorean, websearchQueryGatewayWire } from "@/lib/crawl/translate";
import { koreanTranslationRuntimePrompt } from "@/lib/crawl/korean-translation-prompts";
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
const comparableWire = (wire: string) => JSON.stringify({ ...JSON.parse(wire), model: "same-model-for-comparison" });
// Frozen from main6931ba54 before KO legacy expansion. Native and unrelated routes must retain these bytes.
const frozenWires = {
  "product-translate": { default: "e8b01ab69d4cabdd00055b1a6742c20666d9a98e4352d388cb04ad4072ece131", qwen: "85f30a45fec8d70de70012de9dfc6627bae4b226e5fa26f5fa4a88bbcd2c3526" },
  "product-tagline-ko": { default: "d183d8e22faa861cc1b1236410be8e3024e129bc657a27784cd985f70b7e41c2", qwen: "da6f1dc04d85c707946bfdde00c55d286aa7fe7ba39078c2c21eab170e86fa8f" },
} as const;
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
] as const)("keeps native and multilingual wire frozen for %s and isolates expanded KO changes", async (model, qwen) => {
  for (const route of routes) {
    const original = JSON.parse(wireFor(route, "unknown-fixture"));
    const expected = wireFor(route, model), body = JSON.parse(expected);
    expect(sha(comparableWire(expected))).toBe(frozenWires[route][qwen ? "qwen" : "default"]);
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
    if (route === "product-translate") expect(actual).toBe(expected);
    else {
      const runtime = koreanTranslationRuntimePrompt(model, taglines.length);
      if (qwen) expect(runtime).not.toBeNull();
      else expect(runtime).toBeNull();
      const expanded = { ...body, max_tokens: body.max_tokens * 3,
        messages: [{ ...body.messages[0], content: runtime ?? system }, body.messages[1]] };
      expect(actual).toBe(JSON.stringify(expanded));
      expect(JSON.parse(actual).max_tokens).toBe(2700);
      // Only the explicit KO runtime prompt and output budget differ; ordered inputs and all transport fields remain exact.
      expect({ ...JSON.parse(actual), max_tokens: body.max_tokens, messages: [body.messages[0], JSON.parse(actual).messages[1]] }).toEqual(body);
    }
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
  expect(recordings[0].map(body => sha(JSON.stringify(body)))).toEqual([
    "e982a3a2621ddd2168684c151c1ca572217b7e8c7048013281696245611b4ff7",
    "225e6adff3905ad842d4db99af4e6d158d47562fc956da528cb51e1d3a6bbf6f",
  ]);
});

it("keeps native Chinese search request bytes frozen", () => {
  expect(sha(comparableWire(websearchQueryGatewayWire({ sourceLocale: "zh-Hans", query: "文档管理" }, "[MLX] gpt-oss-120b"))))
    .toBe("3a1032b9a710b6b9fb016f764455deaf2054586ce407f5ef701a1abe03d9f36b");
  expect(sha(comparableWire(websearchQueryGatewayWire({ sourceLocale: "zh-Hant", query: "文件管理" }, "[MLX] gpt-oss-120b"))))
    .toBe("e10c2aeddb7a986fdef5752b98a2301bbbfc1628dd7ce4ac62a7f01e222b31e2");
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

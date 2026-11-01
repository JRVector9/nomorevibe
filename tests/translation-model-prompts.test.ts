import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { productTaglineKoGatewayWire, productTaglineKoLegacyWire, productTranslationGatewayWire,
  translateProductFields, translateTaglinesToKorean, websearchQueryGatewayWire } from "@/lib/crawl/translate";
import { koreanTranslationRuntimePrompt } from "@/lib/crawl/korean-translation-prompts";
import { prepareProductTaglineKoGatewayCall, prepareProductTranslationGatewayCall } from "@/lib/crawl/agent-review-gateway";
import { checkKoreanTagline, parseKoreanTaglines } from "@/lib/domain/products/korean-tagline";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
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

const MODELS = ["[MLX] gpt-oss-120b", "openai/gpt-oss-20b", "[supa] Qwen3.8-27B-NVFP4", "Qwen/Qwen3.8-27B", "[MLX] deepseek-v4.1-flash",
  "unknown-qwen-lookalike"] as const;
// The contracts above are mocked; a direct admin row per route+model opens the bearer (the abcLLM gateway was removed 2026-10-30).
beforeEach(() => setServingContractSnapshotForTest((["product-translate", "product-tagline-ko"] as const).flatMap(routeId =>
  MODELS.map(model => ({ routeId, model, contract: {}, auth: "none" as const, apiKey: null, transport: "direct" as const })))));
afterEach(() => { setServingContractSnapshotForTest(null); vi.unstubAllEnvs(); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const comparableWire = (wire: string) => JSON.stringify({ ...JSON.parse(wire), model: "same-model-for-comparison" });
// Product hashes pin this prompt alignment. KO native hashes retain main6931ba54's pre-expansion bytes.
const frozenWires = {
  "product-translate": { default: "22c72ae7c58335607b66ccbbbff875aba358420fcc7ba627a491a0f48410f9ea", qwen: "635640240f858caef0c0bc4f93b828b347384bf0755b3abefec7b5a11d5258b7" },
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
/** The legacy gateway senders are gone (2026-10-30): they return no_key without reaching the request. */
async function legacySendsNothing(route: typeof routes[number], model: string) {
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] })));
  expect(await (route === "product-translate" ? translateProductFields(products, 1000, request, undefined, model)
    : translateTaglinesToKorean(taglines, 1000, request, undefined, model))).toEqual({ ok: false, error: "no_key" });
  expect(request).not.toHaveBeenCalled();
}
/** The original business parser each native sender applies to its completion content. */
const parse = (route: typeof routes[number], content: string) => route === "product-translate"
  ? parseKoreanTaglines(content, products.length, products) : parseKoreanTaglines(content, taglines.length);

it.each(["[MLX] gpt-oss-120b", "[supa] Qwen3.8-27B-NVFP4"])(
  "supplies each product item's exact protected tokens and faithful English prose requirements for %s", model => {
    const batch = [
      { name: "Acme", locale: "en" as const, field: "tagline" as const, text: "FREE API tools for GitHub and GraphQL; API tools" },
      { name: "Notes", locale: "zh-Hant" as const, field: "description" as const, text: "A tool that manages notes" },
    ];
    const original = structuredClone(batch), wire = JSON.parse(productTranslationGatewayWire(batch, model));
    expect(JSON.parse(wire.messages[1].content)).toEqual([
      { ...batch[0], protectedTokens: ["FREE", "API", "GitHub", "GraphQL"] },
      { ...batch[1], protectedTokens: [] },
    ]);
    expect(batch).toEqual(original);
    const system = wire.messages[0].content as string;
    expect(system).toContain("protectedTokens");
    expect(system).toContain("verbatim and case-sensitively");
    expect(system).toContain("English sentence prose");
    expect(system).toContain("articles and prepositions");
    expect(system).toContain("Do not add facts");
    expect(system).toContain("incomplete source");
    expect(system).toContain("360 characters maximum");
    expect(system).toContain("8000 characters maximum");
    expect(system).toContain("in the input order, with exactly the input count");
  },
);

it("retains exact protected-token and conservative English validation after prompt alignment", () => {
  const source = { id: 1, name: "Acme", tagline: "FREE API tools for GitHub and GraphQL" };
  expect(checkProductTranslation(source.tagline, source, "en", "tagline")).toEqual({ ok: true, text: source.tagline });
  for (const token of ["FREE", "API", "GitHub", "GraphQL"])
    expect(checkProductTranslation(source.tagline.replace(token, token.toLowerCase()), source, "en", "tagline"))
      .toEqual({ ok: false, reason: "term_lost" });
  const korean = { id: 2, name: "Acme", tagline: "문서를 정리하고 팀과 공유하는 도구" };
  const faithful = "A tool for organizing documents and sharing them with your team";
  expect(checkProductTranslation(faithful, korean, "en", "tagline")).toEqual({ ok: true, text: faithful });
  expect(checkProductTranslation("Document organization and team sharing", korean, "en", "tagline"))
    .toEqual({ ok: false, reason: "english_uncertain" });
});

it.each([
  ["[MLX] gpt-oss-120b", false], ["openai/gpt-oss-20b", false],
  ["[supa] Qwen3.8-27B-NVFP4", true], ["Qwen/Qwen3.8-27B", true],
  ["[MLX] deepseek-v4.1-flash", false], ["unknown-qwen-lookalike", false],
] as const)("pins aligned product and original native KO wires for %s and isolates expanded KO changes", async (model, qwen) => {
  for (const route of routes) {
    const original = JSON.parse(wireFor(route, "unknown-fixture"));
    const expected = wireFor(route, model), body = JSON.parse(expected);
    expect(sha(comparableWire(expected))).toBe(frozenWires[route][qwen ? "qwen" : "default"]);
    const system = body.messages[0].content as string;
    expect({ ...body, model: original.model, messages: [original.messages[0], body.messages[1]] }).toEqual(original);
    if (qwen) {
      expect(system.startsWith(original.messages[0].content + "\n\n")).toBe(true);
      expect(system).not.toContain("{count}");
      // The product base is aligned; the model-specific v2.1 suffix and full KO system remain unchanged.
      expect(sha(system)).toBe(route === "product-translate"
        ? "980b5f9656d0cce3aeeada93f99bbb3c096785f9300ddfc823cf9fbf41dcb8b4"
        : "8e4c66ebee8fc42faeea32b42f1c03944acf9545acec055ec19f38a3d5342ccd");
    } else expect(system).toBe(original.messages[0].content);
    await legacySendsNothing(route, model);
    expect(parse(route, '["Translated first","Translated second"]')).toEqual({ ok: true, outputs: ["Translated first", "Translated second"] });
    if (route === "product-tagline-ko") {
      const actual = productTaglineKoLegacyWire(taglines, model);
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
    const { TRANSLATE_MODEL, SEARCH_QUERY_MODEL, reasonTranslationGatewayWire, websearchQueryGatewayWire: queryWire,
      translateToKorean, translateQueryToEnglish } = await import("@/lib/crawl/translate");
    expect([TRANSLATE_MODEL, SEARCH_QUERY_MODEL]).toEqual([model, model]);
    // The legacy senders no longer send; the native reason and Korean search paths send exactly these builders' bytes.
    const request = vi.fn<typeof fetch>();
    expect(await translateToKorean(["A tool that manages documents"], 1000, request)).toEqual({ ok: false, error: "no_key" });
    expect(await translateQueryToEnglish("문서 관리", 1000, request)).toEqual({ ok: false, error: "no_key" });
    expect(request).not.toHaveBeenCalled();
    const bodies = [reasonTranslationGatewayWire(["A tool that manages documents"], TRANSLATE_MODEL),
      queryWire({ sourceLocale: "ko", query: "문서 관리" }, SEARCH_QUERY_MODEL)].map(wire => JSON.parse(wire) as Record<string, unknown>);
    expect(bodies.map(body => body.model)).toEqual([model, model]);
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
  await legacySendsNothing(route, model);
  for (const content of ['[["First","Second"]]', '["First","Second"]["First","Second"]'])
    expect(parse(route, content)).toEqual({ ok: false, error: "invalid_output" });
  // The existing parser maps non-string elements to empty strings; the existing field guards still reject them.
  const nested = parse(route, '[["First"],["Second"]]');
  expect(nested).toEqual({ ok: true, outputs: ["", ""] });
  if (!nested.ok) throw new Error("fixture_expected_empty_elements");
  for (const output of nested.outputs) expect(route === "product-translate"
    ? checkProductTranslation(output, { id: 1, name: "Files", tagline: "A document manager" }, "en", "tagline")
    : checkKoreanTagline(output, taglines[0])).toEqual({ ok: false, reason: "empty" });
});

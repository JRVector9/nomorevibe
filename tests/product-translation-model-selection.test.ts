import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { inTextRank, pinTextRanks, textContract } from "./text-task-ranks-fixture";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("ABCLLM_MODEL", "shared-text-fixture");
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", undefined);
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL_KEY", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); pinTextRanks(null); setServingContractSnapshotForTest(null); });

/**
 * 2026-11-02(PR B): 제품 번역을 포함한 text 경로의 모델은 「작업 ↔ 모델」 순위가 고른다 — 환경변수·등록부 용도·선택·관리자 단계 풀은 읽지 않는다.
 * 예전 시험은 import 때 정해지는 상수(PRODUCT_TRANSLATE_MODEL 등)와 단계 풀(scopedModel)로 고르는 것을 보았다. 그 길은 없앴으므로
 * 같은 뜻을 순위로 본다: 순위의 모델이 그 경로의 장부 이름이자 wire 의 model 이고, 다른 설정이 그것을 바꾸지 않는다.
 */
const GEMMA = "mlx-community--gemma-4-26b-a4b-it-4bit", SUPA = "Qwen3.8-27B-NVFP4";
const items = [{ name: "Doc", text: "문서를 관리하는 도구", locale: "en" as const, field: "tagline" as const }];
/** 경로마다 순위 하나와 그 연결을 가리키는 엔진 직접 계약 하나. */
function pinRanks(ranks: Readonly<Record<string, string>>) {
  pinTextRanks(ranks);
  setServingContractSnapshotForTest(Object.entries(ranks).map(([route, model]) => textContract(route as Parameters<typeof textContract>[0], model)));
}
function recorder() {
  const bodies: Record<string, unknown>[] = [];
  const request = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(["Doc manages documents"]) } }] }));
  }) as typeof fetch;
  return { bodies, request };
}
/** The legacy gateway senders are gone (2026-10-30): none of them reaches HTTP, whatever model it is given. */
async function legacySendsNothing(translate: typeof import("@/lib/crawl/translate"), productModel?: string) {
  const recorded = recorder();
  expect(await translate.translateProductFields(items, 1000, recorded.request, undefined, productModel)).toEqual({ ok: false, error: "no_key" });
  expect(await translate.translateToKorean(["Manage documents"], 1000, recorded.request)).toEqual({ ok: false, error: "no_key" });
  expect(await translate.translateTaglinesToKorean([{ name: "Doc", tagline: "Manage documents" }], 1000, recorded.request))
    .toEqual({ ok: false, error: "no_key" });
  // 검색어 번역은 순위 범위 안에서만 모델을 읽는다(범위 밖이면 기본값으로 떨어지지 않고 던진다)
  expect(await inTextRank("search-query-translate", "query-rank-fixture", () => translate.translateQueryToEnglish("문서 도구", 1000, recorded.request)))
    .toEqual({ ok: false, error: "no_key" });
  expect(recorded.bodies).toEqual([]);
}

it.each([undefined, "   ", "configured-product-fixture", `[supa] ${SUPA}`])("takes the product model from its rank and ignores the removed product env (%j)", async override => {
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", override);
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL_KEY", override?.trim() ? "supa:review" : undefined);
  pinRanks({ "product-translate": GEMMA });
  const translate = await import("@/lib/crawl/translate");
  const { TextTaskRanks } = await import("@/lib/llm/ai-task-resolver");
  const { textTaskModel } = await import("@/lib/llm/ai-task-rank-scope");
  // import 때 정해지는 제품 번역 모델 상수는 없다
  expect("PRODUCT_TRANSLATE_MODEL" in translate).toBe(false);
  const ranks = await TextTaskRanks.open("product-translate");
  expect(ranks.earlyDegraded()).toBeNull();
  const served = await ranks.run(async () => {
    const model = textTaskModel("product-translate");
    expect(JSON.parse(translate.productTranslationGatewayWire(items, model)).model).toBe(GEMMA);
    await legacySendsNothing(translate);
    return model;
  });
  expect(served).toMatchObject({ kind: "served", value: GEMMA, binding: { rank: 1, identity: GEMMA, engineModel: GEMMA } });
});

it("ignores the admin stage pool for product-field translation and preserves the exact non-model wire", async () => {
  const { MODEL_POOL_JOBS, withAdminStagePools } = await import("@/lib/llm/admin-model-pools");
  const { textTaskModel, TextTaskRankMissingError } = await import("@/lib/llm/ai-task-rank-scope");
  const translate = await import("@/lib/crawl/translate");
  // 단계 풀은 이 잡에 열리지 않는다 — 열려 있어도 순위의 모델만 읽는다. 다른 경로는 제 순위가 없으면 기본값으로 떨어지지 않고 던진다.
  expect(MODEL_POOL_JOBS.has("product-translate")).toBe(false);
  const selected = await withAdminStagePools({ "product-translate": ["supa:review"] }, "fixture", () =>
    inTextRank("product-translate", GEMMA, async () => {
      await legacySendsNothing(translate);
      return [textTaskModel("product-translate"), ...["reason-translate", "product-tagline-ko", "search-query-translate"].map(route => {
        try { return textTaskModel(route); } catch (error) { return error instanceof TextTaskRankMissingError ? `missing:${error.routeId}` : error; }
      })];
    }));
  expect(selected).toEqual([GEMMA, "missing:reason-translate", "missing:product-tagline-ko", "missing:search-query-translate"]);
  // 순위 범위 밖에서는 제품 번역의 모델도 없다(공유하는 import 때 선택이 없다).
  expect(() => textTaskModel("product-translate")).toThrow(TextTaskRankMissingError);
  // Only the model and its model-specific system prompt differ; the ordered input and every transport field are exact.
  const pooled = JSON.parse(translate.productTranslationGatewayWire(items, SUPA)), base = JSON.parse(translate.productTranslationGatewayWire(items, GEMMA));
  expect(pooled.model).toBe(SUPA);
  expect({ ...pooled, model: base.model, messages: [base.messages[0], pooled.messages[1]] }).toEqual(base);
});

it("passes an explicit product model to neither legacy HTTP nor the rank's model", async () => {
  vi.stubEnv("PRODUCT_TRANSLATION_MODEL", "configured-product-fixture");
  const translate = await import("@/lib/crawl/translate");
  const { textTaskModel, TextTaskRankMissingError } = await import("@/lib/llm/ai-task-rank-scope");
  await inTextRank("product-translate", GEMMA, async () => {
    await legacySendsNothing(translate, "comparison-fixture");
    expect(textTaskModel("product-translate")).toBe(GEMMA);
  });
  expect(JSON.parse(translate.productTranslationGatewayWire(items, "comparison-fixture")).model).toBe("comparison-fixture");
  // 환경변수는 순위 밖의 모델이 되지 않는다
  expect(() => textTaskModel("product-translate")).toThrow(TextTaskRankMissingError);
});

it("keeps each translation route's rank model aligned with the request model of its wire, whatever registry selections say", async () => {
  vi.stubEnv("ABCLLM_MODEL", undefined);
  const { DEFAULT_MODEL_DEFINITIONS } = await import("@/lib/llm/model-registry");
  vi.stubEnv("MODEL_REGISTRY_CONFIG", JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(model =>
    model.key === "m1:translation" ? { ...model, purposes: [...model.purposes, "product-tagline-ko", "search-query-translate"] } : model),
    selections: { "product-tagline-ko": "m1:translation", "search-query-translate": "m1:translation" } }));
  const ranked = { "product-translate": GEMMA, "reason-translate": "gpt-oss-120b", "product-tagline-ko": SUPA, "search-query-translate": "qwen3.6-35b" } as const;
  pinRanks(ranked);
  const translate = await import("@/lib/crawl/translate");
  const { TextTaskRanks } = await import("@/lib/llm/ai-task-resolver");
  const { textTaskModel } = await import("@/lib/llm/ai-task-rank-scope");
  const wire = {
    "product-translate": (model: string) => translate.productTranslationGatewayWire(items, model),
    "reason-translate": (model: string) => translate.reasonTranslationGatewayWire(["Manage documents"], model),
    "product-tagline-ko": (model: string) => translate.productTaglineKoGatewayWire([{ name: "Doc", tagline: "Manage documents" }], model),
    "search-query-translate": (model: string) => translate.websearchQueryGatewayWire({ sourceLocale: "ko", query: "문서 도구" }, model),
  } as const;
  const models: string[] = [];
  for (const route of Object.keys(ranked) as (keyof typeof ranked)[]) {
    const served = await (await TextTaskRanks.open(route)).run(async () => JSON.parse(wire[route](textTaskModel(route))).model as string);
    if (served.kind !== "served") throw new Error(`unit_rank_unusable:${route}`);
    models.push(served.value);
  }
  expect(models).toEqual(Object.values(ranked));
  await legacySendsNothing(translate);
});

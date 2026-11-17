import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { translateDemandedProductFields } from "@/lib/jobs/products/translations";
import { PRODUCT_TRANSLATION_CANDIDATE_WINDOW, sameLocaleTranslationCandidates } from "@/lib/jobs/products/translation-locale-batch";
import { packProductTranslationBatch, productTranslationPolicy, productTranslationSourceHash } from "@/lib/domain/products/translation-policy";
import type { ProductTranslationTask } from "@/lib/domain/products/translations";
import { productTranslationGatewayWire, type ProductTranslationGatewayItem } from "@/lib/crawl/translate";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { pinTextRanks, textContract } from "./text-task-ranks-fixture";

/**
 * 일본어 요청이 중국어로 오던 문제(2026-11-17): 수요 순서대로 4건을 묶어 zh-Hans 뒤에 ja 가 오면 M1Max Qwen3.8-27B 가 ja 를 중국어로 옮겼다
 * (실측 50묶음 — zh-Hans 뒤 첫 ja 34건 중 18건 not_japanese, 묶음 맨 앞 ja 16건 중 0건). 한 묶음 한 언어로 고친 것을 지킨다.
 */
const mocks = vi.hoisted(() => ({ tasks: vi.fn(), write: vi.fn(), call: vi.fn(), control: vi.fn() }));
vi.mock("@/lib/llm/capacity-repository", async load => ({
  ...await load<typeof import("@/lib/llm/capacity-repository")>(), readModelCapacityCallerControl: mocks.control,
}));
vi.mock("@/lib/domain/products/translations", () => ({ pendingProductTranslations: mocks.tasks, recordProductTranslations: mocks.write }));
vi.mock("@/lib/domain/products/product-translation-model-capacity", () => ({
  translateProductFieldsWithModelCapacity: async (tasks: readonly ProductTranslationTask[]) => ({ kind: "result", result: await mocks.call(tasks) }),
}));
vi.mock("@/lib/db", () => ({ db: {}, onPrimary: async (load: () => Promise<unknown>) => load() }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

type Locale = ProductTranslationTask["locale"];
const source = (id: number) => ({ id, name: `Tool${id}`, tagline: `툴${id}은 서버 로그를 한곳에서 보여 줍니다` });
const task = (id: number, locale: Locale, attempts = 0): ProductTranslationTask => ({ source: source(id), locale, field: "tagline",
  sourceHash: productTranslationSourceHash(source(id), "tagline"), attempts, eligible: true });
const item = (entry: ProductTranslationTask): ProductTranslationGatewayItem => ({ name: entry.source.name, locale: entry.locale, field: entry.field,
  text: entry.source.tagline });
const keys = (batch: readonly ProductTranslationTask[]) => batch.map(entry => `${entry.source.id}:${entry.locale}`);
const context = (): JobContext<null> => ({ cursor: null, lease: { name: "product-translate", token: "fixture-token", requestedVersion: 1 },
  hasBudget: () => true, save: vi.fn(), log: vi.fn() });

beforeEach(() => {
  vi.resetAllMocks();
  pinTextRanks({ "product-translate": "Qwen3.8-27B-4bit" });
  setServingContractSnapshotForTest([textContract("product-translate", "Qwen3.8-27B-4bit")]);
  mocks.control.mockResolvedValue({ mode: "disabled" });
  mocks.write.mockImplementation(async (entries: unknown[]) => entries.length);
  mocks.call.mockImplementation(async (tasks: readonly ProductTranslationTask[]) => ({ ok: false, error: "fixture", outputs: tasks.map(() => "") }));
});
afterEach(() => { setServingContractSnapshotForTest(null); pinTextRanks(null); });

// 운영 수요 순서(갱신 시각·제품·언어)는 한 제품의 en·ja·zh-Hans 를 잇달아 낸다 — 예전 묶음은 [A.zh, B.en, B.ja, B.zh] 처럼 섞였다
it("reproduces the old mixed batch: the plain ordered pack puts ja right after zh-Hans", () => {
  const queue = [task(1, "zh-Hans"), task(2, "ja"), task(2, "zh-Hans"), task(3, "en")];
  expect(keys(packProductTranslationBatch(queue, productTranslationPolicy()))).toEqual(["1:zh-Hans", "2:ja", "2:zh-Hans", "3:en"]);
  expect(keys(packProductTranslationBatch(sameLocaleTranslationCandidates(queue), productTranslationPolicy()))).toEqual(["1:zh-Hans", "2:zh-Hans"]);
});

it("keeps the oldest task's locale and order; the oldest task is always in", () => {
  const queue = [task(5, "ja", 2), task(1, "zh-Hans"), task(6, "ja"), task(1, "en"), task(7, "ja")];
  expect(keys(sameLocaleTranslationCandidates(queue))).toEqual(["5:ja", "6:ja", "7:ja"]);
  expect(sameLocaleTranslationCandidates([])).toEqual([]);
  expect(keys(sameLocaleTranslationCandidates([task(9, "en")]))).toEqual(["9:en"]);
});

it("the job reads a wider window and dispatches only one locale per call", async () => {
  // A·B·C 의 en·ja·zh-Hans 가 섞인 8건 — 맨 앞이 zh-Hans 면 zh-Hans 만, ja 는 다음 묶음에서 ja 끼리
  mocks.tasks.mockResolvedValueOnce([task(1, "zh-Hans"), task(2, "en"), task(2, "ja"), task(2, "zh-Hans"),
    task(3, "en"), task(3, "ja"), task(3, "zh-Hans"), task(4, "ja")]).mockResolvedValue([]);
  expect(await translateDemandedProductFields(context())).toEqual({ done: true });
  expect(mocks.tasks).toHaveBeenCalledTimes(1);
  expect(mocks.tasks.mock.calls[0][0]).toBe(PRODUCT_TRANSLATION_CANDIDATE_WINDOW);
  expect(PRODUCT_TRANSLATION_CANDIDATE_WINDOW).toBeGreaterThan(productTranslationPolicy().batchMax);
  expect(mocks.call).toHaveBeenCalledOnce();
  expect(keys(mocks.call.mock.calls[0][0])).toEqual(["1:zh-Hans", "2:zh-Hans", "3:zh-Hans"]);
  // 기록도 그 묶음만 — 남은 en·ja 는 넘김(passed)이 아니라 다음 묶음이 고른다
  expect(keys(mocks.write.mock.calls[0][0].map((entry: { task: ProductTranslationTask }) => entry.task))).toEqual(["1:zh-Hans", "2:zh-Hans", "3:zh-Hans"]);
});

it("a retried ja task behind zh-Hans is still sent only with ja", async () => {
  mocks.tasks.mockResolvedValueOnce([task(8, "ja", 1), task(1, "zh-Hans"), task(9, "ja", 3), task(1, "en"), task(2, "ja")]).mockResolvedValue([]);
  await translateDemandedProductFields(context());
  const batch: ProductTranslationTask[] = mocks.call.mock.calls[0][0];
  expect(keys(batch)).toEqual(["8:ja", "9:ja", "2:ja"]);
  // 그 묶음의 wire: 모든 항목이 ja, 일본어 지시는 맨 끝에 붙고 시스템 문장의 공통 앞부분은 그대로다(M1Max 프롬프트 캐시)
  const wire = JSON.parse(productTranslationGatewayWire(batch.map(item), "Qwen3.8-27B-4bit"));
  const sent = JSON.parse(wire.messages[1].content) as { locale: string }[];
  expect(new Set(sent.map(entry => entry.locale))).toEqual(new Set(["ja"]));
  const plain = JSON.parse(productTranslationGatewayWire(batch.map(entry => item({ ...entry, locale: "zh-Hans" })), "Qwen3.8-27B-4bit"));
  expect(wire.messages[0].content.startsWith(plain.messages[0].content)).toBe(true);
  expect(wire.messages[0].content.slice(plain.messages[0].content.length)).toContain("Do not output Chinese or Korean for ja");
});

it("no dispatched batch ever mixes locales across a whole simulated queue", () => {
  const locales: Locale[] = ["en", "ja", "zh-Hans"];
  let queue = Array.from({ length: 30 }, (_, index) => task(Math.floor(index / 3) + 1, locales[index % 3]));
  const batches: string[][] = [];
  while (queue.length) {
    const window = queue.slice(0, PRODUCT_TRANSLATION_CANDIDATE_WINDOW);
    const batch = packProductTranslationBatch(sameLocaleTranslationCandidates(window), productTranslationPolicy());
    batches.push(batch.map(entry => entry.locale));
    queue = queue.filter(entry => !batch.includes(entry));
  }
  expect(batches.every(batch => new Set(batch).size === 1)).toBe(true);
  expect(batches.flat()).toHaveLength(30);
  // 창 16건이면 en 이 6건 — 첫 묶음은 맨 앞 en 과 같은 언어로 4건을 채운다
  expect(batches[0]).toEqual(["en", "en", "en", "en"]);
});

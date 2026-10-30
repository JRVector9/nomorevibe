import { expect, it } from "vitest";
import { packProductTranslationBatch, PRODUCT_TRANSLATION_BATCH_CHARS, PRODUCT_TRANSLATION_MAX_SOURCE_CHARS } from "@/lib/domain/products/translation-policy";

const task = (id: number, chars: number, field: "description" | "tagline" = "description") =>
  ({ source: { id, name: `p${id}`, tagline: field === "tagline" ? "t".repeat(chars) : "tagline", description: field === "description" ? "d".repeat(chars) : "" }, field });

it("긴 설명은 단독으로 나가고 짧은 것만 8K 자까지 묶인다 — 300초 상한 안에 끝나게", () => {
  expect(PRODUCT_TRANSLATION_BATCH_CHARS).toBe(8_000);
  expect(PRODUCT_TRANSLATION_BATCH_CHARS).toBeLessThan(PRODUCT_TRANSLATION_MAX_SOURCE_CHARS);
  // 첫 건은 길이와 무관하게 들어간다(설명 상한 8,000자, 입력 상한 30K 자).
  expect(packProductTranslationBatch([task(1, 8_000), task(2, 100)]).map(t => t.source.id)).toEqual([1]);
  expect(packProductTranslationBatch([task(1, 20_000)]).map(t => t.source.id)).toEqual([1]);
  // 짧은 것은 합이 임계를 넘기 직전까지 순서대로, 건너뛰지 않고 묶인다.
  expect(packProductTranslationBatch([task(1, 3_000), task(2, 3_000), task(3, 3_000), task(4, 10)]).map(t => t.source.id)).toEqual([1, 2]);
  expect(packProductTranslationBatch([task(1, 2_000), task(2, 2_000), task(3, 2_000), task(4, 2_000), task(5, 1)]).map(t => t.source.id)).toEqual([1, 2, 3, 4]);
  expect(packProductTranslationBatch([task(1, 10, "tagline"), task(2, 20, "tagline"), task(3, 7_980)]).map(t => t.source.id)).toEqual([1, 2]); // 10+20+7,980 > 8,000
  expect(packProductTranslationBatch([])).toEqual([]);
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseQueryTranslation } from "@/lib/crawl/translate";
import { searchQuerySourceLocale } from "@/lib/domain/products/search-translation";
import { bootstrapMean, cjkQuery, loadTuples, ndcg } from "../scripts/experiments/multilingual-search-shared";

const judgments: Record<string, Record<string, number>> = JSON.parse(readFileSync(path.join(__dirname, "..", "scripts", "search-judgments.json"), "utf8"));
const translations: { answers: Record<string, string> } = JSON.parse(
  readFileSync(path.join(__dirname, "..", "scripts", "experiments", "multilingual-search-translations.json"), "utf8"),
);

describe("4-language search evaluation set", () => {
  const tuples = loadTuples();

  it("covers every judged query once, with four language versions that reuse its judgments", () => {
    const source = readFileSync(path.join(__dirname, "..", "scripts", "search-judged.ts"), "utf8");
    const judged = [...source.matchAll(/\["([^"]+)", "([^"]+)"\]/g)].map((match) => `${match[1]}→${match[2]}`)
      .filter((pair) => !pair.startsWith("seeded→") && !pair.startsWith("verified→"));
    expect(judged).toHaveLength(60);
    expect(tuples.map((tuple) => `${tuple.key}→${tuple.slug}`).sort()).toEqual([...judged].sort());
    for (const tuple of tuples) {
      expect(judgments[tuple.key], tuple.key).toBeDefined();
      expect(tuple[tuple.source]).toBe(tuple.key);
      expect(tuple.ko).toMatch(/[가-힣]/);
      expect(tuple.en).not.toMatch(/[가-힣\u3040-\u30ff\u4e00-\u9fff]/u);
      expect(tuple.zh).not.toMatch(/[가-힣\u3040-\u30ff]/u);
      expect(tuple.ja).not.toMatch(/[가-힣]/);
    }
  });

  it("has a parseable proxy translation for every non-English query", () => {
    for (const tuple of tuples) for (const query of [tuple.ko, tuple.zh, tuple.ja]) {
      expect(parseQueryTranslation(translations.answers[query] ?? ""), query).toBeTruthy();
    }
  });

  it("records that production leaves every Chinese and Japanese query in the set untranslated", () => {
    expect(tuples.filter((tuple) => searchQuerySourceLocale(tuple.zh) !== null)).toHaveLength(0);
    expect(tuples.filter((tuple) => searchQuerySourceLocale(tuple.ja) !== null)).toHaveLength(0);
    expect(tuples.every((tuple) => searchQuerySourceLocale(tuple.ko) === "ko")).toBe(true);
  });
});

describe("blind supplementary judgments", () => {
  it("only add 0/1/2 grades for evaluation keys and never override the base judgments", () => {
    const extra: Record<string, Record<string, number>> = JSON.parse(
      readFileSync(path.join(__dirname, "..", "scripts", "experiments", "multilingual-search-judgments-extra.json"), "utf8"),
    ).judgments;
    const keys = new Set(loadTuples().map((tuple) => tuple.key));
    for (const [key, grades] of Object.entries(extra)) {
      expect(keys.has(key), key).toBe(true);
      for (const [slug, grade] of Object.entries(grades)) {
        expect([0, 1, 2]).toContain(grade);
        expect(slug in (judgments[key] ?? {}), `${key} / ${slug}`).toBe(false);
      }
    }
  });
});

describe("cjkQuery", () => {
  it("takes Chinese and Japanese, including kanji-only Japanese, and leaves Korean and English alone", () => {
    expect(cjkQuery("家計簿アプリ")).toBe(true);
    expect(cjkQuery("薬 副作用 確認")).toBe(true);
    expect(cjkQuery("离线购物清单")).toBe(true);
    expect(cjkQuery("Node Slack机器人")).toBe(true);
    expect(cjkQuery("장보기 목록 앱")).toBe(false);
    expect(cjkQuery("韓國 유학")).toBe(false);
    expect(cjkQuery("gym workout log")).toBe(false);
  });
});

describe("scoring helpers", () => {
  it("computes nDCG@10 against the judged ideal", () => {
    expect(ndcg([2, 1, 0], [2, 1])).toBeCloseTo(1);
    expect(ndcg([0, 2], [2])).toBeCloseTo(1 / Math.log2(3));
    expect(ndcg([0], [])).toBe(0);
  });

  it("gives a deterministic bootstrap interval around the mean", () => {
    const values = Array.from({ length: 60 }, (_, index) => (index % 3) / 10);
    const first = bootstrapMean(values, 2000);
    expect(bootstrapMean(values, 2000)).toEqual(first);
    expect(first.low).toBeLessThanOrEqual(first.mean);
    expect(first.high).toBeGreaterThanOrEqual(first.mean);
  });
});

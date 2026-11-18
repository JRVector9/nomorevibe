/**
 * 4개 언어 검색 평가의 순수 부분 — 평가셋 읽기, 중·일 판별(제안), nDCG, bootstrap 구간. DB·모델을 부르지 않는다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const LANGS = ["en", "ko", "zh", "ja"] as const;
export type Lang = (typeof LANGS)[number];
export const ARMS = ["cold", "current", "current-prodcache", "cjk", "cjk+vec", "cjk+rr", "cjk+vec+rr"] as const;
export type Arm = (typeof ARMS)[number];
export type Tuple = { key: string; slug: string; source: "en" | "ko" } & Record<Lang, string>;

const QUERIES_FILE = path.join(__dirname, "multilingual-search-queries.json");
export const loadTuples = (): Tuple[] => JSON.parse(readFileSync(QUERIES_FILE, "utf8")).tuples;

/** 제안 — 한글이 없고 한자나 가나가 있으면 중·일 검색어로 본다(가나 없는 한자만의 일본어도 든다) */
export function cjkQuery(text: string): boolean {
  return !/[가-힣]/.test(text) && /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(text);
}

const gain = (grade: number) => 2 ** grade - 1;
export function ndcg(grades: readonly number[], ideal: readonly number[], k = 10): number {
  const dcg = (list: readonly number[]) => list.slice(0, k).reduce((sum, grade, index) => sum + gain(grade) / Math.log2(index + 2), 0);
  const best = dcg([...ideal].sort((a, b) => b - a));
  return best ? dcg(grades) / best : 0;
}

/** 시드가 있는 난수(mulberry32) — 구간을 다시 내도 같다 */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMean(values: readonly number[], resamples = 10_000, seed = 20261118): { mean: number; low: number; high: number } {
  const next = random(seed);
  const n = values.length;
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(next() * n)];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  return { mean, low: means[Math.floor(resamples * 0.025)], high: means[Math.floor(resamples * 0.975)] };
}

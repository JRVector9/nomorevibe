import { describe, it, expect, beforeAll, beforeEach } from "vitest";

const { db } = await import("@/lib/db");
const { searchQueries } = await import("@/lib/db/schema");
const { recordSearch, searchLogSummary, pruneSearchQueries } = await import("@/lib/domain/products/search-log");
const { ensureSchema, resetTables } = await import("./setup");
const { sql } = await import("drizzle-orm");

const log = (over: Partial<Parameters<typeof recordSearch>[0]> = {}) =>
  recordSearch({ query: "회의록 요약", keywords: null, results: 0, filtered: false, startedAt: new Date(), ...over });

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(searchQueries);
  await resetTables();
});

describe("검색 질의 기록", () => {
  it("친 글과 결과 수를 남긴다 — 사람을 가리키는 값은 남기지 않는다", async () => {
    await log({ query: "  PDF 합치는 도구 ", keywords: "merge pdf", results: 23 });

    const [row] = await db.select().from(searchQueries);
    expect(row).toMatchObject({ query: "PDF 합치는 도구", normalized: "pdf 합치는 도구", keywords: "merge pdf", results: 23, filtered: false });
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(row)).toEqual(["id", "query", "normalized", "keywords", "results", "filtered", "durationMs", "searchedAt"]);
  });

  it("빈 검색어는 남기지 않는다", async () => {
    await log({ query: "   " });
    expect(await db.select().from(searchQueries)).toHaveLength(0);
  });

  it("공백·대소문자만 다른 말은 한 줄로 묶어 센다", async () => {
    await log({ query: "Merge PDF" });
    await log({ query: "merge   pdf" });

    const summary = await searchLogSummary(7);
    expect(summary.searches).toBe(2);
    expect(summary.misses).toHaveLength(1);
    expect(summary.misses[0]).toMatchObject({ count: 2 });
  });

  it("거르기 때문에 0건인 것은 '못 찾은 말'에서 뺀다 — 말이 안 통한 것이 아니다", async () => {
    await log({ query: "가계부", filtered: true });
    await log({ query: "환율 계산기", filtered: false });

    const summary = await searchLogSummary(7);
    expect(summary.zero).toBe(2);
    expect(summary.misses.map((row) => row.query)).toEqual(["환율 계산기"]);
  });

  it("찾은 말과 못 찾은 말을 갈라 세고, 번역한 횟수와 p95 를 낸다", async () => {
    await log({ query: "회의록 요약", keywords: "meeting summary", results: 17 });
    await log({ query: "회의록 요약", keywords: "meeting summary", results: 17 });
    await log({ query: "없는 말", results: 0 });

    const summary = await searchLogSummary(7);
    expect(summary).toMatchObject({ searches: 3, zero: 1, translated: 2 });
    expect(summary.hits[0]).toMatchObject({ query: "회의록 요약", count: 2, results: 17 });
    expect(summary.misses[0]).toMatchObject({ query: "없는 말", count: 1 });
    expect(summary.p95Ms).not.toBeNull();
  });

  it("창 밖의 기록은 세지 않고, 오래된 것은 지운다", async () => {
    await log({ query: "옛날 말" });
    await db.update(searchQueries).set({ searchedAt: sql`now() - interval '100 days'` });
    await log({ query: "요즘 말" });

    expect((await searchLogSummary(7)).searches).toBe(1);
    expect(await pruneSearchQueries(90)).toBe(1);
    expect(await db.select().from(searchQueries)).toHaveLength(1);
  });
});

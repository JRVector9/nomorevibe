import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { TEST_DATABASE_URL, ensureSchema } from "./setup";

/**
 * 관련도순 검색은 결과가 0건이면 공개 읽기(복제본, lib/domain/products/public-reads.ts) 안에서 번역을 기다린다
 * (relevance.ts searchRelevance). 번역을 적는 일은 쓰기라 복제본에서는 실패한다 — 그래도 번역은 붙고, 기록은 주 DB 에 남아야 한다.
 * 복제본은 같은 DB 에 읽기 전용 연결로 흉내 낸다(운영 복제본처럼 쓰기는 25006 으로 실패한다).
 */
const mocks = vi.hoisted(() => ({ translate: vi.fn() }));
vi.mock("@/lib/crawl/translate", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/crawl/translate")>(),
  translateQueryToEnglish: mocks.translate,
}));

const globalForDb = globalThis as unknown as { readDb?: unknown };

beforeAll(() => {
  ensureSchema();
  process.env.READ_DATABASE_URL = `${TEST_DATABASE_URL}?default_transaction_read_only=on`;
  globalForDb.readDb = undefined;
});
afterAll(() => {
  delete process.env.READ_DATABASE_URL;
  globalForDb.readDb = undefined;
});

const { db, onReplica } = await import("@/lib/db");
const { textTranslations } = await import("@/lib/db/schema");
const { queryTranslationKey, resolveSearchQuery } = await import("@/lib/domain/products/search-translation");

describe("복제본 안에서 기다린 검색어 번역", () => {
  it("번역을 붙이고 번역 기록은 주 DB 에 남긴다", async () => {
    const query = "방송 평점 차트 복제본";
    const hash = queryTranslationKey(query);
    await db.delete(textTranslations).where(eq(textTranslations.sourceHash, hash));
    mocks.translate.mockResolvedValue({ ok: true, keywords: "tv show ratings" });

    const resolved = await onReplica(() => resolveSearchQuery(query, { waitForTranslation: true }));

    expect(resolved.translated).toBe("tv show ratings");
    const [row] = await db.select().from(textTranslations)
      .where(and(eq(textTranslations.sourceHash, hash), eq(textTranslations.targetLang, "en")));
    expect(row?.translated).toBe("tv show ratings");
  });
});

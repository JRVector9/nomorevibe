import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("@/lib/domain/products/og", () => ({ cacheOgImage: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/crawl/classify", () => ({
  classifyCategory: vi.fn().mockResolvedValue(null),
  classifyCategories: vi.fn().mockImplementation(async (inputs: unknown[]) => inputs.map(() => null)),
}));

const { db } = await import("@/lib/db");
const { crawlFrontier, crawlDocuments, crawlCandidates, crawlSettings, jobs } = await import("@/lib/db/schema");
const crawl = await import("@/lib/crawl/repository");
const { saveSettings, getSettings } = await import("@/lib/crawl/settings");
const { publishCandidates } = await import("@/lib/crawl/jobs/publish");
const { runJob } = await import("@/lib/jobs/runner");
const { recheckPublishedProducts } = await import("@/lib/domain/products/recheck");
const { ensureSchema, resetTables } = await import("./setup");

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

/** 발행까지 마친 제품 하나 */
async function published(
  repo: string,
  over: { title?: string; pushedAt?: string; productUrl?: string } = {},
) {
  const productUrl = over.productUrl ?? `https://${repo.split("/")[1]}.test`;
  await crawl.putDocument({
    repo,
    repoMeta: { description: "레포 설명", language: "TypeScript", pushed_at: over.pushedAt ?? daysAgo(3) },
    productUrl,
    pageStatus: 200,
    pageMeta: { title: over.title ?? "My App", description: "소개", ogImage: null },
  });
  await crawl.recordJudgement({
    repo, productUrl, state: "approved", reason: "passed", decidedBy: "auto", signals: { stars: 3 },
  });
  await runJob("crawl-publish", publishCandidates);
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  await saveSettings({ enabled: true }, "테스트");
});

describe("발행분 재검수", () => {
  it("지금 기준으로 거부가 되는 것을 멈춘 규칙과 함께 짚는다", async () => {
    await published("someone/scut-docs", { title: "Scut Docs" });

    const result = await recheckPublishedProducts(await getSettings());

    expect(result.checked).toBe(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ repo: "someone/scut-docs", reason: "not_a_product" });
    expect(result.hits[0].stopped?.rule).toBe("문서 제목 아님");
  });

  /**
   * 이 규칙은 시간이 가면 저절로 걸린다. 짚어 주면 재검수 목록이 날마다 불어나
   * 실제로 내려야 할 것을 덮는다. 실측(2026-09-10): 걸린 31건의 주소가 전부 HTTP 200이었다.
   */
  it("푸시가 끊긴 것만으로는 짚지 않는다 — 내릴 근거가 아니다", async () => {
    const settings = await getSettings();
    await published("someone/quiet-app", { pushedAt: daysAgo(settings.judge.maxPushAgeDays + 30) });

    const result = await recheckPublishedProducts(settings);

    expect(result.checked).toBe(1);
    expect(result.hits).toEqual([]);
  });

  it("푸시가 끊겼어도 제품이 아니면 그 사유로 짚는다", async () => {
    const settings = await getSettings();
    await published("someone/old-docs", {
      title: "Old Docs",
      pushedAt: daysAgo(settings.judge.maxPushAgeDays + 30),
    });

    const result = await recheckPublishedProducts(settings);

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].stopped?.rule).toBe("문서 제목 아님");
  });
});

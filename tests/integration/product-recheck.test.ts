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
  over: { title?: string; pushedAt?: string; productUrl?: string; textSample?: string } = {},
) {
  const productUrl = over.productUrl ?? `https://${repo.split("/")[1]}.test`;
  await crawl.putDocument({
    repo,
    repoMeta: { description: "레포 설명", language: "TypeScript", pushed_at: over.pushedAt ?? daysAgo(3) },
    productUrl,
    pageStatus: 200,
    pageMeta: {
      title: over.title ?? "My App", description: "소개", ogImage: null,
      ...(over.textSample ? { textSample: over.textSample } : {}),
    },
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

  /**
   * 2차 검수. 규칙이 본문을 보게 됐지만 이미 발행된 것들은 그 값이 없던 시절에 수집됐다.
   * 못 태운 몫을 세지 않으면 "걸린 게 없다"가 거짓말이 된다.
   */
  it("본문이 채워지면 설치 유도 페이지를 다시 짚는다", async () => {
    await published("someone/cli-landing", { textSample: "Loom · orchestrate agents. Install: npm install -g loom" });

    const result = await recheckPublishedProducts(await getSettings());

    expect(result.withoutText).toBe(0);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].stopped?.rule).toBe("설치 유도 아님");
  });

  it("본문이 아직 없는 발행분은 못 태운 몫으로 센다", async () => {
    await published("someone/no-text");

    const result = await recheckPublishedProducts(await getSettings());

    expect(result.checked).toBe(1);
    expect(result.withoutText).toBe(1);
    expect(result.hits).toEqual([]);
  });

  /**
   * 푸시 나이에서 멈추면 그 뒤 규칙("설치 유도 아님")을 아직 안 태운 것이다.
   * 판정을 통째로 버리면 210일 전에 손을 뗀 설치 안내 페이지가 조용히 빠져나간다.
   */
  it("푸시가 끊겨 멈춘 것도 나머지 규칙까지 태운다", async () => {
    const settings = await getSettings();
    await published("someone/old-cli", {
      pushedAt: daysAgo(settings.judge.maxPushAgeDays + 30),
      textSample: "old-cli — install with npm install -g old-cli",
    });

    const result = await recheckPublishedProducts(settings);

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].stopped?.rule).toBe("설치 유도 아님");
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

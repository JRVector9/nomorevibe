import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// OG 이미지 복사는 바깥 네트워크를 탄다 — 발행 자체를 보는 테스트에서는 끈다
vi.mock("@/lib/domain/products/og", () => ({ cacheOgImage: vi.fn().mockResolvedValue(null) }));

const { db } = await import("@/lib/db");
const { crawlFrontier, crawlDocuments, crawlCandidates, crawlSettings, jobs } = await import(
  "@/lib/db/schema"
);
const crawl = await import("@/lib/crawl/repository");
const products = await import("@/lib/domain/products/repository");
const { saveSettings } = await import("@/lib/crawl/settings");
const { publishCandidates } = await import("@/lib/crawl/jobs/publish");
const { runJob } = await import("@/lib/jobs/runner");
const { getPublicList, getRankedList, isUnclaimed } = await import("@/lib/domain/products/view");
const { ensureSchema, resetTables } = await import("./setup");

/** 발행 대기 상태의 후보 하나 (원본 + approved 판정) */
async function approved(
  repo: string,
  over: { productUrl?: string; meta?: Record<string, unknown>; pageMeta?: Record<string, unknown> } = {},
) {
  const productUrl = over.productUrl ?? "https://my-app.test";
  await crawl.putDocument({
    repo,
    repoMeta: { description: "레포 설명", language: "TypeScript", ...over.meta },
    productUrl,
    pageStatus: 200,
    pageMeta: over.pageMeta ?? { title: "My App", description: "페이지가 말하는 소개", ogImage: null },
  });
  await crawl.recordJudgement({
    repo,
    productUrl,
    state: "approved",
    reason: "passed",
    decidedBy: "auto",
    signals: { stars: 3 },
  });
}

const tick = () => runJob("crawl-publish", publishCandidates);

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

describe("발행 잡", () => {
  it("통과한 후보를 seeded 제품으로 올린다", async () => {
    await approved("someone/my-app");

    const result = await tick();

    expect(result).toMatchObject({ status: "completed", done: true });
    const product = await products.findByUrl("https://my-app.test");
    expect(product).toMatchObject({
      name: "My App",
      tagline: "페이지가 말하는 소개",
      status: "seeded",
      source: "crawler",
      repoUrl: "https://github.com/someone/my-app",
      stack: ["TypeScript"],
    });
    // 주인이 없는 상태다 — 랭킹에서 빠지고 미클레임 배지가 붙는다
    expect(isUnclaimed(product!)).toBe(true);
    expect(product?.builder).toBeNull();
  });

  it("후보를 발행됨으로 표시하고 slug를 남긴다", async () => {
    await approved("someone/my-app");

    await tick();

    const candidate = await crawl.getCandidate("someone/my-app");
    expect(candidate?.state).toBe("published");
    expect(candidate?.publishedSlug).toBe((await products.findByUrl("https://my-app.test"))?.slug);
  });

  it("발행한 제품은 공개 목록에 뜨되 랭킹에는 빠진다", async () => {
    await approved("someone/my-app");

    await tick();

    expect(await getPublicList(10)).toHaveLength(1);
    expect(await getRankedList(10)).toHaveLength(0);
  });

  it("소개가 아무 데도 없으면 레포 이름을 쓴다 — 지어내지 않는다", async () => {
    await approved("someone/mystery", {
      meta: { description: null, language: null },
      pageMeta: { title: null, description: null, ogImage: null },
    });

    await tick();

    const product = await products.findByUrl("https://my-app.test");
    expect(product).toMatchObject({ name: "mystery", tagline: "someone/mystery", stack: [] });
  });

  it("제목의 마케팅 문구를 이름에서 뗀다", async () => {
    // 실제 수집: "RevealUI | Build it once. Every product after starts ahead." 가 통째로 이름이 됐다
    await approved("someone/reveal", {
      pageMeta: { title: "RevealUI | Build it once. Every product after starts ahead.", description: "소개" },
    });

    await tick();

    expect((await products.findByUrl("https://my-app.test"))?.name).toBe("RevealUI");
  });

  it("이름 안의 하이픈은 자르지 않는다", async () => {
    await approved("someone/shop", { pageMeta: { title: "e-commerce-kit", description: "소개" } });

    await tick();

    expect((await products.findByUrl("https://my-app.test"))?.name).toBe("e-commerce-kit");
  });

  it("topics로 카테고리를 추정한다", async () => {
    await approved("someone/tool", { meta: { topics: ["cli", "rust"], description: "도구" } });

    await tick();

    expect((await products.findByUrl("https://my-app.test"))?.category).toBe("Dev");
  });

  it("단서가 없으면 Other로 둔다", async () => {
    await approved("someone/thing", { meta: { description: "무언가", topics: [] } });

    await tick();

    expect((await products.findByUrl("https://my-app.test"))?.category).toBe("Other");
  });

  it("메이커가 먼저 등록한 URL은 거부로 내린다 — 큐가 막히면 안 된다", async () => {
    await products.insert({
      slug: "my-app",
      url: "https://my-app.test",
      name: "My App",
      tagline: "메이커가 먼저 등록",
      description: "먼저 등록했다.",
      category: "Other",
      stack: [],
      status: "verified",
      source: "skill",
      verifyToken: "nmv_verify_first",
      editTokenHash: "x".repeat(64),
    });
    await approved("someone/my-app");

    await tick();

    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({
      state: "rejected",
      reason: "already_listed",
    });
  });

  it("원본이 없는 후보에 걸려 큐가 멈추지 않는다", async () => {
    await crawl.recordJudgement({
      repo: "someone/ghost",
      productUrl: "https://ghost.test",
      state: "approved",
      reason: "passed",
      decidedBy: "auto",
    });
    await approved("someone/my-app");

    const result = await tick();

    expect(result).toMatchObject({ done: true });
    expect(await crawl.getCandidate("someone/ghost")).toMatchObject({ state: "rejected" });
    expect(await products.findByUrl("https://my-app.test")).toBeDefined();
  });

  it("수집이 꺼져 있으면 발행하지 않는다", async () => {
    await saveSettings({ enabled: false }, "테스트");
    await approved("someone/my-app");

    await tick();

    expect(await products.findByUrl("https://my-app.test")).toBeUndefined();
  });
});

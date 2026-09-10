import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

// OG 이미지 복사는 바깥 네트워크를 탄다 — 발행 자체를 보는 테스트에서는 끈다
vi.mock("@/lib/domain/products/og", () => ({ cacheOgImage: vi.fn().mockResolvedValue(null) }));

// 분류도 바깥을 탄다. 기본은 "못 했다"로 두어 규칙 폴백을 확인하고, 필요한 테스트에서만 값을 준다
const classifyCategory = vi.fn().mockResolvedValue(null);
const classifyCategories = vi.fn().mockImplementation(async (inputs: unknown[]) => inputs.map(() => null));
vi.mock("@/lib/crawl/classify", () => ({
  classifyCategory: (...a: unknown[]) => classifyCategory(...a),
  classifyCategories: (...a: unknown[]) => classifyCategories(...a),
}));

const { db } = await import("@/lib/db");
const { crawlFrontier, crawlDocuments, crawlCandidates, crawlSettings, jobs, agentRepositoryScans, agentRepositoryObservations } = await import(
  "@/lib/db/schema"
);
const crawl = await import("@/lib/crawl/repository");
const products = await import("@/lib/domain/products/repository");
const { saveSettings } = await import("@/lib/crawl/settings");
const { publishCandidates } = await import("@/lib/crawl/jobs/publish");
const { runJob } = await import("@/lib/jobs/runner");
const { getPublicList, getRankedList, isUnclaimed, builderClaimOf } = await import("@/lib/domain/products/view");
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

/** 지금 규칙을 그대로 통과하는 레포 사실 — 발행 직전 재판정을 태우는 테스트가 쓴다 */
const LIVE_REPO = {
  stargazers_count: 3, fork: false, archived: false, owner: { type: "User" }, pushed_at: new Date().toISOString(),
};

/** 판정이 원본보다 먼저였던 것으로 만든다 — 같은 밀리초에 두 값이 찍히면 선후를 가를 수 없다 */
async function judgedEarlier(repo: string) {
  await db.update(crawlCandidates).set({ judgedAt: new Date(Date.now() - 60_000) }).where(eq(crawlCandidates.repo, repo));
}

/** 승인 뒤 같은 주소로 다시 받아 온 원본 */
async function refetched(repo: string, pageStatus: number) {
  await crawl.putDocument({
    repo,
    repoMeta: { description: "레포 설명", language: "TypeScript", ...LIVE_REPO },
    productUrl: "https://my-app.test",
    pageStatus,
    pageMeta: { title: "My App", description: "페이지가 말하는 소개", ogImage: null },
  });
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  classifyCategory.mockReset();
  classifyCategory.mockResolvedValue(null);
  classifyCategories.mockReset();
  classifyCategories.mockImplementation(async (inputs: unknown[]) => inputs.map(() => null));
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
    // 프론티어에 발견 기록이 없으면 "만든 AI"를 지어내지 않는다
    expect(product?.builder).toBeNull();
  });

  it("검색 힌트가 있어도 제작 AI를 확정하지 않는다", async () => {
    await crawl.enqueue([
      { repo: "someone/my-app", signal: "Claude 커밋 트레일러", builder: "Claude" },
    ]);
    await approved("someone/my-app");

    await tick();

    const product = await products.findByUrl("https://my-app.test");
    expect(product?.builder).toBeNull();
    expect(builderClaimOf(product!)).toBe("guessed"); // Claim kind has no visible value when builder is null.
  });

  it("데려온 신호가 어떤 AI인지 말하지 않으면 붙이지 않는다", async () => {
    // topic:vibe-coding 같은 레포 신호가 그렇다 — 배포물인 것만 말하고 도구는 말하지 않는다
    await crawl.enqueue([{ repo: "someone/my-app", signal: "vibe-coding 토픽", builder: null }]);
    await approved("someone/my-app");

    await tick();

    expect((await products.findByUrl("https://my-app.test"))?.builder).toBeNull();
  });

  it("신호 이름 변경으로도 제작 AI 추정이 되살아나지 않는다", async () => {
    // 프론티어의 signal은 첫 발견 때 굳은 문자열이다. 그것을 현재 설정에서 이름으로 찾으면
    // 운영자가 라벨을 고치는 순간(정상적인 운영 행위다) 밀려 있던 후보가 전부 추정을 잃는다.
    await crawl.enqueue([
      { repo: "someone/my-app", signal: "Claude 커밋 트레일러", builder: "Claude" },
    ]);
    await approved("someone/my-app");
    await saveSettings({
      discover: { queries: [{ label: "Claude 트레일러", query: "Co-authored-by: Claude", enabled: true, priority: 100, builder: "Claude" }] },
    }, "테스트");

    await tick();

    expect((await products.findByUrl("https://my-app.test"))?.builder).toBeNull();
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

  it("소개가 아무 데도 없으면 올리지 않고 사람에게 넘긴다", async () => {
    // 무엇을 하는 것인지 아무도 모르는 항목을 목록에 올릴 수는 없다
    await approved("someone/mystery", {
      meta: { description: null, language: null },
      pageMeta: { title: null, description: null, ogImage: null },
    });

    await tick();

    expect(await products.findByUrl("https://my-app.test")).toBeUndefined();
    expect(await crawl.getCandidate("someone/mystery")).toMatchObject({
      state: "needs_review",
      reason: "ambiguous",
    });
  });

  it("사람이 승인한 것은 소개가 없어도 올린다 — 심사로 되돌아오면 끝나지 않는다", async () => {
    await approved("someone/mystery", {
      meta: { description: null, language: null },
      pageMeta: { title: null, description: null, ogImage: null },
    });
    // 심사에서 사람이 통과시킨 상태
    await crawl.recordJudgement({
      repo: "someone/mystery",
      productUrl: "https://my-app.test",
      state: "approved",
      reason: "passed",
      decidedBy: "admin",
    });

    await tick();

    // 지어내지 않고 레포 이름을 쓴다
    expect(await products.findByUrl("https://my-app.test")).toMatchObject({
      name: "mystery",
      tagline: "someone/mystery",
      stack: [],
    });
  });

  it("제목의 마케팅 문구를 이름에서 뗀다", async () => {
    // 실제 수집: "RevealUI | Build it once. Every product after starts ahead." 가 통째로 이름이 됐다
    await approved("someone/reveal", {
      pageMeta: { title: "RevealUI | Build it once. Every product after starts ahead.", description: "소개" },
    });

    await tick();

    expect((await products.findByUrl("https://my-app.test"))?.name).toBe("RevealUI");
  });

  it("공백이 있는 하이픈에서 이름을 자른다 — 실데이터에서 가장 흔한 구분자다", async () => {
    await approved("someone/swarms", {
      pageMeta: { title: "DEEPSEEKAGENTS - AI-Powered Agentic Swarms for Product Development", description: "소개" },
    });

    await tick();

    expect((await products.findByUrl("https://my-app.test"))?.name).toBe("DEEPSEEKAGENTS");
  });

  it("이름 안의 하이픈은 자르지 않는다", async () => {
    await approved("someone/shop", { pageMeta: { title: "e-commerce-kit", description: "소개" } });

    await tick();

    expect((await products.findByUrl("https://my-app.test"))?.name).toBe("e-commerce-kit");
  });

  it("분류가 고른 카테고리를 쓴다", async () => {
    classifyCategories.mockResolvedValueOnce(["Design"]);
    await approved("someone/paint", { meta: { topics: ["cli"], description: "그림 도구" } });

    await tick();

    // topics만 보면 Dev로 떨어질 것을 분류가 바로잡는다
    expect((await products.findByUrl("https://my-app.test"))?.category).toBe("Design");
    // 저장된 카테고리 기준을 함께 넘긴다 — 기준이 코드 상수가 아니라 설정이다
    expect(classifyCategories).toHaveBeenCalledWith(
      [expect.objectContaining({ repo: "someone/paint", topics: ["cli"] })],
      undefined, undefined, undefined,
      expect.objectContaining({ Design: expect.objectContaining({ summary: expect.any(String) }) }),
    );
  });

  it("승인 후보 여러 개를 한 번의 분류 배치로 처리한다", async () => {
    await approved("someone/game", { productUrl: "https://game.test", pageMeta: { title: "Game", description: "A playable puzzle game" } });
    await approved("someone/ledger", { productUrl: "https://ledger.test", pageMeta: { title: "Ledger", description: "Stock valuation and backtesting" } });
    classifyCategories.mockImplementationOnce(async (inputs: { repo: string }[]) =>
      inputs.map((input) => input.repo === "someone/game" ? "Games" : "Finance"));

    await tick();

    expect(classifyCategories).toHaveBeenCalledOnce();
    expect(classifyCategories.mock.calls[0][0]).toHaveLength(2);
    expect((await products.findByUrl("https://game.test"))?.category).toBe("Games");
    expect((await products.findByUrl("https://ledger.test"))?.category).toBe("Finance");
  });

  it("분류가 실패하면 규칙으로 되돌아간다 — 카테고리 하나로 발행을 막지 않는다", async () => {
    classifyCategories.mockResolvedValueOnce([null]);
    await approved("someone/tool2", { meta: { topics: ["cli"], description: "도구" } });

    await tick();

    expect((await products.findByUrl("https://my-app.test"))?.category).toBe("Dev");
  });

  it("topics로 카테고리를 추정한다", async () => {
    await approved("someone/tool", { meta: { topics: ["cli", "rust"], description: "도구" } });

    await tick();

    expect((await products.findByUrl("https://my-app.test"))?.category).toBe("Dev");
  });

  it("모델을 쓸 수 없어도 명확한 게임 토픽은 Games로 분류한다", async () => {
    await approved("someone/puzzle", {
      meta: { topics: ["game", "godot"], description: "A playable 2D puzzle" },
      pageMeta: { title: "Puzzle", description: "A playable 2D puzzle" },
    });

    await tick();

    expect((await products.findByUrl("https://my-app.test"))?.category).toBe("Games");
  });

  it("결혼식 소개의 games라는 단어를 게임 제품으로 오인하지 않는다", async () => {
    await approved("someone/wedding", {
      meta: { topics: [], description: "Wedding celebration with food, games and friends" },
      pageMeta: { title: "Our Wedding", description: "Wedding celebration with food, games and friends" },
    });

    await tick();

    expect((await products.findByUrl("https://my-app.test"))?.category).toBe("Lifestyle");
  });

  it("게임 서버 호스팅 도구는 Games보다 Dev를 우선한다", async () => {
    await approved("someone/game-host", {
      meta: { topics: ["docker", "game-server"], description: "Self-host game servers with Docker and Kubernetes" },
      pageMeta: { title: "Game Host", description: "Self-host game servers with Docker and Kubernetes" },
    });

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

  it("분류를 기다리는 동안 관리자가 거부하면 제품을 삽입하지 않고 새 결정을 보존한다", async () => {
    await approved("someone/my-app");
    classifyCategories.mockImplementationOnce(async () => {
      await crawl.recordJudgement({repo:"someone/my-app",productUrl:"https://my-app.test",state:"rejected",reason:"not_a_product",decidedBy:"admin",signals:{review:"newer rejection"}});
      return ["Dev"];
    });
    expect(await tick()).toMatchObject({status:"completed",done:false});
    expect(await products.findByUrl("https://my-app.test")).toBeUndefined();
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({state:"rejected",decidedBy:"admin",signals:{review:"newer rejection"}});
  });

  it("분류를 기다리는 동안 원본 URL이나 저장소 관계가 바뀌면 과거 내용으로 발행하지 않는다", async () => {
    await approved("someone/my-app");
    classifyCategories.mockImplementationOnce(async () => {
      await crawl.putDocument({repo:"someone/my-app",repoMeta:{description:"Changed app"},productUrl:"https://changed.test",pageStatus:200,pageMeta:{repositoryKeys:["github:other/repo"],title:"Changed"}});
      return ["Dev"];
    });
    expect(await tick()).toMatchObject({status:"completed",done:false});
    expect(await products.findByUrl("https://my-app.test")).toBeUndefined();
    expect(await products.findByUrl("https://changed.test")).toBeUndefined();
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({state:"approved"});
    expect(await crawl.getDocument("someone/my-app")).toMatchObject({productUrl:"https://changed.test"});
  });

  it("분류를 기다리는 동안 수집 설정이 바뀌면 새 설정으로 재검토할 때까지 발행하지 않는다", async () => {
    await approved("someone/my-app");
    classifyCategories.mockImplementationOnce(async () => {await saveSettings({enabled:false},"concurrent admin"); return ["Dev"];});
    expect(await tick()).toMatchObject({status:"completed",done:false});
    expect(await products.findByUrl("https://my-app.test")).toBeUndefined();
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({state:"approved"});
  });

  it("발행 전 소개 검사 실패도 그 사이의 관리자 거부 결정을 덮어쓰지 않는다", async () => {
    await approved("someone/my-app",{meta:{description:null},pageMeta:{title:"App"}});
    const getDocument = crawl.getDocument;
    const spy = vi.spyOn(crawl,"getDocument").mockImplementationOnce(async (repo:string) => {
      const document = await getDocument(repo);
      await crawl.recordJudgement({repo,productUrl:"https://my-app.test",state:"rejected",reason:"banned",decidedBy:"admin",signals:{review:"newer rejection"}});
      return document;
    });
    try {
      await tick();
      expect(await products.findByUrl("https://my-app.test")).toBeUndefined();
      expect(await crawl.getCandidate("someone/my-app")).toMatchObject({state:"rejected",reason:"banned",decidedBy:"admin",signals:{review:"newer rejection"}});
    } finally {spy.mockRestore();}
  });

  it("이미 수집 URL이 달라진 승인 후보는 새 관계 근거를 옛 URL에 붙이지 않고 재검토로 보낸다", async () => {
    await approved("someone/my-app");
    await crawl.putDocument({repo:"someone/my-app",repoMeta:{description:"Changed app"},productUrl:"https://changed.test",pageStatus:200,pageMeta:{repositoryKeys:["github:someone/my-app"],title:"Changed app"}});
    expect(await tick()).toMatchObject({status:"completed",done:true});
    expect(await products.findByUrl("https://my-app.test")).toBeUndefined();
    expect(await products.findByUrl("https://changed.test")).toBeUndefined();
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({state:"needs_review",reason:"source_changed",productUrl:"https://my-app.test"});
    expect(classifyCategories).not.toHaveBeenCalled();
    expect(await tick()).toMatchObject({status:"completed",done:true});
  });

  /**
   * codex 재현: HTTP 200일 때 승인된 후보가 발행 전에 다시 수집돼 404가 됐다. 주소가 같아
   * new로 되돌려지지 않았고, reviewMode가 off/observe면 발행은 규칙을 다시 태우지 않아
   * 최신 404 원본으로 seeded가 됐다. 되돌림이 빠진 어떤 경로로 와도 여기서 막는다.
   */
  it("승인 뒤 다시 받은 원본이 지금 규칙을 통과하지 못하면 발행하지 않고 재판정으로 되돌린다", async () => {
    await approved("someone/my-app", { meta: LIVE_REPO });
    await judgedEarlier("someone/my-app");
    await refetched("someone/my-app", 404);

    expect(await tick()).toMatchObject({ status: "completed", done: true });

    expect(await products.findByUrl("https://my-app.test")).toBeUndefined();
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({
      state: "new", reason: "source_changed", decidedBy: "auto",
    });
    // 되돌린 것은 곧바로 다시 판정해야 한다 — 스케줄(5분)을 기다리지 않는다
    expect(await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-judge") }))
      .toMatchObject({ requestedVersion: 1, processedVersion: 0 });
  });

  it("승인 뒤 다시 받은 원본도 지금 규칙을 통과하면 그대로 발행한다", async () => {
    await approved("someone/my-app", { meta: LIVE_REPO });
    await judgedEarlier("someone/my-app");
    await refetched("someone/my-app", 200);

    await tick();

    expect(await products.findByUrl("https://my-app.test")).toMatchObject({ status: "seeded" });
    expect(await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-judge") })).toBeUndefined();
  });

  it("사람이 승인한 것은 원본이 바뀌어도 규칙으로 되돌리지 않는다", async () => {
    await approved("someone/my-app", { meta: LIVE_REPO });
    await crawl.recordJudgement({ repo: "someone/my-app", productUrl: "https://my-app.test",
      state: "approved", reason: "passed", decidedBy: "admin" });
    await judgedEarlier("someone/my-app");
    await refetched("someone/my-app", 404);

    await tick();

    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({ state: "published", decidedBy: "admin" });
  });

  it("분류 도중 같은 SHA의 재확인이 실패하면 보존된 complete 상태로 발행하지 않는다", async () => {
    await approved("someone/my-app",{pageMeta:{title:"App",description:"Description",repositoryKeys:["github:someone/my-app"]}});
    await saveSettings({agentEvidence:{enabled:true,enforceEligibility:true}},"test");
    const commitSha = "a".repeat(40);
    const [scan] = await db.insert(agentRepositoryScans).values({githubRepositoryId:BigInt(1),repositoryKey:"someone/my-app",commitSha,detectorVersion:"2026-09-06.1",scope:"",scopeHash:createHash("sha256").update(JSON.stringify("")).digest("hex"),state:"complete",completedAt:new Date()}).returning();
    await db.insert(agentRepositoryObservations).values({scanId:scan.id,observationKey:"b".repeat(64),facts:{
      kind:"model_config",client:"codex",compatibleClients:["codex"],modelDeveloper:"openai",declaredModelId:"gpt-5",gateway:null,routing:"fixed",role:"main",scope:"",keyPath:"model",ruleId:"codex.config.v1",sourcePath:".codex/config.toml",commitSha,blobSha:"b".repeat(40),sourceUrl:`https://github.com/someone/my-app/blob/${commitSha}/.codex/config.toml`,
    }});
    classifyCategories.mockImplementationOnce(async () => {
      await db.update(agentRepositoryScans).set({lastErrorCode:"rate_limited"}).where(eq(agentRepositoryScans.id,scan.id));
      return ["Dev"];
    });
    expect(await tick()).toMatchObject({status:"completed",done:false});
    expect(classifyCategories).toHaveBeenCalledOnce();
    expect(await products.findByUrl("https://my-app.test")).toBeUndefined();
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({state:"approved"});
  });
});

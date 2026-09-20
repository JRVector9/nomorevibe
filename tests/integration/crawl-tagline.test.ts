import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

const { db } = await import("@/lib/db");
const { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, crawlTaglines, jobs } = await import("@/lib/db/schema");
const crawl = await import("@/lib/crawl/repository");
const { saveSettings } = await import("@/lib/crawl/settings");
const { writeTaglines } = await import("@/lib/crawl/jobs/tagline");
const { runJob } = await import("@/lib/jobs/runner");
const { ensureSchema, resetTables } = await import("./setup");

/** 소개가 없어 발행이 멈춘 후보 하나 */
async function held(repo: string, pageMeta: Record<string, unknown> = { title: "My App", textSample: "바를 등록하면 손님이 찾을 수 있습니다" }) {
  await crawl.putDocument({
    repo, repoMeta: { description: null, language: "TypeScript" },
    productUrl: "https://my-app.test", pageStatus: 200, pageMeta,
  });
  await crawl.recordJudgement({ repo, productUrl: "https://my-app.test", state: "needs_review", reason: "no_description", decidedBy: "auto" });
}

const answer = (tagline: string, source = "page") =>
  ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ tagline, source }) } }] }) }) as unknown as Response;

const tick = () => runJob("crawl-tagline", writeTaglines);

const gateway = vi.fn();

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlTaglines);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  await saveSettings({ enabled: true }, "테스트");
  vi.stubEnv("ABCLLM_API_KEY", "test-key");
  gateway.mockReset();
  gateway.mockResolvedValue(answer("바를 등록하면 손님이 찾습니다"));
  vi.stubGlobal("fetch", gateway);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("소개 짓기 잡", () => {
  it("한 줄을 지어 두고 후보를 발행 대기로 되돌린다", async () => {
    await held("someone/my-app");

    const result = await tick();

    expect(result).toMatchObject({ status: "completed", done: true });
    const [written] = await db.select().from(crawlTaglines);
    expect(written).toMatchObject({ repo: "someone/my-app", tagline: "바를 등록하면 손님이 찾습니다", source: "page", errorCode: null });
    // 발행할지는 발행 잡이 평소 관문으로 정한다 — 여기서는 대기줄로 돌려놓기만 한다
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({ state: "approved", reason: "passed", decidedBy: "auto" });
  });

  it("증거로 알 수 없다고 하면 사람에게 남기고 다시 묻지 않는다", async () => {
    await held("someone/mystery");
    gateway.mockResolvedValue(answer(""));

    await tick();
    await tick();

    expect(await crawl.getCandidate("someone/mystery")).toMatchObject({ state: "needs_review", reason: "no_description" });
    expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ tagline: "" });
    // 첫 틱에 두 번 묻고(빈 줄 재시도), 두 번째 틱은 이미 답이 있어 묻지 않는다
    expect(gateway).toHaveBeenCalledTimes(2);
  });

  it("빈 줄이 오면 한 번만 더 묻는다 — 두 번째에 줄이 오면 그것을 쓴다", async () => {
    await held("someone/second-try");
    gateway.mockResolvedValueOnce(answer("")).mockResolvedValue(answer("바를 등록하면 손님이 찾습니다"));

    await tick();

    expect(gateway).toHaveBeenCalledTimes(2);
    expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ tagline: "바를 등록하면 손님이 찾습니다" });
    expect(await crawl.getCandidate("someone/second-try")).toMatchObject({ state: "approved" });
  });

  it("읽을 글이 아무 데도 없으면 모델을 부르지 않는다", async () => {
    await held("someone/empty", { title: null, textSample: null, readmeSample: null });

    await tick();

    expect(gateway).not.toHaveBeenCalled();
    expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ tagline: "", model: "" });
  });

  it("사람이 이미 결정한 후보는 건드리지 않는다", async () => {
    await held("someone/mine");
    await db.update(crawlCandidates).set({ decidedBy: "admin" }).where(eq(crawlCandidates.repo, "someone/mine"));

    await tick();

    expect(gateway).not.toHaveBeenCalled();
    expect(await db.select().from(crawlTaglines)).toHaveLength(0);
  });

  it("실패는 다시 볼 시각을 달고 남는다 — 잇따라 둘이 막히면 이번 틱은 접는다", async () => {
    await held("someone/my-app");
    await held("someone/other-app");
    gateway.mockResolvedValue({ ok: false, status: 429 } as Response);

    await tick();

    // 한 건의 실패로 접지 않는다 — 둘 다 물어보고 나서 접는다
    expect(gateway).toHaveBeenCalledTimes(2);
    const [written] = await db.select().from(crawlTaglines);
    expect(written).toMatchObject({ errorCode: "rate_limit", attempts: 1, tagline: "" });
    expect(written.retryAt).not.toBeNull();
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({ state: "needs_review", reason: "no_description" });
    expect(await crawl.getCandidate("someone/other-app")).toMatchObject({ state: "needs_review", reason: "no_description" });
  });

  it("실패한 줄은 다시 볼 때가 되면 같은 원본이라도 다시 묻는다", async () => {
    await held("someone/flaky");
    gateway.mockResolvedValue({ ok: false, status: 502 } as Response);
    await tick();
    // 다시 볼 시각을 앞당긴다 — 운영에서는 5분 뒤다
    await db.update(crawlTaglines).set({ retryAt: new Date(Date.now() - 1_000) }).where(eq(crawlTaglines.repo, "someone/flaky"));
    gateway.mockClear();
    gateway.mockResolvedValue(answer("바를 등록하면 손님이 찾습니다"));

    await tick();

    expect(gateway).toHaveBeenCalled();
    expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ tagline: "바를 등록하면 손님이 찾습니다", errorCode: null });
    expect(await crawl.getCandidate("someone/flaky")).toMatchObject({ state: "approved" });
  });

  it("원본을 다시 긁었지만 내용이 그대로면 또 부르지 않는다", async () => {
    await held("someone/steady");
    gateway.mockResolvedValue(answer(""));
    await tick();
    gateway.mockClear();
    // 재수집 — 같은 페이지를 다시 받아 왔다
    await crawl.putDocument({
      repo: "someone/steady", repoMeta: { description: null, language: "TypeScript" },
      productUrl: "https://my-app.test", pageStatus: 200,
      pageMeta: { title: "My App", textSample: "바를 등록하면 손님이 찾을 수 있습니다" },
    });

    await tick();

    expect(gateway).not.toHaveBeenCalled();
  });

  it("페이지가 바뀌면 다시 짓는다", async () => {
    await held("someone/changed");
    gateway.mockResolvedValue(answer(""));
    await tick();
    gateway.mockClear();
    await crawl.putDocument({
      repo: "someone/changed", repoMeta: { description: null, language: "TypeScript" },
      productUrl: "https://my-app.test", pageStatus: 200,
      pageMeta: { title: "My App", textSample: "이제 무엇을 하는 것인지 페이지가 말한다" },
    });
    gateway.mockResolvedValue(answer("이제 무엇을 하는지 알 수 있다"));

    await tick();

    expect(gateway).toHaveBeenCalledTimes(1);
    expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ tagline: "이제 무엇을 하는지 알 수 있다" });
    expect(await crawl.getCandidate("someone/changed")).toMatchObject({ state: "approved" });
  });
});

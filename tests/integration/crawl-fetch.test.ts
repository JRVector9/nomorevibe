import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const getRepo = vi.fn();
vi.mock("@/lib/crawl/github", () => ({ getRepo: (...a: unknown[]) => getRepo(...a) }));

const fetchPage = vi.fn();
vi.mock("@/lib/net/fetch", () => ({
  fetchPage: (...a: unknown[]) => fetchPage(...a),
  safeFetch: vi.fn().mockResolvedValue(null),
  readBodyCapped: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { crawlFrontier, crawlDocuments, crawlCandidates, crawlSettings, jobs } = await import(
  "@/lib/db/schema"
);
const crawl = await import("@/lib/crawl/repository");
const { saveSettings } = await import("@/lib/crawl/settings");
const { fetchCrawlDocuments } = await import("@/lib/crawl/jobs/fetch");
const { runJob } = await import("@/lib/jobs/runner");
const { ensureSchema } = await import("./setup");

const repoMeta = (over: Record<string, unknown> = {}) => ({
  stargazers_count: 3,
  fork: false,
  archived: false,
  pushed_at: new Date().toISOString(),
  owner: { type: "User" },
  homepage: "https://my-app.test",
  ...over,
});

const tick = () => runJob("crawl-fetch", fetchCrawlDocuments);

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  getRepo.mockReset();
  fetchPage.mockReset();
  await saveSettings({ enabled: true }, "테스트");
});

describe("수집 잡", () => {
  it("레포 메타와 배포 페이지를 원본으로 남긴다", async () => {
    await crawl.enqueue([{ repo: "someone/my-app", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: true, value: repoMeta() });
    fetchPage.mockResolvedValue({
      status: 200,
      finalUrl: "https://my-app.test",
      html: `<meta property="og:title" content="My App"><meta property="og:description" content="한 줄 소개">`,
    });

    const result = await tick();

    expect(result).toMatchObject({ status: "completed", done: true });
    const document = await crawl.getDocument("someone/my-app");
    expect(document).toMatchObject({ productUrl: "https://my-app.test", pageStatus: 200 });
    // 레포 메타는 가공하지 않고 그대로 둔다 — 기준이 바뀌면 이 원본으로 다시 판정한다
    expect(document?.repoMeta).toMatchObject({ stargazers_count: 3, owner: { type: "User" } });
    expect(document?.pageMeta).toMatchObject({ title: "My App", description: "한 줄 소개" });
    expect(await crawl.frontierCounts()).toEqual({ done: 1 });
  });

  it("homepage가 없으면 페이지를 찌르지 않는다", async () => {
    await crawl.enqueue([{ repo: "someone/no-deploy", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: true, value: repoMeta({ homepage: "" }) });

    await tick();

    expect(fetchPage).not.toHaveBeenCalled();
    expect(await crawl.getDocument("someone/no-deploy")).toMatchObject({
      productUrl: null,
      pageStatus: null,
    });
  });

  it("닿지 않는 배포 URL은 0으로 남긴다 — null은 '아직 확인 안 함'이다", async () => {
    await crawl.enqueue([{ repo: "someone/dead", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: true, value: repoMeta() });
    fetchPage.mockResolvedValue(null);

    await tick();

    expect(await crawl.getDocument("someone/dead")).toMatchObject({ pageStatus: 0 });
  });

  it("도메인이 바뀌는 리다이렉트는 목적지를 기준값으로 삼는다", async () => {
    // 메이커가 등록할 때와 같은 기준이어야 "이미 등록된 URL"을 알아본다
    await crawl.enqueue([{ repo: "someone/moved", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: true, value: repoMeta({ homepage: "https://my-app.vercel.app" }) });
    fetchPage.mockResolvedValue({ status: 200, finalUrl: "https://my-app.com/", html: "" });

    await tick();

    expect(await crawl.getDocument("someone/moved")).toMatchObject({ productUrl: "https://my-app.com" });
  });

  it("사라진 레포는 건너뛴다 — 다시 시도할 이유가 없다", async () => {
    await crawl.enqueue([{ repo: "someone/gone", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: false, error: { kind: "not_found" } });

    await tick();

    expect(await crawl.frontierCounts()).toEqual({ skipped: 1 });
    expect(await crawl.getDocument("someone/gone")).toBeUndefined();
  });

  it("일시적 오류는 백오프로 미룬다", async () => {
    await crawl.enqueue([{ repo: "someone/flaky", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: false, error: { kind: "http", status: 500 } });

    await tick();

    expect(await crawl.frontierCounts()).toEqual({ pending: 1 });
    // 바로 다시 꺼내지 않는다
    expect(await crawl.dequeue(10)).toEqual([]);
  });

  it("한도에 걸리면 남은 항목을 두고 물러난다", async () => {
    await crawl.enqueue([
      { repo: "a/one", signal: "commit-trailer" },
      { repo: "b/two", signal: "commit-trailer" },
    ]);
    getRepo.mockResolvedValue({ ok: false, error: { kind: "rate_limited", resetAt: new Date() } });

    const result = await tick();

    // 다음 틱이 이어받아야 하므로 사이클을 끝내지 않는다
    expect(result).toMatchObject({ status: "completed", done: false });
    expect(getRepo).toHaveBeenCalledTimes(1);
    expect(await crawl.frontierCounts()).toEqual({ fetching: 2 });
  });

  it("수집이 꺼져 있으면 큐를 건드리지 않는다", async () => {
    await saveSettings({ enabled: false }, "테스트");
    await crawl.enqueue([{ repo: "someone/my-app", signal: "commit-trailer" }]);

    await tick();

    expect(getRepo).not.toHaveBeenCalled();
    expect(await crawl.frontierCounts()).toEqual({ pending: 1 });
  });
});

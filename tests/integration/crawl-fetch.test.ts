import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

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
const { saveSettings, getSettings } = await import("@/lib/crawl/settings");
const { judge, factsFromRepoMeta, pageFactsFromDocument } = await import("@/lib/crawl/rules");
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

/** 다시 받아도 똑같은 레포 메타 — 원본이 "그대로"인 경우를 만들려면 푸시 시각까지 고정해야 한다 */
const STABLE_META = repoMeta({ pushed_at: "2026-09-01T00:00:00Z", homepage: "https://my-app.test" });

const judgeJob = () => db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-judge") });

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

  /**
   * 실측 509건 중 24건이 meta refresh 껍데기였다. 목적지는 문서(`/docs/`)이기도
   * 진짜 앱(`/zh-TW/7.1h/`)이기도 해서, 껍데기를 보고 정하면 둘 다 틀린다.
   *
   * 주소는 그대로 둔다 — 같은 호스트 안의 이동이라 기준값은 바뀌지 않고(resolveCanonical),
   * 브라우저는 어차피 새로고침을 따라간다. 바뀌어야 하는 것은 판정이 보는 내용이다.
   */
  it("meta refresh를 따라가 목적지의 내용으로 판정한다", async () => {
    await crawl.enqueue([{ repo: "someone/shell", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: true, value: repoMeta({ homepage: "https://my-app.test" }) });
    fetchPage
      .mockResolvedValueOnce({
        status: 200, finalUrl: "https://my-app.test/",
        html: `<title>Redirecting…</title><meta http-equiv="refresh" content="0; url=./docs/">`,
      })
      .mockResolvedValueOnce({
        status: 200, finalUrl: "https://my-app.test/docs/",
        html: `<title>My App Docs</title><body>Getting Started Installation API Reference</body>`,
      });

    await tick();

    const meta = (await crawl.getDocument("someone/shell"))?.pageMeta as
      { title?: string; textSample?: string } | null;
    // 껍데기의 "Redirecting…"이 아니라 목적지의 제목과 본문이 남는다
    expect(meta?.title).toBe("My App Docs");
    expect(meta?.textSample).toContain("Getting Started");
  });

  it("목적지가 열리지 않으면 껍데기 쪽을 그대로 쓴다 — 없는 주소로 바꾸면 더 나쁘다", async () => {
    await crawl.enqueue([{ repo: "someone/broken-shell", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: true, value: repoMeta({ homepage: "https://my-app.test" }) });
    fetchPage
      .mockResolvedValueOnce({
        status: 200, finalUrl: "https://my-app.test/",
        html: `<title>Shell</title><meta http-equiv="refresh" content="0; url=./gone/">`,
      })
      .mockResolvedValueOnce(null);

    await tick();

    expect(await crawl.getDocument("someone/broken-shell")).toMatchObject({ productUrl: "https://my-app.test" });
  });

  it("rejudges an automatic unpublished candidate when a refetch changes its product URL", async () => {
    await crawl.enqueue([{ repo: "someone/changed", signal: "commit-trailer" }]);
    await crawl.putDocument({ repo: "someone/changed", repoMeta: repoMeta(), productUrl: "https://old.test" });
    await crawl.recordJudgement({ repo: "someone/changed", productUrl: "https://old.test",
      state: "approved", reason: "passed", decidedBy: "auto" });
    getRepo.mockResolvedValue({ ok: true, value: repoMeta({ homepage: "https://new.test" }) });
    fetchPage.mockResolvedValue({ status: 200, finalUrl: "https://new.test", html: "" });

    await tick();

    expect(await crawl.getDocument("someone/changed")).toMatchObject({ productUrl: "https://new.test" });
    expect(await crawl.getCandidate("someone/changed")).toMatchObject({
      productUrl: "https://new.test", state: "new", reason: "source_changed", decidedBy: "auto",
    });
    expect(await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-judge") }))
      .toMatchObject({ requestedVersion: 1, processedVersion: 0 });
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
    const resetAt = new Date(Date.now() + 120_000);
    getRepo.mockResolvedValue({ ok: false, error: { kind: "rate_limited", resetAt } });

    const result = await tick();

    // 다음 틱이 이어받아야 하므로 사이클을 끝내지 않는다
    expect(result).toMatchObject({ status: "completed", done: false });
    expect(getRepo).toHaveBeenCalledTimes(1);
    expect(await crawl.frontierCounts()).toEqual({ pending: 2 });
    const waiting = await db.select().from(crawlFrontier);
    expect(waiting.map(entry => entry.nextAttemptAt)).toEqual([resetAt, resetAt]);
    expect(waiting.every(entry => entry.attempts === 0)).toBe(true);
    expect(await crawl.dequeue(10)).toEqual([]);
  });

  it("does not release a frontier claim replaced after the original batch was read", async () => {
    await crawl.enqueue([{ repo: "a/one", signal: "commit-trailer" }]);
    const claimed = await crawl.dequeue(1);
    await db.update(crawlFrontier).set({
      attempts: sql`${crawlFrontier.attempts} + 1`,
      nextAttemptAt: sql`now() + interval '20 minutes'`,
    }).where(eq(crawlFrontier.id, claimed[0].id));
    await crawl.deferFrontier(claimed, new Date(Date.now()+60_000));
    const [current] = await db.select().from(crawlFrontier);
    expect(current.state).toBe("fetching");
    expect(current.attempts).toBe(2);
  });

  /**
   * codex 재현: HTTP 200일 때 승인된 후보가 발행 전에 다시 수집돼 404가 됐다. 주소가 같다는
   * 이유로 new로 되돌리지 않으면, 발행이 규칙을 다시 태우지 않는 모드에서 죽은 페이지가 올라간다.
   */
  it("같은 URL이 404로 다시 받아지면 자동 승인을 재판정으로 되돌린다", async () => {
    await crawl.enqueue([{ repo: "someone/gone-dark", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: true, value: STABLE_META });
    fetchPage.mockResolvedValue({ status: 200, finalUrl: "https://my-app.test", html: "<title>My App</title>" });
    await tick();
    await crawl.recordJudgement({ repo: "someone/gone-dark", productUrl: "https://my-app.test",
      state: "approved", reason: "passed", decidedBy: "auto" });

    await crawl.requeue(["someone/gone-dark"]);
    fetchPage.mockResolvedValue({ status: 404, finalUrl: "https://my-app.test", html: "<title>Not Found</title>" });
    await tick();

    expect(await crawl.getDocument("someone/gone-dark")).toMatchObject({ productUrl: "https://my-app.test", pageStatus: 404 });
    expect(await crawl.getCandidate("someone/gone-dark")).toMatchObject({
      state: "new", reason: "source_changed", decidedBy: "auto", productUrl: "https://my-app.test",
    });
    expect(await judgeJob()).toMatchObject({ requestedVersion: 2 });
  });

  it("다시 받은 원본이 판정 입력 그대로면 자동 승인을 건드리지 않는다", async () => {
    await crawl.enqueue([{ repo: "someone/steady", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: true, value: STABLE_META });
    fetchPage.mockResolvedValue({ status: 200, finalUrl: "https://my-app.test", html: "<title>My App</title>" });
    await tick();
    await crawl.recordJudgement({ repo: "someone/steady", productUrl: "https://my-app.test",
      state: "approved", reason: "passed", decidedBy: "auto" });
    const approved = await crawl.getCandidate("someone/steady");

    await crawl.requeue(["someone/steady"]);
    await tick();

    expect(await crawl.getCandidate("someone/steady")).toEqual(approved);
    // 판정할 것이 새로 생기지 않았으니 판정도 다시 부르지 않는다 (첫 수집 때의 요청 하나뿐)
    expect(await judgeJob()).toMatchObject({ requestedVersion: 1 });
  });

  it("관리자 결정은 원본이 바뀌어도 그대로 둔다", async () => {
    await crawl.enqueue([{ repo: "someone/reviewed", signal: "commit-trailer" }]);
    await crawl.putDocument({ repo: "someone/reviewed", repoMeta: STABLE_META, productUrl: "https://my-app.test", pageStatus: 200 });
    await crawl.recordJudgement({ repo: "someone/reviewed", productUrl: "https://my-app.test",
      state: "approved", reason: "passed", decidedBy: "admin" });
    getRepo.mockResolvedValue({ ok: true, value: STABLE_META });
    fetchPage.mockResolvedValue({ status: 404, finalUrl: "https://my-app.test", html: "" });

    await tick();

    expect(await crawl.getCandidate("someone/reviewed")).toMatchObject({ state: "approved", decidedBy: "admin" });
  });

  it("새 원본을 저장한 묶음은 판정을 한 번만 요청한다", async () => {
    await crawl.enqueue([
      { repo: "a/one", signal: "commit-trailer" },
      { repo: "b/two", signal: "commit-trailer" },
      { repo: "c/three", signal: "commit-trailer" },
    ]);
    getRepo.mockResolvedValue({ ok: true, value: repoMeta({ homepage: "" }) });

    await tick();

    expect(await crawl.frontierCounts()).toEqual({ done: 3 });
    // 후보마다 부르면 잡 행 하나를 두고 경합한다 — 묶음이 끝날 때 한 번
    expect(await judgeJob()).toMatchObject({ requestedVersion: 1, processedVersion: 0 });
  });

  /**
   * codex 재현: A가 페이지를 받은 뒤 멈춘 사이 리스가 만료되고 B가 최신 원본을 저장했다.
   * A가 재개하면 putDocument가 옛 원본을 따로 커밋했고, 리스 검사는 그다음 함수에서야 실패했다.
   */
  it("리스를 잃은 워커는 그사이 저장된 최신 원본을 덮어쓰지 않는다", async () => {
    await crawl.enqueue([{ repo: "someone/raced", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: true, value: STABLE_META });
    fetchPage.mockImplementationOnce(async () => {
      await db.update(jobs).set({ leaseToken: "replacement", lockedAt: new Date() }).where(eq(jobs.name, "crawl-fetch"));
      await crawl.putDocument({ repo: "someone/raced", repoMeta: STABLE_META, productUrl: "https://my-app.test",
        pageStatus: 200, pageMeta: { title: "Newest" } });
      return { status: 200, finalUrl: "https://my-app.test", html: "<title>Stale</title>" };
    });

    expect(await tick()).toMatchObject({ status: "failed", error: "job_lease_lost" });
    expect((await crawl.getDocument("someone/raced"))?.pageMeta).toMatchObject({ title: "Newest" });
  });

  it("회수돼 다른 워커가 다시 꺼낸 항목은 원본도 완료 표시도 건드리지 않는다", async () => {
    await crawl.enqueue([{ repo: "someone/raced", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: true, value: STABLE_META });
    fetchPage.mockImplementationOnce(async () => {
      // 10분이 지나 항목이 회수됐고, B가 다시 꺼내(dequeue와 같은 갱신) 최신 원본을 저장했다
      await db.update(crawlFrontier).set({
        attempts: sql`${crawlFrontier.attempts} + 1`, nextAttemptAt: sql`now() + interval '10 minutes'`,
      }).where(eq(crawlFrontier.repo, "someone/raced"));
      await crawl.putDocument({ repo: "someone/raced", repoMeta: STABLE_META, productUrl: "https://my-app.test",
        pageStatus: 200, pageMeta: { title: "Newest" } });
      return { status: 200, finalUrl: "https://my-app.test", html: "<title>Stale</title>" };
    });

    expect(await tick()).toMatchObject({ status: "completed" });
    expect((await crawl.getDocument("someone/raced"))?.pageMeta).toMatchObject({ title: "Newest" });
    const [entry] = await db.select().from(crawlFrontier);
    expect(entry).toMatchObject({ state: "fetching", attempts: 2 });
  });

  /**
   * codex 재현: 200 헤더 뒤에 본문 전송이 끊기면 예외가 잡 전체로 번졌다. markFailed도 나머지
   * 묶음 반환도 없이 항목들이 fetching으로 남았다가 10분 뒤 회수되기를 반복했고, 그래서 최대
   * 시도 횟수 검사가 영영 걸리지 않았다.
   */
  it("본문 수신이 끊긴 항목만 실패로 남기고 나머지는 계속 받는다", async () => {
    await crawl.enqueue([
      { repo: "a/broken-body", signal: "commit-trailer", priority: 1 },
      { repo: "b/fine", signal: "commit-trailer" },
    ]);
    getRepo.mockImplementation(async (repo: string) => ({ ok: true, value: repoMeta({
      homepage: repo === "a/broken-body" ? "https://broken.test" : "https://fine.test",
    }) }));
    fetchPage.mockImplementation(async (url: string) => {
      if (url.startsWith("https://broken.test")) throw new TypeError("terminated");
      return { status: 200, finalUrl: url, html: "<title>Fine</title>" };
    });

    expect(await tick()).toMatchObject({ status: "completed", done: true });

    const rows = await db.select().from(crawlFrontier);
    expect(rows.find(row => row.repo === "a/broken-body")).toMatchObject({
      state: "pending", attempts: 1, lastError: expect.stringContaining("본문"),
    });
    expect(rows.find(row => row.repo === "b/fine")).toMatchObject({ state: "done" });
    expect(await crawl.getDocument("a/broken-body")).toBeUndefined();
    expect(await crawl.getDocument("b/fine")).toMatchObject({ pageStatus: 200 });
  });

  it("본문 수신 실패도 최대 시도 횟수를 넘기면 failed로 내린다", async () => {
    await crawl.enqueue([{ repo: "a/broken-body", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: true, value: repoMeta({ homepage: "https://broken.test" }) });
    fetchPage.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

    for (let attempt = 0; attempt < crawl.MAX_ATTEMPTS; attempt++) {
      // 백오프를 기다리는 대신 다음 시도 시각을 당긴다
      await db.update(crawlFrontier).set({ nextAttemptAt: sql`now() - interval '1 second'` });
      expect(await tick()).toMatchObject({ status: "completed" });
    }

    const [entry] = await db.select().from(crawlFrontier);
    expect(entry).toMatchObject({ state: "failed", attempts: crawl.MAX_ATTEMPTS });
  });

  /**
   * codex 재현: https://app.test 가 meta refresh로 /docs/ 에 넘긴다. 내용은 목적지 것을 읽지만
   * 제품 주소는 루트로 남아(같은 호스트 — resolveCanonical), 제목이 App이고 본문에 차단 문구가
   * 없으면 "/docs 경로" 규칙을 그대로 지나 승인됐다.
   */
  it("같은 호스트의 meta refresh 목적지 경로를 판정이 볼 수 있게 남긴다", async () => {
    await crawl.enqueue([{ repo: "someone/app", signal: "commit-trailer" }]);
    getRepo.mockResolvedValue({ ok: true, value: repoMeta({ homepage: "https://app.test" }) });
    fetchPage
      .mockResolvedValueOnce({ status: 200, finalUrl: "https://app.test/",
        html: `<meta http-equiv="refresh" content="0; url=/docs/">` })
      .mockResolvedValueOnce({ status: 200, finalUrl: "https://app.test/docs/",
        html: `<title>App</title><body>Welcome to App</body>` });

    await tick();

    const document = (await crawl.getDocument("someone/app"))!;
    // 제품을 가리키는 기준값은 그대로 루트다 — 바뀌는 것은 판정이 보는 주소다
    expect(document).toMatchObject({ productUrl: "https://app.test" });
    expect(document.pageMeta).toMatchObject({ title: "App", finalUrl: "https://app.test/docs/" });
    const verdict = judge(factsFromRepoMeta(document.repo, document.repoMeta), pageFactsFromDocument(document),
      await getSettings());
    expect(verdict).toMatchObject({ state: "rejected", reason: "not_a_product" });
    expect(verdict.trace.at(-1)?.rule).toBe("문서 URL 아님");
  });

  it("수집이 꺼져 있으면 큐를 건드리지 않는다", async () => {
    await saveSettings({ enabled: false }, "테스트");
    await crawl.enqueue([{ repo: "someone/my-app", signal: "commit-trailer" }]);

    await tick();

    expect(getRepo).not.toHaveBeenCalled();
    expect(await crawl.frontierCounts()).toEqual({ pending: 1 });
  });
});

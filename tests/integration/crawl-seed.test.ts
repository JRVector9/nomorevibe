import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const searchCommits = vi.fn();
vi.mock("@/lib/crawl/github", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  searchCommits: (...a: unknown[]) => searchCommits(...a),
}));

const { db } = await import("@/lib/db");
const { crawlFrontier, crawlDocuments, crawlCandidates, crawlSettings, jobs } = await import(
  "@/lib/db/schema"
);
const crawl = await import("@/lib/crawl/repository");
const { saveSettings } = await import("@/lib/crawl/settings");
const { seedFrontier } = await import("@/lib/crawl/jobs/seed");
const { runJob, getJobState } = await import("@/lib/jobs/runner");
const { ensureSchema } = await import("./setup");

/** 검색 한 페이지 응답 — 100건이 다 차면 다음 페이지가 있다는 뜻이다 */
const searchPage = (repos: string[], full = false) => ({
  ok: true,
  value: {
    items: [
      ...repos.map((full_name) => ({ repository: { full_name } })),
      // 페이지가 꽉 찼는지만 보므로 나머지는 같은 레포로 채운다 (중복은 큐에서 걸러진다)
      ...Array.from({ length: full ? 100 - repos.length : 0 }, () => ({
        repository: { full_name: repos[0] },
      })),
    ],
  },
});

const tick = () => runJob("crawl-seed", seedFrontier);

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  searchCommits.mockReset();
  await saveSettings({ enabled: true, discover: { pagesPerTick: 1 } }, "테스트");
});

describe("검색 잡", () => {
  it("검색 결과를 프론티어에 넣는다", async () => {
    searchCommits.mockResolvedValue(searchPage(["a/one", "b/two", "a/one"]));

    await tick();

    expect(await crawl.frontierCounts()).toEqual({ pending: 2 });
    const [entry] = await crawl.dequeue(1);
    // 어떤 신호로 발견했는지 남는다 — 신호별 수율을 비교하려면 필요하다
    expect(entry).toMatchObject({ signal: "Claude 커밋 트레일러", priority: 100 });
  });

  it("검색어에 신호와 기간 창을 함께 넣는다", async () => {
    searchCommits.mockResolvedValue(searchPage(["a/one"]));

    await tick();

    expect(searchCommits).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringMatching(/^Co-authored-by: Claude committer-date:>=\d{4}-\d{2}-\d{2}$/),
        page: 1,
        sort: "relevance",
      }),
    );
  });

  it("한 틱에 설정한 페이지 수만큼만 본다", async () => {
    await saveSettings({ discover: { pagesPerTick: 3 } }, "테스트");
    searchCommits.mockResolvedValue(searchPage(["a/one"], true));

    await tick();

    expect(searchCommits).toHaveBeenCalledTimes(3);
    expect(searchCommits.mock.calls.map(([arg]) => arg.page)).toEqual([1, 2, 3]);
    // 다음 틱이 이어받을 지점이 남는다
    expect((await getJobState("crawl-seed"))?.cursor).toMatchObject({ page: 4 });
  });

  it("다음 틱이 커서 지점부터 이어본다", async () => {
    searchCommits.mockResolvedValue(searchPage(["a/one"], true));

    await tick();
    await tick();

    expect(searchCommits.mock.calls.map(([arg]) => arg.page)).toEqual([1, 2]);
  });

  it("페이지가 덜 차면 다음 신호로 넘어간다", async () => {
    await saveSettings(
      {
        discover: {
          pagesPerTick: 2,
          queries: [
            { label: "첫째", query: "one", enabled: true, priority: 100 },
            { label: "둘째", query: "two", enabled: true, priority: 90 },
          ],
        },
      },
      "테스트",
    );
    searchCommits.mockResolvedValue(searchPage(["a/one"]));

    await tick();

    expect(searchCommits.mock.calls.map(([arg]) => arg.query)).toEqual([
      expect.stringContaining("one"),
      expect.stringContaining("two"),
    ]);
  });

  it("마지막 신호까지 훑으면 사이클을 끝내고 커서를 비운다", async () => {
    // 신호를 하나로 못박는다 — 기본 신호 수가 바뀌면 이 테스트의 뜻이 흔들린다
    await saveSettings(
      { discover: { queries: [{ label: "하나뿐", query: "one", enabled: true, priority: 100 }] } },
      "테스트",
    );
    searchCommits.mockResolvedValue(searchPage(["a/one"]));

    const result = await tick();

    expect(result).toMatchObject({ status: "completed", done: true });
    expect((await getJobState("crawl-seed"))?.cursor).toBeNull();
  });

  it("한도에 걸리면 같은 페이지를 커서에 남기고 물러난다", async () => {
    searchCommits.mockResolvedValue({ ok: false, error: { kind: "rate_limited", resetAt: null } });

    const result = await tick();

    expect(result).toMatchObject({ status: "completed", done: false });
    expect((await getJobState("crawl-seed"))?.cursor).toMatchObject({ page: 1 });
  });

  it("커서가 가리키던 신호가 꺼지면 처음부터 본다", async () => {
    searchCommits.mockResolvedValue(searchPage(["a/one"], true));
    await tick();
    expect((await getJobState("crawl-seed"))?.cursor).toMatchObject({
      signal: "Claude 커밋 트레일러",
      page: 2,
    });

    // 신호 이름을 바꾼다 (= 기존 커서가 가리키던 것이 사라진다)
    await saveSettings(
      { discover: { queries: [{ label: "새 신호", query: "new", enabled: true, priority: 50 }] } },
      "테스트",
    );
    searchCommits.mockClear();

    await tick();

    expect(searchCommits).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
  });

  it("수집이 꺼져 있으면 검색하지 않는다", async () => {
    await saveSettings({ enabled: false }, "테스트");

    await tick();

    expect(searchCommits).not.toHaveBeenCalled();
    expect(await crawl.frontierCounts()).toEqual({});
  });
});

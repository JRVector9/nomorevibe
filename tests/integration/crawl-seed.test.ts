import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const searchCommits = vi.fn();
const searchRepositories = vi.fn();
vi.mock("@/lib/crawl/github", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  searchCommits: (...a: unknown[]) => searchCommits(...a),
  searchRepositories: (...a: unknown[]) => searchRepositories(...a),
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
const signalOf = (arg: { query: string }) => arg.query.split(" committer-date")[0];


beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  searchCommits.mockReset();
  searchRepositories.mockReset();
  // 기본 신호 셋 중 커밋 둘만 켠다 — 레포 검색은 자기 테스트에서 따로 켠다
  await saveSettings({
    enabled: true,
    discover: {
      pagesPerTick: 1,
      queries: [
        { label: "Claude 커밋 트레일러", query: "Co-authored-by: Claude", enabled: true, priority: 100, builder: "Claude" },
        { label: "Codex 커밋 트레일러", query: "Co-authored-by: Codex", enabled: true, priority: 90, builder: "Codex" },
      ],
    },
  }, "테스트");
});

describe("레포 검색 신호", () => {
  const only = (query: string) => saveSettings({
    discover: { queries: [{ label: "토픽", kind: "repositories", query, enabled: true, priority: 80, builder: null }] },
  }, "테스트");

  it("배포 URL이 있는 레포만 프론티어에 넣는다 — 없는 것은 fetch까지 가도 거부될 뿐이다", async () => {
    await only("topic:vibe-coding");
    searchRepositories.mockResolvedValue({
      ok: true,
      value: { items: [
        { full_name: "a/deployed", homepage: "https://a.test" },
        { full_name: "b/bare", homepage: null },
        { full_name: "c/blank", homepage: "   " },
      ] },
    });

    await tick();

    const repos = (await db.select({ repo: crawlFrontier.repo }).from(crawlFrontier)).map((r) => r.repo);
    expect(repos).toEqual(["a/deployed"]);
    expect(searchCommits).not.toHaveBeenCalled();
  });

  it("URL이 아닌 homepage는 배포 URL로 치지 않는다", async () => {
    // GitHub의 homepage는 자유 입력이라 "soon"·"TBD" 같은 값이 온다. 그런 레포는 fetch까지
    // 가도 normalizeUrl이 거부할 뿐이라, 예산만 쓰고 결과가 같다
    await only("topic:vibe-coding");
    searchRepositories.mockResolvedValue({
      ok: true,
      value: { items: [
        { full_name: "a/deployed", homepage: "https://a.test" },
        { full_name: "d/bare-domain", homepage: "d.example.com" },
        { full_name: "e/soon", homepage: "soon" },
        { full_name: "f/tbd", homepage: "TBD" },
        { full_name: "g/scheme", homepage: "ftp://g.example.com" },
      ] },
    });

    await tick();

    const repos = (await db.select({ repo: crawlFrontier.repo }).from(crawlFrontier)).map((r) => r.repo);
    expect(repos.sort()).toEqual(["a/deployed", "d/bare-domain"]);
  });

  it("레포 검색에는 푸시 기간 창을 넣는다", async () => {
    await only("topic:vibe-coding");
    searchRepositories.mockResolvedValue({ ok: true, value: { items: [] } });

    await tick();

    expect(searchRepositories).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.stringMatching(/^topic:vibe-coding pushed:[^ ]+\.\.[^ ]+$/) }),
    );
  });
});

describe("검색 잡", () => {
  it("검색 결과를 프론티어에 넣는다", async () => {
    searchCommits.mockResolvedValue(searchPage(["a/one", "b/two", "a/one"]));

    await tick();

    expect(await crawl.frontierCounts()).toEqual({ pending: 2 });
    const [entry] = await crawl.dequeue(1);
    // 어떤 신호로 발견했는지 남는다 — 신호별 수율을 비교하려면 필요하다
    expect(entry).toMatchObject({ signal: "Claude 커밋 트레일러", priority: 100 });
    // 검색 힌트는 제작 AI 값으로 전달하지 않는다
    expect(entry.builder).toBeNull();
  });

  it("어떤 AI인지 말하지 않는 신호는 추정을 비운 채 넣는다", async () => {
    await saveSettings(
      { discover: { queries: [{ label: "토픽", kind: "repositories", query: "topic:vibe-coding", enabled: true, priority: 80, builder: null }] } },
      "테스트",
    );
    searchRepositories.mockResolvedValue({
      ok: true,
      value: { items: [{ full_name: "a/deployed", homepage: "https://a.test" }] },
    });

    await tick();

    const [entry] = await crawl.dequeue(1);
    expect(entry).toMatchObject({ signal: "토픽" });
    expect(entry.builder).toBeNull();
  });

  it("검색어에 신호와 기간 창을 함께 넣는다", async () => {
    searchCommits.mockResolvedValue(searchPage(["a/one"]));

    await tick();

    expect(searchCommits).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringMatching(/^Co-authored-by: Claude committer-date:[^ ]+\.\.[^ ]+$/),
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
    // 페이지마다 차례를 넘긴다 — 넓은 신호가 뒤 신호를 굶기지 않아야 한다
    expect(searchCommits.mock.calls.map(([arg]) => [signalOf(arg), arg.page])).toEqual([
      ["Co-authored-by: Claude", 1],
      ["Co-authored-by: Codex", 1],
      ["Co-authored-by: Claude", 2],
    ]);
    // 신호마다 다음에 이어받을 지점이 따로 남는다
    expect((await getJobState("crawl-seed"))?.cursor).toMatchObject({
      states: { "Claude 커밋 트레일러": { page: 3 }, "Codex 커밋 트레일러": { page: 2 } },
    });
  });

  it("다음 틱이 커서 지점부터 이어본다", async () => {
    searchCommits.mockResolvedValue(searchPage(["a/one"], true));

    await tick();
    await tick();
    await tick();

    // 두 신호를 한 바퀴 돈 뒤, 세 번째 틱은 첫 신호를 1페이지가 아니라 2페이지부터 이어본다
    expect(searchCommits.mock.calls.map(([arg]) => [signalOf(arg), arg.page])).toEqual([
      ["Co-authored-by: Claude", 1],
      ["Co-authored-by: Codex", 1],
      ["Co-authored-by: Claude", 2],
    ]);
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

  it("마지막 신호까지 훑으면 사이클을 끝내되 어디까지 덮었는지는 남긴다", async () => {
    // 신호를 하나로 못박는다 — 기본 신호 수가 바뀌면 이 테스트의 뜻이 흔들린다
    await saveSettings(
      { discover: { queries: [{ label: "하나뿐", query: "one", enabled: true, priority: 100 }] } },
      "테스트",
    );
    searchCommits.mockResolvedValue(searchPage(["a/one"]));

    const result = await tick();

    expect(result).toMatchObject({ status: "completed", done: true });
    // 커서를 비우면 다음 주기가 같은 구간을 다시 긁는다. 덮은 끝을 남기고 기다린다.
    expect((await getJobState("crawl-seed"))?.cursor).toMatchObject({
      waiting: true,
      cycleWindow: { to: expect.any(String) },
    });
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
    // 첫 신호는 2페이지를 남긴 채 다음 신호에게 차례를 넘겼다
    expect((await getJobState("crawl-seed"))?.cursor).toMatchObject({
      signal: "Codex 커밋 트레일러",
      states: { "Claude 커밋 트레일러": { page: 2 } },
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

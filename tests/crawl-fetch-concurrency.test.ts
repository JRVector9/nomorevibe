import { beforeEach, expect, it, vi } from "vitest";

/**
 * 수집 잡의 동시 처리.
 *
 * HTTP 대기가 지배적이라 셋을 함께 받는다. 다만 GitHub에는 순서대로(같은 origin 하나씩),
 * 같은 사이트에는 한 번에 하나만 보낸다. 예산이 끝나거나 리스를 잃어도 시작하지 않은
 * 항목의 claim은 반드시 돌려준다 — 안 그러면 10분 동안 fetching에 묶인다.
 */

const mocks = vi.hoisted(() => ({
  dequeue: vi.fn(), defer: vi.fn(), save: vi.fn(), mark: vi.fn(), failed: vi.fn(),
  repo: vi.fn(), page: vi.fn(), request: vi.fn(),
}));
vi.mock("@/lib/crawl/repository", () => ({
  dequeue: mocks.dequeue, deferFrontier: mocks.defer, saveFetchedDocument: mocks.save,
  markFrontier: mocks.mark, markFailed: mocks.failed,
}));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => ({ enabled: true, judge: { docsGenerators: [] } }) }));
vi.mock("@/lib/crawl/github", () => ({ getRepo: mocks.repo }));
vi.mock("@/lib/crawl/admin-review", () => ({ requeueAfterAdminEvidenceRefresh: async () => false }));
vi.mock("@/lib/net/fetch", () => ({ fetchPage: mocks.page }));
vi.mock("@/lib/jobs/control", () => ({ requestJob: mocks.request }));

const { fetchCrawlDocuments } = await import("@/lib/crawl/jobs/fetch");

const entry = (i: number) => ({ id: i, repo: `acme/app-${i}`, attempts: 1, nextAttemptAt: new Date(0) });
const context = (hasBudget: () => boolean = () => true) => ({ cursor: null, hasBudget, save: vi.fn(), log: vi.fn() });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 동시에 몇 개가 떠 있었는지 잰다 */
function gauge() {
  let current = 0;
  let max = 0;
  return {
    async around<T>(work: () => Promise<T>): Promise<T> {
      current++;
      max = Math.max(max, current);
      try { return await work(); } finally { current--; }
    },
    get max() { return max; },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockResolvedValue({ needsJudgement: true });
  mocks.page.mockImplementation(async (url: string) => ({ status: 200, finalUrl: url, html: "" }));
});

it("페이지는 최대 셋까지 함께 받고, GitHub에는 하나씩 보낸다", async () => {
  const entries = Array.from({ length: 7 }, (_, i) => entry(i));
  mocks.dequeue.mockResolvedValueOnce(entries).mockResolvedValue([]);
  const github = gauge();
  const pages = gauge();
  mocks.repo.mockImplementation((repo: string) => github.around(async () => {
    await delay(2);
    return { ok: true, value: { homepage: `https://${repo.split("/")[1]}.test` } };
  }));
  mocks.page.mockImplementation((url: string) => pages.around(async () => {
    await delay(25);
    return { status: 200, finalUrl: url, html: "" };
  }));

  expect(await fetchCrawlDocuments(context())).toEqual({ done: true });

  expect(mocks.save).toHaveBeenCalledTimes(7);
  expect(pages.max).toBe(3);
  expect(github.max).toBe(1);
  expect(mocks.defer).not.toHaveBeenCalled();
  // 새 원본이 일곱 개여도 판정 요청은 묶음당 한 번이다
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(mocks.request).toHaveBeenCalledWith("crawl-judge");
});

it("같은 origin에는 한 번에 하나만 보낸다", async () => {
  // owner.github.io 아래에 레포별 배포물이 줄지어 있는 것이 실데이터에서 흔한 모양이다
  const entries = Array.from({ length: 4 }, (_, i) => entry(i));
  mocks.dequeue.mockResolvedValueOnce(entries).mockResolvedValue([]);
  const pages = gauge();
  mocks.repo.mockImplementation(async (repo: string) => ({
    ok: true, value: { homepage: `https://owner.github.io/${repo.split("/")[1]}` },
  }));
  mocks.page.mockImplementation((url: string) => pages.around(async () => {
    await delay(10);
    return { status: 200, finalUrl: url, html: "" };
  }));

  await fetchCrawlDocuments(context());

  expect(mocks.save).toHaveBeenCalledTimes(4);
  expect(pages.max).toBe(1);
});

it("예산이 끝나면 끝낸 항목은 두고, 시작하지 않은 항목만 돌려준다", async () => {
  const entries = Array.from({ length: 5 }, (_, i) => entry(i));
  mocks.dequeue.mockResolvedValueOnce(entries).mockResolvedValue([]);
  let budget = true;
  let firstSaved!: () => void;
  const saved = new Promise<void>((resolve) => { firstSaved = resolve; });
  // 첫 항목 뒤의 GitHub 응답은 첫 저장이 끝난 뒤에 온다 — 그 사이 예산이 끝난다
  mocks.repo.mockImplementation(async (repo: string) => {
    if (repo !== "acme/app-0") await saved;
    return { ok: true, value: { homepage: null } };
  });
  mocks.save.mockImplementation(async (claim: { repo: string }) => {
    if (claim.repo === "acme/app-0") { budget = false; firstSaved(); }
    return { needsJudgement: true };
  });

  expect(await fetchCrawlDocuments(context(() => budget))).toEqual({ done: false });

  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.defer).toHaveBeenCalledTimes(1);
  expect(mocks.defer).toHaveBeenCalledWith(entries.slice(1));
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("저장이 실패하면 새 항목을 시작하지 않고, 시작하지 않은 claim을 돌려준 뒤 실패로 끝낸다", async () => {
  const entries = Array.from({ length: 5 }, (_, i) => entry(i));
  mocks.dequeue.mockResolvedValueOnce(entries).mockResolvedValue([]);
  let lost = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  mocks.repo.mockImplementation(async (repo: string) => {
    if (repo !== "acme/app-0") await released;
    return { ok: true, value: { homepage: null } };
  });
  // 러너가 리스를 잃으면 hasBudget도 false가 된다(runner.ts) — 저장 트랜잭션이 먼저 알아챈 경우다
  mocks.save.mockImplementation(async () => {
    lost = true;
    release();
    throw new Error("job_lease_lost");
  });

  await expect(fetchCrawlDocuments(context(() => !lost))).rejects.toThrow("job_lease_lost");

  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.defer).toHaveBeenCalledWith(entries.slice(1));
});

it("한 항목의 본문 수신 실패는 그 항목의 실패로 끝나고 나머지는 계속한다", async () => {
  const entries = Array.from({ length: 3 }, (_, i) => entry(i));
  mocks.dequeue.mockResolvedValueOnce(entries).mockResolvedValue([]);
  mocks.repo.mockImplementation(async (repo: string) => ({
    ok: true, value: { homepage: `https://${repo.split("/")[1]}.test` },
  }));
  mocks.page.mockImplementation(async (url: string) => {
    if (url === "https://app-1.test") throw new TypeError("terminated");
    return { status: 200, finalUrl: url, html: "" };
  });

  expect(await fetchCrawlDocuments(context())).toEqual({ done: true });

  expect(mocks.failed).toHaveBeenCalledTimes(1);
  expect(mocks.failed).toHaveBeenCalledWith("acme/app-1", expect.stringContaining("본문"), undefined, entries[1]);
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.defer).not.toHaveBeenCalled();
});

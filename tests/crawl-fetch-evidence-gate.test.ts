import { beforeEach, expect, it, vi } from "vitest";

/**
 * 수집 잡의 AI 흔적 게이트.
 *
 * 검색어가 AI 사용을 말하지 않는 신호(requireEvidence)로 온 레포는 흔적이 있어야 들여보낸다. 흔적이 없으면
 * 페이지를 열지 않고 원본만 남긴 채 거절로 적는다. 다른 신호는 더듬지 않는다.
 */

const mocks = vi.hoisted(() => ({
  dequeue: vi.fn(), defer: vi.fn(), save: vi.fn(), mark: vi.fn(), failed: vi.fn(), judge: vi.fn(),
  repo: vi.fn(), page: vi.fn(), request: vi.fn(), probe: vi.fn(), candidate: vi.fn(),
  showHn: { enabled: true, priority: 120, requireEvidence: false },
}));
vi.mock("@/lib/crawl/repository", () => ({
  dequeue: mocks.dequeue, deferFrontier: mocks.defer, saveFetchedDocument: mocks.save,
  markFrontier: mocks.mark, markFailed: mocks.failed, recordJudgement: mocks.judge, getCandidate: mocks.candidate,
  SKIP_NOT_FOUND: "github_not_found", SKIP_EMPTY_REPOSITORY: "github_empty_repository",
}));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => ({
  enabled: true, judge: { docsGenerators: [] },
  discover: { queries: [
    { label: "한국어 README", requireEvidence: true, enabled: true },
    { label: "Claude 커밋 트레일러", requireEvidence: false, enabled: true },
  ], showHn: mocks.showHn },
}) }));
vi.mock("@/lib/crawl/github", () => ({ getRepo: mocks.repo }));
vi.mock("@/lib/crawl/ai-evidence-gate", () => ({ PROBE_COMMITS: 30, probeAiEvidence: mocks.probe }));
vi.mock("@/lib/crawl/admin-review", () => ({ requeueAfterAdminEvidenceRefresh: async () => false }));
vi.mock("@/lib/net/fetch", () => ({ fetchPage: mocks.page }));
vi.mock("@/lib/jobs/control", () => ({ requestJob: mocks.request }));

const { fetchCrawlDocuments } = await import("@/lib/crawl/jobs/fetch");

const entry = (repo: string, signal: string) => ({ id: 1, repo, signal, attempts: 1, nextAttemptAt: new Date(0) });
const context = () => ({ cursor: null, hasBudget: () => true, save: vi.fn(), log: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.showHn.requireEvidence = false;
  mocks.repo.mockResolvedValue({ ok: true, value: { id: 7, homepage: "https://app.test" } });
  mocks.page.mockImplementation(async (url: string) => ({ status: 200, finalUrl: url, html: "<title>App</title>" }));
  mocks.save.mockResolvedValue({ needsJudgement: true });
  mocks.candidate.mockResolvedValue(undefined);
});

it("이미 후보가 있는 레포의 재수집에는 흔적 관문을 걸지 않는다 — 심사 중인 후보를 거절로 덮지 않는다", async () => {
  // 2026-10-05~06: 원본 재수집(승인·보류 후보)이 이 관문에 다시 걸려 1차 AI 승인 237건이 잠금·상태 확인 없이 거절로 덮였다
  mocks.candidate.mockResolvedValue({ id: 9, repo: "kim/todo", state: "approved", reason: "passed" });
  mocks.dequeue.mockResolvedValueOnce([entry("kim/todo", "한국어 README")]).mockResolvedValue([]);
  mocks.probe.mockResolvedValue({ ok: true, found: [] });

  expect(await fetchCrawlDocuments(context())).toEqual({ done: true });

  expect(mocks.probe).not.toHaveBeenCalled();
  expect(mocks.judge).not.toHaveBeenCalledWith(expect.objectContaining({ reason: "ai_evidence_not_found" }));
  // 관문 없이 평소처럼 페이지를 받아 원본을 갱신한다
  expect(mocks.page).toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ repo: "kim/todo", pageStatus: 200 }), undefined);
});

it("흔적이 없으면 페이지를 열지 않고 원본만 남긴 채 거절로 적는다", async () => {
  mocks.dequeue.mockResolvedValueOnce([entry("kim/todo", "한국어 README")]).mockResolvedValue([]);
  mocks.probe.mockResolvedValue({ ok: true, found: [] });
  const ctx = context();

  expect(await fetchCrawlDocuments(ctx)).toEqual({ done: true });

  expect(mocks.probe).toHaveBeenCalledWith("kim/todo");
  expect(mocks.page).not.toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ repo: "kim/todo", productUrl: "https://app.test", pageStatus: null, pageMeta: null }), undefined);
  expect(mocks.judge).toHaveBeenCalledWith(expect.objectContaining({
    repo: "kim/todo", state: "rejected", reason: "ai_evidence_not_found", decidedBy: "auto",
    signals: { evidenceGate: { signal: "한국어 README", recentCommits: 30, found: [] } },
  }));
  // 거절한 것은 판정할 것이 아니다
  expect(mocks.request).not.toHaveBeenCalled();
  expect(ctx.log).toHaveBeenCalledWith("crawl.fetched", expect.objectContaining({ gated: 1, fetched: 0 }));
});

it("흔적이 있으면 평소처럼 페이지를 열고, 무엇이 들여보냈는지 원본에 남긴다", async () => {
  mocks.dequeue.mockResolvedValueOnce([entry("kim/todo", "한국어 README")]).mockResolvedValue([]);
  mocks.probe.mockResolvedValue({ ok: true, found: ["file:CLAUDE.md", "trailer:claude-code"] });

  await fetchCrawlDocuments(context());

  expect(mocks.page).toHaveBeenCalled();
  expect(mocks.judge).not.toHaveBeenCalled();
  const saved = mocks.save.mock.calls[0][1];
  expect(saved.pageStatus).toBe(200);
  expect(saved.pageMeta.evidenceGate).toEqual({ signal: "한국어 README", found: ["file:CLAUDE.md", "trailer:claude-code"] });
  expect(mocks.request).toHaveBeenCalledWith("crawl-judge");
});

it("흔적을 요구하지 않는 신호는 더듬지 않는다", async () => {
  mocks.dequeue.mockResolvedValueOnce([entry("acme/app", "Claude 커밋 트레일러")]).mockResolvedValue([]);

  await fetchCrawlDocuments(context());

  expect(mocks.probe).not.toHaveBeenCalled();
  expect(mocks.page).toHaveBeenCalled();
  expect(mocks.save.mock.calls[0][1].pageMeta.evidenceGate).toBeUndefined();
});

it("더듬다 한도에 걸리면 항목을 돌려주고 틱을 접는다", async () => {
  const resetAt = new Date(Date.now() + 60_000);
  mocks.dequeue.mockResolvedValueOnce([entry("kim/todo", "한국어 README"), entry("lee/app", "한국어 README")]);
  mocks.probe.mockResolvedValue({ ok: false, error: { kind: "rate_limited", resetAt } });

  expect(await fetchCrawlDocuments(context())).toEqual({ done: false });

  // GitHub 줄은 getRepo 에서 선다 — 이미 그 줄을 지난 칸은 더듬어 볼 수 있지만, 한도 안에서는 요청이 나가지 않는다(github-quota)
  expect(mocks.probe).toHaveBeenCalled();
  expect(mocks.page).not.toHaveBeenCalled();
  expect(mocks.judge).not.toHaveBeenCalled();
  expect(mocks.defer).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ repo: "kim/todo" }), expect.objectContaining({ repo: "lee/app" })]), resetAt);
});

it("빈 레포(404)는 건너뛰고, 다른 GitHub 실패는 항목 실패로 남긴다", async () => {
  mocks.dequeue.mockResolvedValueOnce([entry("kim/empty", "한국어 README"), entry("kim/flaky", "한국어 README")]).mockResolvedValue([]);
  mocks.probe.mockResolvedValueOnce({ ok: false, error: { kind: "not_found" } })
    .mockResolvedValueOnce({ ok: false, error: { kind: "http", status: 502 } });

  await fetchCrawlDocuments(context());

  // 빈 저장소라는 까닭을 남긴다 — 사람 대기열에서 "레포 삭제됨"과 섞이지 않게
  expect(mocks.mark).toHaveBeenCalledWith("kim/empty", "skipped", expect.anything(), undefined, "github_empty_repository");
  expect(mocks.failed).toHaveBeenCalledWith("kim/flaky", "AI 흔적 확인 실패 — GitHub 502", undefined, expect.anything());
  expect(mocks.page).not.toHaveBeenCalled();
});

// Show HN 은 검색 신호가 아니라 따로 켠다(settings.discover.showHn.requireEvidence) — 게시물에는 AI 조건이 없다
it("Show HN 은 설정으로 켰을 때만 더듬는다", async () => {
  mocks.dequeue.mockResolvedValueOnce([entry("hn/app", "Show HN")]).mockResolvedValue([]);
  await fetchCrawlDocuments(context());
  expect(mocks.probe).not.toHaveBeenCalled();

  mocks.showHn.requireEvidence = true;
  mocks.dequeue.mockResolvedValueOnce([entry("hn/app", "Show HN")]).mockResolvedValue([]);
  mocks.probe.mockResolvedValue({ ok: true, found: [] });
  await fetchCrawlDocuments(context());
  expect(mocks.probe).toHaveBeenCalledWith("hn/app");
  expect(mocks.judge).toHaveBeenCalledWith(expect.objectContaining({ repo: "hn/app", reason: "ai_evidence_not_found" }));
});

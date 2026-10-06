import { beforeEach, expect, it, vi } from "vitest";

/**
 * 수집 잡의 패키지 증거 확인 — 사이트 없는 스킬·플러그인·확장을 저장소 파일로 알아본다(package-proof.ts).
 * 5~499 스타, 포크·보관 아님, 배포 주소가 없거나 자기 저장소·문서 주소일 때만 GitHub 에 묻는다.
 */

const mocks = vi.hoisted(() => ({
  dequeue: vi.fn(), defer: vi.fn(), save: vi.fn(), mark: vi.fn(), failed: vi.fn(), judge: vi.fn(),
  repo: vi.fn(), page: vi.fn(), request: vi.fn(), probe: vi.fn(),
}));
vi.mock("@/lib/crawl/repository", () => ({
  dequeue: mocks.dequeue, deferFrontier: mocks.defer, saveFetchedDocument: mocks.save,
  markFrontier: mocks.mark, markFailed: mocks.failed, recordJudgement: mocks.judge,
}));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => ({
  enabled: true, judge: { docsGenerators: [] },
  discover: { queries: [{ label: "Claude 커밋 트레일러", requireEvidence: false, enabled: true }],
    showHn: { enabled: true, priority: 120, requireEvidence: false } },
}) }));
vi.mock("@/lib/crawl/github", () => ({ getRepo: mocks.repo }));
vi.mock("@/lib/crawl/package-probe", () => ({ probePackageManifests: mocks.probe }));
vi.mock("@/lib/crawl/admin-review", () => ({ requeueAfterAdminEvidenceRefresh: async () => false }));
vi.mock("@/lib/net/fetch", () => ({ fetchPage: mocks.page }));
vi.mock("@/lib/jobs/control", () => ({ requestJob: mocks.request }));

const { fetchCrawlDocuments } = await import("@/lib/crawl/jobs/fetch");

const entry = (repo: string) => ({ id: 1, repo, signal: "Claude 커밋 트레일러", attempts: 1, nextAttemptAt: new Date(0) });
const context = () => ({ cursor: null, hasBudget: () => true, save: vi.fn(), log: vi.fn() });
const run = async (meta: Record<string, unknown>) => {
  mocks.repo.mockResolvedValue({ ok: true, value: { id: 7, default_branch: "main", ...meta } });
  mocks.dequeue.mockResolvedValueOnce([entry("maker/pdf-skill")]).mockResolvedValue([]);
  const ctx = context();
  await fetchCrawlDocuments(ctx);
  return ctx;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.page.mockImplementation(async (url: string) => ({ status: 200, finalUrl: url, html: "<title>App</title>" }));
  mocks.save.mockResolvedValue({ needsJudgement: true });
  mocks.probe.mockResolvedValue({ ok: true, truncated: false, proof: [{ kind: "skill", path: "SKILL.md" }] });
});

it("사이트 없는 5스타 이상 저장소는 패키지 파일을 찾아 원본에 붙인다", async () => {
  const ctx = await run({ stargazers_count: 12, homepage: null });
  expect(mocks.probe).toHaveBeenCalledWith("maker/pdf-skill", "main");
  expect(mocks.save.mock.calls[0][1].repoMeta).toMatchObject({ stargazers_count: 12, nmv_package_proof: [{ kind: "skill", path: "SKILL.md" }] });
  expect(ctx.log).toHaveBeenCalledWith("crawl.package_proof", { repo: "maker/pdf-skill", stars: 12, proof: ["skill"] });
});

it("자기 저장소 주소를 홈페이지로 둔 것도 묻는다", async () => {
  await run({ stargazers_count: 12, homepage: "https://github.com/maker/pdf-skill" });
  expect(mocks.probe).toHaveBeenCalled();
});

it("5스타 미만·500스타 이상·포크·보관·진짜 사이트는 묻지 않는다", async () => {
  for (const meta of [{ stargazers_count: 4 }, { stargazers_count: 500 }, { stargazers_count: 12, fork: true },
    { stargazers_count: 12, archived: true }, { stargazers_count: 12, homepage: "https://pdf-skill.app" }]) {
    await run(meta);
  }
  expect(mocks.probe).not.toHaveBeenCalled();
});

it("찾은 것이 없으면 원본을 그대로 두고, 빈 저장소(409)도 그렇게 넘긴다", async () => {
  mocks.probe.mockResolvedValueOnce({ ok: true, truncated: false, proof: [] });
  await run({ stargazers_count: 12 });
  expect(mocks.save.mock.calls[0][1].repoMeta).not.toHaveProperty("nmv_package_proof");
  mocks.probe.mockResolvedValueOnce({ ok: false, error: { kind: "http", status: 409 } });
  await run({ stargazers_count: 12 });
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.failed).not.toHaveBeenCalled();
});

it("한도에 걸리면 저장하지 않고 미루며, 다른 실패는 이 항목만 다시 시도한다", async () => {
  mocks.probe.mockResolvedValueOnce({ ok: false, error: { kind: "rate_limited", resetAt: null } });
  await run({ stargazers_count: 12 });
  expect(mocks.save).not.toHaveBeenCalled();
  mocks.probe.mockResolvedValueOnce({ ok: false, error: { kind: "transport" } });
  await run({ stargazers_count: 12 });
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.failed).toHaveBeenCalledWith("maker/pdf-skill", "패키지 확인 실패 — GitHub transport", undefined, expect.anything());
});

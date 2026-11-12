import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 사람 확인 묶음의 쓰기 순서(조각 3b) — 표본 관문을 지난 일괄 결정이 기존 건별 결정(overrideCandidate)을 건마다 부르고,
 * 심사 큐 일괄과 같은 작업 로그 줄에 묶음 id 를 남기는지. 되돌리기는 건별 undoAdminDecision 을 묶음째 부르는지.
 */
const mocks = vi.hoisted(() => ({
  override: vi.fn(), undo: vi.fn(), list: vi.fn(), overview: vi.fn(), settings: vi.fn(), repoCheck: vi.fn(), records: vi.fn(),
  insert: vi.fn(), read: vi.fn(), latest: vi.fn(), mark: vi.fn(), claimRun: vi.fn(), saveResult: vi.fn(), claimUndo: vi.fn(), saveUndo: vi.fn(),
  repoDeleted: [] as number[], admin: vi.fn(), revalidate: vi.fn(),
}));
const chain = { from: () => chain, where: () => chain, orderBy: () => Promise.resolve(mocks.repoDeleted.map(id => ({ id }))) };
vi.mock("@/lib/db", () => ({ db: { select: () => chain } }));
vi.mock("@/lib/crawl/admin-review", () => ({ overrideCandidate: mocks.override, undoAdminDecision: mocks.undo, listAdminReviewEntries: mocks.list }));
vi.mock("@/lib/crawl/review-overview", () => ({ humanQueueOverview: mocks.overview }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/crawl/delegated-repo-check", () => ({ checkDelegatedRepository: mocks.repoCheck }));
vi.mock("@/lib/operations/admin-log", () => ({ recordAdminActions: mocks.records, recordAdminAction: vi.fn() }));
vi.mock("@/lib/crawl/human-batch-store", () => ({ insertHumanBatchGate: mocks.insert, readHumanBatchGate: mocks.read, latestHumanBatchGates: mocks.latest,
  markHumanBatchVerdict: mocks.mark, claimHumanBatchRun: mocks.claimRun, saveHumanBatchResult: mocks.saveResult, claimHumanBatchUndo: mocks.claimUndo,
  saveHumanBatchUndo: mocks.saveUndo }));
// 웹 쓰기 관문(DR 펜스)은 dr-web-fence 시험이 본다 — 여기서는 감싸기만 벗긴다
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: <T>(action: T) => action }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));

const { markHumanBatchSample, runHumanBatch, startHumanBatchSample, undoHumanBatch } = await import("@/lib/crawl/human-batch-run");
const { runHumanBatchAction, startHumanBatchSampleAction } = await import("@/app/(operator)/admin/review/batches/actions");

const H = (c: string) => c.repeat(64);
const member = (id: number) => ({ id, repo: `acme/r${id}`, inputHash: H("a"), sourceRevisionHash: H("b"), candidateRevisionHash: H(String(id % 10)) });
const entry = (id: number, hashes = true) => ({ candidate: { id, repo: `acme/r${id}` }, inputHash: hashes ? H("a") : null, sourceRevisionHash: hashes ? H("b") : null,
  candidateRevisionHash: H(String(id % 10)) });
const overview = (agreed: number[]) => ({ ids: { ai: [], second: [], human: [], agreed },
  secondIds: { unanimous_approve: agreed, agreed_approve: [], unanimous_reject: [], agreed_reject: [], needs_human: [] } });
const okAll = (ids: number[]) => Object.fromEntries(ids.map(id => [String(id), "ok"]));
const gate = (over: Record<string, unknown> = {}) => ({ id: 31, batchKey: "agreed_approve", actor: "jr", members: [1, 2, 3, 4, 5, 6].map(member),
  snapshotHash: "snap", sampleIds: [1, 2, 3, 4, 5], verdicts: okAll([1, 2, 3, 4, 5]), excluded: [], executedAt: null, decision: null, result: null,
  undoneAt: null, undoneBy: null, undoResult: null, createdAt: new Date(), updatedAt: new Date(), ...over });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repoDeleted = [];
  mocks.settings.mockResolvedValue({});
  mocks.admin.mockResolvedValue({ login: "jr" });
  mocks.latest.mockResolvedValue({});
  mocks.insert.mockImplementation(async (input) => ({ id: 31, ...input }));
  mocks.claimRun.mockImplementation(async ({ id }) => gate({ id, executedAt: new Date(), decision: "approve" }));
  let attempt = 100;
  mocks.override.mockImplementation(async () => ({ ok: true, message: "기록", attemptId: ++attempt, previous: { state: "needs_review", reason: "second_review_split" } }));
});

describe("표본 뽑기", () => {
  it("지금 묶음에서 대상을 고정하고, 앞선 표본의 「아님」은 빼고, 판을 못 읽은 후보는 넣지 않는다", async () => {
    mocks.overview.mockResolvedValue(overview([1, 2, 3, 4, 5, 6, 7, 8]));
    mocks.latest.mockResolvedValue({ agreed_approve: gate({ sampleIds: [2, 3], verdicts: { 2: "wrong", 3: "ok" }, excluded: [8, 99] }) });
    mocks.list.mockResolvedValue({ entries: [1, 4, 5, 6, 7].map(id => entry(id)).concat([entry(3, false)]) });
    const result = await startHumanBatchSample("jr", "agreed_approve");
    expect(result).toMatchObject({ ok: true, gateId: 31 });
    // 「아님」 2 와 앞서 뺀 8 은 고정하지 않는다(99 는 이제 묶음에 없어 이어받지 않는다)
    expect(mocks.list).toHaveBeenCalledWith({}, { state: "needs_review", ids: [1, 3, 4, 5, 6, 7], limit: 50 });
    const inserted = mocks.insert.mock.calls[0][0];
    expect(inserted).toMatchObject({ key: "agreed_approve", actor: "jr", excluded: [2, 8] });
    expect(inserted.members.map((row: { id: number }) => row.id)).toEqual([1, 4, 5, 6, 7]);
    expect(inserted.sampleIds).toHaveLength(5);
    expect(inserted.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mocks.records).toHaveBeenCalledWith("jr", [expect.objectContaining({ action: "human-batch-sample", target: "batch:31",
      detail: expect.objectContaining({ key: "agreed_approve", members: 5, excluded: 2 }) })]);
  });

  it("후보가 없으면 줄을 만들지 않는다", async () => {
    mocks.overview.mockResolvedValue(overview([]));
    expect(await startHumanBatchSample("jr", "agreed_approve")).toEqual({ ok: false, message: "이 묶음에 지금 후보가 없습니다." });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("표본 판정은 작업 로그에 남는다", async () => {
    mocks.mark.mockResolvedValue(true);
    expect(await markHumanBatchSample("jr", 31, 3, "wrong")).toMatchObject({ ok: true });
    expect(mocks.mark).toHaveBeenCalledWith({ id: 31, actor: "jr", candidateId: 3, verdict: "wrong" });
    expect(mocks.records).toHaveBeenCalledWith("jr", [expect.objectContaining({ action: "human-batch-mark", target: "batch:31",
      detail: { candidateId: 3, verdict: "wrong" }, ok: true })]);
  });
});

describe("일괄 결정", () => {
  it("관문이 열리면 고정한 대상마다 기존 건별 결정(overrideCandidate)을 고정한 판으로 부르고, 새로 들어온 건은 빼며 작업 로그에 묶음 id 를 남긴다", async () => {
    mocks.read.mockResolvedValue(gate());
    mocks.overview.mockResolvedValue(overview([1, 2, 3, 4, 5, 6, 40]));
    const result = await runHumanBatch("jr", 31, {});
    expect(result).toMatchObject({ ok: true, message: "승인 6건" });
    expect(mocks.claimRun).toHaveBeenCalledWith({ id: 31, actor: "jr", decision: "approve" });
    expect(mocks.override).toHaveBeenCalledTimes(6);
    expect(mocks.override.mock.calls.map(([call]) => call.repo)).not.toContain("acme/r40");
    expect(mocks.override).toHaveBeenCalledWith({ repo: "acme/r1", actor: "jr", decision: "approve", reasonCode: "passed", reason: "AI·2차 일치 승인",
      inputHash: H("a"), sourceRevisionHash: H("b"), candidateRevisionHash: H("1") });
    const entries = mocks.records.mock.calls[0][1];
    expect(entries.filter((row: { action: string }) => row.action === "candidate-approve")).toHaveLength(6);
    expect(entries[0]).toEqual({ action: "candidate-approve", target: "acme/r1", detail: { reason: "", note: "AI·2차 일치 승인", bulk: 6, batchId: 31, attemptId: 101 },
      ok: true, error: null });
    expect(entries.at(-1)).toMatchObject({ action: "human-batch-run", target: "batch:31",
      detail: expect.objectContaining({ key: "agreed_approve", decided: 6, failed: 0, excludedNew: 1, excludedGone: 0, sample: { size: 5, ok: 5 } }) });
    expect(mocks.saveResult).toHaveBeenCalledWith(31, expect.objectContaining({ decision: "approve", excludedNew: 1,
      decided: [1, 2, 3, 4, 5, 6].map(id => ({ id, repo: `acme/r${id}`, attemptId: 100 + id })) }));
  });

  it("「아님」이 있거나 표본을 다 보지 않았으면 잡지도 결정하지도 않는다", async () => {
    mocks.overview.mockResolvedValue(overview([1, 2, 3, 4, 5, 6]));
    mocks.read.mockResolvedValue(gate({ verdicts: { ...okAll([1, 2, 3, 4]), 5: "wrong" } }));
    expect(await runHumanBatch("jr", 31, {})).toEqual({ ok: false, message: "「아님」인 표본이 있어 한 번에 끝낼 수 없습니다." });
    mocks.read.mockResolvedValue(gate({ verdicts: okAll([1, 2, 3, 4]) }));
    expect(await runHumanBatch("jr", 31, {})).toEqual({ ok: false, message: "표본을 모두 보지 않았습니다." });
    // 다른 운영자의 표본·이미 실행한 줄도
    mocks.read.mockResolvedValue(gate({ actor: "other" }));
    expect((await runHumanBatch("jr", 31, {})).ok).toBe(false);
    mocks.read.mockResolvedValue(gate({ executedAt: new Date() }));
    expect(await runHumanBatch("jr", 31, {})).toEqual({ ok: false, message: "이미 실행한 묶음입니다." });
    expect(mocks.claimRun).not.toHaveBeenCalled();
    expect(mocks.override).not.toHaveBeenCalled();
  });

  it("두 창에서 함께 눌러 실행을 못 잡으면 결정하지 않는다", async () => {
    mocks.read.mockResolvedValue(gate());
    mocks.overview.mockResolvedValue(overview([1, 2, 3, 4, 5, 6]));
    mocks.claimRun.mockResolvedValue(null);
    expect(await runHumanBatch("jr", 31, {})).toEqual({ ok: false, message: "이미 실행한 묶음입니다." });
    expect(mocks.override).not.toHaveBeenCalled();
  });

  it("저장소가 없어짐은 거절 사유를 받고, 실행 직전 GitHub 확인에서 정말 없는 것만 거절한다", async () => {
    const repoGate = gate({ batchKey: "repo_deleted", members: [1, 2, 3, 4].map(member), sampleIds: [1, 2, 3, 4], verdicts: okAll([1, 2, 3, 4]) });
    mocks.read.mockResolvedValue(repoGate);
    mocks.overview.mockResolvedValue(overview([]));
    mocks.repoDeleted = [1, 2, 3, 4];
    expect(await runHumanBatch("jr", 31, {})).toEqual({ ok: false, message: "거절 사유를 골라주세요." });
    mocks.repoCheck.mockImplementation(async (repo: string) => ({ check: repo === "acme/r2" ? "present" : repo === "acme/r3" ? "deferred" : "gone", retryAt: null }));
    const result = await runHumanBatch("jr", 31, { reason: "not_a_product" });
    expect(result).toMatchObject({ ok: true, message: "거절 2건 · 남김 2건" });
    expect(mocks.repoCheck).toHaveBeenCalledTimes(4);
    expect(mocks.override.mock.calls.map(([call]) => [call.repo, call.decision, call.reasonCode, call.reason])).toEqual([
      ["acme/r1", "reject", "not_a_product", "레포 삭제됨 — 제품을 확인할 수 없음"], ["acme/r4", "reject", "not_a_product", "레포 삭제됨 — 제품을 확인할 수 없음"]]);
    expect(mocks.saveResult.mock.calls[0][1].skipped).toEqual([
      { id: 2, repo: "acme/r2", why: "저장소가 살아 있음 — 거절하지 않음" }, { id: 3, repo: "acme/r3", why: "GitHub 확인을 못 함(한도·자격·연결) — 다시 시도" }]);
    const entries = mocks.records.mock.calls[0][1];
    expect(entries.filter((row: { action: string }) => row.action === "candidate-reject").map((row: { target: string }) => row.target)).toEqual(["acme/r1", "acme/r4"]);
  });

  it("건별 결정이 거절되면 실패로 남기고 나머지는 처리한다", async () => {
    mocks.read.mockResolvedValue(gate());
    mocks.overview.mockResolvedValue(overview([1, 2, 3, 4, 5, 6]));
    mocks.override.mockResolvedValueOnce({ ok: false, message: "후보 또는 근거가 변경되었습니다." });
    const result = await runHumanBatch("jr", 31, { note: "표본 다섯 건 모두 제품" });
    expect(result).toMatchObject({ ok: true, message: "승인 5건 · 실패 1건" });
    expect(mocks.override).toHaveBeenCalledWith(expect.objectContaining({ reason: "표본 다섯 건 모두 제품" }));
    expect(mocks.records.mock.calls[0][1][0]).toMatchObject({ action: "candidate-approve", target: "acme/r1", ok: false, error: "후보 또는 근거가 변경되었습니다." });
  });
});

describe("묶음째 되돌리기", () => {
  it("결정한 건마다 기존 되돌리기를 부르고, 못 한 것과 요약을 작업 로그에 남긴다", async () => {
    const decided = [{ id: 1, repo: "acme/r1", attemptId: 101 }, { id: 2, repo: "acme/r2", attemptId: 102 }];
    mocks.claimUndo.mockResolvedValue(gate({ executedAt: new Date(), decision: "approve", result: { decision: "approve", reason: "passed", note: "n",
      decided, failures: [], skipped: [], excludedNew: 0, excludedGone: 0 } }));
    mocks.undo.mockResolvedValueOnce({ ok: true, restored: { state: "needs_review", reason: null } })
      .mockResolvedValueOnce({ ok: false, message: "발행 워커가 이미 발행했습니다." });
    const result = await undoHumanBatch("jr", 31);
    expect(result.message).toBe("1건은 되돌리지 못했습니다(1건은 되돌림) — acme/r2: 발행 워커가 이미 발행했습니다.");
    expect(mocks.undo.mock.calls.map(([call]) => call)).toEqual([{ repo: "acme/r1", attemptId: 101, actor: "jr" }, { repo: "acme/r2", attemptId: 102, actor: "jr" }]);
    expect(mocks.saveUndo).toHaveBeenCalledWith(31, { restored: 1, failures: [{ id: 2, repo: "acme/r2", message: "발행 워커가 이미 발행했습니다." }] });
    expect(mocks.records).toHaveBeenCalledWith("jr", [
      { action: "candidate-undo", target: "acme/r2", detail: { attemptId: 102, batchId: 31 }, ok: false, error: "발행 워커가 이미 발행했습니다." },
      expect.objectContaining({ action: "human-batch-undo", target: "batch:31", detail: { key: "agreed_approve", restored: 1, failed: 1 } }),
    ]);
  });

  it("실행 전이거나 이미 되돌린 묶음은 건드리지 않는다", async () => {
    mocks.claimUndo.mockResolvedValue(null);
    expect((await undoHumanBatch("jr", 31)).ok).toBe(false);
    expect(mocks.undo).not.toHaveBeenCalled();
  });
});

describe("서버 동작", () => {
  it("로그인하지 않았거나 모양이 틀리면 거절하고, 처리하면 화면을 다시 그린다", async () => {
    mocks.admin.mockResolvedValueOnce(null);
    expect(await startHumanBatchSampleAction("agreed_approve")).toEqual({ error: "권한이 없습니다. 다시 로그인해주세요." });
    expect(await startHumanBatchSampleAction("everything")).toEqual({ error: "알 수 없는 묶음입니다." });
    expect(await runHumanBatchAction("31", {})).toEqual({ error: "묶음을 읽을 수 없습니다." });
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.read.mockResolvedValue(gate());
    mocks.overview.mockResolvedValue(overview([1, 2, 3, 4, 5, 6]));
    expect(await runHumanBatchAction(31, { note: "확인" })).toEqual({ message: "승인 6건" });
    expect(mocks.revalidate).toHaveBeenCalledWith("/admin/review/batches");
    expect(mocks.revalidate).toHaveBeenCalledWith("/admin/review");
  });
});

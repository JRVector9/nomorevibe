import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 심사 결정 서버 액션 — 거부 사유는 화면이 아니라 서버가 막고(ADM-11), 성공하면 알림·되돌리기가 쓸 값을 돌려준다(ADM-12).
 */
const mocks = vi.hoisted(() => ({ admin: vi.fn(), override: vi.fn(), undo: vi.fn(), record: vi.fn(), records: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/crawl/admin-review", async (original) => ({
  ...await original<typeof import("@/lib/crawl/admin-review")>(), overrideCandidate: mocks.override, undoAdminDecision: mocks.undo,
}));
vi.mock("@/lib/operations/admin-log", async (original) => ({
  ...await original<typeof import("@/lib/operations/admin-log")>(), recordAdminAction: mocks.record, recordAdminActions: mocks.records,
}));

const { decideCrawlCandidate, decideCrawlCandidates } = await import("@/app/admin/actions");
const { undoCandidateDecisions } = await import("@/app/admin/review/actions");
const { packSelection } = await import("@/app/admin/review/contract");

const HASH = { inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64), candidateRevisionHash: "c".repeat(64) };
function form(values: Record<string, string | string[]>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) for (const one of [value].flat()) data.append(key, one);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: "jr" });
  mocks.override.mockResolvedValue({ ok: true, message: "기록", attemptId: 41, previous: { state: "needs_review", reason: "ambiguous" } });
});

describe("한 건 결정", () => {
  it("사유를 고르지 않은 거부는 서버가 거절하고 아무것도 기록하지 않는다", async () => {
    expect(await decideCrawlCandidate(null, form({ decision: "reject", repo: "acme/app", reason: "", ...HASH }))).toEqual({ error: "거부 사유를 골라주세요." });
    expect(await decideCrawlCandidate(null, form({ decision: "reject", repo: "acme/app", reason: "그냥", ...HASH }))).toEqual({ error: "거부 사유를 골라주세요." });
    expect(mocks.override).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("메모를 비운 승인은 '관리자 승인'으로 남기고, 성공하면 되돌릴 기록 id 와 이전 상태를 돌려준다", async () => {
    const result = await decideCrawlCandidate(null, form({ decision: "approve", repo: "acme/app", reason: "personal_site", note: " ", ...HASH }));
    expect(mocks.override).toHaveBeenCalledWith(expect.objectContaining({ repo: "acme/app", actor: "jr", decision: "approve", reasonCode: "passed", reason: "관리자 승인" }));
    expect(result).toEqual({ ok: true, repo: "acme/app", decision: "approve", attemptId: 41, previous: { state: "needs_review", reason: "ambiguous" } });
    expect(mocks.record).toHaveBeenCalledWith("jr", expect.objectContaining({ action: "candidate-approve", ok: true, detail: expect.objectContaining({ attemptId: 41 }) }));
  });

  it("메모를 비운 거부는 고른 사유의 이름을 남기고, 적은 메모는 그대로 쓴다", async () => {
    await decideCrawlCandidate(null, form({ decision: "reject", repo: "acme/app", reason: "not_a_product", ...HASH }));
    expect(mocks.override).toHaveBeenLastCalledWith(expect.objectContaining({ reasonCode: "not_a_product", reason: "제품이 아님 (문서·글·강의·빈 화면)" }));
    await decideCrawlCandidate(null, form({ decision: "reject", repo: "acme/app", reason: "personal_site", note: "회사 소개", ...HASH }));
    expect(mocks.override).toHaveBeenLastCalledWith(expect.objectContaining({ reasonCode: "personal_site", reason: "회사 소개" }));
  });

  it("실패는 error 로 돌려주고 기록에도 실패로 남긴다", async () => {
    mocks.override.mockResolvedValue({ ok: false, message: "후보 또는 근거가 변경되었습니다." });
    expect(await decideCrawlCandidate(null, form({ decision: "approve", repo: "acme/app", ...HASH }))).toEqual({ error: "후보 또는 근거가 변경되었습니다." });
    expect(mocks.record).toHaveBeenCalledWith("jr", expect.objectContaining({ ok: false }));
  });
});

describe("일괄 결정", () => {
  const selected = [packSelection({ repo: "acme/one", ...HASH }), packSelection({ repo: "acme/two", ...HASH })];

  it("사유를 고르지 않은 일괄 거부는 서버가 거절한다", async () => {
    expect(await decideCrawlCandidates(null, form({ decision: "reject", reason: "", selected }))).toEqual({ error: "거부 사유를 골라주세요." });
    expect(mocks.override).not.toHaveBeenCalled();
  });

  it("메모 없이도 처리하고, 처리한 건을 되돌릴 수 있게 decided 로 돌려준다", async () => {
    mocks.override.mockResolvedValueOnce({ ok: true, message: "", attemptId: 7, previous: { state: "needs_review", reason: null } })
      .mockResolvedValueOnce({ ok: false, message: "이미 발행되었거나 심사 원본이 없는 후보입니다." });
    const result = await decideCrawlCandidates(null, form({ decision: "reject", reason: "large_oss", selected }));
    expect(result).toEqual({ ok: 1, decided: [{ repo: "acme/one", attemptId: 7 }],
      failures: [{ repo: "acme/two", message: "이미 발행되었거나 심사 원본이 없는 후보입니다." }] });
    expect(mocks.override).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: "large_oss", reason: "대형 오픈소스" }));
  });
});

describe("되돌리기", () => {
  it("로그인과 입력 모양을 먼저 본다", async () => {
    mocks.admin.mockResolvedValue(null);
    expect(await undoCandidateDecisions([{ repo: "acme/one", attemptId: 1 }])).toMatchObject({ error: expect.any(String) });
    mocks.admin.mockResolvedValue({ login: "jr" });
    expect(await undoCandidateDecisions([{ repo: "acme/one", attemptId: -1 }])).toMatchObject({ error: "되돌릴 결정을 읽을 수 없습니다." });
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("되돌리면 알리고, 못 되돌린 것은 사유와 함께 작업 로그에 실패로 남긴다", async () => {
    mocks.undo.mockResolvedValueOnce({ ok: true, restored: { state: "needs_review", reason: "ambiguous" } });
    expect(await undoCandidateDecisions([{ repo: "acme/one", attemptId: 3 }])).toEqual({ message: "1건을 결정 앞 상태로 되돌렸습니다." });
    expect(mocks.undo).toHaveBeenCalledWith({ repo: "acme/one", attemptId: 3, actor: "jr" });

    mocks.undo.mockResolvedValueOnce({ ok: false, message: "발행 워커가 이미 발행했습니다. 내리려면 제품 관리에서 처리해주세요." });
    expect(await undoCandidateDecisions([{ repo: "acme/two", attemptId: 4 }])).toEqual({ error: "발행 워커가 이미 발행했습니다. 내리려면 제품 관리에서 처리해주세요." });
    expect(mocks.records).toHaveBeenLastCalledWith("jr", [expect.objectContaining({ action: "candidate-undo", target: "acme/two", ok: false })]);
  });
});

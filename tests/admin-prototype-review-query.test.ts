import { beforeEach, expect, it, vi } from "vitest";
import { humanOverview } from "./fixtures/human-queue";
const fake = vi.hoisted(() => ({ list: vi.fn(), causes: vi.fn(), overview: vi.fn(), settings: vi.fn(), delegate: vi.fn() }));
vi.mock("@/lib/crawl/admin-review", async original => ({ ...await original<typeof import("@/lib/crawl/admin-review")>(), listAdminReviewEntries: fake.list, reviewQueueCauses: fake.causes }));
vi.mock("@/lib/crawl/review-overview", () => ({ humanQueueOverview: fake.overview }));
vi.mock("@/lib/crawl/delegate-groups-read", () => ({ readDelegateGroups: fake.delegate }));
vi.mock("@/lib/crawl/settings", async original => ({ ...await original<typeof import("@/lib/crawl/settings")>(), getSettings: fake.settings }));
const { prototypeReviewFilter, prototypeReviewOptions } = await import("@/app/(operator)/admin/review/PrototypeReviewQuery");
const { EXPORT_VIEWS } = await import("@/app/(operator)/admin/export/views");
beforeEach(() => { vi.clearAllMocks(); fake.list.mockResolvedValue({ entries: [], total: 0, hiddenByAge: 0 }); fake.overview.mockResolvedValue(humanOverview({ human: 2, agreed: 1 })); fake.settings.mockResolvedValue({}); fake.causes.mockResolvedValue({ counts: [], ids: new Map(), total: 0, truncated: false });
  fake.delegate.mockResolvedValue({ ids: { abstained: [1, 9], low_confidence: [2], human_only: [], legacy: [3], unreviewed: [], admin: [] } }); });
it("전체 단계와 기존 pending·held 범위를 명시적으로 구분한다", () => {
  expect(prototypeReviewOptions(prototypeReviewFilter({ tab: "all" }), null, null).state).toBe("all");
  expect(prototypeReviewOptions(prototypeReviewFilter({ state: "pending" }), null, null).state).toBe("pending");
  expect(prototypeReviewOptions(prototypeReviewFilter({ state: "needs_review" }), null, null).state).toBe("needs_review");
  expect(prototypeReviewOptions(prototypeReviewFilter({ tab: "publish" }), null, null).state).toBe("approved");
  expect(prototypeReviewOptions(prototypeReviewFilter({ tab: "rejected" }), null, null).state).toBe("rejected");
});
it("사람 확인 탭은 실제 human·agreed 원본 ID를 합치고 단계 필터는 교집합을 유지한다", () => {
  const overview = humanOverview({ human: 2, agreed: 1 });
  expect(prototypeReviewOptions(prototypeReviewFilter({ tab: "human" }), null, overview)).toMatchObject({ state: "needs_review", ids: [1, 2, 3] });
  expect(prototypeReviewOptions(prototypeReviewFilter({ tab: "human", stage: "agreed" }), null, overview).ids).toEqual([3]);
  expect(prototypeReviewOptions(prototypeReviewFilter({ tab: "all", second: "agreed_approve", ai: "approve" }), null, overview).ids).toEqual([3]);
});
it("필수 집계 실패가 빈 큐로 둔갑하지 않는다", () => {
  expect(() => prototypeReviewOptions(prototypeReviewFilter({ tab: "human" }), null, null)).toThrow("review_overview_unavailable");
});
it("CSV가 새 화면과 같은 all/human 필터를 사용하고 page 번호는 제외한다", async () => {
  await EXPORT_VIEWS.review.load(new URLSearchParams("tab=all&page=4&q=real&sort=wait"), 51);
  expect(fake.list).toHaveBeenLastCalledWith({}, expect.objectContaining({ state: "all", ids: undefined, search: "real", sort: "wait", offset: 0 }));
  await EXPORT_VIEWS.review.load(new URLSearchParams("tab=human&page=2"), 51);
  expect(fake.list).toHaveBeenLastCalledWith({}, expect.objectContaining({ state: "needs_review", ids: [1, 2, 3], offset: 0 }));
});
it("이전 CSV 직접 주소의 pending 기본값과 rejected 필터를 보존한다", async () => {
  await EXPORT_VIEWS.review.load(new URLSearchParams(), 10);
  expect(fake.list).toHaveBeenLastCalledWith({}, expect.objectContaining({ state: "pending" }));
  await EXPORT_VIEWS.review.load(new URLSearchParams("state=rejected"), 10);
  expect(fake.list).toHaveBeenLastCalledWith({}, expect.objectContaining({ state: "rejected" }));
});
it("CSV가 AI 위임 결과 갈래(?delegate=)로 같은 목록을 내보내고 위임 의견 칸을 채운다", async () => {
  await EXPORT_VIEWS.review.load(new URLSearchParams("tab=human"), 51);
  expect(fake.delegate).not.toHaveBeenCalled();
  fake.list.mockResolvedValue({ total: 1, hiddenByAge: 0, entries: [{ candidate: { id: 1, repo: "o/r", state: "needs_review", reason: "second_review_split", productUrl: null,
    judgedAt: null, updatedAt: new Date("2026-11-10T00:00:00Z") }, name: "r", bucket: null, review: null, seconds: [],
    delegate: { model: { decision: "approve", confidence: 0.8, holdCause: "low_confidence" }, applied: "needs_review", confidence: 0.8,
      reason: "unclear install", reasonKo: null, modelName: "m", at: "2026-11-10T00:00:00.000Z", current: true } }] });
  const rows = await EXPORT_VIEWS.review.load(new URLSearchParams("tab=human&delegate=abstained"), 51);
  expect(fake.delegate).toHaveBeenCalledTimes(1);
  expect(fake.list).toHaveBeenLastCalledWith({}, expect.objectContaining({ state: "needs_review", ids: [1] }));
  expect(rows[0]).toMatchObject({ delegateDecision: "approve", delegateConfidence: 0.8, delegateHoldCause: "low_confidence", delegateReason: "unclear install" });
});

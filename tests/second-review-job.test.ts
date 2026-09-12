import { beforeEach, expect, it, vi } from "vitest";
import { secondReviewCandidates } from "@/lib/crawl/jobs/second-review";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";

const mocks = vi.hoisted(() => ({
  settings: null as CrawlSettings | null, enqueue: vi.fn(), close: vi.fn(), retry: vi.fn(), pending: vi.fn(), record: vi.fn(),
  candidate: vi.fn(), document: vi.fn(), input: vi.fn(), review: vi.fn(), gateway: vi.fn(),
}));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => mocks.settings }));
vi.mock("@/lib/db", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.candidate }) }) }) } }));
vi.mock("@/lib/crawl/jobs/review-document", () => ({ loadReviewDocument: mocks.document }));
vi.mock("@/lib/crawl/agent-review-repository", () => ({ loadReviewInput: mocks.input }));
vi.mock("@/lib/crawl/agent-review", () => ({ reviewWithAgent: mocks.review, REVIEW_CLI_TIMEOUT_MS: 20_000 }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ reviewWithGateway: mocks.gateway, REVIEW_GATEWAY_TIMEOUT_MS: 30_000 }));
vi.mock("@/lib/crawl/second-review", async (importOriginal) => ({
  // 판단을 합치는 규칙은 진짜를 쓴다 — 잡이 그것을 제대로 부르는지가 이 테스트의 요점이다
  combineVerdicts: (await importOriginal<typeof import("@/lib/crawl/second-review")>()).combineVerdicts,
  enqueueSecondReviews: mocks.enqueue, closeSettledSecondReviews: mocks.close, retryFailedSecondReviews: mocks.retry,
  pendingSecondReviews: mocks.pending, recordSecondReview: mocks.record,
}));

const context = () => ({ cursor: null, hasBudget: () => true, save: vi.fn(), log: vi.fn(), lease: { name: "second-review", token: "t", requestedVersion: 1 } });
const row = (over: Record<string, unknown> = {}) => ({ id: 7, candidateId: 1, repo: "acme/demo", publishedSlug: null, firstDecision: "reject", firstConfidence: 0.9, provider: "claude-cli", model: "opus", ...over });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true };
  mocks.enqueue.mockResolvedValue(1);
  mocks.close.mockResolvedValue(0);
  mocks.pending.mockResolvedValue([row()]);
  mocks.candidate.mockResolvedValue([{ id: 1, repo: "acme/demo" }]);
  mocks.document.mockResolvedValue({ repo: "acme/demo" });
  mocks.input.mockResolvedValue({ snapshot: {} });
  mocks.review.mockResolvedValue({ ok: true, outcome: { decision: "reject", reason: "문서 사이트", evidenceIds: ["product"], confidence: 0.95 } });
  mocks.gateway.mockResolvedValue({ ok: true, outcome: { decision: "reject", reason: "문서 사이트", evidenceIds: ["product"], confidence: 0.95 } });
});

it("꺼져 있으면 아무것도 올리지도 부르지도 않는다", async () => {
  mocks.settings!.secondReview = { ...mocks.settings!.secondReview, enabled: false };
  expect(await secondReviewCandidates(context())).toEqual({ done: true });
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.review).not.toHaveBeenCalled();
});

it("1차와 다른 모델로 보고, 두 판단이 같고 확신이 높으면 일치로 적는다", async () => {
  await secondReviewCandidates(context());
  expect(mocks.review).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "opus" }));
  expect(mocks.record).toHaveBeenCalledWith(7, expect.objectContaining({ ok: true, decision: "reject", confidence: 0.95, status: "agreed", model: "opus" }));
});

it("엇갈리면 사람에게 넘긴다", async () => {
  mocks.review.mockResolvedValue({ ok: true, outcome: { decision: "approve", reason: "쓸 수 있는 앱", evidenceIds: ["product"], confidence: 0.9 } });
  await secondReviewCandidates(context());
  expect(mocks.record).toHaveBeenCalledWith(7, expect.objectContaining({ status: "needs_human" }));
});

it("공개된 제품을 2차가 제품이 아니라고 보면 사람에게 — 내리지는 않는다", async () => {
  mocks.pending.mockResolvedValue([row({ publishedSlug: "demo", firstDecision: "approve", firstConfidence: null })]);
  await secondReviewCandidates(context());
  expect(mocks.record).toHaveBeenCalledWith(7, expect.objectContaining({ status: "needs_human" }));
});

it("호출이 실패하면 판단을 지어내지 않고 실패로 적는다", async () => {
  mocks.review.mockResolvedValue({ ok: false, error: "rate_limited" });
  await secondReviewCandidates(context());
  expect(mocks.record).toHaveBeenCalledWith(7, { ok: false, error: "rate_limited", model: "opus", provider: "claude-cli" });
});

it("원본이 없으면 모델을 부르지 않는다", async () => {
  mocks.document.mockResolvedValue(undefined);
  await secondReviewCandidates(context());
  expect(mocks.review).not.toHaveBeenCalled();
  expect(mocks.record).toHaveBeenCalledWith(7, { ok: false, error: "missing_source", model: "opus", provider: "claude-cli" });
});

it("한 틱에 일감을 넉넉히 집어 끝나는 대로 이어 본다", async () => {
  mocks.pending.mockResolvedValue([row({ id: 7 }), row({ id: 8 }), row({ id: 9 })]);
  await secondReviewCandidates(context());

  expect(mocks.pending).toHaveBeenCalledWith(24);
  expect(mocks.record).toHaveBeenCalledTimes(3);
});

it("남은 시간에 끝낼 수 없는 호출은 시작하지 않는다 — 잘린 호출은 한 시간을 버린다", async () => {
  mocks.settings!.secondReview = { ...mocks.settings!.secondReview, voters: [{ provider: "abcllm", model: "[MLX] gemma4-26b" }] };
  mocks.pending.mockResolvedValue([row({ provider: "abcllm", model: "[MLX] gemma4-26b" })]);
  // 예산이 이미 다 된 틱
  const spent = { ...context(), hasBudget: () => false };
  await secondReviewCandidates(spent);

  expect(mocks.gateway).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
});

it("사내 게이트웨이로 설정하면 CLI 대신 그쪽으로 묻고, 누가 봤는지 함께 적는다", async () => {
  mocks.settings!.secondReview = { ...mocks.settings!.secondReview, voters: [{ provider: "abcllm", model: "[MLX] gemma4-26b" }] };
  mocks.pending.mockResolvedValue([row({ provider: "abcllm", model: "[MLX] gemma4-26b" })]);
  await secondReviewCandidates(context());

  expect(mocks.review).not.toHaveBeenCalled();
  // 게이트웨이는 꼬리가 길어 CLI(20초)보다 넉넉히 준다
  expect(mocks.gateway).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "[MLX] gemma4-26b", timeoutMs: expect.any(Number) }));
  expect(mocks.gateway.mock.calls[0][1].timeoutMs).toBeGreaterThan(20_000);
  expect(mocks.record).toHaveBeenCalledWith(7, expect.objectContaining({ provider: "abcllm", model: "[MLX] gemma4-26b", status: "agreed" }));
});

it("게이트웨이에 모델이 없으면 판단을 지어내지 않고 그 까닭으로 적는다", async () => {
  mocks.settings!.secondReview = { ...mocks.settings!.secondReview, voters: [{ provider: "abcllm", model: "[MLX] 사라진모델" }] };
  mocks.pending.mockResolvedValue([row({ provider: "abcllm", model: "[MLX] 사라진모델" })]);
  mocks.gateway.mockResolvedValue({ ok: false, error: "model_unavailable" });
  await secondReviewCandidates(context());

  expect(mocks.record).toHaveBeenCalledWith(7, { ok: false, error: "model_unavailable", model: "[MLX] 사라진모델", provider: "abcllm" });
});

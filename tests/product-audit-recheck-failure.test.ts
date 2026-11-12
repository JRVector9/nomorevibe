import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { auditPublishedProducts, recheckErrorFields } from "@/lib/crawl/jobs/product-audit";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { RECHECK_ITEM_SKIP_MS, RECHECK_RANK_FAILURE_PAUSE_MS, recheckItemRankRefused, recheckRankFailed, recheckRankPaused, recheckTurn,
  resetRecheckLanes } from "@/lib/crawl/published-recheck-lanes";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { JobLeaseLostError } from "@/lib/jobs/lease";

/**
 * 공개분 변경 재판정 갈래(감사 잡 askRecheckStream)의 호출 오류. 2026-11-09~11 운영에서 OpenCode 1순위의 dispatch 가 매번 장부 guard(23514)에 거절됐는데,
 * 그 오류가 갈래 밖으로 던져져 published_recheck.failed {"error":"error"} 로만 남았고, 다음 틱도 줄 맨 앞의 같은 항목·같은 순위에서 똑같이 멈췄다.
 * 이 시험은 DB 없이 그 갈래만 본다 — 실제 장부 길은 tests/integration/opencode-task-cli-ledger.test.ts 가 본다.
 */
const mocks = vi.hoisted(() => ({ settings: vi.fn(), pending: vi.fn(), input: vi.fn(), record: vi.fn(), path: vi.fn(), remote: vi.fn(), agent: vi.fn(),
  plan: vi.fn(), refusal: vi.fn() }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/crawl/product-audit-hold", () => ({ sweepAuditHolds: async () => 0 }));
vi.mock("@/lib/llm/ai-task-models-snapshot", () => ({ ensureAiTaskModels: async () => undefined }));
vi.mock("@/lib/crawl/published-recheck", () => ({ rollingStream: async () => ({ id: 9 }), recheckYields: async () => false,
  recheckLimits: () => ({ scanBatch: 200, dailyCap: 100, askBatch: 3, minSimilarity: 0.6, yieldHours: 6 }), recheckReviewerPlan: mocks.plan,
  recheckReviewerRefusal: mocks.refusal }));
// 사람이 연 감사는 없다 — 이 시험은 재판정 갈래만 본다
vi.mock("@/lib/crawl/product-audit", () => ({ runningAuditCampaign: async () => null, pendingAuditItems: mocks.pending, loadAuditInput: mocks.input,
  recordAuditResult: mocks.record, markAuditNoSource: vi.fn(), markAuditInputFailed: vi.fn(), finishAuditCampaign: vi.fn() }));
vi.mock("@/lib/llm/cli-model-capacity", () => ({ backgroundCliPath: mocks.path }));
vi.mock("@/lib/crawl/product-audit-model-capacity", () => ({ reviewAuditWithRemoteCliModelCapacity: mocks.remote, auditCliModelCapacity: vi.fn() }));
vi.mock("@/lib/crawl/agent-review", () => ({ reviewWithAgent: mocks.agent, reviewCliTimeoutMs: () => 20_000 }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ reviewWithGateway: vi.fn(), reviewGatewayTimeoutMs: () => 60_000 }));
vi.mock("@/lib/llm/capacity-repository", () => ({
  readModelCapacityCallerControl: async () => ({ mode: "disabled", epoch: 1, revision: 1, policyHash: null, policy: null }),
}));

const OPENCODE = { rank: 1, provider: "opencode-cli", model: "opencode-go/deepseek-v4.1-flash", connectionId: "0a0b0c0d-0000-4000-8000-000000000001",
  connectionLabel: "M3 OpenCode" } as const;
const CLAUDE = { rank: 2, provider: "claude-cli", model: "sonnet", connectionId: "0a0b0c0d-0000-4000-8000-000000000002", connectionLabel: "Claude CLI" } as const;
const verdict = { ok: true, outcome: { decision: "approve", reason: "Usable app", confidence: 0.9, evidenceIds: ["product"] } };
const SECRET = "secret-binding-value";
/** 운영에서 본 꼴 — drizzle 이 감싼 드라이버 오류. message 에는 SQL·params, detail 에는 행 값이 있다(로그에 실리면 안 된다) */
function guardRejection() {
  const driver = Object.assign(new Error('new row for relation "model_capacity_requests" violates check constraint "model_capacity_requests_dispatch_check"'), {
    name: "PostgresError", code: "23514", constraint_name: "model_capacity_requests_dispatch_check", table_name: "model_capacity_requests",
    schema_name: "public", detail: `Failing row contains (${SECRET})` });
  return new DrizzleQueryError(`update "model_capacity_requests" set "dispatch_binding" = $1`, [SECRET], driver);
}
const context = (over: Partial<JobContext<null>> = {}): JobContext<null> => ({ cursor: null, save: vi.fn(), hasBudget: () => true,
  deadlineAt: Date.now() + 70_000, log: vi.fn(), lease: { name: "product-audit", token: "owned", requestedVersion: 1 }, ...over });
const logged = (ctx: JobContext<null>, event: string) => vi.mocked(ctx.log).mock.calls.filter(([name]) => name === event).map(([, fields]) => fields);

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now: new Date("2026-11-11T07:00:00Z") });
  resetRecheckLanes();
  mocks.settings.mockResolvedValue({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewConcurrency: 1 });
  mocks.plan.mockReturnValue({ status: "ok", reviewers: [OPENCODE, CLAUDE], skipped: [] });
  mocks.refusal.mockReturnValue(null);
  mocks.pending.mockResolvedValue([{ id: 1, slug: "first" }, { id: 2, slug: "second" }]);
  mocks.input.mockResolvedValue({ snapshot: {}, inputHash: "h", source: {} });
  mocks.path.mockImplementation(async (_route: string, _model: string, provider?: string) => provider === "opencode-cli" ? "remote" : "legacy");
  mocks.remote.mockRejectedValue(guardRejection());
  mocks.agent.mockResolvedValue(verdict);
  mocks.record.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); resetRecheckLanes(); });

it("summarises a wrapped driver error by class, SQLSTATE, constraint and table only — never its SQL, params or row detail", () => {
  const fields = recheckErrorFields(guardRejection());
  expect(fields).toEqual({ error: "error", errorClass: "DrizzleQueryError", pgCode: "23514", constraint: "model_capacity_requests_dispatch_check",
    table: "model_capacity_requests" });
  expect(JSON.stringify(fields)).not.toMatch(/secret|Failed query|Failing row/);
  // 정리 실패로 감싼 AggregateError 안의 드라이버 오류도 찾는다. 코드 message 와 미룸은 예전과 같은 error 값이다
  expect(recheckErrorFields(new AggregateError([guardRejection(), new Error("cleanup")], "cli_model_reservation_cleanup_failed")))
    .toEqual({ error: "cli_model_reservation_cleanup_failed", errorClass: "AggregateError", pgCode: "23514",
      constraint: "model_capacity_requests_dispatch_check", table: "model_capacity_requests" });
  expect(recheckErrorFields(new Error("cli_task_identity_mismatch"))).toEqual({ error: "cli_task_identity_mismatch", errorClass: "Error" });
  expect(recheckErrorFields(new ModelCapacityDeferredError("capacity"))).toMatchObject({ error: "deferred:capacity", errorClass: "ModelCapacityDeferredError" });
  expect(recheckErrorFields("plain")).toEqual({ error: "error" });
});

it("a thrown dispatch failure on rank 1 is logged with its SQLSTATE and constraint, and the same tick asks every item with rank 2", async () => {
  const ctx = context();
  await auditPublishedProducts(ctx);
  // 1순위(OpenCode)는 첫 항목에서 한 번만 부르고, 이 틱의 나머지는 2순위(Claude)가 묻는다 — 갈래가 멈추지 않는다
  expect(mocks.remote).toHaveBeenCalledTimes(1);
  expect(mocks.remote.mock.calls[0][0]).toMatchObject({ item: { id: 1 } });
  expect(mocks.agent).toHaveBeenCalledTimes(2);
  expect(mocks.record.mock.calls.map(([call]) => [call.itemId, call.provider, call.ok])).toEqual([[1, "claude-cli", true], [2, "claude-cli", true]]);
  expect(logged(ctx, "published_recheck.call_failed")).toEqual([{ stream: 9, itemId: 1, rank: 1, provider: "opencode-cli", model: OPENCODE.model,
    error: "error", errorClass: "DrizzleQueryError", pgCode: "23514", constraint: "model_capacity_requests_dispatch_check", table: "model_capacity_requests" }]);
  expect(logged(ctx, "published_recheck.failed")).toEqual([]);
  expect(logged(ctx, "published_recheck.asked")[0]).toMatchObject({ asked: 2, callFailed: 1, deferred: ["1:failed:23514"] });
  expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toContain(SECRET);
  // 1순위는 두 줄 모두 잠시 쉬고(답을 받은 2순위는 아니다), 그 항목에서는 1순위를 한동안 건너뛴다
  expect(recheckRankFailed(OPENCODE)).toBe(true);
  expect(recheckRankFailed(CLAUDE)).toBe(false);
  expect(recheckItemRankRefused(1, OPENCODE)).toBe(true);
  expect(recheckItemRankRefused(2, OPENCODE)).toBe(false);
  expect(recheckTurn([OPENCODE, CLAUDE], "api", new Set())).toBe(CLAUDE);
  // 미룸의 쉼(다른 줄만 보는 기록)과 섞이지 않는다
  expect(recheckRankPaused(OPENCODE)).toBe(false);
});

it("with only the failing rank, the stream is not pinned on its first item: the rank rests for a while, then the next item is asked", async () => {
  mocks.plan.mockReturnValue({ status: "ok", reviewers: [OPENCODE], skipped: [] });
  // 첫 항목만의 탓인 오류 — 두 번째 항목은 같은 순위로 답을 받는다
  mocks.remote.mockImplementation(async (request: { item: { id: number } }) => {
    if (request.item.id === 1) throw guardRejection();
    return { kind: "result", result: verdict };
  });
  const first = context();
  await auditPublishedProducts(first);
  expect(mocks.remote.mock.calls.map(([request]) => request.item.id)).toEqual([1]);
  expect(mocks.record).not.toHaveBeenCalled();
  expect(logged(first, "published_recheck.asked")[0]).toMatchObject({ asked: 0, callFailed: 1 });

  // 다음 틱(60초 뒤) — 순위가 쉬는 중이라 부르지 않는다(예전에는 같은 항목·같은 순위에서 매 틱 같은 오류였다)
  vi.setSystemTime(Date.now() + 60_000);
  await auditPublishedProducts(context());
  expect(mocks.remote).toHaveBeenCalledTimes(1);

  // 쉼이 끝나면 첫 항목은 그 순위를 건너뛰고 다음 항목을 묻는다 — 첫 항목은 시도로 세지 않았다(기록 없음)
  vi.setSystemTime(Date.now() + RECHECK_RANK_FAILURE_PAUSE_MS);
  const third = context();
  await auditPublishedProducts(third);
  expect(mocks.remote.mock.calls.map(([request]) => request.item.id)).toEqual([1, 2]);
  expect(mocks.record.mock.calls.map(([call]) => [call.itemId, call.provider, call.ok])).toEqual([[2, "opencode-cli", true]]);
  expect(recheckRankFailed(OPENCODE)).toBe(false);
  expect(recheckItemRankRefused(1, OPENCODE)).toBe(true);
  expect(logged(third, "published_recheck.asked")[0]).toMatchObject({ asked: 1, callFailed: 0 });

  // 항목의 건너뜀이 끝나면 첫 항목도 다시 그 순위로 묻는다
  vi.setSystemTime(Date.now() + RECHECK_ITEM_SKIP_MS);
  mocks.pending.mockResolvedValue([{ id: 1, slug: "first" }]);
  mocks.remote.mockResolvedValue({ kind: "result", result: verdict });
  await auditPublishedProducts(context());
  expect(mocks.remote.mock.calls.map(([request]) => request.item.id)).toEqual([1, 2, 1]);
});

it("a rank whose connection stopped accepting product-audit after the plan is paused before dispatch with its reason (2026-11-12 F4)", async () => {
  mocks.refusal.mockImplementation((reviewer: { rank: number }) => reviewer.rank === 1 ? "connection_task_not_allowed" : null);
  const ctx = context();
  await auditPublishedProducts(ctx);
  // 1순위는 부르지 않는다(장부·호스트에 닿기 전) — 같은 틱의 항목은 2순위가 묻는다
  expect(mocks.remote).not.toHaveBeenCalled();
  expect(mocks.record.mock.calls.map(([call]) => [call.itemId, call.provider, call.ok])).toEqual([[1, "claude-cli", true], [2, "claude-cli", true]]);
  expect(logged(ctx, "published_recheck.asked")[0]).toMatchObject({ asked: 2, callFailed: 0, deferred: ["1:connection_task_not_allowed"] });
  expect(recheckRankPaused(OPENCODE)).toBe(true);
});

it("a lost job lease from the call still ends the whole tick", async () => {
  mocks.remote.mockRejectedValue(new JobLeaseLostError());
  await expect(auditPublishedProducts(context())).rejects.toThrow("job_lease_lost");
  expect(mocks.agent).not.toHaveBeenCalled();
  expect(recheckRankFailed(OPENCODE)).toBe(false);
});

it("a stream failure outside the call is logged with its SQLSTATE and constraint and leaves the job running", async () => {
  mocks.pending.mockRejectedValue(guardRejection());
  const ctx = context();
  expect(await auditPublishedProducts(ctx)).toEqual({ done: true });
  expect(logged(ctx, "published_recheck.failed")).toEqual([{ error: "error", errorClass: "DrizzleQueryError", pgCode: "23514",
    constraint: "model_capacity_requests_dispatch_check", table: "model_capacity_requests" }]);
  expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toContain(SECRET);
});

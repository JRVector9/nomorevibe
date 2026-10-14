import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { auditPublishedProducts } from "@/lib/crawl/jobs/product-audit";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";

const mocks = vi.hoisted(() => ({ campaign: vi.fn(), settings: vi.fn(), candidates: vi.fn(), pending: vi.fn(),
  input: vi.fn(), record: vi.fn(), noSource: vi.fn(), finish: vi.fn(), gateway: vi.fn(), agent: vi.fn() }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/crawl/agent-review-repository", () => ({ listReviewCandidates: mocks.candidates }));
vi.mock("@/lib/crawl/agent-review", () => ({ reviewWithAgent: mocks.agent, REVIEW_CLI_TIMEOUT_MS: 20_000 }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ reviewWithGateway: mocks.gateway, REVIEW_GATEWAY_TIMEOUT_MS: 60_000 }));
vi.mock("@/lib/crawl/product-audit", () => ({ runningAuditCampaign: mocks.campaign, pendingAuditItems: mocks.pending,
  loadAuditInput: mocks.input, recordAuditResult: mocks.record, markAuditNoSource: mocks.noSource, finishAuditCampaign: mocks.finish }));

const verdict = { ok: true, outcome: { decision: "approve", reason: "Usable app", confidence: 0.9, evidenceIds: ["product"] } };
const context = (over: Partial<JobContext<null>> = {}): JobContext<null> => ({ cursor: null, save: vi.fn(),
  hasBudget: () => true, deadlineAt: Date.now() + 70_000, log: vi.fn(),
  lease: { name: "product-audit", token: "owned", requestedVersion: 1 }, ...over });

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.campaign.mockResolvedValue({ id: 4, provider: "abcllm", model: "[MLX] gpt-oss-120b",
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION });
  mocks.settings.mockResolvedValue({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewConcurrency: 1 });
  mocks.candidates.mockResolvedValue([]);
  mocks.pending.mockResolvedValue([{ id: 7, slug: "app" }]);
  mocks.input.mockResolvedValue({ snapshot: {}, inputHash: "h", source: {} });
  mocks.gateway.mockResolvedValue(verdict);
});
afterEach(() => vi.useRealTimers());

it("stores a normal thirty-second gateway response instead of exhausting an audit attempt at twenty-four seconds", async () => {
  mocks.gateway.mockImplementation(async (_input, options) => {
    const responds = options.timeoutMs >= 30_000;
    await new Promise(resolve => setTimeout(resolve, Math.min(30_000, options.timeoutMs)));
    return responds ? verdict : { ok: false, error: "timeout" };
  });
  const ctx = context();
  const running = auditPublishedProducts(ctx);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await running).toEqual({ done: false });
  expect(mocks.gateway).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timeoutMs: 60_000 }));
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ itemId: 7, ok: true, outcome: verdict.outcome }), ctx.lease);
});

it("does not start a call when the runner cannot leave the full provider timeout and storage margin", async () => {
  await auditPublishedProducts(context({ deadlineAt: Date.now() + 30_000 }));
  expect(mocks.gateway).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
});

it("rechecks admission after loading the input consumes the available call margin", async () => {
  mocks.input.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 10_000));
    return { snapshot: {}, inputHash: "h", source: {} };
  });
  const running = auditPublishedProducts(context());
  await vi.advanceTimersByTimeAsync(10_000);
  await running;
  expect(mocks.gateway).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
});

it("leaves the remaining queue for a later request rather than shortening the next sixty-second call", async () => {
  mocks.pending.mockResolvedValue([{ id: 7, slug: "app" }, { id: 8, slug: "next" }]);
  mocks.gateway.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 10_000));
    return verdict;
  });
  const running = auditPublishedProducts(context());
  await vi.advanceTimersByTimeAsync(60_000);
  await running;
  expect(mocks.gateway).toHaveBeenCalledTimes(1);
  expect(mocks.record).toHaveBeenCalledTimes(1);
});

it("discards a late success after shutdown even when the adapter returns success", async () => {
  const shutdown = new AbortController();
  mocks.gateway.mockImplementation(async () => {
    shutdown.abort();
    return verdict;
  });
  await auditPublishedProducts(context({ signal: shutdown.signal }));
  expect(mocks.record).not.toHaveBeenCalled();
});

it("aborts an active call after budget or ownership loss and does not count it as a model failure", async () => {
  let owned = true;
  let signal: AbortSignal | undefined;
  mocks.gateway.mockImplementation(async (_input, options) => {
    signal = options.signal;
    await new Promise(resolve => setTimeout(resolve, 1_000));
    return verdict;
  });
  const running = auditPublishedProducts(context({ hasBudget: () => owned }));
  await vi.advanceTimersByTimeAsync(500);
  owned = false;
  await vi.advanceTimersByTimeAsync(500);
  await running;
  expect(signal?.aborted).toBe(true);
  expect(mocks.record).not.toHaveBeenCalled();
});

it("still yields to an unreviewed new candidate before spending audit capacity", async () => {
  mocks.candidates.mockResolvedValue([{ id: 99 }]);
  expect(await auditPublishedProducts(context())).toEqual({ done: true });
  expect(mocks.pending).not.toHaveBeenCalled();
  expect(mocks.gateway).not.toHaveBeenCalled();
});

it("keeps a shorter CLI provider within its own timeout instead of demanding gateway time", async () => {
  mocks.campaign.mockResolvedValue({ id: 4, provider: "claude-cli", model: "fixture",
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION });
  mocks.agent.mockResolvedValue(verdict);
  await auditPublishedProducts(context({ deadlineAt: Date.now() + 25_000 }));
  expect(mocks.agent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timeoutMs: 20_000 }));
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), expect.anything());
});

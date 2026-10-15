import { beforeEach, expect, it, vi } from "vitest";
import type { CrawlCandidate, CrawlDocument, SecondReview } from "@/lib/db/schema";
import { createReviewInput, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { fullReviewPolicyHash } from "@/lib/operations/pipeline-capacity";
import { withReviewFixtureTransport, type ReviewFixtureLedger } from "@/lib/crawl/review-fixture-transport";
import type { ReplayRun } from "@/lib/operations/pipeline-replay-ledger";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { secondReviewCandidates } from "@/lib/crawl/jobs/second-review";

const mocks = vi.hoisted(() => ({ settings: null as CrawlSettings | null, input: null as ReviewInput | null,
  candidate: null as CrawlCandidate | null, document: null as CrawlDocument | null, row: null as SecondReview | null,
  recordFirst: vi.fn(), recordSecond: vi.fn(), external: vi.fn(), claim: vi.fn(), admitSecond: vi.fn() }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => mocks.settings }));
vi.mock("@/lib/crawl/jobs/review-document", () => ({ loadReviewDocument: async () => mocks.document }));
vi.mock("@/lib/domain/products/repository", () => ({ findRepositoryProduct: async () => null }));
vi.mock("@/lib/crawl/repository", () => ({ holdSuspectedSpam: vi.fn() }));
vi.mock("@/lib/crawl/agent-review-repository", () => ({ requeueStaleReviewSources: async () => 0,
  canStartLegacyAgentReview: async () => true,
  handOffExhaustedFirstReviews: async () => 0, listReviewCandidates: async () => [mocks.candidate],
  loadReviewInput: async () => mocks.input, claimAgentReview: mocks.claim, recordAgentReview: mocks.recordFirst }));
vi.mock("@/lib/crawl/second-review-ownership", () => ({ canStartLegacySecondReview: async () => true, admitLegacySecondReview: mocks.admitSecond }));
vi.mock("@/lib/crawl/second-review", () => ({ enqueueSecondReviews: async () => 0, closeSettledSecondReviews: async () => 0,
  reopenOrphanedGateHolds: async () => 0, retryFailedSecondReviews: async () => 0, pendingSecondReviews: async () => [mocks.row],
  combineVerdicts: () => "agreed", recordSecondReview: mocks.recordSecond }));
vi.mock("@/lib/crawl/agent-review", () => ({ firstReviewer: (settings: CrawlSettings) => settings.firstReview,
  REVIEW_CLI_TIMEOUT_MS: 20_000, reviewWithAgent: mocks.external }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ REVIEW_GATEWAY_TIMEOUT_MS: 60_000, reviewWithGateway: mocks.external }));
vi.mock("@/lib/crawl/agent-review-grok", () => ({ GROK_REVIEW_TIMEOUT_MS: 90_000, reviewWithGrokCli: mocks.external }));
const context = (name: string) => ({ cursor: null, hasBudget: () => true, log: vi.fn(), save: vi.fn(),
  lease: { name, token: "fixture-job-token", requestedVersion: 1 } });

beforeEach(() => {
  vi.resetAllMocks();
  const now = new Date();
  mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "observe",
    agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enforceEligibility: false } };
  mocks.candidate = { id: 1, repo: "acme/demo", productUrl: "https://demo.example", state: "approved", decidedBy: "auto", judgedAt: now } as CrawlCandidate;
  mocks.document = { id: 1, repo: "acme/demo", productUrl: "https://demo.example", fetchedAt: now, pageStatus: 200,
    repoMeta: { description: "Task tracker", homepage: "https://demo.example", pushed_at: now.toISOString(), stargazers_count: 0, owner: { type: "User" } },
    pageMeta: { title: "Demo" } } as CrawlDocument;
  mocks.input = createReviewInput(mocks.candidate, mocks.document, mocks.settings, { scan: null, observations: [] }, now);
  mocks.row = { id: 23, candidateId: 1, repo: "acme/demo", firstAttemptId: 11, firstDecision: "approve", firstConfidence: 0.99,
    firstModel: "first-model", generationKey: "d".repeat(64), fallbackForId: 19, provider: "abcllm", model: "second-model" } as SecondReview;
  mocks.claim.mockResolvedValue({ kind: "claimed", attempt: { id: 11, attemptNumber: 1 },
    receipt: { attemptId: 11, origin: "fresh", ownership: { kind: "legacy", stageEpoch: 1, job: context("crawl-agent-review").lease } } });
  mocks.recordFirst.mockResolvedValue({ applied: false, state: "succeeded" });
  mocks.admitSecond.mockImplementation(async () => ({ kind: "admitted", row: mocks.row, input: mocks.input,
    receipt: Object.freeze({ admittedVoteId: mocks.row!.id }) }));
  mocks.external.mockRejectedValue(new Error("raw_model_adapter_reached"));
});
function harness() {
  const events: string[] = [];
  const ledger = { fixtureMode: vi.fn(async () => {}), reserve: vi.fn(async () => {}), markDispatching: vi.fn(async () => {}),
    markInFlight: vi.fn(async () => {}), cancelBeforeDispatch: vi.fn(async () => {}), markIndeterminate: vi.fn(async () => {}),
    settle: vi.fn(async () => { events.push("settled"); }) } as unknown as ReviewFixtureLedger;
  const fixture = vi.fn(async () => ({ result: { ok: true as const, outcome: { decision: "approve" as const,
    reason: "The captured homepage describes the project.", evidenceIds: ["product"], confidence: 0.99 }, usage: {} },
    receipt: { inputTokens: 8, outputTokens: 2 } }));
  return { ledger, fixture, events, run: { runId: "fixture-run" } as ReplayRun, tokenUpperBound: 100,
    inputs: [{ candidateId: 1, input: mocks.input! }], fullReviewPolicyHash: fullReviewPolicyHash(mocks.settings!) };
}

it.each(["abcllm", "claude-cli", "grok-cli"] as const)("routes AI1 %s through fixture and the existing result writer", async provider => {
  mocks.settings!.firstReview = { provider, model: "first-model" };
  const h = harness();
  mocks.recordFirst.mockImplementation(async () => { h.events.push("writer"); return { state: "succeeded", applied: false }; });
  await withReviewFixtureTransport(h, () => reviewCrawlCandidates(context("crawl-agent-review")));
  expect(mocks.external).not.toHaveBeenCalled();
  expect(h.fixture).toHaveBeenCalledTimes(1);
  expect(h.ledger.reserve).toHaveBeenCalledWith(h.run, expect.objectContaining({ stage: "first", candidateId: 1, firstAttemptId: 11, provider, model: "first-model" }));
  expect(mocks.recordFirst).toHaveBeenCalledWith(expect.objectContaining({
    receipt: { attemptId: 11, origin: "fresh", ownership: { kind: "legacy", stageEpoch: 1, job: context("crawl-agent-review").lease } },
    outcome: expect.objectContaining({ decision: "approve" }),
  }));
  expect(mocks.recordFirst.mock.calls[0][0]).not.toHaveProperty("attempt");
  expect(h.events).toEqual(["settled", "writer"]);
});

it.each(["crawl-agent-review", "second-review"] as const)("rejects changed settings after %s runner preclaim validation", async name => {
  const h = harness();
  mocks.settings = { ...mocks.settings!, reviewMode: "off" };
  await expect(withReviewFixtureTransport(h, () => name === "crawl-agent-review"
    ? reviewCrawlCandidates(context(name)) : secondReviewCandidates(context(name)))).rejects.toThrow("replay_fixture_settings_mismatch");
  expect(h.fixture).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
  expect(mocks.recordFirst).not.toHaveBeenCalled();
  expect(mocks.recordSecond).not.toHaveBeenCalled();
});

it.each(["abcllm", "claude-cli", "grok-cli"] as const)("routes AI2 %s through fixture with actual row and root slot", async provider => {
  mocks.row!.provider = provider;
  const h = harness();
  mocks.recordSecond.mockImplementation(async () => { h.events.push("writer"); return { state: "recorded" }; });
  await withReviewFixtureTransport(h, () => secondReviewCandidates(context("second-review")));
  expect(mocks.external).not.toHaveBeenCalled();
  expect(h.fixture).toHaveBeenCalledTimes(1);
  expect(h.ledger.reserve).toHaveBeenCalledWith(h.run, expect.objectContaining({ stage: "second", candidateId: 1, firstAttemptId: 11,
    secondReviewId: 23, generationKey: "d".repeat(64), vote: 19, provider, model: "second-model" }));
  expect(mocks.recordSecond).toHaveBeenCalledWith({ receipt: expect.anything(), result: expect.objectContaining({ ok: true, decision: "approve", model: "second-model", provider }) });
  const admitted = await mocks.admitSecond.mock.results[0].value;
  expect(mocks.recordSecond.mock.calls[0][0].receipt).toBe(admitted.receipt);
  expect(h.events).toEqual(["settled", "writer"]);
});

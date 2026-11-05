import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishCandidates } from "@/lib/crawl/jobs/publish";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import type { JobContext } from "@/lib/jobs/runner";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const boundary = vi.hoisted(() => ({
  candidates: vi.fn(), prepare: vi.fn(), authority: vi.fn(), path: vi.fn(),
  agent: vi.fn(), classify: vi.fn(), publish: vi.fn(), hold: vi.fn(),
  recordDrain: vi.fn(),
  recordFailure: vi.fn(), profile: vi.fn(), request: vi.fn(),
}));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => ({ enabled: true, classify: { definitions: {} } }) }));
vi.mock("@/lib/crawl/repository", () => ({ listCandidates: boundary.candidates }));
vi.mock("@/lib/crawl/publish", () => ({ prepareCandidateClassification: boundary.prepare, publishCandidate: boundary.publish }));
vi.mock("@/lib/crawl/publication-classify-capacity", () => ({ publicationClassificationAuthority: boundary.authority, publicationClassificationPath: boundary.path }));
vi.mock("@/lib/operations/agent-client", () => ({ agentRequest: boundary.agent }));
vi.mock("@/lib/crawl/classify", () => ({ classifyCategories: boundary.classify }));
vi.mock('@/lib/operations/publisher-drain-progress', () => ({ recordPublisherClassificationDraining: boundary.recordDrain }));
vi.mock("@/lib/crawl/publication-guard", () => ({ recordPublicationFailure: boundary.recordFailure }));
vi.mock("@/lib/crawl/rules", () => ({ requiresProfileCategory: boundary.profile }));
vi.mock("@/lib/jobs/control", () => ({ requestJob: boundary.request }));
vi.mock("@/lib/operations/categories", () => ({
  classificationReadyPredicate: () => undefined, decisionFor: async () => null, holdClassification: boundary.hold,
}));
vi.mock("@/lib/crawl/agent-review-repository", () => ({
  requeueInvalidStarApprovals: async () => 0, reviewApprovalPredicate: () => undefined, starAutoApprovalPredicate: () => undefined,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CONNECT_AGENT_URL", "http://agent.test");
  boundary.candidates.mockResolvedValue([{ id: 42, repo: "owner/tool" }]);
  boundary.prepare.mockResolvedValue({ input: { repo: "owner/tool" }, snapshot: { document: {}, starAutoApproved: false } });
  boundary.recordDrain.mockResolvedValue(undefined);
});

describe("publication snapshot conflict progress", () => {
  const dialect = new PgDialect();
  function queue(size: number) {
    const pending = new Map(Array.from({ length: size }, (_, index) => {
      const id = index + 1;
      return [id, { id, repo: `owner/tool-${id}`, signals: { conflicted: id === 1 } }] as const;
    }));
    boundary.prepare.mockResolvedValue(null); // No model request or classification is needed.
    boundary.candidates.mockImplementation(async (_states: unknown, limit: number, predicate?: SQL) => {
      const excluded = predicate ? dialect.sqlToQuery(predicate).params : [];
      return [...pending.values()].filter(row => !excluded.includes(row.id)).slice(0, limit);
    });
    let checks = 0;
    const ctx: JobContext<null> = { cursor: null, save: vi.fn(), log: vi.fn(), hasBudget: () => ++checks < 100 };
    return { pending, ctx };
  }

  it.each([
    ["publication_state_changed", "publication_state_changed"],
    ["review_approval_changed", "review_approval_changed"],
    ["profile", "profile_failure_cas"],
    ["stale_judgement", "rejudge_failure_cas"],
    ["no_description", "publication_failure_cas"],
  ])("continues past %s without changing or counting the conflicting candidate", async (reason, branch) => {
    const { pending, ctx } = queue(12); // More than BATCH: the front conflict must be excluded before the next LIMIT.
    boundary.profile.mockImplementation(signals => reason === "profile" && signals?.conflicted === true);
    boundary.recordFailure.mockResolvedValue(false);
    boundary.publish.mockImplementation(async candidate => {
      if (candidate.id === 1) return { ok: false, reason };
      pending.delete(candidate.id);
      return { ok: true };
    });
    expect(await publishCandidates(ctx)).toEqual({ done: false });
    expect([...pending.keys()]).toEqual([1]); // The protected source/human decision was never overwritten.
    expect(boundary.prepare).toHaveBeenCalledTimes(12); // No reclassification of the excluded candidate.
    expect(boundary.publish.mock.calls.filter(([row]) => row.id === 1)).toHaveLength(reason === "profile" ? 0 : 1);
    expect(boundary.recordFailure).toHaveBeenCalledTimes(["profile", "stale_judgement", "no_description"].includes(reason) ? 1 : 0);
    const retryPredicate = boundary.candidates.mock.calls[1][2] as SQL;
    const query = dialect.sqlToQuery(retryPredicate);
    expect(query.sql).toContain('"crawl_candidates"."id" not in');
    expect(query.params).toEqual([1]);
    expect(ctx.log).toHaveBeenCalledWith("crawl.publication_changed", { repo: "owner/tool-1", branch, conflicts: 1 });
    expect(ctx.log).toHaveBeenCalledWith("crawl.publish_done", { published: 11, skipped: 0, conflicts: 1, drained: false });
    expect(boundary.agent).not.toHaveBeenCalled();
    expect(boundary.classify).not.toHaveBeenCalled();
  });

  it("does not mark a conflict-only queue drained or count it as progress", async () => {
    const { ctx } = queue(1);
    boundary.publish.mockResolvedValue({ ok: false, reason: "publication_state_changed" });
    expect(await publishCandidates(ctx)).toEqual({ done: false });
    expect(boundary.candidates).toHaveBeenCalledTimes(2);
    expect(boundary.prepare).toHaveBeenCalledTimes(1);
    expect(ctx.log).toHaveBeenCalledWith("crawl.publish_done", { published: 0, skipped: 0, conflicts: 1, drained: false });
  });

  it("preserves unexpected publication errors instead of treating them as conflicts", async () => {
    const { ctx } = queue(2);
    boundary.publish.mockRejectedValue(new Error("lease_or_db_failure"));
    await expect(publishCandidates(ctx)).rejects.toThrow("lease_or_db_failure");
    expect(boundary.candidates).toHaveBeenCalledTimes(1);
    expect(ctx.log).not.toHaveBeenCalledWith("crawl.publication_changed", expect.anything());
  });
});
afterEach(() => vi.unstubAllEnvs());

function context(): JobContext<null> {
  return { cursor: null, save: vi.fn(), hasBudget: vi.fn().mockReturnValueOnce(true).mockReturnValue(false), log: vi.fn() };
}
function expectNoFallbackOrPublication() {
  expect(boundary.classify).not.toHaveBeenCalled();
  expect(boundary.publish).not.toHaveBeenCalled();
  expect(boundary.hold).not.toHaveBeenCalled();
}

describe("publication classification deferral", () => {
  it.each(['draining', 'capacity', 'provider_contract_unavailable', 'dispatched'] as const)(
    'records only the typed draining refusal (%s)', async reason => {
      boundary.authority.mockRejectedValue(new ModelCapacityDeferredError(reason));
      const ctx = context();
      expect(await publishCandidates(ctx)).toEqual({ done: false, deferred: 'model_capacity' });
      expect(boundary.recordDrain).toHaveBeenCalledTimes(reason === 'draining' ? 1 : 0);
      expectNoFallbackOrPublication();
    });

  it('keeps drain observation failure advisory and observes a typed no-agent drain', async () => {
    boundary.recordDrain.mockRejectedValue(new Error('observation_unavailable'));
    boundary.authority.mockRejectedValue(new ModelCapacityDeferredError('draining'));
    expect(await publishCandidates(context())).toEqual({ done: false, deferred: 'model_capacity' });
    vi.stubEnv('CONNECT_AGENT_URL', '');
    boundary.path.mockRejectedValue(new ModelCapacityDeferredError('draining'));
    await expect(publishCandidates(context())).rejects.toMatchObject({ reason: 'draining' });
    expect(boundary.recordDrain).toHaveBeenCalledTimes(2);
    expectNoFallbackOrPublication();
  });
  it("returns a typed defer when capacity admission refuses the classification", async () => {
    boundary.authority.mockRejectedValue(new ModelCapacityDeferredError("capacity"));
    const ctx = context();
    expect(await publishCandidates(ctx)).toEqual({ done: false, deferred: "model_capacity" });
    expect(ctx.log).toHaveBeenCalledWith("crawl.classification_deferred", { count: 1, reason: "capacity" });
    expect(boundary.agent).not.toHaveBeenCalled();
    expectNoFallbackOrPublication();
  });

  it("preserves an admitted native request when its RPC response is lost", async () => {
    const authority = { requestId: "native-request" };
    boundary.authority.mockResolvedValue(authority);
    boundary.agent.mockRejectedValue(new Error("RPC response lost"));
    const ctx = context();
    expect(await publishCandidates(ctx)).toEqual({ done: false, deferred: "model_capacity" });
    expect(boundary.agent).toHaveBeenCalledExactlyOnceWith("classify", {
      inputs: [{ repo: "owner/tool" }], definitions: {}, authority,
    });
    expect(ctx.log).toHaveBeenCalledWith("crawl.classification_deferred", { count: 1, reason: "dispatched" });
    expectNoFallbackOrPublication();
  });

  it("defers a native route without an agent instead of acknowledging work or using a legacy model", async () => {
    vi.stubEnv("CONNECT_AGENT_URL", "");
    boundary.path.mockResolvedValue("native");
    const ctx = context();
    expect(await publishCandidates(ctx)).toEqual({ done: false, deferred: "model_capacity" });
    expect(ctx.log).toHaveBeenCalledWith("crawl.classification_deferred", { count: 1, reason: "provider_contract_unavailable" });
    expect(boundary.authority).not.toHaveBeenCalled();
    expect(boundary.agent).not.toHaveBeenCalled();
    expectNoFallbackOrPublication();
  });

  it("still completes an empty publication queue", async () => {
    boundary.candidates.mockResolvedValue([]);
    expect(await publishCandidates(context())).toEqual({ done: true });
    expect(boundary.authority).not.toHaveBeenCalled();
    expectNoFallbackOrPublication();
  });
});

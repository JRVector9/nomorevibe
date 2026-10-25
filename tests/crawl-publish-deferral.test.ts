import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishCandidates } from "@/lib/crawl/jobs/publish";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import type { JobContext } from "@/lib/jobs/runner";

const boundary = vi.hoisted(() => ({
  candidates: vi.fn(), prepare: vi.fn(), authority: vi.fn(), path: vi.fn(),
  agent: vi.fn(), classify: vi.fn(), publish: vi.fn(), hold: vi.fn(),
}));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => ({ enabled: true, classify: { definitions: {} } }) }));
vi.mock("@/lib/crawl/repository", () => ({ listCandidates: boundary.candidates }));
vi.mock("@/lib/crawl/publish", () => ({ prepareCandidateClassification: boundary.prepare, publishCandidate: boundary.publish }));
vi.mock("@/lib/crawl/publication-classify-capacity", () => ({ publicationClassificationAuthority: boundary.authority, publicationClassificationPath: boundary.path }));
vi.mock("@/lib/operations/agent-client", () => ({ agentRequest: boundary.agent }));
vi.mock("@/lib/crawl/classify", () => ({ classifyCategories: boundary.classify }));
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

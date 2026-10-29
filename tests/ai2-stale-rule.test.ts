import { describe, expect, it } from "vitest";
import { classifyAi2Vote, type Ai2StaleContext } from "@/lib/crawl/second-review-stale";

/** 오래된 AI2 대기 판별 규칙 — 해시·버전·상태 비교만으로 정하고, 경과 시간은 닫는 까닭이 아니다 */
const now = new Date("2026-10-29T12:00:00Z");
const row = {
  status: "pending" as const, trigger: "ai_approved" as const, publishedSlug: null, firstAttemptId: 7,
  inputHash: "in-1", generationKey: "gen-1", firstDecision: "approve", firstConfidence: 0.9, firstModel: "sonnet",
};
const first = { id: 7, inputHash: "in-1", sourceRevisionHash: "src-1", policyHash: "pol-1", promptVersion: "p1", rulesVersion: "r1",
  model: "sonnet", outcome: { decision: "approve" as const, reason: "ok", evidenceIds: ["product"], confidence: 0.9 } };
function context(patch: Partial<Ai2StaleContext> = {}): Ai2StaleContext {
  return {
    candidate: { id: 1, repo: "o/r", state: "approved", decidedBy: "auto", reason: "passed", publishedSlug: null, productUrl: "https://r.test" },
    documentUrl: "https://r.test",
    input: { inputHash: "in-1", sourceRevisionHash: "src-1", policyHash: "pol-1", validUntil: new Date(+now + 3_600_000) },
    first, latestFirstId: 7, expectedGenerationKey: "gen-1", reviewerConfigured: true, loaderAccepts: false,
    promptVersion: "p1", rulesVersion: "r1", now, ...patch,
  };
}

describe("classifyAi2Vote", () => {
  it("treats loader-accepted and finished votes as untouched", () => {
    expect(classifyAi2Vote(row, context({ loaderAccepts: true }))).toEqual({ kind: "current" });
    for (const status of ["agreed", "needs_human", "resolved"] as const)
      expect(classifyAi2Vote({ ...row, status }, context())).toEqual({ kind: "inactive" });
  });

  it("flags the 138985 shape: gate vote whose auto candidate fell back to a non-split hold", () => {
    const verdict = classifyAi2Vote(row, context({ candidate: { ...context().candidate!, state: "needs_review", reason: "ambiguous" } }));
    expect(verdict).toEqual({ kind: "stale", reasons: ["candidate_state_changed"] });
  });

  it("protects human holds and human decisions instead of closing them", () => {
    const base = context().candidate!;
    expect(classifyAi2Vote(row, context({ candidate: { ...base, state: "needs_review", reason: "second_review_split" } })))
      .toEqual({ kind: "protected", reason: "human_hold" });
    expect(classifyAi2Vote(row, context({ candidate: { ...base, decidedBy: "admin" } })))
      .toEqual({ kind: "protected", reason: "not_automatic" });
  });

  it("names each changed input by hash and version comparison", () => {
    const verdict = (patch: Partial<Ai2StaleContext>) => classifyAi2Vote(row, context(patch));
    expect(verdict({ input: { ...context().input!, inputHash: "in-2" }, expectedGenerationKey: "gen-2" }))
      .toEqual({ kind: "stale", reasons: ["input_hash_changed", "generation_changed"] });
    expect(verdict({ input: { ...context().input!, sourceRevisionHash: "src-2" } }))
      .toEqual({ kind: "stale", reasons: ["source_revision_changed"] });
    expect(verdict({ input: { ...context().input!, policyHash: "pol-2" } })).toEqual({ kind: "stale", reasons: ["policy_changed"] });
    expect(verdict({ promptVersion: "p2", rulesVersion: "r2" }))
      .toEqual({ kind: "stale", reasons: ["prompt_version_changed", "rules_version_changed"] });
    expect(verdict({ latestFirstId: 8 })).toEqual({ kind: "stale", reasons: ["first_attempt_replaced"] });
    expect(verdict({ first: { ...first, outcome: { ...first.outcome, decision: "reject" } } }))
      .toEqual({ kind: "stale", reasons: ["first_outcome_changed"] });
    expect(verdict({ first: null })).toEqual({ kind: "stale", reasons: ["first_attempt_missing"] });
    expect(verdict({ reviewerConfigured: false })).toEqual({ kind: "stale", reasons: ["reviewer_removed"] });
    expect(verdict({ documentUrl: "https://moved.test" })).toEqual({ kind: "stale", reasons: ["source_url_changed"] });
    expect(verdict({ candidate: null })).toEqual({ kind: "stale", reasons: ["candidate_missing"] });
    expect(verdict({ input: null, expectedGenerationKey: null })).toEqual({ kind: "stale", reasons: ["input_unavailable"] });
  });

  it("never closes a vote only because time passed — expiry with identical hashes asks for a refresh", () => {
    const expired = context({ input: { ...context().input!, validUntil: new Date(+now - 1) } });
    expect(classifyAi2Vote(row, expired)).toEqual({ kind: "refresh_only", reason: "evidence_expired" });
    // 한 해가 지나도 비교가 같으면 같은 답이다 — 만든 시각은 규칙에 들어가지 않는다
    expect(classifyAi2Vote(row, { ...expired, now: new Date(+now + 365 * 86_400_000) }))
      .toEqual({ kind: "refresh_only", reason: "evidence_expired" });
  });

  it("checks published samples by publication identity, not by first-review hashes", () => {
    const published = { ...row, trigger: "risk" as const, publishedSlug: "app", firstAttemptId: null, inputHash: "published:app" };
    const candidate = { ...context().candidate!, state: "published" as const, publishedSlug: "app" };
    expect(classifyAi2Vote(published, context({ candidate, first: null, latestFirstId: null })))
      .toEqual({ kind: "stale", reasons: ["binding_invalid"] });
    expect(classifyAi2Vote(published, context({ candidate: { ...candidate, state: "rejected", publishedSlug: null }, first: null })))
      .toEqual({ kind: "stale", reasons: ["publication_changed"] });
  });
});

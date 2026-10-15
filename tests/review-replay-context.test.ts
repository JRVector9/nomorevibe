import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { AgentRepositoryScan, CrawlCandidate, CrawlDocument, CrawlReviewAttempt, SecondReview } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { accessFromDocument } from "@/lib/crawl/rules";
import { loadReviewDocument } from "@/lib/crawl/jobs/review-document";
import { secondReviewGeneration, secondReviewInputMatches } from "@/lib/crawl/second-review-input";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { reviewSemanticNow, reviewSemanticNowSql, storedReviewEvidenceRequired, withReviewReplayContext } from "@/lib/crawl/review-replay-context";

const boundary = vi.hoisted(() => ({ document: vi.fn(), save: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/crawl/repository", () => ({ getDocument: boundary.document, setReadmeSample: boundary.save }));
vi.mock("@/lib/crawl/readme", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/readme")>(), fetchReadmeSample: boundary.fetch,
}));

const referenceTime = new Date("2001-11-01T00:00:00.000Z");
const settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce" as const,
  firstReview: { provider: "abcllm" as const, model: "first" },
  secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters: [{ provider: "abcllm" as const, model: "second" }] } };
const candidate = { id: 1, repo: "clock/app", productUrl: "https://clock.example", state: "approved", decidedBy: "auto",
  judgedAt: referenceTime, updatedAt: referenceTime } as CrawlCandidate;
function document(): CrawlDocument {
  return { id: 1, repo: candidate.repo, productUrl: candidate.productUrl, fetchedAt: new Date(referenceTime.getTime() - 1_000),
    pageStatus: 200, repoMeta: { description: "A useful application", pushed_at: referenceTime.toISOString() },
    pageMeta: { title: "Clock", description: "A useful application", repositoryKeys: [candidate.repo],
      readmeSample: "A useful application", readmeSampleVersion: README_SAMPLE_VERSION } } as CrawlDocument;
}
beforeEach(() => {
  vi.clearAllMocks();
  boundary.fetch.mockRejectedValue(new Error("unexpected_readme_fetch"));
});

it("freezes only semantic time and returns independent Date objects", async () => {
  const wallBefore = Date.now(), supplied = new Date(referenceTime);
  await withReviewReplayContext({ referenceTime: supplied }, async () => {
    supplied.setTime(0);
    const exposed = reviewSemanticNow(); exposed.setTime(0);
    await Promise.resolve();
    expect(reviewSemanticNow(new Date())).toEqual(referenceTime);
    expect(storedReviewEvidenceRequired()).toBe(true);
    expect(Date.now()).toBeGreaterThanOrEqual(wallBefore);
  });
  expect(storedReviewEvidenceRequired()).toBe(false);
  expect(reviewSemanticNow().getTime()).toBeGreaterThanOrEqual(wallBefore);
  expect(reviewSemanticNow(new Date(100))).toEqual(new Date(100));
});

it("isolates concurrent reference scopes and restores the outer scope after errors", async () => {
  const other = new Date(referenceTime.getTime() + 86_400_000);
  expect(await Promise.all([referenceTime, other].map(at => withReviewReplayContext({ referenceTime: at }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    return reviewSemanticNow().getTime();
  })))).toEqual([referenceTime.getTime(), other.getTime()]);
  await withReviewReplayContext({ referenceTime }, async () => {
    await expect(withReviewReplayContext({ referenceTime: other }, async () => undefined)).rejects.toThrow("replay_clock_scope_conflict");
    await expect(withReviewReplayContext({ referenceTime }, async () => { throw new Error("fixture_failure"); })).rejects.toThrow("fixture_failure");
    expect(reviewSemanticNow()).toEqual(referenceTime);
  });
  expect(storedReviewEvidenceRequired()).toBe(false);
});

it("rejects invalid references before invoking replay work", async () => {
  const work = vi.fn(async () => undefined);
  await expect(withReviewReplayContext({ referenceTime: new Date(NaN) }, work)).rejects.toThrow("invalid_replay_reference_time");
  expect(work).not.toHaveBeenCalled();
});

it("binds reference SQL as a parameter while leaving the unscoped DB clock intact", async () => {
  const dialect = new PgDialect();
  expect(dialect.sqlToQuery(reviewSemanticNowSql())).toMatchObject({ sql: "now()", params: [] });
  await withReviewReplayContext({ referenceTime }, async () => {
    expect(dialect.sqlToQuery(reviewSemanticNowSql())).toMatchObject({ sql: "$1::timestamp", params: [referenceTime.toISOString()] });
  });
});

it("uses reference freshness for the complete review input without changing source timestamps", async () => {
  const scan = { id: 1, startedAt: referenceTime, completedAt: referenceTime, state: "complete", lastErrorCode: null,
    detectorVersion: settings.agentEvidence.detectorVersion } as AgentRepositoryScan;
  const evidence = { scan, observations: [] };
  const expected = createReviewInput(candidate, document(), settings, evidence, referenceTime);
  expect(createReviewInput(candidate, document(), settings, evidence).snapshot.relationship).toBe("unknown");
  await withReviewReplayContext({ referenceTime }, async () => {
    const actual = createReviewInput(candidate, document(), settings, evidence);
    expect(actual).toEqual(expected);
    expect(actual.snapshot.relationship).toBe("same_product");
    expect(actual.snapshot.scanState).toBe("complete");
    expect(actual.validUntil.getTime()).toBeLessThan(Date.now());
  });
});

it("passes the same explicit rule clock into access-mode resolution", () => {
  const stored = { ...document(), repoMeta: { full_name: candidate.repo, id: 1, private: false, fork: false,
    archived: false, stargazers_count: 500, pushed_at: referenceTime.toISOString() },
    pageMeta: { ...document().pageMeta, readmeSample: "A useful productivity application." } };
  expect(accessFromDocument(stored, settings)?.mode).toBe("installable");
  expect(accessFromDocument(stored, settings, referenceTime)?.mode).toBe("website");
  expect(createReviewInput(candidate, stored, settings, { scan: null, observations: [] }, referenceTime).snapshot.product.accessMode).toBe("website");
});

it("validates the AI2 generation at reference time while preserving first-attempt identity", async () => {
  const stored = document(), input = createReviewInput(candidate, stored, settings, { scan: null, observations: [] }, referenceTime);
  const first = { id: 1, kind: "automatic", state: "succeeded", provider: "abcllm", model: "first",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, outcome: { decision: "approve" } } as CrawlReviewAttempt;
  const vote = { id: 1, candidateId: candidate.id, repo: candidate.repo, trigger: "ai_approved", publishedSlug: null,
    provider: "abcllm", model: "second", firstAttemptId: first.id, firstDecision: "approve", firstModel: "first",
    generationKey: secondReviewGeneration(first.id, input, "ai_approved"), fallbackForId: null } as SecondReview;
  const current = { candidate, document: stored, settings, input, first };
  expect(secondReviewInputMatches(vote, current)).toBe(false);
  await withReviewReplayContext({ referenceTime }, async () => {
    expect(secondReviewInputMatches(vote, current)).toBe(true);
    expect(secondReviewInputMatches({ ...vote, firstAttemptId: 2 }, current)).toBe(false);
  });
});

it.each([
  [undefined, README_SAMPLE_VERSION], [null, README_SAMPLE_VERSION], [42, README_SAMPLE_VERSION], ["old text", "old"],
])("rejects an unprepared README without fetching or saving (%j, %j)", async (sample, version) => {
  boundary.document.mockResolvedValue({ ...document(), pageMeta: { readmeSample: sample, readmeSampleVersion: version } });
  await withReviewReplayContext({ referenceTime }, async () => {
    await expect(loadReviewDocument(candidate.repo)).rejects.toThrow("replay_readme_evidence_missing");
  });
  expect(boundary.fetch).not.toHaveBeenCalled();
  expect(boundary.save).not.toHaveBeenCalled();
});

it.each(["", "A prepared README"])("accepts a current-version stored README, including explicit absence (%j)", async sample => {
  const stored = { ...document(), pageMeta: { readmeSample: sample, readmeSampleVersion: README_SAMPLE_VERSION } };
  boundary.document.mockResolvedValue(stored);
  await withReviewReplayContext({ referenceTime }, async () => expect(await loadReviewDocument(candidate.repo)).toEqual(stored));
  expect(boundary.fetch).not.toHaveBeenCalled();
  expect(boundary.save).not.toHaveBeenCalled();
});

it("rejects unprepared direct input before querying stored agent evidence", async () => {
  const select = vi.fn(() => { throw new Error("unexpected_evidence_query"); });
  const executor = { select } as unknown as NonNullable<Parameters<typeof loadReviewInput>[3]>;
  await withReviewReplayContext({ referenceTime }, async () => {
    await expect(loadReviewInput(candidate, { ...document(), pageMeta: {} }, settings, executor))
      .rejects.toThrow("replay_readme_evidence_missing");
  });
  expect(select).not.toHaveBeenCalled();
});

it("retains ordinary README fetching outside replay", async () => {
  const stored = { ...document(), pageMeta: {} };
  boundary.document.mockResolvedValue(stored);
  boundary.fetch.mockResolvedValue("stored sample");
  boundary.save.mockResolvedValue(document());
  expect(await loadReviewDocument(candidate.repo)).toEqual(document());
  expect(boundary.fetch).toHaveBeenCalledWith(candidate.repo);
  expect(boundary.save).toHaveBeenCalledTimes(1);
});

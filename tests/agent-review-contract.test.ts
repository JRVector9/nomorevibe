import { expect, it } from "vitest";
import type { CrawlCandidate, CrawlDocument, AgentRepositoryScan } from "@/lib/db/schema";
import type { AgentObservation } from "@/lib/domain/evidence/agents/types";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { createReviewInput, MAX_REVIEW_INPUT_BYTES, reviewHash, validateReviewOutcome } from "@/lib/crawl/agent-review-contract";

const now = new Date("2026-09-08T00:00:00Z");
const candidate = { id: 1, repo: "owner/app", productUrl: "https://app.example", state: "approved", decidedBy: "auto",
  judgedAt: now, updatedAt: now } as CrawlCandidate;
const document = { id: 1, repo: candidate.repo, productUrl: candidate.productUrl, fetchedAt: now,
  pageStatus: 200, repoMeta: { description: "A useful service", topics: ["productivity"] },
  pageMeta: { title: "App", description: "A useful service", repositoryKeys: ["owner/app"] } } as CrawlDocument;
const observation = { kind: "instruction_file", client: null, compatibleClients: ["codex"], modelDeveloper: null,
  declaredModelId: null, gateway: null, routing: "unknown", role: null, scope: "", keyPath: null,
  ruleId: "agents-md", sourcePath: "AGENTS.md", commitSha: "a".repeat(40), blobSha: "b".repeat(40),
  sourceUrl: "https://github.com/owner/app/blob/main/AGENTS.md" } satisfies AgentObservation;
const scan = { id: 1, startedAt: now, completedAt: now, state: "complete", detectorVersion: DEFAULT_CRAWL_SETTINGS.agentEvidence.detectorVersion,
  lastErrorCode: null, commitSha: observation.commitSha } as AgentRepositoryScan;
const evidence = { scan, observations: [{ id: "observation:1", observation }] };

it("hashes semantic inputs stably while tracking operational source revisions separately", () => {
  const first = createReviewInput(candidate, document, DEFAULT_CRAWL_SETTINGS, evidence, now);
  const operational = createReviewInput({ ...candidate, state: "needs_review", updatedAt: new Date(0) }, document,
    { ...DEFAULT_CRAWL_SETTINGS, reviewMode: "enforce" }, evidence, now);
  expect(operational.inputHash).toBe(first.inputHash);
  const fresh = createReviewInput(candidate, { ...document, fetchedAt: new Date(now.getTime() - 1) }, DEFAULT_CRAWL_SETTINGS,
    { ...evidence, scan: { ...scan, id: 2 }, observations: [{ id: "observation:2", observation }] }, now);
  expect(fresh.inputHash).toBe(first.inputHash);
  expect(fresh.sourceRevisionHash).not.toBe(first.sourceRevisionHash);
  expect(reviewHash({ a: 1, b: 2 })).toBe(reviewHash({ b: 2, a: 1 }));
});

it("invalidates semantic approval on product, source relationship, evidence or policy changes", () => {
  const first = createReviewInput(candidate, document, DEFAULT_CRAWL_SETTINGS, evidence, now);
  for (const changed of [
    createReviewInput(candidate, { ...document, pageMeta: { ...document.pageMeta, description: "Different product" } }, DEFAULT_CRAWL_SETTINGS, evidence, now),
    createReviewInput(candidate, { ...document, pageMeta: { ...document.pageMeta, repositoryKeys: ["other/app"] } }, DEFAULT_CRAWL_SETTINGS, evidence, now),
    createReviewInput(candidate, document, { ...DEFAULT_CRAWL_SETTINGS, judge: { ...DEFAULT_CRAWL_SETTINGS.judge, maxStars: 99 } }, evidence, now),
    createReviewInput(candidate, document, DEFAULT_CRAWL_SETTINGS, { ...evidence, observations: [] }, now),
    createReviewInput(candidate, { ...document, pageMeta: { ...document.pageMeta, textSample: "App CLI. Install: npm install -g app" } }, DEFAULT_CRAWL_SETTINGS, evidence, now),
  ]) expect(changed.inputHash).not.toBe(first.inputHash);
});

it("gives the model the same page body the rules judge", () => {
  const body = "App — plan your week. Sign in to your dashboard.";
  const input = createReviewInput(candidate, { ...document, pageMeta: { ...document.pageMeta, textSample: body } }, DEFAULT_CRAWL_SETTINGS, evidence, now);
  expect(input.snapshot.product.pageText).toBe(body);
  const edited = createReviewInput(candidate, { ...document, pageMeta: { ...document.pageMeta, textSample: `${body} Install: brew install app` } },
    DEFAULT_CRAWL_SETTINGS, evidence, now);
  expect(edited.inputHash).not.toBe(input.inputHash);
  expect(createReviewInput(candidate, document, DEFAULT_CRAWL_SETTINGS, evidence, now).snapshot.product.pageText).toBe("");
});

it("tracks a same-SHA scan refresh even when completion time and semantic observations stay unchanged", () => {
  const first = createReviewInput(candidate, document, DEFAULT_CRAWL_SETTINGS, evidence, now);
  const refreshed = createReviewInput(candidate, document, DEFAULT_CRAWL_SETTINGS,
    { ...evidence, scan: { ...scan, startedAt: new Date(now.getTime() - 1) } }, now);
  expect(refreshed.inputHash).toBe(first.inputHash);
  expect(refreshed.sourceRevisionHash).not.toBe(first.sourceRevisionHash);
});

it("preserves static file discovery as evidence without claiming model execution", () => {
  const settings = { ...DEFAULT_CRAWL_SETTINGS, agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enforceEligibility: true } };
  const input = createReviewInput(candidate, document, settings, evidence, now);
  expect(input.snapshot.evidenceSummary).toMatchObject({ eligible: false, executionVerified: false });
  expect(() => validateReviewOutcome(input, { decision: "approve", reason: "Has AGENTS.md", evidenceIds: ["observation:1"] }))
    .toThrow("review_evidence_policy_failed");
});

it("rejects invented or missing evidence IDs and caps the actual UTF-8 input snapshot", () => {
  const input = createReviewInput(candidate, document, DEFAULT_CRAWL_SETTINGS, {
    scan, observations: Array.from({ length: 100 }, (_, index) => ({ id: `observation:${index}`,
      observation: { ...observation, sourcePath: "한".repeat(1000), ruleId: `rule-${index}` } })),
  }, now);
  expect(Buffer.byteLength(JSON.stringify(input.snapshot))).toBeLessThanOrEqual(MAX_REVIEW_INPUT_BYTES);
  expect(input.snapshot.evidenceTruncated).toBe(true);
  expect(() => validateReviewOutcome(input, { decision: "approve", reason: "Made up", evidenceIds: ["unknown"] })).toThrow("review_unknown_evidence");
  expect(() => validateReviewOutcome(input, { decision: "approve", reason: "No evidence", evidenceIds: [] })).toThrow("review_missing_evidence");
});

/**
 * 실측(2026-09-11, 사람이 결정한 50건): 옛 입력·지시문은 90%를 보류했다. README·저장소 사실·규칙이 멈춘
 * 곳을 싣고 "쓸 수 있는 제품인가" 하나만 물으니 보류 10%, 사람과 일치 84%, 반대 판단 6%.
 */
it("README·저장소 사실·규칙이 멈춘 곳을 싣고, README 가 바뀌면 입력 해시도 바뀐다", () => {
  const withReadme = { ...document, repoMeta: { ...document.repoMeta, stargazers_count: 7, pushed_at: "2026-09-01T00:00:00Z", created_at: "2026-08-01T00:00:00Z" },
    pageMeta: { ...document.pageMeta, readmeSample: "Oigo — dictation for macOS. brew install oigo" } } as CrawlDocument;
  const input = createReviewInput(candidate, withReadme, DEFAULT_CRAWL_SETTINGS, evidence, now);
  expect(input.snapshot.product.readme).toBe("Oigo — dictation for macOS. brew install oigo");
  expect(input.snapshot.repoFacts).toEqual({ stars: 7, pushedAt: "2026-09-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z" });
  expect(input.snapshot.rules).toHaveProperty("stoppedAt");

  const changed = createReviewInput(candidate, { ...withReadme, pageMeta: { ...withReadme.pageMeta, readmeSample: "A CLI. npm i -g oigo" } } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, evidence, now);
  expect(changed.inputHash).not.toBe(input.inputHash);
});

it("README 를 아직 못 받았으면 빈 글자로 싣는다", () => {
  expect(createReviewInput(candidate, document, DEFAULT_CRAWL_SETTINGS, evidence, now).snapshot.product.readme).toBe("");
});

it("규칙이 멈춘 곳은 보류 후보의 마지막 단계다", () => {
  const held = { ...document, productUrl: "https://owner.github.io/app",
    repoMeta: { ...document.repoMeta, pushed_at: "2026-09-07T00:00:00Z", stargazers_count: 3, owner: { type: "User" } } } as CrawlDocument;
  const { rules } = createReviewInput({ ...candidate, productUrl: held.productUrl }, held, DEFAULT_CRAWL_SETTINGS, evidence, now).snapshot;
  expect(rules.stoppedAt).toBeTruthy();
  expect(rules.cause).toBe("host_excluded_subpath");
});

it("확신도는 0~1 만 받고, 없어도 된다", () => {
  const input = createReviewInput(candidate, document, DEFAULT_CRAWL_SETTINGS, evidence, now);
  expect(validateReviewOutcome(input, { decision: "reject", reason: "문서 사이트", evidenceIds: ["product"], confidence: 0.9 }).confidence).toBe(0.9);
  expect(validateReviewOutcome(input, { decision: "reject", reason: "문서 사이트", evidenceIds: ["product"] }).confidence).toBeUndefined();
  expect(() => validateReviewOutcome(input, { decision: "reject", reason: "문서 사이트", evidenceIds: ["product"], confidence: 1.5 })).toThrow();
});

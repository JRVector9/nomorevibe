import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrawlCandidate, CrawlDocument, CrawlReviewAttempt, SecondReview } from "@/lib/db/schema";
import { MODEL_ASSIGNMENT_TABLE_ENV, assignmentTableEnabled, parseAssignmentTableFlag, setAssignmentTableEnabledForTest } from "@/lib/llm/assignment-flag";
import type { ModelAssignmentRow } from "@/lib/llm/capacity-helpers";
import { assignmentSourceFor, stageTableRows } from "@/lib/llm/stage-assignments";
import { assignmentSource, requireStageAssignments, setStageAssignmentsForTest, stageAssignmentRows } from "@/lib/llm/stage-assignment-snapshot";
import { firstReviewTableRows, firstReviewers, firstReviewerKey, hasFirstReviewer, selectFirstReviewer, selectTableFirstReviewer,
  tableFirstReviewers } from "@/lib/crawl/first-reviewers";
import { secondReviewFallbacks, secondReviewVoterSets, secondReviewVoters, tableSecondReviewVoters } from "@/lib/crawl/second-review-voters";
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { secondReviewGeneration, secondReviewInputMatches } from "@/lib/crawl/second-review-input";
import { secondReviewPolicyHash } from "@/lib/crawl/second-review-ownership";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";

/** PR 3b-B — MODEL_ASSIGNMENT_TABLE 이 켜졌을 때의 고르기(순수 판정 + 고정한 스냅숏). 꺼진 경로는 기존 시험이 그대로 본다. */
let seq = 0;
const row = (value: Partial<ModelAssignmentRow> & Pick<ModelAssignmentRow, "stage" | "model" | "provider">): ModelAssignmentRow => ({
  assignmentId: value.assignmentId ?? `row-${String(++seq).padStart(3, "0")}`, deviceId: "dev-a", registryKey: "supa:review", transport: "gateway",
  rank: 1, role: "primary", vote: false, mode: "live", routeId: "route", maxSlots: 1, evidenceKey: "e".repeat(64), version: 1, note: null,
  updatedBy: "fixture", createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z", ...value });
const legacyFirst = { provider: "abcllm" as const, model: "legacy-first" };
const poolSettings = { firstReview: legacyFirst, firstReviewAdditional: [] as { provider: "abcllm"; model: string }[] };

beforeEach(() => { seq = 0; });
afterEach(() => { setAssignmentTableEnabledForTest(null); setStageAssignmentsForTest(null); vi.unstubAllEnvs(); });

describe("MODEL_ASSIGNMENT_TABLE flag", () => {
  it("is on only for exactly '1'; anything else is off (an invalid value never changes selection)", () => {
    expect(MODEL_ASSIGNMENT_TABLE_ENV).toBe("MODEL_ASSIGNMENT_TABLE");
    expect(parseAssignmentTableFlag("1")).toEqual({ enabled: true, invalid: false });
    expect(parseAssignmentTableFlag(" 1 ")).toEqual({ enabled: true, invalid: false });
    for (const value of [undefined, "", "0"]) expect(parseAssignmentTableFlag(value)).toEqual({ enabled: false, invalid: false });
    for (const value of ["true", "yes", "2", "on"]) expect(parseAssignmentTableFlag(value)).toEqual({ enabled: false, invalid: true });
  });

  it("reads the env once per process", () => {
    setAssignmentTableEnabledForTest(null);
    vi.stubEnv(MODEL_ASSIGNMENT_TABLE_ENV, "1");
    expect(assignmentTableEnabled()).toBe(true);
    vi.stubEnv(MODEL_ASSIGNMENT_TABLE_ENV, "0");
    expect(assignmentTableEnabled()).toBe(true);                                        // fixed at the first read
    setAssignmentTableEnabledForTest(null);
    expect(assignmentTableEnabled()).toBe(false);
  });
});

describe("assignment source (pure)", () => {
  const rows = [row({ stage: "ai1", model: "[supa] q", provider: "abcllm" }), row({ stage: "ai1", model: "spark", provider: "codex-cli" }),
    row({ stage: "ai2", model: "[supa] q", provider: "abcllm", rank: 2 }), row({ stage: "tagline", model: "[MLX] t", provider: "abcllm", mode: "off" })];
  it("is legacy when off or unread, legacy_empty_table without usable rows, table otherwise", () => {
    expect(assignmentSourceFor("ai1", false, rows)).toBe("legacy");
    expect(assignmentSourceFor("ai1", true, null)).toBe("legacy");
    expect(assignmentSourceFor("ai1", true, rows)).toBe("table");
    expect(assignmentSourceFor("tagline", true, rows)).toBe("legacy_empty_table");             // only an off row
    expect(assignmentSourceFor("ai2", true, rows)).toBe("legacy_empty_table");                 // a fallback but no voter
    expect(assignmentSourceFor("ai2", true, [...rows, row({ stage: "ai2", model: "deep", provider: "local-direct", vote: true })])).toBe("table");
    expect(assignmentSourceFor("ai1", true, [rows[1]])).toBe("legacy_empty_table");            // codex-cli cannot be a first reviewer
  });
  it("orders usable rows by rank then assignment id and drops helper, off and unsupported rows", () => {
    const ordered = stageTableRows("ai1", [row({ assignmentId: "b", stage: "ai1", model: "b", provider: "abcllm", rank: 2 }),
      row({ assignmentId: "c", stage: "ai1", model: "c", provider: "abcllm" }), row({ assignmentId: "a", stage: "ai1", model: "a", provider: "abcllm" }),
      row({ assignmentId: "h", stage: "ai1", model: "h", provider: "abcllm", role: "helper" as never }),
      row({ assignmentId: "x", stage: "ai1", model: "x", provider: "codex-cli" })]);
    expect(ordered.map(entry => entry.assignmentId)).toEqual(["a", "c", "b"]);
  });
});

describe("snapshot gate", () => {
  it("returns no rows while off; with the flag on it serves the pinned snapshot per stage", () => {
    setStageAssignmentsForTest([row({ stage: "ai1", model: "[supa] q", provider: "abcllm" })]);
    expect(assignmentSource("ai1")).toBe("legacy");
    expect(stageAssignmentRows("ai1")).toBeNull();
    setAssignmentTableEnabledForTest(true);
    expect(assignmentSource("ai1")).toBe("table");
    expect(assignmentSource("ai2")).toBe("legacy_empty_table");
    expect(stageAssignmentRows("ai1")?.map(entry => entry.model)).toEqual(["[supa] q"]);
    expect(stageAssignmentRows("ai2")).toBeNull();
  });

  it("defers async entry points with assignments_unavailable when on but never read, and passes when off or loaded", async () => {
    vi.stubEnv("DATABASE_URL", "");
    await expect(requireStageAssignments()).resolves.toBeUndefined();                       // off
    setAssignmentTableEnabledForTest(true);
    const refused = await requireStageAssignments().catch(error => error);
    expect(refused).toBeInstanceOf(ModelCapacityDeferredError);
    expect((refused as ModelCapacityDeferredError).reason).toBe("assignments_unavailable");
    setStageAssignmentsForTest([]);
    await expect(requireStageAssignments()).resolves.toBeUndefined();                       // loaded (even if empty → legacy)
    expect(assignmentSource("ai1")).toBe("legacy_empty_table");
  });
});

describe("AI1 reviewers from the table", () => {
  const a = row({ assignmentId: "ai1:01", stage: "ai1", model: "[supa] Qwen", provider: "abcllm" });
  const b = row({ assignmentId: "ai1:02", stage: "ai1", model: "[MLX] gpt", provider: "abcllm" });
  const c = row({ assignmentId: "ai1:03", stage: "ai1", model: "sonnet", provider: "claude-cli" });
  const fallback = row({ assignmentId: "ai1:04", stage: "ai1", model: "grok-4.7", provider: "grok-cli", rank: 2 });
  const rows = [fallback, c, a, b];
  const reviewer = (entry: ModelAssignmentRow) => ({ provider: entry.provider, model: entry.model });

  it("builds the pool from the table and ignores firstReview/firstReviewAdditional (pool mode required)", () => {
    expect(tableFirstReviewers(rows)).toEqual([reviewer(a), reviewer(b), reviewer(c), reviewer(fallback)]);
    for (const value of tableFirstReviewers(rows)) expect(Object.keys(value).sort()).toEqual(["model", "provider"]);
    setStageAssignmentsForTest(rows);
    expect(firstReviewers(poolSettings)).toEqual([legacyFirst]);                               // flag off
    setAssignmentTableEnabledForTest(true);
    expect(firstReviewers(poolSettings)).toEqual(tableFirstReviewers(rows));
    expect(firstReviewers({ ...poolSettings, firstReviewAdditional: [{ provider: "abcllm", model: "legacy-extra" }] }, legacyFirst))
      .toEqual(tableFirstReviewers(rows));
    expect(hasFirstReviewer(firstReviewers(poolSettings), reviewer(fallback))).toBe(true);    // a fallback's result is a current first reviewer
    expect(hasFirstReviewer(firstReviewers(poolSettings), legacyFirst)).toBe(false);
    // not pool mode: the consumer/legacy job would send firstReviewer(settings) alone — stay legacy
    expect(firstReviewTableRows({ firstReview: legacyFirst })).toBeNull();
    expect(firstReviewers({ firstReview: legacyFirst })).toEqual([legacyFirst]);
    // no usable ai1 rows: legacy
    setStageAssignmentsForTest([row({ stage: "ai1", model: "spark", provider: "codex-cli" })]);
    expect(firstReviewers(poolSettings)).toEqual([legacyFirst]);
  });

  it("uses the same (id − 1) mod n slot as selectFirstReviewer over the rank-1 rows", () => {
    const legacyPool = [reviewer(a), reviewer(b), reviewer(c)] as Parameters<typeof selectFirstReviewer>[0];
    for (const id of [1, 2, 3, 4, 5, 6, 7, 100])
      expect(selectTableFirstReviewer(rows, id)).toEqual(selectFirstReviewer(legacyPool, id));
    expect(selectTableFirstReviewer(rows, 0)).toBeNull();
    expect(selectTableFirstReviewer([], 1)).toBeNull();
  });

  it("pins active intents and retries to their model (fallbacks included) and never moves sent work", () => {
    expect(selectTableFirstReviewer(rows, 1, [reviewer(fallback)])).toEqual(reviewer(fallback));
    expect(selectTableFirstReviewer(rows, 1, [], [reviewer(c)])).toEqual(reviewer(c));
    expect(selectTableFirstReviewer(rows, 1, [legacyFirst])).toBeNull();                       // removed model: no reassignment
    expect(selectTableFirstReviewer(rows, 1, [], [reviewer(a), reviewer(b)])).toBeNull();
    const blocked = new Set([firstReviewerKey(a)]);
    expect(selectTableFirstReviewer(rows, 1, [], [reviewer(a)], { blocked, untouched: true })).toEqual(reviewer(a));
  });

  it("reroutes only untouched candidates: next rank-1 row, then the rank-2 fallback, else waits on the fixed slot", () => {
    const untouched = (keys: ModelAssignmentRow[]) => ({ blocked: new Set(keys.map(entry => firstReviewerKey(entry))), untouched: true });
    expect(selectTableFirstReviewer(rows, 1, [], [], untouched([a]))).toEqual(reviewer(b));
    expect(selectTableFirstReviewer(rows, 3, [], [], untouched([c]))).toEqual(reviewer(a));
    expect(selectTableFirstReviewer(rows, 1, [], [], { ...untouched([a]), untouched: false })).toEqual(reviewer(a));
    expect(selectTableFirstReviewer(rows, 2, [], [], untouched([a, b, c]))).toEqual(reviewer(fallback));
    expect(selectTableFirstReviewer(rows, 2, [], [], untouched([a, b, c, fallback]))).toEqual(reviewer(b));
  });
});

describe("AI2 voters from the table", () => {
  const settings = { secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters: [{ provider: "claude-cli" as const, model: "opus" }],
    fallbacks: [{ provider: "abcllm" as const, model: "legacy-backup" }] } };
  const v1 = row({ assignmentId: "ai2:01", stage: "ai2", model: "deep-1", provider: "local-direct", vote: true });
  const v2 = row({ assignmentId: "ai2:02", stage: "ai2", model: "[supa] Qwen", provider: "abcllm", vote: true });
  const idle = row({ assignmentId: "ai2:03", stage: "ai2", model: "idle", provider: "abcllm" });
  const f1 = row({ assignmentId: "ai2:05", stage: "ai2", model: "[MLX] gpt", provider: "abcllm", rank: 3 });
  const f2 = row({ assignmentId: "ai2:04", stage: "ai2", model: "backup", provider: "abcllm", rank: 2 });
  const dup = row({ assignmentId: "ai2:06", stage: "ai2", model: "[mlx] GPT", provider: "abcllm", rank: 4 });
  const cli = row({ assignmentId: "ai2:07", stage: "ai2", model: "spark", provider: "codex-cli", rank: 2 });

  it("voters = rank 1 · vote rows, fallbacks = rank ≥ 2 by rank, one row per model, plain { provider, model } objects", () => {
    expect(tableSecondReviewVoters([f1, idle, v2, dup, cli, f2, v1])).toEqual({
      voters: [{ provider: "local-direct", model: "deep-1" }, { provider: "abcllm", model: "[supa] Qwen" }],
      fallbacks: [{ provider: "abcllm", model: "backup" }, { provider: "abcllm", model: "[MLX] gpt" }] });
  });

  it("switches every reader together and keeps the settings arrays when off or without a voter", () => {
    setStageAssignmentsForTest([v1, f2]);
    expect(secondReviewVoters(settings)).toBe(settings.secondReview.voters);
    expect(secondReviewFallbacks(settings)).toBe(settings.secondReview.fallbacks);
    setAssignmentTableEnabledForTest(true);
    expect(secondReviewVoterSets(settings)).toEqual({ source: "table", voters: [{ provider: "local-direct", model: "deep-1" }],
      fallbacks: [{ provider: "abcllm", model: "backup" }] });
    setStageAssignmentsForTest([f2]);
    expect(secondReviewVoterSets(settings).source).toBe("settings");
  });

  it("accepts a table voter and its table fallback in input validation, refuses the settings-only voter, and keeps the AI2 policy hash", () => {
    const now = new Date("2026-10-16T03:00:00.000Z");
    const crawl: CrawlSettings = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
      firstReview: { provider: "abcllm", model: "first-model" },
      secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: true, voters: [{ provider: "abcllm", model: "second-model" }] } };
    const candidate: CrawlCandidate = { id: 11, repo: "assign/app", productUrl: "https://assign.test", state: "approved", reason: "passed", decidedBy: "auto",
      signals: {}, publishedSlug: null, judgedAt: now, decidedAt: now, updatedAt: now };
    const document: CrawlDocument = { id: 31, repo: candidate.repo, productUrl: candidate.productUrl, fetchedAt: new Date(+now - 1_000), pageStatus: 200,
      repoMeta: { description: "A deployed application", stargazers_count: 12, fork: false, archived: false,
        pushed_at: new Date(+now - 60_000).toISOString(), owner: { type: "User" } },
      pageMeta: { title: "Assign", description: "Manage projects and tasks", textSample: "Create projects and manage tasks.", repositoryKeys: [candidate.repo] } };
    const input = createReviewInput(candidate, document, crawl, { scan: null, observations: [] }, now);
    const first: CrawlReviewAttempt = { id: 101, candidateId: candidate.id, kind: "automatic", state: "succeeded", inputHash: input.inputHash,
      sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash, snapshot: input.snapshot, source: input.source,
      promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: "abcllm", model: "first-model", attemptNumber: 1,
      reusedFromAttemptId: null, outcome: { decision: "approve", confidence: 0.94, reason: "A deployed application", evidenceIds: ["product"] },
      errorCode: null, inputTokens: 10, outputTokens: 5, costUsd: null, actor: null, reason: null, leaseToken: "t", startedAt: new Date(+now - 500),
      completedAt: now, retryAfter: null, validUntil: input.validUntil };
    const vote = (model: string, provider: SecondReview["provider"], extra: Partial<SecondReview> = {}): SecondReview => ({ id: 201, candidateId: candidate.id,
      repo: candidate.repo, publishedSlug: null, trigger: "ai_approved", signals: [], firstDecision: "approve", firstConfidence: 0.94,
      firstModel: "first-model", firstAttemptId: first.id, generationKey: secondReviewGeneration(first.id, input, "ai_approved"),
      inputHash: input.inputHash, provider, model, secondDecision: null, secondConfidence: null, secondReason: null, autoOpinion: null,
      errorCode: null, errorDetail: null, fallbackForId: null, failureCount: 0, status: "pending", resolvedBy: null, resolution: null,
      createdAt: now, reviewedAt: null, resolvedAt: null, ...extra });
    const current = { candidate, document, settings: crawl, input, first };
    const hash = secondReviewPolicyHash(crawl);
    expect(secondReviewInputMatches(vote("second-model", "abcllm"), current, now)).toBe(true);
    expect(secondReviewInputMatches(vote("deep-1", "local-direct"), current, now)).toBe(false);
    setStageAssignmentsForTest([v1, f2]);
    setAssignmentTableEnabledForTest(true);
    expect(secondReviewInputMatches(vote("deep-1", "local-direct"), current, now)).toBe(true);
    expect(secondReviewInputMatches(vote("second-model", "abcllm"), current, now)).toBe(false);
    const root = vote("deep-1", "local-direct", { status: "resolved", resolution: "fallback", failureCount: 1 });
    expect(secondReviewInputMatches(vote("backup", "abcllm", { id: 202, fallbackForId: 201, failureCount: 1 }), { ...current, root }, now)).toBe(true);
    expect(secondReviewInputMatches(vote("[MLX] gpt", "abcllm", { id: 202, fallbackForId: 201, failureCount: 1 }), { ...current, root }, now)).toBe(false);
    expect(secondReviewPolicyHash(crawl)).toBe(hash);
  });
});

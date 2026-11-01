import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrawlCandidate, CrawlDocument, CrawlReviewAttempt, SecondReview } from "@/lib/db/schema";
import { MODEL_ASSIGNMENT_TABLE_ENV, assignmentFlag, assignmentTableEnabled, assignmentTableReplayPinned, parseAssignmentTableOverride,
  setAssignmentTableEnabledForTest } from "@/lib/llm/assignment-flag";
import type { ModelAssignmentRow } from "@/lib/llm/capacity-helpers";
import { assignmentSourceFor, stageTableRows } from "@/lib/llm/stage-assignments";
import { assignmentSource, ensureStageAssignments, requireStageAssignments, setStageAssignmentsForTest, stageAssignmentRows } from "@/lib/llm/stage-assignment-snapshot";
import { replayRuntimeSettingsSnapshot, runtimeSettingsSnapshotFromStored, setRuntimeSettingsForTest, setRuntimeSettingsLoader,
  withRuntimeSettings, type RuntimeSettingsLoader } from "@/lib/operations/runtime-settings-store";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { firstReviewTableRows, firstReviewers, firstReviewerKey, hasFirstReviewer, selectFirstReviewer, selectTableFirstReviewer,
  tableFirstReviewers } from "@/lib/crawl/first-reviewers";
import { secondReviewFallbacks, secondReviewVoterSets, secondReviewVoters, tableSecondReviewVoters } from "@/lib/crawl/second-review-voters";
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { secondReviewGeneration, secondReviewInputMatches } from "@/lib/crawl/second-review-input";
import { secondReviewPolicyHash } from "@/lib/crawl/second-review-ownership";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";

/**
 * PR 3b-B — 배정 표 읽기가 켜졌을 때의 고르기(순수 판정 + 고정한 스냅숏). 꺼진 경로는 기존 시험이 그대로 본다.
 * PR 3b-E — 스위치는 runtime_settings 토글(assignments.tableReads)이고 env MODEL_ASSIGNMENT_TABLE 은 강제다(첫 describe).
 * DB 는 가짜다: 토글을 못 읽는 프로세스의 미룸을 보려고 db.execute 가 늘 실패한다(serving-contract reload 가 받아 마지막 스냅숏을 지킨다).
 */
vi.mock("@/lib/db", async importOriginal => ({ ...(await importOriginal<object>()),
  db: new Proxy({}, { get: () => () => { throw new Error("db_down"); } }) }));
// replay DB 범위(currentReplayDb)만 흉내 낸다 — 관문이 범위 안에서 읽지 않고, 범위 밖의 다음 길목을 「읽은 것」으로 두지 않는가(PR #771 CI 회귀).
const replay = vi.hoisted(() => ({ active: false, marker: {} as object }));
vi.mock("@/lib/db/replay-scope", async importOriginal => ({ ...(await importOriginal<object>()),
  currentReplayDb: () => replay.active ? replay.marker : undefined }));
let seq = 0;
const row = (value: Partial<ModelAssignmentRow> & Pick<ModelAssignmentRow, "stage" | "model" | "provider">): ModelAssignmentRow => ({
  assignmentId: value.assignmentId ?? `row-${String(++seq).padStart(3, "0")}`, deviceId: "dev-a", registryKey: "supa:review", transport: "gateway",
  rank: 1, role: "primary", vote: false, mode: "live", routeId: "route", maxSlots: 1, evidenceKey: "e".repeat(64), version: 1, note: null,
  updatedBy: "fixture", createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z", ...value });
const legacyFirst = { provider: "abcllm" as const, model: "legacy-first" };
const poolSettings = { firstReview: legacyFirst, firstReviewAdditional: [] as { provider: "abcllm"; model: string }[] };

const TOGGLE_ON = { version: 1, assignments: { tableReads: "on" } }, TOGGLE_OFF = { version: 1, assignments: { tableReads: "off" } };

beforeEach(() => { seq = 0; vi.stubEnv(MODEL_ASSIGNMENT_TABLE_ENV, ""); setAssignmentTableEnabledForTest(null); });
afterEach(() => { setAssignmentTableEnabledForTest(null); setStageAssignmentsForTest(null); setRuntimeSettingsForTest(null); setServingContractSnapshotForTest(null);
  vi.unstubAllEnvs(); });

describe("assignment-table switch — runtime_settings toggle, env override (PR 3b-E)", () => {
  it("env MODEL_ASSIGNMENT_TABLE is an override only: '1' forces on, '0' forces off, blank follows the toggle, anything else is ignored", () => {
    expect(MODEL_ASSIGNMENT_TABLE_ENV).toBe("MODEL_ASSIGNMENT_TABLE");
    expect(parseAssignmentTableOverride("1")).toEqual({ override: "on", invalid: false });
    expect(parseAssignmentTableOverride(" 1 ")).toEqual({ override: "on", invalid: false });
    expect(parseAssignmentTableOverride("0")).toEqual({ override: "off", invalid: false });
    for (const value of [undefined, ""]) expect(parseAssignmentTableOverride(value)).toEqual({ override: null, invalid: false });
    for (const value of ["true", "yes", "2", "on"]) expect(parseAssignmentTableOverride(value)).toEqual({ override: null, invalid: true });
  });

  it("follows the saved toggle without a restart (unread → off; off; on) and the env override wins, read once per process", () => {
    expect(assignmentFlag()).toEqual({ enabled: false, source: "unread", override: null });         // the default snapshot never came from the DB
    setRuntimeSettingsForTest({ version: 1 });
    expect(assignmentFlag()).toEqual({ enabled: false, source: "runtime", override: null });        // a DB document without the key = default off
    setRuntimeSettingsForTest(TOGGLE_ON);
    expect(assignmentFlag()).toEqual({ enabled: true, source: "runtime", override: null });
    expect(assignmentTableEnabled()).toBe(true);
    setRuntimeSettingsForTest(TOGGLE_OFF);
    expect(assignmentTableEnabled()).toBe(false);
    // env forces regardless of the toggle; it is read once (a later env change needs a restart)
    vi.stubEnv(MODEL_ASSIGNMENT_TABLE_ENV, "1");
    setAssignmentTableEnabledForTest(null);
    expect(assignmentFlag()).toEqual({ enabled: true, source: "env", override: "on" });
    vi.stubEnv(MODEL_ASSIGNMENT_TABLE_ENV, "0");
    expect(assignmentTableEnabled()).toBe(true);
    setAssignmentTableEnabledForTest(null);
    setRuntimeSettingsForTest(TOGGLE_ON);
    expect(assignmentFlag()).toEqual({ enabled: false, source: "env", override: "off" });          // forced off while the toggle says on
    // a bad value follows the toggle
    vi.stubEnv(MODEL_ASSIGNMENT_TABLE_ENV, "yes");
    setAssignmentTableEnabledForTest(null);
    expect(assignmentFlag()).toEqual({ enabled: true, source: "runtime", override: null });
    // the test pin reports as forced
    setAssignmentTableEnabledForTest(false);
    expect(assignmentFlag()).toEqual({ enabled: false, source: "env", override: "off" });
  });

  it("the gate refreshes the toggle itself: unread in a DB-reading process defers, an env-only process (kill switch) stays legacy", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://nobody:nothing@127.0.0.1:1/never");
    vi.stubEnv("MODEL_SERVING_CONTRACTS_DB", "0");                                                 // env-only: the toggle is never read, no deferral
    await expect(requireStageAssignments()).resolves.toBeUndefined();
    expect(assignmentFlag().source).toBe("unread");
    expect(assignmentSource("ai1")).toBe("legacy");
    vi.stubEnv("MODEL_SERVING_CONTRACTS_DB", "");                                                  // DB-reading process whose reads fail (db_down): defer
    setStageAssignmentsForTest(null);
    const refused = await requireStageAssignments().catch(error => error);
    expect(refused).toBeInstanceOf(ModelCapacityDeferredError);
    expect((refused as ModelCapacityDeferredError).reason).toBe("assignments_unavailable");
    // once the toggle is readable (pinned document) the same gate passes while off, and the sync readers stay legacy
    setRuntimeSettingsForTest(TOGGLE_OFF);
    await expect(requireStageAssignments()).resolves.toBeUndefined();
    expect(assignmentSource("ai1")).toBe("legacy");
    // toggle on but the rows cannot be read (db_down): defer — never the legacy list
    setRuntimeSettingsForTest(TOGGLE_ON);
    await ensureStageAssignments(0);
    expect(stageAssignmentRows("ai1")).toBeNull();
    await expect(requireStageAssignments()).rejects.toMatchObject({ reason: "assignments_unavailable" });
  });

  it("a replay-pinned tick (fixed-input replay) is a decided off: legacy, no toggle read, no deferral — and the pin does not leak out of the tick", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://nobody:nothing@127.0.0.1:1/never");
    vi.stubEnv("MODEL_SERVING_CONTRACTS_DB", "");                                                  // a DB-reading process whose reads fail (db_down)
    expect(assignmentFlag().source).toBe("unread");
    await withRuntimeSettings(replayRuntimeSettingsSnapshot(), async () => {
      expect(assignmentTableReplayPinned()).toBe(true);
      expect(assignmentFlag()).toEqual({ enabled: false, source: "runtime", override: null });
      await expect(requireStageAssignments()).resolves.toBeUndefined();                       // the fixed tick never defers on the unread process snapshot
      await expect(ensureStageAssignments(0)).resolves.toBeUndefined();
      expect(assignmentSource("ai1")).toBe("legacy");
      expect(stageAssignmentRows("ai1")).toBeNull();
    });
    // outside the tick the process is still unread (the tick read nothing and left no read timestamp): the live gate keeps deferring as designed
    expect(assignmentTableReplayPinned()).toBe(false);
    expect(assignmentFlag().source).toBe("unread");
    await expect(requireStageAssignments()).rejects.toMatchObject({ reason: "assignments_unavailable" });
  });

  it("a gate crossed inside a replay DB scope reads nothing and does not count as a read: the next gate outside the scope reads the toggle itself", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://nobody:nothing@127.0.0.1:1/never");
    vi.stubEnv("MODEL_SERVING_CONTRACTS_DB", "");
    // the real loader (serving-contract-store) would fail on db_down; count a stand-in that serves the stored toggle
    const holder = globalThis as { __nmvRuntimeSettings?: { loader: RuntimeSettingsLoader | null } };
    const original = holder.__nmvRuntimeSettings?.loader ?? null;
    let reads = 0;
    setRuntimeSettingsLoader(async () => { reads++; return runtimeSettingsSnapshotFromStored(TOGGLE_OFF, 7).snapshot; });
    try {
      replay.active = true;
      await expect(requireStageAssignments()).resolves.toBeUndefined();                       // replay scope: legacy, no deferral …
      await expect(ensureStageAssignments(0)).resolves.toBeUndefined();
      expect(reads).toBe(0);                                                                  // … and no toggle read
      expect(assignmentFlag().source).toBe("unread");
      replay.active = false;
      await expect(requireStageAssignments()).resolves.toBeUndefined();                       // outside: the toggle is read now (not skipped as "fresh") → off → legacy
      expect(reads).toBe(1);
      expect(assignmentFlag()).toEqual({ enabled: false, source: "runtime", override: null });
      expect(assignmentSource("ai1")).toBe("legacy");
    } finally { replay.active = false; setRuntimeSettingsLoader(original); }
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
  it("returns no rows while off; with the switch on (toggle or override) it serves the pinned snapshot per stage", () => {
    setStageAssignmentsForTest([row({ stage: "ai1", model: "[supa] q", provider: "abcllm" })]);
    expect(assignmentSource("ai1")).toBe("legacy");
    expect(stageAssignmentRows("ai1")).toBeNull();
    setRuntimeSettingsForTest(TOGGLE_ON);                                                          // the saved toggle, no env
    expect(assignmentSource("ai1")).toBe("table");
    expect(assignmentSource("ai2")).toBe("legacy_empty_table");
    expect(stageAssignmentRows("ai1")?.map(entry => entry.model)).toEqual(["[supa] q"]);
    expect(stageAssignmentRows("ai2")).toBeNull();
    setRuntimeSettingsForTest(TOGGLE_OFF);
    expect(assignmentSource("ai1")).toBe("legacy");
    setAssignmentTableEnabledForTest(true);
    expect(assignmentSource("ai1")).toBe("table");
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

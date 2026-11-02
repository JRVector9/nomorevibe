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
import { firstReviewers, hasFirstReviewer } from "@/lib/crawl/first-reviewers";
import { secondReviewFallbacks, secondReviewVoterSets, secondReviewVoters } from "@/lib/crawl/second-review-voters";
import { pinReviewRanks } from "./review-task-ranks-fixture";
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
  pinReviewRanks(null); vi.unstubAllEnvs(); });

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
  const rows = [row({ stage: "reason", model: "[supa] q", provider: "abcllm" }), row({ stage: "ai1", model: "[supa] q", provider: "abcllm" }),
    row({ stage: "ai2", model: "deep", provider: "local-direct", vote: true }), row({ stage: "tagline", model: "[MLX] t", provider: "abcllm", mode: "off" })];
  it("is legacy when off or unread, legacy_empty_table without usable rows, table otherwise", () => {
    expect(assignmentSourceFor("reason", false, rows)).toBe("legacy");
    expect(assignmentSourceFor("reason", true, null)).toBe("legacy");
    expect(assignmentSourceFor("reason", true, rows)).toBe("table");
    expect(assignmentSourceFor("tagline", true, rows)).toBe("legacy_empty_table");             // only an off row
    // PR C1: 1차·2차는 「작업 ↔ 모델」 순위만 읽는다 — 표에 쓸 수 있는 ai1 행·ai2 투표 행이 있어도 출처가 되지 않는다
    expect(assignmentSourceFor("ai1", true, rows)).toBe("legacy_empty_table");
    expect(assignmentSourceFor("ai2", true, rows)).toBe("legacy_empty_table");
    expect(assignmentSourceFor("ai1", false, rows)).toBe("legacy");
  });
  it("orders usable rows by rank then assignment id and drops helper and off rows", () => {
    const ordered = stageTableRows("reason", [row({ assignmentId: "b", stage: "reason", model: "b", provider: "abcllm", rank: 2 }),
      row({ assignmentId: "c", stage: "reason", model: "c", provider: "abcllm" }), row({ assignmentId: "a", stage: "reason", model: "a", provider: "abcllm" }),
      row({ assignmentId: "h", stage: "reason", model: "h", provider: "abcllm", role: "helper" as never }),
      row({ assignmentId: "o", stage: "reason", model: "o", provider: "abcllm", mode: "off" }),
      row({ assignmentId: "x", stage: "ai1", model: "x", provider: "abcllm" })]);
    expect(ordered.map(entry => entry.assignmentId)).toEqual(["a", "c", "b"]);
  });
  it("never serves ai1 or ai2 rows (PR C1 — the review stages read task ranks)", () => {
    expect(stageTableRows("ai1", [row({ stage: "ai1", model: "a", provider: "abcllm" }), row({ stage: "ai1", model: "s", provider: "claude-cli" })])).toEqual([]);
    expect(stageTableRows("ai2", [row({ stage: "ai2", model: "v", provider: "local-direct", vote: true }),
      row({ stage: "ai2", model: "f", provider: "abcllm", rank: 2 })])).toEqual([]);
  });
});

describe("snapshot gate", () => {
  it("returns no rows while off; with the switch on (toggle or override) it serves the pinned snapshot per stage", () => {
    setStageAssignmentsForTest([row({ stage: "reason", model: "[supa] q", provider: "abcllm" }), row({ stage: "ai1", model: "[supa] q", provider: "abcllm" })]);
    expect(assignmentSource("reason")).toBe("legacy");
    expect(stageAssignmentRows("reason")).toBeNull();
    setRuntimeSettingsForTest(TOGGLE_ON);                                                          // the saved toggle, no env
    expect(assignmentSource("reason")).toBe("table");
    expect(assignmentSource("tagline")).toBe("legacy_empty_table");
    expect(stageAssignmentRows("reason")?.map(entry => entry.model)).toEqual(["[supa] q"]);
    expect(stageAssignmentRows("tagline")).toBeNull();
    // PR C1: 켜져 있어도 1차·2차는 표를 내지 않는다
    expect(assignmentSource("ai1")).toBe("legacy_empty_table");
    expect(stageAssignmentRows("ai1")).toBeNull();
    expect(stageAssignmentRows("ai2")).toBeNull();
    setRuntimeSettingsForTest(TOGGLE_OFF);
    expect(assignmentSource("reason")).toBe("legacy");
    setAssignmentTableEnabledForTest(true);
    expect(assignmentSource("reason")).toBe("table");
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

// PR C1: 1차 배정 표 읽기(tableFirstReviewers·selectTableFirstReviewer·firstReviewTableRows)는 없앴다 — 표가 켜져 있고 ai1 행이 있어도 1차 풀은 「작업 ↔ 모델」 순위다.
// 순위 고르기 자체는 tests/first-reviewers.test.ts, 묶기는 tests/review-task-ranks.test.ts 가 본다.
describe("AI1 reviewers ignore the table", () => {
  it("serves the rank pool whether the table is on or off and never the table or firstReview/firstReviewAdditional", () => {
    const ranked = { provider: "abcllm" as const, model: "ranked-first" };
    const table = [row({ stage: "ai1", model: "[supa] Qwen", provider: "abcllm" }), row({ stage: "ai1", model: "grok-4.7", provider: "grok-cli", rank: 2 })];
    pinReviewRanks({ first: [ranked] });
    setStageAssignmentsForTest(table);
    expect(firstReviewers(poolSettings)).toEqual([ranked]);
    setAssignmentTableEnabledForTest(true);
    expect(firstReviewers(poolSettings)).toEqual([ranked]);
    expect(firstReviewers({ firstReview: legacyFirst })).toEqual([ranked]);
    expect(hasFirstReviewer(firstReviewers(poolSettings), { provider: "grok-cli", model: "grok-4.7" })).toBe(false);
    expect(hasFirstReviewer(firstReviewers(poolSettings), legacyFirst)).toBe(false);
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

  // PR C1: 2차 배정 표 읽기(tableSecondReviewVoters)는 없앴다 — 투표자·대체는 「작업 ↔ 모델」의 투표자 칸 순위다(표·설정 배열을 읽지 않는다)
  it("every reader follows the voter-slot ranks, never the table or the settings arrays", () => {
    pinReviewRanks({ second: [[{ provider: "local-direct", model: "deep-1" }, { provider: "abcllm", model: "backup" }]] });
    setStageAssignmentsForTest([v1, v2, f2, f1, idle, dup, cli]);
    for (const enabled of [false, true]) {
      setAssignmentTableEnabledForTest(enabled);
      expect(secondReviewVoterSets(settings)).toEqual({ source: "ranks", voters: [{ provider: "local-direct", model: "deep-1" }],
        fallbacks: [{ provider: "abcllm", model: "backup" }] });
      expect(secondReviewVoters(settings)).not.toBe(settings.secondReview.voters);
      expect(secondReviewFallbacks(settings)).toEqual([{ provider: "abcllm", model: "backup" }]);
    }
    for (const value of secondReviewVoters(settings)) expect(Object.keys(value).sort()).toEqual(["model", "provider"]);
    // 순위가 없으면 빈 목록이다 — 설정의 voters·fallbacks 로 대신 채우지 않는다
    pinReviewRanks({});
    expect(secondReviewVoterSets(settings)).toEqual({ source: "ranks", voters: [], fallbacks: [] });
  });

  it("accepts a ranked voter and its same-slot fallback in input validation, refuses the settings-only voter, and keeps the AI2 policy hash", () => {
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
    // 1차 1순위 = first-model. 2차 칸 1 = second-model 하나면 그 투표자만 맞다
    pinReviewRanks({ first: [{ provider: "abcllm", model: "first-model" }], second: [[{ provider: "abcllm", model: "second-model" }]] });
    expect(secondReviewInputMatches(vote("second-model", "abcllm"), current, now)).toBe(true);
    expect(secondReviewInputMatches(vote("deep-1", "local-direct"), current, now)).toBe(false);
    // 순위를 바꾸면(칸 1 = deep-1 → backup) 설정에만 남은 second-model 은 더 이상 맞지 않는다 — 켜진 배정 표의 투표 행(v2)도 보지 않는다
    setStageAssignmentsForTest([v2]);
    setAssignmentTableEnabledForTest(true);
    pinReviewRanks({ first: [{ provider: "abcllm", model: "first-model" }],
      second: [[{ provider: "local-direct", model: "deep-1" }, { provider: "abcllm", model: "backup" }]] });
    expect(secondReviewInputMatches(vote("deep-1", "local-direct"), current, now)).toBe(true);
    expect(secondReviewInputMatches(vote("[supa] Qwen", "abcllm"), current, now)).toBe(false);
    expect(secondReviewInputMatches(vote("second-model", "abcllm"), current, now)).toBe(false);
    const root = vote("deep-1", "local-direct", { status: "resolved", resolution: "fallback", failureCount: 1 });
    expect(secondReviewInputMatches(vote("backup", "abcllm", { id: 202, fallbackForId: 201, failureCount: 1 }), { ...current, root }, now)).toBe(true);
    expect(secondReviewInputMatches(vote("[MLX] gpt", "abcllm", { id: 202, fallbackForId: 201, failureCount: 1 }), { ...current, root }, now)).toBe(false);
    expect(secondReviewPolicyHash(crawl)).toBe(hash);
  });
});

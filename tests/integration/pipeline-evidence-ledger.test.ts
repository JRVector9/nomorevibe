import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { crawlDocuments, jobs, secondReviews } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { changeReviewMode, getSettings, saveSettings } from "@/lib/crawl/settings";
import { claimAgentReview, loadReviewInput, recordAgentReview } from "@/lib/crawl/agent-review-repository";
import { candidateRevisionHash, overrideCandidate } from "@/lib/crawl/admin-review";
import { collectLiveCapacityWindow } from "@/lib/operations/pipeline-capacity-live-repository";
import { reportLiveCapacityWindow } from "@/lib/operations/pipeline-capacity-live";
import { recordAi2Attempt, recordHumanDecisionOverride, recordLateWriteRefused, recordLeaseViolation,
  startEvidenceRecorder } from "@/lib/operations/pipeline-evidence-ledger";
import { enqueueSecondReviewsFixture, recordSecondReviewFixture } from "./second-review-receipt-fixtures";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// 기록 시작 marker는 지울 수 없다. 공유 test DB에 남기면 다른 파일의 전체 DB 비교가 깨지므로 이 파일만의 DB를 만든다.
const root = fileURLToPath(new URL("../..", import.meta.url));
const name = `nomorevibe_test_pr01b8_${randomBytes(6).toString("hex")}`;
const url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
let client: postgres.Sql | undefined, created = false;
const owner = { name: "crawl-agent-review", token: "pr01b8-ledger-owner", requestedVersion: 1 };
const outcome = { reason: "A usable product", evidenceIds: ["product"], confidence: .95 };
const events = async () => [...await client!`SELECT kind, stage, candidate_id, first_attempt_id, second_review_id, root_review_id, failed, code
  FROM pipeline_evidence_events WHERE kind <> 'recorder_started' ORDER BY id`];

beforeAll(async () => {
  ensureSchema();
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${name}`); created = true; } finally { await admin.end({ timeout: 5 }); }
  client = postgres(url.toString(), { max: 4, onnotice: () => {} });
  await client.unsafe("set statement_timeout = 0");
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  const g = globalThis as { db?: unknown; pgClient?: unknown }; g.pgClient = client; g.db = drizzle(client, { schema });
}, 600_000);
afterAll(async () => {
  const g = globalThis as { db?: unknown; pgClient?: unknown }; delete g.db; delete g.pgClient;
  await client?.end({ timeout: 5 });
  if (!created) return;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);
beforeEach(() => {
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  vi.stubEnv("CRAWL_REVIEW_MODEL", "first-fixture");
});

async function configure() {
  await saveSettings({ enabled: true, firstReview: { provider: "claude-cli", model: "first-fixture" }, secondReview: {
    enabled: true, voters: [{ provider: "abcllm", model: "second-a" }], fallbacks: [{ provider: "abcllm", model: "backup" }], sampleRate: 0,
  } }, "test");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "evidence ledger fixture" })).toMatchObject({ ok: true });
  await db.execute(sql`update crawl_settings set updated_at = (now() at time zone 'utc') - interval '2 hours'`);
  await db.execute(sql`update pipeline_stage_modes set updated_at = clock_timestamp() - interval '2 days'`);
  await db.execute(sql`update model_capacity_control set updated_at = clock_timestamp() - interval '2 days'`);
}
/** 실제 판정·claim 경로로 실행 중인 legacy AI1 세대 하나를 만든다. */
async function claim(repo: string) {
  const settings = await getSettings();
  await crawl.putDocument({ repo, productUrl: `https://${repo.replace("/", "-")}.example`, pageStatus: 200,
    repoMeta: { description: "A useful product" }, pageMeta: { title: repo, description: "A useful product" } });
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 2000) }).where(eq(crawlDocuments.repo, repo));
  const document = (await crawl.getDocument(repo))!;
  await crawl.recordAutomaticJudgement({ candidate: undefined, document, settings, verdict: { state: "approved", reason: "passed", signals: {} } });
  const candidate = (await crawl.getCandidate(repo))!;
  await db.insert(jobs).values({ name: owner.name, leaseToken: owner.token, lockedAt: new Date(), requestedVersion: 1 })
    .onConflictDoUpdate({ target: jobs.name, set: { leaseToken: owner.token, lockedAt: new Date() } });
  const context = { candidate, document, settings, lease: owner, provider: "claude-cli", model: "first-fixture",
    input: await loadReviewInput(candidate, document, settings) };
  const claimed = await claimAgentReview(context);
  if (claimed.kind === "skipped") throw new Error(claimed.reason);
  return { ...context, receipt: claimed.receipt, attempt: claimed.attempt };
}
async function collect(startedAt: string, endedAt: string) {
  return collectLiveCapacityWindow(db, { runId: "ledger", revision: "9e13341", target: "primary", startedAt, endedAt });
}
async function lastMinutes(minutes: number, endShift = 0) {
  await new Promise(resolve => setTimeout(resolve, 20));
  const [row] = [...await db.execute(sql`select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`)] as { now: string }[];
  const end = Date.parse(row.now) - endShift;
  return [new Date(end - minutes * 60_000).toISOString(), new Date(end).toISOString()] as const;
}

it("applies 0097 as an append-only table that records nothing before the recorder marker", async () => {
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  expect(journal.entries.map(entry => entry.tag)).toContain("0097_pipeline_evidence_history");
  const [applied] = await client!`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  await expect(client!`UPDATE pipeline_evidence_events SET code = 'x'`).rejects.toMatchObject({ code: "55000" });
  await expect(client!`DELETE FROM pipeline_evidence_events`).rejects.toMatchObject({ code: "55000" });
  await expect(client!`TRUNCATE pipeline_evidence_events`).rejects.toMatchObject({ code: "55000" });
  await configure();
  await db.transaction(tx => recordAi2Attempt(tx, { stage: "ai2", secondReviewId: 1 }, { rootReviewId: 1, failed: true, code: "timeout" }));
  await recordLateWriteRefused({ stage: "ai1", firstAttemptId: 1 }, new Error("item_lease_lost"));
  expect(await events()).toEqual([]);
  const artifact = await collect(...await lastMinutes(40));
  expect(artifact.ledger).toBeNull();
  expect(artifact.safety).toEqual({ duplicatePublications: 0, humanDecisionOverrides: "unverified", leaseViolations: "unverified" });
});

it("keeps one recorder marker with a checked revision", async () => {
  // 두 시간 전에 운영자가 남긴 marker를 흉내 낸다(구간이 marker 뒤에 오려면 30분 이상 앞서야 한다).
  await client!`INSERT INTO pipeline_evidence_events (kind, revision, operator, created_at)
    VALUES ('recorder_started', '9e13341', 'pr01b8-root', clock_timestamp() - interval '2 hours')`;
  const [marker] = await client!`SELECT to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
    FROM pipeline_evidence_events WHERE kind = 'recorder_started'`;
  expect(await startEvidenceRecorder(db, { revision: "abcdef0", operator: "second" })).toEqual({ startedAt: marker.at });
  const [count] = await client!`SELECT count(*)::int AS count FROM pipeline_evidence_events WHERE kind = 'recorder_started'`;
  expect(count.count).toBe(1);
  await expect(client!`INSERT INTO pipeline_evidence_events (kind, revision, operator) VALUES ('recorder_started', 'not-a-sha', 'x')`)
    .rejects.toMatchObject({ code: "23514" });
});

it("records real AI1/AI2 refusals and AI2 calls, and the collector verifies zero violations only after the marker", async () => {
  // AI1 승인 → 필수 AI2 칸이 실패해 대체 모델로 넘어가고 대체 모델이 승인한다(호출 2, 실패 1, 사슬 1).
  const approved = await claim("ledger/app");
  expect(await recordAgentReview({ ...approved, outcome: { ...outcome, decision: "approve" } })).toMatchObject({ applied: true });
  await enqueueSecondReviewsFixture(await getSettings());
  const [rootVote] = await db.select().from(secondReviews).orderBy(asc(secondReviews.id));
  await recordSecondReviewFixture(rootVote.id, { ok: false, error: "timeout", model: rootVote.model!, provider: rootVote.provider! });
  const backup = (await db.select().from(secondReviews)).find(row => row.fallbackForId === rootVote.id)!;
  await recordSecondReviewFixture(backup.id, { ok: true, decision: "approve", confidence: .95, reason: "Verified product",
    model: backup.model!, provider: backup.provider!, status: "agreed" });

  // 관리자가 실행 중인 AI1 세대를 덮어 결정하면, 늦게 도착한 자동 결과는 반영되지 않고 거부가 남는다.
  const human = await claim("ledger/human");
  const input = await loadReviewInput(human.candidate, human.document, human.settings);
  expect(await overrideCandidate({ repo: human.candidate.repo, actor: "pr01b8-admin", reason: "Not a product", inputHash: input.inputHash,
    sourceRevisionHash: input.sourceRevisionHash, candidateRevisionHash: candidateRevisionHash(human.candidate),
    decision: "reject", reasonCode: "not_a_product" })).toMatchObject({ ok: true });
  expect(await recordAgentReview({ ...human, outcome: { ...outcome, decision: "approve" } })).toEqual({ applied: false, state: "superseded" });

  // 작업 lease를 다른 실행이 가져간 뒤의 늦은 저장은 되감기고, 거부 이력만 별도 문장으로 남는다.
  const late = await claim("ledger/late");
  await db.update(jobs).set({ leaseToken: "pr01b8-new-owner" }).where(eq(jobs.name, owner.name));
  await expect(recordAgentReview({ ...late, outcome: { ...outcome, decision: "approve" } })).rejects.toThrow("job_lease_lost");
  await db.update(jobs).set({ leaseToken: owner.token, lockedAt: new Date() }).where(eq(jobs.name, owner.name));

  expect(await events()).toEqual([
    { kind: "ai2_attempt", stage: "ai2", candidate_id: approved.candidate.id, first_attempt_id: approved.attempt.id,
      second_review_id: rootVote.id, root_review_id: rootVote.id, failed: true, code: "timeout" },
    { kind: "ai2_attempt", stage: "ai2", candidate_id: approved.candidate.id, first_attempt_id: approved.attempt.id,
      second_review_id: backup.id, root_review_id: rootVote.id, failed: false, code: null },
    { kind: "human_decision_refused", stage: "ai1", candidate_id: human.candidate.id, first_attempt_id: human.attempt.id,
      second_review_id: null, root_review_id: null, failed: null, code: null },
    { kind: "late_write_refused", stage: "ai1", candidate_id: late.candidate.id, first_attempt_id: late.attempt.id,
      second_review_id: null, root_review_id: null, failed: null, code: "job_lease_lost" },
  ]);
  const [marker] = await client!`SELECT to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
    FROM pipeline_evidence_events WHERE kind = 'recorder_started'`;
  const covered = await collect(...await lastMinutes(40));
  expect(covered.ledger).toEqual({ startedAt: marker.at, humanDecisionRefusals: 1, lateWritesRefused: 1 });
  expect(covered.safety).toEqual({ duplicatePublications: 0, humanDecisionOverrides: 0, leaseViolations: 0 });
  expect(covered.ai2Calls).toEqual({ chains: 1, calls: 2, failed: 1, unattributedChains: 0 });
  expect(reportLiveCapacityWindow(covered).safety).toMatchObject({ humanDecisionOverrides: { status: "verified", count: 0 },
    leaseViolations: { status: "verified", count: 0 } });
  // marker보다 먼저 시작한 구간은 기록이 시작되기 전을 포함하므로 미검증으로 남는다.
  const before = await collect(...await lastMinutes(120, 60 * 60_000));
  expect(before.ledger).toBeNull();
  expect(reportLiveCapacityWindow(before).safety.leaseViolations).toEqual({ status: "unverified" });
});

it("counts violations computed from DB state at the write site in the same transaction", async () => {
  const human = (await db.select().from(schema.crawlCandidates).where(eq(schema.crawlCandidates.repo, "ledger/human")))[0];
  const automatic = (await db.select().from(schema.crawlCandidates).where(eq(schema.crawlCandidates.repo, "ledger/app")))[0];
  const floor = (await events()).length;
  await db.transaction(async tx => {
    await recordLeaseViolation(tx, { stage: "ai1", firstAttemptId: 7 }, { kind: "job", name: owner.name, token: owner.token });
    await recordLeaseViolation(tx, { stage: "ai1", firstAttemptId: 7 }, { kind: "job", name: owner.name, token: "pr01b8-stale-owner" });
    await recordLeaseViolation(tx, { stage: "ai2", secondReviewId: 9 }, { kind: "item", stage: "ai2", workKey: "ai2:9", token: randomUUID() });
    await recordHumanDecisionOverride(tx, { stage: "ai1", candidateId: automatic.id, firstAttemptId: 7 });
    await recordHumanDecisionOverride(tx, { stage: "ai1", candidateId: human.id, firstAttemptId: 7 });
    // 공급자 오류 문자열이 비어도 결과 트랜잭션을 깨지 않는다.
    await recordAi2Attempt(tx, { stage: "ai2", secondReviewId: 9 }, { rootReviewId: 9, failed: true, code: "  " });
  });
  expect((await events()).slice(floor).map(row => [row.kind, row.code, row.candidate_id])).toEqual([
    ["lease_violation", "job", null], ["lease_violation", "item", null], ["human_decision_overridden", null, human.id], ["ai2_attempt", null, null]]);
  const detected = await collect(...await lastMinutes(40));
  expect(detected.safety).toEqual({ duplicatePublications: 0, humanDecisionOverrides: 1, leaseViolations: 2 });
  expect(reportLiveCapacityWindow(detected).safety).toMatchObject({ humanDecisionOverrides: { status: "verified", count: 1 },
    leaseViolations: { status: "verified", count: 2 } });
});

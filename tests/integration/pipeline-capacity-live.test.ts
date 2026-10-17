import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, secondReviews } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { changeReviewMode, getSettings, saveSettings } from "@/lib/crawl/settings";
import { claimAgentReview, loadReviewInput, recordAgentReview } from "@/lib/crawl/agent-review-repository";
import { reviewPolicyHash } from "@/lib/crawl/agent-review-contract";
import { collectLiveCapacityWindow, type LiveCapacityOptions } from "@/lib/operations/pipeline-capacity-live-repository";
import { reportLiveCapacityWindow } from "@/lib/operations/pipeline-capacity-live";
import { closeSettledSecondReviewsFixture, enqueueSecondReviewsFixture, recordSecondReviewFixture } from "./second-review-receipt-fixtures";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";

const READER = "nomorevibe_capacity_live_reader";
beforeAll(ensureSchema);
beforeEach(async () => {
  for (const table of [secondReviews, crawlReviewAttempts, crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, jobs]) await db.delete(table);
  await resetTables();
  // 구간 시작 전부터 단계·모델 슬롯 모드가 그대로였다는 전제(마이그레이션 시각만 과거로 옮긴다).
  await db.execute(sql`update pipeline_stage_modes set updated_at = clock_timestamp() - interval '2 days'`);
  await db.execute(sql`update model_capacity_control set updated_at = clock_timestamp() - interval '2 days'`);
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  vi.stubEnv("CRAWL_REVIEW_MODEL", "first-fixture");
});
afterAll(async () => {
  await db.execute(sql.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READER}') THEN
    EXECUTE 'DROP OWNED BY ${READER}'; EXECUTE 'DROP ROLE ${READER}'; END IF; END $$`));
});
const outcome = { reason: "A usable product", evidenceIds: ["product"], confidence: .95 };
async function configure(voters: string[], { backdate = true } = {}) {
  await saveSettings({ enabled: true, firstReview: { provider: "claude-cli", model: "first-fixture" }, secondReview: {
    enabled: true, voters: voters.map(model => ({ provider: "abcllm" as const, model })),
    fallbacks: [{ provider: "abcllm", model: "backup" }], sampleRate: 0,
  } }, "test");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "live capacity fixture" })).toMatchObject({ ok: true });
  if (backdate) await db.execute(sql`update crawl_settings set updated_at = (now() at time zone 'utc') - interval '2 hours'`);
  return getSettings();
}
async function candidateFor(repo: string, settings: Awaited<ReturnType<typeof getSettings>>) {
  await crawl.putDocument({ repo, productUrl: `https://${repo.replace("/", "-")}.example`, pageStatus: 200,
    repoMeta: { description: "A useful product" }, pageMeta: { title: repo, description: "A useful product" } });
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 2000) }).where(eq(crawlDocuments.repo, repo));
  const document = (await crawl.getDocument(repo))!;
  await crawl.recordAutomaticJudgement({ candidate: undefined, document, settings, verdict: { state: "approved", reason: "passed", signals: {} } });
  return { document, candidate: (await crawl.getCandidate(repo))! };
}
/** 실제 claim/record 경로로 AI1 세대 하나를 남긴다. */
async function review(repo: string, settings: Awaited<ReturnType<typeof getSettings>>,
  result: { decision?: "approve" | "reject"; error?: string } = { decision: "approve" }) {
  const { document, candidate } = await candidateFor(repo, settings);
  const lease = { name: "crawl-agent-review", token: "live-capacity-owner", requestedVersion: 1 };
  await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: new Date(), requestedVersion: 1 })
    .onConflictDoUpdate({ target: jobs.name, set: { leaseToken: lease.token, lockedAt: new Date() } });
  const context = { candidate, document, settings, lease, provider: "claude-cli", model: "first-fixture",
    input: await loadReviewInput(candidate, document, settings) };
  const claim = await claimAgentReview(context);
  if (claim.kind === "skipped") throw new Error(claim.reason);
  await recordAgentReview({ ...context, receipt: claim.receipt,
    ...(result.error ? { error: result.error } : { outcome: { ...outcome, decision: result.decision ?? "approve" } }) });
  return { candidate, attempt: claim.attempt };
}
/** 구간 시작 전부터 준비 대기였고 아직 아무도 집지 않은 후보. */
async function witness(settings: Awaited<ReturnType<typeof getSettings>>) {
  const { candidate } = await candidateFor("live/waiting", settings);
  await db.execute(sql`update crawl_documents set fetched_at = (now() at time zone 'utc') - interval '2 hours' where repo = 'live/waiting'`);
  await db.execute(sql`update crawl_candidates set updated_at = (now() at time zone 'utc') - interval '2 hours',
    judged_at = (now() at time zone 'utc') - interval '2 hours' where id = ${candidate.id}`);
  return candidate.id;
}
async function approveVote(id: number) {
  const [row] = await db.select().from(secondReviews).where(eq(secondReviews.id, id));
  await recordSecondReviewFixture(id, { ok: true, decision: "approve", confidence: .95, reason: "Verified product",
    model: row.model!, provider: row.provider!, status: "agreed" });
}
/** 구간 끝은 DB 시계 기준 현재다. 운영 시각 열과 같은 UTC 벽시계에서 잰다. */
async function window(minutes = 40, endShiftMs = 0): Promise<Pick<LiveCapacityOptions, "startedAt" | "endedAt">> {
  await new Promise(resolve => setTimeout(resolve, 20));
  const [row] = [...await db.execute(sql`select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`)] as { now: string }[];
  const end = Date.parse(row.now) + endShiftMs;
  return { startedAt: new Date(end - minutes * 60_000).toISOString(), endedAt: new Date(end).toISOString() };
}
const collect = async (range: Pick<LiveCapacityOptions, "startedAt" | "endedAt">, target: "primary" | "replica" = "primary", database = db) =>
  collectLiveCapacityWindow(database, { runId: "live-test", revision: "9e13341", target, ...range });
async function rows() {
  return JSON.stringify([await db.select().from(crawlReviewAttempts).orderBy(asc(crawlReviewAttempts.id)),
    await db.select().from(secondReviews).orderBy(asc(secondReviews.id)), await db.select().from(crawlCandidates).orderBy(asc(crawlCandidates.id)),
    await db.select().from(crawlSettings), await db.select().from(jobs)]);
}

it("collects one required-AI2 approval from real rows in a read-only snapshot without writing", async () => {
  const settings = await configure(["second-a", "second-b"]);
  const waiting = await witness(settings);
  const f = await review("live/app", settings);
  await enqueueSecondReviewsFixture(settings);
  const votes = await db.select().from(secondReviews).orderBy(asc(secondReviews.id));
  expect(votes).toHaveLength(2);
  for (const vote of votes) await approveVote(vote.id);
  const before = await rows();
  const artifact = await collect(await window());
  expect(await rows()).toBe(before);
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: unknown[] };
  expect(artifact.schema).toEqual({ appliedMigrations: journal.entries.length, absentTables: [] });
  expect(artifact.database).toEqual({ target: "primary", inRecovery: false, readOnly: true, isolation: "repeatable read",
    replicaCaughtUp: null, writeXidAssigned: false });
  expect(artifact.identity).toMatchObject({ reviewMode: "enforce", secondGateRequired: true, inputPolicyHash: reviewPolicyHash(settings),
    models: { first: { provider: "claude-cli", model: "first-fixture", canonicalModel: "first-fixture" } } });
  expect(artifact.attempts).toHaveLength(1);
  expect(artifact.attempts[0]).toMatchObject({ id: f.attempt.id, state: "succeeded", decision: "approve", reReview: false });
  expect(artifact.votes).toHaveLength(2);
  expect(artifact.readiness).toEqual({ witnesses: 1, sampleCandidateIds: [waiting] });
  expect(artifact.ai2Calls).toEqual({ chains: 2, calls: 2, failed: 0, unattributedChains: 0 });
  const report = reportLiveCapacityWindow(artifact);
  expect(report.evidenceIssues).toEqual([]);
  expect(report.finals).toMatchObject({ newCandidates: 1, approvals: 1, repeatGenerations: 0 });
  // SQL이 잰 경과: 준비→최종이 AI1 끝→AI2 관문보다 길고, 9시간 시간대 오차가 없다.
  expect(report.latencyMs.endToEnd.p95!).toBeGreaterThanOrEqual(report.latencyMs.ai2Gate.p95!);
  expect(report.latencyMs.endToEnd.p95!).toBeLessThan(600_000);
  expect(artifact.attempts[0].completedMs!).toBeGreaterThan(30 * 60_000);
});

it("counts an AI2 fallback chain once for completion and fully for technical calls", async () => {
  const settings = await configure(["second-a"]);
  await witness(settings);
  await review("live/app", settings);
  await enqueueSecondReviewsFixture(settings);
  const [root] = await db.select().from(secondReviews);
  await recordSecondReviewFixture(root.id, { ok: false, error: "timeout", model: root.model!, provider: root.provider! });
  const backup = (await db.select().from(secondReviews)).find(row => row.fallbackForId === root.id)!;
  await approveVote(backup.id);
  const artifact = await collect(await window());
  expect(artifact.ai2Calls).toEqual({ chains: 1, calls: 2, failed: 1, unattributedChains: 0 });
  const report = reportLiveCapacityWindow(artifact);
  expect(report.finals.newCandidates).toBe(1);
  expect(report.calls).toMatchObject({ total: 3, failed: 1 });
});

it("finalizes AI1 rejections and separates technical failures from cancellations", async () => {
  const settings = await configure(["second-a"]);
  await witness(settings);
  await review("live/rejected", settings, { decision: "reject" });
  await review("live/failed", settings, { error: "timeout" });
  await review("live/cancelled", settings, { error: "cancelled" });
  const report = reportLiveCapacityWindow(await collect(await window()));
  expect(report.finals).toMatchObject({ newCandidates: 1, rejections: 1 });
  expect(report.calls.ai1).toEqual({ calls: 2, failed: 1, cancelled: 1 });
});

it("keeps a counted final after publication cleanup closes its gate rows", async () => {
  const settings = await configure(["second-a"]);
  await witness(settings);
  const f = await review("live/app", settings);
  await enqueueSecondReviewsFixture(settings);
  const [vote] = await db.select().from(secondReviews);
  await approveVote(vote.id);
  await db.update(crawlCandidates).set({ state: "published", publishedSlug: "live-app" }).where(eq(crawlCandidates.id, f.candidate.id));
  await closeSettledSecondReviewsFixture();
  const [closed] = await db.select().from(secondReviews);
  expect(closed).toMatchObject({ status: "resolved", resolution: "decided_elsewhere" });
  expect(reportLiveCapacityWindow(await collect(await window())).finals.newCandidates).toBe(1);
});

it("reports missing witnesses and settings changes, and refuses wrong targets or unfinished windows", async () => {
  const settings = await configure(["second-a"], { backdate: false });
  await review("live/rejected", settings, { decision: "reject" });
  const range = await window();
  expect(reportLiveCapacityWindow(await collect(range)).evidenceIssues)
    .toEqual(["settings_changed_since_window_start", "readiness_unproven"]);
  await expect(collect(range, "replica")).rejects.toThrow("live_target_mismatch");
  await expect(collect(await window(40, 60_000))).rejects.toThrow("live_window_not_finished");
  await expect(collect(await window(29))).rejects.toThrow("live_window_invalid");
});

it("succeeds under a SELECT-only database role, proving the collector issues no writes", async () => {
  const settings = await configure(["second-a"]);
  await witness(settings);
  await review("live/rejected", settings, { decision: "reject" });
  await db.execute(sql.raw(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READER}') THEN
    CREATE ROLE ${READER} LOGIN PASSWORD 'reader'; END IF; END $$`));
  await db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${READER}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READER}`));
  const url = new URL(TEST_DATABASE_URL); url.username = READER; url.password = "reader";
  const client = postgres(url.toString(), { max: 1 });
  try {
    const reader = drizzle(client, { schema });
    await expect(reader.execute(sql`insert into jobs (name) values ('live-capacity-write-probe')`)).rejects.toThrow();
    const range = await window();
    const [asReader, asOwner] = [await collect(range, "primary", reader), await collect(range)];
    expect(asReader.attempts).toEqual(asOwner.attempts);
    // 마이그레이션 장부를 읽을 권한이 없으면 오류 대신 미상(null)으로 남긴다.
    expect([asReader.schema.appliedMigrations, asOwner.schema.appliedMigrations === null]).toEqual([null, false]);
    expect(reportLiveCapacityWindow(asReader).finals.newCandidates).toBe(1);
  } finally { await client.end({ timeout: 5 }); }
});

it("runs the collect CLI against an explicit database URL and writes a private artifact", async () => {
  await configure(["second-a"]);
  const directory = mkdtempSync(join(tmpdir(), "nomorevibe-capacity-live-collect-"));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|DATABASE_URL$|READ_DATABASE_URL$)/.test(key)));
    const start = new Date(Date.now() - 3_600_000).toISOString(), end = new Date(Date.now() - 60_000).toISOString();
    const output = join(directory, "live.json");
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/pipeline-capacity-live.ts", ...args],
      { encoding: "utf8", env: { ...env, NODE_ENV: "test", LIVE_CAPACITY_DATABASE_URL: TEST_DATABASE_URL }, timeout: 20_000 });
    const collected = run("collect", "cli-run", start, end, "primary", output);
    expect(collected.stderr).toBe("");
    expect(collected.status).toBe(0);
    expect(JSON.parse(collected.stdout)).toMatchObject({ collected: true, target: "primary" });
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ scope: "live_window", runId: "cli-run", budget: { status: "unverified" } });
    expect(run("collect", "cli-run", start, end, "replica", join(directory, "replica.json")).stderr.trim()).toBe("live_target_mismatch");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("collects a generation finished before the window once its required AI2 vote lands inside it, and records the source database (F1)", async () => {
  const settings = await configure(["second-a"]);
  await witness(settings);
  // 구간(40분) 시작 전에 끝난 AI1 승인 — 구간 안의 AI2 승인으로만 관련 세대가 된다(합집합의 두 번째 범위).
  const early = await review("live/early", settings);
  const ago = (minutes: number) => sql`to_char((now() at time zone 'utc') - ${minutes} * interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  await db.execute(sql`update crawl_review_attempts set started_at = (now() at time zone 'utc') - interval '50 minutes',
    completed_at = (now() at time zone 'utc') - interval '49 minutes',
    source = (source - 'scanCompletedAt') || jsonb_build_object('documentFetchedAt', ${ago(52)}, 'candidateJudgedAt', ${ago(51)})
    where id = ${early.attempt.id}`);
  const inside = await review("live/inside", settings, { decision: "reject" });
  await enqueueSecondReviewsFixture(settings);
  const votes = await db.select().from(secondReviews).orderBy(asc(secondReviews.id));
  expect(votes.map(row => row.firstAttemptId)).toEqual([early.attempt.id]);
  for (const vote of votes) await approveVote(vote.id);
  const artifact = await collect(await window());
  expect(artifact.attempts.map(row => row.id)).toEqual([early.attempt.id, inside.attempt.id].sort((a, b) => a - b));
  expect(artifact.votes.map(row => row.id)).toEqual(votes.map(row => row.id));
  expect(artifact.candidates.map(row => row.id)).toEqual([early.candidate.id, inside.candidate.id].sort((a, b) => a - b));
  expect(reportLiveCapacityWindow(artifact).finals).toMatchObject({ newCandidates: 2, approvals: 1, rejections: 1 });
  const [identity] = [...await db.execute(sql`select (select system_identifier::text from pg_control_system()) as system_identifier,
    (select oid::text from pg_database where datname = current_database()) as database_oid, current_database() as database_name`)] as Record<string, string>[];
  expect(artifact.source).toEqual({ kind: "live", database: { systemIdentifier: identity.system_identifier, databaseOid: identity.database_oid,
    databaseName: identity.database_name } });
});

it("records the same source identity under a SELECT-only role (F1)", async () => {
  const settings = await configure(["second-a"]);
  await witness(settings);
  await review("live/rejected", settings, { decision: "reject" });
  await db.execute(sql.raw(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READER}') THEN
    CREATE ROLE ${READER} LOGIN PASSWORD 'reader'; END IF; END $$`));
  await db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${READER}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READER}`));
  const url = new URL(TEST_DATABASE_URL); url.username = READER; url.password = "reader";
  const client = postgres(url.toString(), { max: 1 });
  try {
    const range = await window();
    const [asReader, asOwner] = [await collect(range, "primary", drizzle(client, { schema })), await collect(range)];
    expect(asReader.source).toEqual(asOwner.source);
    expect(asOwner.source?.database).not.toBeNull();
  } finally { await client.end({ timeout: 5 }); }
});

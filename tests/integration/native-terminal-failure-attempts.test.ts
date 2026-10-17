import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, crawlReviewAttempts } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { saveSettings, changeReviewMode, getSettings } from "@/lib/crawl/settings";
import { loadReviewInput, claimAgentReview, recordAgentReview, handOffExhaustedFirstReviews, listReviewCandidates } from "@/lib/crawl/agent-review-repository";
import { ensureSchema } from "./setup";

/**
 * F2 결함 2(AI1): native 게이트웨이 계약 위반(invalid_output + detail invalid_native_terminal)은 별도 errorCode 로 남고 재시도 대기만 정하며
 * MAX_REVIEW_ATTEMPTS·사람 넘김에 세지 않는다. 모델 판정 실패(같은 invalid_output, 다른 detail)와 legacy 기록은 지금 규칙 그대로다.
 * jobs 행은 tests/integration/agent-review-records.test.ts 와 같은 방식으로 원래대로 돌려놓는다.
 */
const managedJobs = ["crawl-agent-review", "crawl-fetch", "crawl-publish", "second-review"];
type RawJob = Record<string, unknown>;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
let originalJobs: RawJob[] | undefined, preparedJobs: RawJob[] = [], jobsPrepared = false;
async function rawJobs(tx: typeof db | Transaction = db): Promise<RawJob[]> {
  const [row] = await tx.execute<{ rows: RawJob[] }>(sql`SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY name),'[]'::jsonb) AS rows FROM jobs j`);
  return row.rows;
}
async function prepareJobs() {
  if (!originalJobs || jobsPrepared) throw new Error("f2_fixture_jobs_not_restored");
  preparedJobs = await db.transaction(async tx => {
    await tx.execute(sql`SELECT name FROM jobs WHERE ${inArray(jobs.name, managedJobs)} ORDER BY name FOR UPDATE`);
    const [active] = await tx.execute<{ live: boolean }>(sql`SELECT EXISTS(SELECT 1 FROM jobs WHERE ${inArray(jobs.name, managedJobs)}
      AND lease_token IS NOT NULL AND locked_at>=clock_timestamp()-interval '90 seconds') AS live`);
    if (active.live) throw new Error("f2_fixture_foreign_job_owner");
    expect(await rawJobs(tx)).toEqual(originalJobs);
    const reset = { requestedVersion: 0, processedVersion: 0, nextScheduledAt: null, notBefore: null, leaseToken: null, workerSeenAt: null,
      cursor: null, lockedAt: null, lastRunAt: null, lastSuccessAt: null, lastError: null, runs: 0, updatedAt: sql`now()` };
    for (const name of managedJobs) {
      const original = originalJobs!.find(row => row.name === name);
      const changed = original
        ? await tx.update(jobs).set(reset).where(sql`${jobs.name}=${name} AND to_jsonb(${jobs})=${JSON.stringify(original)}::text::jsonb`).returning({ name: jobs.name })
        : await tx.insert(jobs).values({ name, ...reset }).onConflictDoNothing().returning({ name: jobs.name });
      expect(changed).toHaveLength(1);
    }
    return (await rawJobs(tx)).filter(row => managedJobs.includes(row.name as string));
  });
  jobsPrepared = true;
}
async function restoreJobs() {
  if (!jobsPrepared || !originalJobs) return;
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT name FROM jobs WHERE ${inArray(jobs.name, managedJobs)} ORDER BY name FOR UPDATE`);
    const current = await rawJobs(tx);
    for (const name of managedJobs) {
      const row = current.find(value => value.name === name);
      if (!row || row.runs !== 0 || row.last_run_at !== null || row.lease_token !== null && row.lease_token !== "f2-owner")
        throw new Error("f2_fixture_job_owner_changed");
      const original = originalJobs!.find(value => value.name === name);
      const changed = original
        ? await tx.execute(sql`UPDATE jobs j SET (requested_version,processed_version,next_scheduled_at,not_before,lease_token,
            worker_seen_at,cursor,locked_at,last_run_at,last_success_at,last_error,runs,updated_at)=
            (r.requested_version,r.processed_version,r.next_scheduled_at,r.not_before,r.lease_token,r.worker_seen_at,
            r.cursor,r.locked_at,r.last_run_at,r.last_success_at,r.last_error,r.runs,r.updated_at)
            FROM jsonb_populate_record(NULL::jobs,${JSON.stringify(original)}::text::jsonb) r
            WHERE j.name=${name} AND to_jsonb(j)=${JSON.stringify(row)}::text::jsonb RETURNING j.name`)
        : await tx.execute(sql`DELETE FROM jobs j WHERE name=${name} AND to_jsonb(j)=${JSON.stringify(row)}::text::jsonb RETURNING name`);
      expect(changed).toHaveLength(1);
    }
    expect(await rawJobs(tx)).toEqual(originalJobs);
  });
  jobsPrepared = false; preparedJobs = [];
}
beforeAll(async () => { ensureSchema(); originalJobs = await rawJobs(); });
beforeEach(async () => {
  await prepareJobs();
  await db.delete(crawlReviewAttempts); await db.delete(crawlCandidates); await db.delete(crawlDocuments);
  await db.delete(crawlFrontier); await db.delete(crawlSettings);
});
afterEach(restoreJobs);
afterAll(async () => { await restoreJobs(); });

async function fixture() {
  await saveSettings({ enabled: true }, "test");
  const previous = process.env.CRAWL_REVIEW_READY;
  process.env.CRAWL_REVIEW_READY = "true";
  try { expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "Integration test" })).toMatchObject({ ok: true }); }
  finally { if (previous === undefined) delete process.env.CRAWL_REVIEW_READY; else process.env.CRAWL_REVIEW_READY = previous; }
  await crawl.putDocument({ repo: "owner/f2-contract", productUrl: "https://f2-contract.example", pageStatus: 200,
    repoMeta: { description: "A deployed service" }, pageMeta: { title: "F2 Contract", description: "A deployed service" } });
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 2000) });
  await crawl.recordJudgement({ repo: "owner/f2-contract", productUrl: "https://f2-contract.example", state: "approved", reason: "passed", decidedBy: "auto" });
  const lease = { name: "crawl-agent-review", token: "f2-owner", requestedVersion: 1 };
  const prepared = preparedJobs.find(row => row.name === lease.name);
  if (!prepared) throw new Error("f2_fixture_job_not_prepared");
  const issued = await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: new Date(), requestedVersion: 1 })
    .onConflictDoUpdate({ target: jobs.name, set: { leaseToken: lease.token, lockedAt: new Date(), requestedVersion: 1 },
      setWhere: sql`to_jsonb(${jobs})=${JSON.stringify(prepared)}::text::jsonb` }).returning({ name: jobs.name });
  expect(issued).toHaveLength(1);
  const candidate = (await crawl.getCandidate("owner/f2-contract"))!, document = (await crawl.getDocument(candidate.repo))!;
  await saveSettings({ firstReview: { provider: "abcllm", model: "f2-model" } }, "test");
  const settings = await getSettings();
  return { candidate, document, settings, lease, input: await loadReviewInput(candidate, document, settings), provider: "abcllm", model: "f2-model" };
}

it("native contract violations keep failed attempts with a retry wait but never exhaust or hand off the candidate", async () => {
  const context = await fixture();
  for (let number = 1; number <= 4; number++) {
    const claim = await claimAgentReview(context);
    if (claim.kind === "skipped") throw new Error(claim.reason);
    expect(claim.attempt.attemptNumber).toBe(number);
    await recordAgentReview({ ...context, receipt: claim.receipt, error: "invalid_output", detail: "invalid_native_terminal", retryAfter: new Date(0) });
  }
  expect((await db.select().from(crawlReviewAttempts)).map(row => [row.state, row.errorCode])).toEqual(
    Array.from({ length: 4 }, () => ["failed", "invalid_native_terminal"]));
  expect(await handOffExhaustedFirstReviews(context.settings, context.lease)).toBe(0);
  expect(await crawl.getCandidate(context.candidate.repo)).toMatchObject({ state: "approved", decidedBy: "auto" });
  expect(await listReviewCandidates(context.settings, 20, { readyOnly: true })).toMatchObject([{ id: context.candidate.id }]);
  // 재시도 대기는 그대로 지킨다
  const claim = await claimAgentReview(context);
  if (claim.kind === "skipped") throw new Error(claim.reason);
  expect(claim.attempt.attemptNumber).toBe(5);
  await recordAgentReview({ ...context, receipt: claim.receipt, error: "invalid_output", detail: "invalid_native_terminal",
    retryAfter: new Date(Date.now() + 60_000) });
  expect(await claimAgentReview(context)).toEqual({ kind: "skipped", reason: "retry_wait" });
});

it("judgment failures and every legacy diagnostic still count toward the existing three-attempt hand-off", async () => {
  const context = await fixture();
  // 계약 위반 둘은 세지 않고, 모델 판정 실패 셋은 지금처럼 센다
  for (const detail of ["invalid_native_terminal", "invalid_json", "invalid_native_terminal", "schema_validation", undefined]) {
    const claim = await claimAgentReview(context);
    if (claim.kind === "skipped") throw new Error(claim.reason);
    await recordAgentReview({ ...context, receipt: claim.receipt, error: "invalid_output", detail, retryAfter: new Date(0) });
  }
  expect((await db.select().from(crawlReviewAttempts)).map(row => row.errorCode).sort()).toEqual(
    ["invalid_native_terminal", "invalid_native_terminal", "invalid_output", "invalid_output", "invalid_output"]);
  expect(await claimAgentReview(context)).toEqual({ kind: "skipped", reason: "attempts_exhausted" });
  expect(await handOffExhaustedFirstReviews(context.settings, context.lease)).toBe(1);
  expect(await crawl.getCandidate(context.candidate.repo)).toMatchObject({ state: "needs_review", reason: "ai_review_exhausted" });
});

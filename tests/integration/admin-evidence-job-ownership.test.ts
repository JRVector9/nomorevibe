import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import postgres from "postgres";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, jobs } from "@/lib/db/schema";
import { candidateRevisionHash, requestCandidateEvidence, requeueAfterAdminEvidenceRefresh } from "@/lib/crawl/admin-review";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { getCandidate, putDocument, recordJudgement } from "@/lib/crawl/repository";
import { getSettings, saveSettings } from "@/lib/crawl/settings";
import { requestJob, type JobLease } from "@/lib/jobs/control";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03-admin-evidence-clock-blocker", statement_timeout: 8_000 } });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03-admin-evidence-clock-observer", statement_timeout: 8_000 } });
const prefix = "pr03-admin-evidence-clock/";
const jobNames = ["crawl-fetch", "crawl-judge", "agent-evidence-refresh"];
let originalJobs: (typeof jobs.$inferSelect)[] = [];
let originalSettings: (typeof crawlSettings.$inferSelect)[] = [];
let initialized = false;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("admin_evidence_job_barrier_timeout");
}

beforeAll(async () => {
  ensureSchema();
  originalJobs = await db.select().from(jobs).where(inArray(jobs.name, jobNames));
  originalSettings = await db.select().from(crawlSettings);
  initialized = true;
  await db.delete(jobs).where(inArray(jobs.name, jobNames));
  await saveSettings({ enabled: true, agentEvidence: { enabled: true } }, "pr03-clock-test");
});
afterAll(async () => {
  try {
    if (!initialized) return;
    await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
    await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}%`));
    await db.delete(crawlFrontier).where(like(crawlFrontier.repo, `${prefix}%`));
    await db.delete(jobs).where(inArray(jobs.name, jobNames));
    if (originalJobs.length) await db.insert(jobs).values(originalJobs);
    await db.delete(crawlSettings);
    if (originalSettings.length) await db.insert(crawlSettings).values(originalSettings);
  } finally { await Promise.all([blocker.end({ timeout: 3 }), observer.end({ timeout: 3 })]); }
});

it("rolls evidence consumption and its judge request back when the collector lease expires during an actual job lock wait", async () => {
  const repo = `${prefix}source`;
  await putDocument({ repo, repoMeta: { id: 903070, full_name: repo, private: false, fork: false, archived: false,
    stargazers_count: 3, pushed_at: "2026-10-01T00:00:00.000Z", owner: { type: "User" },
    homepage: "https://pr03-evidence-clock.test", description: "A deployed task tracker" },
    productUrl: "https://pr03-evidence-clock.test", pageStatus: 200,
    pageMeta: { title: "Task tracker", description: "Create and manage projects" } });
  await recordJudgement({ repo, productUrl: "https://pr03-evidence-clock.test",
    state: "needs_review", reason: "ambiguous", decidedBy: "auto" });
  await db.insert(crawlFrontier).values({ repo, signal: "pr03-clock-test", state: "done" });
  await db.update(crawlDocuments).set({ fetchedAt: sql`clock_timestamp() - interval '1 hour'` })
    .where(eq(crawlDocuments.repo, repo));
  const candidate = (await getCandidate(repo))!;
  const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, repo));
  const input = await loadReviewInput(candidate, document, await getSettings());
  expect(await requestCandidateEvidence({ repo, actor: "pr03-clock-test", reason: "Refresh public evidence",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
    candidateRevisionHash: candidateRevisionHash(candidate) })).toMatchObject({ ok: true });
  // Only an actual fresh source row makes this accepted request consumable.
  await db.update(crawlDocuments).set({ fetchedAt: sql`clock_timestamp()` }).where(eq(crawlDocuments.repo, repo));
  await requestJob("crawl-judge");
  const [judgeBefore] = await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"));
  const token = randomUUID();
  const [job] = await db.update(jobs).set({ leaseToken: token, lockedAt: sql`clock_timestamp()` })
    .where(eq(jobs.name, "agent-evidence-refresh")).returning();
  const lease: JobLease = { name: job.name, token, requestedVersion: job.requestedVersion };

  const locked = deferred<number>(), expireFor = deferred<number>(), expired = deferred<void>(), release = deferred<void>();
  const holding = blocker.begin(async tx => {
    const [row] = await tx`SELECT pg_backend_pid() AS pid FROM jobs WHERE name='agent-evidence-refresh' FOR UPDATE`;
    locked.resolve(row.pid);
    const writerPid = await expireFor.promise;
    // xact_start is the writer's exact PostgreSQL now(). Its lease remains
    // healthy at that instant, but expires before the observed wall clock.
    await tx`UPDATE jobs SET locked_at=(SELECT xact_start FROM pg_stat_activity WHERE pid=${writerPid})
      - ${STALE_LOCK_MS} * interval '1 millisecond' + interval '1 millisecond'
      WHERE name='agent-evidence-refresh'`;
    const proof = await waitFor(async () => {
      const [state] = await tx`SELECT locked_at + ${STALE_LOCK_MS} * interval '1 millisecond'
        > (SELECT xact_start FROM pg_stat_activity WHERE pid=${writerPid}) AS healthy_at_start,
        locked_at + ${STALE_LOCK_MS} * interval '1 millisecond' <= clock_timestamp() AS expired_now
        FROM jobs WHERE name='agent-evidence-refresh'`;
      return state.expired_now ? state : undefined;
    });
    expect(proof).toMatchObject({ healthy_at_start: true, expired_now: true });
    expired.resolve();
    await release.promise;
  });
  let writing: Promise<{ value?: boolean; error?: unknown }> | undefined;
  let result: { value?: boolean; error?: unknown };
  try {
    const blockerPid = await Promise.race([locked.promise, holding.then(() => { throw new Error("job_blocker_ended_before_lock"); })]);
    writing = requeueAfterAdminEvidenceRefresh(repo, lease).then(value => ({ value }), error => ({ error }));
    const writerPid = await waitFor(async () => {
      const [waiting] = await observer`SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock'
        AND ${blockerPid} = ANY(pg_blocking_pids(pid)) AND query ILIKE '%jobs%'`;
      return waiting?.pid as number | undefined;
    });
    expireFor.resolve(writerPid);
    await Promise.race([expired.promise, holding.then(() => { throw new Error("job_blocker_ended_before_expiry"); })]);
    release.resolve();
    await holding;
    result = await writing;
  } finally {
    release.resolve();
    // Unblock setup if the actual lock barrier itself failed.
    expireFor.resolve(-1);
    await Promise.allSettled([holding, ...(writing ? [writing] : [])]);
  }
  expect.soft(result.error).toBeInstanceOf(Error);
  expect.soft((result.error as Error | undefined)?.message).toBe("job_lease_lost");
  expect.soft(await getCandidate(repo)).toEqual(candidate);
  expect.soft((await db.select().from(jobs).where(eq(jobs.name, "crawl-judge")))[0]).toEqual(judgeBefore);
  const [sourceAfter] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, repo));
  expect(sourceAfter.fetchedAt).not.toEqual(document.fetchedAt);
});

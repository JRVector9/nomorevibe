import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import postgres from "postgres";
import { eq, like, sql } from "drizzle-orm";

const http = vi.hoisted(() => ({ repo: vi.fn(), page: vi.fn() }));
vi.mock("@/lib/crawl/github", () => ({ getRepo: http.repo }));
vi.mock("@/lib/net/fetch", () => ({ fetchPage: http.page,
  safeFetch: vi.fn().mockResolvedValue(null), readBodyCapped: vi.fn() }));

import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, jobs } from "@/lib/db/schema";
import { fetchCrawlDocuments } from "@/lib/crawl/jobs/fetch";
import { runJob } from "@/lib/jobs/runner";
import { getSettings, saveSettings } from "@/lib/crawl/settings";
import * as crawl from "@/lib/crawl/repository";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { candidateRevisionHash, requestCandidateEvidence } from "@/lib/crawl/admin-review";
import { claimItemLease, lockItemStage, readItemStage, type ItemStageGuard } from "@/lib/jobs/items/repository";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";
import { lockAdminEvidenceRefreshCompletion, applyAdminEvidenceRefreshCompletion } from "@/lib/crawl/evidence-refresh-completion";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { FetchItemBinding } from "@/lib/jobs/items/types";
import { assertFetchOwnership, type FetchClaim } from "@/lib/crawl/fetch-ownership";
import { claimFetchFixtureJob } from "./fetch-fixtures";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03-fetch-independent-admin" } });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03-fetch-independent-observer", statement_timeout: 8_000 } });
const prefix = "pr03-independent/";
let serial = 0;
const unrelatedJob = { name: "pr03-fetch-independent-unrelated", requestedVersion: 13, processedVersion: 5,
  cursor: { marker: "pr03-unrelated", page: 71 }, notBefore: new Date("2101-01-01T00:00:00.000Z") };

async function clean() {
  await admin`DROP TRIGGER IF EXISTS pr03_fetch_independent_fail ON jobs`;
  await admin`DROP FUNCTION IF EXISTS pr03_fetch_independent_fail()`;
  await admin`DELETE FROM pipeline_item_leases WHERE stage='fetch' AND binding->>'repo' LIKE 'pr03-independent/%'`;
  await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
  await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}%`));
  await db.delete(crawlFrontier).where(like(crawlFrontier.repo, `${prefix}%`));
  await db.delete(jobs).where(sql`${jobs.name} IN ('crawl-fetch','crawl-judge','crawl-agent-review','agent-evidence-refresh')`);
  await admin`UPDATE pipeline_stage_modes SET mode='legacy',draining_from=NULL,epoch=1,
    writer_contract_version=0,updated_at=clock_timestamp()`;
}

beforeAll(async () => {
  ensureSchema();
  await db.insert(jobs).values(unrelatedJob);
});
beforeEach(async () => {
  await clean();
  vi.clearAllMocks();
  await saveSettings({ enabled: true, agentEvidence: { enabled: true } }, "pr03-independent");
  http.repo.mockImplementation(async (repo: string) => ({ ok: true, value: {
    id: 903000 + serial, full_name: repo, private: false, fork: false, archived: false,
    stargazers_count: 3, pushed_at: "2026-10-01T00:00:00.000Z", owner: { type: "User" },
    homepage: "https://pr03-fetch.test", description: "A deployed task tracker",
  } }));
  http.page.mockResolvedValue({ status: 200, finalUrl: "https://pr03-fetch.test",
    html: "<title>Task tracker</title><p>Create and manage projects in the application.</p>" });
});
afterEach(async () => {
  expect(await db.select().from(jobs).where(eq(jobs.name, unrelatedJob.name))).toMatchObject([unrelatedJob]);
});
afterAll(async () => {
  try { await clean(); await db.delete(jobs).where(eq(jobs.name, unrelatedJob.name)); }
  finally { await Promise.all([admin.end({ timeout: 3 }), observer.end({ timeout: 3 })]); }
});

async function frontier(state: "pending" | "fetching" = "pending") {
  const [row] = await db.insert(crawlFrontier).values({ repo: `${prefix}source-${++serial}`,
    signal: "pr03-independent", state, attempts: state === "fetching" ? 1 : 0,
    updatedAt: new Date(Date.now() - 60_000),
    nextAttemptAt: state === "fetching" ? new Date(Date.now() + 20 * 60_000) : new Date(0),
  }).returning();
  return row;
}

const itemOwner = { instanceId: "pr03-independent-item", bootId: "00000000-0000-4000-8000-000000000072" };
async function itemClaim(ttlMs = 60_000) {
  const row = await frontier();
  return claimReadyItem(row, ttlMs);
}
async function claimReadyItem(row: { id: number }, ttlMs = 60_000) {
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='fetch'`;
  const claim = await crawl.claimFetchItem({ owner: itemOwner, ttlMs });
  expect(claim).toMatchObject({ id: row.id, ownership: { kind: "item" } });
  return claim!;
}
function source(claim: Pick<FetchClaim, "id" | "repo">) {
  return { repo: claim.repo, repoMeta: { id: 904000 + claim.id, full_name: claim.repo },
    productUrl: "https://pr03-fetch.test", pageStatus: 200, pageMeta: { title: "Actual item source" } };
}
async function ownFrontier(id: number) {
  return (await db.select().from(crawlFrontier).where(eq(crawlFrontier.id, id)))[0];
}
async function actualItem(claim: FetchClaim) {
  return (await admin`SELECT * FROM pipeline_item_leases WHERE stage='fetch' AND work_key=${`fetch:${claim.id}`}`)[0];
}
async function requestedEvidence() {
  const row = await frontier();
  expect(await runJob("crawl-fetch", fetchCrawlDocuments)).toMatchObject({ status: "completed" });
  await crawl.recordJudgement({ repo: row.repo, productUrl: "https://pr03-fetch.test",
    state: "needs_review", reason: "ambiguous", decidedBy: "auto" });
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 3_600_000) })
    .where(eq(crawlDocuments.repo, row.repo));
  const candidate = (await crawl.getCandidate(row.repo))!;
  const document = (await crawl.getDocument(row.repo))!;
  const input = await loadReviewInput(candidate, document, await getSettings());
  expect(await requestCandidateEvidence({ repo: row.repo, actor: "pr03-independent", reason: "Refresh public evidence",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
    candidateRevisionHash: candidateRevisionHash(candidate) })).toMatchObject({ ok: true });
  const [request] = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, candidate.id));
  return { row, candidate, document, request };
}

async function waitForBlockedBy(pid: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [state] = await observer`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock') AS waiting`;
    if (state.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`source did not enter actual lock wait behind ${pid}`);
}

it.each(["items", "draining"] as const)("blocks actual legacy HTTP and source writes while fetch mode is %s", async mode => {
  const row = await frontier();
  await admin`UPDATE pipeline_stage_modes SET mode=${mode},
    draining_from=${mode === "draining" ? "legacy" : null},writer_contract_version=1 WHERE stage='fetch'`;
  await runJob("crawl-fetch", fetchCrawlDocuments);
  expect(http.repo).not.toHaveBeenCalled();
  expect(http.page).not.toHaveBeenCalled();
  expect(await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, row.repo))).toHaveLength(0);
  expect((await db.select().from(crawlFrontier).where(eq(crawlFrontier.id, row.id)))[0])
    .toMatchObject({ state: "pending", attempts: 0 });
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"))).toHaveLength(0);
});

it("preserves a healthy foreign item through actual legacy recovery and HTTP admission", async () => {
  const row = await frontier("fetching");
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='fetch'`;
  const binding: FetchItemBinding = { stage: "fetch", frontierId: row.id, repo: row.repo,
    claim: { attempts: row.attempts, nextAttemptAt: row.nextAttemptAt.toISOString() } };
  const lease = await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "fetch"), binding,
    { instanceId: "pr03-independent-foreign", bootId: "00000000-0000-4000-8000-000000000071" }, 60_000));
  expect(lease).not.toBeNull();
  // Explicit owner fixture: changing a scheduler/job mode never authorizes it
  // to reclaim an independently live item or declare the external call ended.
  await admin`UPDATE pipeline_stage_modes SET mode='legacy' WHERE stage='fetch'`;
  await runJob("crawl-fetch", fetchCrawlDocuments);
  expect(http.repo.mock.calls.filter(([repo]) => repo === row.repo)).toHaveLength(0);
  expect((await db.select().from(crawlFrontier).where(eq(crawlFrontier.id, row.id)))[0])
    .toMatchObject({ state: "fetching", attempts: row.attempts, nextAttemptAt: row.nextAttemptAt });
  expect(await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, row.repo))).toHaveLength(0);
  const [actual] = await admin`SELECT token,owner_instance_id,owner_boot_id,item_epoch FROM pipeline_item_leases
    WHERE stage='fetch' AND work_key=${lease!.workKey}`;
  expect({ ...actual, item_epoch: Number(actual.item_epoch) }).toMatchObject({ token: lease!.token, owner_instance_id: lease!.owner.instanceId,
    owner_boot_id: lease!.owner.bootId, item_epoch: lease!.itemEpoch });
});

it("rolls source and admin evidence consumption back when the actual next job request fails", async () => {
  const row = await frontier();
  expect(await runJob("crawl-fetch", fetchCrawlDocuments)).toMatchObject({ status: "completed" });
  await crawl.recordJudgement({ repo: row.repo, productUrl: "https://pr03-fetch.test",
    state: "needs_review", reason: "ambiguous", decidedBy: "auto" });
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 3_600_000) })
    .where(eq(crawlDocuments.repo, row.repo));
  const candidate = (await crawl.getCandidate(row.repo))!;
  const document = (await crawl.getDocument(row.repo))!;
  const input = await loadReviewInput(candidate, document, await getSettings());
  expect(await requestCandidateEvidence({ repo: row.repo, actor: "pr03-independent", reason: "Refresh public evidence",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
    candidateRevisionHash: candidateRevisionHash(candidate) })).toMatchObject({ ok: true });
  const [request] = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, candidate.id));
  expect(request.kind).toBe("evidence_refresh");
  const [judgeBefore] = await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"));
  await admin`CREATE FUNCTION pr03_fetch_independent_fail() RETURNS trigger LANGUAGE plpgsql AS
    'BEGIN IF NEW.name = ''crawl-judge'' THEN RAISE EXCEPTION ''pr03_fetch_request_failure''; END IF; RETURN NEW; END'`;
  await admin`CREATE TRIGGER pr03_fetch_independent_fail BEFORE INSERT OR UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION pr03_fetch_independent_fail()`;
  try {
    expect(await runJob("crawl-fetch", fetchCrawlDocuments)).toMatchObject({ status: "failed" });
    expect.soft(await crawl.getDocument(row.repo)).toEqual(document);
    expect.soft((await db.select().from(crawlFrontier).where(eq(crawlFrontier.id, row.id)))[0].state).toBe("fetching");
    expect.soft(await crawl.getCandidate(row.repo)).toEqual(candidate);
    expect((await db.select().from(jobs).where(eq(jobs.name, "crawl-judge")))[0]).toEqual(judgeBefore);
  } finally {
    await admin`DROP TRIGGER pr03_fetch_independent_fail ON jobs`;
    await admin`DROP FUNCTION pr03_fetch_independent_fail()`;
  }
  expect(await runJob("crawl-fetch", fetchCrawlDocuments)).toMatchObject({ status: "completed" });
  expect(await crawl.getCandidate(row.repo)).toMatchObject({ state: "new",
    signals: { adminEvidenceRefreshConsumedId: request.id } });
  expect((await db.select().from(jobs).where(eq(jobs.name, "crawl-judge")))[0].requestedVersion)
    .toBe(judgeBefore.requestedVersion + 1);
});

it("rejects an ended transaction completion context without consuming its fresh evidence request", async () => {
  const row = await frontier();
  expect(await runJob("crawl-fetch", fetchCrawlDocuments)).toMatchObject({ status: "completed" });
  await crawl.recordJudgement({ repo: row.repo, productUrl: "https://pr03-fetch.test",
    state: "needs_review", reason: "ambiguous", decidedBy: "auto" });
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 3_600_000) })
    .where(eq(crawlDocuments.repo, row.repo));
  const candidate = (await crawl.getCandidate(row.repo))!;
  const input = await loadReviewInput(candidate, (await crawl.getDocument(row.repo))!, await getSettings());
  expect(await requestCandidateEvidence({ repo: row.repo, actor: "pr03-independent", reason: "Refresh public evidence",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
    candidateRevisionHash: candidateRevisionHash(candidate) })).toMatchObject({ ok: true });
  await db.update(crawlDocuments).set({ fetchedAt: new Date() }).where(eq(crawlDocuments.repo, row.repo));
  let escaped!: ProductTransaction;
  const context = await db.transaction(async tx => {
    escaped = tx;
    const stages = await lockPipelineInputStages(tx);
    return lockAdminEvidenceRefreshCompletion(tx, row.repo, stages.fetch);
  });
  expect(context).not.toBeNull();
  const before = await crawl.getCandidate(row.repo);
  await expect.soft(applyAdminEvidenceRefreshCompletion(escaped, context!)).rejects.toThrow();
  expect(await crawl.getCandidate(row.repo)).toEqual(before);
});

it("authenticates observational stage reads against forged, foreign and ended transaction guards", async () => {
  let escaped!: ProductTransaction;
  let guard!: ItemStageGuard;
  await db.transaction(async tx => {
    escaped = tx;
    guard = await lockItemStage(tx, "fetch");
    expect(await readItemStage(tx, guard)).toMatchObject({ stage: "fetch", mode: "legacy", epoch: 1 });
    await expect(readItemStage(tx, {} as ItemStageGuard)).rejects.toThrow("invalid_item_stage_guard");
  });
  await db.transaction(async tx => {
    await expect(readItemStage(tx, guard)).rejects.toThrow("invalid_item_stage_guard");
  });
  await expect(readItemStage(escaped, guard)).rejects.toThrow("invalid_item_stage_guard");
});

it("commits an actual item source, release and one judgement request and rejects its duplicate receipt", async () => {
  const claim = await itemClaim();
  expect(await crawl.saveFetchedDocument(claim, source(claim))).toEqual({ needsJudgement: true });
  expect(await ownFrontier(claim.id)).toMatchObject({ state: "done", attempts: 1 });
  expect(await crawl.getDocument(claim.repo)).toMatchObject(source(claim));
  expect(await actualItem(claim)).toMatchObject({ token: null, owner_instance_id: null, lease_until: null });
  const [job] = await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"));
  expect(job).toMatchObject({ requestedVersion: 1, processedVersion: 0 });
  const document = await crawl.getDocument(claim.repo);
  await expect(crawl.saveFetchedDocument(claim, source(claim))).rejects.toThrow("item_lease_lost");
  expect(await crawl.getDocument(claim.repo)).toEqual(document);
  expect((await db.select().from(jobs).where(eq(jobs.name, "crawl-judge")))[0]).toEqual(job);
});

it("rolls actual item source and release back with a failed downstream request", async () => {
  const evidence = await requestedEvidence();
  const claim = await claimReadyItem(evidence.row);
  const before = await ownFrontier(claim.id), item = await actualItem(claim);
  const [judge] = await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"));
  await admin`CREATE FUNCTION pr03_fetch_independent_fail() RETURNS trigger LANGUAGE plpgsql AS
    'BEGIN IF NEW.name = ''crawl-judge'' THEN RAISE EXCEPTION ''pr03_fetch_request_failure''; END IF; RETURN NEW; END'`;
  await admin`CREATE TRIGGER pr03_fetch_independent_fail BEFORE INSERT OR UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION pr03_fetch_independent_fail()`;
  await expect(crawl.saveFetchedDocument(claim, source(claim))).rejects.toThrow();
  expect(await ownFrontier(claim.id)).toEqual(before);
  expect(await actualItem(claim)).toEqual(item);
  expect(await crawl.getDocument(claim.repo)).toEqual(evidence.document);
  expect(await crawl.getCandidate(claim.repo)).toEqual(evidence.candidate);
  expect((await db.select().from(jobs).where(eq(jobs.name, "crawl-judge")))[0]).toEqual(judge);
  await admin`DROP TRIGGER pr03_fetch_independent_fail ON jobs`;
  await admin`DROP FUNCTION pr03_fetch_independent_fail()`;
  expect(await crawl.saveFetchedDocument(claim, source(claim))).toEqual({ needsJudgement: true });
  expect(await crawl.getCandidate(claim.repo)).toMatchObject({ state: "new",
    signals: { adminEvidenceRefreshConsumedId: evidence.request.id } });
  expect(await actualItem(claim)).toMatchObject({ token: null, lease_until: null });
  expect((await db.select().from(jobs).where(eq(jobs.name, "crawl-judge")))[0].requestedVersion).toBe(judge.requestedVersion + 1);
});

it.each(["source", "failure", "defer", "skip"] as const)("rejects an expired item %s without domain or request writes", async operation => {
  const claim = await itemClaim();
  await admin`UPDATE pipeline_item_leases SET lease_until=clock_timestamp()-interval '1 second'
    WHERE stage='fetch' AND work_key=${`fetch:${claim.id}`}`;
  const before = await ownFrontier(claim.id), item = await actualItem(claim);
  const write = operation === "source" ? crawl.saveFetchedDocument(claim, source(claim))
    : operation === "failure" ? crawl.markFailed(claim, "expired external failure")
    : operation === "defer" ? crawl.deferFrontier([claim]) : crawl.markFrontier(claim, "skipped");
  await expect(write).rejects.toThrow("item_lease_lost");
  expect(await ownFrontier(claim.id)).toEqual(before);
  expect(await actualItem(claim)).toEqual(item);
  expect(await crawl.getDocument(claim.repo)).toBeUndefined();
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"))).toHaveLength(0);
});

it.each(["foreign", "binding", "epoch"] as const)("rejects %s item source ownership without releasing the live owner", async mutation => {
  const claim = await itemClaim();
  if (claim.ownership.kind !== "item") throw new Error("item fixture required");
  const forged: FetchClaim = mutation === "foreign" ? { ...claim, ownership: { kind: "item", lease: {
    ...claim.ownership.lease, owner: { ...claim.ownership.lease.owner, bootId: "00000000-0000-4000-8000-000000000073" },
  } } } : structuredClone(claim);
  if (forged.ownership.kind !== "item") throw new Error("item fixture required");
  if (mutation === "binding") forged.ownership.lease.binding.claim.attempts++;
  if (mutation === "epoch") await admin`UPDATE pipeline_stage_modes SET epoch=epoch+1 WHERE stage='fetch'`;
  const item = await actualItem(claim), before = await ownFrontier(claim.id);
  await expect(crawl.saveFetchedDocument(forged, source(forged))).rejects.toThrow();
  expect(await actualItem(claim)).toEqual(item);
  expect(await ownFrontier(claim.id)).toEqual(before);
  expect(await crawl.getDocument(claim.repo)).toBeUndefined();
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"))).toHaveLength(0);
});

it.each(["job", "stage"] as const)("rejects a stale legacy %s source with atomic domain and outbox preservation", async mutation => {
  const row = await frontier();
  const [claim] = await crawl.dequeue(1, undefined, await claimFetchFixtureJob());
  expect(claim.id).toBe(row.id);
  if (mutation === "job") await db.update(jobs).set({ leaseToken: "pr03-foreign-job" }).where(eq(jobs.name, "crawl-fetch"));
  else await admin`UPDATE pipeline_stage_modes SET epoch=epoch+1 WHERE stage='fetch'`;
  const before = await ownFrontier(claim.id);
  await expect(crawl.saveFetchedDocument(claim, source(claim))).rejects.toThrow();
  expect(await ownFrontier(claim.id)).toEqual(before);
  expect(await crawl.getDocument(claim.repo)).toBeUndefined();
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"))).toHaveLength(0);
});

it("allows a settled legacy source to finish during drain while admitting no new work", async () => {
  const row = await frontier();
  const job = await claimFetchFixtureJob();
  const [claim] = await crawl.dequeue(1, undefined, job);
  expect(claim.id).toBe(row.id);
  await admin`UPDATE pipeline_stage_modes SET mode='draining',draining_from='legacy',writer_contract_version=1 WHERE stage='fetch'`;
  expect(await crawl.dequeue(1, undefined, job)).toEqual([]);
  expect(await crawl.saveFetchedDocument(claim, source(claim))).toEqual({ needsJudgement: true });
  expect(await ownFrontier(claim.id)).toMatchObject({ state: "done" });
});

it("keeps the controller candidate then frontier identity order while source waits on that actual candidate", async () => {
  const row = await frontier();
  await crawl.putDocument(source(row));
  await crawl.recordJudgement({ repo: row.repo, productUrl: "https://pr03-fetch.test", state: "needs_review",
    reason: "ambiguous", decidedBy: "auto" });
  const [claim] = await crawl.dequeue(1, undefined, await claimFetchFixtureJob());
  let pending: ReturnType<typeof crawl.saveFetchedDocument> | undefined;
  try {
    await admin.begin(async controller => {
      const [{ pid }] = await controller`SELECT pg_backend_pid() AS pid`;
      await controller`SELECT id FROM crawl_candidates WHERE repo=${row.repo} FOR UPDATE`;
      pending = crawl.saveFetchedDocument(claim, source(claim));
      void pending.catch(() => {});
      await waitForBlockedBy(pid);
      const [identity] = await controller`SELECT pg_try_advisory_xact_lock(hashtext(${`crawl-frontier:${row.repo.toLowerCase()}`})) AS acquired`;
      expect(identity.acquired).toBe(true);
      await controller`UPDATE crawl_frontier SET attempts=attempts+1 WHERE id=${row.id}`;
    });
  } finally {
    if (pending) await pending;
  }
  expect(await pending).toBeNull();
  expect(await ownFrontier(row.id)).toMatchObject({ state: "fetching", attempts: 2 });
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"))).toHaveLength(0);
});

it("checks item expiry after a downstream job lock wait and rolls source, evidence, release and request back", async () => {
  const evidence = await requestedEvidence();
  const claim = await claimReadyItem(evidence.row, 1_000);
  const before = await ownFrontier(claim.id), item = await actualItem(claim);
  const [judge] = await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"));
  let pending: ReturnType<typeof crawl.saveFetchedDocument> | undefined;
  let outcome: Promise<unknown> | undefined;
  try {
    await admin.begin(async blocker => {
      const [{ pid }] = await blocker`SELECT pg_backend_pid() AS pid`;
      await blocker`SELECT name FROM jobs WHERE name='crawl-judge' FOR UPDATE`;
      pending = crawl.saveFetchedDocument(claim, source(claim));
      outcome = expect(pending).rejects.toThrow("item_lease_lost");
      void outcome.catch(() => {});
      await waitForBlockedBy(pid);
      const deadline = Date.now() + 3_000;
      let expired = false;
      while (Date.now() < deadline) {
        const [clock] = await observer`SELECT clock_timestamp() >= ${claim.ownership.kind === "item"
          ? claim.ownership.lease.leaseUntil : new Date(0)} AS expired`;
        if (clock.expired) { expired = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(expired).toBe(true);
    });
  } finally {
    if (outcome) await outcome;
  }
  expect(await ownFrontier(claim.id)).toEqual(before);
  expect(await actualItem(claim)).toEqual(item);
  expect(await crawl.getDocument(claim.repo)).toEqual(evidence.document);
  expect(await crawl.getCandidate(claim.repo)).toEqual(evidence.candidate);
  expect((await db.select().from(jobs).where(eq(jobs.name, "crawl-judge")))[0]).toEqual(judge);
});

it.each(["failure", "defer", "skip"] as const)("settles an owned item %s during drain and preserves its distinct retry semantics", async operation => {
  const claim = await itemClaim();
  await admin`UPDATE pipeline_stage_modes SET mode='draining',draining_from='items' WHERE stage='fetch'`;
  expect(await crawl.claimFetchItem({ owner: itemOwner, ttlMs: 60_000 })).toBeNull();
  const retryAt = new Date(Date.now() + 60 * 60_000);
  if (operation === "failure") await crawl.markFailed(claim, "settled failure", { retryAt });
  else if (operation === "defer") await crawl.deferFrontier([claim], retryAt);
  else await crawl.markFrontier(claim, "skipped", crawl.SKIP_NOT_FOUND);
  expect(await actualItem(claim)).toMatchObject({ token: null, owner_instance_id: null, lease_until: null });
  const row = await ownFrontier(claim.id);
  expect(row).toMatchObject(operation === "failure" ? { state: "pending", attempts: 1, lastError: "settled failure" }
    : operation === "defer" ? { state: "pending", attempts: 0, lastError: null }
    : { state: "skipped", attempts: 1, lastError: crawl.SKIP_NOT_FOUND });
  if (operation !== "skip") expect(row.nextAttemptAt).toEqual(retryAt);
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"))).toHaveLength(0);
});

it("rejects a forged fresh document timestamp rather than consuming stale actual evidence", async () => {
  const evidence = await requestedEvidence();
  await db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx);
    const context = await lockAdminEvidenceRefreshCompletion(tx, evidence.row.repo, stages.fetch);
    expect(context).not.toBeNull();
    expect(await applyAdminEvidenceRefreshCompletion(tx, context!, { documentFetchedAt: new Date(Date.now() + 60_000) }))
      .toEqual({ consumed: false, needsJudgement: false });
  });
  expect(await crawl.getCandidate(evidence.row.repo)).toEqual(evidence.candidate);
  expect(await crawl.getDocument(evidence.row.repo)).toEqual(evidence.document);
});

it("rejects using another stage's authentic guard as legacy fetch authority", async () => {
  const row = await frontier();
  const [claim] = await crawl.dequeue(1, undefined, await claimFetchFixtureJob());
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='fetch'`;
  const before = await ownFrontier(row.id);
  await expect.soft(db.transaction(async tx => {
    const guard = await lockItemStage(tx, "ai1");
    await tx.select().from(crawlFrontier).where(eq(crawlFrontier.id, row.id)).for("update");
    await tx.update(crawlFrontier).set({ state: "done" }).where(eq(crawlFrontier.id, row.id));
    await assertFetchOwnership(tx, guard, claim);
  })).rejects.toThrow();
  expect(await ownFrontier(row.id)).toEqual(before);
});

import { afterAll, beforeAll, expect, it } from "vitest";
import postgres from "postgres";
import { eq, inArray, sql } from "drizzle-orm";
import { db, onPrimary, onReplica } from "@/lib/db";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, jobs, products } from "@/lib/db/schema";
import { getSettings } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { claimAgentReview, loadReviewInput, recordAgentReview } from "@/lib/crawl/agent-review-repository";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { requestJob } from "@/lib/jobs/control";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";

let identityPath: string, release: () => Promise<void>, admin: postgres.Sql;
let fixture: Awaited<ReturnType<typeof prepareFixture>>;
beforeAll(async () => {
  ensureSchema();
  fixture = await prepareFixture();
  ({ identityPath, release } = await getReplayHandlerIdentityPath());
  admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
});
afterAll(async () => { await admin?.end({ timeout: 3 }); await release?.(); });
const scope = <T>(load: () => Promise<T>) => withReplayDatabaseScope(identityPath, load);

it("bypasses poisoned global primary/replica handles and exposes only the restricted role", async () => {
  const globals = globalThis as { db?: unknown; readDb?: unknown }, original = { db: globals.db, readDb: globals.readDb };
  const poison = new Proxy({}, { get() { throw new Error("live_database_access_canary"); } });
  globals.db = poison; globals.readDb = poison;
  try {
    await scope(async () => {
      const [current] = await db.execute<{ role: string; pid: number }>(sql`select current_user as role, pg_backend_pid() as pid`);
      expect(current.role).toMatch(/^nomorevibe_replay_/);
      expect((await onReplica(() => onPrimary(() => db.execute<{ role: string }>(sql`select current_user as role`))))[0].role).toBe(current.role);
      expect(await db.select({ id: products.id }).from(products).limit(1)).toBeDefined();
      expect(() => db.$client).toThrow("replay_raw_client_rejected");
    });
  } finally { Object.assign(globals, original); }
});

async function prepareFixture() {
  const referenceTime = new Date("2001-11-01T00:00:00.000Z");
  const previous = await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(eq(crawlCandidates.repo, "scope-replay/app"));
  if (previous.length) {
    await db.delete(crawlReviewAttempts).where(inArray(crawlReviewAttempts.candidateId, previous.map(row => row.id)));
    await db.delete(crawlCandidates).where(inArray(crawlCandidates.id, previous.map(row => row.id)));
  }
  await db.delete(crawlDocuments).where(eq(crawlDocuments.repo, "scope-replay/app"));
  await db.insert(crawlSettings).values({ id: 1, values: { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "first" }, secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: false } } })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce",
      firstReview: { provider: "abcllm", model: "first" }, secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: false } } } });
  const [candidate] = await db.insert(crawlCandidates).values({ repo: "scope-replay/app", productUrl: "https://scope.example",
    state: "approved", reason: "passed", decidedBy: "auto", judgedAt: referenceTime }).returning();
  const [document] = await db.insert(crawlDocuments).values({ repo: candidate.repo, productUrl: candidate.productUrl,
    fetchedAt: new Date(referenceTime.getTime() - 1_000), pageStatus: 200, repoMeta: { description: "A useful application" },
    pageMeta: { title: "Scope", readmeSample: "A useful application", readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  const lease = { name: "crawl-agent-review", token: "scope-replay-claim", requestedVersion: 1 };
  await db.delete(jobs).where(inArray(jobs.name, [lease.name, "second-review", "crawl-publish", "crawl-fetch"]));
  await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: new Date(), requestedVersion: 1 });
  return { referenceTime, candidate, document, lease };
}

it("runs the existing input/claim/result repository with source locks and its ordinary job outbox", async () => {
  const { referenceTime, candidate, document, lease } = fixture;
  await scope(() => withReviewReplayContext({ referenceTime }, async () => {
    const settings = await getSettings(), input = await loadReviewInput(candidate, document, settings);
    expect(settings.firstReview).toEqual({ provider: "abcllm", model: "first" });
    expect((await db.query.crawlDocuments.findFirst({ where: eq(crawlDocuments.id, document.id) }))?.fetchedAt).toEqual(document.fetchedAt);
    const context = { candidate, document, settings, input, lease, provider: "abcllm", model: "first" };
    const claim = await claimAgentReview(context);
    if (claim.kind !== "claimed") throw new Error(`unexpected_claim_${claim.kind}`);
    expect(claim.attempt.startedAt).toBeInstanceOf(Date);
    expect(await recordAgentReview({ ...context, receipt: claim.receipt, outcome: { decision: "approve", confidence: 0.95,
      reason: "A usable application", evidenceIds: ["product"] } })).toEqual({ applied: true, state: "succeeded" });
  }));
  expect((await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, candidate.id)))[0].state).toBe("succeeded");
  expect((await db.select().from(jobs).where(eq(jobs.name, "crawl-publish")))[0].requestedVersion).toBeGreaterThan(0);
});

it("keeps actual writer/outbox rollback on the same connection including nested savepoints", async () => {
  await scope(async () => {
    await expect(db.transaction(async tx => {
      const [before] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await requestJob("second-review", tx);
      await tx.transaction(async inner => {
        expect((await inner.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0].pid).toBe(before.pid);
      });
      throw new Error("writer_rollback_canary");
    })).rejects.toThrow("writer_rollback_canary");
  });
  expect(await db.select().from(jobs).where(eq(jobs.name, "second-review"))).toEqual([]);
});

it("rolls back a pending write when admin privilege drift is detected at commit", async () => {
  const [{ role }] = await scope(() => db.execute<{ role: string }>(sql`select current_user as role`));
  try {
    await expect(scope(() => db.transaction(async tx => {
      await requestJob("second-review", tx);
      await admin.unsafe(`GRANT DELETE ON public.products TO "${role}"`);
    }))).rejects.toThrow("replay_database_privileges_rejected");
  } finally { await admin.unsafe(`REVOKE DELETE ON public.products FROM "${role}"`); }
  expect(await db.select().from(jobs).where(eq(jobs.name, "second-review"))).toEqual([]);
});

it("denies product writes and immutable evidence mutation through the actual Drizzle executor", async () => {
  await scope(async () => {
    for (const query of [sql`update products set name = name`, sql`delete from products`, sql`update crawl_settings set id = id`])
      await expect(db.execute(query)).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});

it("fences lazy builders and captured transactions after their owning lifetime ends", async () => {
  let query!: PromiseLike<unknown>, transactionQuery!: () => PromiseLike<unknown>;
  await scope(async () => {
    query = db.select().from(jobs);
    await db.transaction(async tx => { transactionQuery = () => tx.select().from(jobs); });
    await expect(Promise.resolve().then(() => transactionQuery()))
      .rejects.toMatchObject({ cause: { message: "replay_transaction_closed" } });
  });
  await expect(Promise.resolve(query)).rejects.toMatchObject({ cause: { message: "replay_database_scope_closed" } });
});

it("rolls back actively started unawaited work before closing its owned connection", async () => {
  let entered!: () => void, resume!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { resume = resolve; });
  let background!: Promise<unknown>;
  await expect(scope(async () => {
    background = db.transaction(async tx => {
      await requestJob("crawl-fetch", tx);
      entered();
      await wait;
    });
    void background.catch(() => {});
    await running;
    setTimeout(resume, 10);
  })).rejects.toThrow("replay_database_work_not_awaited");
  await expect(background).rejects.toThrow("replay_database_scope_closed");
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-fetch"))).toEqual([]);
});

it("rolls back both actual savepoint and parent when the child callback is left unawaited", async () => {
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { resume = resolve; });
  let child!: Promise<unknown>;
  await scope(async () => {
    await expect(db.transaction(async tx => {
      child = tx.transaction(async inner => { await requestJob("second-review", inner); entered(); await wait; });
      void child.catch(() => {});
      await started;
    })).rejects.toThrow("replay_transaction_work_not_awaited");
    resume();
    await expect(child).rejects.toThrow("replay_transaction_closed");
  });
  expect(await db.select().from(jobs).where(eq(jobs.name, "second-review"))).toEqual([]);
});

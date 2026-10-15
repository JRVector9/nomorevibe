import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import postgres from "postgres";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, jobs, products } from "@/lib/db/schema";
import { getCandidate, getDocument, putDocument, recordJudgement, recordPublishedReadme,
  refreshTextSample, setReadmeSample } from "@/lib/crawl/repository";
import { getSettings, saveSettings } from "@/lib/crawl/settings";
import { candidateRevisionHash, overrideCandidate } from "@/lib/crawl/admin-review";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03b-input-stage-blocker", statement_timeout: 8_000 } });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03b-input-stage-observer", statement_timeout: 8_000 } });
const repo = "pr03b-input-stage/product", slug = "pr03b-input-stage-product";
const jobNames = ["product-readme-refresh", "crawl-publish"];
let originalSettings: (typeof crawlSettings.$inferSelect)[] = [];
let originalJobs: (typeof jobs.$inferSelect)[] = [];
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
  throw new Error("input_stage_lock_barrier_timeout");
}
async function clean() {
  await db.delete(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  await db.delete(crawlDocuments).where(eq(crawlDocuments.repo, repo));
  await db.delete(products).where(eq(products.slug, slug));
}
beforeAll(async () => {
  ensureSchema();
  originalSettings = await db.select().from(crawlSettings);
  originalJobs = await db.select().from(jobs).where(inArray(jobs.name, jobNames));
  initialized = true;
});
beforeEach(async () => {
  await clean();
  await saveSettings({ enabled: true, agentEvidence: { enabled: true } }, "pr03b-stage");
  await putDocument({ repo, productUrl: "https://pr03b-input.test", pageStatus: 200,
    repoMeta: { description: "A deployed project manager" }, pageMeta: { title: "Project manager" } });
  await recordJudgement({ repo, productUrl: "https://pr03b-input.test", state: "needs_review",
    reason: "ambiguous", decidedBy: "auto" });
});
afterAll(async () => {
  try {
    if (!initialized) return;
    await clean();
    await db.delete(jobs).where(inArray(jobs.name, jobNames));
    if (originalJobs.length) await db.insert(jobs).values(originalJobs);
    await db.delete(crawlSettings);
    if (originalSettings.length) await db.insert(crawlSettings).values(originalSettings);
    expect(await db.select().from(crawlDocuments).where(like(crawlDocuments.repo, "pr03b-input-stage/%"))).toHaveLength(0);
  } finally { await Promise.all([blocker.end({ timeout: 3 }), observer.end({ timeout: 3 })]); }
});

/** Actual stage-controller lock must be reached before any domain row lock/write. */
async function behindStage(action: () => Promise<unknown>, domainAvailable: () => Promise<void>) {
  const locked = deferred<number>(), release = deferred<void>();
  const holding = blocker.begin(async tx => {
    const [row] = await tx`SELECT pg_backend_pid() AS pid FROM pipeline_stage_modes WHERE stage='ai1' FOR UPDATE`;
    locked.resolve(row.pid);
    await release.promise;
  });
  let outcome: Promise<{ value: unknown } | { error: unknown }> | undefined;
  try {
    const pid = await locked.promise;
    let settled = false;
    outcome = action().then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    const state = await waitFor(async () => {
      if (settled) return "completed";
      const [wait] = await observer`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND ${pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
      return wait.blocked ? "blocked" : undefined;
    });
    expect(state).toBe("blocked");
    await domainAvailable();
  } finally {
    release.resolve();
    await holding;
    if (outcome) {
      const result = await outcome;
      if ("error" in result) throw result.error;
    }
  }
}
async function documentAvailable() {
  await observer.begin(async tx => {
    await tx`SELECT id FROM crawl_documents WHERE repo=${repo} FOR UPDATE NOWAIT`;
  });
}

it("locks stages before writing a review README", async () => {
  const document = (await getDocument(repo))!;
  await behindStage(() => setReadmeSample(repo, "Fresh README", document), documentAvailable);
  expect((await getDocument(repo))?.pageMeta?.readmeSample).toBe("Fresh README");
});
it("locks stages before writing a published README", async () => {
  const document = (await getDocument(repo))!;
  const token = randomUUID();
  await db.insert(jobs).values({ name: "product-readme-refresh", leaseToken: token, lockedAt: sql`clock_timestamp()` })
    .onConflictDoUpdate({ target: jobs.name, set: { leaseToken: token, lockedAt: sql`clock_timestamp()` } });
  await behindStage(() => recordPublishedReadme(document,
    { name: "product-readme-refresh", token, requestedVersion: 0 }, { ok: true, sample: "Published README" }), documentAvailable);
  expect((await getDocument(repo))?.pageMeta?.readmeSample).toBe("Published README");
});
it("locks stages before a product generation or text source row", async () => {
  const [product] = await db.insert(products).values({ slug, name: "Input stage", url: "https://pr03b-input.test",
    tagline: "Input stage", description: "Input stage", category: "Dev", status: "seeded", source: "crawler",
    verifyToken: "fixture", editTokenHash: "fixture" }).returning();
  await db.update(crawlCandidates).set({ publishedSlug: slug }).where(eq(crawlCandidates.repo, repo));
  await behindStage(() => refreshTextSample(slug, "Fresh page text", undefined, { id: product.id, url: product.url }), async () => {
    await observer.begin(async tx => { await tx`SELECT id FROM products WHERE id=${product.id} FOR UPDATE NOWAIT`; });
    await documentAvailable();
  });
  expect((await getDocument(repo))?.pageMeta?.textSample).toBe("Fresh page text");
});
it("locks stages before a settings policy write", async () => {
  await behindStage(() => saveSettings({ reviewConcurrency: 3 }, "pr03b-stage"), async () => {
    await observer.begin(async tx => { await tx`SELECT id FROM crawl_settings WHERE id=1 FOR UPDATE NOWAIT`; });
  });
  expect((await getSettings()).reviewConcurrency).toBe(3);
});
it("locks stages before an administrator decision", async () => {
  const candidate = (await getCandidate(repo))!, document = (await getDocument(repo))!;
  const input = await loadReviewInput(candidate, document, await getSettings());
  await behindStage(() => overrideCandidate({ repo, actor: "pr03b-stage", reason: "A person reviewed this source",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
    candidateRevisionHash: candidateRevisionHash(candidate), decision: "reject", reasonCode: "not_a_product" }), async () => {
    await observer.begin(async tx => { await tx`SELECT id FROM crawl_candidates WHERE repo=${repo} FOR UPDATE NOWAIT`; });
    await documentAvailable();
  });
  expect(await getCandidate(repo)).toMatchObject({ state: "rejected", decidedBy: "admin" });
});

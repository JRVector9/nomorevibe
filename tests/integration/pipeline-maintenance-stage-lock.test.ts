import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, products } from "@/lib/db/schema";
import { applyReconsideration, planReconsideration } from "@/lib/crawl/reconsider";
import { applyStarRejudge, planStarRejudge, revertStarRejudge } from "@/lib/crawl/rejudge";
import { applyChanges, reverse } from "@/lib/crawl/tidy-catalog";
import { applyNameChanges, reverseNameChanges } from "@/lib/domain/products/name-review";
import { reconcileCrawlDuplicates } from "@/lib/crawl/duplicate-reconciliation";
import { getSettings, mergeWithDefaults } from "@/lib/crawl/settings";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { normalizeTypedLink } from "@/lib/domain/evidence/contracts";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const prefix = `pr03d-maint-${randomUUID().slice(0, 8)}`;
const raw = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
let jobBefore: unknown;
const unrelatedRepo = `unrelated-${prefix}/preserved`;
let unrelatedBefore: postgres.JSONValue;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitFor<T>(load: () => Promise<T | undefined>): Promise<T> {
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    const value = await load();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("actual_pg_barrier_not_observed");
}

async function behindStage<T>(domain: number | { productId: number }, action: () => Promise<T>, check?: () => Promise<void>): Promise<T> {
  const locked = deferred<number>();
  const release = deferred<void>();
  const holding = blocker.begin(async tx => {
    const [row] = await tx`SELECT pg_backend_pid() AS pid FROM pipeline_stage_modes WHERE stage='ai1' FOR UPDATE`;
    locked.resolve(Number(row.pid));
    await release.promise;
  });
  void holding.catch(locked.reject);
  let result: Promise<{ value: T } | { error: unknown }> | undefined;
  try {
    const pid = await locked.promise;
    let finished = false;
    result = action().then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
    const state = await waitFor(async () => {
      if (finished) return "completed";
      const [row] = await observer`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND ${pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
      return row.blocked ? "blocked" : undefined;
    });
    expect(state).toBe("blocked");
    await observer.begin(async tx => {
      if (typeof domain === "number") {
        const [candidate] = await tx`SELECT id,repo FROM crawl_candidates WHERE id=${domain} FOR UPDATE NOWAIT`;
        const identity = normalizeTypedLink("repository", `https://github.com/${candidate.repo}`)!.normalizedKey;
        const [available] = await tx`SELECT pg_try_advisory_xact_lock(hashtext(${`product-repository:${identity}`})) AS available`;
        expect(available.available).toBe(true);
        await tx`SELECT d.id FROM crawl_documents d JOIN crawl_candidates c ON c.repo=d.repo WHERE c.id=${domain} FOR UPDATE OF d NOWAIT`;
      } else await tx`SELECT id FROM products WHERE id=${domain.productId} FOR UPDATE NOWAIT`;
    });
    await check?.();
  } finally {
    release.resolve();
    const cleanup = await Promise.allSettled([holding, ...(result ? [result] : [])]);
    for (const settled of cleanup) if (settled.status === "rejected") throw settled.reason;
  }
  const settled = await result!;
  if ("error" in settled) throw settled.error;
  return settled.value;
}

async function reconsiderFixture(suffix: string) {
  const repo = `${prefix}/${suffix}`;
  await db.insert(crawlDocuments).values({ repo, productUrl: null,
    repoMeta: { stargazers_count: 12, description: "An editor plugin", fork: false, archived: false },
    fetchedAt: new Date(Date.now() - 60_000) });
  const [candidate] = await db.insert(crawlCandidates).values({ repo, state: "rejected", reason: "no_homepage", decidedBy: "auto" }).returning();
  const all = await withReconsiderPreview(candidate.id, () => planReconsideration(2_000, { policy: "package" }));
  const plan = { ...all, entries: all.entries.filter(entry => entry.id === candidate.id) };
  expect(plan.entries).toHaveLength(1);
  return { repo, candidate, plan };
}

async function withReconsiderPreview<T>(candidateId: number, preview: () => Promise<T>): Promise<T> {
  // The real selector limits before our ID filter. Suspend only competing
  // demand for this preview, preserving every source/hash/timestamp column.
  const before = await raw`SELECT to_jsonb(c) AS data FROM crawl_candidates c WHERE id<>${candidateId}
    AND state='rejected' AND reason='no_homepage' AND decided_by='auto' ORDER BY id`;
  if (!before.length) return preview();
  const ids = before.map(row => Number(row.data.id));
  try {
    await raw`UPDATE crawl_candidates SET decided_by=NULL WHERE id=ANY(${ids}::int[])`;
    return await preview();
  } finally {
    await raw`UPDATE crawl_candidates c SET decided_by=s.decided_by
      FROM jsonb_populate_recordset(NULL::crawl_candidates,${raw.json(before.map(row => row.data))}) s WHERE c.id=s.id`;
    const after = await raw`SELECT to_jsonb(c) AS data FROM crawl_candidates c WHERE id=ANY(${ids}::int[]) ORDER BY id`;
    expect(after.map(row => row.data)).toEqual(before.map(row => row.data));
  }
}

beforeAll(async () => {
  ensureSchema();
  const [row] = await raw`SELECT to_jsonb(j) AS data FROM jobs j WHERE name='crawl-fetch'`;
  jobBefore = row?.data;
  await db.insert(crawlCandidates).values({ repo: unrelatedRepo, state: "rejected", reason: "already_listed", decidedBy: "auto" });
  await raw`UPDATE crawl_candidates SET updated_at='2026-09-12 12:34:56.123456'::timestamp WHERE repo=${unrelatedRepo}`;
  unrelatedBefore = (await raw`SELECT to_jsonb(c) AS data FROM crawl_candidates c WHERE repo=${unrelatedRepo}`)[0].data;
});

afterAll(async () => {
  try {
    await raw`DELETE FROM pipeline_item_leases WHERE owner_instance_id=${prefix}`;
    await db.delete(crawlFrontier).where(like(crawlFrontier.repo, `${prefix}/%`));
    await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}/%`));
    await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}/%`));
    await db.delete(products).where(like(products.slug, `${prefix}-%`));
    // Deleting our public products creates purge rows rather than cascading them.
    await raw`DELETE FROM cdn_purges WHERE slug LIKE ${`${prefix}-%`}`;
    expect((await raw`SELECT to_jsonb(c) AS data FROM crawl_candidates c WHERE repo=${unrelatedRepo}`)[0].data).toEqual(unrelatedBefore);
    await db.delete(crawlCandidates).where(eq(crawlCandidates.repo, unrelatedRepo));
    if (jobBefore) {
      await raw`UPDATE jobs SET requested_version=s.requested_version,updated_at=s.updated_at
        FROM jsonb_populate_record(NULL::jobs,${raw.json(jobBefore as postgres.JSONValue)}) s WHERE jobs.name='crawl-fetch'`;
      const [after] = await raw`SELECT to_jsonb(j) AS data FROM jobs j WHERE name='crawl-fetch'`;
      expect(after.data).toEqual(jobBefore);
    } else await raw`DELETE FROM jobs WHERE name='crawl-fetch'`;
    const [remaining] = await raw`SELECT
      (SELECT count(*)::int FROM crawl_candidates WHERE repo LIKE ${`${prefix}/%`}) AS candidates,
      (SELECT count(*)::int FROM crawl_documents WHERE repo LIKE ${`${prefix}/%`}) AS documents,
      (SELECT count(*)::int FROM crawl_frontier WHERE repo LIKE ${`${prefix}/%`}) AS frontiers,
      (SELECT count(*)::int FROM products WHERE slug LIKE ${`${prefix}-%`}) AS products,
      (SELECT count(*)::int FROM cdn_purges WHERE slug LIKE ${`${prefix}-%`}) AS purges,
      (SELECT count(*)::int FROM pipeline_item_leases WHERE owner_instance_id=${prefix}) AS items`;
    expect(remaining).toEqual({ candidates: 0, documents: 0, frontiers: 0, products: 0, purges: 0, items: 0 });
  } finally {
    await Promise.all([raw.end(), blocker.end(), observer.end()]);
  }
});

it("normal reconsider control commits its own candidate, frontier, audit and request", async () => {
  const fixture = await reconsiderFixture("control");
  expect(await applyReconsideration(fixture.plan, prefix)).toEqual({ queued: [fixture.repo], changed: [] });
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, fixture.candidate.id)))[0])
    .toMatchObject({ state: "new", reason: "source_changed" });
  expect(await db.select().from(crawlFrontier).where(eq(crawlFrontier.repo, fixture.repo)))
    .toMatchObject([{ state: "pending", priority: 30 }]);
});

it("crowded selector keeps the scoped reconsider fixture visible behind 2000 unrelated eligible rows", async () => {
  const repos = Array.from({ length: 2_000 }, (_, i) => `${prefix}/crowded-${i}`);
  await db.insert(crawlDocuments).values(repos.map(repo => ({ repo, productUrl: null,
    repoMeta: { stargazers_count: 12, description: "An editor plugin" }, fetchedAt: new Date(Date.now() - 60_000) })));
  await db.insert(crawlCandidates).values(repos.map(repo => ({ repo, state: "rejected" as const, reason: "no_homepage" as const, decidedBy: "auto" })));
  const fixture = await reconsiderFixture("crowded-target");
  expect((await applyReconsideration(fixture.plan, prefix)).queued).toEqual([fixture.repo]);
});

it("reconsider waits for S3 before domain locks, writes or outbox", async () => {
  const fixture = await reconsiderFixture("barrier");
  const before = await ownState(fixture.repo);
  const result = await behindStage(fixture.candidate.id, () => applyReconsideration(fixture.plan, prefix), async () => {
    expect(await ownState(fixture.repo)).toEqual(before);
  });
  expect(result.queued).toEqual([fixture.repo]);
});

async function ownState(repo: string) {
  const [row] = await raw`SELECT jsonb_build_object(
    'candidate',(SELECT to_jsonb(c) FROM crawl_candidates c WHERE repo=${repo}),
    'document',(SELECT to_jsonb(d) FROM crawl_documents d WHERE repo=${repo}),
    'frontier',(SELECT to_jsonb(f) FROM crawl_frontier f WHERE repo=${repo}),
    'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM operations_audit a WHERE target=${repo}),
    'request',(SELECT to_jsonb(j) FROM jobs j WHERE name='crawl-fetch')) AS data`;
  return row.data;
}

async function productFixture(suffix: string) {
  const slug = `${prefix}-${suffix}`;
  const [product] = await db.insert(products).values({ slug, name: "Long product title", url: `https://${slug}.test`,
    repoUrl: `https://github.com/${prefix}/${suffix}`, tagline: "기존 소개", description: "설명", category: "Other",
    source: "crawler", status: "seeded", verifyToken: prefix, editTokenHash: "e" }).returning();
  return product;
}

async function withMode<T>(mode: "items" | "draining", action: () => Promise<T>) {
  const before = await raw`SELECT to_jsonb(s) AS data FROM pipeline_stage_modes s ORDER BY stage`;
  try {
    await raw`UPDATE pipeline_stage_modes SET mode=${mode},draining_from=${mode === "draining" ? "legacy" : null},writer_contract_version=1`;
    return await action();
  } finally {
    for (const row of before) await raw`UPDATE pipeline_stage_modes p SET mode=s.mode,draining_from=s.draining_from,
      writer_contract_version=s.writer_contract_version FROM jsonb_populate_record(NULL::pipeline_stage_modes,${raw.json(row.data)}) s WHERE p.stage=s.stage`;
    expect((await raw`SELECT to_jsonb(s) AS data FROM pipeline_stage_modes s ORDER BY stage`).map(row => row.data))
      .toEqual(before.map(row => row.data));
  }
}

it.each(["items", "draining"] as const)("reconsider remains a controller in %s without altering live item or attempt", async mode => {
  const fixture = await reconsiderFixture(`mode-${mode}`);
  await withMode("items", async () => {
    // These are real logical owners; a source controller invalidates input without settling external work.
    const { claimItemLease, lockItemStage } = await import("@/lib/jobs/items/repository");
    const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, fixture.repo));
    const input = await loadReviewInput(fixture.candidate, document, await getSettings());
    const binding = { stage: "ai1" as const, candidateId: fixture.candidate.id,
      inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
      promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, reviewer: { provider: "fixture", model: "fixture" } };
    const lease = await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "ai1"), binding,
      { instanceId: prefix, bootId: randomUUID() }, 60_000));
    expect(lease).not.toBeNull();
    const [attempt] = await db.insert(crawlReviewAttempts).values({ candidateId: fixture.candidate.id, state: "running",
      ...input, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: "fixture", model: "fixture",
      attemptNumber: 1, leaseToken: lease!.token, validUntil: new Date(Date.now() + 60_000) }).returning();
    const [attemptBefore] = await raw`SELECT to_jsonb(a) AS data FROM crawl_review_attempts a WHERE id=${attempt.id}`;
    if (mode === "draining") await raw`UPDATE pipeline_stage_modes SET mode='draining',draining_from='items'`;
    const [before] = await raw`SELECT to_jsonb(l) AS data FROM pipeline_item_leases l WHERE stage='ai1' AND work_key=${`ai1:${fixture.candidate.id}`}`;
    const result = await applyReconsideration(fixture.plan, prefix);
    expect(result.queued).toEqual([fixture.repo]);
    const product = await productFixture(`mode-tidy-${mode}`);
    const tidy = [{ slug: product.slug, field: "category" as const, before: "Other", after: "Dev" }];
    expect(await applyChanges(tidy)).toEqual({ applied: 1, skipped: 0 });
    expect(await applyChanges(reverse(tidy))).toEqual({ applied: 1, skipped: 0 });
    const names = [{ slug: product.slug, before: product.name, after: "Mode independent name", issues: [] }];
    expect(await applyNameChanges(names)).toEqual(names);
    expect(await applyNameChanges(reverseNameChanges(names))).toEqual(reverseNameChanges(names));
    expect((await raw`SELECT to_jsonb(l) AS data FROM pipeline_item_leases l WHERE stage='ai1' AND work_key=${`ai1:${fixture.candidate.id}`}`)[0].data).toEqual(before.data);
    expect((await raw`SELECT to_jsonb(a) AS data FROM crawl_review_attempts a WHERE id=${attempt.id}`)[0].data).toEqual(attemptBefore.data);
  });
});

it("reconsider source CAS and request-trigger failure preserve the original domain atomically", async () => {
  const stale = await reconsiderFixture("stale");
  await db.update(crawlCandidates).set({ decidedBy: "admin" }).where(eq(crawlCandidates.id, stale.candidate.id));
  const staleBefore = await ownState(stale.repo);
  expect(await applyReconsideration(stale.plan, prefix)).toEqual({ queued: [], changed: [stale.repo] });
  expect(await ownState(stale.repo)).toEqual(staleBefore);
  const fixture = await reconsiderFixture("rollback");
  const before = await ownState(fixture.repo);
  await raw`CREATE FUNCTION pr03d_maint_fail_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.name='crawl-fetch' THEN RAISE EXCEPTION 'pr03d_maint_request_failed'; END IF; RETURN NEW; END $$`;
  try {
    await raw`CREATE TRIGGER pr03d_maint_fail_request BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION pr03d_maint_fail_request()`;
    await expect(applyReconsideration(fixture.plan, prefix)).rejects.toMatchObject({ cause: { message: "pr03d_maint_request_failed" } });
    expect(await ownState(fixture.repo)).toEqual(before);
  } finally {
    await raw`DROP TRIGGER IF EXISTS pr03d_maint_fail_request ON jobs`;
    await raw`DROP FUNCTION pr03d_maint_fail_request()`;
  }
});

it("tidy name/category and reversal acquire S3 before the product CAS", async () => {
  const product = await productFixture("tidy");
  const changes = [
    { slug: product.slug, field: "name" as const, before: product.name, after: "Short name" },
    { slug: product.slug, field: "category" as const, before: "Other", after: "Dev" },
  ];
  expect(await behindStage({ productId: product.id }, () => applyChanges(changes))).toEqual({ applied: 2, skipped: 0 });
  expect(await behindStage({ productId: product.id }, () => applyChanges(reverse(changes)))).toEqual({ applied: 2, skipped: 0 });
  expect((await db.select().from(products).where(eq(products.id, product.id)))[0]).toMatchObject({ name: product.name, category: "Other" });
});

it("name normalization and reversal acquire S3 and preserve a later human CAS change", async () => {
  const product = await productFixture("name");
  const changes = [{ slug: product.slug, before: product.name, after: "Short name", issues: [] }];
  expect(await behindStage({ productId: product.id }, () => applyNameChanges(changes))).toEqual(changes);
  expect(await behindStage({ productId: product.id }, () => applyNameChanges(reverseNameChanges(changes))))
    .toEqual(reverseNameChanges(changes));
  await db.update(products).set({ name: "Human name" }).where(eq(products.id, product.id));
  expect(await applyNameChanges(changes)).toEqual([]);
});

async function starRejudgeCycle(mode: "items" | "draining") {
  const repo = `${prefix}/rejudge-${mode}`;
  await db.insert(crawlDocuments).values({ repo, productUrl: "https://pr03d-star.test", pageStatus: 200,
    repoMeta: { stargazers_count: 5000, owner: { type: "User" }, description: "A useful app", pushed_at: new Date().toISOString() },
    pageMeta: { title: "Star Product", description: "An application for daily work" } });
  const [candidate] = await db.insert(crawlCandidates).values({ repo, state: "rejected", reason: "large_oss", decidedBy: "auto" }).returning();
  await raw`UPDATE crawl_candidates SET updated_at='2026-09-12 12:34:56.123456'::timestamp WHERE id=${candidate.id}`;
  const [saved] = await raw`SELECT to_jsonb(s) AS data FROM crawl_settings s WHERE id=1`;
  const settings = mergeWithDefaults(saved?.data.values);
  try {
    await db.insert(crawlSettings).values({ id: 1, values: { ...settings, judge: { ...settings.judge, maxStars: 99999 } } })
      .onConflictDoUpdate({ target: crawlSettings.id, set: { values: { ...settings, judge: { ...settings.judge, maxStars: 99999 } } } });
    const all = await planStarRejudge();
    const plan = { ...all, entries: all.entries.filter(entry => entry.id === candidate.id) };
    expect(plan.entries).toHaveLength(1);
    const [before] = await raw`SELECT to_jsonb(c) AS data FROM crawl_candidates c WHERE id=${candidate.id}`;
    const receipt = await behindStage(candidate.id, () => applyStarRejudge(plan, () => {}));
    expect(receipt.entries.map(row => row.id)).toEqual([candidate.id]);
    expect(await behindStage(candidate.id, () => revertStarRejudge(receipt))).toEqual({ reverted: 1, skipped: 0 });
    expect((await raw`SELECT to_jsonb(c) AS data FROM crawl_candidates c WHERE id=${candidate.id}`)[0].data).toEqual(before.data);
  } finally {
    if (saved) {
      await raw`UPDATE crawl_settings p SET values=s.values FROM jsonb_populate_record(NULL::crawl_settings,${raw.json(saved.data)}) s WHERE p.id=1`;
      expect((await raw`SELECT to_jsonb(s) AS data FROM crawl_settings s WHERE id=1`)[0].data).toEqual(saved.data);
    } else await raw`DELETE FROM crawl_settings WHERE id=1`;
  }
}
it.each(["items", "draining"] as const)("star rejudge apply/revert wait for S3 in %s and restore the exact PostgreSQL microsecond snapshot",
  async mode => withMode(mode, () => starRejudgeCycle(mode)));

async function duplicateCycle(mode: "items" | "draining") {
  const product = await productFixture(`duplicate-${mode}`);
  const repo = `${prefix}/duplicate-${mode}`;
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: product.url, state: "rejected",
    reason: "already_listed", decidedBy: "auto" }).returning();
  const foreign = await raw`SELECT to_jsonb(c) AS data FROM crawl_candidates c WHERE decided_by='auto'
    AND state='rejected' AND published_slug IS NULL AND repo NOT LIKE ${`${prefix}/%`} AND reason IN ('already_listed','not_a_product')`;
  try {
    for (const row of foreign) await raw`UPDATE crawl_candidates SET decided_by='admin' WHERE id=${row.data.id}`;
    const result = await behindStage(candidate.id, () => reconcileCrawlDuplicates({ actor: prefix, apply: true }));
    expect(result.entries.map(entry => entry.repo)).toEqual([repo]);
    expect(result.updated).toBe(1);
    expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidate.id)))[0].signals)
      .toMatchObject({ existingSlug: product.slug, existingStatus: "seeded" });
  } finally {
    for (const row of foreign) {
      await raw`UPDATE crawl_candidates c SET decided_by=s.decided_by
        FROM jsonb_populate_record(NULL::crawl_candidates,${raw.json(row.data)}) s WHERE c.id=s.id`;
      expect((await raw`SELECT to_jsonb(c) AS data FROM crawl_candidates c WHERE id=${row.data.id}`)[0].data).toEqual(row.data);
    }
  }
}
it.each(["items", "draining"] as const)("duplicate reconciliation waits for S3 in %s while foreign demand is suspended and exactly restored",
  async mode => withMode(mode, () => duplicateCycle(mode)));

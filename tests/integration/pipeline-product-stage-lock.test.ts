import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import postgres from "postgres";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, jobs, pipelineItemLeases, pipelineStageModes, products, secondReviews,
  productAuditCampaigns, productAuditItems, productEvidenceAudit, productEvidenceSources, productHealth,
  productLinks, productRefreshRequests, productRepoReviews, takedownRequests, cdnPurges } from "@/lib/db/schema";
import * as productRepository from "@/lib/domain/products/repository";
import { guardPublication, recordPublicationFailure } from "@/lib/crawl/publication-guard";
import { decidePublishedSecondReview } from "@/lib/crawl/published-second-review";
import { resolveTakedown } from "@/lib/domain/products/takedown";
import { decideRepoReview, delistGoneRepository, type RepoReviewRecord } from "@/lib/domain/products/repo-reviews";
import { autoBanUptimeProduct } from "@/lib/domain/products/uptime-auto-ban";
import { removeAuditedProduct } from "@/lib/crawl/product-audit";
import { applyPurposeRemoval, planPurposeRemovals } from "@/lib/crawl/product-purpose-cleanup";
import { rescanPublishedSpam, type SpamRescanCursor } from "@/lib/jobs/products/spam-rescan";
import { SPAM_DETECTOR_VERSION } from "@/lib/crawl/spam-signals";
import type { JobContext } from "@/lib/jobs/runner";
import { claimItemLease, lockItemStage } from "@/lib/jobs/items/repository";
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { loadReviewInput, ReviewApprovalChangedError } from "@/lib/crawl/agent-review-repository";
import type { JobLease } from "@/lib/jobs/control";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const prefix = "pr03c-product-stage", repo = `${prefix}/project`, slug = `${prefix}-project`;
const jobNames = ["product-evidence-refresh", "crawl-publish", "uptime-ping", "product-repo-review", "product-spam-rescan"];
const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03c-product-stage-blocker", statement_timeout: 8_000 } });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03c-product-stage-observer", statement_timeout: 8_000 } });
let originalJobs: Record<string, unknown>[] = [];
let originalSettings: Record<string, unknown>[] = [];
let originalStages: (typeof pipelineStageModes.$inferSelect)[] = [];
const foreignSlug = `pr03c-foreign-${randomUUID().slice(0, 8)}`, foreignRepo = `pr03c-foreign/${foreignSlug}`;
let foreignProduct: typeof products.$inferSelect;
let foreignJob: typeof jobs.$inferSelect;

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
  throw new Error("product_stage_lock_barrier_timeout");
}
async function clean() {
  const owned = like(products.slug, `${prefix}%`);
  const candidates = await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}/%`));
  if (candidates.length) await db.delete(pipelineItemLeases).where(inArray(pipelineItemLeases.workKey, candidates.map(row => `ai1:${row.id}`)));
  await db.delete(secondReviews).where(like(secondReviews.repo, `${prefix}/%`));
  await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}/%`));
  await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}/%`));
  await db.delete(productAuditItems).where(like(productAuditItems.slug, `${prefix}%`));
  await db.delete(productAuditCampaigns).where(eq(productAuditCampaigns.startedBy, prefix));
  await db.delete(productHealth).where(like(productHealth.slug, `${prefix}%`));
  await db.delete(takedownRequests).where(like(takedownRequests.slug, `${prefix}%`));
  await db.delete(productRefreshRequests).where(like(productRefreshRequests.slug, `${prefix}%`));
  await db.delete(productEvidenceSources).where(like(productEvidenceSources.slug, `${prefix}%`));
  await db.delete(productLinks).where(like(productLinks.slug, `${prefix}%`));
  await db.delete(productEvidenceAudit).where(like(productEvidenceAudit.slug, `${prefix}%`));
  await db.delete(cdnPurges).where(like(cdnPurges.slug, `${prefix}%`));
  await db.delete(products).where(owned);
  await db.delete(cdnPurges).where(like(cdnPurges.slug, `${prefix}%`));
}
beforeAll(async () => {
  ensureSchema();
  originalJobs = (await db.select({ row: sql<Record<string, unknown>>`to_jsonb(${jobs})` })
    .from(jobs).where(inArray(jobs.name, jobNames)).orderBy(jobs.name)).map(({ row }) => row);
  originalSettings = (await db.select({ row: sql<Record<string, unknown>>`to_jsonb(${crawlSettings})` })
    .from(crawlSettings).where(eq(crawlSettings.id, 1))).map(({ row }) => row);
  originalStages = await db.select().from(pipelineStageModes);
  [foreignProduct] = await db.insert(products).values({ ...values(), slug: foreignSlug, url: `https://${foreignSlug}.github.io`,
    repoUrl: `https://github.com/${foreignRepo}` }).returning();
  await db.insert(crawlCandidates).values({ repo: foreignRepo, productUrl: foreignProduct.url,
    state: "published", reason: "passed", decidedBy: "auto", publishedSlug: foreignSlug });
  await db.insert(crawlDocuments).values({ repo: foreignRepo, productUrl: foreignProduct.url, pageStatus: 200,
    repoMeta: { name: "codex-deepseek", owner: { login: "Promisedlandsubtraction2856" }, stargazers_count: 1, has_issues: false },
    pageMeta: { title: "🤖 codex-deepseek - Run Codex on DeepSeek Models", textSample: "Visit this link to download the application." } });
  [foreignJob] = await db.insert(jobs).values({ name: foreignSlug, requestedVersion: 19, processedVersion: 7,
    cursor: { marker: foreignSlug }, notBefore: new Date("2101-01-01T00:00:00.000Z") }).returning();
});
beforeEach(async () => {
  await clean();
  await db.delete(jobs).where(inArray(jobs.name, jobNames));
});
afterEach(async () => {
  for (const stage of originalStages) await db.update(pipelineStageModes).set(stage).where(eq(pipelineStageModes.stage, stage.stage));
  expect((await db.select().from(products).where(eq(products.id, foreignProduct.id)))[0]).toEqual(foreignProduct);
  expect((await db.select().from(jobs).where(eq(jobs.name, foreignJob.name)))[0]).toEqual(foreignJob);
});
afterAll(async () => {
  try {
    await clean();
    for (const stage of originalStages) await db.update(pipelineStageModes).set(stage).where(eq(pipelineStageModes.stage, stage.stage));
    await db.delete(jobs).where(inArray(jobs.name, jobNames));
    if (originalJobs.length) await db.execute(sql`INSERT INTO jobs
      SELECT * FROM jsonb_populate_recordset(NULL::jobs, ${JSON.stringify(originalJobs)}::text::jsonb)`);
    expect((await db.select({ row: sql<Record<string, unknown>>`to_jsonb(${jobs})` }).from(jobs)
      .where(inArray(jobs.name, jobNames)).orderBy(jobs.name)).map(({ row }) => row)).toEqual(originalJobs);
    await db.delete(crawlSettings).where(eq(crawlSettings.id, 1));
    if (originalSettings.length) await db.execute(sql`INSERT INTO crawl_settings
      SELECT * FROM jsonb_populate_recordset(NULL::crawl_settings, ${JSON.stringify(originalSettings)}::text::jsonb)`);
    expect((await db.select({ row: sql<Record<string, unknown>>`to_jsonb(${crawlSettings})` }).from(crawlSettings)
      .where(eq(crawlSettings.id, 1))).map(({ row }) => row)).toEqual(originalSettings);
    await db.delete(crawlCandidates).where(eq(crawlCandidates.repo, foreignRepo));
    await db.delete(crawlDocuments).where(eq(crawlDocuments.repo, foreignRepo));
    await db.delete(products).where(eq(products.slug, foreignSlug));
    await db.delete(cdnPurges).where(eq(cdnPurges.slug, foreignSlug));
    await db.delete(jobs).where(eq(jobs.name, foreignSlug));
  } finally { await Promise.all([blocker.end({ timeout: 3 }), observer.end({ timeout: 3 })]); }
});

function values() {
  return { slug, name: "Stage product", tagline: "A usable project manager", description: "Project manager",
    url: "https://pr03c-product-stage.test", repoUrl: `https://github.com/${repo}`, category: "Dev" as const,
    status: "seeded" as const, source: "crawler" as const, verifyToken: "fixture", editTokenHash: "h".repeat(64) };
}
async function seedProduct() { return (await db.insert(products).values(values()).returning())[0]; }
async function seedCandidate(state: "approved" | "published" = "approved") {
  return (await db.insert(crawlCandidates).values({ repo, productUrl: values().url,
    state, reason: "passed", decidedBy: "auto", publishedSlug: state === "published" ? slug : null }).returning())[0];
}
async function domainAvailable(id?: number) {
  await observer.begin(async tx => {
    const [repository] = await tx`SELECT pg_try_advisory_xact_lock(hashtext(${`product-repository:github:${repo}`})) AS available`;
    expect(repository.available).toBe(true);
    const [generation] = await tx`SELECT pg_try_advisory_xact_lock(hashtext(${`product-lifecycle:${slug}`})) AS available`;
    expect(generation.available).toBe(true);
    if (id !== undefined) {
      await tx`SELECT id FROM products WHERE id=${id} FOR UPDATE NOWAIT`;
      await tx`SELECT product_id FROM product_repo_reviews WHERE product_id=${id} FOR UPDATE NOWAIT`;
      await tx`SELECT id FROM product_audit_items WHERE product_id=${id} FOR UPDATE NOWAIT`;
    }
    await tx`SELECT id FROM crawl_candidates WHERE repo=${repo} FOR UPDATE NOWAIT`;
    await tx`SELECT id FROM crawl_documents WHERE repo=${repo} FOR UPDATE NOWAIT`;
    await tx`SELECT id FROM second_reviews WHERE repo=${repo} FOR UPDATE NOWAIT`;
    await tx`SELECT slug FROM product_health WHERE slug=${slug} FOR UPDATE NOWAIT`;
    await tx`SELECT slug FROM takedown_requests WHERE slug=${slug} FOR UPDATE NOWAIT`;
  });
}
/** Observe an actual wait on the stage controller, before repository/product/candidate locks. */
async function behindStage(action: () => Promise<unknown>, id?: number) {
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
      const [row] = await observer`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND ${pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
      return row.blocked ? "blocked" : undefined;
    });
    expect(state).toBe("blocked");
    await domainAvailable(id);
  } finally {
    release.resolve();
    await holding;
    if (outcome) {
      const result = await outcome;
      if ("error" in result) throw result.error;
    }
  }
}

it("keeps normal product insertion, update, status audit and deletion working", async () => {
  await productRepository.insert(values());
  const product = (await productRepository.findBySlug(slug))!;
  expect(product.repoUrl).toBe(values().repoUrl);
  await productRepository.update(product.id, { name: "Edited project" });
  expect((await productRepository.findBySlug(slug))?.name).toBe("Edited project");
  expect(await productRepository.setStatusWithAudit({ id: product.id, slug, status: "banned", action: "admin.product.ban" })).toBe(true);
  expect(await productRepository.setStatusWithAudit({ id: product.id, slug, status: "seeded", action: "admin.product.unban" })).toBe(true);
  expect(await productRepository.removeProductAndEvidence(product.id, slug)).toBe(true);
  expect(await productRepository.findBySlug(slug)).toBeUndefined();
});
it("locks stages before repository identity and the publication insertion callback", async () => {
  let callbackCalls = 0;
  await behindStage(() => productRepository.insert(values(), async () => { callbackCalls++; }));
  expect(callbackCalls).toBe(1);
  expect(await productRepository.findBySlug(slug)).toBeTruthy();
});
it("locks stages before product update generation", async () => {
  const product = await seedProduct();
  await behindStage(() => productRepository.update(product.id, { name: "Edited project" }), product.id);
  expect((await productRepository.findBySlug(slug))?.name).toBe("Edited project");
});
it("locks stages before product verification generation", async () => {
  const product = await seedProduct();
  await behindStage(() => productRepository.markVerified(product.id, slug, "fixture", {}), product.id);
  expect((await productRepository.findBySlug(slug))?.status).toBe("verified");
});
it("locks stages before product deletion and candidate detachment", async () => {
  const product = await seedProduct();
  const candidate = await seedCandidate("published");
  await behindStage(() => productRepository.removeProductAndEvidence(product.id, slug), product.id);
  expect(await productRepository.findBySlug(slug)).toBeUndefined();
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidate.id)))[0].publishedSlug).toBeNull();
});
it("locks stages before the exported direct product deletion", async () => {
  const product = await seedProduct();
  await behindStage(() => productRepository.remove(product.id), product.id);
  expect(await productRepository.findBySlug(slug)).toBeUndefined();
});
it("locks stages before standalone status and audit generation", async () => {
  const product = await seedProduct();
  await behindStage(() => productRepository.setStatusWithAudit({ id: product.id, slug,
    status: "banned", action: "admin.product.ban" }), product.id);
  expect((await productRepository.findBySlug(slug))?.status).toBe("banned");
});
it("locks stages before recording a publication failure", async () => {
  const candidate = await seedCandidate();
  await behindStage(() => recordPublicationFailure(candidate, { state: "needs_review", reason: "no_description" }));
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidate.id)))[0].state).toBe("needs_review");
});
it("locks stages before a published second-review product and human decision", async () => {
  const product = await seedProduct(), candidate = await seedCandidate("published");
  const [finding] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo,
    publishedSlug: slug, trigger: "risk", firstDecision: "approve", inputHash: "a".repeat(64),
    model: "reviewer", secondDecision: "reject", status: "needs_human" }).returning();
  await behindStage(() => decidePublishedSecondReview({ id: finding.id, slug, decision: "ban", actor: "pr03c-reviewer" }), product.id);
  expect((await productRepository.findBySlug(slug))?.status).toBe("banned");
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, finding.id)))[0].resolution).toBe("banned");
});
it("locks stages before resolving a product takedown", async () => {
  const product = await seedProduct();
  await db.insert(takedownRequests).values({ slug, reason: "Owner requests removal" });
  await behindStage(() => resolveTakedown(slug, "remove", prefix), product.id);
  expect((await productRepository.findBySlug(slug))?.status).toBe("banned");
  expect((await db.select().from(takedownRequests).where(eq(takedownRequests.slug, slug)))[0].outcome).toBe("removed");
});
function repoReviewRecord(productId: number): RepoReviewRecord & { slug: string } {
  return { productId, slug, decision: "delist_candidate", reason: "deployment_gone", answers: null,
    model: null, pageHttpStatus: 404, finalUrl: values().url, pageTitle: null, pageExcerpt: null };
}
it("locks stages before an automatic repository delist", async () => {
  const product = await seedProduct();
  await db.update(products).set({ repoStatus: "not_found", repoCheckedAt: sql`now()`,
    repoMissingSince: sql`now() - interval '2 days'` }).where(eq(products.id, product.id));
  await db.insert(productRepoReviews).values({ productId: product.id, decision: "delist_candidate", reason: "deployment_gone" });
  await behindStage(() => delistGoneRepository(repoReviewRecord(product.id)), product.id);
  expect((await productRepository.findBySlug(slug))?.status).toBe("banned");
});
it("locks stages before an operator repository delist", async () => {
  const product = await seedProduct();
  await db.insert(productRepoReviews).values({ productId: product.id, decision: "delist_candidate", reason: "deployment_gone" });
  await behindStage(() => decideRepoReview({ slug, decision: "delist", by: prefix }), product.id);
  expect((await productRepository.findBySlug(slug))?.status).toBe("banned");
});
it("locks stages before an uptime automatic ban", async () => {
  const product = await seedProduct();
  await db.update(products).set({ updatedAt: sql`now() - interval '8 days'` }).where(eq(products.id, product.id));
  await db.insert(productHealth).values({ slug, failures: 10, status: 404,
    checkedAt: sql`now() - interval '1 minute'`, downSince: sql`now() - interval '3 days'` });
  await behindStage(() => autoBanUptimeProduct(product), product.id);
  expect((await productRepository.findBySlug(slug))?.status).toBe("banned");
});
it("locks stages before an audited product removal", async () => {
  const product = await seedProduct();
  const [campaign] = await db.insert(productAuditCampaigns).values({ startedBy: prefix, reason: "Review a product",
    promptVersion: "fixture", rulesVersion: "fixture", provider: "fixture", model: "fixture", status: "done" }).returning();
  const [item] = await db.insert(productAuditItems).values({ campaignId: campaign.id, productId: product.id, slug,
    aiDecision: "reject", aiReason: "A personal journal" }).returning();
  await behindStage(() => removeAuditedProduct({ itemId: item.id, slug, by: prefix }), product.id);
  expect((await productRepository.findBySlug(slug))?.status).toBe("banned");
  expect((await db.select().from(productAuditItems).where(eq(productAuditItems.id, item.id)))[0].humanDecision).toBe("removed");
});
it("locks stages before a purpose-cleanup product ban", async () => {
  const product = await seedProduct();
  await db.update(products).set({ name: "Personal Research Notes", tagline: "My research journal" }).where(eq(products.id, product.id));
  const plan = (await planPurposeRemovals()).find(row => row.id === product.id)!;
  expect(plan).toBeTruthy();
  await behindStage(() => applyPurposeRemoval(plan), product.id);
  expect((await productRepository.findBySlug(slug))?.status).toBe("banned");
});
it("locks stages before a published spam-rescan ban", async () => {
  const product = await seedProduct();
  await seedCandidate("published");
  await db.insert(crawlDocuments).values({ repo, productUrl: `https://${prefix}.github.io`, pageStatus: 200,
    repoMeta: { name: "codex-deepseek", owner: { login: "Promisedlandsubtraction2856" }, stargazers_count: 1, has_issues: false },
    pageMeta: { title: "🤖 codex-deepseek - Run Codex on DeepSeek Models", textSample: "Visit this link to download the application." } });
  const context: JobContext<SpamRescanCursor> = { cursor: { version: SPAM_DETECTOR_VERSION, afterId: product.id - 1, idleUntil: null },
    save: async () => {}, hasBudget: () => true, log: () => {} };
  await behindStage(() => rescanPublishedSpam(context), product.id);
  expect((await productRepository.findBySlug(slug))?.status).toBe("banned");
});
for (const mode of ["items", "draining"] as const) {
  it(`keeps product input controllers active in ${mode} without releasing a live item or attempt`, async () => {
    const product = await seedProduct(), candidate = await seedCandidate();
    const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: product.url, pageStatus: 200,
      repoMeta: { description: "Project manager" }, pageMeta: { title: "Project manager" } }).returning();
    const input = createReviewInput(candidate, document, mergeWithDefaults({}), { scan: null, observations: [] });
    await db.update(pipelineStageModes).set({ mode: "items", drainingFrom: null, writerContractVersion: 1 })
      .where(eq(pipelineStageModes.stage, "ai1"));
    const binding = { stage: "ai1" as const, candidateId: candidate.id, inputHash: input.inputHash,
      sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
      promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, reviewer: { provider: "fixture", model: "fixture" } };
    const lease = await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "ai1"), binding,
      { instanceId: prefix, bootId: randomUUID() }, 60_000));
    expect(lease).toBeTruthy();
    const [attempt] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, state: "running",
      inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash,
      snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
      provider: "fixture", model: "fixture", attemptNumber: 1, leaseToken: lease!.token, validUntil: input.validUntil }).returning();
    if (mode === "draining") await db.update(pipelineStageModes).set({ mode, drainingFrom: "items" }).where(eq(pipelineStageModes.stage, "ai1"));
    const itemBefore = await db.select().from(pipelineItemLeases).where(eq(pipelineItemLeases.workKey, lease!.workKey));
    await productRepository.update(product.id, { url: "https://pr03c-product-stage-changed.test" });
    expect(await productRepository.setStatusWithAudit({ id: product.id, slug, status: "banned", action: "admin.product.ban" })).toBe(true);
    expect((await productRepository.findBySlug(slug))?.url).toBe("https://pr03c-product-stage-changed.test");
    expect(await db.select().from(pipelineItemLeases).where(eq(pipelineItemLeases.workKey, lease!.workKey))).toEqual(itemBefore);
    expect((await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.id, attempt.id)))[0]).toEqual(attempt);
  });
}

async function workerLease(name: string, expiresSoon = true): Promise<JobLease> {
  const token = randomUUID();
  await db.insert(jobs).values({ name, leaseToken: token, requestedVersion: 1,
    lockedAt: expiresSoon ? sql`(clock_timestamp() at time zone 'UTC') - interval '89 seconds'` : sql`clock_timestamp() at time zone 'UTC'` });
  return { name, token, requestedVersion: 1 };
}

/** Wait for real lock contention, then observe lease expiry on the DB clock. */
async function expireWhileBlocked(lease: JobLease, kind: "stage" | "job" | "generation", action: () => Promise<unknown>) {
  const locked = deferred<number>(), release = deferred<void>();
  const holding = blocker.begin(async tx => {
    if (kind === "stage") await tx`SELECT stage FROM pipeline_stage_modes WHERE stage='ai1' FOR UPDATE`;
    else if (kind === "job") await tx`SELECT name FROM jobs WHERE name=${lease.name} FOR UPDATE`;
    else await tx`SELECT pg_advisory_xact_lock(hashtext(${`product-lifecycle:${slug}`}))`;
    const [row] = await tx`SELECT pg_backend_pid() AS pid`;
    locked.resolve(row.pid);
    await release.promise;
  });
  let outcome: Promise<{ value: unknown } | { error: unknown }> | undefined;
  try {
    const pid = await locked.promise;
    let settled = false;
    outcome = action().then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    expect(await waitFor(async () => {
      if (settled) return "completed";
      const [row] = await observer`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND ${pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
      return row.blocked ? "blocked" : undefined;
    })).toBe("blocked");
    await waitFor(async () => {
      const [row] = await observer`SELECT locked_at < (clock_timestamp() at time zone 'UTC') - interval '90 seconds' AS expired
        FROM jobs WHERE name=${lease.name}`;
      return row?.expired ? true : undefined;
    });
  } finally {
    release.resolve();
    await holding;
    if (outcome) await outcome;
  }
  if (!outcome) throw new Error("product_lease_action_not_started");
  return outcome;
}

function expectLeaseLost(result: { value: unknown } | { error: unknown }) {
  expect(result).toHaveProperty("error");
  if ("error" in result) expect(result.error).toMatchObject({ message: "job_lease_lost" });
}

async function uptimeFixture() {
  const product = await seedProduct();
  await db.update(products).set({ updatedAt: sql`now() - interval '8 days'` }).where(eq(products.id, product.id));
  await db.insert(productHealth).values({ slug, failures: 10, status: 404,
    checkedAt: sql`now() - interval '1 minute'`, downSince: sql`now() - interval '3 days'` });
  return product;
}
async function goneRepositoryFixture(operatorDecision?: "keep") {
  const product = await seedProduct();
  await db.update(products).set({ repoStatus: "not_found", repoCheckedAt: sql`now()`,
    repoMissingSince: sql`now() - interval '2 days'` }).where(eq(products.id, product.id));
  await db.insert(productRepoReviews).values({ productId: product.id, decision: "delist_candidate", reason: "deployment_gone", operatorDecision });
  return product;
}
async function spamFixture() {
  const product = await seedProduct();
  await seedCandidate("published");
  await db.insert(crawlDocuments).values({ repo, productUrl: `https://${prefix}.github.io`, pageStatus: 200,
    repoMeta: { name: "codex-deepseek", owner: { login: "Promisedlandsubtraction2856" }, stargazers_count: 1, has_issues: false },
    pageMeta: { title: "🤖 codex-deepseek - Run Codex on DeepSeek Models", textSample: "Visit this link to download the application." } });
  return product;
}
function spamContext(productId: number, lease: JobLease): JobContext<SpamRescanCursor> {
  return { cursor: { version: SPAM_DETECTOR_VERSION, afterId: productId - 1, idleUntil: null },
    lease, save: async () => {}, hasBudget: () => true, log: () => {} };
}
async function publicationFixture(approved = true) {
  // Exercise real first-review enforcement with a current approval. Do not inherit
  // another suite's reviewer settings or bypass the publication gate for lease tests.
  const settings = mergeWithDefaults({ reviewMode: "enforce",
    firstReview: { provider: "claude-cli", model: "pr03c-test-model" }, secondReview: { enabled: false } });
  await db.insert(crawlSettings).values({ id: 1, values: settings }).onConflictDoUpdate({
    target: crawlSettings.id, set: { values: settings } });
  const candidate = await seedCandidate();
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: candidate.productUrl, pageStatus: 200,
    fetchedAt: sql`(clock_timestamp() at time zone 'UTC') - interval '1 second'`,
    repoMeta: {}, pageMeta: { title: "Project manager", description: "A usable project manager" } }).returning();
  const input = await loadReviewInput(candidate, document, settings);
  if (approved) await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id,
    kind: "automatic", state: "succeeded", inputHash: input.inputHash, policyHash: input.policyHash,
    sourceRevisionHash: input.sourceRevisionHash, snapshot: input.snapshot, source: input.source,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: "claude-cli", model: "pr03c-test-model", attemptNumber: 1,
    outcome: { decision: "approve", reason: "Product description confirmed", evidenceIds: ["product"] },
    validUntil: input.validUntil, startedAt: document.fetchedAt, completedAt: document.fetchedAt });
  return { candidate, document, settings, slug, scanId: null };
}

it("rejects a publication failure when its lease expires during the stage wait", async () => {
  const candidate = await seedCandidate(), lease = await workerLease("crawl-publish");
  expectLeaseLost(await expireWhileBlocked(lease, "stage", () =>
    recordPublicationFailure(candidate, { state: "needs_review", reason: "no_description" }, lease)));
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidate.id)))[0]).toEqual(candidate);
});
it("rejects an uptime ban when its lease expires during the job-row wait", async () => {
  const product = await uptimeFixture(), lease = await workerLease("uptime-ping");
  expectLeaseLost(await expireWhileBlocked(lease, "job", () => autoBanUptimeProduct(product, { lease })));
  expect((await productRepository.findBySlug(slug))?.status).toBe("seeded");
  expect(await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, slug))).toEqual([]);
});
it("rejects an automatic repository delist when its lease expires during the stage wait", async () => {
  const product = await goneRepositoryFixture(), lease = await workerLease("product-repo-review");
  expectLeaseLost(await expireWhileBlocked(lease, "stage", () => delistGoneRepository(repoReviewRecord(product.id), lease)));
  expect((await productRepository.findBySlug(slug))?.status).toBe("seeded");
  expect((await db.select().from(productRepoReviews).where(eq(productRepoReviews.productId, product.id)))[0].operatorDecision).toBeNull();
});
it("rejects repository review refresh in the operator-keep branch after lease expiry", async () => {
  const product = await goneRepositoryFixture("keep"), lease = await workerLease("product-repo-review");
  const before = await db.select().from(productRepoReviews).where(eq(productRepoReviews.productId, product.id));
  expectLeaseLost(await expireWhileBlocked(lease, "stage", () => delistGoneRepository({ ...repoReviewRecord(product.id), reason: "new observation" }, lease)));
  expect(await db.select().from(productRepoReviews).where(eq(productRepoReviews.productId, product.id))).toEqual(before);
});
it("rejects a spam ban when its lease expires during the job-row wait", async () => {
  const product = await spamFixture(), lease = await workerLease("product-spam-rescan");
  expectLeaseLost(await expireWhileBlocked(lease, "job", () => rescanPublishedSpam(spamContext(product.id, lease))));
  expect((await productRepository.findBySlug(slug))?.status).toBe("seeded");
  expect(await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, slug))).toEqual([]);
});
it("rejects normal publication when its lease expires during the stage wait", async () => {
  const input = await publicationFixture(), lease = await workerLease("crawl-publish");
  expectLeaseLost(await expireWhileBlocked(lease, "stage", () =>
    productRepository.insert(values(), tx => guardPublication(tx, { ...input, lease }))));
  expect(await productRepository.findBySlug(slug)).toBeUndefined();
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, input.candidate.id)))[0]).toEqual(input.candidate);
});
it("rejects normal publication after a post-callback generation wait expires its lease", async () => {
  const input = await publicationFixture(), lease = await workerLease("crawl-publish");
  expectLeaseLost(await expireWhileBlocked(lease, "generation", () =>
    productRepository.insert(values(), tx => guardPublication(tx, { ...input, lease }), lease)));
  expect(await productRepository.findBySlug(slug)).toBeUndefined();
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, input.candidate.id)))[0]).toEqual(input.candidate);
  expect(await db.select().from(productRefreshRequests).where(eq(productRefreshRequests.slug, slug))).toEqual([]);
  expect(await db.select().from(jobs).where(eq(jobs.name, "product-evidence-refresh"))).toEqual([]);
});
it("still rejects publication without a current first-review approval", async () => {
  const input = await publicationFixture(false), publisher = await workerLease("crawl-publish", false);
  await expect(productRepository.insert(values(), tx => guardPublication(tx, { ...input, lease: publisher }), publisher))
    .rejects.toBeInstanceOf(ReviewApprovalChangedError);
  expect(await productRepository.findBySlug(slug)).toBeUndefined();
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, input.candidate.id)))[0]).toEqual(input.candidate);
  expect(await db.select().from(productRefreshRequests).where(eq(productRefreshRequests.slug, slug))).toEqual([]);
});
it("keeps healthy worker-authorized product writes working", async () => {
  const input = await publicationFixture(), publisher = await workerLease("crawl-publish", false);
  await productRepository.insert(values(), tx => guardPublication(tx, { ...input, lease: publisher }), publisher);
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, input.candidate.id)))[0].state).toBe("published");
  expect((await db.select().from(productRefreshRequests).where(eq(productRefreshRequests.slug, slug)))[0].requestedVersion).toBe(1);
  expect((await db.select().from(jobs).where(eq(jobs.name, "product-evidence-refresh")))[0].requestedVersion).toBe(1);
});
it("keeps a healthy publisher's failure write working", async () => {
  const candidate = await seedCandidate(), lease = await workerLease("crawl-publish", false);
  expect(await recordPublicationFailure(candidate, { state: "needs_review", reason: "no_description" }, lease)).toBe(true);
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidate.id)))[0].state).toBe("needs_review");
});
it("keeps a healthy uptime worker's ban working", async () => {
  const product = await uptimeFixture(), lease = await workerLease("uptime-ping", false);
  expect(await autoBanUptimeProduct(product, { lease })).toBe(true);
  expect((await productRepository.findBySlug(slug))?.status).toBe("banned");
});
it("keeps a healthy repository worker's delist working", async () => {
  const product = await goneRepositoryFixture(), lease = await workerLease("product-repo-review", false);
  expect(await delistGoneRepository(repoReviewRecord(product.id), lease)).toBe("delisted");
  expect((await productRepository.findBySlug(slug))?.status).toBe("banned");
});
it("keeps a healthy spam worker's ban working", async () => {
  const product = await spamFixture(), lease = await workerLease("product-spam-rescan", false);
  await rescanPublishedSpam(spamContext(product.id, lease));
  expect((await productRepository.findBySlug(slug))?.status).toBe("banned");
});

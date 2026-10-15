import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import postgres from "postgres";
import { eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, crawlCandidates, crawlDocuments, crawlSettings, pipelineItemLeases, products, secondReviews } from "@/lib/db/schema";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { markPublished } from "@/lib/crawl/repository";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";
import { publishedInputHash } from "@/lib/crawl/second-review";
import { lockSecondReviewDomain, secondReviewGeneration } from "@/lib/crawl/second-review-input";
import { secondReviewBinding } from "@/lib/crawl/second-review-ownership";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { removeProductAndEvidence } from "@/lib/domain/products/repository";
import { itemBindingHash } from "@/lib/jobs/items/types";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04-domain-binding-admin" } });
const prefix = "pr04-domain-binding/", slugPrefix = "pr04-domain-binding-";
const settings: CrawlSettings = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
  firstReview: { provider: "abcllm", model: "first-model" },
  secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
    voters: [{ provider: "abcllm", model: "second-model" }], fallbacks: [], sampleRate: 0.5 } };
let sequence = 0, initialized = false;
let originalSettings: unknown[] = [];
let settingsWithSentinel: unknown[] = [];
let originalHasOne = false, insertedSentinel = false;
const sentinelSettingsId = -40491;
let foreignRows: unknown;

async function snapshot() {
  const [row] = await admin`SELECT jsonb_build_object(
    'products', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id), '[]'::jsonb) FROM products p),
    'candidates', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id), '[]'::jsonb) FROM crawl_candidates c),
    'documents', (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id), '[]'::jsonb) FROM crawl_documents d),
    'votes', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id), '[]'::jsonb) FROM second_reviews s),
    'jobs', (SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY name), '[]'::jsonb) FROM jobs j),
    'stages', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY stage), '[]'::jsonb) FROM pipeline_stage_modes s),
    'items', (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY stage, work_key), '[]'::jsonb) FROM pipeline_item_leases i)
    , 'purges', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id), '[]'::jsonb) FROM cdn_purges p)
  ) AS value`;
  return row.value;
}

async function cleanOwnRows() {
  await admin`DELETE FROM pipeline_item_leases WHERE stage='ai2' AND binding->>'candidateId' IN
    (SELECT id::text FROM crawl_candidates WHERE repo LIKE 'pr04-domain-binding/%')`;
  await db.delete(secondReviews).where(like(secondReviews.repo, `${prefix}%`));
  await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
  await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}%`));
  await db.delete(products).where(like(products.slug, `${slugPrefix}%`));
  await db.delete(cdnPurges).where(like(cdnPurges.slug, `${slugPrefix}%`));
  expect(await db.select({ id: cdnPurges.id }).from(cdnPurges).where(like(cdnPurges.slug, `${slugPrefix}%`))).toEqual([]);
}

beforeAll(async () => {
  ensureSchema();
  await cleanOwnRows();
  originalSettings = [...await admin`SELECT to_jsonb(s) AS value FROM crawl_settings s ORDER BY id`].map(row => row.value);
  originalHasOne = (await db.select({ id: crawlSettings.id }).from(crawlSettings).where(eq(crawlSettings.id, 1))).length === 1;
  // Preserve a real non-singleton row, including PostgreSQL microseconds.
  const sentinel = await admin`INSERT INTO crawl_settings (id, values, updated_by, updated_at)
    VALUES (${sentinelSettingsId}, ${JSON.stringify(settings)}::text::jsonb, 'pr04-domain-unrelated',
      timestamp '2001-02-03 04:05:06.123456') ON CONFLICT DO NOTHING RETURNING id`;
  insertedSentinel = sentinel.length === 1;
  settingsWithSentinel = [...await admin`SELECT to_jsonb(s) AS value FROM crawl_settings s ORDER BY id`].map(row => row.value);
  foreignRows = await snapshot();
  initialized = true;
});
beforeEach(async () => {
  await cleanOwnRows();
  await db.insert(crawlSettings).values({ id: 1, values: settings, updatedBy: "pr04-domain-binding" })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings, updatedBy: "pr04-domain-binding" } });
});
afterEach(cleanOwnRows);
afterAll(async () => {
  try {
    if (initialized) {
      await cleanOwnRows();
      if (originalHasOne) await admin`UPDATE crawl_settings current SET values = original.values, updated_by = original.updated_by
        FROM jsonb_populate_recordset(NULL::crawl_settings, ${JSON.stringify(originalSettings)}::text::jsonb) original
        WHERE current.id=1 AND original.id=1`;
      else await db.delete(crawlSettings).where(eq(crawlSettings.id, 1));
      expect([...await admin`SELECT to_jsonb(s) AS value FROM crawl_settings s ORDER BY id`].map(row => row.value)).toEqual(settingsWithSentinel);
      if (insertedSentinel) await db.delete(crawlSettings).where(eq(crawlSettings.id, sentinelSettingsId));
      expect([...await admin`SELECT to_jsonb(s) AS value FROM crawl_settings s ORDER BY id`].map(row => row.value)).toEqual(originalSettings);
      expect(await snapshot()).toEqual(foreignRows);
    }
  } finally { await admin.end({ timeout: 3 }); }
});

async function publishedFixture() {
  const number = ++sequence, slug = `${slugPrefix}${number}`, repo = `${prefix}app-${number}`;
  const productValues = { slug, url: `https://${slug}.example`, repoUrl: `https://github.com/${repo}`,
    name: "Published task tracker", tagline: "Create projects and manage tasks", description: "A deployed task tracker",
    category: "Dev", source: "crawler" as const, status: "seeded" as const,
    verifyToken: `verify-${slug}`, editTokenHash: "a".repeat(64) };
  const [product] = await db.insert(products).values(productValues).returning();
  const fetchedAt = new Date(Date.now() - 2_000);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: product.url, fetchedAt, pageStatus: 200,
    repoMeta: { description: "A deployed task tracker", fork: false, archived: false, stargazers_count: 12,
      pushed_at: fetchedAt.toISOString(), owner: { type: "User" } },
    pageMeta: { title: "Published task tracker", description: "Create projects and manage tasks online",
      textSample: "Create projects and manage tasks in the application.", repositoryKeys: [repo] } }).returning();
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: product.url, state: "approved",
    reason: "passed", decidedBy: "auto", judgedAt: fetchedAt, decidedAt: fetchedAt }).returning();
  await markPublished(repo, slug);
  const [published] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidate.id));
  const input = await loadReviewInput(published, document, settings);
  const [vote] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo, publishedSlug: slug,
    trigger: "sample", firstDecision: "approve", firstAttemptId: null, firstModel: null, firstConfidence: null,
    generationKey: secondReviewGeneration(null, input), inputHash: publishedInputHash(slug),
    provider: "abcllm", model: "second-model", status: "pending" }).returning();
  return { candidate, product, productValues, vote, repo, slug };
}

async function currentBinding(id: number) {
  return db.transaction(async tx => {
    await lockPipelineInputStages(tx);
    const context = await lockSecondReviewDomain(tx, id);
    expect(context).not.toBeNull();
    if (!context) throw new Error("missing_published_domain_control");
    return { binding: secondReviewBinding(context), inputHash: context.input.inputHash,
      sourceRevisionHash: context.input.sourceRevisionHash, generationKey: context.row.generationKey };
  });
}

it("keeps a published binding stable while the actual product generation is unchanged", async () => {
  const fixture = await publishedFixture();
  const first = await currentBinding(fixture.vote.id), repeated = await currentBinding(fixture.vote.id);
  expect(repeated).toEqual(first);
  expect(first.binding.source).toEqual({ kind: "published", slug: fixture.slug, productId: fixture.product.id });
  expect(first.binding.inputHash).not.toBe(fixture.vote.inputHash);
  expect(await db.select({ id: products.id }).from(products).where(eq(products.slug, fixture.slug))).toEqual([{ id: fixture.product.id }]);
});

it("distinguishes a deleted and re-registered product despite the same slug, candidate, input and source", async () => {
  const fixture = await publishedFixture();
  const before = await currentBinding(fixture.vote.id);
  await db.insert(pipelineItemLeases).values({ stage: "ai2", workKey: `ai2:${fixture.vote.id}`,
    binding: before.binding, bindingHash: itemBindingHash(before.binding) });

  expect(await removeProductAndEvidence(fixture.product.id, fixture.slug)).toBe(true);
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, fixture.candidate.id)))[0].publishedSlug).toBeNull();
  const [replacement] = await db.insert(products).values(fixture.productValues).returning();
  expect(replacement.id).not.toBe(fixture.product.id);
  await markPublished(fixture.repo, fixture.slug);
  const after = await currentBinding(fixture.vote.id);
  expect(before.binding.source).toEqual({ kind: "published", slug: fixture.slug, productId: fixture.product.id });
  expect(after.binding.source).toEqual({ kind: "published", slug: fixture.slug, productId: replacement.id });
  expect(after.inputHash).toBe(before.inputHash);
  expect(after.sourceRevisionHash).toBe(before.sourceRevisionHash);
  expect(after.generationKey).toBe(before.generationKey);
  expect(after.binding.policyHash).toBe(before.binding.policyHash);
  expect(after.binding.secondReviewId).toBe(before.binding.secondReviewId);
  expect(await db.select({ id: products.id }).from(products).where(eq(products.slug, fixture.slug))).toEqual([{ id: replacement.id }]);
  const [persisted] = await db.select().from(pipelineItemLeases).where(eq(pipelineItemLeases.workKey, `ai2:${fixture.vote.id}`));
  expect(persisted.binding).toEqual(before.binding);
  expect(after.binding).not.toEqual(persisted.binding);
  expect(itemBindingHash(after.binding)).not.toBe(persisted.bindingHash);
});

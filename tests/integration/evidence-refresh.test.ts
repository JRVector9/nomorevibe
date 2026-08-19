import { and, eq, gt } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db } from "@/lib/db";
import {
  evidenceSettings,
  productEvidenceSources,
  productMedia,
  products,
  productUpdates,
} from "@/lib/db/schema";
import {
  dueEvidenceProductSlugs,
  refreshProductEvidence,
  retryAt,
  type EvidenceRefreshDependencies,
} from "@/lib/domain/evidence/refresh";
import { replaceMakerLinks, upsertObservedSource } from "@/lib/domain/evidence/repository";
import { normalizeImage } from "@/lib/domain/media/images";
import { observeProductMedia } from "@/lib/domain/media/repository";
import { DEFAULT_EVIDENCE_SETTINGS } from "@/lib/domain/evidence/settings";
import { removeProductAndEvidence } from "@/lib/domain/products/repository";
import {
  refreshProductEvidenceJob,
  type EvidenceRefreshCursor,
} from "@/lib/jobs/products/evidence-refresh";
import type { JobContext } from "@/lib/jobs/runner";
import { ensureSchema, resetTables } from "./setup";

const NOW = new Date("2026-08-19T03:00:00.000Z");

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
});

async function product(slug: string) {
  await db.insert(products).values({
    slug,
    url: `https://${slug}.example`,
    name: slug,
    tagline: "Evidence",
    description: "Evidence refresh",
    category: "Dev",
    status: "verified",
    verifyToken: `verify-${slug}`,
    verifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    editTokenHash: "a".repeat(64),
  });
}

async function supportLink(slug: string) {
  await replaceMakerLinks({
    slug,
    actor: "maker:test",
    links: [{ kind: "support", url: `https://${slug}.example/support` }],
  });
}

function context(
  cursor: EvidenceRefreshCursor | null = null,
  hasBudget: () => boolean = () => true,
) {
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  let saved = cursor;
  const ctx: JobContext<EvidenceRefreshCursor> = {
    cursor,
    save: async (next) => { saved = next; },
    hasBudget,
    log: (event, fields) => { logs.push({ event, fields }); },
  };
  return { ctx, logs, saved: () => saved };
}

async function image(color: string) {
  return normalizeImage(await sharp({
    create: { width: 80, height: 50, channels: 3, background: color },
  }).png().toBuffer());
}

describe("bounded product evidence refresh", () => {
  it("selects due products in bounded cursor order and isolates a failed product", async () => {
    for (const slug of ["alpha", "beta", "gamma"]) {
      await product(slug);
      await supportLink(slug);
    }
    await db.insert(evidenceSettings).values({ id: 1, values: { batchSize: 2 } });
    const calls: string[] = [];
    const dependencies: EvidenceRefreshDependencies = {
      now: () => NOW,
      refreshSource: async (source) => {
        calls.push(source.slug);
        if (source.slug === "beta") throw new Error("provider body must not leak");
        return { factsChanged: 1, eventsInserted: 0, mediaInserted: 0 };
      },
    };

    let firstBudgetChecks = 0;
    const first = context(null, () => ++firstBudgetChecks <= 5);
    await expect(refreshProductEvidenceJob(first.ctx, dependencies)).resolves.toEqual({
      done: false,
      cursor: { afterSlug: "beta" },
    });
    expect(calls).toEqual(["alpha", "beta"]);
    expect(first.saved()).toEqual({ afterSlug: "beta" });
    expect(first.logs.at(-1)).toEqual({
      event: "evidence.refresh_batch",
      fields: {
        attempted: 2,
        succeeded: 1,
        failed: 1,
        factsChanged: 1,
        eventsInserted: 0,
        mediaInserted: 0,
      },
    });
    expect(first.logs.filter((entry) => entry.event === "evidence.source_refresh")).toHaveLength(2);
    const [failed] = await db.select().from(productEvidenceSources).where(eq(
      productEvidenceSources.slug,
      "beta",
    ));
    expect(failed).toMatchObject({
      state: "failed",
      attempts: 1,
      lastErrorCode: "collection_failed",
      nextAttemptAt: new Date("2026-08-19T09:00:00.000Z"),
    });

    const second = context({ afterSlug: "beta" });
    await expect(refreshProductEvidenceJob(second.ctx, dependencies)).resolves.toEqual({ done: true });
    expect(calls).toEqual(["alpha", "beta", "gamma"]);
  });

  it("logs a safe product identity and error code for an unexpected refresh failure", async () => {
    await product("job-error");
    await supportLink("job-error");
    const run = context();

    await refreshProductEvidenceJob(run.ctx, {
      now: () => NOW,
      refreshSource: async (source) => {
        const current = await db.query.products.findFirst({
          where: eq(products.slug, source.slug),
        });
        await removeProductAndEvidence(current!.id, source.slug);
        throw new Error("provider secret body");
      },
    });

    expect(run.logs).toContainEqual({
      event: "evidence.product_refresh_failed",
      fields: { slug: "job-error", errorCode: "product_generation_changed" },
    });
    expect(JSON.stringify(run.logs)).not.toContain("provider secret body");
  });

  it("finishes an exact-full final page without waiting for another scheduled invocation", async () => {
    for (const slug of ["alpha", "beta"]) {
      await product(slug);
      await supportLink(slug);
    }
    await db.insert(evidenceSettings).values({ id: 1, values: { batchSize: 2 } });
    const run = context();

    await expect(refreshProductEvidenceJob(run.ctx, {
      now: () => NOW,
      genericLink: async (url) => ({ finalUrl: url }),
    })).resolves.toEqual({ done: true });
    expect(run.saved()).toEqual({ afterSlug: "beta" });
  });

  it("stops between sources at the runner budget and resumes the unfinished product", async () => {
    await product("budgeted");
    await replaceMakerLinks({
      slug: "budgeted",
      actor: "maker:test",
      links: [
        { kind: "support", url: "https://budgeted.example/support" },
        { kind: "rss", url: "https://budgeted.example/feed.xml" },
      ],
    });
    const calls: string[] = [];
    const dependencies: EvidenceRefreshDependencies = {
      now: () => NOW,
      genericLink: async (url) => {
        calls.push("support");
        return { finalUrl: url };
      },
      feed: async (url) => {
        calls.push("rss");
        return { finalUrl: url, items: [] };
      },
    };
    let budgetChecks = 0;
    const first = context(null, () => ++budgetChecks <= 3);

    await expect(refreshProductEvidenceJob(first.ctx, dependencies)).resolves.toEqual({
      done: false,
      cursor: null,
    });
    expect(calls).toEqual(["support"]);
    expect(first.saved()).toBeNull();
    expect(await db.select().from(productEvidenceSources)).toHaveLength(1);

    const second = context();
    await expect(refreshProductEvidenceJob(second.ctx, dependencies)).resolves.toEqual({ done: true });
    expect(calls).toEqual(["support", "rss"]);
    expect(await db.select().from(productEvidenceSources)).toHaveLength(2);
  });

  it("does not advance the product cursor when GitHub stops for job budget", async () => {
    await product("github-budget");
    await replaceMakerLinks({
      slug: "github-budget",
      actor: "maker:test",
      links: [{ kind: "repository", url: "https://github.com/Owner/Repo" }],
    });
    const run = context();

    await expect(refreshProductEvidenceJob(run.ctx, {
      now: () => NOW,
      github: async () => ({ status: "budget_exhausted", releases: 0 }),
    })).resolves.toEqual({ done: false, cursor: null });
    expect(run.saved()).toBeNull();
    expect(await db.select().from(productEvidenceSources)).toHaveLength(0);
  });

  it("skips future sources normally, supports force refresh, and increases bounded retry delay", async () => {
    await product("alpha");
    await supportLink("alpha");
    await upsertObservedSource({
      slug: "alpha",
      kind: "support",
      provider: "support",
      sourceKey: "https://alpha.example/support",
      sourceUrl: "https://alpha.example/support",
      state: "ok",
      normalizedFacts: { type: "link", provider: "support" },
      observedAt: NOW,
      lastSuccessAt: NOW,
      nextAttemptAt: new Date("2026-08-20T03:00:00.000Z"),
    });
    await expect(dueEvidenceProductSlugs({
      now: NOW,
      afterSlug: undefined,
      limit: 20,
      settings: DEFAULT_EVIDENCE_SETTINGS,
    })).resolves.toEqual([]);

    const refreshSource = vi.fn(async () => ({
      factsChanged: 0,
      eventsInserted: 0,
      mediaInserted: 0,
    }));
    await refreshProductEvidence("alpha", {
      force: true,
      now: NOW,
      dependencies: { refreshSource },
    });
    expect(refreshSource).toHaveBeenCalledTimes(1);
    expect(retryAt(NOW, 1, DEFAULT_EVIDENCE_SETTINGS)).toEqual(new Date("2026-08-19T09:00:00.000Z"));
    expect(retryAt(NOW, 2, DEFAULT_EVIDENCE_SETTINGS)).toEqual(new Date("2026-08-19T15:00:00.000Z"));
    expect(retryAt(NOW, 99, DEFAULT_EVIDENCE_SETTINGS)).toEqual(new Date("2026-08-21T03:00:00.000Z"));
  });

  it("marks failed last-known-good facts stale at the configured interval boundary", async () => {
    await product("stale-source");
    await supportLink("stale-source");
    const facts = { type: "link", provider: "support" };
    await upsertObservedSource({
      slug: "stale-source",
      kind: "support",
      provider: "support",
      sourceKey: "https://stale-source.example/support",
      sourceUrl: "https://stale-source.example/support",
      state: "ok",
      normalizedFacts: facts,
      observedAt: new Date("2026-08-17T02:59:59.000Z"),
      lastSuccessAt: new Date("2026-08-17T02:59:59.000Z"),
      nextAttemptAt: NOW,
    });

    const result = await refreshProductEvidence("stale-source", {
      now: NOW,
      dependencies: {
        refreshSource: async () => { throw new Error("provider failed"); },
      },
    });

    expect(result.sourcesFailed).toBe(1);
    const [source] = await db.select().from(productEvidenceSources).where(eq(
      productEvidenceSources.slug,
      "stale-source",
    ));
    expect(source).toMatchObject({
      state: "stale",
      normalizedFacts: facts,
      attempts: 1,
      lastErrorCode: "collection_failed",
    });
  });

  it("persists feed and changed media idempotently while retaining internal bytes", async () => {
    await product("mixed");
    await replaceMakerLinks({
      slug: "mixed",
      actor: "maker:test",
      links: [{ kind: "rss", url: "https://mixed.example/feed.xml" }],
    });
    const purple = await image("#7755ee");
    const green = await image("#22aa77");
    await observeProductMedia({
      slug: "mixed",
      sourceUrl: "https://mixed.example/gallery.png",
      asset: purple,
      altText: "Gallery",
      position: 0,
      observedAt: new Date("2026-08-18T00:00:00.000Z"),
    });
    const dependencies: EvidenceRefreshDependencies = {
      feed: async () => ({
        finalUrl: "https://mixed.example/feed.xml",
        items: [{
          title: "v1.0.0 공개",
          canonicalUrl: "https://mixed.example/releases/v1.0.0",
          summary: "Release",
          externalId: "release-1",
          publishedAt: new Date("2026-08-19T00:00:00.000Z"),
        }],
      }),
      image: async () => ({
        ok: true,
        asset: green,
        finalUrl: "https://mixed.example/gallery.png",
      }),
    };

    await expect(refreshProductEvidence("mixed", {
      force: true,
      now: NOW,
      dependencies,
    })).resolves.toMatchObject({
      sourcesAttempted: 2,
      sourcesFailed: 0,
      factsChanged: 1,
      eventsInserted: 1,
      mediaInserted: 1,
    });
    await expect(refreshProductEvidence("mixed", {
      force: true,
      now: new Date("2026-08-19T04:00:00.000Z"),
      dependencies,
    })).resolves.toMatchObject({
      sourcesAttempted: 2,
      sourcesFailed: 0,
      factsChanged: 0,
      eventsInserted: 0,
      mediaInserted: 0,
    });
    expect(await db.select().from(productUpdates)).toHaveLength(1);
    const media = await db.select().from(productMedia).where(eq(productMedia.slug, "mixed"));
    expect(media).toHaveLength(2);
    expect(media.filter((row) => row.current)).toHaveLength(1);
  });

  it("treats GitHub 304 as success and preserves last-known-good facts", async () => {
    await product("github-304");
    await replaceMakerLinks({
      slug: "github-304",
      actor: "maker:test",
      links: [{ kind: "repository", url: "https://github.com/Owner/Repo" }],
    });
    const facts = { type: "github_repository", stars: 42 };
    await upsertObservedSource({
      slug: "github-304",
      kind: "repository",
      provider: "github",
      sourceKey: "owner/repo",
      sourceUrl: "https://github.com/owner/repo",
      state: "ok",
      normalizedFacts: facts,
      etag: '"repo-v1"',
      observedAt: new Date("2026-08-17T02:59:59.000Z"),
      lastSuccessAt: new Date("2026-08-17T02:59:59.000Z"),
      nextAttemptAt: NOW,
    });

    const result = await refreshProductEvidence("github-304", {
      now: NOW,
      dependencies: {
        github: async () => {
          await upsertObservedSource({
            slug: "github-304",
            kind: "repository",
            provider: "github",
            sourceKey: "owner/repo",
            sourceUrl: "https://github.com/owner/repo",
            state: "ok",
            lastSuccessAt: NOW,
            nextAttemptAt: new Date("2026-08-20T03:00:00.000Z"),
            attempts: 0,
          });
          return { status: "not_modified", releases: 0 };
        },
      },
    });

    expect(result).toMatchObject({ sourcesAttempted: 1, sourcesFailed: 0, factsChanged: 0 });
    const [source] = await db.select().from(productEvidenceSources).where(eq(
      productEvidenceSources.slug,
      "github-304",
    ));
    expect(source.normalizedFacts).toEqual(facts);
    expect(source.lastSuccessAt).toEqual(NOW);
  });

  it("counts a deferred GitHub refresh as failed without replacing provider retry state or good facts", async () => {
    await product("github-deferred");
    await replaceMakerLinks({
      slug: "github-deferred",
      actor: "maker:test",
      links: [{ kind: "repository", url: "https://github.com/Owner/Repo" }],
    });
    const facts = { type: "github_repository", stars: 42 };
    await upsertObservedSource({
      slug: "github-deferred",
      kind: "repository",
      provider: "github",
      sourceKey: "owner/repo",
      sourceUrl: "https://github.com/owner/repo",
      state: "ok",
      normalizedFacts: facts,
      observedAt: new Date("2026-08-17T02:59:59.000Z"),
      lastSuccessAt: new Date("2026-08-17T02:59:59.000Z"),
      nextAttemptAt: NOW,
    });
    const providerRetryAt = new Date("2026-08-19T09:00:00.000Z");

    const result = await refreshProductEvidence("github-deferred", {
      now: NOW,
      dependencies: {
        github: async () => {
          await upsertObservedSource({
            slug: "github-deferred",
            kind: "repository",
            provider: "github",
            sourceKey: "owner/repo",
            sourceUrl: "https://github.com/owner/repo",
            state: "failed",
            lastFailureAt: NOW,
            nextAttemptAt: providerRetryAt,
            attempts: 1,
            lastErrorCode: "rate_limited",
          });
          return { status: "deferred", releases: 0, retryAt: providerRetryAt };
        },
      },
    });

    expect(result).toMatchObject({ sourcesAttempted: 1, sourcesFailed: 1, factsChanged: 0 });
    const [source] = await db.select().from(productEvidenceSources).where(eq(
      productEvidenceSources.slug,
      "github-deferred",
    ));
    expect(source).toMatchObject({
      state: "stale",
      normalizedFacts: facts,
      nextAttemptAt: providerRetryAt,
      attempts: 1,
      lastErrorCode: "rate_limited",
    });
  });

  it("applies shared exponential backoff to transient GitHub failures", async () => {
    await product("github-backoff");
    await replaceMakerLinks({
      slug: "github-backoff",
      actor: "maker:test",
      links: [{ kind: "repository", url: "https://github.com/Owner/Repo" }],
    });
    await upsertObservedSource({
      slug: "github-backoff",
      kind: "repository",
      provider: "github",
      sourceKey: "owner/repo",
      sourceUrl: "https://github.com/owner/repo",
      state: "failed",
      nextAttemptAt: NOW,
      attempts: 1,
      lastErrorCode: "http_500",
    });

    await refreshProductEvidence("github-backoff", {
      now: NOW,
      dependencies: {
        github: async () => {
          await upsertObservedSource({
            slug: "github-backoff",
            kind: "repository",
            provider: "github",
            sourceKey: "owner/repo",
            sourceUrl: "https://github.com/owner/repo",
            state: "failed",
            lastFailureAt: NOW,
            nextAttemptAt: new Date("2026-08-20T03:00:00.000Z"),
            attempts: 2,
            lastErrorCode: "http_500",
          });
          return { status: "deferred", releases: 0 };
        },
      },
    });

    const [source] = await db.select().from(productEvidenceSources).where(eq(
      productEvidenceSources.slug,
      "github-backoff",
    ));
    expect(source.nextAttemptAt).toEqual(new Date("2026-08-19T15:00:00.000Z"));
  });

  it("uses shared backoff when a GitHub rate limit has no reset timestamp", async () => {
    await product("github-rate-no-reset");
    await replaceMakerLinks({
      slug: "github-rate-no-reset",
      actor: "maker:test",
      links: [{ kind: "repository", url: "https://github.com/Owner/Repo" }],
    });
    await upsertObservedSource({
      slug: "github-rate-no-reset",
      kind: "repository",
      provider: "github",
      sourceKey: "owner/repo",
      sourceUrl: "https://github.com/owner/repo",
      state: "failed",
      nextAttemptAt: NOW,
      attempts: 1,
      lastErrorCode: "rate_limited",
    });

    await refreshProductEvidence("github-rate-no-reset", {
      now: NOW,
      dependencies: {
        github: async () => {
          await upsertObservedSource({
            slug: "github-rate-no-reset",
            kind: "repository",
            provider: "github",
            sourceKey: "owner/repo",
            sourceUrl: "https://github.com/owner/repo",
            state: "failed",
            lastFailureAt: NOW,
            nextAttemptAt: new Date("2026-08-20T03:00:00.000Z"),
            attempts: 2,
            lastErrorCode: "rate_limited",
          });
          return { status: "deferred", releases: 0 };
        },
      },
    });

    const [source] = await db.select().from(productEvidenceSources).where(eq(
      productEvidenceSources.slug,
      "github-rate-no-reset",
    ));
    expect(source.nextAttemptAt).toEqual(new Date("2026-08-19T15:00:00.000Z"));
  });

  it("keeps successful source work when another source and media refresh fail", async () => {
    await product("isolated");
    await replaceMakerLinks({
      slug: "isolated",
      actor: "maker:test",
      links: [
        { kind: "support", url: "https://isolated.example/support" },
        { kind: "rss", url: "https://isolated.example/feed.xml" },
      ],
    });
    const stored = await image("#7755ee");
    await observeProductMedia({
      slug: "isolated",
      sourceUrl: "https://isolated.example/gallery.png",
      asset: stored,
      altText: null,
      position: 0,
      observedAt: new Date("2026-08-18T00:00:00.000Z"),
    });
    const completed: string[] = [];
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const result = await refreshProductEvidence("isolated", {
      force: true,
      now: NOW,
      dependencies: {
        refreshSource: async (source) => {
          if (source.kind === "rss") throw new Error("malformed feed body");
          completed.push(source.kind);
          return { factsChanged: 1, eventsInserted: 0, mediaInserted: 0 };
        },
        image: async () => ({ ok: false }),
        log: (event, fields) => logs.push({ event, fields }),
      },
    });

    expect(completed).toEqual(["support"]);
    expect(result).toMatchObject({
      sourcesAttempted: 3,
      sourcesFailed: 2,
      factsChanged: 1,
    });
    const failed = await db.select().from(productEvidenceSources).where(and(
      eq(productEvidenceSources.slug, "isolated"),
      eq(productEvidenceSources.state, "failed"),
    ));
    expect(failed.map((row) => row.kind)).toEqual(["rss"]);
    expect(await db.select().from(productMedia).where(and(
      eq(productMedia.slug, "isolated"),
      gt(productMedia.missingAt, new Date("2026-08-19T02:59:00.000Z")),
    ))).toHaveLength(1);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "evidence.source_refresh",
        fields: expect.objectContaining({
          sourceKind: "media",
          slug: "isolated",
          outcome: "failed",
          httpClass: "error",
          factsChanged: 0,
          eventsInserted: 0,
          mediaInserted: 0,
        }),
      }),
    ]));
  });
});

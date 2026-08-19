import { isDeepStrictEqual } from "node:util";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  evidenceSettings,
  productEvidenceSources,
  productLinks,
  productMedia,
  products,
} from "@/lib/db/schema";
import type { LinkKind } from "@/lib/db/product-evidence-schema";
import { fetchCapped } from "@/lib/net/fetch";
import { fetchAndNormalizeImage } from "@/lib/domain/media/images";
import { markProductMediaMissing, observeProductMedia } from "@/lib/domain/media/repository";
import type { NormalizedImageAsset } from "@/lib/domain/media/storage";
import { evidenceSettingsSchema, type EvidenceSettings } from "./settings";
import { fetchFeedEvidence, feedUpdateCandidates } from "./providers/feeds";
import { refreshGitHubEvidence } from "./providers/github";
import {
  verifyAppStoreLink,
  verifyChangelogLink,
  verifyPackageLink,
  verifyPlayStoreLink,
} from "./providers/links";
import { upsertObservedSource } from "./repository";
import { insertUpdateCandidates } from "./updates";

const slugSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const GENERIC_LINK_CAP = 64 * 1024;
const KINDS = [
  "repository",
  "app_store",
  "play_store",
  "npm",
  "pypi",
  "crates",
  "documentation",
  "support",
  "rss",
  "changelog",
  "video",
] as const satisfies readonly LinkKind[];

export type DeclaredEvidenceSource = {
  slug: string;
  kind: LinkKind;
  sourceKey: string;
  sourceUrl: string;
  attempts: number;
  normalizedFacts: Record<string, unknown> | null;
  lastSuccessAt: Date | null;
};

type MediaSource = {
  slug: string;
  sourceUrl: string;
  altText: string | null;
  position: number;
};

export type EvidenceSourceResult = {
  factsChanged: number;
  eventsInserted: number;
  mediaInserted: number;
};

type CollectedEvidenceSourceResult = EvidenceSourceResult & {
  failed?: boolean;
  httpClass?: "ok" | "not_modified" | "error";
};

export type ProductEvidenceRefreshResult = EvidenceSourceResult & {
  sourcesAttempted: number;
  sourcesFailed: number;
  complete: boolean;
};

export type EvidenceRefreshDependencies = {
  now?: () => Date;
  github?: typeof refreshGitHubEvidence;
  feed?: typeof fetchFeedEvidence;
  appStore?: typeof verifyAppStoreLink;
  playStore?: typeof verifyPlayStoreLink;
  package?: typeof verifyPackageLink;
  changelog?: typeof verifyChangelogLink;
  genericLink?: (url: string) => Promise<{ finalUrl: string } | null>;
  image?: (url: string) => Promise<{ ok: true; asset: NormalizedImageAsset; finalUrl: string } | { ok: false }>;
  refreshSource?: (source: DeclaredEvidenceSource) => Promise<EvidenceSourceResult>;
  log?: (event: string, fields: Record<string, unknown>) => void;
};

export type EvidenceRefreshOptions = {
  force?: boolean;
  now?: Date;
  hasBudget?: () => boolean;
  dependencies?: EvidenceRefreshDependencies;
};

export async function currentEvidenceSettings(): Promise<EvidenceSettings> {
  const row = await db.query.evidenceSettings.findFirst({ where: eq(evidenceSettings.id, 1) });
  return evidenceSettingsSchema.parse(row?.values ?? {});
}

function intervalHours(kind: LinkKind, settings: EvidenceSettings): number {
  if (kind === "repository") return settings.githubFactsHours;
  if (kind === "rss" || kind === "changelog") return settings.releaseFeedHours;
  return settings.linkCheckHours;
}

function failureState(
  source: Pick<DeclaredEvidenceSource, "kind" | "lastSuccessAt">,
  now: Date,
  settings: EvidenceSettings,
): "failed" | "stale" {
  if (!source.lastSuccessAt) return "failed";
  const staleAt = source.lastSuccessAt.getTime()
    + intervalHours(source.kind, settings) * settings.staleAfterIntervals * 60 * 60 * 1000;
  return now.getTime() >= staleAt ? "stale" : "failed";
}

export function retryAt(now: Date, attempts: number, settings: EvidenceSettings): Date {
  const exponent = Math.min(Math.max(0, attempts - 1), settings.maxRetries - 1);
  const delayMinutes = Math.min(7 * 24 * 60, 6 * 60 * (2 ** exponent));
  return new Date(now.getTime() + delayMinutes * 60 * 1000);
}

export async function dueEvidenceProductSlugs(input: {
  afterSlug?: string;
  limit: number;
  now: Date;
  settings: EvidenceSettings;
}): Promise<string[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
  const cursor = input.afterSlug ? slugSchema.parse(input.afterSlug) : null;
  const linkRows = await db.select({ slug: productLinks.slug })
    .from(productLinks)
    .innerJoin(products, eq(products.slug, productLinks.slug))
    .leftJoin(productEvidenceSources, and(
      eq(productEvidenceSources.slug, productLinks.slug),
      eq(productEvidenceSources.kind, productLinks.kind),
      eq(productEvidenceSources.sourceKey, productLinks.normalizedKey),
    ))
    .where(and(
      eq(productLinks.visible, true),
      inArray(products.status, ["verified", "seeded"]),
      cursor ? gt(productLinks.slug, cursor) : undefined,
      or(isNull(productEvidenceSources.id), lte(productEvidenceSources.nextAttemptAt, input.now)),
    ))
    .groupBy(productLinks.slug)
    .orderBy(asc(productLinks.slug))
    .limit(limit);
  const mediaBefore = new Date(input.now.getTime() - input.settings.linkCheckHours * 60 * 60 * 1000);
  const mediaRows = await db.select({ slug: productMedia.slug })
    .from(productMedia)
    .innerJoin(products, eq(products.slug, productMedia.slug))
    .where(and(
      eq(productMedia.current, true),
      inArray(products.status, ["verified", "seeded"]),
      cursor ? gt(productMedia.slug, cursor) : undefined,
      lte(productMedia.lastObservedAt, mediaBefore),
    ))
    .groupBy(productMedia.slug)
    .orderBy(asc(productMedia.slug))
    .limit(limit);
  return [...new Set([...linkRows, ...mediaRows].map((row) => row.slug))]
    .sort()
    .slice(0, limit);
}

async function declaredSources(
  slug: string,
  now: Date,
  force: boolean,
): Promise<DeclaredEvidenceSource[]> {
  const rows = await db.select({
    slug: productLinks.slug,
    kind: productLinks.kind,
    sourceKey: productLinks.normalizedKey,
    sourceUrl: productLinks.url,
    attempts: productEvidenceSources.attempts,
    normalizedFacts: productEvidenceSources.normalizedFacts,
    lastSuccessAt: productEvidenceSources.lastSuccessAt,
    sourceId: productEvidenceSources.id,
    nextAttemptAt: productEvidenceSources.nextAttemptAt,
  })
    .from(productLinks)
    .leftJoin(productEvidenceSources, and(
      eq(productEvidenceSources.slug, productLinks.slug),
      eq(productEvidenceSources.kind, productLinks.kind),
      eq(productEvidenceSources.sourceKey, productLinks.normalizedKey),
    ))
    .where(and(
      eq(productLinks.slug, slug),
      eq(productLinks.visible, true),
    ))
    .orderBy(asc(productLinks.id));
  return rows.flatMap((row) => (
    force || row.sourceId === null || (row.nextAttemptAt && row.nextAttemptAt <= now)
      ? [{
          slug: row.slug,
          kind: row.kind,
          sourceKey: row.sourceKey,
          sourceUrl: row.sourceUrl,
          attempts: row.attempts ?? 0,
          normalizedFacts: row.normalizedFacts ?? null,
          lastSuccessAt: row.lastSuccessAt ?? null,
        }]
      : []
  ));
}

async function mediaSources(
  slug: string,
  now: Date,
  force: boolean,
  settings: EvidenceSettings,
): Promise<MediaSource[]> {
  const dueBefore = new Date(now.getTime() - settings.linkCheckHours * 60 * 60 * 1000);
  return db.select({
    slug: productMedia.slug,
    sourceUrl: productMedia.sourceUrl,
    altText: productMedia.altText,
    position: productMedia.position,
  }).from(productMedia).where(and(
    eq(productMedia.slug, slug),
    eq(productMedia.current, true),
    force ? undefined : lte(productMedia.lastObservedAt, dueBefore),
  )).orderBy(asc(productMedia.position), asc(productMedia.id));
}

async function markSourceFailure(
  source: DeclaredEvidenceSource,
  now: Date,
  settings: EvidenceSettings,
  errorCode: string,
): Promise<void> {
  const attempts = source.attempts + 1;
  await upsertObservedSource({
    slug: source.slug,
    kind: source.kind,
    provider: providerFor(source.kind),
    sourceKey: source.sourceKey,
    sourceUrl: source.sourceUrl,
    state: failureState(source, now, settings),
    lastFailureAt: now,
    nextAttemptAt: retryAt(now, attempts, settings),
    attempts,
    lastErrorCode: errorCode.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80),
  });
}

function providerFor(kind: LinkKind): string {
  if (kind === "repository") return "github";
  if (kind === "app_store") return "apple";
  if (kind === "play_store") return "google_play";
  if (kind === "npm" || kind === "pypi" || kind === "crates") return kind;
  if (kind === "rss") return "feed";
  return kind;
}

async function defaultGenericLink(url: string) {
  const result = await fetchCapped(url, { maxBytes: GENERIC_LINK_CAP });
  return result.ok ? { finalUrl: result.finalUrl } : null;
}

async function collectDeclaredSource(
  source: DeclaredEvidenceSource,
  now: Date,
  settings: EvidenceSettings,
  dependencies: EvidenceRefreshDependencies,
): Promise<CollectedEvidenceSourceResult> {
  if (source.kind === "repository") {
    const result = await (dependencies.github ?? refreshGitHubEvidence)({
      slug: source.slug,
      repository: source.sourceKey,
    }, { now: () => now, log: dependencies.log });
    const refreshed = await db.query.productEvidenceSources.findFirst({
      where: and(
        eq(productEvidenceSources.slug, source.slug),
        eq(productEvidenceSources.kind, source.kind),
        eq(productEvidenceSources.sourceKey, source.sourceKey),
      ),
    });
    const failed = result.status === "deferred" || result.status === "disconnected";
    if (
      result.status === "deferred"
      && refreshed
      && failureState(source, now, settings) === "stale"
    ) {
      await db.update(productEvidenceSources).set({ state: "stale" })
        .where(eq(productEvidenceSources.id, refreshed.id));
    }
    if (refreshed && !failed) {
      await db.update(productEvidenceSources).set({
        nextAttemptAt: new Date(now.getTime() + intervalHours(source.kind, settings) * 60 * 60 * 1000),
      }).where(eq(productEvidenceSources.id, refreshed.id));
    }
    return {
      factsChanged: !isDeepStrictEqual(source.normalizedFacts, refreshed?.normalizedFacts ?? null) ? 1 : 0,
      eventsInserted: result.releases,
      mediaInserted: 0,
      failed,
      httpClass: result.status === "not_modified" ? "not_modified" : failed ? "error" : "ok",
    };
  }

  let facts: Record<string, unknown> | null = null;
  let events = 0;
  if (source.kind === "rss") {
    const feed = await (dependencies.feed ?? fetchFeedEvidence)(source.sourceUrl);
    if (!feed) throw new Error("invalid_feed");
    facts = {
      type: "feed",
      provider: "feed",
      finalUrl: feed.finalUrl,
      itemCount: feed.items.length,
    };
    await db.transaction(async (tx) => {
      await upsertObservedSource({
        slug: source.slug,
        kind: source.kind,
        provider: providerFor(source.kind),
        sourceKey: source.sourceKey,
        sourceUrl: source.sourceUrl,
        state: "ok",
        normalizedFacts: facts,
        observedAt: now,
        lastSuccessAt: now,
        nextAttemptAt: new Date(now.getTime() + intervalHours(source.kind, settings) * 60 * 60 * 1000),
        attempts: 0,
        lastErrorCode: null,
      }, tx);
      events = await insertUpdateCandidates(source.slug, feedUpdateCandidates(feed.items, now), tx);
    });
  } else {
    const value = source.kind === "app_store"
      ? await (dependencies.appStore ?? verifyAppStoreLink)(source.sourceUrl)
      : source.kind === "play_store"
        ? await (dependencies.playStore ?? verifyPlayStoreLink)(source.sourceUrl)
        : source.kind === "npm" || source.kind === "pypi" || source.kind === "crates"
          ? await (dependencies.package ?? verifyPackageLink)(source.kind, source.sourceUrl)
          : source.kind === "changelog"
            ? await (dependencies.changelog ?? verifyChangelogLink)(source.sourceUrl)
            : await (dependencies.genericLink ?? defaultGenericLink)(source.sourceUrl).then((result) => (
                result ? {
                  type: "link" as const,
                  provider: providerFor(source.kind),
                  url: result.finalUrl,
                  evidenceLabel: "링크 확인" as const,
                } : null
              ));
    if (!value) throw new Error("invalid_response");
    facts = value;
    await upsertObservedSource({
      slug: source.slug,
      kind: source.kind,
      provider: providerFor(source.kind),
      sourceKey: source.sourceKey,
      sourceUrl: source.sourceUrl,
      state: "ok",
      normalizedFacts: facts,
      observedAt: now,
      lastSuccessAt: now,
      nextAttemptAt: new Date(now.getTime() + intervalHours(source.kind, settings) * 60 * 60 * 1000),
      attempts: 0,
      lastErrorCode: null,
    });
  }
  return {
    factsChanged: isDeepStrictEqual(source.normalizedFacts, facts) ? 0 : 1,
    eventsInserted: events,
    mediaInserted: 0,
  };
}

async function collectMedia(
  source: MediaSource,
  now: Date,
  dependencies: EvidenceRefreshDependencies,
): Promise<EvidenceSourceResult> {
  const fetched = await (dependencies.image ?? (async (url: string) => {
    const result = await fetchAndNormalizeImage(url);
    return result.ok
      ? { ok: true as const, asset: result.asset, finalUrl: result.finalUrl }
      : { ok: false as const };
  }))(source.sourceUrl);
  if (!fetched.ok) {
    await markProductMediaMissing({ slug: source.slug, sourceUrl: source.sourceUrl, observedAt: now });
    throw new Error("media_unavailable");
  }
  const observed = await observeProductMedia({
    ...source,
    asset: fetched.asset,
    observedAt: now,
  });
  return {
    factsChanged: 0,
    eventsInserted: 0,
    mediaInserted: observed.status === "inserted" || observed.status === "superseded" ? 1 : 0,
  };
}

export async function refreshProductEvidence(
  slugInput: string,
  options: EvidenceRefreshOptions = {},
): Promise<ProductEvidenceRefreshResult> {
  const slug = slugSchema.parse(slugInput);
  const dependencies = options.dependencies ?? {};
  const now = options.now ?? (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error("invalid refresh timestamp");
  const settings = await currentEvidenceSettings();
  const [sources, media] = await Promise.all([
    declaredSources(slug, now, options.force ?? false),
    mediaSources(slug, now, options.force ?? false, settings),
  ]);
  const totals: ProductEvidenceRefreshResult = {
    sourcesAttempted: 0,
    sourcesFailed: 0,
    factsChanged: 0,
    eventsInserted: 0,
    mediaInserted: 0,
    complete: true,
  };

  for (const source of sources) {
    if (options.hasBudget && !options.hasBudget()) {
      totals.complete = false;
      return totals;
    }
    totals.sourcesAttempted += 1;
    const startedAt = performance.now();
    try {
      const result = dependencies.refreshSource
        ? await dependencies.refreshSource(source)
        : await collectDeclaredSource(source, now, settings, dependencies);
      totals.factsChanged += result.factsChanged;
      totals.eventsInserted += result.eventsInserted;
      totals.mediaInserted += result.mediaInserted;
      if ("failed" in result && result.failed) totals.sourcesFailed += 1;
      dependencies.log?.("evidence.source_refresh", {
        sourceKind: source.kind,
        slug,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: "failed" in result && result.failed ? "failed" : "succeeded",
        httpClass: "httpClass" in result ? result.httpClass : "ok",
        factsChanged: result.factsChanged,
        eventsInserted: result.eventsInserted,
        mediaInserted: result.mediaInserted,
      });
    } catch {
      totals.sourcesFailed += 1;
      await markSourceFailure(source, now, settings, "collection_failed");
      dependencies.log?.("evidence.source_refresh", {
        sourceKind: source.kind,
        slug,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: "failed",
        httpClass: "error",
        factsChanged: 0,
        eventsInserted: 0,
        mediaInserted: 0,
      });
    }
  }
  for (const source of media) {
    if (options.hasBudget && !options.hasBudget()) {
      totals.complete = false;
      return totals;
    }
    totals.sourcesAttempted += 1;
    const startedAt = performance.now();
    try {
      const result = await collectMedia(source, now, dependencies);
      totals.mediaInserted += result.mediaInserted;
      dependencies.log?.("evidence.source_refresh", {
        sourceKind: "media",
        slug,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: "succeeded",
        httpClass: "ok",
        factsChanged: 0,
        eventsInserted: 0,
        mediaInserted: result.mediaInserted,
      });
    } catch {
      totals.sourcesFailed += 1;
      dependencies.log?.("evidence.source_refresh", {
        sourceKind: "media",
        slug,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: "failed",
        httpClass: "error",
        factsChanged: 0,
        eventsInserted: 0,
        mediaInserted: 0,
      });
    }
  }
  return totals;
}

export const EVIDENCE_SOURCE_KINDS = KINDS;

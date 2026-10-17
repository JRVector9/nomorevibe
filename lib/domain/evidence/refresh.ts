import { canonicalSourceMode } from "./source-control";
import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  productEvidenceSources,
  productEvidenceAudit,
  productLinks,
  productMedia,
  productMediaDeclarations,
  products,
  productRefreshRequests,
} from "@/lib/db/schema";
import type { LinkKind, ProductRefreshProgress } from "@/lib/db/product-evidence-schema";
import { fetchCapped } from "@/lib/net/fetch";
import { fetchAndNormalizeImage } from "@/lib/domain/media/images";
import { markProductMediaMissing, observeProductMedia } from "@/lib/domain/media/repository";
import type { NormalizedImageAsset } from "@/lib/domain/media/storage";
import {
  withProductGeneration,
  ProductGenerationChangedError,
} from "@/lib/domain/products/generation";
import type { EvidenceSettings } from "./settings";
import { currentEvidenceSettings } from "./settings-store";
import { fetchFeedEvidence, feedUpdateCandidates } from "./providers/feeds";
import { refreshGitHubEvidence, recomputeRepositoryRelationships } from "./providers/github";
import { refreshSiteFingerprint } from "./providers/site-fingerprint";
import {
  verifyAppStoreLink,
  verifyChangelogLink,
  verifyPackageLink,
  verifyPlayStoreLink,
} from "./providers/links";
import { upsertObservedSource } from "./repository";
import { insertUpdateCandidates } from "./updates";
import { normalizeTypedLink, safeHttpUrl } from "./contracts";
import { syncRepositoryLink } from "./repository-link-sync";
import { queueProductRefresh } from "./refresh-requests";
import { assertJobLease, JobLeaseLostError, withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";

const slugSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const GENERIC_LINK_CAP = 64 * 1024;

function publicEvidenceFacts(facts: Record<string, unknown> | null | undefined) {
  return facts ? Object.fromEntries(Object.entries(facts).filter(([key]) => key !== "_githubCollection")) : null;
}

/**
 * 출처 종류별 규칙 한 곳.
 *
 * 이전에는 같은 `kind` 분기가 갱신 주기·provider 이름·검증 함수 선택 세 곳에 흩어져 있어,
 * 종류를 하나 추가할 때 어디를 고쳐야 하는지 코드가 알려주지 않았다. `Record<LinkKind, _>`로
 * 묶어 두면 종류를 빠뜨렸을 때 타입 검사가 먼저 막는다.
 *
 * `repository`와 `rss`는 자체 영속화 경로가 있어 `verify`가 없다 — collectDeclaredSource 참고.
 */
type LinkVerifier = (
  source: DeclaredEvidenceSource,
  dependencies: EvidenceRefreshDependencies,
) => Promise<Record<string, unknown> | null>;

type EvidenceKindSpec = {
  provider: string;
  /** 갱신 간격을 읽어올 설정 필드 */
  interval: "githubFactsHours" | "releaseFeedHours" | "linkCheckHours";
  verify: LinkVerifier | null;
};

const EVIDENCE_KINDS: Record<LinkKind, EvidenceKindSpec> = {
  repository: { provider: "github", interval: "githubFactsHours", verify: null },
  rss: { provider: "feed", interval: "releaseFeedHours", verify: null },
  changelog: {
    provider: "changelog",
    interval: "releaseFeedHours",
    verify: (source, deps) => (deps.changelog ?? verifyChangelogLink)(source.sourceUrl),
  },
  app_store: {
    provider: "apple",
    interval: "linkCheckHours",
    verify: (source, deps) => (deps.appStore ?? verifyAppStoreLink)(source.sourceUrl),
  },
  play_store: {
    provider: "google_play",
    interval: "linkCheckHours",
    verify: (source, deps) => (deps.playStore ?? verifyPlayStoreLink)(source.sourceUrl),
  },
  npm: {
    provider: "npm",
    interval: "linkCheckHours",
    verify: (source, deps) => (deps.package ?? verifyPackageLink)("npm", source.sourceUrl),
  },
  pypi: {
    provider: "pypi",
    interval: "linkCheckHours",
    verify: (source, deps) => (deps.package ?? verifyPackageLink)("pypi", source.sourceUrl),
  },
  crates: {
    provider: "crates",
    interval: "linkCheckHours",
    verify: (source, deps) => (deps.package ?? verifyPackageLink)("crates", source.sourceUrl),
  },
  documentation: { provider: "documentation", interval: "linkCheckHours", verify: verifyGenericLink },
  support: { provider: "support", interval: "linkCheckHours", verify: verifyGenericLink },
  video: { provider: "video", interval: "linkCheckHours", verify: verifyGenericLink },
};

export type DeclaredEvidenceSource = {
  productId: number;
  slug: string;
  kind: LinkKind;
  sourceKey: string;
  sourceUrl: string;
  attempts: number;
  normalizedFacts: Record<string, unknown> | null;
  lastSuccessAt: Date | null;
  retryAt?: Date | null;
};

type MediaSource = {
  productId: number;
  slug: string;
  sourceUrl: string;
  altText: string | null;
  position: number;
  declarationId: number | null;
  declarationRevision: number | null;
};

export type EvidenceSourceResult = {
  factsChanged: number;
  eventsInserted: number;
  mediaInserted: number;
};

type CollectedEvidenceSourceResult = EvidenceSourceResult & {
  failed?: boolean;
  complete?: boolean;
  retryAt?: Date;
  httpClass?: "ok" | "not_modified" | "error" | "budget";
};

export type ProductEvidenceRefreshResult = EvidenceSourceResult & {
  deferred?: "http_origin_permit";
  sourcesAttempted: number;
  sourcesFailed: number;
  complete: boolean;
  nextAttemptAt?: Date;
};

export type EvidenceRefreshDependencies = {
  lease?: JobLease;
  deadlineAt?: number;
  signal?: AbortSignal;
  now?: () => Date;
  github?: typeof refreshGitHubEvidence;
  siteFingerprint?: typeof refreshSiteFingerprint;
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
  lease?: JobLease;
  deadlineAt?: number;
  signal?: AbortSignal;
  force?: boolean;
  now?: Date;
  hasBudget?: () => boolean;
  dependencies?: EvidenceRefreshDependencies;
  productId?: number;
  progress?: ProductRefreshProgress;
  saveProgress?: (progress: ProductRefreshProgress) => Promise<void>;
};

/** A URL or declaration revision change must not inherit another input's completion. */
export function evidenceRefreshKey(source: Pick<DeclaredEvidenceSource, "kind" | "sourceKey" | "sourceUrl">): string {
  return createHash("sha256").update(JSON.stringify(["source", source.kind, source.sourceKey, source.sourceUrl])).digest("hex");
}

export function mediaRefreshKey(source: Pick<MediaSource, "sourceUrl" | "declarationId" | "declarationRevision">): string {
  return createHash("sha256").update(JSON.stringify(["media", source.sourceUrl,
    source.declarationId, source.declarationRevision])).digest("hex");
}

function intervalHours(kind: LinkKind, settings: EvidenceSettings): number {
  return settings[EVIDENCE_KINDS[kind].interval];
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

/** A single recovery intake; collection stays in the existing request lane. */
export async function queueInitialProductEvidenceRefresh(options: {
  lease?: JobLease;
  hasBudget?: () => boolean;
} = {}): Promise<{
  slug: string;
  linkAction: "created" | "updated" | "unchanged";
} | null> {
  const primaryKey = sql<string>`regexp_replace(rtrim(regexp_replace(lower(btrim(${products.repoUrl})),
    '^https?://(www[.])?github[.]com/', ''), '/'), '[.]git$', '')`;
  const [candidate] = await db.select({ productId: products.id, slug: products.slug,
    repositoryKey: primaryKey }).from(products)
    .leftJoin(productLinks, and(eq(productLinks.slug, products.slug), eq(productLinks.kind, "repository"),
      eq(productLinks.normalizedKey, primaryKey)))
    .leftJoin(productEvidenceSources, and(eq(productEvidenceSources.slug, products.slug),
      eq(productEvidenceSources.kind, "repository"), eq(productEvidenceSources.sourceKey, primaryKey)))
    .where(and(
      inArray(products.status, ["seeded", "verified"]),
      sql`btrim(${products.repoUrl}) ~* '^https?://(www[.])?github[.]com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$'`,
      sql`${primaryKey} ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'`,
      sql`${primaryKey} !~ '^([.]{1,2}/|[^/]+/[.]{1,2}$)'`,
      sql`not exists (select 1 from ${productRefreshRequests}
        where ${productRefreshRequests.productId} = ${products.id}
          and ${productRefreshRequests.requestedVersion} > ${productRefreshRequests.completedVersion})`,
      or(
        and(eq(productLinks.visible, true), isNull(productEvidenceSources.id)),
        and(isNull(productLinks.id), eq(products.source, "crawler"), isNull(products.claimedAt),
          sql`not exists (select 1 from ${productEvidenceAudit}
            where ${productEvidenceAudit.slug} = ${products.slug}
              and ${productEvidenceAudit.action} like 'maker.links.%')`),
      ),
    )).orderBy(asc(products.id)).limit(1);
  if (!candidate || (options.hasBudget && !options.hasBudget())) return null;
  return withProductGeneration(candidate.slug, candidate.productId, async tx => {
    if (options.lease) await assertJobLease(tx, options.lease);
    const [product] = await tx.select({ repoUrl: products.repoUrl, status: products.status }).from(products)
      .where(eq(products.id, candidate.productId));
    const repository = product?.repoUrl ? normalizeTypedLink("repository", product.repoUrl) : null;
    if (!product || !["seeded", "verified"].includes(product.status)
      || repository?.normalizedKey !== candidate.repositoryKey) return null;
    const [request] = await tx.select().from(productRefreshRequests)
      .where(eq(productRefreshRequests.productId, candidate.productId)).for("update");
    if (request && request.requestedVersion > request.completedVersion) return null;
    const link = await syncRepositoryLink({ productId: candidate.productId, slug: candidate.slug,
      repoUrl: product.repoUrl, declarationSource: "discovered", mode: "backfill" }, tx);
    if (link.action === "preserved_hidden" || link.action === "review_required") return null;
    const [source] = await tx.select({ id: productEvidenceSources.id }).from(productEvidenceSources).where(and(
      eq(productEvidenceSources.slug, candidate.slug), eq(productEvidenceSources.kind, "repository"),
      eq(productEvidenceSources.sourceKey, candidate.repositoryKey),
    )).limit(1);
    if (source && link.action !== "created") return null;
    await queueProductRefresh({ slug: candidate.slug, productId: candidate.productId,
      actor: "system:evidence_bootstrap", force: false }, tx);
    return { slug: candidate.slug, linkAction: link.action };
  });
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
  const declarationRows = await db.select({ slug: productMediaDeclarations.slug })
    .from(productMediaDeclarations)
    .innerJoin(products, eq(products.slug, productMediaDeclarations.slug))
    .where(and(
      inArray(products.status, ["verified", "seeded"]),
      cursor ? gt(productMediaDeclarations.slug, cursor) : undefined,
      lte(productMediaDeclarations.nextAttemptAt, input.now),
    ))
    .groupBy(productMediaDeclarations.slug)
    .orderBy(asc(productMediaDeclarations.slug))
    .limit(limit);
  const siteRows = await db.select({ slug: products.slug }).from(productEvidenceSources)
    .innerJoin(products, eq(products.slug, productEvidenceSources.slug))
    .where(and(eq(productEvidenceSources.provider, "product_site"), eq(productEvidenceSources.sourceKey, "canonical_site"),
      inArray(products.status, ["verified", "seeded"]), cursor ? gt(products.slug, cursor) : undefined,
      or(lte(productEvidenceSources.nextAttemptAt, input.now), sql`${productEvidenceSources.sourceUrl} is distinct from ${products.url}`)))
    .orderBy(asc(products.slug)).limit(limit);
  return [...new Set([...linkRows, ...mediaRows, ...declarationRows, ...siteRows].map((row) => row.slug))]
    .sort()
    .slice(0, limit);
}

async function canonicalSiteSources(slug: string, now: Date, force: boolean, progress?: ProductRefreshProgress,
  hasBudget: () => boolean = () => true, includeUnobserved = false): Promise<DeclaredEvidenceSource[]> {
  if (!hasBudget()) return [];
  const product = await db.query.products.findFirst({ where: eq(products.slug, slug), columns: { id: true, url: true } });
  if (!hasBudget() || !product) return [];
  // 출처 기록이 거절하는 주소(sslip.io 같은 사설 DNS 별칭)는 관측을 남길 수 없다. 사이트를 먼저 시도하면
  // 매번 기록 단계에서 던져 같은 제품의 다른 출처까지 영영 막으므로 사이트 출처가 없는 것으로 본다.
  if (!safeHttpUrl.safeParse(product.url).success) return [];
  const stored = await db.query.productEvidenceSources.findFirst({ where: and(eq(productEvidenceSources.slug, slug),
    eq(productEvidenceSources.provider, "product_site"), eq(productEvidenceSources.sourceKey, "canonical_site")) });
  if (!hasBudget()) return [];
  if (!stored && !includeUnobserved) {
    const repository = await db.query.productLinks.findFirst({ where: and(eq(productLinks.slug, slug), eq(productLinks.kind, "repository"), eq(productLinks.visible, true)) });
    if (!hasBudget() || !repository) return [];
  }
  const source: DeclaredEvidenceSource = { productId: product.id, slug, kind: "documentation", sourceKey: "canonical_site", sourceUrl: product.url,
    attempts: stored?.attempts ?? 0, normalizedFacts: stored?.normalizedFacts ?? null, lastSuccessAt: stored?.lastSuccessAt ?? null,
    retryAt: stored?.lastErrorCode && stored.sourceUrl === product.url && stored.nextAttemptAt > now ? stored.nextAttemptAt : null };
  return force || !stored || stored.sourceUrl !== product.url || stored.nextAttemptAt <= now || progress?.retryAfterByKey[evidenceRefreshKey(source)]
    ? [source] : [];
}

async function declaredSources(
  slug: string,
  now: Date,
  force: boolean,
  progress?: ProductRefreshProgress,
): Promise<DeclaredEvidenceSource[]> {
  const rows = await db.select({
    productId: products.id,
    slug: productLinks.slug,
    kind: productLinks.kind,
    sourceKey: productLinks.normalizedKey,
    sourceUrl: productLinks.url,
    attempts: productEvidenceSources.attempts,
    normalizedFacts: productEvidenceSources.normalizedFacts,
    lastSuccessAt: productEvidenceSources.lastSuccessAt,
    sourceId: productEvidenceSources.id,
    nextAttemptAt: productEvidenceSources.nextAttemptAt,
    lastErrorCode: productEvidenceSources.lastErrorCode,
  })
    .from(productLinks)
    .innerJoin(products, eq(products.slug, productLinks.slug))
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
      || (progress && (row.lastErrorCode || progress.retryAfterByKey[evidenceRefreshKey(row)]))
      ? [{
          productId: row.productId,
          slug: row.slug,
          kind: row.kind,
          sourceKey: row.sourceKey,
          sourceUrl: row.sourceUrl,
          attempts: row.attempts ?? 0,
          normalizedFacts: row.normalizedFacts ?? null,
          lastSuccessAt: row.lastSuccessAt ?? null,
          retryAt: row.lastErrorCode && row.nextAttemptAt && row.nextAttemptAt > now ? row.nextAttemptAt : null,
        }]
      : []
  ));
}

async function mediaSources(
  slug: string,
  now: Date,
  force: boolean,
  settings: EvidenceSettings,
  progress?: ProductRefreshProgress,
): Promise<MediaSource[]> {
  const dueBefore = new Date(now.getTime() - settings.linkCheckHours * 60 * 60 * 1000);
  const [declared, observed] = await Promise.all([
    db.select({
      productId: products.id,
      slug: productMediaDeclarations.slug,
      sourceUrl: productMediaDeclarations.sourceUrl,
      altText: productMediaDeclarations.altText,
      position: productMediaDeclarations.position,
      declarationId: productMediaDeclarations.id,
      declarationRevision: productMediaDeclarations.revision,
      nextAttemptAt: productMediaDeclarations.nextAttemptAt,
    }).from(productMediaDeclarations)
      .innerJoin(products, eq(products.slug, productMediaDeclarations.slug))
      .where(and(
        eq(productMediaDeclarations.slug, slug),
        force || progress ? undefined : lte(productMediaDeclarations.nextAttemptAt, now),
      )).orderBy(asc(productMediaDeclarations.position), asc(productMediaDeclarations.id)),
    db.select({
      productId: products.id,
      slug: productMedia.slug,
      sourceUrl: productMedia.sourceUrl,
      altText: productMedia.altText,
      position: productMedia.position,
      declarationId: sql<number | null>`null`,
      declarationRevision: sql<number | null>`null`,
      nextAttemptAt: productMedia.lastObservedAt,
    }).from(productMedia)
      .innerJoin(products, eq(products.slug, productMedia.slug))
      .where(and(
        eq(productMedia.slug, slug),
        eq(productMedia.current, true),
        force || progress ? undefined : lte(productMedia.lastObservedAt, dueBefore),
      )).orderBy(asc(productMedia.position), asc(productMedia.id)),
  ]);
  const sources = new Map<string, MediaSource>();
  for (const source of [...declared, ...observed]) {
    const due = source.declarationId === null ? source.nextAttemptAt <= dueBefore : source.nextAttemptAt <= now;
    if (!force && !due && !progress?.retryAfterByKey[mediaRefreshKey(source)]) continue;
    if (!sources.has(source.sourceUrl)) sources.set(source.sourceUrl, source);
  }
  return [...sources.values()];
}

async function markSourceFailure(
  source: DeclaredEvidenceSource,
  now: Date,
  settings: EvidenceSettings,
  errorCode: string,
  lease?: JobLease,
): Promise<void> {
  const attempts = source.attempts + 1;
  await withJobLeaseWrite(lease, tx => upsertObservedSource({
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
  }, tx, source.productId));
}

function providerFor(kind: LinkKind): string {
  return EVIDENCE_KINDS[kind].provider;
}

/** 전용 검증기가 없는 종류(문서·지원·영상)는 도달 여부만 확인한다 */
async function verifyGenericLink(
  source: DeclaredEvidenceSource,
  dependencies: EvidenceRefreshDependencies,
) {
  const result = await (dependencies.genericLink ?? defaultGenericLink)(source.sourceUrl);
  return result
    ? {
        type: "link" as const,
        provider: providerFor(source.kind),
        url: result.finalUrl,
        evidenceLabel: "링크 확인" as const,
      }
    : null;
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
  hasBudget?: () => boolean,
): Promise<CollectedEvidenceSourceResult> {
  if (source.sourceKey === "canonical_site" && source.kind === "documentation") {
    const canContinue = () => (hasBudget?.() ?? true) && !dependencies.signal?.aborted && Date.now() < (dependencies.deadlineAt ?? Infinity);
    const succeeded = await (dependencies.siteFingerprint ?? refreshSiteFingerprint)({ slug: source.slug, productId: source.productId,
      url: source.sourceUrl }, { now, force: true, deadlineAt: dependencies.deadlineAt, signal: dependencies.signal, hasBudget, lease: dependencies.lease });
    if (succeeded === "budget_exhausted" || !canContinue()) return { factsChanged: 0, eventsInserted: 0, mediaInserted: 0, complete: false, httpClass: "budget" };
    if (succeeded) await recomputeRepositoryRelationships(source.slug, source.productId, dependencies.lease, { hasBudget,
      deadlineAt: dependencies.deadlineAt, signal: dependencies.signal });
    if (!canContinue()) return { factsChanged: 0, eventsInserted: 0, mediaInserted: 0, complete: false, httpClass: "budget" };
    const refreshed = await db.query.productEvidenceSources.findFirst({ where: and(eq(productEvidenceSources.slug, source.slug),
      eq(productEvidenceSources.kind, source.kind), eq(productEvidenceSources.sourceKey, source.sourceKey)) });
    return { factsChanged: succeeded && !isDeepStrictEqual(source.normalizedFacts, refreshed?.normalizedFacts) ? 1 : 0,
      eventsInserted: 0, mediaInserted: 0, failed: !succeeded,
      httpClass: succeeded ? "ok" : "error" };
  }
  if (source.kind === "repository") {
    const hardStopped = () => Boolean(dependencies.signal?.aborted) || Date.now() >= (dependencies.deadlineAt ?? Infinity);
    // A supplied GitHub provider owns its network dependencies. The production path
    // records site-to-repository evidence before deriving the GitHub relationship.
    const result = await (dependencies.github ?? refreshGitHubEvidence)({
      slug: source.slug,
      repository: source.sourceKey,
      productId: source.productId,
    }, { now: () => now, hasBudget, log: dependencies.log, deadlineAt: dependencies.deadlineAt, signal: dependencies.signal, lease: dependencies.lease });
    const interrupted: CollectedEvidenceSourceResult = {
      factsChanged: 0,
      eventsInserted: result.releases,
      mediaInserted: 0,
      complete: false,
      httpClass: "budget",
    };
    if (result.status === "budget_exhausted" || hardStopped()) return interrupted;
    const failed = result.status === "deferred" || result.status === "disconnected";
    let sourceRetryAt = result.retryAt ?? undefined;
    const refreshed = await withProductGeneration(source.slug, source.productId, async (tx) => {
      if (hardStopped()) return null;
      const [row] = await tx.select().from(productEvidenceSources).where(and(
        eq(productEvidenceSources.slug, source.slug),
        eq(productEvidenceSources.kind, source.kind),
        eq(productEvidenceSources.sourceKey, source.sourceKey),
      )).limit(1);
      if (hardStopped()) return null;
      if (row && result.status === "deferred") {
        sourceRetryAt = result.retryAt ?? retryAt(now, row.attempts, settings);
        await tx.update(productEvidenceSources).set({
          ...(failureState(source, now, settings) === "stale" ? { state: "stale" as const } : {}),
          nextAttemptAt: sourceRetryAt,
        }).where(eq(productEvidenceSources.id, row.id));
      } else if (row && !failed) {
        await tx.update(productEvidenceSources).set({
          nextAttemptAt: new Date(now.getTime() + intervalHours(source.kind, settings) * 60 * 60 * 1000),
        }).where(eq(productEvidenceSources.id, row.id));
      }
      if (row && result.status === "disconnected") sourceRetryAt = row.nextAttemptAt;
      if (dependencies.lease) await assertJobLease(tx, dependencies.lease);
      return row;
    });
    if (refreshed === null) return interrupted;
    return {
      factsChanged: !isDeepStrictEqual(publicEvidenceFacts(source.normalizedFacts), publicEvidenceFacts(refreshed?.normalizedFacts)) ? 1 : 0,
      eventsInserted: result.releases,
      mediaInserted: 0,
      failed,
      retryAt: sourceRetryAt,
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
      }, tx, source.productId);
      events = await insertUpdateCandidates(
        source.slug,
        feedUpdateCandidates(feed.items, now),
        tx,
        source.productId,
      );
    });
  } else {
    // repository·rss는 위에서 처리되므로 여기 오는 종류는 모두 검증기가 있다
    const verify = EVIDENCE_KINDS[source.kind].verify;
    const value = verify ? await verify(source, dependencies) : null;
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
    }, db, source.productId);
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
    await markProductMediaMissing({
      slug: source.slug,
      sourceUrl: source.sourceUrl,
      observedAt: now,
      productId: source.productId,
    });
    throw new Error("media_unavailable");
  }
  const observed = await observeProductMedia({
    ...source,
    asset: fetched.asset,
    observedAt: now,
    productId: source.productId,
    declarationId: source.declarationId,
    declarationRevision: source.declarationRevision,
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
  const dependencies = { ...options.dependencies,
    deadlineAt: options.deadlineAt ?? options.dependencies?.deadlineAt, signal: options.signal ?? options.dependencies?.signal,
    lease: options.lease ?? options.dependencies?.lease };
  const now = options.now ?? (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error("invalid refresh timestamp");
  const hardStopped = () => Boolean(dependencies.signal?.aborted) || Date.now() >= (dependencies.deadlineAt ?? Infinity);
  const hasBudget = () => (options.hasBudget?.() ?? true) && !hardStopped();
  const totals: ProductEvidenceRefreshResult = {
    sourcesAttempted: 0, sourcesFailed: 0, factsChanged: 0, eventsInserted: 0, mediaInserted: 0, complete: true,
  };
  const stopped = () => ({ ...totals, complete: false, nextAttemptAt: now });
  if (!hasBudget()) return stopped();
  if (options.productId !== undefined) await withProductGeneration(slug, options.productId, async () => {});
  if (!hasBudget()) return stopped();
  const settings = await currentEvidenceSettings();
  if (!hasBudget()) return stopped();
  const progress: ProductRefreshProgress | undefined = options.progress ? {
    completedKeys: [...options.progress.completedKeys], retryAfterByKey: { ...options.progress.retryAfterByKey },
  } : undefined;
  const force = options.force ?? false;
  const sourceMode = await canonicalSourceMode();
  const [declared, site, media] = await Promise.all([
    declaredSources(slug, now, force, progress),
    sourceMode || !dependencies.github || dependencies.siteFingerprint ? canonicalSiteSources(slug, now, force, progress, hasBudget, sourceMode) : [],
    mediaSources(slug, now, force, settings, progress),
  ]);
  if (!hasBudget()) return stopped();
  const sources = [...site, ...declared];
  if (options.productId !== undefined && [...sources, ...media].some(source => source.productId !== options.productId)) {
    throw new ProductGenerationChangedError();
  }
  const completed = new Set(progress?.completedKeys ?? []);
  const persist = async (key: string, retry?: Date) => {
    if (!progress) return;
    if (retry) progress.retryAfterByKey[key] = retry.toISOString();
    else {
      completed.add(key);
      delete progress.retryAfterByKey[key];
    }
    progress.completedKeys = [...completed];
    await options.saveProgress?.(progress);
  };
  const waiting = (key: string) => {
    const retry = progress?.retryAfterByKey[key];
    return retry && new Date(retry) > now;
  };
  const finish = async (budgetEnded = false) => {
    if (budgetEnded || !hasBudget()) {
      // Resume bookkeeping can settle without starting another expired collection read.
      totals.complete = false;
      totals.nextAttemptAt = now;
      if (progress) await options.saveProgress?.(progress);
      return totals;
    }
    if (!progress) return totals;
    // Re-read declarations so an edit during external I/O remains pending in this request.
    const [currentDeclared, currentSite, currentMedia] = await Promise.all([
      declaredSources(slug, now, force, progress),
      sourceMode || !dependencies.github || dependencies.siteFingerprint ? canonicalSiteSources(slug, now, force, progress, hasBudget, sourceMode) : [],
      mediaSources(slug, now, force, settings, progress),
    ]);
    if (!hasBudget()) return finish(true);
    const currentSources = [...currentSite, ...currentDeclared];
    const keys = [...currentSources.map(evidenceRefreshKey), ...currentMedia.map(mediaRefreshKey)];
    const currentKeys = new Set(keys);
    progress.completedKeys = progress.completedKeys.filter(key => currentKeys.has(key));
    progress.retryAfterByKey = Object.fromEntries(Object.entries(progress.retryAfterByKey)
      .filter(([key]) => currentKeys.has(key)));
    const pending = keys.filter(key => !completed.has(key));
    totals.complete = !budgetEnded && pending.length === 0;
    if (!totals.complete) {
      const waits = pending.map(key => new Date(progress.retryAfterByKey[key] ?? now).getTime());
      totals.nextAttemptAt = new Date(Math.max(now.getTime(), Math.min(...waits, ...(budgetEnded ? [now.getTime()] : []))));
    }
    await options.saveProgress?.(progress);
    return totals;
  };

  for (const source of sources) {
    const key = evidenceRefreshKey(source);
    if (completed.has(key) || waiting(key)) continue;
    if (sourceMode && source.kind === "documentation" && source.sourceKey === "canonical_site") {
      totals.complete = false; totals.nextAttemptAt = now; continue;
    }
    if (source.retryAt && source.retryAt > now) {
      // Force bypasses normal freshness intervals, never an upstream failure/cooldown.
      if (progress) await persist(key, source.retryAt);
      else { totals.complete = false; totals.nextAttemptAt = source.retryAt; }
      continue;
    }
    if (!hasBudget()) {
      totals.complete = false;
      return finish(true);
    }
    totals.sourcesAttempted += 1;
    const startedAt = performance.now();
    let retry: Date | undefined;
    let partial = false;
    try {
      const result = dependencies.refreshSource
        ? await dependencies.refreshSource(source)
        : await collectDeclaredSource(source, now, settings, dependencies, hasBudget);
      totals.factsChanged += result.factsChanged;
      totals.eventsInserted += result.eventsInserted;
      totals.mediaInserted += result.mediaInserted;
      const failed = "failed" in result && Boolean(result.failed);
      if (failed) {
        totals.sourcesFailed += 1;
        let nextAttemptAt = "retryAt" in result && result.retryAt instanceof Date ? result.retryAt : undefined;
        if (!hardStopped()) {
          const [stored] = await db.select({ nextAttemptAt: productEvidenceSources.nextAttemptAt })
            .from(productEvidenceSources).where(and(eq(productEvidenceSources.slug, slug),
              eq(productEvidenceSources.kind, source.kind), eq(productEvidenceSources.sourceKey, source.sourceKey))).limit(1);
          if (stored?.nextAttemptAt && stored.nextAttemptAt > now) nextAttemptAt = stored.nextAttemptAt;
        }
        retry = nextAttemptAt && nextAttemptAt > now ? nextAttemptAt : retryAt(now, source.attempts + 1, settings);
      }
      partial = "complete" in result && result.complete === false;
      dependencies.log?.("evidence.source_refresh", {
        sourceKind: source.kind, slug, durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: partial ? "deferred" : failed ? "failed" : "succeeded",
        httpClass: "httpClass" in result ? result.httpClass : "ok",
        factsChanged: result.factsChanged, eventsInserted: result.eventsInserted, mediaInserted: result.mediaInserted,
      });
    } catch (error) {
      if (error instanceof HttpOriginPermitError) {
        totals.sourcesAttempted -= 1;
        totals.deferred = "http_origin_permit";
        return finish(true);
      }
      if (error instanceof ProductGenerationChangedError || error instanceof JobLeaseLostError) throw error;
      // Canonical's writer already owns failure persistence/CAS. A rejected
      // original result must not fall through into a receipt-less failure write.
      if (source.kind === "documentation" && source.sourceKey === "canonical_site") throw error;
      totals.sourcesFailed += 1;
      if (!hardStopped()) await markSourceFailure(source, now, settings, "collection_failed", dependencies.lease);
      retry = retryAt(now, source.attempts + 1, settings);
      dependencies.log?.("evidence.source_refresh", {
        sourceKind: source.kind, slug, durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: "failed", httpClass: "error", factsChanged: 0, eventsInserted: 0, mediaInserted: 0,
      });
    }
    if (partial) { totals.complete = false; return finish(true); }
    // Progress writes sit outside the collector catch: losing ownership must abort the tick.
    await persist(key, retry);
  }
  for (const source of media) {
    const key = mediaRefreshKey(source);
    if (completed.has(key) || waiting(key)) continue;
    if (!hasBudget()) {
      totals.complete = false;
      return finish(true);
    }
    totals.sourcesAttempted += 1;
    const startedAt = performance.now();
    let retry: Date | undefined;
    try {
      const result = await collectMedia(source, now, dependencies);
      if (source.declarationId !== null) {
        await db.update(productMediaDeclarations).set({
          nextAttemptAt: new Date(now.getTime() + settings.linkCheckHours * 60 * 60 * 1_000), updatedAt: now,
        }).where(and(eq(productMediaDeclarations.id, source.declarationId),
          eq(productMediaDeclarations.revision, source.declarationRevision!)));
      }
      totals.mediaInserted += result.mediaInserted;
      dependencies.log?.("evidence.source_refresh", {
        sourceKind: "media", slug, durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: "succeeded", httpClass: "ok", factsChanged: 0, eventsInserted: 0, mediaInserted: result.mediaInserted,
      });
    } catch (error) {
      if (error instanceof HttpOriginPermitError) {
        totals.sourcesAttempted -= 1;
        totals.deferred = "http_origin_permit";
        return finish(true);
      }
      if (error instanceof ProductGenerationChangedError) throw error;
      totals.sourcesFailed += 1;
      retry = new Date(now.getTime() + 6 * 60 * 60 * 1_000);
      if (source.declarationId !== null) {
        await db.update(productMediaDeclarations).set({ nextAttemptAt: retry, updatedAt: now }).where(and(
          eq(productMediaDeclarations.id, source.declarationId), eq(productMediaDeclarations.revision, source.declarationRevision!),
        ));
      }
      dependencies.log?.("evidence.source_refresh", {
        sourceKind: "media", slug, durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: "failed", httpClass: "error", factsChanged: 0, eventsInserted: 0, mediaInserted: 0,
      });
    }
    await persist(key, retry);
  }
  return finish();
}

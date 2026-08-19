import "server-only";

import { cache } from "react";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  mediaAssets,
  productAgents,
  productEvidenceSources,
  productHealth,
  productLinks,
  productMedia,
  productProfiles,
  products,
  productSkills,
  productUpdates,
  rankingEntries,
  rankingSeasons,
  type EvidenceLevel,
  type LinkKind,
  type MakerLicense,
  type Product,
  type ProductAgent,
  type ProductLink,
  type ProductProfile,
  type ProductSkill,
  type ProductUpdateSourceKind,
  type RelationshipState,
  type SourceState,
} from "@/lib/db/schema";
import { currentEvidenceSettings } from "@/lib/domain/evidence/refresh";
import { EVIDENCE_LABELS } from "@/lib/domain/evidence/provenance";
import type { EvidenceSettings } from "@/lib/domain/evidence/settings";
import { parseRankingPolicy } from "@/lib/domain/ranking/policy";
import { healthMetrics, DOWN_THRESHOLD } from "./health";
import { isUnclaimed } from "./view";
import { METRICS_WINDOW_DAYS, visitMetrics, type VisitMetrics } from "./clicks";

const slugSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const MAX_PUBLIC_UPDATES = 50;

export type DetailVisitMetrics = VisitMetrics & { periodDays: typeof METRICS_WINDOW_DAYS };

export type ProductLinkView = Pick<ProductLink,
  "id" | "kind" | "url" | "declarationSource" | "verificationState" | "relationshipState" | "verifiedAt"
> & { evidenceLabel: "공식 출처에서 확인" | "메이커 제공·미검증" | "자동 감지" };

export type RepositoryFactsView = {
  repositoryKey: string | null;
  repositoryUrl: string | null;
  createdAt: string | null;
  pushedAt: string | null;
  updatedAt: string | null;
  stars: number | null;
  forks: number | null;
  public: boolean | null;
  archived: boolean | null;
  fork: boolean | null;
  homepage: string | null;
  contributors: { count: number; incomplete: boolean; cap: number | null } | null;
  license: LicenseValue | null;
  languages: Array<{ name: string; bytes: number; percent: number }>;
  latestRelease: {
    tagName: string;
    name: string;
    url: string | null;
    notesUrl: string | null;
    publishedAt: string | null;
  } | null;
  relationshipState: RelationshipState | null;
};

export type RepositoryEvidenceView = {
  provider: string;
  sourceUrl: string | null;
  state: SourceState;
  observedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  facts: RepositoryFactsView | null;
};

export type LicenseValue = {
  value: string;
  spdxId: string | null;
  url: string | null;
  sourceLabel: string;
};

export type LicensePresentation = {
  state: "matched" | "conflict" | "maker_only" | "observed_only" | "missing";
  label: "GitHub에서 확인" | "정보 충돌" | "메이커 제공·미검증" | "라이선스 확인 안 됨";
  maker: LicenseValue | null;
  observed: LicenseValue | null;
};

export type ProductMediaView = {
  id: number;
  hash: string;
  src: string;
  thumbnailSrc: string;
  width: number;
  height: number;
  thumbnailWidth: number;
  thumbnailHeight: number;
  altText: string;
  position: number;
  sourceMissing: boolean;
  lastSuccessAt: Date;
};

export type ProductUpdateView = {
  id: number;
  sourceKind: ProductUpdateSourceKind;
  sourceLabel: "메이커 업데이트" | "자동 감지";
  canonicalUrl: string | null;
  title: string;
  summary: string | null;
  beforeAfter: Record<string, unknown> | null;
  publishedAt: Date | null;
  observedAt: Date;
  makerEditedAt: Date | null;
};

export type AgentView = ProductAgent & { evidenceLabel: string };
export type SkillView = ProductSkill & { evidenceLabel: string };

export type FreshnessView = {
  kind: LinkKind;
  provider: string;
  state: "collecting" | "current" | "failed" | "delayed" | "stale" | "disconnected";
  label: "집계 중" | "최신" | "최근 갱신 실패" | "갱신 지연" | "오래된 정보" | "연결 끊김";
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  nextAttemptAt: Date;
};

export type PublicProduct = Pick<Product,
  | "id"
  | "slug"
  | "url"
  | "name"
  | "tagline"
  | "description"
  | "category"
  | "builder"
  | "stack"
  | "ogImage"
  | "makerName"
  | "repoUrl"
  | "status"
  | "source"
  | "claimedAt"
  | "verifiedAt"
  | "createdAt"
  | "updatedAt"
>;

export type ProductDetailView = {
  product: PublicProduct;
  unclaimed: boolean;
  rank: { seasonKey: string; rank: number; scoreMode: "valid_visits" | "unique_visitors" } | null;
  visits: DetailVisitMetrics;
  health: {
    uptime30d: number | null;
    latencyMs: number | null;
    checkedAt: Date | null;
    down: boolean;
  };
  profile: ProductProfile | null;
  links: ProductLinkView[];
  repository: RepositoryEvidenceView | null;
  license: LicensePresentation;
  media: ProductMediaView[];
  updates: ProductUpdateView[];
  agents: AgentView[];
  skills: SkillView[];
  freshness: FreshnessView[];
};

async function findPublicProduct(slug: string): Promise<PublicProduct | null> {
  return await db.query.products.findFirst({
    where: and(eq(products.slug, slug), ne(products.status, "banned")),
    columns: {
      id: true,
      slug: true,
      url: true,
      name: true,
      tagline: true,
      description: true,
      category: true,
      builder: true,
      stack: true,
      ogImage: true,
      makerName: true,
      repoUrl: true,
      status: true,
      source: true,
      claimedAt: true,
      verifiedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  }) ?? null;
}

export const getProductIdentity = cache(async (slugInput: string): Promise<PublicProduct | null> => {
  const parsed = slugSchema.safeParse(slugInput);
  if (!parsed.success) return null;
  return findPublicProduct(parsed.data);
});

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, max = 1_000): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function relationship(value: unknown): RelationshipState | null {
  return value === "bidirectional" || value === "site_link" || value === "repository_link"
    || value === "maker_reported" || value === "disconnected"
    ? value
    : null;
}

function licenseValue(
  value: unknown,
  sourceLabel: string,
): LicenseValue | null {
  const item = record(value);
  if (!item) return null;
  const spdxId = text(item.spdxId, 80);
  const name = spdxId ?? text(item.value, 120) ?? text(item.name, 120);
  if (!name) return null;
  return {
    value: text(item.value, 120) ?? text(item.name, 120) ?? name,
    spdxId,
    url: text(item.url),
    sourceLabel,
  };
}

function makerLicense(value: MakerLicense | null): LicenseValue | null {
  if (!value?.value) return null;
  return {
    value: value.value,
    spdxId: value.spdxId ?? null,
    url: value.url ?? null,
    sourceLabel: "메이커 제공·미검증",
  };
}

function sameLicense(left: LicenseValue, right: LicenseValue): boolean {
  const leftIdentity = (left.spdxId ?? left.value).trim().toLocaleLowerCase();
  const rightIdentity = (right.spdxId ?? right.value).trim().toLocaleLowerCase();
  return leftIdentity === rightIdentity;
}

export function presentLicense(
  maker: MakerLicense | null,
  observedValue: unknown,
  provider: string | null,
): LicensePresentation {
  const makerView = makerLicense(maker);
  const observedLabel = provider === "github" ? "GitHub에서 확인" : "공식 출처에서 확인";
  const observed = licenseValue(observedValue, observedLabel);
  if (makerView && observed) {
    return sameLicense(makerView, observed)
      ? { state: "matched", label: "GitHub에서 확인", maker: makerView, observed }
      : { state: "conflict", label: "정보 충돌", maker: makerView, observed };
  }
  if (makerView) {
    return { state: "maker_only", label: "메이커 제공·미검증", maker: makerView, observed: null };
  }
  if (observed) {
    return { state: "observed_only", label: "GitHub에서 확인", maker: null, observed };
  }
  return { state: "missing", label: "라이선스 확인 안 됨", maker: null, observed: null };
}

function contributorView(value: unknown): RepositoryFactsView["contributors"] {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { count: Math.max(0, Math.trunc(value)), incomplete: false, cap: null };
  }
  const item = record(value);
  const count = finite(item?.count);
  if (count === null) return null;
  return {
    count: Math.max(0, Math.trunc(count)),
    incomplete: item?.incomplete === true,
    cap: finite(item?.cap),
  };
}

function languageViews(value: unknown): RepositoryFactsView["languages"] {
  if (!Array.isArray(value)) return [];
  const rows = value.flatMap((entry) => {
    const item = record(entry);
    const name = text(item?.name, 120);
    const bytes = finite(item?.bytes);
    if (!name || bytes === null || bytes < 0) return [];
    return [{ name, bytes: Math.trunc(bytes), percent: finite(item?.percent) }];
  });
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  return rows.map((row) => ({
    name: row.name,
    bytes: row.bytes,
    percent: row.percent ?? (total > 0 ? Math.round((row.bytes / total) * 1_000) / 10 : 0),
  }));
}

function releaseView(value: unknown): RepositoryFactsView["latestRelease"] {
  const item = record(value);
  if (!item) return null;
  const tagName = text(item.tagName, 160) ?? text(item.tag, 160);
  if (!tagName) return null;
  return {
    tagName,
    name: text(item.name, 500) ?? tagName,
    url: text(item.url),
    notesUrl: text(item.notesUrl),
    publishedAt: text(item.publishedAt, 100),
  };
}

function repositoryFacts(
  value: Record<string, unknown> | null,
  sourceKey: string,
  sourceUrl: string | null,
  provider: string,
): RepositoryFactsView | null {
  if (!value || value.type !== "github_repository") return null;
  const publicValue = flag(value.public) ?? (value.visibility === "public" ? true : null);
  return {
    repositoryKey: text(value.repositoryKey, 500) ?? sourceKey,
    repositoryUrl: text(value.repositoryUrl) ?? sourceUrl,
    createdAt: text(value.createdAt, 100),
    pushedAt: text(value.pushedAt, 100),
    updatedAt: text(value.updatedAt, 100),
    stars: finite(value.stars),
    forks: finite(value.forks),
    public: publicValue,
    archived: flag(value.archived),
    fork: flag(value.fork),
    homepage: text(value.homepage),
    contributors: contributorView(value.contributors),
    license: licenseValue(value.license, provider === "github" ? "GitHub에서 확인" : "공식 출처에서 확인"),
    languages: languageViews(value.languages),
    latestRelease: releaseView(value.latestRelease),
    relationshipState: relationship(value.relationshipState ?? value.relationship),
  };
}

function linkEvidenceLabel(link: Pick<ProductLink, "verificationState" | "declarationSource">): ProductLinkView["evidenceLabel"] {
  if (link.verificationState === "ok") return "공식 출처에서 확인";
  return link.declarationSource === "maker" ? "메이커 제공·미검증" : "자동 감지";
}

function intervalHours(kind: LinkKind, settings: EvidenceSettings): number {
  if (kind === "repository") return settings.githubFactsHours;
  if (kind === "rss" || kind === "changelog") return settings.releaseFeedHours;
  return settings.linkCheckHours;
}

export function sourceFreshness(
  source: {
    kind: LinkKind;
    provider: string;
    state: SourceState;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    nextAttemptAt: Date;
  },
  settings: EvidenceSettings,
  now: Date,
): FreshnessView {
  if (source.state === "disconnected") {
    return { ...source, state: "disconnected", label: "연결 끊김" };
  }
  if (source.state === "failed") {
    return { ...source, state: "failed", label: "최근 갱신 실패" };
  }
  if (!source.lastSuccessAt) {
    return { ...source, state: "collecting", label: "집계 중" };
  }
  const age = Math.max(0, now.getTime() - source.lastSuccessAt.getTime());
  const delayedAfter = intervalHours(source.kind, settings) * settings.staleAfterIntervals * HOUR;
  if (age > delayedAfter * 2) {
    return { ...source, state: "stale", label: "오래된 정보" };
  }
  if (source.state === "stale" || age > delayedAfter) {
    return { ...source, state: "delayed", label: "갱신 지연" };
  }
  return { ...source, state: "current", label: "최신" };
}

const HOUR = 60 * 60 * 1_000;

async function activeRank(slug: string): Promise<ProductDetailView["rank"]> {
  const [row] = await db.select({
    seasonKey: rankingSeasons.key,
    rank: rankingEntries.rank,
    policySnapshot: rankingSeasons.policySnapshot,
  }).from(rankingEntries)
    .innerJoin(rankingSeasons, eq(rankingSeasons.id, rankingEntries.seasonId))
    .where(and(eq(rankingEntries.slug, slug), eq(rankingSeasons.state, "active")))
    .orderBy(desc(rankingSeasons.id))
    .limit(1);
  if (!row) return null;
  return {
    seasonKey: row.seasonKey,
    rank: row.rank,
    scoreMode: parseRankingPolicy(row.policySnapshot).scoring.mode,
  };
}

async function detailHealth(slug: string): Promise<ProductDetailView["health"]> {
  const [metrics, current] = await Promise.all([
    healthMetrics([slug], 30),
    db.query.productHealth.findFirst({
      where: eq(productHealth.slug, slug),
      columns: { checkedAt: true, failures: true },
    }),
  ]);
  const metric = metrics.get(slug);
  return {
    uptime30d: metric?.uptimePercent ?? null,
    latencyMs: metric?.latencyMs ?? null,
    checkedAt: current?.checkedAt ?? null,
    down: (current?.failures ?? 0) >= DOWN_THRESHOLD,
  };
}

async function visibleLinks(slug: string): Promise<ProductLinkView[]> {
  const rows = await db.select({
    id: productLinks.id,
    kind: productLinks.kind,
    url: productLinks.url,
    declarationSource: productLinks.declarationSource,
    verificationState: productLinks.verificationState,
    relationshipState: productLinks.relationshipState,
    verifiedAt: productLinks.verifiedAt,
  }).from(productLinks)
    .where(and(eq(productLinks.slug, slug), eq(productLinks.visible, true)))
    .orderBy(asc(productLinks.id));
  return rows.map((link) => ({ ...link, evidenceLabel: linkEvidenceLabel(link) }));
}

async function evidenceSources(slug: string) {
  return db.select({
    id: productEvidenceSources.id,
    kind: productEvidenceSources.kind,
    provider: productEvidenceSources.provider,
    sourceKey: productEvidenceSources.sourceKey,
    sourceUrl: productEvidenceSources.sourceUrl,
    state: productEvidenceSources.state,
    normalizedFacts: productEvidenceSources.normalizedFacts,
    observedAt: productEvidenceSources.observedAt,
    lastSuccessAt: productEvidenceSources.lastSuccessAt,
    lastFailureAt: productEvidenceSources.lastFailureAt,
    nextAttemptAt: productEvidenceSources.nextAttemptAt,
  }).from(productEvidenceSources)
    .innerJoin(productLinks, and(
      eq(productLinks.slug, productEvidenceSources.slug),
      eq(productLinks.kind, productEvidenceSources.kind),
      eq(productLinks.normalizedKey, productEvidenceSources.sourceKey),
      eq(productLinks.visible, true),
    ))
    .where(eq(productEvidenceSources.slug, slug))
    .orderBy(asc(productEvidenceSources.id));
}

async function visibleMedia(slug: string): Promise<ProductMediaView[]> {
  const rows = await db.select({
    id: productMedia.id,
    hash: productMedia.assetHash,
    position: productMedia.position,
    altText: productMedia.altText,
    missingAt: productMedia.missingAt,
    lastSuccessAt: productMedia.lastSuccessAt,
    width: mediaAssets.width,
    height: mediaAssets.height,
    thumbnailWidth: mediaAssets.thumbnailWidth,
    thumbnailHeight: mediaAssets.thumbnailHeight,
  }).from(productMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.hash, productMedia.assetHash))
    .where(and(
      eq(productMedia.slug, slug),
      eq(productMedia.current, true),
      eq(productMedia.visible, true),
    ))
    .orderBy(asc(productMedia.position), asc(productMedia.id))
    .limit(8);
  return rows.map((row) => ({
    id: row.id,
    hash: row.hash,
    src: `/api/media/${row.hash}`,
    thumbnailSrc: `/api/media/${row.hash}?variant=thumbnail`,
    width: row.width,
    height: row.height,
    thumbnailWidth: row.thumbnailWidth,
    thumbnailHeight: row.thumbnailHeight,
    altText: row.altText ?? "제품 화면",
    position: row.position,
    sourceMissing: row.missingAt !== null,
    lastSuccessAt: row.lastSuccessAt,
  }));
}

async function visibleUpdates(slug: string): Promise<ProductUpdateView[]> {
  const rows = await db.select({
    id: productUpdates.id,
    sourceKind: productUpdates.sourceKind,
    canonicalUrl: productUpdates.canonicalUrl,
    title: productUpdates.title,
    summary: productUpdates.summary,
    beforeAfter: productUpdates.beforeAfter,
    publishedAt: productUpdates.publishedAt,
    observedAt: productUpdates.observedAt,
    makerEditedAt: productUpdates.makerEditedAt,
  }).from(productUpdates)
    .where(and(
      eq(productUpdates.slug, slug),
      eq(productUpdates.visible, true),
      isNull(productUpdates.makerDeletedAt),
    ))
    .orderBy(desc(sql`coalesce(${productUpdates.publishedAt}, ${productUpdates.observedAt})`), desc(productUpdates.id))
    .limit(MAX_PUBLIC_UPDATES);
  return rows.map((row) => ({
    ...row,
    sourceLabel: row.sourceKind === "maker" ? "메이커 업데이트" : "자동 감지",
  }));
}

function withEvidenceLabels<T extends { evidenceLevel: EvidenceLevel }>(rows: T[]): Array<T & { evidenceLabel: string }> {
  return rows.map((row) => ({ ...row, evidenceLabel: EVIDENCE_LABELS[row.evidenceLevel] }));
}

async function visibleProvenance(slug: string) {
  const [agents, skills] = await Promise.all([
    db.select().from(productAgents)
      .where(eq(productAgents.slug, slug))
      .orderBy(asc(productAgents.id)),
    db.select().from(productSkills)
      .where(eq(productSkills.slug, slug))
      .orderBy(asc(productSkills.id)),
  ]);
  return { agents, skills };
}

export async function getProductDetail(slugInput: string): Promise<ProductDetailView | null> {
  const product = await getProductIdentity(slugInput);
  if (!product || product.status === "banned") return null;
  const slug = product.slug;
  const now = new Date();
  const [rank, visitMap, health, profile, links, sources, media, updates, provenance, settings] = await Promise.all([
    activeRank(slug),
    visitMetrics([slug], { windowHours: METRICS_WINDOW_DAYS * 24, minimumPreviousUniqueVisitors: 5 }),
    detailHealth(slug),
    db.query.productProfiles.findFirst({ where: eq(productProfiles.slug, slug) }),
    visibleLinks(slug),
    evidenceSources(slug),
    visibleMedia(slug),
    visibleUpdates(slug),
    visibleProvenance(slug),
    currentEvidenceSettings(),
  ]);
  const repositorySource = sources.find((source) => source.kind === "repository") ?? null;
  const facts = repositorySource
    ? repositoryFacts(
        repositorySource.normalizedFacts,
        repositorySource.sourceKey,
        repositorySource.sourceUrl,
        repositorySource.provider,
      )
    : null;
  const visits = visitMap.get(slug) ?? {
    validVisits: 0,
    uniqueVisitors: null,
    uniqueChangePercent: null,
    collectionStartedAt: null,
    collecting: true,
  };
  const currentProduct = await findPublicProduct(slug);
  if (!currentProduct || currentProduct.id !== product.id) return null;

  return {
    product: currentProduct,
    unclaimed: isUnclaimed(currentProduct),
    rank,
    visits: { ...visits, periodDays: METRICS_WINDOW_DAYS },
    health,
    profile: profile ?? null,
    links,
    repository: repositorySource ? {
      provider: repositorySource.provider,
      sourceUrl: repositorySource.sourceUrl,
      state: repositorySource.state,
      observedAt: repositorySource.observedAt,
      lastSuccessAt: repositorySource.lastSuccessAt,
      lastFailureAt: repositorySource.lastFailureAt,
      facts,
    } : null,
    license: presentLicense(profile?.makerLicense ?? null, facts?.license, repositorySource?.provider ?? null),
    media,
    updates,
    agents: withEvidenceLabels(provenance.agents),
    skills: withEvidenceLabels(provenance.skills),
    freshness: sources.map((source) => sourceFreshness(source, settings, now)),
  };
}

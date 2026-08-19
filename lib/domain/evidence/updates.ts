import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { db } from "@/lib/db";
import { productUpdates } from "@/lib/db/schema";
import { extractPageMeta } from "@/lib/net/normalize";
import { safeHttpUrl } from "./contracts";
import { sanitizeExternalSummary } from "./providers/feeds";
import {
  findProductGenerationId,
  lockProductGeneration,
  ProductGenerationChangedError,
} from "@/lib/domain/products/repository";

export type UpdateCandidate = {
  sourceKind: "maker" | "github_release" | "feed" | "site_change" | "repository_change" | "activity_digest";
  dedupeKey: string;
  canonicalUrl: string | null;
  title: string;
  summary: string | null;
  beforeAfter: Record<string, unknown> | null;
  publishedAt: Date | null;
  observedAt: Date;
};

const slugSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const sourceKindSchema = z.enum([
  "maker",
  "github_release",
  "feed",
  "site_change",
  "repository_change",
  "activity_digest",
]);

function jsonWithin(value: Record<string, unknown> | null, bytes: number): boolean {
  if (value === null) return true;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= bytes;
  } catch {
    return false;
  }
}

function canonicalExternalUrl(value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  url.search = "";
  url.hash = "";
  if (url.hostname.toLowerCase() === "www.github.com") url.hostname = "github.com";
  if (url.hostname.toLowerCase() === "github.com") {
    const segments = url.pathname.split("/");
    if (segments.length >= 3) {
      segments[1] = segments[1].toLowerCase();
      segments[2] = segments[2].toLowerCase();
      url.pathname = segments.join("/");
    }
  }
  const parsed = safeHttpUrl.safeParse(url.toString());
  return parsed.success ? parsed.data : null;
}

function normalizedVersion(title: string, canonicalUrl: string | null): string | null {
  let decodedUrl = canonicalUrl ?? "";
  if (canonicalUrl) {
    try {
      decodedUrl = decodeURIComponent(canonicalUrl);
    } catch {
      decodedUrl = canonicalUrl;
    }
  }
  const values = [decodedUrl, title];
  for (const value of values) {
    const match = value.match(/(?:^|[^a-z0-9])v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9a-z.-]+)?)(?:$|[^a-z0-9])/i);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function releaseDedupeKey(candidate: UpdateCandidate, canonicalUrl: string | null, title: string): string | null {
  if (candidate.sourceKind !== "github_release" && candidate.sourceKind !== "feed") return null;
  const version = normalizedVersion(title, canonicalUrl);
  if (!canonicalUrl || !version) return null;
  const identity = createHash("sha256").update(canonicalUrl).update("\0").update(version).digest("hex");
  return `release:${identity}`;
}

export function normalizeUpdateCandidate(input: UpdateCandidate): UpdateCandidate {
  const sourceKind = sourceKindSchema.parse(input.sourceKind);
  const title = sanitizeExternalSummary(input.title)?.slice(0, 500);
  if (!title) throw new Error("update title is required");
  if (!Number.isFinite(input.observedAt.getTime())) throw new Error("invalid observedAt");
  if (input.publishedAt && !Number.isFinite(input.publishedAt.getTime())) throw new Error("invalid publishedAt");
  if (!jsonWithin(input.beforeAfter, 32 * 1024)) throw new Error("update beforeAfter is too large");
  const canonicalUrl = canonicalExternalUrl(input.canonicalUrl);
  if (input.canonicalUrl && !canonicalUrl) throw new Error("invalid canonicalUrl");
  const suppliedKey = input.dedupeKey.trim().slice(0, 500);
  if (!suppliedKey) throw new Error("update dedupeKey is required");
  const dedupeKey = releaseDedupeKey(input, canonicalUrl, title) ?? suppliedKey;
  return {
    sourceKind,
    dedupeKey,
    canonicalUrl,
    title,
    summary: sanitizeExternalSummary(input.summary),
    beforeAfter: input.beforeAfter,
    publishedAt: input.publishedAt,
    observedAt: input.observedAt,
  };
}

export type SiteFingerprint = {
  type: "site_fingerprint";
  title: string | null;
  description: string | null;
  headings: string[];
};

function headingText(value: string): string | null {
  return sanitizeExternalSummary(value)?.slice(0, 300) ?? null;
}

export function meaningfulSiteFingerprint(html: string): SiteFingerprint {
  const metadata = extractPageMeta(html.slice(0, 512 * 1024), "https://evidence.invalid");
  const headings: string[] = [];
  for (const match of html.slice(0, 512 * 1024).matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]\s*>/gi)) {
    const value = headingText(match[1]);
    if (!value || headings.includes(value)) continue;
    headings.push(value);
    if (headings.length === 12) break;
  }
  return {
    type: "site_fingerprint",
    title: headingText(metadata.title ?? ""),
    description: headingText(metadata.description ?? ""),
    headings,
  };
}

export function sameMeaningfulSiteFingerprint(
  before: SiteFingerprint,
  after: SiteFingerprint,
): boolean {
  return isDeepStrictEqual(before, after);
}

export function siteChangeCandidate(
  before: SiteFingerprint,
  after: SiteFingerprint,
  canonicalUrl: string,
  observedAt: Date,
): UpdateCandidate | null {
  if (sameMeaningfulSiteFingerprint(before, after)) return null;
  const change = { before, after };
  const identity = createHash("sha256").update(JSON.stringify(change)).digest("hex");
  return normalizeUpdateCandidate({
    sourceKind: "site_change",
    dedupeKey: `site:${identity}`,
    canonicalUrl,
    title: "서비스 소개 변경",
    summary: null,
    beforeAfter: change,
    publishedAt: null,
    observedAt,
  });
}

export type RepositoryUpdateFacts = {
  stars: number;
  forks: number;
  license: string | null;
  archived: boolean;
  public: boolean;
  relationshipState: string;
};

export type RepositoryActivityThresholds = {
  starsAbsolute: number;
  starsPercent: number;
  forksAbsolute: number;
  forksPercent: number;
};

const DEFAULT_THRESHOLDS: RepositoryActivityThresholds = {
  starsAbsolute: 25,
  starsPercent: 10,
  forksAbsolute: 10,
  forksPercent: 20,
};

function thresholdReached(before: number, after: number, absolute: number, percent: number): boolean {
  const delta = Math.abs(after - before);
  const percentage = before === 0 ? (delta > 0 ? 100 : 0) : (delta / Math.abs(before)) * 100;
  return delta >= absolute || percentage >= percent;
}

function repositoryEvent(
  field: string,
  title: string,
  before: unknown,
  after: unknown,
  observedAt: Date,
): UpdateCandidate {
  const change = { [field]: { before, after } };
  const digest = createHash("sha256").update(JSON.stringify(change)).digest("hex");
  return {
    sourceKind: "repository_change",
    dedupeKey: `repository:${field}:${digest}`,
    canonicalUrl: null,
    title,
    summary: null,
    beforeAfter: change,
    publishedAt: null,
    observedAt,
  };
}

export function repositoryUpdateCandidates(
  before: RepositoryUpdateFacts,
  after: RepositoryUpdateFacts,
  observedAt: Date,
  thresholds: RepositoryActivityThresholds = DEFAULT_THRESHOLDS,
): UpdateCandidate[] {
  const events: UpdateCandidate[] = [];
  if (before.license !== after.license) {
    events.push(repositoryEvent("license", "저장소 라이선스 변경", before.license, after.license, observedAt));
  }
  if (before.archived !== after.archived) {
    events.push(repositoryEvent("archived", "저장소 보관 상태 변경", before.archived, after.archived, observedAt));
  }
  if (before.public !== after.public) {
    events.push(repositoryEvent("visibility", "저장소 공개 상태 변경", before.public, after.public, observedAt));
  }
  if (before.relationshipState !== after.relationshipState) {
    events.push(repositoryEvent(
      "relationship",
      "서비스와 저장소 연결 상태 변경",
      before.relationshipState,
      after.relationshipState,
      observedAt,
    ));
  }

  const digest: Record<string, unknown> = {};
  if (thresholdReached(before.stars, after.stars, thresholds.starsAbsolute, thresholds.starsPercent)) {
    digest.stars = { before: before.stars, after: after.stars };
  }
  if (thresholdReached(before.forks, after.forks, thresholds.forksAbsolute, thresholds.forksPercent)) {
    digest.forks = { before: before.forks, after: after.forks };
  }
  if (Object.keys(digest).length > 0) {
    const key = createHash("sha256").update(JSON.stringify(digest)).digest("hex");
    events.push({
      sourceKind: "activity_digest",
      dedupeKey: `repository:activity:${key}`,
      canonicalUrl: null,
      title: "저장소 활동 변화",
      summary: null,
      beforeAfter: digest,
      publishedAt: null,
      observedAt,
    });
  }
  return events;
}

type EvidenceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type EvidenceExecutor = typeof db | EvidenceTransaction;

/** 자동 이벤트는 conflict 시 본문을 갱신하지 않는다. 관리자 visibility만 별도 경계에서 바꾼다. */
export async function insertUpdateCandidates(
  slugInput: string,
  candidates: UpdateCandidate[],
  executor: EvidenceExecutor = db,
  expectedProductId?: number,
): Promise<number> {
  const slug = slugSchema.parse(slugInput);
  if (candidates.length > 100) throw new Error("too many update candidates");
  const unique = new Map<string, UpdateCandidate>();
  for (const candidate of candidates) {
    const normalized = normalizeUpdateCandidate(candidate);
    if (!unique.has(normalized.dedupeKey)) unique.set(normalized.dedupeKey, normalized);
  }
  if (unique.size === 0) return 0;
  if (executor === db) {
    const productId = expectedProductId ?? await findProductGenerationId(slug);
    if (productId === null) throw new ProductGenerationChangedError();
    return db.transaction((tx) => insertUpdateCandidates(
      slug,
      [...unique.values()],
      tx,
      productId,
    ));
  }
  let productId = expectedProductId;
  if (productId === undefined) {
    const current = await findProductGenerationId(slug);
    productId = current ?? undefined;
  }
  if (
    productId === undefined
    || !(await lockProductGeneration(executor as EvidenceTransaction, productId, slug))
  ) {
    throw new ProductGenerationChangedError();
  }
  const inserted = await executor.insert(productUpdates).values([...unique.values()].map((candidate) => ({
    slug,
    sourceKind: candidate.sourceKind,
    dedupeKey: candidate.dedupeKey,
    canonicalUrl: candidate.canonicalUrl,
    title: candidate.title,
    summary: candidate.summary,
    beforeAfter: candidate.beforeAfter,
    publishedAt: candidate.publishedAt,
    observedAt: candidate.observedAt,
  }))).onConflictDoNothing({
    target: [productUpdates.slug, productUpdates.dedupeKey],
  }).returning({ id: productUpdates.id });
  return inserted.length;
}

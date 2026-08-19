import { and, eq, not, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  productEvidenceAudit,
  productEvidenceSources,
  productLinks,
  productProfiles,
  products,
} from "@/lib/db/schema";
import {
  makerLinksSchema,
  makerProfileSchema,
  safeHttpUrl,
  type MakerProfileInput,
} from "./contracts";

const slugSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);

const normalizedFactsSchema = z.object({
  type: z.enum([
    "github_repository",
    "link",
    "app_store",
    "package",
    "feed",
    "site_fingerprint",
  ]),
}).catchall(z.json()).refine(
  (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 64 * 1024,
  "정규화된 관측 정보는 64 KiB 이하여야 합니다",
);

const observedSourceSchema = z.object({
  slug: slugSchema,
  kind: z.enum([
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
  ]),
  provider: z.string().min(1).max(60),
  sourceKey: z.string().min(1).max(500),
  sourceUrl: safeHttpUrl.nullish(),
  state: z.enum(["unobserved", "ok", "failed", "stale", "disconnected"]),
  normalizedFacts: normalizedFactsSchema.nullish(),
  etag: z.string().max(500).nullish(),
  lastModified: z.string().max(200).nullish(),
  observedAt: z.date().nullish(),
  lastSuccessAt: z.date().nullish(),
  lastFailureAt: z.date().nullish(),
  nextAttemptAt: z.date().optional(),
  attempts: z.number().int().min(0).max(1_000).optional(),
  lastErrorCode: z.string().max(80).nullish(),
}).strict();

type MakerLinkInput = z.input<typeof makerLinksSchema>["links"][number];
type EvidenceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type EvidenceExecutor = typeof db | EvidenceTransaction;

export async function saveMakerProfile(input: {
  slug: string;
  profile: unknown;
  actor: string;
}): Promise<void> {
  const slug = slugSchema.parse(input.slug);
  const profile: MakerProfileInput = makerProfileSchema.parse(input.profile);
  const values = {
    slug,
    problem: profile.problem ?? null,
    targetUsers: profile.targetUsers ?? null,
    keyFeatures: profile.keyFeatures,
    useCases: profile.useCases,
    pricingModel: profile.pricingModel,
    pricingUrl: profile.pricingUrl ?? null,
    lifecycle: profile.lifecycle,
    platforms: profile.platforms,
    privacySummary: profile.privacySummary ?? null,
    longDescriptionMarkdown: profile.longDescriptionMarkdown,
    team: profile.team,
    makerLicense: profile.makerLicense ?? null,
    updatedAt: new Date(),
  };

  await db.transaction(async (tx) => {
    await tx.insert(productProfiles).values(values).onConflictDoUpdate({
      target: productProfiles.slug,
      set: values,
    });
    await tx.insert(productEvidenceAudit).values({
      slug,
      actor: input.actor,
      action: "maker.profile.save",
      metadata: { fields: Object.keys(profile).sort() },
    });
  });
}

export async function replaceMakerLinks(input: {
  slug: string;
  links: MakerLinkInput[];
  actor: string;
}): Promise<void> {
  const slug = slugSchema.parse(input.slug);
  const { links } = makerLinksSchema.parse({ links: input.links });

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtext(${`product-evidence-maker-links:${slug}`}))
    `);
    if (links.length > 0) {
      await tx.insert(productLinks).values(links.map((link) => ({
        slug,
        kind: link.kind,
        declarationSource: "maker" as const,
        url: link.url,
        normalizedKey: link.normalizedKey,
      }))).onConflictDoUpdate({
        target: [productLinks.slug, productLinks.kind, productLinks.normalizedKey],
        set: {
          declarationSource: "maker",
          url: sql`excluded.url`,
          updatedAt: new Date(),
        },
      });
    }
    const keep = or(...links.map((link) => and(
      eq(productLinks.kind, link.kind),
      eq(productLinks.normalizedKey, link.normalizedKey),
    )));
    await tx.delete(productLinks).where(and(
      eq(productLinks.slug, slug),
      eq(productLinks.declarationSource, "maker"),
      keep ? not(keep) : undefined,
    ));
    await tx.insert(productEvidenceAudit).values({
      slug,
      actor: input.actor,
      action: "maker.links.replace",
      metadata: { count: links.length, kinds: links.map((link) => link.kind) },
    });
  });
}

export async function upsertObservedSource(
  input: unknown,
  executor: EvidenceExecutor = db,
): Promise<void> {
  const source = observedSourceSchema.parse(input);
  const now = new Date();
  if (source.state === "ok" && !source.normalizedFacts) {
    const refreshed = await executor.update(productEvidenceSources).set({
      provider: source.provider,
      state: "ok",
      nextAttemptAt: source.nextAttemptAt ?? now,
      ...(source.etag ? { etag: source.etag } : {}),
      ...(source.lastModified ? { lastModified: source.lastModified } : {}),
      ...(source.lastSuccessAt ? { lastSuccessAt: source.lastSuccessAt } : {}),
      attempts: source.attempts ?? 0,
      lastErrorCode: null,
      updatedAt: now,
    }).where(and(
      eq(productEvidenceSources.slug, source.slug),
      eq(productEvidenceSources.kind, source.kind),
      eq(productEvidenceSources.sourceKey, source.sourceKey),
    )).returning({ id: productEvidenceSources.id });
    if (refreshed.length === 0) {
      throw new Error("not-modified source does not exist");
    }
    return;
  }

  await executor.insert(productEvidenceSources).values({
    slug: source.slug,
    kind: source.kind,
    provider: source.provider,
    sourceKey: source.sourceKey,
    sourceUrl: source.sourceUrl ?? null,
    state: source.state,
    normalizedFacts: source.normalizedFacts ?? null,
    etag: source.etag ?? null,
    lastModified: source.lastModified ?? null,
    observedAt: source.observedAt ?? null,
    lastSuccessAt: source.lastSuccessAt ?? null,
    lastFailureAt: source.lastFailureAt ?? null,
    nextAttemptAt: source.nextAttemptAt ?? now,
    attempts: source.attempts ?? 0,
    lastErrorCode: source.lastErrorCode ?? null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [
      productEvidenceSources.slug,
      productEvidenceSources.kind,
      productEvidenceSources.sourceKey,
    ],
    set: {
      provider: source.provider,
      state: source.state,
      nextAttemptAt: source.nextAttemptAt ?? now,
      ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
      ...(source.normalizedFacts ? { normalizedFacts: source.normalizedFacts } : {}),
      ...(source.state === "ok" && source.normalizedFacts && source.etag !== undefined
        ? { etag: source.etag }
        : {}),
      ...(source.state === "ok" && source.normalizedFacts && source.lastModified !== undefined
        ? { lastModified: source.lastModified }
        : {}),
      ...(source.observedAt ? { observedAt: source.observedAt } : {}),
      ...(source.lastSuccessAt ? { lastSuccessAt: source.lastSuccessAt } : {}),
      ...(source.lastFailureAt ? { lastFailureAt: source.lastFailureAt } : {}),
      ...(source.attempts !== undefined
        ? { attempts: source.attempts }
        : source.state === "ok" ? { attempts: 0 } : {}),
      ...(source.lastErrorCode !== undefined
        ? { lastErrorCode: source.lastErrorCode }
        : source.state === "ok" ? { lastErrorCode: null } : {}),
      updatedAt: now,
    },
  });
}

export async function findObservedSource(input: {
  slug: string;
  kind: z.infer<typeof observedSourceSchema>["kind"];
  sourceKey: string;
}) {
  return db.query.productEvidenceSources.findFirst({
    where: and(
      eq(productEvidenceSources.slug, input.slug),
      eq(productEvidenceSources.kind, input.kind),
      eq(productEvidenceSources.sourceKey, input.sourceKey),
    ),
  });
}

export async function isMakerLinkDeclared(input: {
  slug: string;
  kind: z.infer<typeof observedSourceSchema>["kind"];
  normalizedKey: string;
}): Promise<boolean> {
  const link = await db.query.productLinks.findFirst({
    where: and(
      eq(productLinks.slug, input.slug),
      eq(productLinks.kind, input.kind),
      eq(productLinks.normalizedKey, input.normalizedKey),
      eq(productLinks.declarationSource, "maker"),
    ),
    columns: { id: true },
  });
  return Boolean(link);
}

export async function findProductEvidenceIdentity(slug: string) {
  return db.query.products.findFirst({
    where: eq(products.slug, slugSchema.parse(slug)),
    columns: { url: true },
  });
}

export async function siteObservedRepository(input: {
  slug: string;
  repositoryKey: string;
}): Promise<boolean> {
  const sources = await db.query.productEvidenceSources.findMany({
    where: and(
      eq(productEvidenceSources.slug, slugSchema.parse(input.slug)),
      eq(productEvidenceSources.provider, "product_site"),
      eq(productEvidenceSources.state, "ok"),
    ),
    columns: { normalizedFacts: true },
  });
  return sources.some((source) => {
    const facts = source.normalizedFacts;
    if (!facts || facts.type !== "site_fingerprint") return false;
    const keys = facts.repositoryKeys;
    return Array.isArray(keys) && keys.some((key) => key === input.repositoryKey);
  });
}

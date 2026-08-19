import { and, asc, eq, ne, not, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  productEvidenceAudit,
  productEvidenceSources,
  productAgents,
  productLinks,
  productMediaDeclarations,
  productProfiles,
  productSkills,
  products,
} from "@/lib/db/schema";
import {
  makerLinksSchema,
  makerProfileSchema,
  safeHttpUrl,
  type MakerProfileInput,
} from "./contracts";
import { EVIDENCE_LABELS, normalizeProductProvenance } from "./provenance";
import { assertMakerResourceVersion } from "./resource-version";
import {
  findProductGenerationId,
  lockProductGeneration,
  ProductGenerationChangedError,
} from "@/lib/domain/products/repository";

const slugSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const actorSchema = z.string().min(1).max(120);

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

type EvidenceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type EvidenceExecutor = typeof db | EvidenceTransaction;

async function readMakerResource<T>(
  slugInput: string,
  productId: number,
  resourceLock: string | null,
  read: (tx: EvidenceTransaction, slug: string) => Promise<T>,
): Promise<T> {
  const slug = slugSchema.parse(slugInput);
  return db.transaction(async (tx) => {
    if (!(await lockProductGeneration(tx, productId, slug))) {
      throw new ProductGenerationChangedError();
    }
    if (resourceLock) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${resourceLock}))`);
    }
    return read(tx, slug);
  });
}

export async function getMakerProfileResource(slugInput: string, productId: number) {
  return readMakerResource(
    slugInput,
    productId,
    `product-profile:${slugSchema.parse(slugInput)}`,
    readMakerProfileResource,
  );
}

async function readMakerProfileResource(executor: EvidenceExecutor, slug: string) {
  const [profile] = await executor.select().from(productProfiles).where(eq(productProfiles.slug, slug));
  if (!profile) return null;
  return {
    ...(profile.problem === null ? {} : { problem: profile.problem }),
    ...(profile.targetUsers === null ? {} : { targetUsers: profile.targetUsers }),
    keyFeatures: profile.keyFeatures,
    useCases: profile.useCases,
    pricingModel: profile.pricingModel,
    ...(profile.pricingUrl === null ? {} : { pricingUrl: profile.pricingUrl }),
    lifecycle: profile.lifecycle,
    platforms: profile.platforms,
    ...(profile.privacySummary === null ? {} : { privacySummary: profile.privacySummary }),
    longDescriptionMarkdown: profile.longDescriptionMarkdown,
    team: profile.team,
    ...(profile.makerLicense === null ? {} : { makerLicense: profile.makerLicense }),
  };
}

async function readMakerLinksResource(executor: EvidenceExecutor, slug: string) {
  const links = await executor.select({ kind: productLinks.kind, url: productLinks.url })
    .from(productLinks)
    .where(and(eq(productLinks.slug, slug), eq(productLinks.declarationSource, "maker")))
    .orderBy(asc(productLinks.id));
  return { links };
}

export async function getMakerLinksResource(slugInput: string, productId: number) {
  return readMakerResource(
    slugInput,
    productId,
    `product-evidence-maker-links:${slugSchema.parse(slugInput)}`,
    readMakerLinksResource,
  );
}

export async function readMakerMediaResource(executor: EvidenceExecutor, slug: string) {
  const items = await executor.select({
    url: productMediaDeclarations.sourceUrl,
    altText: productMediaDeclarations.altText,
  }).from(productMediaDeclarations)
    .where(eq(productMediaDeclarations.slug, slug))
    .orderBy(asc(productMediaDeclarations.position), asc(productMediaDeclarations.id));
  return { items };
}

export async function getMakerMediaResource(slugInput: string, productId: number) {
  return readMakerResource(
    slugInput,
    productId,
    `product-media:${slugSchema.parse(slugInput)}`,
    readMakerMediaResource,
  );
}

async function readMakerProvenanceResource(executor: EvidenceExecutor, slug: string) {
  const agents = await executor.select({
    provider: productAgents.provider,
    client: productAgents.client,
    model: productAgents.model,
    roles: productAgents.roles,
    commitFrom: productAgents.commitFrom,
    commitTo: productAgents.commitTo,
    dateFrom: productAgents.dateFrom,
    dateTo: productAgents.dateTo,
    sourceUrl: productAgents.sourceUrl,
    evidenceLevel: productAgents.evidenceLevel,
  }).from(productAgents).where(and(
    eq(productAgents.slug, slug),
    eq(productAgents.evidenceLevel, "maker_reported"),
  )).orderBy(asc(productAgents.id));
  const skills = await executor.select({
    namespace: productSkills.namespace,
    name: productSkills.name,
    version: productSkills.version,
    source: productSkills.source,
    hash: productSkills.hash,
    commit: productSkills.commit,
    evidenceLevel: productSkills.evidenceLevel,
  }).from(productSkills).where(and(
    eq(productSkills.slug, slug),
    eq(productSkills.evidenceLevel, "maker_reported"),
  )).orderBy(asc(productSkills.id));
  return {
    agents: agents.map((agent) => Object.fromEntries(
      Object.entries(agent).filter(([, value]) => value !== null),
    )),
    skills: skills.map((skill) => Object.fromEntries(
      Object.entries(skill).filter(([, value]) => value !== null),
    )),
  };
}

export async function getMakerProvenanceResource(slugInput: string, productId: number) {
  return readMakerResource(
    slugInput,
    productId,
    `product-provenance:${slugSchema.parse(slugInput)}`,
    readMakerProvenanceResource,
  );
}

export async function saveMakerProfile(input: {
  slug: string;
  profile: unknown;
  actor: string;
  productId?: number;
  expectedVersion?: string;
}): Promise<void> {
  const slug = slugSchema.parse(input.slug);
  const productId = input.productId ?? await findProductGenerationId(slug);
  if (productId === null) throw new ProductGenerationChangedError();
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
    if (!(await lockProductGeneration(tx, productId, slug))) {
      throw new ProductGenerationChangedError();
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`product-profile:${slug}`}))`);
    assertMakerResourceVersion(input.expectedVersion, {
      profile: await readMakerProfileResource(tx, slug),
    });
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
  links: unknown;
  actor: string;
  productId?: number;
  expectedVersion?: string;
}): Promise<void> {
  const slug = slugSchema.parse(input.slug);
  const productId = input.productId ?? await findProductGenerationId(slug);
  if (productId === null) throw new ProductGenerationChangedError();
  const { links } = makerLinksSchema.parse({ links: input.links });

  await db.transaction(async (tx) => {
    if (!(await lockProductGeneration(tx, productId, slug))) {
      throw new ProductGenerationChangedError();
    }
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtext(${`product-evidence-maker-links:${slug}`}))
    `);
    assertMakerResourceVersion(input.expectedVersion, await readMakerLinksResource(tx, slug));
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
  expectedProductId?: number,
): Promise<void> {
  const source = observedSourceSchema.parse(input);
  if (executor === db) {
    const productId = expectedProductId ?? await findProductGenerationId(source.slug);
    if (productId === null) throw new ProductGenerationChangedError();
    return db.transaction((tx) => upsertObservedSource(source, tx, productId));
  }
  let productId = expectedProductId;
  if (productId === undefined) {
    const [current] = await executor.select({ id: products.id })
      .from(products)
      .where(eq(products.slug, source.slug));
    productId = current?.id;
  }
  if (
    productId === undefined
    || !(await lockProductGeneration(executor as EvidenceTransaction, productId, source.slug))
  ) {
    throw new ProductGenerationChangedError();
  }
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
    columns: { id: true, url: true },
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

export async function replaceProductProvenance(input: {
  slug: string;
  provenance: unknown;
  actor: string;
  authority?: "maker" | "system";
  productId?: number;
  expectedVersion?: string;
}): Promise<void> {
  const slug = slugSchema.parse(input.slug);
  const productId = input.productId ?? await findProductGenerationId(slug);
  if (productId === null) throw new ProductGenerationChangedError();
  const actor = actorSchema.parse(input.actor);
  const authority = input.authority ?? "maker";
  const provenance = normalizeProductProvenance(input.provenance, authority);
  await db.transaction(async (tx) => {
    if (!(await lockProductGeneration(tx, productId, slug))) {
      throw new ProductGenerationChangedError();
    }
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtext(${`product-provenance:${slug}`}))
    `);
    if (authority === "maker") {
      assertMakerResourceVersion(
        input.expectedVersion,
        await readMakerProvenanceResource(tx, slug),
      );
    }
    await tx.delete(productAgents).where(and(
      eq(productAgents.slug, slug),
      authority === "maker" ? eq(productAgents.evidenceLevel, "maker_reported") : undefined,
    ));
    await tx.delete(productSkills).where(and(
      eq(productSkills.slug, slug),
      authority === "maker" ? eq(productSkills.evidenceLevel, "maker_reported") : undefined,
    ));
    let skills = provenance.skills;
    if (authority === "maker" && skills.length > 0) {
      const retained = await tx.select({
        namespace: productSkills.namespace,
        name: productSkills.name,
        version: productSkills.version,
        commit: productSkills.commit,
      }).from(productSkills).where(and(
        eq(productSkills.slug, slug),
        ne(productSkills.evidenceLevel, "maker_reported"),
      ));
      const identities = new Set(retained.map((skill) => [
        skill.namespace,
        skill.name,
        skill.version ?? "",
        skill.commit ?? "",
      ].join("\0")));
      skills = skills.filter((skill) => !identities.has([
        skill.namespace,
        skill.name,
        skill.version ?? "",
        skill.commit ?? "",
      ].join("\0")));
    }
    if (provenance.agents.length > 0) {
      await tx.insert(productAgents).values(provenance.agents.map((agent) => ({ slug, ...agent })));
    }
    if (skills.length > 0) {
      await tx.insert(productSkills).values(skills.map((skill) => ({ slug, ...skill })));
    }
    await tx.insert(productEvidenceAudit).values({
      slug,
      actor,
      action: authority === "maker" ? "maker.provenance.replace" : "system.provenance.replace",
      metadata: {
        agents: provenance.agents.length,
        skills: skills.length,
        authority,
        evidenceLevels: [...new Set([
          ...provenance.agents.map((agent) => agent.evidenceLevel),
          ...provenance.skills.map((skill) => skill.evidenceLevel),
        ])].sort(),
      },
    });
  });
}

export async function listProductProvenance(slugInput: string) {
  const slug = slugSchema.parse(slugInput);
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtext(${`product-provenance:${slug}`}))
    `);
    const agents = await tx.select().from(productAgents)
      .where(eq(productAgents.slug, slug))
      .orderBy(asc(productAgents.id));
    const skills = await tx.select().from(productSkills)
      .where(eq(productSkills.slug, slug))
      .orderBy(asc(productSkills.id));
    return {
      agents: agents.map((agent) => ({
        ...agent,
        evidenceLabel: EVIDENCE_LABELS[agent.evidenceLevel],
      })),
      skills: skills.map((skill) => ({
        ...skill,
        evidenceLabel: EVIDENCE_LABELS[skill.evidenceLevel],
      })),
    };
  });
}

import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  evidenceSettings,
  productAgents,
  productEvidenceAudit,
  productEvidenceSources,
  productLinks,
  productMedia,
  productMediaDeclarations,
  productProfiles,
  productSkills,
  productUpdates,
  products,
} from "@/lib/db/schema";
import { lockProductGeneration } from "@/lib/domain/products/repository";
import { evidenceSettingsSchema, type EvidenceSettings } from "./settings";

const slugSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const actorSchema = z.string().trim().min(1).max(120);
const visibilitySchema = z.object({
  slug: slugSchema,
  updateId: z.number().int().positive(),
  visible: z.boolean(),
  reason: z.string().trim().min(1).max(500),
  actor: actorSchema,
}).strict();

function scalarNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scalarString(value: unknown): string | null {
  return typeof value === "string" && value.length <= 500 ? value : null;
}

function sourceFacts(value: Record<string, unknown> | null) {
  if (!value) return null;
  const license = value.license && typeof value.license === "object"
    ? value.license as Record<string, unknown>
    : null;
  const release = value.latestRelease && typeof value.latestRelease === "object"
    ? value.latestRelease as Record<string, unknown>
    : null;
  return {
    stars: scalarNumber(value.stars),
    forks: scalarNumber(value.forks),
    contributors: scalarNumber(value.contributors),
    license: scalarString(license?.spdxId) ?? scalarString(license?.value),
    relationship: scalarString(value.relationshipState),
    pushedAt: scalarString(value.pushedAt),
    latestRelease: scalarString(release?.tagName),
  };
}

export async function saveEvidenceSettingsValue(
  input: unknown,
  actorInput: string,
): Promise<EvidenceSettings> {
  const values = evidenceSettingsSchema.parse(input);
  const actor = actorSchema.parse(actorInput);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(evidenceSettings).values({
      id: 1,
      values,
      updatedBy: actor,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: evidenceSettings.id,
      set: { values, updatedBy: actor, updatedAt: now },
    });
    await tx.insert(productEvidenceAudit).values({
      slug: null,
      actor: `admin:${actor}`,
      action: "admin.evidence.settings.save",
      metadata: { fields: Object.keys(values).sort() },
    });
  });
  return values;
}

export type AutomaticUpdateVisibilityResult = "updated" | "unchanged" | "not_found" | "forbidden";

export async function setAutomaticUpdateVisibility(
  input: z.input<typeof visibilitySchema>,
): Promise<AutomaticUpdateVisibilityResult> {
  const value = visibilitySchema.parse(input);
  return db.transaction(async (tx) => {
    const product = await tx.query.products.findFirst({
      where: eq(products.slug, value.slug),
      columns: { id: true },
    });
    if (!product || !(await lockProductGeneration(tx, product.id, value.slug))) return "not_found";
    const update = await tx.query.productUpdates.findFirst({
      where: and(eq(productUpdates.id, value.updateId), eq(productUpdates.slug, value.slug)),
    });
    if (!update) return "not_found";
    if (update.sourceKind === "maker") return "forbidden";
    if (update.visible === value.visible) return "unchanged";
    await tx.update(productUpdates).set({ visible: value.visible })
      .where(eq(productUpdates.id, update.id));
    await tx.insert(productEvidenceAudit).values({
      slug: value.slug,
      actor: `admin:${value.actor}`,
      action: value.visible ? "admin.update.restore" : "admin.update.hide",
      reason: value.reason,
      metadata: { updateId: update.id, sourceKind: update.sourceKind },
    });
    return "updated";
  });
}

export async function getEvidenceAdminProduct(slugInput: string) {
  const slug = slugSchema.parse(slugInput);
  const product = await db.query.products.findFirst({
    where: eq(products.slug, slug),
    columns: { id: true, slug: true, name: true, url: true, status: true },
  });
  if (!product) return null;

  const [profile, links, sources, media, declarations, updates, agents, skills, audits] = await Promise.all([
    db.query.productProfiles.findFirst({
      where: eq(productProfiles.slug, slug),
      columns: { makerLicense: true },
    }),
    db.select({
      id: productLinks.id,
      kind: productLinks.kind,
      url: productLinks.url,
      declarationSource: productLinks.declarationSource,
      verificationState: productLinks.verificationState,
      relationshipState: productLinks.relationshipState,
    }).from(productLinks).where(eq(productLinks.slug, slug)).orderBy(asc(productLinks.id)),
    db.select({
      id: productEvidenceSources.id,
      kind: productEvidenceSources.kind,
      provider: productEvidenceSources.provider,
      state: productEvidenceSources.state,
      normalizedFacts: productEvidenceSources.normalizedFacts,
      lastSuccessAt: productEvidenceSources.lastSuccessAt,
      lastFailureAt: productEvidenceSources.lastFailureAt,
      nextAttemptAt: productEvidenceSources.nextAttemptAt,
      attempts: productEvidenceSources.attempts,
      lastErrorCode: productEvidenceSources.lastErrorCode,
    }).from(productEvidenceSources)
      .where(eq(productEvidenceSources.slug, slug)).orderBy(asc(productEvidenceSources.id)),
    db.select({
      id: productMedia.id,
      sourceUrl: productMedia.sourceUrl,
      version: productMedia.version,
      current: productMedia.current,
      visible: productMedia.visible,
      missingAt: productMedia.missingAt,
    }).from(productMedia).where(eq(productMedia.slug, slug))
      .orderBy(asc(productMedia.sourceUrl), desc(productMedia.version)),
    db.select({
      id: productMediaDeclarations.id,
      sourceUrl: productMediaDeclarations.sourceUrl,
      revision: productMediaDeclarations.revision,
      position: productMediaDeclarations.position,
    }).from(productMediaDeclarations).where(eq(productMediaDeclarations.slug, slug))
      .orderBy(asc(productMediaDeclarations.position), asc(productMediaDeclarations.id)),
    db.select({
      id: productUpdates.id,
      sourceKind: productUpdates.sourceKind,
      title: productUpdates.title,
      visible: productUpdates.visible,
      makerEditedAt: productUpdates.makerEditedAt,
      makerDeletedAt: productUpdates.makerDeletedAt,
    }).from(productUpdates).where(eq(productUpdates.slug, slug))
      .orderBy(desc(sql`coalesce(${productUpdates.publishedAt}, ${productUpdates.observedAt})`)),
    db.select({
      id: productAgents.id,
      provider: productAgents.provider,
      roles: productAgents.roles,
      evidenceLevel: productAgents.evidenceLevel,
    }).from(productAgents).where(eq(productAgents.slug, slug)).orderBy(asc(productAgents.id)),
    db.select({
      id: productSkills.id,
      namespace: productSkills.namespace,
      name: productSkills.name,
      evidenceLevel: productSkills.evidenceLevel,
    }).from(productSkills).where(eq(productSkills.slug, slug)).orderBy(asc(productSkills.id)),
    db.select({
      id: productEvidenceAudit.id,
      actor: productEvidenceAudit.actor,
      action: productEvidenceAudit.action,
      reason: productEvidenceAudit.reason,
      createdAt: productEvidenceAudit.createdAt,
    }).from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, slug))
      .orderBy(desc(productEvidenceAudit.id)).limit(100),
  ]);

  const repository = sources.find((source) => source.kind === "repository");
  const observedLicense = sourceFacts(repository?.normalizedFacts ?? null)?.license ?? null;
  const makerLicense = profile?.makerLicense?.spdxId ?? profile?.makerLicense?.value ?? null;
  const conflicts = makerLicense && observedLicense && makerLicense !== observedLicense
    ? [{ field: "license" as const, makerValue: makerLicense, observedValue: observedLicense }]
    : [];

  return {
    product: { slug: product.slug, name: product.name, url: product.url, status: product.status },
    profile: profile ?? null,
    conflicts,
    links,
    sources: sources.map(({ normalizedFacts, ...source }) => ({
      ...source,
      facts: sourceFacts(normalizedFacts),
    })),
    media,
    declarations,
    updates,
    agents,
    skills,
    audits,
  };
}

export async function getEvidenceStatusSummary(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid status timestamp");
  const [row] = await db.select({
    due: sql<number>`count(*) filter (where ${productEvidenceSources.nextAttemptAt} <= ${now.toISOString()}::timestamptz)::int`,
    stale: sql<number>`count(*) filter (where ${productEvidenceSources.state} = 'stale')::int`,
    failed: sql<number>`count(*) filter (where ${productEvidenceSources.state} in ('failed', 'disconnected'))::int`,
  }).from(productEvidenceSources);
  return { due: row?.due ?? 0, stale: row?.stale ?? 0, failed: row?.failed ?? 0 };
}

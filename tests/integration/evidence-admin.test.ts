import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  evidenceSettings,
  productAgents,
  productEvidenceAudit,
  productEvidenceSources,
  productLinks,
  productMediaDeclarations,
  productProfiles,
  productSkills,
  productUpdates,
  products,
} from "@/lib/db/schema";
import {
  getEvidenceAdminProduct,
  getEvidenceStatusSummary,
  saveEvidenceSettingsValue,
  setAutomaticUpdateVisibility,
} from "@/lib/domain/evidence/admin";
import { ensureSchema, resetTables } from "./setup";

const NOW = new Date("2026-08-20T03:00:00.000Z");

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.insert(products).values({
    slug: "evidence-admin",
    url: "https://evidence-admin.example",
    name: "Evidence Admin",
    tagline: "Evidence",
    description: "Evidence admin fixture",
    category: "Dev",
    status: "verified",
    verifyToken: "verify",
    editTokenHash: "a".repeat(64),
  });
});

describe("evidence admin persistence", () => {
  it("saves validated settings with an immutable audit row", async () => {
    const settings = {
      githubFactsHours: 48,
      releaseFeedHours: 12,
      linkCheckHours: 24,
      staleAfterIntervals: 3,
      maxRetries: 5,
      batchSize: 30,
      starDigestAbsolute: 40,
      starDigestPercent: 12.5,
    };
    await expect(saveEvidenceSettingsValue(settings, "admin")).resolves.toEqual(settings);
    expect(await db.query.evidenceSettings.findFirst({ where: eq(evidenceSettings.id, 1) }))
      .toMatchObject({ values: settings, updatedBy: "admin" });
    expect(await db.query.productEvidenceAudit.findFirst({
      where: eq(productEvidenceAudit.action, "admin.evidence.settings.save"),
    })).toMatchObject({ actor: "admin:admin", slug: null });
  });

  it("hides and restores only automatic updates while appending audit history", async () => {
    const [automatic, maker] = await db.insert(productUpdates).values([
      { slug: "evidence-admin", sourceKind: "github_release", dedupeKey: "release:1", title: "v1", observedAt: NOW },
      { slug: "evidence-admin", sourceKind: "maker", dedupeKey: "maker:1", title: "maker", observedAt: NOW },
    ]).returning({ id: productUpdates.id });

    await expect(setAutomaticUpdateVisibility({
      slug: "evidence-admin",
      updateId: automatic.id,
      visible: false,
      reason: "중복 공지",
      actor: "admin",
    })).resolves.toEqual("updated");
    expect(await db.query.productUpdates.findFirst({ where: eq(productUpdates.id, automatic.id) }))
      .toMatchObject({ visible: false });
    await expect(setAutomaticUpdateVisibility({
      slug: "evidence-admin",
      updateId: automatic.id,
      visible: true,
      reason: "복원",
      actor: "admin",
    })).resolves.toEqual("updated");
    await expect(setAutomaticUpdateVisibility({
      slug: "evidence-admin",
      updateId: maker.id,
      visible: false,
      reason: "허용하지 않음",
      actor: "admin",
    })).resolves.toEqual("forbidden");

    const audits = await db.select().from(productEvidenceAudit)
      .where(eq(productEvidenceAudit.slug, "evidence-admin"))
      .orderBy(asc(productEvidenceAudit.id));
    expect(audits.map((row) => [row.action, row.reason])).toEqual([
      ["admin.update.hide", "중복 공지"],
      ["admin.update.restore", "복원"],
    ]);
  });
});

describe("evidence admin read models", () => {
  it("returns source conflicts, provenance, media declarations, updates, and audits", async () => {
    await db.insert(productProfiles).values({
      slug: "evidence-admin",
      pricingModel: "open_source",
      lifecycle: "ga",
      longDescriptionMarkdown: "Description",
      makerLicense: { value: "MIT", spdxId: "MIT" },
    });
    await db.insert(productLinks).values({
      slug: "evidence-admin",
      kind: "repository",
      declarationSource: "maker",
      url: "https://github.com/example/evidence-admin",
      normalizedKey: "example/evidence-admin",
      relationshipState: "bidirectional",
      verificationState: "ok",
    });
    await db.insert(productEvidenceSources).values({
      slug: "evidence-admin",
      kind: "repository",
      provider: "github",
      sourceKey: "example/evidence-admin",
      state: "stale",
      normalizedFacts: {
        type: "github_repository",
        stars: 12,
        license: { value: "Apache License 2.0", spdxId: "Apache-2.0" },
        relationshipState: "bidirectional",
      },
      lastSuccessAt: new Date("2026-08-18T00:00:00Z"),
      nextAttemptAt: new Date("2026-08-19T00:00:00Z"),
      attempts: 2,
      lastErrorCode: "timeout",
    });
    await db.insert(productMediaDeclarations).values({
      slug: "evidence-admin",
      sourceUrl: "https://cdn.example/evidence.png",
      altText: "Evidence",
      revision: 2,
    });
    await db.insert(productUpdates).values({
      slug: "evidence-admin",
      sourceKind: "github_release",
      dedupeKey: "release:1",
      title: "v1",
      observedAt: NOW,
    });
    await db.insert(productAgents).values({
      slug: "evidence-admin",
      provider: "OpenAI",
      roles: ["implementation"],
      evidenceLevel: "maker_reported",
    });
    await db.insert(productSkills).values({
      slug: "evidence-admin",
      namespace: "openai",
      name: "review",
      evidenceLevel: "maker_reported",
    });
    await db.insert(productEvidenceAudit).values({
      slug: "evidence-admin",
      actor: "maker:1",
      action: "maker.profile.save",
    });

    const view = await getEvidenceAdminProduct("evidence-admin");
    expect(view).toMatchObject({
      product: { slug: "evidence-admin" },
      conflicts: [{ field: "license", makerValue: "MIT", observedValue: "Apache-2.0" }],
      sources: [{ state: "stale", facts: { stars: 12, license: "Apache-2.0", relationship: "bidirectional" } }],
      declarations: [{ revision: 2 }],
      updates: [{ title: "v1" }],
      agents: [{ provider: "OpenAI" }],
      skills: [{ name: "review" }],
      audits: [{ action: "maker.profile.save" }],
    });
  });

  it("counts due, stale, and failed or disconnected sources", async () => {
    await db.insert(productEvidenceSources).values([
      { slug: "evidence-admin", kind: "repository", provider: "github", sourceKey: "a", state: "stale", nextAttemptAt: new Date("2026-08-20T02:00:00Z") },
      { slug: "evidence-admin", kind: "support", provider: "support", sourceKey: "b", state: "failed", nextAttemptAt: new Date("2026-08-20T04:00:00Z") },
      { slug: "evidence-admin", kind: "documentation", provider: "documentation", sourceKey: "c", state: "disconnected", nextAttemptAt: new Date("2026-08-20T01:00:00Z") },
    ]);

    await expect(getEvidenceStatusSummary(NOW)).resolves.toEqual({ due: 2, stale: 1, failed: 2 });
  });
});

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
import { readWorkerProgress } from "@/lib/operations/worker-progress-query";

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
    createdAt: new Date(NOW.getTime() - 4 * 60 * 60_000),
    updatedAt: new Date(NOW.getTime() - 4 * 60 * 60_000),
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
    const createdAt = new Date(NOW.getTime() - 4 * 60 * 60_000);
    await db.insert(productLinks).values([
      { slug: "evidence-admin", kind: "repository", declarationSource: "maker", normalizedKey: "a", url: "https://github.com/acme/a", createdAt },
      { slug: "evidence-admin", kind: "support", declarationSource: "maker", normalizedKey: "b", url: "https://support.example/b", createdAt },
      { slug: "evidence-admin", kind: "documentation", declarationSource: "maker", normalizedKey: "c", url: "https://docs.example/c", createdAt },
    ]);
    await db.insert(productEvidenceSources).values([
      { slug: "evidence-admin", kind: "repository", provider: "github", sourceKey: "a", sourceUrl: "https://github.com/acme/a", state: "stale", nextAttemptAt: new Date("2026-08-20T02:00:00Z"), createdAt },
      { slug: "evidence-admin", kind: "support", provider: "support", sourceKey: "b", sourceUrl: "https://support.example/b", state: "failed", nextAttemptAt: new Date("2026-08-20T04:00:00Z"), createdAt },
      { slug: "evidence-admin", kind: "documentation", provider: "documentation", sourceKey: "c", sourceUrl: "https://docs.example/c", state: "disconnected", nextAttemptAt: new Date("2026-08-20T01:00:00Z"), createdAt },
    ]);

    // 가장 오래 밀린 것은 01:00 기한 — NOW(03:00)보다 2시간
    await expect(getEvidenceStatusSummary(NOW)).resolves.toEqual({ due: 2, stale: 1, failed: 2, oldestDueHours: 2 });
  });

  it("matches current worker demand including a visible link without a source and excludes inactive history", async () => {
    const createdAt = new Date(NOW.getTime() - 4 * 60 * 60_000), old = new Date(NOW.getTime() - 34 * 24 * 60 * 60_000);
    await db.insert(products).values(["banned", "unverified"].map(status => ({ slug: `evidence-${status}`,
      url: `https://evidence-${status}.example`, name: status, tagline: "test", description: "test", category: "Dev",
      verifyToken: status, editTokenHash: "a".repeat(64), status: status as "banned" | "unverified", createdAt: old, updatedAt: old })));
    await db.insert(productLinks).values([
      { slug: "evidence-admin", kind: "repository", declarationSource: "maker", normalizedKey: "active", url: "https://github.com/acme/active", createdAt },
      { slug: "evidence-admin", kind: "support", declarationSource: "maker", normalizedKey: "future", url: "https://support.example/future", createdAt },
      { slug: "evidence-admin", kind: "npm", declarationSource: "maker", normalizedKey: "initial", url: "https://npmjs.com/package/initial", createdAt: new Date(NOW.getTime() - 30 * 60_000) },
      { slug: "evidence-admin", kind: "support", declarationSource: "maker", normalizedKey: "hidden", url: "https://support.example/hidden", visible: false, createdAt: old },
      ...["banned", "unverified"].map(status => ({ slug: `evidence-${status}`, kind: "repository" as const,
        declarationSource: "maker" as const, normalizedKey: status, url: `https://github.com/acme/${status}`, createdAt: old })),
    ]);
    await db.insert(productEvidenceSources).values([
      { slug: "evidence-admin", kind: "repository", provider: "github", sourceKey: "active", sourceUrl: "https://github.com/acme/active", state: "stale", nextAttemptAt: new Date(NOW.getTime() - 60 * 60_000), createdAt },
      { slug: "evidence-admin", kind: "support", provider: "support", sourceKey: "future", sourceUrl: "https://support.example/future", state: "failed", nextAttemptAt: new Date(NOW.getTime() + 60 * 60_000), createdAt },
      { slug: "evidence-admin", kind: "documentation", provider: "product_site", sourceKey: "canonical_site", sourceUrl: "https://evidence-admin.example", state: "disconnected", nextAttemptAt: new Date(NOW.getTime() - 2 * 60 * 60_000), createdAt },
      { slug: "evidence-admin", kind: "support", provider: "support", sourceKey: "hidden", sourceUrl: "https://support.example/hidden", state: "failed", nextAttemptAt: old, createdAt: old },
      { slug: "evidence-admin", kind: "repository", provider: "github", sourceKey: "obsolete", sourceUrl: "https://github.com/acme/obsolete", state: "stale", nextAttemptAt: old, createdAt: old },
      ...["banned", "unverified"].map(status => ({ slug: `evidence-${status}`, kind: "repository" as const, provider: "github",
        sourceKey: status, sourceUrl: `https://github.com/acme/${status}`, state: "failed" as const, nextAttemptAt: old, createdAt: old })),
      { slug: "evidence-banned", kind: "documentation", provider: "product_site", sourceKey: "canonical_site", sourceUrl: "https://evidence-banned.example", state: "failed", nextAttemptAt: old, createdAt: old },
    ]);
    const before = await db.select().from(productEvidenceSources).orderBy(asc(productEvidenceSources.id));
    const summary = await getEvidenceStatusSummary(NOW);
    expect(summary).toEqual({ due: 3, stale: 1, failed: 2, oldestDueHours: 2 });
    expect((await readWorkerProgress(NOW)).stages.find(stage => stage.stage === "evidence"))
      .toMatchObject({ waiting: summary.due, oldestMinutes: summary.oldestDueHours! * 60 });
    expect(await db.select().from(productEvidenceSources).orderBy(asc(productEvidenceSources.id))).toEqual(before);
  });

  it("counts a changed canonical URL from the current product clock without inheriting the old URL failure", async () => {
    const updatedAt = new Date(NOW.getTime() - 12 * 60_000);
    await db.update(products).set({ updatedAt }).where(eq(products.slug, "evidence-admin"));
    await db.insert(productEvidenceSources).values({ slug: "evidence-admin", kind: "documentation", provider: "product_site",
      sourceKey: "canonical_site", sourceUrl: "https://old.example", state: "failed", lastErrorCode: "site_http",
      createdAt: new Date(NOW.getTime() - 24 * 60 * 60_000), nextAttemptAt: new Date(NOW.getTime() + 60 * 60_000) });
    const summary = await getEvidenceStatusSummary(NOW);
    expect(summary).toEqual({ due: 1, stale: 0, failed: 0, oldestDueHours: 0.2 });
    expect((await readWorkerProgress(NOW)).stages.find(stage => stage.stage === "evidence"))
      .toMatchObject({ waiting: summary.due, oldestMinutes: 12, providerErrors: 0 });
  });
});

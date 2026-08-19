import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  productEvidenceAudit,
  productEvidenceSources,
  productLinks,
  productProfiles,
  products,
} from "@/lib/db/schema";
import {
  replaceMakerLinks,
  saveMakerProfile,
  upsertObservedSource,
} from "@/lib/domain/evidence/repository";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.insert(products).values({
    slug: "evidence-product",
    url: "https://product.example",
    name: "Evidence Product",
    tagline: "Evidence",
    description: "Evidence product",
    category: "Dev",
    status: "verified",
    verifyToken: "verify-token",
    editTokenHash: "a".repeat(64),
  });
});

const profile = {
  pricingModel: "open_source" as const,
  lifecycle: "ga" as const,
  longDescriptionMarkdown: "## 소개\n\n메이커가 작성한 설명입니다.",
  team: [{ name: "Maker", role: "Developer" }],
  makerLicense: { value: "MIT", spdxId: "MIT" },
};

describe("product evidence repository", () => {
  it("keeps maker declarations and idempotent observed facts separate when they conflict", async () => {
    await saveMakerProfile({ slug: "evidence-product", profile, actor: "maker:test" });
    await replaceMakerLinks({
      slug: "evidence-product",
      actor: "maker:test",
      links: [{ kind: "repository", url: "https://github.com/Owner/Repo" }],
    });

    const observedInput = {
      slug: "evidence-product",
      kind: "repository" as const,
      provider: "github",
      sourceKey: "owner/repo",
      sourceUrl: "https://github.com/owner/repo",
      state: "ok" as const,
      normalizedFacts: {
        type: "github_repository",
        license: { value: "Apache License 2.0", spdxId: "Apache-2.0" },
        stars: 10,
      },
      observedAt: new Date("2026-08-19T00:00:00.000Z"),
      lastSuccessAt: new Date("2026-08-19T00:00:00.000Z"),
    };
    await upsertObservedSource(observedInput);
    await upsertObservedSource({
      ...observedInput,
      normalizedFacts: { ...observedInput.normalizedFacts, stars: 12 },
      observedAt: new Date("2026-08-19T01:00:00.000Z"),
      lastSuccessAt: new Date("2026-08-19T01:00:00.000Z"),
    });

    const [savedProfile] = await db.select().from(productProfiles).where(eq(productProfiles.slug, "evidence-product"));
    const links = await db.select().from(productLinks).where(eq(productLinks.slug, "evidence-product"));
    const sources = await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, "evidence-product"));

    expect(savedProfile.makerLicense).toEqual({ value: "MIT", spdxId: "MIT" });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      kind: "repository",
      declarationSource: "maker",
      normalizedKey: "owner/repo",
    });
    expect(sources).toHaveLength(1);
    expect(sources[0].normalizedFacts).toMatchObject({
      license: { spdxId: "Apache-2.0" },
      stars: 12,
    });
  });

  it("rolls back a maker replacement and its single audit when the transaction fails", async () => {
    await replaceMakerLinks({
      slug: "evidence-product",
      actor: "maker:initial",
      links: [{ kind: "support", url: "https://product.example/support" }],
    });
    const [{ count: auditsBefore }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(productEvidenceAudit);

    await expect(replaceMakerLinks({
      slug: "evidence-product",
      actor: "x".repeat(121),
      links: [{ kind: "documentation", url: "https://product.example/docs" }],
    })).rejects.toThrow();

    const links = await db.select().from(productLinks).where(eq(productLinks.slug, "evidence-product"));
    const audits = await db.select().from(productEvidenceAudit);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: "support", normalizedKey: "https://product.example/support" });
    expect(audits).toHaveLength(auditsBefore);
  });

  it("writes bounded audit metadata without credentials or provider bodies", async () => {
    await replaceMakerLinks({
      slug: "evidence-product",
      actor: "maker:test",
      links: [
        { kind: "documentation", url: "https://product.example/docs" },
        { kind: "rss", url: "https://product.example/feed.xml" },
      ],
    });

    const [audit] = await db
      .select()
      .from(productEvidenceAudit)
      .where(eq(productEvidenceAudit.action, "maker.links.replace"));
    expect(audit.metadata).toEqual({ count: 2, kinds: ["documentation", "rss"] });
    expect(JSON.stringify(audit)).not.toMatch(/edit.?token|source.?body|credential/i);
  });

  it("preserves last-known-good facts and validators when an observed refresh fails", async () => {
    await upsertObservedSource({
      slug: "evidence-product",
      kind: "repository",
      provider: "github",
      sourceKey: "owner/repo",
      sourceUrl: "https://github.com/owner/repo",
      state: "ok",
      normalizedFacts: { type: "github_repository", stars: 12 },
      etag: "etag-12",
      lastModified: "Wed, 19 Aug 2026 00:00:00 GMT",
      observedAt: new Date("2026-08-19T00:00:00.000Z"),
      lastSuccessAt: new Date("2026-08-19T00:00:00.000Z"),
    });
    await upsertObservedSource({
      slug: "evidence-product",
      kind: "repository",
      provider: "github",
      sourceKey: "owner/repo",
      state: "failed",
      etag: null,
      lastModified: null,
      lastFailureAt: new Date("2026-08-19T01:00:00.000Z"),
      lastErrorCode: "http_500",
      attempts: 1,
    });

    const [source] = await db
      .select()
      .from(productEvidenceSources)
      .where(eq(productEvidenceSources.slug, "evidence-product"));
    expect(source).toMatchObject({
      sourceUrl: "https://github.com/owner/repo",
      normalizedFacts: { type: "github_repository", stars: 12 },
      etag: "etag-12",
      lastModified: "Wed, 19 Aug 2026 00:00:00 GMT",
      lastSuccessAt: new Date("2026-08-19T00:00:00.000Z"),
      state: "failed",
      lastErrorCode: "http_500",
      attempts: 1,
    });
  });

  it("advances 304 freshness without facts and clears missing validators on a new 200", async () => {
    const firstSuccess = new Date("2026-08-19T00:00:00.000Z");
    await upsertObservedSource({
      slug: "evidence-product",
      kind: "repository",
      provider: "github",
      sourceKey: "owner/repo",
      sourceUrl: "https://github.com/owner/repo",
      state: "ok",
      normalizedFacts: { type: "github_repository", stars: 12 },
      etag: "etag-12",
      lastModified: "Wed, 19 Aug 2026 00:00:00 GMT",
      observedAt: firstSuccess,
      lastSuccessAt: firstSuccess,
    });

    const notModifiedAt = new Date("2026-08-19T01:00:00.000Z");
    await upsertObservedSource({
      slug: "evidence-product",
      kind: "repository",
      provider: "github",
      sourceKey: "owner/repo",
      state: "ok",
      etag: null,
      lastModified: null,
      lastSuccessAt: notModifiedAt,
    });
    let [source] = await db
      .select()
      .from(productEvidenceSources)
      .where(eq(productEvidenceSources.slug, "evidence-product"));
    expect(source).toMatchObject({
      normalizedFacts: { type: "github_repository", stars: 12 },
      etag: "etag-12",
      lastModified: "Wed, 19 Aug 2026 00:00:00 GMT",
      lastSuccessAt: notModifiedAt,
    });

    const nextSuccess = new Date("2026-08-19T02:00:00.000Z");
    await upsertObservedSource({
      slug: "evidence-product",
      kind: "repository",
      provider: "github",
      sourceKey: "owner/repo",
      sourceUrl: "https://github.com/owner/repo",
      state: "ok",
      normalizedFacts: { type: "github_repository", stars: 13 },
      etag: null,
      lastModified: null,
      observedAt: nextSuccess,
      lastSuccessAt: nextSuccess,
    });
    [source] = await db
      .select()
      .from(productEvidenceSources)
      .where(eq(productEvidenceSources.slug, "evidence-product"));
    expect(source).toMatchObject({
      normalizedFacts: { type: "github_repository", stars: 13 },
      etag: null,
      lastModified: null,
      lastSuccessAt: nextSuccess,
    });
  });

  it("merges a matching discovered link into the maker declaration without losing verification", async () => {
    await db.insert(productLinks).values({
      slug: "evidence-product",
      kind: "support",
      declarationSource: "discovered",
      url: "https://product.example/support",
      normalizedKey: "https://product.example/support",
      verificationState: "ok",
      relationshipState: "site_link",
      verifiedAt: new Date("2026-08-19T00:00:00.000Z"),
    });

    await replaceMakerLinks({
      slug: "evidence-product",
      actor: "maker:test",
      links: [{ kind: "support", url: "https://product.example/support" }],
    });
    await replaceMakerLinks({
      slug: "evidence-product",
      actor: "maker:test",
      links: [{ kind: "support", url: "https://product.example/support" }],
    });

    const links = await db.select().from(productLinks).where(eq(productLinks.slug, "evidence-product"));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      declarationSource: "maker",
      verificationState: "ok",
      relationshipState: "site_link",
      verifiedAt: new Date("2026-08-19T00:00:00.000Z"),
    });
  });

  it("serializes concurrent full replacements instead of merging both writers", async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await db.delete(productLinks).where(eq(productLinks.slug, "evidence-product"));
      await Promise.all([
        replaceMakerLinks({
          slug: "evidence-product",
          actor: "maker:a",
          links: [{ kind: "documentation", url: "https://product.example/docs" }],
        }),
        replaceMakerLinks({
          slug: "evidence-product",
          actor: "maker:b",
          links: [{ kind: "rss", url: "https://product.example/feed.xml" }],
        }),
      ]);

      const links = await db.select().from(productLinks).where(eq(productLinks.slug, "evidence-product"));
      expect(links, `attempt ${attempt}`).toHaveLength(1);
      expect(["documentation", "rss"]).toContain(links[0].kind);
    }
  });
});

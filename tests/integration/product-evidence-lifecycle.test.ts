import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  mediaAssets,
  productAgents,
  productEvidenceAudit,
  productEvidenceSources,
  productHealth,
  productHealthDaily,
  productLinks,
  productMedia,
  productProfiles,
  productSkills,
  productUpdates,
  products,
} from "@/lib/db/schema";
import { banProduct, deleteProduct } from "@/lib/domain/products/manage";
import {
  listProducts,
  removeProductAndEvidence,
  setStatusWithAudit,
} from "@/lib/domain/products/repository";
import { refreshProductEvidence } from "@/lib/domain/evidence/refresh";
import { hashToken } from "@/lib/tokens";
import { ensureSchema, resetTables } from "./setup";

const EDIT_TOKEN = "nmv_edit_lifecycle";
const SHARED_HASH = "a".repeat(64);

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

async function insertProduct(slug: string, status: "verified" | "seeded" = "verified") {
  await db.insert(products).values({
    slug,
    url: `https://${slug}.example`,
    name: slug,
    tagline: "Lifecycle fixture",
    description: "Lifecycle fixture product",
    category: "Dev",
    status,
    source: status === "seeded" ? "crawler" : "skill",
    verifyToken: `verify-${slug}`,
    editTokenHash: hashToken(EDIT_TOKEN),
  });
}

async function insertEvidence(slug: string, assetHash = SHARED_HASH) {
  await db.insert(productProfiles).values({
    slug,
    pricingModel: "open_source",
    lifecycle: "ga",
    longDescriptionMarkdown: "Detailed maker description",
  });
  await db.insert(productLinks).values({
    slug,
    kind: "repository",
    declarationSource: "maker",
    url: `https://github.com/example/${slug}`,
    normalizedKey: `example/${slug}`,
  });
  await db.insert(productEvidenceSources).values({
    slug,
    kind: "repository",
    provider: "github",
    sourceKey: `example/${slug}`,
    sourceUrl: `https://github.com/example/${slug}`,
    state: "ok",
    normalizedFacts: { type: "github_repository", stars: 10 },
  });
  await db.insert(productMedia).values({
    slug,
    sourceUrl: `https://${slug}.example/screenshot.png`,
    assetHash,
    current: true,
    visible: true,
  });
  await db.insert(productUpdates).values({
    slug,
    sourceKind: "github_release",
    dedupeKey: `release:${slug}:1`,
    title: "v1 released",
    observedAt: new Date("2026-08-19T00:00:00.000Z"),
  });
  await db.insert(productAgents).values({
    slug,
    provider: "OpenAI",
    roles: ["implementation"],
    evidenceLevel: "maker_reported",
  });
  await db.insert(productSkills).values({
    slug,
    namespace: "openai",
    name: "review",
    evidenceLevel: "maker_reported",
  });
  await db.insert(productEvidenceAudit).values({
    slug,
    actor: "maker:fixture",
    action: "maker.profile.save",
  });
}

const count = sql<number>`count(*)::int`;

describe("product evidence lifecycle", () => {
  it("maker deletion removes product-owned evidence and the last orphaned media bytes", async () => {
    await insertProduct("delete-one");
    await insertProduct("delete-two");
    await db.insert(mediaAssets).values({
      hash: SHARED_HASH,
      webData: Buffer.from("web"),
      thumbnailData: Buffer.from("thumb"),
      width: 100,
      height: 80,
      thumbnailWidth: 50,
      thumbnailHeight: 40,
      mimeType: "image/webp",
      webSize: 3,
      thumbnailSize: 5,
    });
    await insertEvidence("delete-one");
    await insertEvidence("delete-two");
    await db.insert(productHealth).values({ slug: "delete-one", status: 200 });
    await db.insert(productHealthDaily).values({
      slug: "delete-one",
      day: "2026-08-19",
      checks: 1,
      successes: 1,
      latencyTotalMs: 20,
      latencySamples: 1,
    });

    await expect(deleteProduct("delete-one", { editToken: EDIT_TOKEN }))
      .resolves.toMatchObject({ ok: true });

    const deletedCounts = await Promise.all([
      db.select({ count }).from(productProfiles).where(eq(productProfiles.slug, "delete-one")),
      db.select({ count }).from(productLinks).where(eq(productLinks.slug, "delete-one")),
      db.select({ count }).from(productEvidenceSources).where(eq(productEvidenceSources.slug, "delete-one")),
      db.select({ count }).from(productMedia).where(eq(productMedia.slug, "delete-one")),
      db.select({ count }).from(productUpdates).where(eq(productUpdates.slug, "delete-one")),
      db.select({ count }).from(productAgents).where(eq(productAgents.slug, "delete-one")),
      db.select({ count }).from(productSkills).where(eq(productSkills.slug, "delete-one")),
      db.select({ count }).from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, "delete-one")),
      db.select({ count }).from(productHealth).where(eq(productHealth.slug, "delete-one")),
      db.select({ count }).from(productHealthDaily).where(eq(productHealthDaily.slug, "delete-one")),
    ]);
    expect(deletedCounts.map(([row]) => row.count)).toEqual(Array(10).fill(0));
    expect(await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.hash, SHARED_HASH) }))
      .toBeTruthy();
    expect(await db.query.productMedia.findFirst({
      where: eq(productMedia.slug, "delete-two"),
    })).toBeTruthy();

    await expect(deleteProduct("delete-two", { editToken: EDIT_TOKEN }))
      .resolves.toMatchObject({ ok: true });
    expect(await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.hash, SHARED_HASH) }))
      .toBeUndefined();
  });

  it("admin ban removes public visibility but preserves observations and audit history", async () => {
    await insertProduct("ban-me");
    await db.insert(mediaAssets).values({
      hash: SHARED_HASH,
      webData: Buffer.from("web"),
      thumbnailData: Buffer.from("thumb"),
      width: 100,
      height: 80,
      thumbnailWidth: 50,
      thumbnailHeight: 40,
      mimeType: "image/webp",
      webSize: 3,
      thumbnailSize: 5,
    });
    await insertEvidence("ban-me");

    await expect(banProduct("ban-me")).resolves.toMatchObject({ ok: true });

    expect(await listProducts({ statuses: ["verified", "seeded"], limit: 10 }))
      .toHaveLength(0);
    expect((await db.query.products.findFirst({ where: eq(products.slug, "ban-me") }))?.status)
      .toBe("banned");
    const preservedCounts = await Promise.all([
      db.select({ count }).from(productProfiles).where(eq(productProfiles.slug, "ban-me")),
      db.select({ count }).from(productLinks).where(eq(productLinks.slug, "ban-me")),
      db.select({ count }).from(productEvidenceSources).where(eq(productEvidenceSources.slug, "ban-me")),
      db.select({ count }).from(productMedia).where(eq(productMedia.slug, "ban-me")),
      db.select({ count }).from(productUpdates).where(eq(productUpdates.slug, "ban-me")),
      db.select({ count }).from(productAgents).where(eq(productAgents.slug, "ban-me")),
      db.select({ count }).from(productSkills).where(eq(productSkills.slug, "ban-me")),
    ]);
    expect(preservedCounts.map(([row]) => row.count)).toEqual(Array(7).fill(1));
    const audits = await db.select().from(productEvidenceAudit)
      .where(eq(productEvidenceAudit.slug, "ban-me"))
      .orderBy(asc(productEvidenceAudit.id));
    expect(audits.map((audit) => audit.action)).toEqual([
      "maker.profile.save",
      "admin.product.ban",
    ]);
  });

  it("a maker delete authorized before an admin ban cannot erase the banned product", async () => {
    await insertProduct("ban-wins-delete");
    await db.insert(mediaAssets).values({
      hash: SHARED_HASH,
      webData: Buffer.from("web"),
      thumbnailData: Buffer.from("thumb"),
      width: 100,
      height: 80,
      thumbnailWidth: 50,
      thumbnailHeight: 40,
      mimeType: "image/webp",
      webSize: 3,
      thumbnailSize: 5,
    });
    await insertEvidence("ban-wins-delete");
    const product = await db.query.products.findFirst({
      where: eq(products.slug, "ban-wins-delete"),
    });

    await expect(banProduct("ban-wins-delete")).resolves.toMatchObject({ ok: true });
    await expect(removeProductAndEvidence(product!.id, "ban-wins-delete"))
      .resolves.toBe(false);

    expect((await db.query.products.findFirst({
      where: eq(products.slug, "ban-wins-delete"),
    }))?.status).toBe("banned");
    expect(await db.query.productProfiles.findFirst({
      where: eq(productProfiles.slug, "ban-wins-delete"),
    })).toBeTruthy();
    expect((await db.select().from(productEvidenceAudit)
      .where(eq(productEvidenceAudit.slug, "ban-wins-delete"))
      .orderBy(asc(productEvidenceAudit.id)))
      .map((audit) => audit.action)).toEqual([
      "maker.profile.save",
      "admin.product.ban",
    ]);
  });

  it("repeating an already-applied status transition does not duplicate its audit", async () => {
    await insertProduct("ban-once");
    const product = await db.query.products.findFirst({
      where: eq(products.slug, "ban-once"),
    });
    const transition = {
      id: product!.id,
      slug: "ban-once",
      status: "banned" as const,
      action: "admin.product.ban" as const,
    };

    await expect(setStatusWithAudit(transition)).resolves.toBe(true);
    await expect(setStatusWithAudit(transition)).resolves.toBe(true);

    expect((await db.select().from(productEvidenceAudit)
      .where(eq(productEvidenceAudit.slug, "ban-once")))
      .map((audit) => audit.action)).toEqual(["admin.product.ban"]);
  });

  it("a stale delete cannot remove a replacement product that reused the slug", async () => {
    await insertProduct("reused-slug");
    const oldProduct = await db.query.products.findFirst({
      where: eq(products.slug, "reused-slug"),
    });
    await deleteProduct("reused-slug", { editToken: EDIT_TOKEN });

    await insertProduct("reused-slug");
    await db.insert(productProfiles).values({
      slug: "reused-slug",
      pricingModel: "paid",
      lifecycle: "ga",
      longDescriptionMarkdown: "Replacement product",
    });

    await expect(removeProductAndEvidence(oldProduct!.id, "reused-slug"))
      .resolves.toBe(false);
    expect(await db.query.products.findFirst({ where: eq(products.slug, "reused-slug") }))
      .toBeTruthy();
    expect(await db.query.productProfiles.findFirst({
      where: eq(productProfiles.slug, "reused-slug"),
    })).toMatchObject({ longDescriptionMarkdown: "Replacement product" });
  });

  it("a stale status change neither changes nor audits a replacement product", async () => {
    await insertProduct("status-reuse");
    const oldProduct = await db.query.products.findFirst({
      where: eq(products.slug, "status-reuse"),
    });
    await deleteProduct("status-reuse", { editToken: EDIT_TOKEN });
    await insertProduct("status-reuse");

    await expect(setStatusWithAudit({
      id: oldProduct!.id,
      slug: "status-reuse",
      status: "banned",
      action: "admin.product.ban",
    })).resolves.toBe(false);
    expect((await db.query.products.findFirst({
      where: eq(products.slug, "status-reuse"),
    }))?.status).toBe("verified");
    expect(await db.select().from(productEvidenceAudit)
      .where(eq(productEvidenceAudit.slug, "status-reuse"))).toHaveLength(0);
  });

  it("an in-flight refresh cannot attach the deleted generation's facts to a replacement", async () => {
    await insertProduct("refresh-reuse");
    await db.insert(productLinks).values({
      slug: "refresh-reuse",
      kind: "support",
      declarationSource: "maker",
      url: "https://refresh-reuse.example/support",
      normalizedKey: "https://refresh-reuse.example/support",
    });
    let signalStarted!: () => void;
    let releaseResponse!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const responseReleased = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const refresh = refreshProductEvidence("refresh-reuse", {
      force: true,
      dependencies: {
        genericLink: async (url) => {
          signalStarted();
          await responseReleased;
          return { finalUrl: url };
        },
      },
    });
    await started;

    await deleteProduct("refresh-reuse", { editToken: EDIT_TOKEN });
    await insertProduct("refresh-reuse");
    releaseResponse();

    await expect(refresh).rejects.toThrow(/product generation changed/);
    expect(await db.select().from(productEvidenceSources)
      .where(eq(productEvidenceSources.slug, "refresh-reuse"))).toHaveLength(0);
  });

  it("an old GitHub refresh cannot reschedule a replacement source", async () => {
    await insertProduct("github-reuse");
    await db.insert(productLinks).values({
      slug: "github-reuse",
      kind: "repository",
      declarationSource: "maker",
      url: "https://github.com/example/github-reuse",
      normalizedKey: "example/github-reuse",
    });
    const replacementNextAttempt = new Date("2030-01-01T00:00:00.000Z");

    const refresh = refreshProductEvidence("github-reuse", {
      force: true,
      dependencies: {
        github: async () => {
          await deleteProduct("github-reuse", { editToken: EDIT_TOKEN });
          await insertProduct("github-reuse");
          await db.insert(productLinks).values({
            slug: "github-reuse",
            kind: "repository",
            declarationSource: "maker",
            url: "https://github.com/example/github-reuse",
            normalizedKey: "example/github-reuse",
          });
          await db.insert(productEvidenceSources).values({
            slug: "github-reuse",
            kind: "repository",
            provider: "github",
            sourceKey: "example/github-reuse",
            sourceUrl: "https://github.com/example/github-reuse",
            state: "ok",
            nextAttemptAt: replacementNextAttempt,
          });
          return { status: "updated", releases: 0 };
        },
      },
    });

    await expect(refresh).rejects.toThrow(/product generation changed/);
    expect((await db.query.productEvidenceSources.findFirst({
      where: eq(productEvidenceSources.slug, "github-reuse"),
    }))?.nextAttemptAt).toEqual(replacementNextAttempt);
  });
});

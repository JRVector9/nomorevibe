import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productUpdates } from "@/lib/db/schema";
import { insertUpdateCandidates } from "@/lib/domain/evidence/updates";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.insert(products).values({
    slug: "update-product",
    url: "https://product.example",
    name: "Update Product",
    tagline: "Updates",
    description: "Update evidence",
    category: "Dev",
    status: "verified",
    verifyToken: "verify-token",
    editTokenHash: "a".repeat(64),
  });
});

describe("product update persistence", () => {
  it("collapses GitHub and feed observations of one canonical release and is idempotent", async () => {
    const observedAt = new Date("2026-08-19T00:00:00Z");
    const github = {
      sourceKind: "github_release" as const,
      dedupeKey: "github-release:123",
      canonicalUrl: "https://github.com/owner/repo/releases/tag/v1.6.0",
      title: "v1.6.0",
      summary: null,
      beforeAfter: null,
      publishedAt: new Date("2026-08-18T00:00:00Z"),
      observedAt,
    };
    const feed = {
      sourceKind: "feed" as const,
      dedupeKey: "feed-guid-v1.6.0",
      canonicalUrl: "https://github.com/owner/repo/releases/tag/v1.6.0?source=feed",
      title: "Version 1.6.0 released",
      summary: "<p>Stable release</p>",
      beforeAfter: null,
      publishedAt: new Date("2026-08-18T00:00:00Z"),
      observedAt,
    };

    await expect(insertUpdateCandidates("update-product", [github, feed])).resolves.toBe(1);
    await expect(insertUpdateCandidates("update-product", [feed, github])).resolves.toBe(0);

    const rows = await db.select().from(productUpdates).where(eq(productUpdates.slug, "update-product"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ visible: true, summary: null });
  });

  it("keeps automatic events immutable when the same dedupe key is observed again", async () => {
    const observedAt = new Date("2026-08-19T00:00:00Z");
    const base = {
      sourceKind: "repository_change" as const,
      dedupeKey: "repository:license:MIT:Apache-2.0",
      canonicalUrl: "https://github.com/owner/repo",
      title: "라이선스 변경",
      summary: null,
      beforeAfter: { license: { before: "MIT", after: "Apache-2.0" } },
      publishedAt: null,
      observedAt,
    };
    await expect(insertUpdateCandidates("update-product", [base])).resolves.toBe(1);
    await db.update(productUpdates).set({ visible: false }).where(eq(productUpdates.slug, "update-product"));
    await expect(insertUpdateCandidates("update-product", [{
      ...base,
      title: "조작된 제목",
      observedAt: new Date("2026-08-20T00:00:00Z"),
    }])).resolves.toBe(0);

    const [row] = await db.select().from(productUpdates).where(eq(productUpdates.slug, "update-product"));
    expect(row.title).toBe("라이선스 변경");
    expect(row.visible).toBe(false);
    expect(row.observedAt).toEqual(observedAt);
  });
});

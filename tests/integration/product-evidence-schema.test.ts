import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, rankingEntries } from "@/lib/db/schema";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

type LicenseRow = {
  makerLicense: { value: string } | null;
  normalizedFacts: { license: { spdxId: string } };
};

describe("product evidence schema", () => {
  it("separates declarations, observations, shared media, deduped updates, and ranking", async () => {
    await db.insert(products).values([
      {
        slug: "evidence-a",
        url: "https://evidence-a.test",
        name: "Evidence A",
        tagline: "A",
        description: "A",
        category: "Developer Tools",
        status: "verified",
        verifyToken: "verify-a",
        editTokenHash: "a".repeat(64),
      },
      {
        slug: "evidence-b",
        url: "https://evidence-b.test",
        name: "Evidence B",
        tagline: "B",
        description: "B",
        category: "Developer Tools",
        status: "verified",
        verifyToken: "verify-b",
        editTokenHash: "b".repeat(64),
      },
    ]);

    await db.execute(sql`
      INSERT INTO product_profiles (
        slug, pricing_model, lifecycle, long_description_markdown, maker_license
      ) VALUES (
        'evidence-a', 'open_source', 'ga', 'Maker description',
        ${JSON.stringify({ value: "MIT", spdxId: "MIT" })}::jsonb
      )
    `);

    const observed = JSON.stringify({ license: { value: "Apache License 2.0", spdxId: "Apache-2.0" } });
    await db.execute(sql`
      INSERT INTO product_evidence_sources (
        slug, kind, provider, source_key, state, normalized_facts, last_success_at
      ) VALUES (
        'evidence-a', 'repository', 'github', 'owner/repo', 'ok', ${observed}::jsonb, now()
      )
      ON CONFLICT (slug, kind, source_key) DO UPDATE SET
        normalized_facts = excluded.normalized_facts,
        last_success_at = excluded.last_success_at
    `);
    await db.execute(sql`
      INSERT INTO product_evidence_sources (
        slug, kind, provider, source_key, state, normalized_facts, last_success_at
      ) VALUES (
        'evidence-a', 'repository', 'github', 'owner/repo', 'ok', ${observed}::jsonb, now()
      )
      ON CONFLICT (slug, kind, source_key) DO UPDATE SET
        normalized_facts = excluded.normalized_facts,
        last_success_at = excluded.last_success_at
    `);

    const assetHash = "c".repeat(64);
    const webBytes = Buffer.from("normalized-webp");
    await db.execute(sql`
      INSERT INTO media_assets (
        hash, web_data, thumbnail_data, width, height, thumbnail_width, thumbnail_height,
        mime_type, web_size, thumbnail_size
      ) VALUES (
        ${assetHash}, ${webBytes}, ${webBytes}, 1200, 800, 320, 213,
        'image/webp', ${webBytes.length}, ${webBytes.length}
      )
    `);
    await db.execute(sql`
      INSERT INTO product_media (slug, source_url, asset_hash, position, alt_text, version)
      VALUES
        ('evidence-a', 'https://cdn.test/gallery.png', ${assetHash}, 0, 'Gallery', 1),
        ('evidence-b', 'https://cdn.test/gallery.png', ${assetHash}, 0, 'Gallery', 1)
    `);

    await db.execute(sql`
      INSERT INTO product_updates (slug, source_kind, dedupe_key, title, observed_at)
      VALUES ('evidence-a', 'github_release', 'release:v1.0.0', 'v1.0.0', now())
      ON CONFLICT (slug, dedupe_key) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO product_updates (slug, source_kind, dedupe_key, title, observed_at)
      VALUES ('evidence-a', 'github_release', 'release:v1.0.0', 'duplicate', now())
      ON CONFLICT (slug, dedupe_key) DO NOTHING
    `);

    const rankCountBefore = await db.select({ count: sql<number>`count(*)::int` }).from(rankingEntries);
    await db.execute(sql`
      INSERT INTO product_agents (slug, provider, client, model, roles, evidence_level)
      VALUES ('evidence-a', 'OpenAI', 'Codex', 'gpt-5.6', '["implementation"]'::jsonb, 'maker_reported')
    `);
    await db.execute(sql`
      INSERT INTO product_skills (slug, namespace, name, version, evidence_level)
      VALUES ('evidence-a', 'openai', 'frontend', '1.0.0', 'maker_reported')
    `);
    const rankCountAfter = await db.select({ count: sql<number>`count(*)::int` }).from(rankingEntries);

    const licenseRows = await db.execute(sql`
      SELECT p.maker_license AS "makerLicense", s.normalized_facts AS "normalizedFacts"
      FROM product_profiles p
      JOIN product_evidence_sources s ON s.slug = p.slug
      WHERE p.slug = 'evidence-a'
    `) as unknown as LicenseRow[];
    const sourceCounts = await db.execute(sql`
      SELECT count(*)::int AS count
      FROM product_evidence_sources
      WHERE slug = 'evidence-a' AND kind = 'repository' AND source_key = 'owner/repo'
    `) as unknown as Array<{ count: number }>;
    const mediaCounts = await db.execute(sql`
      SELECT
        count(DISTINCT pm.slug)::int AS "productCount",
        count(DISTINCT ma.hash)::int AS "assetCount"
      FROM product_media pm
      JOIN media_assets ma ON ma.hash = pm.asset_hash
      WHERE pm.asset_hash = ${assetHash}
    `) as unknown as Array<{ productCount: number; assetCount: number }>;
    const updateCounts = await db.execute(sql`
      SELECT count(*)::int AS count
      FROM product_updates
      WHERE slug = 'evidence-a' AND dedupe_key = 'release:v1.0.0'
    `) as unknown as Array<{ count: number }>;

    expect(licenseRows[0].makerLicense?.value).toBe("MIT");
    expect(licenseRows[0].normalizedFacts.license.spdxId).toBe("Apache-2.0");
    expect(sourceCounts[0].count).toBe(1);
    expect(mediaCounts[0]).toEqual({ productCount: 2, assetCount: 1 });
    expect(updateCounts[0].count).toBe(1);
    expect(rankCountAfter).toEqual(rankCountBefore);
  });

  it("stores maker update tombstones and indexes each product timeline by effective time", async () => {
    await db.execute(sql`
      INSERT INTO product_updates (
        slug, source_kind, dedupe_key, title, observed_at, maker_deleted_at
      ) VALUES (
        'evidence-a', 'maker', 'maker:tombstone', 'Removed update', now(), now()
      )
    `);

    const tombstones = await db.execute(sql`
      SELECT maker_deleted_at IS NOT NULL AS deleted
      FROM product_updates
      WHERE slug = 'evidence-a' AND dedupe_key = 'maker:tombstone'
    `) as unknown as Array<{ deleted: boolean }>;
    const indexes = await db.execute(sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'product_updates'
        AND indexname = 'product_updates_visible_order_idx'
    `) as unknown as Array<{ indexdef: string }>;

    expect(tombstones[0]?.deleted).toBe(true);
    expect(indexes[0]?.indexdef).toMatch(
      /\(slug, visible, COALESCE\(published_at, observed_at\) DESC/i,
    );
  });
});

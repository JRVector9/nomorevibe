import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@/lib/db";
import { mediaAssets, productMedia, products } from "@/lib/db/schema";
import { normalizeImage } from "@/lib/domain/media/images";
import { postgresMediaStorage } from "@/lib/domain/media/postgres-storage";
import {
  listProductMedia,
  markProductMediaMissing,
  observeProductMedia,
} from "@/lib/domain/media/repository";
import type { MediaStorage, RelationshipMediaStorage } from "@/lib/domain/media/storage";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.insert(products).values({
    slug: "media-product",
    url: "https://product.example",
    name: "Media Product",
    tagline: "Gallery",
    description: "Gallery product",
    category: "Dev",
    status: "verified",
    verifyToken: "verify-token",
    editTokenHash: "a".repeat(64),
  });
});

async function asset(color: string) {
  const input = await sharp({
    create: { width: 80, height: 50, channels: 3, background: color },
  }).png().toBuffer();
  return normalizeImage(input);
}

describe("product media persistence", () => {
  it("deduplicates normalized bytes and versions a changed source without overwriting old bytes", async () => {
    const purple = await asset("#7755ee");
    const green = await asset("#22aa77");
    const firstAt = new Date("2026-08-19T00:00:00Z");
    await expect(observeProductMedia({
      slug: "media-product",
      sourceUrl: "https://cdn.example/gallery/one.png",
      asset: purple,
      altText: "Product dashboard",
      position: 0,
      observedAt: firstAt,
    })).resolves.toMatchObject({ status: "inserted", version: 1 });
    await expect(observeProductMedia({
      slug: "media-product",
      sourceUrl: "https://cdn.example/gallery/one.png",
      asset: purple,
      altText: "Product dashboard",
      position: 0,
      observedAt: new Date("2026-08-19T01:00:00Z"),
    })).resolves.toMatchObject({ status: "unchanged", version: 1 });
    await expect(observeProductMedia({
      slug: "media-product",
      sourceUrl: "https://cdn.example/gallery/one.png",
      asset: green,
      altText: "Updated dashboard",
      position: 0,
      observedAt: new Date("2026-08-19T02:00:00Z"),
    })).resolves.toMatchObject({ status: "superseded", version: 2 });

    const assets = await db.select().from(mediaAssets);
    const versions = await db.select().from(productMedia).where(eq(productMedia.slug, "media-product"));
    expect(assets).toHaveLength(2);
    expect(versions).toHaveLength(2);
    expect(versions.find((row) => row.assetHash === purple.hash)).toMatchObject({
      current: false,
      version: 1,
      supersededAt: new Date("2026-08-19T02:00:00Z"),
    });
    expect(versions.find((row) => row.assetHash === green.hash)).toMatchObject({
      current: true,
      version: 2,
      supersededAt: null,
    });
    expect((await postgresMediaStorage.get(purple.hash, "web"))?.data.equals(purple.web.data)).toBe(true);
  });

  it("keeps the last internal copy visible when the external source goes missing", async () => {
    const image = await asset("#7755ee");
    const sourceUrl = "https://cdn.example/gallery/missing.png";
    await observeProductMedia({
      slug: "media-product",
      sourceUrl,
      asset: image,
      altText: null,
      position: 0,
      observedAt: new Date("2026-08-19T00:00:00Z"),
    });
    const missingAt = new Date("2026-08-20T00:00:00Z");
    await markProductMediaMissing({ slug: "media-product", sourceUrl, observedAt: missingAt });

    const [row] = await db.select().from(productMedia).where(and(
      eq(productMedia.slug, "media-product"),
      eq(productMedia.current, true),
    ));
    expect(row).toMatchObject({ current: true, visible: true, missingAt });
    expect(await postgresMediaStorage.get(image.hash, "thumbnail")).not.toBeNull();
  });

  it("shows at most eight current gallery images while retaining later copies internally", async () => {
    const image = await asset("#7755ee");
    for (let index = 0; index < 9; index++) {
      await observeProductMedia({
        slug: "media-product",
        sourceUrl: `https://cdn.example/gallery/${index}.png`,
        asset: image,
        altText: `Gallery ${index + 1}`,
        position: index,
        observedAt: new Date("2026-08-19T00:00:00Z"),
      });
    }
    const listed = await listProductMedia("media-product");
    const all = await db.select().from(productMedia).where(and(
      eq(productMedia.slug, "media-product"),
      eq(productMedia.current, true),
    ));
    expect(listed).toHaveLength(8);
    expect(all).toHaveLength(9);
    expect(all.filter((row) => row.visible)).toHaveLength(8);
    expect(await db.select().from(mediaAssets)).toHaveLength(1);
  });

  it("deletes bytes only after every media relationship is gone", async () => {
    const image = await asset("#7755ee");
    await observeProductMedia({
      slug: "media-product",
      sourceUrl: "https://cdn.example/gallery/ref.png",
      asset: image,
      altText: null,
      position: 0,
      observedAt: new Date("2026-08-19T00:00:00Z"),
    });
    await expect(postgresMediaStorage.deleteIfUnreferenced(image.hash)).resolves.toBe(false);
    await db.delete(productMedia).where(eq(productMedia.assetHash, image.hash));
    await expect(postgresMediaStorage.deleteIfUnreferenced(image.hash)).resolves.toBe(true);
    await expect(postgresMediaStorage.get(image.hash, "web")).resolves.toBeNull();
  });

  it("ignores delayed success and missing observations instead of replacing newer state", async () => {
    const purple = await asset("#7755ee");
    const green = await asset("#22aa77");
    const sourceUrl = "https://cdn.example/gallery/ordered.png";
    await observeProductMedia({
      slug: "media-product",
      sourceUrl,
      asset: purple,
      altText: "First",
      position: 0,
      observedAt: new Date("2026-08-19T01:00:00Z"),
    });
    await observeProductMedia({
      slug: "media-product",
      sourceUrl,
      asset: green,
      altText: "Newest",
      position: 0,
      observedAt: new Date("2026-08-19T03:00:00Z"),
    });

    await expect(observeProductMedia({
      slug: "media-product",
      sourceUrl,
      asset: purple,
      altText: "Delayed",
      position: 0,
      observedAt: new Date("2026-08-19T02:00:00Z"),
    })).resolves.toMatchObject({ status: "stale", version: 2 });
    await expect(markProductMediaMissing({
      slug: "media-product",
      sourceUrl,
      observedAt: new Date("2026-08-19T02:30:00Z"),
    })).resolves.toBe(false);
    const missingAt = new Date("2026-08-19T04:00:00Z");
    await expect(markProductMediaMissing({
      slug: "media-product",
      sourceUrl,
      observedAt: missingAt,
    })).resolves.toBe(true);
    await expect(observeProductMedia({
      slug: "media-product",
      sourceUrl,
      asset: green,
      altText: "Delayed success",
      position: 0,
      observedAt: new Date("2026-08-19T03:30:00Z"),
    })).resolves.toMatchObject({ status: "stale", version: 2 });

    const [current] = await db.select().from(productMedia).where(and(
      eq(productMedia.slug, "media-product"),
      eq(productMedia.current, true),
    ));
    expect(current).toMatchObject({
      assetHash: green.hash,
      altText: "Newest",
      lastObservedAt: missingAt,
      lastSuccessAt: new Date("2026-08-19T03:00:00Z"),
      missingAt,
    });
  });

  it("serializes relationship creation with unreferenced deletion for the same asset", async () => {
    const image = await asset("#7755ee");
    let signalPutStarted!: () => void;
    let releasePut!: () => void;
    const putStarted = new Promise<void>((resolve) => { signalPutStarted = resolve; });
    const putReleased = new Promise<void>((resolve) => { releasePut = resolve; });
    const delayedStorage: RelationshipMediaStorage = {
      put: (value) => postgresMediaStorage.put(value),
      async putUnderLock(value) {
        await db.insert(mediaAssets).values({
          hash: value.hash,
          webData: value.web.data,
          thumbnailData: value.thumbnail.data,
          width: value.web.width,
          height: value.web.height,
          thumbnailWidth: value.thumbnail.width,
          thumbnailHeight: value.thumbnail.height,
          mimeType: value.mimeType,
          webSize: value.web.size,
          thumbnailSize: value.thumbnail.size,
        }).onConflictDoNothing({ target: mediaAssets.hash });
        signalPutStarted();
        await putReleased;
      },
      get: (...args) => postgresMediaStorage.get(...args),
      deleteIfUnreferenced: (...args) => postgresMediaStorage.deleteIfUnreferenced(...args),
    };
    const observation = observeProductMedia({
      slug: "media-product",
      sourceUrl: "https://cdn.example/gallery/race.png",
      asset: image,
      altText: null,
      position: 0,
      observedAt: new Date("2026-08-19T00:00:00Z"),
    }, delayedStorage).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await putStarted;

    let deletionSettled = false;
    const deletion = postgresMediaStorage.deleteIfUnreferenced(image.hash).then((value) => {
      deletionSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    const settledBeforeRelationship = deletionSettled;
    releasePut();

    const observed = await observation;
    expect(settledBeforeRelationship).toBe(false);
    expect(observed).toMatchObject({ ok: true, value: { status: "inserted" } });
    await expect(deletion).resolves.toBe(false);
  });

  it("rolls back newly stored bytes when the relationship insert fails", async () => {
    const image = await asset("#7755ee");
    await db.execute(sql`
      alter table product_media
      add constraint product_media_test_reject check (slug <> 'media-product')
    `);
    try {
      await expect(observeProductMedia({
        slug: "media-product",
        sourceUrl: "https://cdn.example/gallery/reject.png",
        asset: image,
        altText: null,
        position: 0,
        observedAt: new Date("2026-08-19T00:00:00Z"),
      })).rejects.toThrow();
    } finally {
      await db.execute(sql`
        alter table product_media drop constraint if exists product_media_test_reject
      `);
    }
    await expect(postgresMediaStorage.get(image.hash, "web")).resolves.toBeNull();
  });

  it("uses the explicit under-lock write path for injected relationship storage", async () => {
    const image = await asset("#7755ee");
    const storage = {
      async put() {
        throw new Error("lock-acquiring put must not run inside the relationship lock");
      },
      async putUnderLock(value: typeof image) {
        await db.insert(mediaAssets).values({
          hash: value.hash,
          webData: value.web.data,
          thumbnailData: value.thumbnail.data,
          width: value.web.width,
          height: value.web.height,
          thumbnailWidth: value.thumbnail.width,
          thumbnailHeight: value.thumbnail.height,
          mimeType: value.mimeType,
          webSize: value.web.size,
          thumbnailSize: value.thumbnail.size,
        }).onConflictDoNothing({ target: mediaAssets.hash });
      },
      get: (...args: Parameters<MediaStorage["get"]>) => postgresMediaStorage.get(...args),
      deleteIfUnreferenced: (...args: Parameters<MediaStorage["deleteIfUnreferenced"]>) => (
        postgresMediaStorage.deleteIfUnreferenced(...args)
      ),
    };

    await expect(observeProductMedia({
      slug: "media-product",
      sourceUrl: "https://cdn.example/gallery/under-lock.png",
      asset: image,
      altText: null,
      position: 0,
      observedAt: new Date("2026-08-19T00:00:00Z"),
    }, storage)).resolves.toMatchObject({ status: "inserted" });
  });
});

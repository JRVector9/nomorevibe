import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { mediaAssets, productMedia } from "@/lib/db/schema";
import type {
  MediaVariant,
  NormalizedImageAsset,
  RelationshipMediaStorage,
  StoredImage,
} from "./storage";

class PostgresMediaStorage implements RelationshipMediaStorage {
  async put(asset: NormalizedImageAsset): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.execute(mediaAssetLock(asset.hash));
      await tx.insert(mediaAssets).values(mediaAssetValues(asset))
        .onConflictDoNothing({ target: mediaAssets.hash });
    });
  }

  async putUnderLock(asset: NormalizedImageAsset): Promise<void> {
    await db.insert(mediaAssets).values(mediaAssetValues(asset))
      .onConflictDoNothing({ target: mediaAssets.hash });
  }

  async get(hash: string, variant: MediaVariant): Promise<StoredImage | null> {
    const row = await db.query.mediaAssets.findFirst({
      where: eq(mediaAssets.hash, hash),
    });
    if (!row) return null;
    return variant === "thumbnail"
      ? { data: Buffer.from(row.thumbnailData), mimeType: row.mimeType, size: row.thumbnailSize }
      : { data: Buffer.from(row.webData), mimeType: row.mimeType, size: row.webSize };
  }

  async deleteIfUnreferenced(hash: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.execute(mediaAssetLock(hash));
      const deleted = await tx.delete(mediaAssets).where(and(
        eq(mediaAssets.hash, hash),
        sql`not exists (
          select 1 from ${productMedia}
          where ${productMedia.assetHash} = ${hash}
        )`,
      )).returning({ hash: mediaAssets.hash });
      return deleted.length > 0;
    });
  }
}

export function mediaAssetLock(hash: string) {
  return sql`select pg_advisory_xact_lock(hashtext(${`media-asset:${hash}`}))`;
}

export function mediaAssetValues(asset: NormalizedImageAsset) {
  return {
    hash: asset.hash,
    webData: asset.web.data,
    thumbnailData: asset.thumbnail.data,
    width: asset.web.width,
    height: asset.web.height,
    thumbnailWidth: asset.thumbnail.width,
    thumbnailHeight: asset.thumbnail.height,
    mimeType: asset.mimeType,
    webSize: asset.web.size,
    thumbnailSize: asset.thumbnail.size,
  };
}

export const postgresMediaStorage: RelationshipMediaStorage = new PostgresMediaStorage();

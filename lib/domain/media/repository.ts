import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { mediaAssets, productMedia } from "@/lib/db/schema";
import { safeHttpUrl } from "@/lib/domain/evidence/contracts";
import { mediaAssetLock, mediaAssetValues, postgresMediaStorage } from "./postgres-storage";
import type { NormalizedImageAsset, RelationshipMediaStorage } from "./storage";

const slugSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const positionSchema = z.number().int().min(0).max(1_000);

function normalizedAltText(value: string | null): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 500) : null;
}

export async function observeProductMedia(
  input: {
    slug: string;
    sourceUrl: string;
    asset: NormalizedImageAsset;
    altText: string | null;
    position: number;
    observedAt: Date;
  },
  storage: RelationshipMediaStorage = postgresMediaStorage,
): Promise<{
  status: "inserted" | "unchanged" | "superseded" | "restored" | "stale";
  version: number;
  visible: boolean;
}> {
  const slug = slugSchema.parse(input.slug);
  const sourceUrl = safeHttpUrl.parse(input.sourceUrl);
  const position = positionSchema.parse(input.position);
  const altText = normalizedAltText(input.altText);
  if (!Number.isFinite(input.observedAt.getTime())) throw new Error("invalid observedAt");
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`product-media:${slug}`}))`);
      const current = await tx.query.productMedia.findFirst({
        where: and(
          eq(productMedia.slug, slug),
          eq(productMedia.sourceUrl, sourceUrl),
          eq(productMedia.current, true),
        ),
      });
      if (current && input.observedAt < current.lastObservedAt) {
        return { status: "stale" as const, version: current.version, visible: current.visible };
      }

      await tx.execute(mediaAssetLock(input.asset.hash));
      if (storage === postgresMediaStorage) {
        await tx.insert(mediaAssets).values(mediaAssetValues(input.asset))
          .onConflictDoNothing({ target: mediaAssets.hash });
      } else {
        await storage.putUnderLock(input.asset);
      }

      if (current?.assetHash === input.asset.hash) {
        await tx.update(productMedia).set({
          altText,
          position,
          lastObservedAt: input.observedAt,
          lastSuccessAt: input.observedAt,
          missingAt: null,
        }).where(eq(productMedia.id, current.id));
        return { status: "unchanged" as const, version: current.version, visible: current.visible };
      }

      const priorSameAsset = await tx.query.productMedia.findFirst({
        where: and(
          eq(productMedia.slug, slug),
          eq(productMedia.sourceUrl, sourceUrl),
          eq(productMedia.assetHash, input.asset.hash),
        ),
      });
      const visibleRows = await tx.select({ id: productMedia.id }).from(productMedia).where(and(
        eq(productMedia.slug, slug),
        eq(productMedia.current, true),
        eq(productMedia.visible, true),
      ));
      const visible = current?.visible ?? visibleRows.length < 8;
      const version = (current?.version ?? priorSameAsset?.version ?? 0) + 1;

      if (current) {
        await tx.update(productMedia).set({
          current: false,
          supersededAt: input.observedAt,
        }).where(eq(productMedia.id, current.id));
      }

      if (priorSameAsset) {
        await tx.update(productMedia).set({
          current: true,
          visible,
          version,
          position,
          altText,
          lastObservedAt: input.observedAt,
          lastSuccessAt: input.observedAt,
          missingAt: null,
          supersededAt: null,
        }).where(eq(productMedia.id, priorSameAsset.id));
        return { status: "restored" as const, version, visible };
      }

      await tx.insert(productMedia).values({
        slug,
        sourceUrl,
        assetHash: input.asset.hash,
        position,
        altText,
        current: true,
        visible,
        version,
        firstObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
        lastSuccessAt: input.observedAt,
      });
      return {
        status: current ? "superseded" as const : "inserted" as const,
        version,
        visible,
      };
    });
  } catch (error) {
    await storage.deleteIfUnreferenced(input.asset.hash).catch(() => false);
    throw error;
  }
}

export async function markProductMediaMissing(input: {
  slug: string;
  sourceUrl: string;
  observedAt: Date;
}): Promise<boolean> {
  const slug = slugSchema.parse(input.slug);
  const sourceUrl = safeHttpUrl.parse(input.sourceUrl);
  if (!Number.isFinite(input.observedAt.getTime())) throw new Error("invalid observedAt");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`product-media:${slug}`}))`);
    const current = await tx.query.productMedia.findFirst({
      where: and(
        eq(productMedia.slug, slug),
        eq(productMedia.sourceUrl, sourceUrl),
        eq(productMedia.current, true),
      ),
    });
    if (!current || input.observedAt < current.lastObservedAt) return false;
    await tx.update(productMedia).set({
      lastObservedAt: input.observedAt,
      missingAt: input.observedAt,
    }).where(eq(productMedia.id, current.id));
    return true;
  });
}

export async function listProductMedia(slugInput: string) {
  const slug = slugSchema.parse(slugInput);
  return db.select().from(productMedia).where(and(
    eq(productMedia.slug, slug),
    eq(productMedia.current, true),
    eq(productMedia.visible, true),
  )).orderBy(asc(productMedia.position), asc(productMedia.id)).limit(8);
}

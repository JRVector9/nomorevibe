import { randomUUID } from "node:crypto";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  productEvidenceAudit,
  productEvidenceSources,
  productMedia,
  productMediaDeclarations,
  productUpdates,
} from "@/lib/db/schema";
import {
  findProductGenerationId,
  lockProductGeneration,
  ProductGenerationChangedError,
} from "@/lib/domain/products/repository";
import { isSafeMakerMarkdown, makerMediaSchema, safeHttpUrl } from "./contracts";

const MAX_MAKER_BODY_BYTES = 64 * 1024;
const slugSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const actorSchema = z.string().min(1).max(120);
const updateIdSchema = z.number().int().positive();

export class MakerRequestBodyError extends Error {
  constructor(public readonly kind: "too_large" | "invalid_json") {
    super(kind === "too_large" ? "request body is too large" : "invalid JSON body");
    this.name = "MakerRequestBodyError";
  }
}

/** Request.json() 전에 선언 크기와 실제 스트림을 모두 제한한다. */
export async function readBoundedJson(
  request: Request,
  limit = MAX_MAKER_BODY_BYTES,
): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new MakerRequestBodyError("too_large");
  }
  if (!request.body) throw new MakerRequestBodyError("invalid_json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new MakerRequestBodyError("too_large");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new MakerRequestBodyError("invalid_json");
  }
}

const updateFields = z.object({
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().max(5_000).refine(isSafeMakerMarkdown, "안전하지 않은 내용입니다").nullable().optional(),
  canonicalUrl: safeHttpUrl.nullable().optional(),
  publishedAt: z.iso.datetime().transform((value) => new Date(value)).nullable().optional(),
}).strict();

export const makerUpdateCreateSchema = updateFields;
export const makerUpdatePatchSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  summary: z.string().trim().max(5_000).refine(isSafeMakerMarkdown, "안전하지 않은 내용입니다").nullable().optional(),
  canonicalUrl: safeHttpUrl.nullable().optional(),
  publishedAt: z.iso.datetime().transform((value) => new Date(value)).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "수정할 필드가 필요합니다");

type MakerUpdateCreate = z.infer<typeof makerUpdateCreateSchema>;
type MakerUpdatePatch = z.infer<typeof makerUpdatePatchSchema>;

async function expectedProductId(slug: string, productId?: number): Promise<number> {
  const current = productId ?? await findProductGenerationId(slug);
  if (current === null) throw new ProductGenerationChangedError();
  return current;
}

export async function replaceMakerMedia(input: {
  slug: string;
  media: unknown;
  actor: string;
  productId?: number;
}): Promise<number> {
  const slug = slugSchema.parse(input.slug);
  const actor = actorSchema.parse(input.actor);
  const productId = await expectedProductId(slug, input.productId);
  const { items } = makerMediaSchema.parse(input.media);
  const urls = items.map((item) => item.url);
  if (new Set(urls).size !== urls.length) throw new Error("duplicate media URL");
  const now = new Date();

  await db.transaction(async (tx) => {
    if (!(await lockProductGeneration(tx, productId, slug))) {
      throw new ProductGenerationChangedError();
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`product-media:${slug}`}))`);
    if (items.length > 0) {
      await tx.insert(productMediaDeclarations).values(items.map((item, position) => ({
        slug,
        sourceUrl: item.url,
        altText: item.altText.trim(),
        position,
        nextAttemptAt: now,
        updatedAt: now,
      }))).onConflictDoUpdate({
        target: [productMediaDeclarations.slug, productMediaDeclarations.sourceUrl],
        set: {
          altText: sql`excluded.alt_text`,
          position: sql`excluded.position`,
          revision: sql`${productMediaDeclarations.revision} + 1`,
          nextAttemptAt: now,
          updatedAt: now,
        },
      });
    }
    await tx.delete(productMediaDeclarations).where(and(
      eq(productMediaDeclarations.slug, slug),
      urls.length > 0 ? notInArray(productMediaDeclarations.sourceUrl, urls) : undefined,
    ));
    await tx.update(productMedia).set({ visible: false }).where(and(
      eq(productMedia.slug, slug),
      eq(productMedia.current, true),
      urls.length > 0 ? notInArray(productMedia.sourceUrl, urls) : undefined,
    ));
    for (const [position, item] of items.entries()) {
      await tx.update(productMedia).set({
        altText: item.altText.trim(),
        position,
      }).where(and(
        eq(productMedia.slug, slug),
        eq(productMedia.sourceUrl, item.url),
        eq(productMedia.current, true),
      ));
    }
    await tx.insert(productEvidenceAudit).values({
      slug,
      actor,
      action: "maker.media.replace",
      metadata: { count: items.length },
    });
  });
  return items.length;
}

export async function createMakerUpdate(input: {
  slug: string;
  update: MakerUpdateCreate;
  actor: string;
  productId?: number;
}): Promise<number> {
  const slug = slugSchema.parse(input.slug);
  const actor = actorSchema.parse(input.actor);
  const productId = await expectedProductId(slug, input.productId);
  const update = makerUpdateCreateSchema.parse(input.update);
  return db.transaction(async (tx) => {
    if (!(await lockProductGeneration(tx, productId, slug))) {
      throw new ProductGenerationChangedError();
    }
    const [created] = await tx.insert(productUpdates).values({
      slug,
      sourceKind: "maker",
      dedupeKey: `maker:${randomUUID()}`,
      title: update.title,
      summary: update.summary ?? null,
      canonicalUrl: update.canonicalUrl ?? null,
      publishedAt: update.publishedAt ?? null,
      observedAt: new Date(),
    }).returning({ id: productUpdates.id });
    await tx.insert(productEvidenceAudit).values({
      slug,
      actor,
      action: "maker.update.create",
      metadata: { updateId: created.id },
    });
    return created.id;
  });
}

export type MakerUpdateMutationResult = "updated" | "deleted" | "not_found" | "forbidden";

export async function editMakerUpdate(input: {
  slug: string;
  id: number;
  patch: MakerUpdatePatch;
  actor: string;
  productId?: number;
}): Promise<MakerUpdateMutationResult> {
  const slug = slugSchema.parse(input.slug);
  const id = updateIdSchema.parse(input.id);
  const actor = actorSchema.parse(input.actor);
  const patch = makerUpdatePatchSchema.parse(input.patch);
  const productId = await expectedProductId(slug, input.productId);
  return db.transaction(async (tx) => {
    if (!(await lockProductGeneration(tx, productId, slug))) return "not_found";
    const row = await tx.query.productUpdates.findFirst({
      where: and(eq(productUpdates.id, id), eq(productUpdates.slug, slug)),
    });
    if (!row) return "not_found";
    if (row.sourceKind !== "maker" || row.makerDeletedAt) return "forbidden";
    await tx.update(productUpdates).set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.canonicalUrl !== undefined ? { canonicalUrl: patch.canonicalUrl } : {}),
      ...(patch.publishedAt !== undefined ? { publishedAt: patch.publishedAt } : {}),
      makerEditedAt: new Date(),
      makerEditedBy: actor,
    }).where(eq(productUpdates.id, id));
    await tx.insert(productEvidenceAudit).values({
      slug,
      actor,
      action: "maker.update.edit",
      metadata: { updateId: id, fields: Object.keys(patch).sort() },
    });
    return "updated";
  });
}

export async function tombstoneMakerUpdate(input: {
  slug: string;
  id: number;
  actor: string;
  productId?: number;
}): Promise<MakerUpdateMutationResult> {
  const slug = slugSchema.parse(input.slug);
  const id = updateIdSchema.parse(input.id);
  const actor = actorSchema.parse(input.actor);
  const productId = await expectedProductId(slug, input.productId);
  return db.transaction(async (tx) => {
    if (!(await lockProductGeneration(tx, productId, slug))) return "not_found";
    const row = await tx.query.productUpdates.findFirst({
      where: and(eq(productUpdates.id, id), eq(productUpdates.slug, slug)),
    });
    if (!row) return "not_found";
    if (row.sourceKind !== "maker") return "forbidden";
    if (!row.makerDeletedAt) {
      await tx.update(productUpdates).set({
        visible: false,
        makerDeletedAt: new Date(),
      }).where(eq(productUpdates.id, id));
      await tx.insert(productEvidenceAudit).values({
        slug,
        actor,
        action: "maker.update.delete",
        metadata: { updateId: id },
      });
    }
    return "deleted";
  });
}

export async function queueMakerRefresh(input: {
  slug: string;
  actor: string;
  productId?: number;
}): Promise<void> {
  const slug = slugSchema.parse(input.slug);
  const actor = actorSchema.parse(input.actor);
  const productId = await expectedProductId(slug, input.productId);
  await db.transaction(async (tx) => {
    if (!(await lockProductGeneration(tx, productId, slug))) {
      throw new ProductGenerationChangedError();
    }
    const now = new Date();
    await tx.update(productEvidenceSources).set({ nextAttemptAt: now, updatedAt: now })
      .where(eq(productEvidenceSources.slug, slug));
    await tx.update(productMediaDeclarations).set({ nextAttemptAt: now, updatedAt: now })
      .where(eq(productMediaDeclarations.slug, slug));
    await tx.insert(productEvidenceAudit).values({
      slug,
      actor,
      action: "maker.refresh.queue",
      metadata: {},
    });
  });
}

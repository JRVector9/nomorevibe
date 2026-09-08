import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { products, productEvidenceAudit, productEvidenceSources, productMediaDeclarations } from "@/lib/db/schema";
import {
  productRefreshRequests,
  type ProductRefreshProgress,
  type ProductRefreshRequest,
} from "@/lib/db/product-evidence-schema";
import {
  findProductGenerationId,
  ProductGenerationChangedError,
  withProductGeneration,
} from "@/lib/domain/products/generation";
import { requestJob, assertJobLease, type JobLease } from "@/lib/jobs/control";
import type { ProductEvidenceRefreshResult } from "./refresh";

const requestSchema = z.object({
  slug: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
  productId: z.number().int().positive().optional(),
  actor: z.string().trim().min(1).max(120),
  force: z.boolean().default(false),
});
const ADMIN_REFRESH_INTERVAL_MS = 60_000;

export class ProductRefreshRateLimitError extends Error {
  constructor(public readonly retryAt: Date) {
    super("product refresh requested too recently");
    this.name = "ProductRefreshRateLimitError";
  }
}

export type ProductRefreshReceipt = {
  productId: number;
  requestedVersion: number;
  status: "queued";
};

/** Requests awaiting a run coalesce; one arriving during a run gets a later version. */
export function nextProductRefreshVersion(current: Pick<ProductRefreshRequest,
  "requestedVersion" | "completedVersion" | "activeVersion"> | undefined): number {
  if (!current) return 1;
  const pendingAfterActive = current.activeVersion ?? current.completedVersion;
  return current.requestedVersion > pendingAfterActive
    ? current.requestedVersion
    : current.requestedVersion + 1;
}

export async function queueProductRefresh(input: z.input<typeof requestSchema>): Promise<ProductRefreshReceipt> {
  const value = requestSchema.parse(input);
  const productId = value.productId ?? await findProductGenerationId(value.slug);
  if (productId === null) throw new ProductGenerationChangedError();
  return withProductGeneration(value.slug, productId, async tx => {
    const now = new Date();
    const [current] = await tx.select().from(productRefreshRequests)
      .where(eq(productRefreshRequests.productId, productId)).for("update");
    if (value.force && current && current.requestedVersion === current.completedVersion
      && now.getTime() - current.requestedAt.getTime() < ADMIN_REFRESH_INTERVAL_MS) {
      throw new ProductRefreshRateLimitError(new Date(current.requestedAt.getTime() + ADMIN_REFRESH_INTERVAL_MS));
    }
    const requestedVersion = nextProductRefreshVersion(current);
    const pending = current && current.requestedVersion > (current.activeVersion ?? current.completedVersion);
    const force = value.force || Boolean(pending && current.force);
    if (current && current.requestedVersion === requestedVersion && (!value.force || current.force)) {
      return { productId, requestedVersion, status: "queued" };
    }
    const values = { productId, slug: value.slug, requestedVersion, force,
      actor: value.actor, requestedAt: now, updatedAt: now,
      // Use the same clock as the request. Database/app clock skew must not
      // defer a newly accepted request until a later poll.
      nextAttemptAt: current?.activeVersion ? current.nextAttemptAt : now };
    await tx.insert(productRefreshRequests).values(values).onConflictDoUpdate({
      target: productRefreshRequests.productId,
      // A new request cannot bypass a provider wait of the captured run.
      set: values,
    });
    if (!value.force) {
      // Preserve the maker's due refresh; provider failures retain their retry deadline.
      await tx.update(productEvidenceSources).set({ nextAttemptAt: now, updatedAt: now }).where(and(
        eq(productEvidenceSources.slug, value.slug),
        or(isNull(productEvidenceSources.lastErrorCode), lte(productEvidenceSources.nextAttemptAt, now)),
      ));
      await tx.update(productMediaDeclarations).set({ nextAttemptAt: now, updatedAt: now })
        .where(eq(productMediaDeclarations.slug, value.slug));
    }
    await tx.insert(productEvidenceAudit).values({
      slug: value.slug, actor: value.actor,
      action: value.force ? "admin.evidence.refresh.queue" : "maker.refresh.queue",
      metadata: { productId, requestedVersion, force, coalesced: current?.requestedVersion === requestedVersion },
    });
    await requestJob("product-evidence-refresh", tx);
    return { productId, requestedVersion, status: "queued" };
  });
}

export async function getProductRefreshRequest(slug: string): Promise<ProductRefreshRequest | null> {
  const [row] = await db.select({ request: productRefreshRequests }).from(productRefreshRequests)
    .innerJoin(products, and(eq(products.id, productRefreshRequests.productId), eq(products.slug, productRefreshRequests.slug)))
    .where(eq(productRefreshRequests.slug, slug)).limit(1);
  return row?.request ?? null;
}

export async function dueProductRefreshRequests(now: Date, limit = 1): Promise<ProductRefreshRequest[]> {
  return db.select({ request: productRefreshRequests }).from(productRefreshRequests)
    .innerJoin(products, and(eq(products.id, productRefreshRequests.productId), eq(products.slug, productRefreshRequests.slug)))
    .where(and(
      gt(productRefreshRequests.requestedVersion, productRefreshRequests.completedVersion),
      lte(productRefreshRequests.nextAttemptAt, now),
    ))
    .orderBy(asc(productRefreshRequests.nextAttemptAt), asc(productRefreshRequests.productId))
    .limit(Math.max(1, Math.min(100, limit))).then(rows => rows.map(row => row.request));
}

export async function beginProductRefresh(
  request: ProductRefreshRequest, now: Date, lease?: JobLease,
): Promise<ProductRefreshRequest | null> {
  return withProductGeneration(request.slug, request.productId, async tx => {
    const [current] = await tx.select().from(productRefreshRequests)
      .where(eq(productRefreshRequests.productId, request.productId)).for("update");
    if (lease) await assertJobLease(tx, lease);
    if (!current || current.requestedVersion <= current.completedVersion || current.nextAttemptAt > now) return null;
    if (current.activeVersion !== null) return current;
    const [started] = await tx.update(productRefreshRequests).set({
      activeVersion: current.requestedVersion, activeForce: current.force,
      progress: { completedKeys: [], retryAfterByKey: {} }, result: {},
      startedAt: now, lastError: null, updatedAt: now,
    }).where(eq(productRefreshRequests.productId, current.productId)).returning();
    return started;
  });
}

export async function saveProductRefreshProgress(
  request: ProductRefreshRequest,
  progress: ProductRefreshProgress,
  options: { now: Date; lease?: JobLease; result?: ProductEvidenceRefreshResult; error?: string } ,
): Promise<void> {
  await withProductGeneration(request.slug, request.productId, async tx => {
    const [current] = await tx.select().from(productRefreshRequests)
      .where(eq(productRefreshRequests.productId, request.productId)).for("update");
    if (options.lease) await assertJobLease(tx, options.lease);
    if (!current || current.activeVersion !== request.activeVersion || request.activeVersion === null) {
      throw new Error("product refresh request changed");
    }
    const complete = options.result?.complete === true && !options.error;
    const { result } = options;
    const totals = { ...current.result };
    if (result) for (const key of ["sourcesAttempted", "sourcesFailed", "factsChanged", "eventsInserted", "mediaInserted"] as const) {
      totals[key] = (totals[key] ?? 0) + result[key];
    }
    const waits = Object.values(progress.retryAfterByKey).map(value => new Date(value).getTime())
      .filter(value => Number.isFinite(value) && value > options.now.getTime());
    const nextAttemptAt = options.error ? new Date(options.now.getTime() + 60_000)
      : result?.nextAttemptAt ?? (waits.length ? new Date(Math.min(...waits)) : options.now);
    await tx.update(productRefreshRequests).set({
      progress, result: totals, updatedAt: options.now,
      ...(result || options.error ? { nextAttemptAt, lastError: options.error?.slice(0, 200)
        ?? (result?.sourcesFailed ? "source_refresh_failed" : null) } : {}),
      ...(complete ? {
        completedVersion: request.activeVersion, activeVersion: null, completedAt: options.now,
        nextAttemptAt: options.now, lastError: null,
      } : {}),
    }).where(and(eq(productRefreshRequests.productId, request.productId),
      eq(productRefreshRequests.activeVersion, request.activeVersion)));
  });
}

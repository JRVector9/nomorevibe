import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productRepoReviews, products } from "@/lib/db/schema";
import type { ProductTransaction } from "./generation";
import { repoMoveSnapshotSchema, type RepoMoveSnapshot } from "./repo-move-review";

/** Build raw revisions in PostgreSQL; Date would discard the CAS microseconds. */
export const repoMoveSnapshotSelection = sql<RepoMoveSnapshot>`jsonb_build_object(
  'id',${products.id},'slug',${products.slug},'url',${products.url},'repoUrl',${products.repoUrl},
  'repoLinkVersion',${products.repoLinkVersion},'updatedAt',${products.updatedAt}::text,
  'name',${products.name},'description',left(${products.description},8000),'status',${products.status},'source',${products.source},
  'accessMode',${products.accessMode},'claimedAt',${products.claimedAt}::text,
  'activeMaker',exists(select 1 from product_maker_members m where m.product_id=${products.id} and m.revoked_at is null),
  'repoStatus',${products.repoStatus},'repoCheckedAt',${products.repoCheckedAt}::text,
  'repoMissingSince',${products.repoMissingSince}::text,'repoRenamedTo',${products.repoRenamedTo},
  'review',case when ${productRepoReviews.productId} is null then null else jsonb_build_object(
    'reviewedAt',${productRepoReviews.reviewedAt}::text,'operatorDecision',${productRepoReviews.operatorDecision},
    'operatorAt',${productRepoReviews.operatorAt}::text) end)`;

export async function readRepoMoveSnapshot(productId: number, tx: ProductTransaction | typeof db = db): Promise<RepoMoveSnapshot | null> {
  const [row] = await tx.select({ snapshot: repoMoveSnapshotSelection }).from(products)
    .leftJoin(productRepoReviews, eq(productRepoReviews.productId, products.id)).where(eq(products.id, productId));
  if (!row) return null;
  const parsed = repoMoveSnapshotSchema.safeParse(row.snapshot);
  return parsed.success ? parsed.data : null;
}

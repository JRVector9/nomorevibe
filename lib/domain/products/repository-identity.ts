import { eq, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { normalizeTypedLink } from "@/lib/domain/evidence/contracts";
import { repositoryUrl } from "./access";
import type { ProductTransaction } from "./generation";

/** The crawl identity is the repository, even when its public homepage changes. */
export async function findRepositoryProduct(repo: string, homepage?: string | null, executor: typeof db | ProductTransaction = db) {
  const canonical = repositoryUrl(repo)?.toLowerCase();
  if (!canonical && !homepage) return undefined;
  const [existing] = await executor.select().from(products).where(or(
    homepage ? eq(products.url, homepage) : undefined,
    canonical ? eq(products.url, canonical) : undefined,
    canonical ? sql`regexp_replace(regexp_replace(lower(rtrim(${products.repoUrl}, '/')), '^https?://(www[.])?', 'https://'), '[.]git$', '') = ${canonical}` : undefined,
  )).orderBy(sql`case when ${products.status} = 'banned' then 0 else 1 end`, products.id).limit(1);
  return existing;
}

/** Serialize the empty-row case too: row locks cannot protect an absent repository. */
export async function lockProductRepository(tx: ProductTransaction, repoUrl?: string | null) {
  const identity = repoUrl ? normalizeTypedLink("repository", repoUrl)?.normalizedKey : null;
  if (identity) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`product-repository:${identity}`}))`);
}

import { sql } from "drizzle-orm";
import type { ProductTransaction } from "@/lib/domain/products/generation";

/**
 * Lock the repository/scope identity, including scan rows that do not exist yet.
 * A latest-row FOR SHARE alone cannot prevent a newer SHA from being inserted before publication.
 * Readers lock candidate → document → settings → this identity → scan/observations → job lease.
 * Scan writers take this identity before their scan upsert and observation inserts, with no network.
 */
export async function lockRepositoryAgentEvidence(tx: ProductTransaction, repositoryKey: string, scope = ""): Promise<void> {
  const repository = repositoryKey.toLowerCase();
  const normalizedScope = scope.replace(/^\/+|\/+$/g, "");
  const key = JSON.stringify(["agent-evidence", repository, normalizedScope]);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

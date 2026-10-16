import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { evidenceSourceControl } from "@/lib/db/evidence-source-claims-schema";
/** Inactive additive path; changing this row is a separate operational rollout. */
export async function canonicalSourceMode(): Promise<boolean> {
  const [row] = await db.select({ enabled: evidenceSourceControl.enabled }).from(evidenceSourceControl).where(eq(evidenceSourceControl.id, 1));
  return row?.enabled === true;
}

import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  rankingPolicyRevisions,
  type RankingPolicyRevision,
} from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import {
  DEFAULT_RANKING_POLICY,
  rankingPolicySchema,
  rankingPolicyWarnings,
} from "./policy";

export type PolicySaveResult =
  | { ok: true; revision: RankingPolicyRevision; warnings: string[] }
  | { ok: false; issues: string[] };

const policyLock = sql`select pg_advisory_xact_lock(hashtext('ranking-policy'))`;

export async function ensureDefaultPolicy(
  createdBy = "system",
  now = new Date(),
): Promise<RankingPolicyRevision> {
  return db.transaction(async (tx) => {
    await tx.execute(policyLock);

    const [existing] = await tx
      .select()
      .from(rankingPolicyRevisions)
      .where(eq(rankingPolicyRevisions.state, "applied"))
      .orderBy(desc(rankingPolicyRevisions.createdAt), desc(rankingPolicyRevisions.id))
      .limit(1);
    if (existing) return existing;

    const [created] = await tx
      .insert(rankingPolicyRevisions)
      .values({
        values: DEFAULT_RANKING_POLICY,
        state: "applied",
        createdBy,
        createdAt: now,
        appliedAt: now,
      })
      .returning();
    return created;
  });
}

export async function getAppliedPolicy(): Promise<RankingPolicyRevision | undefined> {
  const [revision] = await db
    .select()
    .from(rankingPolicyRevisions)
    .where(eq(rankingPolicyRevisions.state, "applied"))
    .orderBy(desc(rankingPolicyRevisions.createdAt), desc(rankingPolicyRevisions.id))
    .limit(1);
  return revision;
}

export async function getScheduledPolicy(): Promise<RankingPolicyRevision | undefined> {
  const [revision] = await db
    .select()
    .from(rankingPolicyRevisions)
    .where(eq(rankingPolicyRevisions.state, "scheduled"))
    .limit(1);
  return revision;
}

export async function listPolicyRevisions(): Promise<RankingPolicyRevision[]> {
  return db
    .select()
    .from(rankingPolicyRevisions)
    .orderBy(asc(rankingPolicyRevisions.createdAt), asc(rankingPolicyRevisions.id));
}

export async function schedulePolicy(
  raw: unknown,
  createdBy: string,
  now = new Date(),
): Promise<PolicySaveResult> {
  const parsed = rankingPolicySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "설정"}: ${issue.message}`,
      ),
    };
  }

  try {
    const revision = await db.transaction(async (tx) => {
      await tx.execute(policyLock);

      await tx
        .update(rankingPolicyRevisions)
        .set({ state: "cancelled", cancelledAt: now })
        .where(eq(rankingPolicyRevisions.state, "scheduled"));

      const [created] = await tx
        .insert(rankingPolicyRevisions)
        .values({
          values: parsed.data,
          state: "scheduled",
          createdBy,
          createdAt: now,
        })
        .returning();
      return created;
    });

    return { ok: true, revision, warnings: rankingPolicyWarnings(parsed.data) };
  } catch (error) {
    logger.error("ranking.policy_schedule_failed", { createdBy, error });
    return { ok: false, issues: ["랭킹 설정을 예약하지 못했습니다. 잠시 후 다시 시도해주세요."] };
  }
}

export async function cancelScheduledPolicy(
  cancelledBy: string,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(policyLock);
    await tx
      .update(rankingPolicyRevisions)
      .set({ state: "cancelled", cancelledAt: now })
      .where(eq(rankingPolicyRevisions.state, "scheduled"));
  });

  logger.info("ranking.policy_cancelled", { cancelledBy });
}

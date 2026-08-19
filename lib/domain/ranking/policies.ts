import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  rankingPolicyRevisions,
  visitCollectionState,
  type RankingPolicyRevision,
} from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import {
  DEFAULT_RANKING_POLICY,
  parseRankingPolicy,
  rankingPolicySchema,
  rankingPolicyWarnings,
  UNIQUE_FIRST_RANKING_POLICY,
  type RankingPolicy,
} from "./policy";

const UNIQUE_COLLECTION_WARMUP_MS = 7 * 24 * 60 * 60 * 1000;

export type PolicySaveResult =
  | { ok: true; revision: RankingPolicyRevision; warnings: string[] }
  | { ok: false; issues: string[] };

export type UniqueCollectionReadiness = {
  startedAt: Date | null;
  readyAt: Date | null;
  ready: boolean;
};

const policyLock = sql`select pg_advisory_xact_lock(hashtext('ranking-policy'))`;
type PolicyTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PolicyExecutor = typeof db | PolicyTransaction;

function normalizeRevision(revision: RankingPolicyRevision): RankingPolicyRevision {
  return { ...revision, values: parseRankingPolicy(revision.values) };
}

async function readUniqueCollectionReadiness(
  executor: PolicyExecutor,
  now: Date,
): Promise<UniqueCollectionReadiness> {
  const [state] = await executor
    .select({ startedAt: visitCollectionState.uniqueVisitorStartedAt })
    .from(visitCollectionState)
    .where(eq(visitCollectionState.id, 1))
    .limit(1);
  const startedAt = state?.startedAt ?? null;
  const readyAt = startedAt
    ? new Date(startedAt.getTime() + UNIQUE_COLLECTION_WARMUP_MS)
    : null;
  return {
    startedAt,
    readyAt,
    ready: readyAt !== null && now.getTime() >= readyAt.getTime(),
  };
}

export function getUniqueCollectionReadiness(
  now = new Date(),
): Promise<UniqueCollectionReadiness> {
  return readUniqueCollectionReadiness(db, now);
}

export function transitionPreviewPolicies(raw: unknown): {
  form: RankingPolicy;
  valid: RankingPolicy;
  unique: RankingPolicy;
} {
  const form = parseRankingPolicy(raw);
  return {
    form,
    valid: form.scoring.mode === "valid_visits"
      ? form
      : parseRankingPolicy({ ...form, scoring: DEFAULT_RANKING_POLICY.scoring }),
    unique: form.scoring.mode === "unique_visitors"
      ? form
      : parseRankingPolicy({ ...form, scoring: UNIQUE_FIRST_RANKING_POLICY.scoring }),
  };
}

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
      .orderBy(desc(rankingPolicyRevisions.appliedAt), desc(rankingPolicyRevisions.id))
      .limit(1);
    if (existing) return normalizeRevision(existing);

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
    return normalizeRevision(created);
  });
}

export async function getAppliedPolicy(): Promise<RankingPolicyRevision | undefined> {
  const [revision] = await db
    .select()
    .from(rankingPolicyRevisions)
    .where(eq(rankingPolicyRevisions.state, "applied"))
    .orderBy(desc(rankingPolicyRevisions.appliedAt), desc(rankingPolicyRevisions.id))
    .limit(1);
  return revision ? normalizeRevision(revision) : undefined;
}

export async function getScheduledPolicy(): Promise<RankingPolicyRevision | undefined> {
  const [revision] = await db
    .select()
    .from(rankingPolicyRevisions)
    .where(eq(rankingPolicyRevisions.state, "scheduled"))
    .limit(1);
  return revision ? normalizeRevision(revision) : undefined;
}

export async function listPolicyRevisions(): Promise<RankingPolicyRevision[]> {
  const revisions = await db
    .select()
    .from(rankingPolicyRevisions)
    .orderBy(asc(rankingPolicyRevisions.createdAt), asc(rankingPolicyRevisions.id));
  return revisions.map(normalizeRevision);
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

      if (parsed.data.scoring.mode === "unique_visitors") {
        const readiness = await readUniqueCollectionReadiness(tx, now);
        if (!readiness.startedAt) {
          throw new UniqueCollectionNotReadyError("고유 유입자 집계가 아직 시작되지 않았습니다.");
        }
        if (!readiness.ready) {
          throw new UniqueCollectionNotReadyError(
            `고유 유입자 집계 시작 후 7일이 지나야 예약할 수 있습니다. 준비 시각: ${readiness.readyAt!.toISOString()}`,
          );
        }
      }

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
      return normalizeRevision(created);
    });

    return { ok: true, revision, warnings: rankingPolicyWarnings(parsed.data) };
  } catch (error) {
    if (error instanceof UniqueCollectionNotReadyError) {
      return { ok: false, issues: [error.message] };
    }
    logger.error("ranking.policy_schedule_failed", { createdBy, error });
    return { ok: false, issues: ["랭킹 설정을 예약하지 못했습니다. 잠시 후 다시 시도해주세요."] };
  }
}

class UniqueCollectionNotReadyError extends Error {}

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

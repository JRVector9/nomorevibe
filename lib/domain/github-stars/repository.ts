import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { githubUserConnections } from "@/lib/db/github-user-schema";
import { githubStarOperations, githubStarOperationReceipts, type GithubStarOperation } from "@/lib/db/github-star-schema";
import { PublicAuthError } from "@/lib/domain/accounts/request-auth";
import { rateLimit } from "@/lib/rate-limit";
import type { GithubFlowTransaction } from "@/lib/domain/github-user/repository";
import type { GithubStarState, StarView, StarWrite } from "./contract";

export type StarTarget = { productId: number; productRepoUrl: string; repositoryId: number; owner: string; repo: string };
type StarCredential = { revision: number; githubUserId: number };
export async function starCredentialIsCurrent(userId: number, credential: StarCredential): Promise<boolean> {
  return onPrimary(async () => {
    const [connection] = await db.select({ userId: githubUserConnections.userId }).from(githubUserConnections).where(and(eq(githubUserConnections.userId, userId), eq(githubUserConnections.revision, credential.revision), eq(githubUserConnections.githubUserId, credential.githubUserId), eq(githubUserConnections.state, "active"), sql`${githubUserConnections.accessExpiresAt} > clock_timestamp()`));
    return !!connection;
  });
}
const key = (userId: number, repositoryId: number) => and(eq(githubStarOperations.userId, userId), eq(githubStarOperations.repositoryId, repositoryId));
const receiptKey = (userId: number, operationId: string) => and(eq(githubStarOperationReceipts.userId, userId), eq(githubStarOperationReceipts.operationId, operationId));
type StoredResponse = NonNullable<(typeof githubStarOperationReceipts.$inferSelect)["response"]>;
function receiptView(response: StoredResponse): StarView {
  const { productRepoUrl, ...view } = response;
  if (typeof productRepoUrl !== "string") throw new PublicAuthError(409, "star_operation_conflict");
  return view;
}

/** Receipt reads authorize no external write and require only the current local target snapshot. */
export async function replayStarResponse(slug: string, userId: number, input: StarWrite): Promise<StarView | null> {
  return onPrimary(() => db.transaction(async (tx) => {
    const [receipt] = await tx.select().from(githubStarOperationReceipts).where(receiptKey(userId, input.operationId));
    if (!receipt) return null;
    const [product] = await tx.select({ id: products.id, repoUrl: products.repoUrl, status: products.status }).from(products).where(eq(products.slug, slug)).for("update");
    if (!product) throw new PublicAuthError(404, "product_not_found");
    if (product.status === "banned") throw new PublicAuthError(403, "product_unavailable");
    if (receipt.productId !== product.id || receipt.starred !== input.starred || receipt.expectedRevision !== input.expectedRevision) throw new PublicAuthError(409, "star_operation_conflict");
    let snapshot = receipt.response?.productRepoUrl;
    if (!receipt.response) {
      const [pending] = await tx.select().from(githubStarOperations).where(key(userId, receipt.repositoryId));
      if (pending?.operationId === input.operationId) snapshot = pending.productRepoUrl;
    }
    if (!snapshot || snapshot !== product.repoUrl) throw new PublicAuthError(409, "star_operation_conflict");
    if (!receipt.response) throw new PublicAuthError(409, "star_operation_in_progress");
    return receiptView(receipt.response);
  }));
}

export function starView(row: GithubStarOperation): StarView {
  return { state: row.state, revision: row.revision, repositoryId: row.repositoryId, pending: !!row.leaseOwner, ...(row.operationId ? { operationId: row.operationId } : {}), ...(row.state === "unknown" && row.desiredStarred !== null ? { uncertain: true } : {}) };
}
async function lockUser(tx: GithubFlowTransaction, userId: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`github-star:${userId}`}, 0))`);
}
async function nextRevision(tx: GithubFlowTransaction, userId: number) {
  const [row] = await tx.select({ revision: sql<number>`coalesce(max(${githubStarOperations.revision}), 0)::int + 1` }).from(githubStarOperations).where(eq(githubStarOperations.userId, userId));
  return row.revision;
}
async function validateTarget(tx: GithubFlowTransaction, target: StarTarget) {
  const [product] = await tx.select({ repoUrl: products.repoUrl, status: products.status }).from(products).where(eq(products.id, target.productId)).for("update");
  if (!product || product.status === "banned" || product.repoUrl !== target.productRepoUrl) throw new PublicAuthError(409, "star_repository_changed");
}

export async function knownStarRepositoryId(userId: number, productId: number, productRepoUrl: string): Promise<number | undefined> {
  return onPrimary(async () => {
    const [row] = await db.select({ repositoryId: githubStarOperations.repositoryId }).from(githubStarOperations).where(and(eq(githubStarOperations.userId, userId), eq(githubStarOperations.productId, productId), eq(githubStarOperations.productRepoUrl, productRepoUrl))).orderBy(desc(githubStarOperations.revision)).limit(1);
    return row?.repositoryId;
  });
}

export async function loadStarOperation(userId: number, target: StarTarget): Promise<GithubStarOperation> {
  return onPrimary(() => db.transaction(async (tx) => {
    await lockUser(tx, userId); await validateTarget(tx, target);
    let [row] = await tx.select().from(githubStarOperations).where(key(userId, target.repositoryId)).for("update");
    if (!row) {
      [row] = await tx.insert(githubStarOperations).values({ userId, repositoryId: target.repositoryId, productId: target.productId, productRepoUrl: target.productRepoUrl, revision: await nextRevision(tx, userId) }).returning();
    }
    const latestRevision = await nextRevision(tx, userId);
    if (!row.leaseOwner && row.revision < latestRevision - 1) {
      [row] = await tx.update(githubStarOperations).set({ revision: latestRevision }).where(key(userId, target.repositoryId)).returning();
    }
    const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    const now = new Date(clock.now);
    if (row.leaseOwner && (!row.leaseExpiresAt || row.leaseExpiresAt <= now)) {
      [row] = await tx.update(githubStarOperations).set({ state: "unknown", revision: await nextRevision(tx, userId), leaseOwner: null, leaseExpiresAt: null, reconcileAfter: new Date(now.getTime() + 60_000) }).where(key(userId, target.repositoryId)).returning();
      if (row.operationId) await tx.update(githubStarOperationReceipts).set({ response: { ...starView(row), operationId: row.operationId, productRepoUrl: row.productRepoUrl } }).where(receiptKey(userId, row.operationId));
    }
    return row;
  }));
}

export async function recordStarObservation(userId: number, target: StarTarget, expectedRevision: number, state: GithubStarState): Promise<GithubStarOperation> {
  return onPrimary(() => db.transaction(async (tx) => {
    await lockUser(tx, userId); await validateTarget(tx, target);
    const [row] = await tx.select().from(githubStarOperations).where(key(userId, target.repositoryId)).for("update");
    if (!row || row.revision !== expectedRevision || row.leaseOwner) return row;
    const isUncertainWrite = row.state === "unknown" && row.desiredStarred !== null;
    // A matching GET may describe another actor's change while the old write is still running.
    // Only a definitive result of that dispatch can release its uncertainty fence.
    if (isUncertainWrite) return row;
    const revision = row.state === state ? row.revision : await nextRevision(tx, userId);
    const [updated] = await tx.update(githubStarOperations).set({ state, revision, observedAt: sql`clock_timestamp()`, reconcileAfter: null, ...(state !== "unknown" ? { desiredStarred: null } : {}) }).where(key(userId, target.repositoryId)).returning();
    return updated;
  }));
}

export async function savedStarResponse(userId: number, target: StarTarget, input: StarWrite): Promise<StarView | null> {
  return onPrimary(async () => {
    const [receipt] = await db.select().from(githubStarOperationReceipts).where(receiptKey(userId, input.operationId));
    if (!receipt) return null;
    if (receipt.productId !== target.productId || receipt.repositoryId !== target.repositoryId || receipt.starred !== input.starred || receipt.expectedRevision !== input.expectedRevision) throw new PublicAuthError(409, "star_operation_conflict");
    if (!receipt.response) throw new PublicAuthError(409, "star_operation_in_progress");
    return receiptView(receipt.response);
  });
}

export type StarClaim = { kind: "complete"; response: StarView } | { kind: "dispatch"; row: GithubStarOperation; owner: string; previousState: GithubStarState } | { kind: "error"; code: string };
export async function claimStarWrite(userId: number, target: StarTarget, input: StarWrite, credential: StarCredential): Promise<StarClaim> {
  const saved = await savedStarResponse(userId, target, input);
  if (saved) return { kind: "complete", response: saved };
  if (!await onPrimary(() => rateLimit(`github-star:${userId}`, 30, 60_000))) throw new PublicAuthError(429, "star_rate_limited");
  return onPrimary(() => db.transaction(async (tx): Promise<StarClaim> => {
    await lockUser(tx, userId); await validateTarget(tx, target);
    const [connection] = await tx.select().from(githubUserConnections).where(eq(githubUserConnections.userId, userId)).for("update");
    if (!connection || connection.state !== "active" || connection.revision !== credential.revision || connection.githubUserId !== credential.githubUserId) return { kind: "error", code: "github_needs_reconnect" };
    const [row] = await tx.select().from(githubStarOperations).where(key(userId, target.repositoryId)).for("update");
    if (!row) return { kind: "error", code: "star_revision_conflict" };
    const [receipt] = await tx.select().from(githubStarOperationReceipts).where(receiptKey(userId, input.operationId));
    if (receipt) {
      if (receipt.productId !== target.productId || receipt.repositoryId !== target.repositoryId || receipt.starred !== input.starred || receipt.expectedRevision !== input.expectedRevision) return { kind: "error", code: "star_operation_conflict" };
      return receipt.response ? { kind: "complete", response: receiptView(receipt.response) } : { kind: "error", code: "star_operation_in_progress" };
    }
    if (row.leaseOwner) return { kind: "error", code: "star_operation_in_progress" };
    if (row.state === "unknown" && row.desiredStarred !== null) return { kind: "error", code: "star_result_uncertain" };
    if (row.revision !== input.expectedRevision) return { kind: "error", code: "star_revision_conflict" };
    const revision = await nextRevision(tx, userId);
    const desiredState = input.starred ? "starred" : "unstarred";
    if (row.state === desiredState) {
      const [updated] = await tx.update(githubStarOperations).set({ revision, operationId: input.operationId }).where(key(userId, target.repositoryId)).returning();
      const response = { ...starView(updated), operationId: input.operationId };
      await tx.insert(githubStarOperationReceipts).values({ userId, ...input, productId: target.productId, repositoryId: target.repositoryId, response: { ...response, productRepoUrl: target.productRepoUrl } });
      return { kind: "complete", response };
    }
    const owner = randomUUID();
    const [updated] = await tx.update(githubStarOperations).set({ productId: target.productId, productRepoUrl: target.productRepoUrl, revision, operationId: input.operationId, desiredStarred: input.starred, leaseOwner: owner, leaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'`, dispatchedAt: sql`clock_timestamp()`, reconcileAfter: null }).where(key(userId, target.repositoryId)).returning();
    await tx.insert(githubStarOperationReceipts).values({ userId, ...input, productId: target.productId, repositoryId: target.repositoryId });
    return { kind: "dispatch", row: updated, owner, previousState: row.state };
  }));
}

export async function settleStarWrite(userId: number, target: StarTarget, claim: Extract<StarClaim, { kind: "dispatch" }>, state: GithubStarState, retryAt?: number | null, failure?: StarView["failure"]): Promise<StarView> {
  return onPrimary(() => db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const [current] = await tx.select().from(githubStarOperations).where(key(userId, target.repositoryId)).for("update");
    const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    const now = new Date(clock.now);
    if (current.leaseOwner !== claim.owner || current.revision !== claim.row.revision || !current.leaseExpiresAt || current.leaseExpiresAt <= now) {
      // Expiration is uncertainty, including when a successful HTTP reply arrives late.
      if (current.leaseOwner === claim.owner) {
        const [expired] = await tx.update(githubStarOperations).set({ state: "unknown", revision: await nextRevision(tx, userId), leaseOwner: null, leaseExpiresAt: null, reconcileAfter: new Date(now.getTime() + 60_000) }).where(key(userId, target.repositoryId)).returning();
        const response = { ...starView(expired), operationId: claim.row.operationId! };
        await tx.update(githubStarOperationReceipts).set({ response: { ...response, productRepoUrl: target.productRepoUrl } }).where(receiptKey(userId, claim.row.operationId!));
        return response;
      }
      return starView(current);
    }
    const [updated] = await tx.update(githubStarOperations).set({ state, revision: await nextRevision(tx, userId), leaseOwner: null, leaseExpiresAt: null, desiredStarred: state === "unknown" ? current.desiredStarred : null, reconcileAfter: state === "unknown" ? new Date(now.getTime() + 60_000) : null, observedAt: state === "starred" || state === "unstarred" ? now : current.observedAt }).where(key(userId, target.repositoryId)).returning();
    const response = { ...starView(updated), operationId: claim.row.operationId!, ...(retryAt ? { retryAt } : {}), ...(failure ? { failure } : {}) };
    await tx.update(githubStarOperationReceipts).set({ response: { ...response, productRepoUrl: target.productRepoUrl } }).where(receiptKey(userId, claim.row.operationId!));
    return response;
  }));
}

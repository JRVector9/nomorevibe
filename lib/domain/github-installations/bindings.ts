import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { githubMakerAuthContexts, githubProductBindings, type GithubProductBinding } from "@/lib/db/github-binding-schema";
import { isGithubNumericId, type GithubRepository } from "@/lib/github/repositories";
import { GithubInstallationError } from "./credentials";
import { hasGithubInstallationRevocation, lockGithubFeedbackInstallation } from "@/lib/domain/github-webhooks/lifecycle";
import { cancelBindingFeedbackOutbox } from "@/lib/domain/feedback/github/outbox";

/** Lock product before binding everywhere, so invalidation and maker completion serialize. */
export async function getProductGithubBinding(productId: number): Promise<GithubProductBinding | null> {
  if (!isGithubNumericId(productId)) throw new GithubInstallationError(400, "github_invalid_request");
  return onPrimary(() => db.transaction(async tx => {
    const [product] = await tx.select().from(products).where(eq(products.id, productId)).for("update");
    const [binding] = await tx.select().from(githubProductBindings).where(eq(githubProductBindings.productId, productId)).for("update");
    if (!binding) return null;
    const reason = product?.status === "banned" ? "product_banned" : product?.repoUrl !== binding.productRepoUrl ? "product_repository_changed" : null;
    if (!binding.enabled || !reason) return binding;
    const [disabled] = await tx.update(githubProductBindings).set({ enabled: false, revision: binding.revision + 1, blockedReason: reason, updatedAt: new Date() }).where(eq(githubProductBindings.productId, productId)).returning();
    await cancelBindingFeedbackOutbox(tx, productId, reason);
    return disabled;
  }));
}

export async function disableProductGithubBinding(productId: number, reason: string, expectedRevision?: number, makerAuthorization?: { editTokenHash: string | null; productRepoUrl: string | null }): Promise<GithubProductBinding | null> {
  if (!isGithubNumericId(productId) || !/^[a-z][a-z0-9_]{0,79}$/.test(reason) || (expectedRevision !== undefined && !isGithubNumericId(expectedRevision))) throw new GithubInstallationError(400, "github_invalid_request");
  return onPrimary(() => db.transaction(async tx => {
    const [product] = await tx.select().from(products).where(eq(products.id, productId)).for("update");
    if (makerAuthorization && (!product || product.status === "banned" || product.editTokenHash !== makerAuthorization.editTokenHash || product.repoUrl !== makerAuthorization.productRepoUrl)) throw new GithubInstallationError(409, "github_maker_authorization_changed");
    const [binding] = await tx.select().from(githubProductBindings).where(eq(githubProductBindings.productId, productId)).for("update");
    if (expectedRevision !== undefined && binding?.revision !== expectedRevision) throw new GithubInstallationError(409, "github_binding_revision_conflict");
    if (!binding || !binding.enabled) return binding ?? null;
    const [disabled] = await tx.update(githubProductBindings).set({ enabled: false, revision: binding.revision + 1, blockedReason: reason, updatedAt: new Date() }).where(eq(githubProductBindings.productId, productId)).returning();
    await cancelBindingFeedbackOutbox(tx, productId, reason);
    return disabled;
  }));
}

export async function completeProductGithubBinding(input: { flowId: string; actorUserId: number; installationId: number; repository: GithubRepository }): Promise<GithubProductBinding> {
  if (!isGithubNumericId(input.installationId)) throw new GithubInstallationError(400, "github_invalid_request");
  return onPrimary(() => db.transaction(async tx => {
    const [snapshot] = await tx.select().from(githubMakerAuthContexts).where(eq(githubMakerAuthContexts.flowId, input.flowId));
    if (!snapshot) throw new GithubInstallationError(400, "invalid_github_flow");
    await lockGithubFeedbackInstallation(tx, input.installationId);
    const [product] = await tx.select().from(products).where(eq(products.id, snapshot.productId)).for("update");
    const [previous] = await tx.select().from(githubProductBindings).where(eq(githubProductBindings.productId, snapshot.productId)).for("update");
    const [context] = await tx.select().from(githubMakerAuthContexts).where(eq(githubMakerAuthContexts.flowId, input.flowId)).for("update");
    const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    const now = new Date(clock.now);
    if (!context || context.actorUserId !== input.actorUserId || context.state !== "verifying" || context.expiresAt <= now) throw new GithubInstallationError(400, "invalid_github_flow");
    if (!product || product.status === "banned" || product.repoUrl !== context.productRepoUrl || product.editTokenHash !== context.editTokenHash || context.repositoryId !== input.repository.id) throw new GithubInstallationError(409, "github_maker_authorization_changed");
    if ((previous?.revision ?? 0) !== context.expectedRevision) throw new GithubInstallationError(409, "github_binding_revision_conflict");
    if (await hasGithubInstallationRevocation(tx, { installationId: input.installationId, repositoryId: input.repository.id, verifiedAfter: context.createdAt })) throw new GithubInstallationError(409, "github_installation_revoked");
    const values = { productId: product.id, repositoryId: input.repository.id, repositoryFullName: input.repository.fullName, repositoryUrl: input.repository.htmlUrl, productRepoUrl: context.productRepoUrl, installationId: input.installationId, consentedByUserId: input.actorUserId, enabled: true, blockedReason: null, revision: (previous?.revision ?? 0) + 1, lastVerifiedAt: now, verificationRetryAt: null, updatedAt: now };
    const [binding] = await tx.insert(githubProductBindings).values(values).onConflictDoUpdate({ target: githubProductBindings.productId, set: values }).returning();
    if (previous) await cancelBindingFeedbackOutbox(tx, product.id, "feedback_binding_replaced");
    await tx.update(githubMakerAuthContexts).set({ state: "completed", encryptedUserToken: null, setupStateHash: null }).where(eq(githubMakerAuthContexts.flowId, input.flowId));
    return binding;
  }));
}

export async function failMakerGithubAuthorization(flowId: string): Promise<void> {
  await onPrimary(() => db.update(githubMakerAuthContexts).set({ state: "failed", encryptedUserToken: null, setupStateHash: null }).where(and(eq(githubMakerAuthContexts.flowId, flowId), inArray(githubMakerAuthContexts.state, ["authorizing", "awaiting_setup", "verifying"]))));
}

/** Runs even when feature flags are off; expired credentials are never reusable. */
export async function expireMakerGithubAuthorizations(): Promise<number> {
  const expired = await onPrimary(() => db.update(githubMakerAuthContexts).set({ state: "expired", encryptedUserToken: null, setupStateHash: null }).where(and(lte(githubMakerAuthContexts.expiresAt, sql`clock_timestamp()`), inArray(githubMakerAuthContexts.state, ["authorizing", "awaiting_setup", "verifying"]))).returning({ id: githubMakerAuthContexts.flowId }));
  return expired.length;
}

import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { githubAuthFlows, githubUserConnections, type GithubUserConnection } from "@/lib/db/github-user-schema";
import { publicIdentities, publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { PublicAuthError, requirePublicAuthEnabled, safeReturnUrl } from "@/lib/domain/accounts/request-auth";
import { csrfForToken, hashSessionToken, isOpaqueToken, newPublicSession } from "@/lib/domain/accounts/session";
import { decryptGithubSecret, encryptGithubSecret, newGithubAuthorizationSecrets } from "./secrets";
import type { GithubUserTokens } from "./credentials";

export type GithubFlowTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type FlowInput = { purpose: "star" | "maker"; actorUserId: number | null; productId?: number | null; returnTo?: string };

export async function createGithubAuthFlow(input: FlowInput, transaction?: GithubFlowTransaction) {
  requirePublicAuthEnabled();
  if (input.purpose === "maker" && (!input.actorUserId || !input.productId)) throw new PublicAuthError(400, "invalid_github_flow");
  const secrets = newGithubAuthorizationSecrets();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await onPrimary(() => (transaction ?? db).insert(githubAuthFlows).values({ id, purpose: input.purpose, actorUserId: input.actorUserId, productId: input.productId ?? null, stateHash: hashSessionToken(secrets.state), browserNonceHash: hashSessionToken(secrets.browserNonce), encryptedPkceVerifier: encryptGithubSecret(secrets.verifier), returnTo: safeReturnUrl(input.returnTo), expiresAt }));
  return { id, state: secrets.state, browserNonce: secrets.browserNonce, codeChallenge: secrets.challenge, expiresAt };
}

export async function consumeGithubAuthFlow(input: { state: string; browserNonce: string; actorUserId: number | null; purpose: "star" | "maker" }, transaction?: GithubFlowTransaction) {
  requirePublicAuthEnabled();
  if (!isOpaqueToken(input.state) || !isOpaqueToken(input.browserNonce)) throw new PublicAuthError(400, "invalid_github_flow");
  const [flow] = await onPrimary(() => (transaction ?? db).update(githubAuthFlows).set({ consumedAt: sql`clock_timestamp()` })
    .where(and(eq(githubAuthFlows.stateHash, hashSessionToken(input.state)), eq(githubAuthFlows.browserNonceHash, hashSessionToken(input.browserNonce)), eq(githubAuthFlows.purpose, input.purpose), input.actorUserId === null ? isNull(githubAuthFlows.actorUserId) : eq(githubAuthFlows.actorUserId, input.actorUserId), isNull(githubAuthFlows.consumedAt), gt(githubAuthFlows.expiresAt, sql`clock_timestamp()`))).returning());
  if (!flow) throw new PublicAuthError(400, "invalid_github_flow");
  return { id: flow.id, actorUserId: flow.actorUserId, productId: flow.productId, pkceVerifier: decryptGithubSecret(flow.encryptedPkceVerifier), returnTo: flow.returnTo, expiresAt: flow.expiresAt };
}

export async function saveGithubUserConnection(input: { actorUserId: number | null; githubUser: { id: number; login: string }; tokens: GithubUserTokens; previousToken?: string; deviceLabel?: string | null }) {
  return onPrimary(() => db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`public-github:${input.githubUser.id}`}, 0))`);
    const subject = String(input.githubUser.id);
    const [identity] = await tx.select().from(publicIdentities).where(and(eq(publicIdentities.provider, "github"), eq(publicIdentities.subject, subject)));
    if (identity && input.actorUserId !== null && identity.userId !== input.actorUserId) throw new PublicAuthError(409, "github_identity_conflict");
    const userId = input.actorUserId ?? identity?.userId;
    let user;
    if (userId !== undefined) {
      const [found] = await tx.select({ id: publicUsers.id, displayName: publicUsers.displayName, deletedAt: publicUsers.deletedAt }).from(publicUsers).where(eq(publicUsers.id, userId)).for("update");
      // 탈퇴한 계정에는 세션·연결을 다시 만들지 않는다
      if (!found || found.deletedAt) throw new PublicAuthError(401, "login_required");
      user = { id: found.id, displayName: found.displayName };
    } else {
      [user] = await tx.insert(publicUsers).values({ displayName: `참여자-${randomBytes(4).toString("hex")}` }).returning({ id: publicUsers.id, displayName: publicUsers.displayName });
    }
    // 표시용 login 은 로그인할 때마다 고친다(GitHub 에서 이름을 바꿀 수 있다)
    if (identity) await tx.update(publicIdentities).set({ providerLogin: input.githubUser.login, lastUsedAt: sql`now()` }).where(eq(publicIdentities.id, identity.id));
    else await tx.insert(publicIdentities).values({ userId: user.id, provider: "github", subject, providerLogin: input.githubUser.login, lastUsedAt: sql`now()` });
    const values = { githubUserId: input.githubUser.id, githubLogin: input.githubUser.login, state: "active" as const, encryptedAccessToken: encryptGithubSecret(input.tokens.accessToken), encryptedRefreshToken: encryptGithubSecret(input.tokens.refreshToken), accessExpiresAt: input.tokens.accessExpiresAt, refreshExpiresAt: input.tokens.refreshExpiresAt, refreshLeaseOwner: null, refreshLeaseExpiresAt: null, updatedAt: sql`now()` };
    await tx.insert(githubUserConnections).values({ userId: user.id, ...values }).onConflictDoUpdate({ target: githubUserConnections.userId, set: { ...values, revision: sql`${githubUserConnections.revision} + 1` } });
    const session = newPublicSession();
    if (isOpaqueToken(input.previousToken)) await tx.update(publicSessions).set({ revokedAt: sql`now()` }).where(eq(publicSessions.tokenHash, hashSessionToken(input.previousToken)));
    await tx.insert(publicSessions).values({ userId: user.id, tokenHash: session.tokenHash, createdAt: session.createdAt, expiresAt: session.expiresAt,
      provider: "github", deviceLabel: input.deviceLabel ?? null, lastSeenAt: session.createdAt });
    return { user, token: session.token, csrfToken: csrfForToken(session.token, "session") };
  }));
}

export async function getGithubConnection(userId: number) {
  return onPrimary(async () => {
    const [connection] = await db.select({ githubUserId: githubUserConnections.githubUserId, login: githubUserConnections.githubLogin, state: githubUserConnections.state }).from(githubUserConnections).where(eq(githubUserConnections.userId, userId));
    return connection ?? null;
  });
}

const clearCredentials = { encryptedAccessToken: null, encryptedRefreshToken: null, accessExpiresAt: null, refreshExpiresAt: null, refreshLeaseOwner: null, refreshLeaseExpiresAt: null };

export async function disconnectGithubUser(userId: number): Promise<void> {
  await onPrimary(() => db.update(githubUserConnections).set({ ...clearCredentials, state: "revoked", revision: sql`${githubUserConnections.revision} + 1`, updatedAt: sql`now()` }).where(eq(githubUserConnections.userId, userId)));
}

export async function markGithubConnectionNeedsReconnect(userId: number, expectedRevision: number): Promise<void> {
  await onPrimary(() => db.update(githubUserConnections).set({ ...clearCredentials, state: "needs_reconnect", revision: sql`${githubUserConnections.revision} + 1`, updatedAt: sql`now()` }).where(and(eq(githubUserConnections.userId, userId), eq(githubUserConnections.revision, expectedRevision), eq(githubUserConnections.state, "active"))));
}

type Claim = { kind: "ready"; connection: GithubUserConnection } | { kind: "refresh"; connection: GithubUserConnection; owner: string } | { kind: "error"; code: "github_not_connected" | "github_needs_reconnect" | "github_refresh_in_progress" };
export async function claimGithubRefresh(userId: number): Promise<Claim> {
  return onPrimary(() => db.transaction(async (tx): Promise<Claim> => {
    const [connection] = await tx.select().from(githubUserConnections).where(eq(githubUserConnections.userId, userId)).for("update");
    if (!connection) return { kind: "error", code: "github_not_connected" };
    if (connection.state !== "active") return { kind: "error", code: "github_needs_reconnect" };
    const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    const now = new Date(clock.now);
    if (connection.refreshLeaseOwner && connection.refreshLeaseExpiresAt && connection.refreshLeaseExpiresAt > now) return { kind: "error", code: "github_refresh_in_progress" };
    if (connection.refreshLeaseOwner || !connection.encryptedAccessToken || !connection.encryptedRefreshToken || !connection.refreshExpiresAt || connection.refreshExpiresAt <= now) {
      await tx.update(githubUserConnections).set({ ...clearCredentials, state: "needs_reconnect", revision: connection.revision + 1, updatedAt: now }).where(eq(githubUserConnections.userId, userId));
      return { kind: "error", code: "github_needs_reconnect" };
    }
    if (connection.accessExpiresAt && connection.accessExpiresAt.getTime() > now.getTime() + 60_000) return { kind: "ready", connection };
    const owner = randomUUID();
    await tx.update(githubUserConnections).set({ refreshLeaseOwner: owner, refreshLeaseExpiresAt: new Date(now.getTime() + 30_000) }).where(eq(githubUserConnections.userId, userId));
    return { kind: "refresh", connection, owner };
  }));
}

export async function completeGithubRefresh(userId: number, lease: { owner: string; revision: number }, tokens: GithubUserTokens): Promise<boolean> {
  const changed = await onPrimary(() => db.update(githubUserConnections).set({ encryptedAccessToken: encryptGithubSecret(tokens.accessToken), encryptedRefreshToken: encryptGithubSecret(tokens.refreshToken), accessExpiresAt: tokens.accessExpiresAt, refreshExpiresAt: tokens.refreshExpiresAt, revision: lease.revision + 1, refreshLeaseOwner: null, refreshLeaseExpiresAt: null, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(githubUserConnections.userId, userId), eq(githubUserConnections.state, "active"), eq(githubUserConnections.revision, lease.revision), eq(githubUserConnections.refreshLeaseOwner, lease.owner), gt(githubUserConnections.refreshLeaseExpiresAt, sql`clock_timestamp()`))).returning({ userId: githubUserConnections.userId }));
  return changed.length === 1;
}

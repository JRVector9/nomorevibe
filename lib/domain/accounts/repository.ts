import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { emailLoginChallenges, publicIdentities, publicSessions, publicUsers, type PublicUser } from "@/lib/db/public-user-schema";
import { rateLimit } from "@/lib/rate-limit";
import { PublicAuthError } from "./errors";
import { csrfForToken, hashEmailCode, hashSessionToken, isOpaqueToken, matchesSecretHash, newPublicSession, privateRateKey } from "./session";
import type { EmailDeliveryState } from "./email-delivery";

export async function limitEmailLogin(email: string, ip: string | null): Promise<void> {
  await onPrimary(async () => {
    const allowed = await rateLimit(privateRateKey("email-quarter", email), 3, 15 * 60 * 1000);
    const dailyAllowed = await rateLimit(privateRateKey("email-day", email), 10, 24 * 60 * 60 * 1000);
    // With no trusted peer, a shared fallback bucket prevents unlimited IP bypass.
    const ipAllowed = await rateLimit(privateRateKey("ip", ip ?? "untrusted-peer"), 20, 15 * 60 * 1000);
    if (!allowed || !dailyAllowed || !ipAllowed) throw new PublicAuthError(429, "login_rate_limited");
  });
}

type ChallengeInput = { id: string; email: string; codeHash: string; browserNonceHash: string; returnTo: string };

export async function replaceEmailChallenge(input: ChallengeInput): Promise<void> {
  await onPrimary(() => db.transaction(async (tx) => {
    // Both replacement and consumption acquire the same email lock first.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`public-email:${input.email}`}, 0))`);
    await tx.update(emailLoginChallenges).set({ consumedAt: sql`now()` })
      .where(and(eq(emailLoginChallenges.email, input.email), isNull(emailLoginChallenges.consumedAt)));
    await tx.insert(emailLoginChallenges).values({ ...input, expiresAt: sql`now() + interval '10 minutes'` });
  }));
}

export async function recordEmailDelivery(challengeId: string, state: EmailDeliveryState): Promise<void> {
  await onPrimary(() => db.update(emailLoginChallenges)
    .set({ deliveryState: state, ...(state === "rejected" ? { consumedAt: sql`now()` } : {}) })
    .where(eq(emailLoginChallenges.id, challengeId)));
}

export type VerifyEmailInput = { challengeId: string; code: string; browserNonce: string; previousToken?: string };

export async function consumeEmailChallenge(input: VerifyEmailInput) {
  const result = await onPrimary(() => db.transaction(async (tx) => {
    const [initial] = await tx.select({ email: emailLoginChallenges.email }).from(emailLoginChallenges).where(eq(emailLoginChallenges.id, input.challengeId));
    if (!initial) return null;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`public-email:${initial.email}`}, 0))`);
    const [challenge] = await tx.select().from(emailLoginChallenges).where(eq(emailLoginChallenges.id, input.challengeId)).for("update");
    const [clock] = await tx.execute<{ now: string }>(sql`select now()`);
    const now = new Date(clock.now);
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= now || challenge.attempts >= 5 || challenge.deliveryState === "rejected") return null;
    if (!matchesSecretHash(challenge.browserNonceHash, hashSessionToken(input.browserNonce))) return null;
    if (!matchesSecretHash(challenge.codeHash, hashEmailCode(input.challengeId, input.code))) {
      // Return instead of throwing: the failed-attempt increment must commit.
      await tx.update(emailLoginChallenges).set({ attempts: challenge.attempts + 1 }).where(eq(emailLoginChallenges.id, input.challengeId));
      return null;
    }

    const [identity] = await tx.select({ userId: publicIdentities.userId }).from(publicIdentities)
      .where(and(eq(publicIdentities.provider, "email"), eq(publicIdentities.subject, challenge.email)));
    let user: PublicUser;
    if (identity) {
      [user] = await tx.select({ id: publicUsers.id, displayName: publicUsers.displayName }).from(publicUsers).where(eq(publicUsers.id, identity.userId));
    } else {
      [user] = await tx.insert(publicUsers).values({ displayName: `참여자-${randomBytes(4).toString("hex")}` }).returning({ id: publicUsers.id, displayName: publicUsers.displayName });
      await tx.insert(publicIdentities).values({ userId: user.id, provider: "email", subject: challenge.email });
    }

    const session = newPublicSession();
    if (isOpaqueToken(input.previousToken)) {
      await tx.update(publicSessions).set({ revokedAt: now }).where(eq(publicSessions.tokenHash, hashSessionToken(input.previousToken)));
    }
    await tx.insert(publicSessions).values({ tokenHash: session.tokenHash, userId: user.id, createdAt: session.createdAt, expiresAt: session.expiresAt });
    await tx.update(emailLoginChallenges).set({ consumedAt: now }).where(eq(emailLoginChallenges.id, input.challengeId));
    return { user, token: session.token, expiresAt: session.expiresAt, csrfToken: csrfForToken(session.token, "session"), returnTo: challenge.returnTo };
  }));
  if (!result) throw new PublicAuthError(400, "invalid_code");
  return result;
}

export async function getSessionUser(token: string): Promise<PublicUser | null> {
  if (!isOpaqueToken(token)) return null;
  return onPrimary(async () => {
    const [user] = await db.select({ id: publicUsers.id, displayName: publicUsers.displayName }).from(publicSessions)
      .innerJoin(publicUsers, eq(publicUsers.id, publicSessions.userId))
      .where(and(eq(publicSessions.tokenHash, hashSessionToken(token)), isNull(publicSessions.revokedAt), gt(publicSessions.expiresAt, sql`now()`)));
    return user ?? null;
  });
}

export async function revokePublicSession(token: string): Promise<void> {
  if (!isOpaqueToken(token)) return;
  await onPrimary(() => db.update(publicSessions).set({ revokedAt: sql`now()` }).where(eq(publicSessions.tokenHash, hashSessionToken(token))));
}

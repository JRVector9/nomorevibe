import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { emailLoginChallenges, publicIdentities, publicSessions, publicUsers, type PublicUser } from "@/lib/db/public-user-schema";
import { rateLimit } from "@/lib/rate-limit";
import { webWritable } from "@/lib/operations/dr/web-gate";
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
type AccountTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 한 이메일의 로그인 흐름 잠금(트랜잭션 끝까지) — 코드 보내기·코드 확인·계정 삭제(lib/me/account.ts)가 먼저 잡는다.
 * 코드 확인은 이 잠금 → 챌린지 행 → 계정 행(FOR SHARE) 순서다. 계정 삭제도 계정 행보다 이것을 먼저 잡아야 교착하지 않는다
 */
export async function lockPublicEmail(tx: AccountTransaction, email: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`public-email:${email}`}, 0))`);
}

export async function replaceEmailChallenge(input: ChallengeInput): Promise<void> {
  await onPrimary(() => db.transaction(async (tx) => {
    // Both replacement and consumption acquire the same email lock first.
    await lockPublicEmail(tx, input.email);
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

export type VerifyEmailInput = { challengeId: string; code: string; browserNonce: string; previousToken?: string; deviceLabel?: string | null };

export async function consumeEmailChallenge(input: VerifyEmailInput) {
  const result = await onPrimary(() => db.transaction(async (tx) => {
    const [initial] = await tx.select({ email: emailLoginChallenges.email }).from(emailLoginChallenges).where(eq(emailLoginChallenges.id, input.challengeId));
    if (!initial) return null;
    await lockPublicEmail(tx, initial.email);
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

    const [identity] = await tx.select({ id: publicIdentities.id, userId: publicIdentities.userId }).from(publicIdentities)
      .where(and(eq(publicIdentities.provider, "email"), eq(publicIdentities.subject, challenge.email)));
    let user: PublicUser;
    /** 이 로그인이 계정을 새로 만들었다 — 분석의 sign_up(서버 사실)과 login 을 가른다 */
    let created = false;
    if (identity) {
      // 탈퇴와 겹치면 탈퇴가 먼저 끝난 뒤 다시 읽는다 — 탈퇴한 계정에는 세션을 만들지 않는다
      const [found] = await tx.select({ id: publicUsers.id, displayName: publicUsers.displayName, deletedAt: publicUsers.deletedAt }).from(publicUsers).where(eq(publicUsers.id, identity.userId)).for("share");
      if (!found || found.deletedAt) throw new PublicAuthError(401, "login_required");
      user = { id: found.id, displayName: found.displayName };
      await tx.update(publicIdentities).set({ lastUsedAt: now }).where(eq(publicIdentities.id, identity.id));
    } else {
      [user] = await tx.insert(publicUsers).values({ displayName: `참여자-${randomBytes(4).toString("hex")}` }).returning({ id: publicUsers.id, displayName: publicUsers.displayName });
      await tx.insert(publicIdentities).values({ userId: user.id, provider: "email", subject: challenge.email, lastUsedAt: now });
      created = true;
    }

    const session = newPublicSession();
    if (isOpaqueToken(input.previousToken)) {
      await tx.update(publicSessions).set({ revokedAt: now }).where(eq(publicSessions.tokenHash, hashSessionToken(input.previousToken)));
    }
    await tx.insert(publicSessions).values({ tokenHash: session.tokenHash, userId: user.id, createdAt: session.createdAt, expiresAt: session.expiresAt,
      provider: "email", deviceLabel: input.deviceLabel ?? null, lastSeenAt: session.createdAt });
    await tx.update(emailLoginChallenges).set({ consumedAt: now }).where(eq(emailLoginChallenges.id, input.challengeId));
    return { user, token: session.token, expiresAt: session.expiresAt, csrfToken: csrfForToken(session.token, "session"), returnTo: challenge.returnTo, created };
  }));
  if (!result) throw new PublicAuthError(400, "invalid_code");
  return result;
}

/** 마지막 사용일은 하루 한 번만 고친다 — 매 요청 쓰지 않게 */
const SESSION_SEEN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function getSessionUser(token: string): Promise<PublicUser | null> {
  if (!isOpaqueToken(token)) return null;
  const tokenHash = hashSessionToken(token);
  return onPrimary(async () => {
    const [row] = await db.select({ id: publicUsers.id, displayName: publicUsers.displayName, lastSeenAt: publicSessions.lastSeenAt }).from(publicSessions)
      .innerJoin(publicUsers, eq(publicUsers.id, publicSessions.userId))
      .where(and(eq(publicSessions.tokenHash, tokenHash), isNull(publicSessions.revokedAt), gt(publicSessions.expiresAt, sql`now()`), isNull(publicUsers.deletedAt)));
    if (!row) return null;
    if (!row.lastSeenAt || Date.now() - row.lastSeenAt.getTime() > SESSION_SEEN_INTERVAL_MS) await touchSession(tokenHash);
    return { id: row.id, displayName: row.displayName };
  });
}

/** 조건부 한 줄 쓰기 — 여러 요청이 겹쳐도 하루 한 번. fenced DB 거나 실패하면 건너뛴다(읽기는 그대로 된다) */
async function touchSession(tokenHash: string): Promise<void> {
  try {
    if (!await webWritable()) return;
    await db.update(publicSessions).set({ lastSeenAt: sql`now()` })
      .where(and(eq(publicSessions.tokenHash, tokenHash), or(isNull(publicSessions.lastSeenAt), lt(publicSessions.lastSeenAt, sql`now() - interval '1 day'`))));
  } catch {
    // 마지막 사용일은 보조 정보다
  }
}

export async function revokePublicSession(token: string): Promise<void> {
  if (!isOpaqueToken(token)) return;
  await onPrimary(() => db.update(publicSessions).set({ revokedAt: sql`now()` }).where(eq(publicSessions.tokenHash, hashSessionToken(token))));
}

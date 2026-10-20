import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { emailLoginChallenges, publicIdentities, publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { githubAuthFlows, githubUserConnections } from "@/lib/db/github-user-schema";
import { githubMakerAuthContexts } from "@/lib/db/github-binding-schema";
import { githubStarOperationReceipts, githubStarOperations } from "@/lib/db/github-star-schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import {
  emailOutbox, makerReplies, notifications, notificationSettings, productMakerMembers, productReactions, userFollows, userSavedProducts,
} from "@/lib/db/me-schema";
import { PublicAuthError } from "@/lib/domain/accounts/errors";
import { rateLimit } from "@/lib/rate-limit";
import { DISPLAY_NAME_CHANGE_DAYS } from "./contract";
import { DELETED_DISPLAY_NAME, displayNameChangeAvailableAt, maskEmail, normalizeDisplayName, sessionPublicId, isSessionPublicId } from "./profile";

/** 계정 탭(MY1 = 로그인 설계 L3) — 닉네임, 로그인 수단, 로그인 기기, 내 데이터 받기, 계정 삭제. 모두 자기 행만 읽고 쓴다 */

export type AccountIdentity = { provider: "github" | "email"; label: string | null; createdAt: string; lastUsedAt: string | null };
export type AccountSession = { id: string; provider: string | null; deviceLabel: string | null; createdAt: string; lastSeenAt: string | null; current: boolean };
export type AccountView = {
  displayName: string; createdAt: string; nextNameChangeAt: string | null;
  identities: AccountIdentity[]; github: { login: string; state: "active" | "needs_reconnect" | "revoked" } | null; sessions: AccountSession[];
};

const live = (userId: number) => and(eq(publicSessions.userId, userId), isNull(publicSessions.revokedAt), gt(publicSessions.expiresAt, sql`now()`));
const iso = (value: Date | null) => value?.toISOString() ?? null;
const RATE_HOUR = 60 * 60 * 1000;

async function limit(key: string, count: number, windowMs: number, code: string) {
  if (!await rateLimit(key, count, windowMs)) throw new PublicAuthError(429, code);
}

export function listSessions(userId: number, currentTokenHash: string | null): Promise<AccountSession[]> {
  return onPrimary(async () => {
    const rows = await db.select({ tokenHash: publicSessions.tokenHash, provider: publicSessions.provider, deviceLabel: publicSessions.deviceLabel, createdAt: publicSessions.createdAt, lastSeenAt: publicSessions.lastSeenAt })
      .from(publicSessions).where(live(userId))
      .orderBy(desc(sql`coalesce(${publicSessions.lastSeenAt}, ${publicSessions.createdAt})`), desc(publicSessions.createdAt)).limit(50);
    // 해시는 여기서 끊는다 — 화면·응답에는 앞 16자 id 만 간다
    return rows.map((row) => ({ id: sessionPublicId(row.tokenHash), provider: row.provider, deviceLabel: row.deviceLabel,
      createdAt: row.createdAt.toISOString(), lastSeenAt: iso(row.lastSeenAt), current: row.tokenHash === currentTokenHash }))
      .sort((left, right) => Number(right.current) - Number(left.current));
  });
}

export function getAccountView(userId: number, currentTokenHash: string | null): Promise<AccountView | null> {
  return onPrimary(async () => {
    const [user] = await db.select().from(publicUsers).where(eq(publicUsers.id, userId));
    if (!user || user.deletedAt) return null;
    const [identities, [github], sessions] = await Promise.all([
      db.select().from(publicIdentities).where(eq(publicIdentities.userId, userId)).orderBy(asc(publicIdentities.id)),
      db.select({ login: githubUserConnections.githubLogin, state: githubUserConnections.state }).from(githubUserConnections).where(eq(githubUserConnections.userId, userId)),
      listSessions(userId, currentTokenHash),
    ]);
    return {
      displayName: user.displayName, createdAt: user.createdAt.toISOString(), nextNameChangeAt: iso(displayNameChangeAvailableAt(user.displayNameChangedAt)),
      identities: identities.filter((row) => row.provider === "github" || row.provider === "email").map((row) => ({
        provider: row.provider as "github" | "email",
        label: row.provider === "email" ? maskEmail(row.subject) : row.providerLogin ?? github?.login ?? null,
        createdAt: row.createdAt.toISOString(), lastUsedAt: iso(row.lastUsedAt),
      })),
      github: github ?? null, sessions,
    };
  });
}

/** 닉네임 바꾸기 — 30일에 한 번. 같은 이름이면 아무것도 바꾸지 않는다(한 번을 쓰지 않음) */
export async function changeDisplayName(userId: number, value: unknown): Promise<{ displayName: string; nextNameChangeAt: string | null }> {
  const name = normalizeDisplayName(value);
  return onPrimary(async () => {
    await limit(`me-profile:${userId}`, 10, RATE_HOUR, "profile_rate_limited");
    // 한도 확인과 쓰기를 한 문장에 — 두 요청이 겹쳐도 30일에 한 번
    const [updated] = await db.update(publicUsers).set({ displayName: name, displayNameChangedAt: sql`now()` })
      .where(and(eq(publicUsers.id, userId), isNull(publicUsers.deletedAt), ne(publicUsers.displayName, name),
        or(isNull(publicUsers.displayNameChangedAt), sql`${publicUsers.displayNameChangedAt} <= now() - ${sql.raw(`interval '${DISPLAY_NAME_CHANGE_DAYS} days'`)}`)))
      .returning({ displayName: publicUsers.displayName, changedAt: publicUsers.displayNameChangedAt });
    if (updated) return { displayName: updated.displayName, nextNameChangeAt: iso(displayNameChangeAvailableAt(updated.changedAt)) };
    const [current] = await db.select({ displayName: publicUsers.displayName, changedAt: publicUsers.displayNameChangedAt, deletedAt: publicUsers.deletedAt })
      .from(publicUsers).where(eq(publicUsers.id, userId));
    if (!current || current.deletedAt) throw new PublicAuthError(401, "login_required");
    if (current.displayName === name) return { displayName: name, nextNameChangeAt: iso(displayNameChangeAvailableAt(current.changedAt)) };
    throw new PublicAuthError(409, "display_name_change_limited");
  });
}

/** 기기 하나 로그아웃 — 남의 세션 id 는 없는 것과 같다(404). 지금 세션이면 current: true */
export async function revokeSession(userId: number, publicId: unknown, currentTokenHash: string | null): Promise<{ current: boolean }> {
  if (!isSessionPublicId(publicId)) throw new PublicAuthError(404, "session_not_found");
  return onPrimary(async () => {
    await limit(`me-sessions:${userId}`, 30, RATE_HOUR, "sessions_rate_limited");
    const rows = await db.update(publicSessions).set({ revokedAt: sql`now()` })
      .where(and(live(userId), sql`left(${publicSessions.tokenHash}, 16) = ${publicId}`)).returning({ tokenHash: publicSessions.tokenHash });
    if (!rows.length) throw new PublicAuthError(404, "session_not_found");
    return { current: rows.some((row) => row.tokenHash === currentTokenHash) };
  });
}

/** 지금 기기만 남기고 모두 로그아웃 */
export async function revokeOtherSessions(userId: number, currentTokenHash: string): Promise<{ revoked: number }> {
  return onPrimary(async () => {
    await limit(`me-sessions:${userId}`, 30, RATE_HOUR, "sessions_rate_limited");
    const rows = await db.update(publicSessions).set({ revokedAt: sql`now()` })
      .where(and(live(userId), ne(publicSessions.tokenHash, currentTokenHash))).returning({ tokenHash: publicSessions.tokenHash });
    return { revoked: rows.length };
  });
}

/** 내 데이터 받기(개인정보보호법 열람) — 토큰·해시·암호화 값은 넣지 않는다. 하루 2번 */
export async function exportAccount(userId: number) {
  return onPrimary(async () => {
    await limit(`me-export:${userId}`, 2, 24 * RATE_HOUR, "export_rate_limited");
    return db.transaction(async (tx) => {
      const [user] = await tx.select().from(publicUsers).where(eq(publicUsers.id, userId));
      if (!user || user.deletedAt) throw new PublicAuthError(401, "login_required");
      // 한 연결의 TX 라 차례로 읽는다(같은 스냅숏)
      const identities = await tx.select().from(publicIdentities).where(eq(publicIdentities.userId, userId)).orderBy(asc(publicIdentities.id));
      const [github] = await tx.select({ login: githubUserConnections.githubLogin, githubUserId: githubUserConnections.githubUserId, state: githubUserConnections.state, updatedAt: githubUserConnections.updatedAt })
        .from(githubUserConnections).where(eq(githubUserConnections.userId, userId));
      const sessions = await tx.select({ provider: publicSessions.provider, deviceLabel: publicSessions.deviceLabel, createdAt: publicSessions.createdAt, lastSeenAt: publicSessions.lastSeenAt, expiresAt: publicSessions.expiresAt, revokedAt: publicSessions.revokedAt })
        .from(publicSessions).where(eq(publicSessions.userId, userId)).orderBy(desc(publicSessions.createdAt));
      const saved = await tx.select({ slug: products.slug, name: products.name, source: userSavedProducts.source, createdAt: userSavedProducts.createdAt })
        .from(userSavedProducts).innerJoin(products, eq(products.id, userSavedProducts.productId)).where(eq(userSavedProducts.userId, userId)).orderBy(desc(userSavedProducts.createdAt));
      const reactions = await tx.select({ slug: products.slug, name: products.name, verdict: productReactions.verdict, tags: productReactions.tags, comment: productReactions.comment, commentState: productReactions.commentState,
        triedVerified: productReactions.triedVerified, source: productReactions.source, locale: productReactions.locale, createdAt: productReactions.createdAt, updatedAt: productReactions.updatedAt })
        .from(productReactions).innerJoin(products, eq(products.id, productReactions.productId)).where(eq(productReactions.userId, userId)).orderBy(desc(productReactions.updatedAt));
      const feedback = await tx.select({ id: productFeedback.id, slug: products.slug, name: products.name, kind: productFeedback.kind, title: productFeedback.title, body: productFeedback.body,
        reviewState: productFeedback.reviewState, sendToGithub: productFeedback.sendToGithub, deliveryState: productFeedback.deliveryState, createdAt: productFeedback.createdAt })
        .from(productFeedback).innerJoin(products, eq(products.id, productFeedback.productId)).where(eq(productFeedback.authorUserId, userId)).orderBy(desc(productFeedback.createdAt));
      const replies = await tx.select({ slug: products.slug, targetType: makerReplies.targetType, targetId: makerReplies.targetId, body: makerReplies.body, reviewState: makerReplies.reviewState, createdAt: makerReplies.createdAt, updatedAt: makerReplies.updatedAt })
        .from(makerReplies).innerJoin(products, eq(products.id, makerReplies.productId)).where(eq(makerReplies.authorUserId, userId)).orderBy(desc(makerReplies.createdAt));
      const follows = await tx.select({ targetType: userFollows.targetType, targetKey: userFollows.targetKey, createdAt: userFollows.createdAt })
        .from(userFollows).where(eq(userFollows.userId, userId)).orderBy(desc(userFollows.createdAt));
      const inbox = await tx.select({ kind: notifications.kind, slug: products.slug, payload: notifications.payload, createdAt: notifications.createdAt, readAt: notifications.readAt })
        .from(notifications).leftJoin(products, eq(products.id, notifications.productId)).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt));
      const [settings] = await tx.select({ makerReply: notificationSettings.makerReply, followedProject: notificationSettings.followedProject, followedMaker: notificationSettings.followedMaker,
        followedCategory: notificationSettings.followedCategory, newListingMine: notificationSettings.newListingMine, digestWeekday: notificationSettings.digestWeekday,
        digestHour: notificationSettings.digestHour, newsOptInAt: notificationSettings.newsOptInAt, updatedAt: notificationSettings.updatedAt })
        .from(notificationSettings).where(eq(notificationSettings.userId, userId));
      const memberships = await tx.select({ slug: products.slug, name: products.name, role: productMakerMembers.role, method: productMakerMembers.method, verifiedAt: productMakerMembers.verifiedAt,
        recheckAt: productMakerMembers.recheckAt, revokedAt: productMakerMembers.revokedAt, revokedReason: productMakerMembers.revokedReason })
        .from(productMakerMembers).innerJoin(products, eq(products.id, productMakerMembers.productId)).where(eq(productMakerMembers.userId, userId));
      return {
        exportedAt: new Date().toISOString(),
        profile: { displayName: user.displayName, createdAt: user.createdAt, displayNameChangedAt: user.displayNameChangedAt },
        identities: identities.map((row) => ({ provider: row.provider, ...(row.provider === "email" ? { email: row.subject } : { subject: row.subject, login: row.providerLogin }),
          verifiedAt: row.verifiedAt, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt })),
        githubStarConnection: github ?? null,
        sessions, saved, reactions, feedback, makerReplies: replies, follows, notifications: inbox,
        notificationSettings: settings ?? null, makerMemberships: memberships,
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  });
}

/**
 * 계정 삭제 — 한 트랜잭션. 사람 행은 남기고(댓글·답장 작성자 FK 에 ON DELETE 가 없다) 이름을 '탈퇴한 사용자'로 바꾼 뒤
 * 로그인 수단·세션·GitHub 연결·저장·팔로·알림·메일·메이커 확인을 지운다. 신원이 지워지므로 같은 GitHub·이메일로 다시 오면 새 계정이다.
 * 써봤어요는 이 브라우저 열쇠(visitor_hash)가 있으면 익명으로 남기고, 계정에만 묶였으면 지운다. 공개한 의견·메이커 답장은 남는다.
 */
export async function deleteAccount(userId: number, confirmation: unknown): Promise<void> {
  await onPrimary(async () => {
    await limit(`me-delete:${userId}`, 5, RATE_HOUR, "delete_rate_limited");
    await db.transaction(async (tx) => {
      // 로그인 흐름(FOR SHARE)과 줄을 세운다 — 삭제가 끝난 뒤에는 그 계정으로 새 세션을 만들지 못한다
      const [user] = await tx.select({ displayName: publicUsers.displayName, deletedAt: publicUsers.deletedAt }).from(publicUsers).where(eq(publicUsers.id, userId)).for("update");
      if (!user || user.deletedAt) throw new PublicAuthError(401, "login_required");
      if (typeof confirmation !== "string" || confirmation.trim() !== user.displayName) throw new PublicAuthError(400, "delete_confirmation_mismatch");
      const emails = (await tx.select({ email: publicIdentities.subject }).from(publicIdentities)
        .where(and(eq(publicIdentities.userId, userId), eq(publicIdentities.provider, "email")))).map((row) => row.email);

      await tx.delete(publicSessions).where(eq(publicSessions.userId, userId));
      await tx.delete(githubMakerAuthContexts).where(eq(githubMakerAuthContexts.actorUserId, userId));
      await tx.delete(githubAuthFlows).where(eq(githubAuthFlows.actorUserId, userId));
      await tx.delete(githubStarOperationReceipts).where(eq(githubStarOperationReceipts.userId, userId));
      await tx.delete(githubStarOperations).where(eq(githubStarOperations.userId, userId));
      await tx.delete(githubUserConnections).where(eq(githubUserConnections.userId, userId));
      await tx.delete(notificationSettings).where(eq(notificationSettings.userId, userId));
      await tx.delete(publicIdentities).where(eq(publicIdentities.userId, userId));
      if (emails.length) await tx.delete(emailLoginChallenges).where(inArray(emailLoginChallenges.email, emails));
      await tx.delete(userSavedProducts).where(eq(userSavedProducts.userId, userId));
      await tx.delete(userFollows).where(eq(userFollows.userId, userId));
      await tx.delete(notifications).where(eq(notifications.userId, userId));
      await tx.delete(emailOutbox).where(eq(emailOutbox.userId, userId));
      await tx.delete(productMakerMembers).where(eq(productMakerMembers.userId, userId));
      const removed = await tx.delete(productReactions).where(and(eq(productReactions.userId, userId), isNull(productReactions.visitorHash))).returning({ id: productReactions.id });
      if (removed.length) await tx.delete(makerReplies).where(and(eq(makerReplies.targetType, "reaction"), inArray(makerReplies.targetId, removed.map((row) => row.id))));
      await tx.update(productReactions).set({ userId: null }).where(eq(productReactions.userId, userId));
      await tx.update(publicUsers).set({ displayName: DELETED_DISPLAY_NAME, displayNameChangedAt: null, deletedAt: sql`now()` }).where(eq(publicUsers.id, userId));
    });
  });
}

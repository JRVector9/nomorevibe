import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products, rateLimits } from "@/lib/db/schema";
import { emailLoginChallenges, publicIdentities, publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { githubAuthFlows, githubUserConnections } from "@/lib/db/github-user-schema";
import { githubMakerAuthContexts } from "@/lib/db/github-binding-schema";
import { githubStarOperationReceipts, githubStarOperations } from "@/lib/db/github-star-schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { githubIssueOutbox } from "@/lib/db/github-issue-outbox-schema";
import {
  emailOutbox, makerReplies, notifications, notificationSettings, productMakerMembers, productReactions, userFollows, userSavedProducts,
} from "@/lib/db/me-schema";
import { PublicAuthError } from "@/lib/domain/accounts/errors";
import { lockPublicEmail } from "@/lib/domain/accounts/repository";
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

/** 내 데이터 받기(개인정보보호법 열람) — 토큰·해시·암호화 값은 넣지 않는다. 하루 2번 — 읽다가 실패하면 그 한 번은 돌려준다 */
export async function exportAccount(userId: number) {
  const key = `me-export:${userId}`;
  return onPrimary(async () => {
    await limit(key, 2, 24 * RATE_HOUR, "export_rate_limited");
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
      // 계정 삭제가 지우는 내 줄은 모두 싣는다 — 알림 메일 발송함과 사이트에서 누른 GitHub 스타(중복 열쇠·요청 id·lease 는 빼고)
      const emails = await tx.select({ kind: emailOutbox.kind, payload: emailOutbox.payload, state: emailOutbox.state, createdAt: emailOutbox.createdAt, sentAt: emailOutbox.sentAt })
        .from(emailOutbox).where(eq(emailOutbox.userId, userId)).orderBy(desc(emailOutbox.createdAt));
      const stars = await tx.select({ slug: products.slug, repositoryId: githubStarOperations.repositoryId, productRepoUrl: githubStarOperations.productRepoUrl,
        state: githubStarOperations.state, desiredStarred: githubStarOperations.desiredStarred, dispatchedAt: githubStarOperations.dispatchedAt, observedAt: githubStarOperations.observedAt })
        .from(githubStarOperations).leftJoin(products, eq(products.id, githubStarOperations.productId)).where(eq(githubStarOperations.userId, userId))
        .orderBy(asc(githubStarOperations.repositoryId));
      const starRequests = await tx.select({ slug: products.slug, repositoryId: githubStarOperationReceipts.repositoryId, starred: githubStarOperationReceipts.starred,
        result: sql<string | null>`${githubStarOperationReceipts.response}->>'state'`, createdAt: githubStarOperationReceipts.createdAt })
        .from(githubStarOperationReceipts).leftJoin(products, eq(products.id, githubStarOperationReceipts.productId)).where(eq(githubStarOperationReceipts.userId, userId))
        .orderBy(desc(githubStarOperationReceipts.createdAt));
      return {
        exportedAt: new Date().toISOString(),
        profile: { displayName: user.displayName, createdAt: user.createdAt, displayNameChangedAt: user.displayNameChangedAt },
        identities: identities.map((row) => ({ provider: row.provider, ...(row.provider === "email" ? { email: row.subject } : { subject: row.subject, login: row.providerLogin }),
          verifiedAt: row.verifiedAt, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt })),
        githubStarConnection: github ?? null,
        sessions, saved, reactions, feedback, makerReplies: replies, follows, notifications: inbox,
        notificationSettings: settings ?? null, makerMemberships: memberships, notificationEmails: emails, githubStars: stars, githubStarRequests: starRequests,
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" }).catch(async (error: unknown) => {
      // 받지 못한 내려받기(끊김·장애 조치·시간 초과)가 하루 한도를 쓰지 않게 — 돌려주지 못해도 원래 오류를 낸다
      await db.update(rateLimits).set({ count: sql`greatest(${rateLimits.count} - 1, 0)` }).where(eq(rateLimits.key, key)).catch(() => undefined);
      throw error;
    });
  });
}

/**
 * 계정 삭제 — 한 트랜잭션. 사람 행은 남기고(댓글·답장 작성자 FK 에 ON DELETE 가 없다) 이름을 '탈퇴한 사용자'로 바꾼 뒤
 * 로그인 수단·세션·GitHub 연결·저장·팔로·알림·메일·메이커 확인을 지운다. 신원이 지워지므로 같은 GitHub·이메일로 다시 오면 새 계정이다.
 * 써봤어요와 공개되지 않은 의견·답장도 지운다. 공개한 의견·메이커 답장만 «탈퇴한 사용자» 이름으로 남고, 그 의견의 보내지 않은 GitHub 전달은 멈춘다.
 * public_users 행은 지우지 않는다(소프트 삭제) — 써봤어요 FK(ON DELETE SET NULL)와 주인 CHECK 가 맞지 않아, 행을 지우려면 써봤어요를 먼저 지워야 한다.
 */
export async function deleteAccount(userId: number, confirmation: unknown): Promise<void> {
  await onPrimary(async () => {
    await limit(`me-delete:${userId}`, 5, RATE_HOUR, "delete_rate_limited");
    await db.transaction(async (tx) => {
      // 이메일 로그인과 같은 순서로 잠근다 — 그 이메일의 로그인 흐름 잠금이 먼저, 계정 행이 다음(lockPublicEmail).
      // 거꾸로면 코드 확인(챌린지 FOR UPDATE → 계정 FOR SHARE)과 교착한다. 이메일 신원은 새 계정을 만들 때만 생기므로 먼저 읽어도 된다
      const emails = (await tx.select({ email: publicIdentities.subject }).from(publicIdentities)
        .where(and(eq(publicIdentities.userId, userId), eq(publicIdentities.provider, "email")))).map((row) => row.email).sort();
      for (const email of emails) await lockPublicEmail(tx, email);
      // 로그인 흐름(FOR SHARE)과 줄을 세운다 — 삭제가 끝난 뒤에는 그 계정으로 새 세션을 만들지 못한다
      const [user] = await tx.select({ displayName: publicUsers.displayName, deletedAt: publicUsers.deletedAt }).from(publicUsers).where(eq(publicUsers.id, userId)).for("update");
      if (!user || user.deletedAt) throw new PublicAuthError(401, "login_required");
      if (typeof confirmation !== "string" || confirmation.trim() !== user.displayName) throw new PublicAuthError(400, "delete_confirmation_mismatch");

      // 아직 보내지 않은 GitHub 이슈 전달은 멈춘다 — 본문에 그때의 닉네임이 박혀 있어 탈퇴 뒤 GitHub 에 그 이름이 새로 올라간다.
      // 이미 보낸 것(sending·uncertain)은 결과만 확인한다. 발송 워커와 같은 순서(발송함 → 의견)로 잠근다(lib/domain/feedback/github/outbox.ts)
      const stopped = await tx.update(githubIssueOutbox).set({ state: "cancelled", lastErrorCode: "author_deleted", leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() })
        .where(and(inArray(githubIssueOutbox.state, ["queued", "retry_wait"]),
          inArray(githubIssueOutbox.feedbackId, tx.select({ id: productFeedback.id }).from(productFeedback).where(eq(productFeedback.authorUserId, userId)))))
        .returning({ feedbackId: githubIssueOutbox.feedbackId });
      if (stopped.length) await tx.update(productFeedback).set({ deliveryState: "cancelled" }).where(inArray(productFeedback.id, stopped.map((row) => row.feedbackId)));

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
      // 써봤어요는 모두 지운다 — 익명으로 남기면 같은 브라우저 쿠키(공용 PC)로 다시 읽히고 고쳐진다. 거기 달린 메이커 답장도 함께
      const removed = await tx.delete(productReactions).where(eq(productReactions.userId, userId)).returning({ id: productReactions.id });
      if (removed.length) await tx.delete(makerReplies).where(and(eq(makerReplies.targetType, "reaction"), inArray(makerReplies.targetId, removed.map((row) => row.id))));
      // 공개되지 않은(보류·거절) 의견과 내 답장은 지운다 — 공개한 것만 «탈퇴한 사용자»로 남긴다. 의견의 GitHub 발송함은 FK cascade
      const hidden = await tx.delete(productFeedback).where(and(eq(productFeedback.authorUserId, userId), ne(productFeedback.reviewState, "accepted")))
        .returning({ id: productFeedback.id });
      if (hidden.length) await tx.delete(makerReplies).where(and(eq(makerReplies.targetType, "feedback"), inArray(makerReplies.targetId, hidden.map((row) => row.id))));
      await tx.delete(makerReplies).where(and(eq(makerReplies.authorUserId, userId), ne(makerReplies.reviewState, "accepted")));
      await tx.update(publicUsers).set({ displayName: DELETED_DISPLAY_NAME, displayNameChangedAt: null, deletedAt: sql`now()` }).where(eq(publicUsers.id, userId));
    });
  });
}

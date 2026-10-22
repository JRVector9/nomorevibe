import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { makerReplies, productMakerMembers, productReactions, userSavedProducts } from "@/lib/db/me-schema";
import { publicIdentities } from "@/lib/db/public-user-schema";
import { githubUserConnections } from "@/lib/db/github-user-schema";
import { initialFeedbackReview, type FeedbackKind } from "@/lib/domain/feedback/contract";
import { productReactionsEnabled } from "@/lib/domain/reactions/flags";
import { visitMetrics } from "@/lib/domain/products/clicks";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import * as productRepository from "@/lib/domain/products/repository";
import { updateSchema } from "@/lib/domain/products/schema";
import { hiddenByDefault } from "@/lib/domain/products/visibility";
import { isGithubRepositoryName } from "@/lib/github/repositories";
import { PUBLIC_PRIVATE_HEADERS, PublicAuthError, publicAuthErrorResponse } from "@/lib/domain/accounts/request-auth";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
import { WEB_FENCED_RETRY_AFTER } from "@/lib/operations/dr/web-gate";
import { logger } from "@/lib/observability/logger";
import type { MakerMethod, MakerReplyTarget, MakerRole, ReactionVerdict } from "./contract";
import { MakerError, nextRecheckDate } from "./maker-claims";
import { notifyPublishedMakerReply } from "./maker-reply-notify";
import { listedOwnerSql, renamedOwnerSql } from "./owner-key-sql";

/**
 * 내 프로젝트 탭(MY5·MY6) 읽기·쓰기 — 확인한 프로젝트 목록과 숫자, 내 저장소 찾기, 받은 의견과 답장, 소개 고치기.
 * 확인(claim)과 재확인은 maker-claims.ts. 모두 로그인한 계정 자신의 행만 읽고 쓴다.
 */

const REPLY_LIMIT = 1000;
const PUBLIC_STATUSES = ["seeded", "verified"] as const;

/** 이 계정의 GitHub 이름 — 로그인 때 적는 public_identities.provider_login, 없으면 스타 연결(github_user_connections)의 이름 */
export async function githubLoginOf(userId: number): Promise<{ linked: boolean; login: string | null }> {
  const rows = await onPrimary(() => db.select({ subject: publicIdentities.subject, login: publicIdentities.providerLogin, connected: githubUserConnections.githubLogin })
    .from(publicIdentities)
    .leftJoin(githubUserConnections, and(eq(githubUserConnections.userId, publicIdentities.userId), sql`${githubUserConnections.githubUserId}::text = ${publicIdentities.subject}`))
    .where(and(eq(publicIdentities.userId, userId), eq(publicIdentities.provider, "github"))).orderBy(asc(publicIdentities.id)));
  for (const row of rows) {
    const login = row.login ?? row.connected;
    if (login && isGithubRepositoryName(login, "x")) return { linked: true, login };
  }
  return { linked: rows.length > 0, login: null };
}

export type FoundRepo = { productId: number; slug: string; name: string; tagline: string; repo: string; listedAt: string };

/**
 * 내 저장소 찾기 — 공개 제품 중 저장소 주인 이름이 내 GitHub 이름과 같고(대소문자 무시) 아직 내가 확인하지 않은 것.
 * 이름이 바뀐 저장소는 GitHub 이 알려 준 지금 이름(repo_renamed_to)의 주인으로 본다. 확인할 때는 숫자 id 로 다시 맞춘다
 */
export async function findMyRepos(userId: number): Promise<{ linked: boolean; login: string | null; repos: FoundRepo[] }> {
  const { linked, login } = await githubLoginOf(userId);
  if (!login) return { linked, login: null, repos: [] };
  const owner = login.toLowerCase();
  const rows = await onPrimary(() => db.execute<{ id: number; slug: string; name: string; tagline: string; repo_url: string; repo_renamed_to: string | null; listed_iso: string }>(sql`
    select ${products.id} as id, ${products.slug} as slug, ${products.name} as name, ${products.tagline} as tagline,
      ${products.repoUrl} as repo_url, ${products.repoRenamedTo} as repo_renamed_to,
      to_char(coalesce(${products.verifiedAt}, ${products.createdAt}), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as listed_iso
    from ${products}
    where ${products.status} in ('seeded', 'verified')
      -- 후보는 저장소 주인 열쇠 색인으로 고른다(owner-key-sql.ts). 아래 줄이 정확한 조건이다
      and (${listedOwnerSql} = ${owner} or (${products.repoRenamedTo} is not null and ${renamedOwnerSql} = ${owner}))
      and lower(coalesce(split_part(${products.repoRenamedTo}, '/', 1),
        substring(${products.repoUrl} from '^https?://(?:www[.])?github[.]com/([^/]+)/[^/]+/?$'))) = ${owner}
      -- ?·# 가 붙은 주소는 저장소로 읽지 않는다(확인하면 no_github_repo — maker-claims.ts productRepoRef)
      and ${products.repoUrl} !~ '[?#]'
      and not exists (select 1 from product_maker_members m where m.product_id = ${products.id} and m.user_id = ${userId} and m.revoked_at is null)
    order by coalesce(${products.verifiedAt}, ${products.createdAt}) desc, ${products.id} desc
    limit 50
  `));
  return { linked, login, repos: rows.map((row) => ({
    productId: Number(row.id), slug: row.slug, name: row.name, tagline: row.tagline, listedAt: row.listed_iso,
    repo: row.repo_renamed_to ?? row.repo_url.replace(/^https?:\/\/(?:www\.)?github\.com\//i, "").replace(/\/$/, ""),
  })) };
}

/** 확인한 프로젝트가 하나라도 있나 — 탭 줄의 «내 프로젝트» */
export async function hasMakerProjects(userId: number): Promise<boolean> {
  const [row] = await onPrimary(() => db.select({ productId: productMakerMembers.productId }).from(productMakerMembers)
    .where(and(eq(productMakerMembers.userId, userId), isNull(productMakerMembers.revokedAt))).limit(1));
  return Boolean(row);
}

/**
 * 내 프로젝트에 들어온 공개 의견(로그인 댓글)과 공개 한 줄(써봤어요) — 답장 여부와 함께. 계정 하나의 확인한 제품만.
 * 써봤어요를 끄면(PRODUCT_REACTIONS_ENABLED) 한 줄은 빼고 의견만 본다.
 * author_deleted: 댓글 글쓴이가 탈퇴했다(이름이 비면 탈퇴, 한 줄은 이름이 늘 비어 «방문자»). notifiable: 답하면 알림을 받을 계정이 있다
 */
function inboxSource(userId: number) {
  return sql`
    with mine as (select product_id from product_maker_members where user_id = ${userId} and revoked_at is null),
    items as (
      select 'feedback'::text as target_type, f.id as target_id, f.product_id, f.kind, null::text as verdict, f.title, f.body,
        case when u.deleted_at is null then u.display_name end as author_name, u.deleted_at is not null as author_deleted,
        (u.deleted_at is null and u.id <> ${userId}) as notifiable, false as tried_verified, f.created_at as at
      from product_feedback f join mine using (product_id) join public_users u on u.id = f.author_user_id
      where f.review_state = 'accepted'
      ${productReactionsEnabled() ? sql`union all
      select 'reaction', r.id, r.product_id, null, r.verdict, null, r.comment, null, false,
        coalesce(ru.deleted_at is null and ru.id <> ${userId}, false), r.tried_verified, r.updated_at
      from product_reactions r join mine using (product_id) left join public_users ru on ru.id = r.user_id
      where r.comment_state = 'accepted'` : sql``}
    )`;
}

/** 답장을 기다린다 — 공개된 답장이 없다. 검토에 걸린(held) 옛 답장은 글쓴이에게 보이지 않으므로 아직 기다리는 것으로 센다 */
const awaitingReply = sql`not exists (select 1 from maker_replies mr where mr.target_type = i.target_type and mr.target_id = i.target_id and mr.review_state = 'accepted')`;

/** 답장 기다림 수 — 메이커가 /me 를 열 때 내 프로젝트 탭으로 열지 정한다(Q3: 기다림이 있을 때만) */
export async function makerPendingReplies(userId: number): Promise<number> {
  // /me 를 열 때마다 부른다 — 운영자가 아닌 대부분의 계정은 색인 한 번으로 끝낸다
  if (!(await hasMakerProjects(userId))) return 0;
  const [row] = await onPrimary(() => db.execute<{ n: number }>(sql`${inboxSource(userId)}
    select count(*)::int as n from items i where ${awaitingReply}`));
  return Number(row?.n ?? 0);
}

export type InboxItem = {
  targetType: MakerReplyTarget; targetId: string; productId: number; productSlug: string; productName: string;
  kind: FeedbackKind | null; verdict: ReactionVerdict | null; title: string | null; body: string; authorName: string | null;
  authorDeleted: boolean; notifiable: boolean; triedVerified: boolean; createdAt: string;
  reply: { id: string; body: string; reviewState: "accepted" | "held" | "rejected"; updatedAt: string } | null;
};

/** 받은 의견 한 쪽의 수 — 전체 보기는 이만큼씩 넘긴다 */
export const INBOX_PAGE = 50;

/** 받은 의견 — 답장 기다림이 먼저, 그 안에서 새것부터(waitingFirst). 전체 보기는 새것부터, offset 으로 쪽을 넘긴다 */
export async function makerInbox(userId: number, options: { limit: number; offset?: number; waitingFirst?: boolean }): Promise<{ items: InboxItem[]; waiting: number; total: number }> {
  const limit = Math.max(1, Math.min(options.limit, 100));
  const offset = Math.max(0, Math.min(Math.trunc(options.offset ?? 0), 100_000));
  return onPrimary(async () => {
    const rows = await db.execute<{
      target_type: MakerReplyTarget; target_id: string; product_id: number; slug: string; name: string; kind: FeedbackKind | null;
      verdict: ReactionVerdict | null; title: string | null; body: string; author_name: string | null; author_deleted: boolean; notifiable: boolean;
      tried_verified: boolean; at_iso: string;
      reply_id: string | null; reply_body: string | null; reply_state: "accepted" | "held" | "rejected" | null; reply_iso: string | null;
    }>(sql`${inboxSource(userId)}
      select i.target_type, i.target_id, i.product_id, p.slug, p.name, i.kind, i.verdict, i.title, i.body, i.author_name, i.author_deleted, i.notifiable,
        i.tried_verified, to_char(i.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at_iso,
        mr.id as reply_id, mr.body as reply_body, mr.review_state as reply_state,
        to_char(mr.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as reply_iso
      from items i join products p on p.id = i.product_id
      left join maker_replies mr on mr.target_type = i.target_type and mr.target_id = i.target_id
      order by ${options.waitingFirst ? sql`(mr.id is null or mr.review_state <> 'accepted') desc,` : sql``} i.at desc, i.target_id
      limit ${limit} offset ${offset}`);
    const [counts] = await db.execute<{ total: number; waiting: number }>(sql`${inboxSource(userId)}
      select count(*)::int as total, count(*) filter (where ${awaitingReply})::int as waiting from items i`);
    return {
      total: Number(counts?.total ?? 0), waiting: Number(counts?.waiting ?? 0),
      items: rows.map((row) => ({
        targetType: row.target_type, targetId: row.target_id, productId: Number(row.product_id), productSlug: row.slug, productName: row.name,
        kind: row.kind, verdict: row.verdict, title: row.title, body: row.body, authorName: row.author_name, authorDeleted: row.author_deleted === true,
        notifiable: row.notifiable === true, triedVerified: row.tried_verified, createdAt: row.at_iso,
        reply: row.reply_id ? { id: row.reply_id, body: row.reply_body ?? "", reviewState: row.reply_state ?? "accepted", updatedAt: row.reply_iso ?? row.at_iso } : null,
      })),
    };
  });
}

export type MakerProject = {
  productId: number; slug: string; name: string; tagline: string; description: string;
  status: "public" | "review" | "hidden"; role: MakerRole; method: MakerMethod; nextRecheckAt: string;
  /** 배지·공유 카드를 내주는 제품(공개 목록에 오른 것 — lib/me/share.ts 와 같은 규칙) */
  shareable: boolean;
  /** 공유 카드 주소에 붙여 소개를 고치면 새 그림을 받게 한다 */
  updatedAt: string;
  stars: number | null; visits7d: number; tried: number; good: number; meh: number; bad: number; feedback: number; waiting: number; saves: number;
};

/** 확인한 프로젝트 카드 — 상태·역할·다음 재확인과 숫자(스타, 7일 유효 방문, 써본 사람과 평가 셋, 의견, 답장 기다림, 저장). 써봤어요를 끄면 써본 사람·평가는 0 */
export async function makerProjects(userId: number): Promise<MakerProject[]> {
  return onPrimary(async () => {
    const rows = await db.select({
      productId: products.id, slug: products.slug, name: products.name, tagline: products.tagline, description: products.description,
      productStatus: products.status, category: products.category, source: products.source, claimedAt: products.claimedAt, updatedAt: products.updatedAt,
      auditHoldAt: products.auditHoldAt,
      stars: products.stars, role: productMakerMembers.role, method: productMakerMembers.method,
      verifiedAt: productMakerMembers.verifiedAt, recheckAt: productMakerMembers.recheckAt,
    }).from(productMakerMembers).innerJoin(products, eq(products.id, productMakerMembers.productId))
      .where(and(eq(productMakerMembers.userId, userId), isNull(productMakerMembers.revokedAt)))
      .orderBy(asc(productMakerMembers.verifiedAt), asc(products.id));
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.productId);
    const [reactions, feedback, saves, waiting, visits] = await Promise.all([
      !productReactionsEnabled() ? [] : db.select({
        productId: productReactions.productId, tried: sql<number>`count(*)::int`,
        good: sql<number>`count(*) filter (where ${productReactions.verdict} = 'good')::int`,
        meh: sql<number>`count(*) filter (where ${productReactions.verdict} = 'meh')::int`,
        bad: sql<number>`count(*) filter (where ${productReactions.verdict} = 'bad')::int`,
      }).from(productReactions).where(and(inArray(productReactions.productId, ids), eq(productReactions.rankingExcluded, false)))
        .groupBy(productReactions.productId),
      db.select({ productId: productFeedback.productId, n: sql<number>`count(*)::int` }).from(productFeedback)
        .where(and(inArray(productFeedback.productId, ids), eq(productFeedback.reviewState, "accepted"))).groupBy(productFeedback.productId),
      db.select({ productId: userSavedProducts.productId, n: sql<number>`count(*)::int` }).from(userSavedProducts)
        .where(inArray(userSavedProducts.productId, ids)).groupBy(userSavedProducts.productId),
      db.execute<{ product_id: number; n: number }>(sql`${inboxSource(userId)}
        select i.product_id, count(*)::int as n from items i where ${awaitingReply} group by i.product_id`),
      visitMetrics(rows.map((row) => row.slug)),
    ]);
    const by = <T extends { productId: number }>(list: T[]) => new Map(list.map((row) => [row.productId, row]));
    const reactionBy = by(reactions), feedbackBy = by(feedback), savesBy = by(saves);
    const waitingBy = new Map(waiting.map((row) => [Number(row.product_id), Number(row.n)]));
    return rows.map((row) => {
      const reaction = reactionBy.get(row.productId);
      const status = (PUBLIC_STATUSES as readonly string[]).includes(row.productStatus) ? "public" : row.productStatus === "banned" ? "hidden" : "review";
      return {
        productId: row.productId, slug: row.slug, name: row.name, tagline: row.tagline, description: row.description, status,
        // 주인 없는 수집 개인 프로필·감사 보류는 목록에서 빠진다 — 배지·카드도 404 다(share.ts)
        shareable: status === "public" && !row.auditHoldAt && !(hiddenByDefault(row.category) && row.source === "crawler" && !row.claimedAt),
        updatedAt: row.updatedAt.toISOString(),
        role: row.role, method: row.method, nextRecheckAt: nextRecheckDate(row.verifiedAt, row.recheckAt).toISOString(),
        stars: row.stars, visits7d: visits.get(row.slug)?.validVisits ?? 0,
        tried: reaction?.tried ?? 0, good: reaction?.good ?? 0, meh: reaction?.meh ?? 0, bad: reaction?.bad ?? 0,
        feedback: feedbackBy.get(row.productId)?.n ?? 0, waiting: waitingBy.get(row.productId) ?? 0, saves: savesBy.get(row.productId)?.n ?? 0,
      } satisfies MakerProject;
    });
  });
}

/** 이 계정이 이 제품의 운영자(풀리지 않은 행)인가 */
async function activeMember(executor: ProductTransaction | typeof db, userId: number, productId: number): Promise<boolean> {
  const [row] = await executor.select({ productId: productMakerMembers.productId }).from(productMakerMembers)
    .where(and(eq(productMakerMembers.productId, productId), eq(productMakerMembers.userId, userId), isNull(productMakerMembers.revokedAt))).limit(1);
  return Boolean(row);
}

export type ReplyInput = { targetType: MakerReplyTarget; targetId: string; body: string };

/**
 * 답장 본문 검사 — 1~1000자. 링크가 넷 이상이면 저장 후 관리자 답장 검수에서 공개 여부를 정한다.
 */
export function parseReplyInput(value: unknown): ReplyInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MakerError("reply_invalid", 400);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["targetType", "targetId", "body"].includes(key))
    || (input.targetType !== "feedback" && input.targetType !== "reaction")
    || typeof input.targetId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.targetId)
    || typeof input.body !== "string") throw new MakerError("reply_invalid", 400);
  const body = input.body.replace(/\r\n?/g, "\n").trim();
  if (!body || body.length > REPLY_LIMIT) throw new MakerError("reply_invalid", 400);
  return { targetType: input.targetType, targetId: input.targetId.toLowerCase(), body };
}

/** notified: 이번 쓰기로 글쓴이 알림이 생겼다(익명 한 줄·탈퇴한 글쓴이·내 글·고치기면 false) */
export type SavedReply = { id: string; body: string; reviewState: "accepted" | "held" | "rejected"; updatedAt: string; created: boolean; notified: boolean };

/**
 * 답장 쓰기·고치기 — 대상(공개된 의견·한 줄) 하나에 답장 하나. 그 제품의 운영자(풀리지 않은 행)만 쓴다(아니면 403).
 * 처음 공개된 답장이면 글쓴이에게 알림 하나(maker_reply:<답장 id>). 고치기는 알림을 다시 보내지 않는다.
 * 써봤어요를 끄면 한 줄에는 답하지 못한다(404)
 */
export async function upsertMakerReply(userId: number, input: ReplyInput): Promise<SavedReply> {
  if (input.targetType === "reaction" && !productReactionsEnabled()) throw new MakerError("target_not_found", 404);
  const review = initialFeedbackReview(input.body, false);
  const saved = await onPrimary(() => db.transaction(async (tx) => {
    // 같은 대상의 동시 답장을 한 줄로 세운다
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`maker-reply:${input.targetType}:${input.targetId}`}))`);
    const target = input.targetType === "feedback"
      ? (await tx.select({ productId: productFeedback.productId, recipient: productFeedback.authorUserId }).from(productFeedback)
        .where(and(eq(productFeedback.id, input.targetId), eq(productFeedback.reviewState, "accepted"))))[0]
      : (await tx.select({ productId: productReactions.productId, recipient: productReactions.userId }).from(productReactions)
        .where(and(eq(productReactions.id, input.targetId), eq(productReactions.commentState, "accepted"))))[0];
    if (!target) throw new MakerError("target_not_found", 404);
    if (!(await activeMember(tx, userId, target.productId))) throw new MakerError("not_a_member", 403);
    const [previous] = await tx.select({ id: makerReplies.id, reviewState: makerReplies.reviewState, reviewRequired: makerReplies.reviewRequired }).from(makerReplies)
      .where(and(eq(makerReplies.targetType, input.targetType), eq(makerReplies.targetId, input.targetId)));
    // 관리자가 숨긴 답장을 고치면 다시 검수한다. 내용 수정으로 숨김 결정을 우회하지 않는다.
    const reviewState = previous?.reviewRequired ? "held" : review.state;
    const [reply] = previous
      ? await tx.update(makerReplies).set({ body: input.body, authorUserId: userId, reviewState, reviewVersion: sql`${makerReplies.reviewVersion} + 1`, updatedAt: sql`now()` })
        .where(eq(makerReplies.id, previous.id)).returning()
      : await tx.insert(makerReplies).values({ productId: target.productId, targetType: input.targetType, targetId: input.targetId,
        authorUserId: userId, body: input.body, reviewState: review.state }).returning();
    const notified = reply.reviewState === "accepted" && previous?.reviewState !== "accepted"
      ? await notifyPublishedMakerReply(tx, reply, target.recipient) : false;
    return { reply, created: !previous, notified };
  }));
  return { id: saved.reply.id, body: saved.reply.body, reviewState: saved.reply.reviewState,
    updatedAt: saved.reply.updatedAt.toISOString(), created: saved.created, notified: saved.notified };
}

export type IntroInput = { productId: number; tagline?: string; description?: string };

/** 소개 고치기 본문 — 제품 번호와 한 줄 소개·소개 중 하나 이상. 글자 규칙은 수정 키 경로와 같은 updateSchema */
export function parseIntroInput(value: unknown): { productId: number; updates: { tagline?: string; description?: string } } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MakerError("intro_invalid", 400);
  const { productId, ...rest } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(productId) || (productId as number) <= 0) throw new MakerError("intro_invalid", 400);
  const trimmed = Object.fromEntries(Object.entries(rest).map(([key, item]) => [key, typeof item === "string" ? item.trim() : item]));
  if (Object.keys(trimmed).length === 0 || Object.keys(trimmed).some((key) => key !== "tagline" && key !== "description")) throw new MakerError("intro_invalid", 400);
  const parsed = updateSchema.safeParse(trimmed);
  if (!parsed.success) throw new MakerError("intro_invalid", 400);
  return { productId: productId as number, updates: { tagline: parsed.data.tagline, description: parsed.data.description } };
}

/**
 * 소개 고치기 — 운영자로 확인한 계정의 길. 수정 키 경로(manage.ts updateProduct)와 같은 검사·같은 쓰기(repository.update)라
 * 검토를 거치지 않고 바로 바뀐다(«AI가 요약» 표시도 같은 자리에서 뗀다). 공개 화면 캐시는 몇 분 뒤에 따라온다
 */
export async function editMakerIntro(userId: number, input: { productId: number; updates: { tagline?: string; description?: string } }): Promise<{ state: "applied" }> {
  const allowed = await onPrimary(async () => {
    const [product] = await db.select({ status: products.status }).from(products).where(eq(products.id, input.productId));
    if (!product || product.status === "banned") return null;
    return activeMember(db, userId, input.productId);
  });
  if (allowed === null) throw new MakerError("product_not_found", 404);
  if (!allowed) throw new MakerError("not_a_member", 403);
  const updates: { tagline?: string; description?: string } = {};
  if (input.updates.tagline !== undefined) updates.tagline = input.updates.tagline;
  if (input.updates.description !== undefined) updates.description = input.updates.description;
  await onPrimary(() => productRepository.update(input.productId, updates));
  logger.info("maker.intro_edited", { productId: input.productId, userId, fields: Object.keys(updates) });
  return { state: "applied" };
}

/** 라우트용 작은 JSON 읽기 — 크기를 넘기 전에 끊는다 */
export async function readMakerJson(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new MakerError("invalid_request", 415);
  if (Number(request.headers.get("content-length")) > limit || !request.body) throw new MakerError("invalid_request", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new MakerError("invalid_request", 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof MakerError) throw error;
    throw new MakerError("invalid_request", 400);
  } finally { reader.releaseLock(); }
}

/** 라우트 오류 응답 — 메이커 오류는 코드 그대로, 로그인·CSRF·fenced DB 는 계정 경로와 같은 모양. 모두 private no-store */
export function makerErrorResponse(error: unknown): Response {
  if (error instanceof MakerError) return Response.json({ error: error.code }, { status: error.status, headers: PUBLIC_PRIVATE_HEADERS });
  if (!(error instanceof PublicAuthError) && !(error instanceof DrWriterFencedError)) logger.warn("maker.route_failed", { error });
  return publicAuthErrorResponse(error);
}

/** fenced DB 쓰기 거절 — 계정 경로와 같은 503 */
export function makerFencedResponse(): Response {
  return Response.json({ error: "public_auth_unavailable" }, { status: 503, headers: { ...PUBLIC_PRIVATE_HEADERS, "Retry-After": WEB_FENCED_RETRY_AFTER } });
}

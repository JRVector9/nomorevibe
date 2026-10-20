import { eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { githubUserConnections } from "@/lib/db/github-user-schema";
import { publicIdentities, publicUsers } from "@/lib/db/public-user-schema";
import { reactionListVisible } from "@/lib/domain/reactions/repository";
import { savedPublic } from "./saved";

/** 마이페이지 머리 숫자 — 저장·써봤어요·의견·팔로 개수와 안 읽은 알림. 머리·아바타 메뉴·GET /api/me/summary 가 같이 쓴다 */
export type MeCounts = { saved: number; tried: number; opinions: number; following: number; unreadAlerts: number };
/** 로그인 수단 칩 — GitHub 은 login, 이메일은 주소를 싣지 않는다 */
export type MeProvider = { provider: "github" | "email"; login: string | null };
export type MeSummary = { user: { id: number; displayName: string; createdAt: string }; counts: MeCounts; isMaker: boolean; providers: MeProvider[] };

type CountRow = { saved: unknown; tried: unknown; opinions: unknown; following: unknown; unread_alerts: unknown; is_maker: unknown };
type IdentityRow = { provider: string; providerLogin: string | null; githubLogin: string | null };

const count = (value: unknown) => {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
};

/** 표에서 읽은 값을 응답 모양으로 — 개수는 0 이상 정수, 수단은 GitHub 먼저, 모르는 수단은 뺀다 */
export function shapeMeSummary(user: { id: number; displayName: string; createdAt: Date }, counts: CountRow, identities: IdentityRow[]): MeSummary {
  const providers: MeProvider[] = [];
  for (const kind of ["github", "email"] as const) {
    for (const identity of identities.filter((row) => row.provider === kind)) {
      const login = kind === "github" ? identity.providerLogin ?? identity.githubLogin : null;
      providers.push({ provider: kind, login: login && /^[A-Za-z0-9-]{1,100}$/.test(login) ? login : null });
    }
  }
  return {
    user: { id: user.id, displayName: user.displayName, createdAt: user.createdAt.toISOString() },
    counts: { saved: count(counts.saved), tried: count(counts.tried), opinions: count(counts.opinions), following: count(counts.following), unreadAlerts: count(counts.unread_alerts) },
    isMaker: counts.is_maker === true,
    providers,
  };
}

/** 한 계정의 머리 숫자. 바뀐 직후에도 맞아야 해서 주 DB 에서 읽는다. 저장·써봤어요는 탭과 같은 공개 조건으로 센다. 탈퇴한 계정은 null */
export function getMeSummary(userId: number): Promise<MeSummary | null> {
  return onPrimary(async () => {
    const [user] = await db.select({ id: publicUsers.id, displayName: publicUsers.displayName, createdAt: publicUsers.createdAt, deletedAt: publicUsers.deletedAt })
      .from(publicUsers).where(eq(publicUsers.id, userId));
    if (!user || user.deletedAt) return null;
    const [[counts], identities] = await Promise.all([
      db.execute<CountRow>(sql`select
        (select count(*) from user_saved_products s join products on products.id = s.product_id where s.user_id = ${userId} and ${savedPublic}) as saved,
        (select count(*) from product_reactions r join products on products.id = r.product_id where r.user_id = ${userId} and ${reactionListVisible}) as tried,
        (select count(*) from product_feedback where author_user_id = ${userId}) as opinions,
        (select count(*) from user_follows where user_id = ${userId}) as following,
        (select count(*) from notifications where user_id = ${userId} and read_at is null) as unread_alerts,
        exists(select 1 from product_maker_members where user_id = ${userId} and revoked_at is null) as is_maker`),
      db.select({ provider: publicIdentities.provider, providerLogin: publicIdentities.providerLogin, githubLogin: githubUserConnections.githubLogin })
        .from(publicIdentities).leftJoin(githubUserConnections, eq(githubUserConnections.userId, publicIdentities.userId))
        .where(eq(publicIdentities.userId, userId)).orderBy(publicIdentities.id),
    ]);
    return shapeMeSummary(user, counts, identities);
  });
}

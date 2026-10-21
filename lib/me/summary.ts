import { eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { githubUserConnections } from "@/lib/db/github-user-schema";
import { publicIdentities } from "@/lib/db/public-user-schema";
import { reactionListVisible } from "@/lib/domain/reactions/repository";
import { savedPublic } from "./saved";

/** 마이페이지 머리 숫자 — 저장·써봤어요·의견·팔로 개수와 안 읽은 알림. 마이페이지 틀과 GET /api/me/summary 가 쓴다(화면마다 받는 머리 값은 getMeHeader) */
export type MeCounts = { saved: number; tried: number; opinions: number; following: number; unreadAlerts: number };
/** 로그인 수단 칩 — GitHub 은 login, 이메일은 주소를 싣지 않는다 */
export type MeProvider = { provider: "github" | "email"; login: string | null };
export type MeSummary = { user: { id: number; displayName: string; createdAt: string }; counts: MeCounts; isMaker: boolean; providers: MeProvider[] };

type CountRow = { saved: unknown; tried: unknown; opinions: unknown; following: unknown; unread_alerts: unknown; is_maker: unknown };
type UserCountRow = CountRow & { display_name: string; created_iso: string; deleted: boolean };
type IdentityRow = { provider: string; providerLogin: string | null; githubLogin: string | null };

const count = (value: unknown) => {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
};

/** 로그인 수단 칩 — GitHub 먼저, 모르는 수단은 뺀다 */
function shapeProviders(identities: IdentityRow[]): MeProvider[] {
  const providers: MeProvider[] = [];
  for (const kind of ["github", "email"] as const) {
    for (const identity of identities.filter((row) => row.provider === kind)) {
      const login = kind === "github" ? identity.providerLogin ?? identity.githubLogin : null;
      providers.push({ provider: kind, login: login && /^[A-Za-z0-9-]{1,100}$/.test(login) ? login : null });
    }
  }
  return providers;
}

/** 표에서 읽은 값을 응답 모양으로 — 개수는 0 이상 정수, 수단은 GitHub 먼저, 모르는 수단은 뺀다 */
export function shapeMeSummary(user: { id: number; displayName: string; createdAt: Date }, counts: CountRow, identities: IdentityRow[]): MeSummary {
  const providers = shapeProviders(identities);
  return {
    user: { id: user.id, displayName: user.displayName, createdAt: user.createdAt.toISOString() },
    counts: { saved: count(counts.saved), tried: count(counts.tried), opinions: count(counts.opinions), following: count(counts.following), unreadAlerts: count(counts.unread_alerts) },
    isMaker: counts.is_maker === true,
    providers,
  };
}

/**
 * 한 계정의 머리 숫자. 바뀐 직후에도 맞아야 해서 주 DB 에서 읽는다. 저장·써봤어요는 탭과 같은 공개 조건으로 센다. 탈퇴한 계정은 null.
 * 계정 행과 숫자는 한 문장이다 — 계정을 먼저 읽고 숫자를 기다리는 왕복을 두지 않는다(로그인한 모든 화면의 머리가 부른다)
 */
export function getMeSummary(userId: number): Promise<MeSummary | null> {
  return onPrimary(async () => {
    const [[row], identities] = await Promise.all([
      db.execute<UserCountRow>(sql`select u.display_name, u.deleted_at is not null as deleted,
        to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_iso,
        (select count(*) from user_saved_products s join products on products.id = s.product_id where s.user_id = u.id and ${savedPublic}) as saved,
        (select count(*) from product_reactions r join products on products.id = r.product_id where r.user_id = u.id and ${reactionListVisible}) as tried,
        (select count(*) from product_feedback where author_user_id = u.id) as opinions,
        (select count(*) from user_follows where user_id = u.id) as following,
        (select count(*) from notifications where user_id = u.id and read_at is null) as unread_alerts,
        exists(select 1 from product_maker_members where user_id = u.id and revoked_at is null) as is_maker
        from public_users u where u.id = ${userId}`),
      db.select({ provider: publicIdentities.provider, providerLogin: publicIdentities.providerLogin, githubLogin: githubUserConnections.githubLogin })
        .from(publicIdentities).leftJoin(githubUserConnections, eq(githubUserConnections.userId, publicIdentities.userId))
        .where(eq(publicIdentities.userId, userId)).orderBy(publicIdentities.id),
    ]);
    if (!row || row.deleted) return null;
    return shapeMeSummary({ id: userId, displayName: row.display_name, createdAt: new Date(row.created_iso) }, row, identities);
  });
}

/**
 * 머리(아바타 메뉴·종·저장 동기화)가 화면마다 받는 값 — GET /api/me?view=header. 머리 숫자 전부(getMeSummary)는 마이페이지만 읽는다.
 * 한 문장으로 읽는다. 안 읽은 수는 종과 같이 100에서 멈추고, 저장 판(공개 저장 수:마지막 저장 시각)은 저장 동기화가 계정 목록을 다시 받을지 본다
 */
export type MeHeader = { isMaker: boolean; providers: MeProvider[]; unreadAlerts: number; savedVersion: string };

export function getMeHeader(userId: number): Promise<MeHeader> {
  return onPrimary(async () => {
    const [row] = await db.execute<{ is_maker: unknown; unread_alerts: unknown; saved_version: unknown; identities: unknown }>(sql`select
      exists(select 1 from product_maker_members where user_id = ${userId} and revoked_at is null) as is_maker,
      (select count(*) from (select 1 from notifications where user_id = ${userId} and read_at is null limit 100) n) as unread_alerts,
      (select count(*)::text || ':' || coalesce((extract(epoch from max(s.created_at)) * 1000000)::bigint, 0)::text
        from user_saved_products s join products on products.id = s.product_id where s.user_id = ${userId} and ${savedPublic}) as saved_version,
      (select coalesce(json_agg(json_build_object('provider', i.provider, 'providerLogin', i.provider_login, 'githubLogin', g.github_login) order by i.id), '[]'::json)
        from public_identities i left join github_user_connections g on g.user_id = i.user_id where i.user_id = ${userId}) as identities`);
    return {
      isMaker: row?.is_maker === true,
      providers: shapeProviders(Array.isArray(row?.identities) ? row.identities as IdentityRow[] : []),
      unreadAlerts: count(row?.unread_alerts),
      savedVersion: String(row?.saved_version ?? ""),
    };
  });
}

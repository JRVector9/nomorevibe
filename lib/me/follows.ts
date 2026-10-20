import "server-only";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products, productUpdates } from "@/lib/db/schema";
import { userFollows } from "@/lib/db/me-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { PublicAuthError } from "@/lib/domain/accounts/errors";
import type { Category } from "@/lib/domain/products/categories";
import { FOLLOW_TARGETS, type FollowTarget } from "./contract";
import { categoryOfKey, FOLLOW_LIMIT, parseFollowKey, type FollowKey } from "./follow-keys";

/**
 * SQL 쪽 같은 열쇠 둘 — 등록한 주소의 계정과 옮겨 간 계정. 상세가 보여 주는 주인은 둘 중 하나다.
 * 두 식은 0108 의 색인(products_listed_owner_idx·products_renamed_owner_idx)과 글자까지 같아야 색인을 탄다 — 아니면 제품 전부를 정규식으로 훑는다
 */
const listedOwner = sql<string | null>`substring(lower(${products.repoUrl}) from '^https?://(?:www\\.)?github\\.com/([a-z0-9-]+)/[^/]+/?$')`;
const renamedOwner = sql<string | null>`nullif(lower(split_part(${products.repoRenamedTo}, '/', 1)), '')`;
const visibleProduct = ne(products.status, "banned");

/** 옮겨 간 계정 쪽은 부분 색인(repo_renamed_to is not null)이라 그 조건을 함께 적는다 */
function ownedBy(keys: string[]) {
  const list = sql.join(keys.map((key) => sql`${key}`), sql`, `);
  return sql`(${listedOwner} in (${list}) or (${products.repoRenamedTo} is not null and ${renamedOwner} in (${list})))`;
}

/**
 * 메이커 열쇠마다 공개 프로젝트 수와 GitHub 에 적힌 대로의 이름(대소문자) — 제품마다 열쇠가 둘일 수 있어 펼쳐 센다.
 * 펼치기 전에 색인으로 그 열쇠의 제품만 고른다(ownedBy)
 */
async function makerProjects(keys: string[]): Promise<Array<{ key: string; login: string; projects: number }>> {
  const list = sql.join(keys.map((key) => sql`${key}`), sql`, `);
  return db.execute<{ key: string; login: string; projects: number }>(sql`
    select k.key, min(k.login) as login, count(distinct ${products.id})::int as projects
      from ${products}
     cross join lateral (values
       (${listedOwner}, substring(${products.repoUrl} from '(?i)^https?://(?:www\\.)?github\\.com/([a-z0-9-]+)/[^/]+/?$')),
       (${renamedOwner}, nullif(split_part(${products.repoRenamedTo}, '/', 1), ''))
     ) as k(key, login)
     where ${products.status} in ('seeded', 'verified') and ${ownedBy(keys)} and k.key in (${list})
     group by k.key`);
}

/** 팔로할 대상이 지금 있는가 — 상세가 열리는 제품(차단 아님), 그 주인, 알려진 분야 */
async function targetExists({ targetType, targetKey }: FollowKey): Promise<boolean> {
  if (targetType === "category") return true;
  const where = targetType === "product" ? and(eq(products.id, Number(targetKey)), visibleProduct) : and(visibleProduct, ownedBy([targetKey]));
  const [row] = await db.select({ id: products.id }).from(products).where(where).limit(1);
  return Boolean(row);
}

/** 팔로한다. 이미 팔로 중이면 그대로 둔다. 같은 계정의 동시 요청은 계정 행 잠금으로 줄을 세워 상한을 넘지 않게 한다 */
export async function follow(userId: number, key: FollowKey): Promise<{ created: boolean }> {
  return onPrimary(async () => {
    if (!await targetExists(key)) throw new PublicAuthError(404, "follow_not_found");
    return db.transaction(async (tx) => {
      const [user] = await tx.select({ id: publicUsers.id }).from(publicUsers).where(eq(publicUsers.id, userId)).for("update");
      if (!user) throw new PublicAuthError(404, "follow_not_found");
      const [existing] = await tx.select({ userId: userFollows.userId }).from(userFollows).where(and(eq(userFollows.userId, userId),
        eq(userFollows.targetType, key.targetType), eq(userFollows.targetKey, key.targetKey)));
      if (existing) return { created: false };
      const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` }).from(userFollows).where(eq(userFollows.userId, userId));
      if (total >= FOLLOW_LIMIT) throw new PublicAuthError(409, "follow_limit");
      await tx.insert(userFollows).values({ userId, ...key }).onConflictDoNothing();
      return { created: true };
    });
  });
}

export async function unfollow(userId: number, key: FollowKey): Promise<{ removed: boolean }> {
  const rows = await onPrimary(() => db.delete(userFollows).where(and(eq(userFollows.userId, userId),
    eq(userFollows.targetType, key.targetType), eq(userFollows.targetKey, key.targetKey))).returning({ userId: userFollows.userId }));
  return { removed: rows.length > 0 };
}

/** 단추가 묻는 것만 — 제품·메이커·분야 하나씩 */
export async function followState(userId: number, query: Partial<Record<FollowTarget, string>>): Promise<Partial<Record<FollowTarget, boolean>>> {
  const asked = FOLLOW_TARGETS.flatMap((targetType) => {
    const key = parseFollowKey({ targetType, targetKey: query[targetType] });
    return key ? [key] : [];
  });
  if (!asked.length) return {};
  const rows = await onPrimary(() => db.select({ targetType: userFollows.targetType, targetKey: userFollows.targetKey }).from(userFollows)
    .where(and(eq(userFollows.userId, userId), sql`(${userFollows.targetType}, ${userFollows.targetKey}) in (${sql.join(asked.map((key) => sql`(${key.targetType}, ${key.targetKey})`), sql`, `)})`)));
  return Object.fromEntries(asked.map((key) => [key.targetType, rows.some((row) => row.targetType === key.targetType && row.targetKey === key.targetKey)]));
}

export type FollowedProduct = {
  productId: number; slug: string; name: string; ogImage: string | null; category: string;
  /** 차단되면 false — 팔로는 남겨 두고 풀 수 있게 보인다 */
  listed: boolean;
  latest: { title: string; at: string } | null; followedAt: string;
};
export type FollowedMaker = { key: string; login: string; projects: number; followedAt: string };
export type FollowedCategory = { slug: string; category: Category; newThisWeek: number; followedAt: string };
export type FollowList = { products: FollowedProduct[]; makers: FollowedMaker[]; categories: FollowedCategory[] };

/** 팔로 탭 — 종류별로, 최근에 팔로한 것부터. 화면에 그릴 이름·타일·최근 소식을 함께 읽는다 */
export async function listFollows(userId: number): Promise<FollowList> {
  return onPrimary(async () => {
    const rows = await db.select().from(userFollows).where(eq(userFollows.userId, userId)).orderBy(desc(userFollows.createdAt)).limit(FOLLOW_LIMIT);
    const of = (type: FollowTarget) => rows.filter((row) => row.targetType === type);
    const productIds = of("product").map((row) => Number(row.targetKey));
    const makerKeys = of("maker").map((row) => row.targetKey);
    const categoryRows = of("category").flatMap((row) => {
      const category = categoryOfKey(row.targetKey);
      return category ? [{ row, category }] : [];
    });
    const [productRows, makerRows, categoryCounts] = await Promise.all([
      productIds.length ? db.select({ id: products.id, slug: products.slug, name: products.name, ogImage: products.ogImage, category: products.category, status: products.status })
        .from(products).where(inArray(products.id, productIds)) : [],
      makerKeys.length ? makerProjects(makerKeys) : [],
      categoryRows.length ? db.select({ category: products.category, total: sql<number>`count(*)::int` }).from(products)
        .where(and(inArray(products.status, ["seeded", "verified"]), inArray(products.category, categoryRows.map((item) => item.category)),
          sql`coalesce(${products.verifiedAt}, ${products.createdAt}) >= now() - interval '7 days'`)).groupBy(products.category) : [],
    ]);
    const slugs = productRows.map((row) => row.slug);
    const updates = slugs.length ? await db.selectDistinctOn([productUpdates.slug], { slug: productUpdates.slug, title: productUpdates.title,
      at: sql<Date>`coalesce(${productUpdates.publishedAt}, ${productUpdates.observedAt})` }).from(productUpdates)
      .where(and(inArray(productUpdates.slug, slugs), eq(productUpdates.visible, true), sql`${productUpdates.makerDeletedAt} is null`))
      .orderBy(productUpdates.slug, sql`coalesce(${productUpdates.publishedAt}, ${productUpdates.observedAt}) desc`) : [];
    return {
      products: of("product").flatMap((row) => {
        const product = productRows.find((item) => item.id === Number(row.targetKey));
        if (!product) return [];
        const latest = updates.find((item) => item.slug === product.slug);
        return [{ productId: product.id, slug: product.slug, name: product.name, ogImage: product.ogImage, category: product.category,
          listed: product.status !== "banned", latest: latest ? { title: latest.title, at: new Date(latest.at).toISOString() } : null,
          followedAt: row.createdAt.toISOString() }];
      }),
      makers: of("maker").map((row) => {
        const maker = makerRows.find((item) => item.key === row.targetKey);
        return { key: row.targetKey, login: maker?.login || row.targetKey, projects: maker?.projects ?? 0, followedAt: row.createdAt.toISOString() };
      }),
      categories: categoryRows.map(({ row, category }) => ({ slug: row.targetKey, category,
        newThisWeek: categoryCounts.find((item) => item.category === category)?.total ?? 0, followedAt: row.createdAt.toISOString() })),
    };
  });
}

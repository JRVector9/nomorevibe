import "server-only";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productUpdates } from "@/lib/db/schema";
import { productReactions, userSavedProducts } from "@/lib/db/me-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { PublicAuthError } from "@/lib/domain/accounts/request-auth";
import { taglineKo } from "@/lib/domain/products/korean-tagline";
import { LIST_COLUMNS, listedByDefault, repoGone, type ProductListRow } from "@/lib/domain/products/repository";
import { toListItem, withProductHealth, type ProductListItem } from "@/lib/domain/products/view";
import type { Locale } from "@/lib/i18n/locales";
import { localizeProductList } from "@/lib/i18n/products";
import { SAVED_LIMIT } from "./contract";

/**
 * 계정 저장 목록(시안 MY2, 로그인 설계 L4) — user_saved_products 읽기·쓰기와 첫 로그인 합치기.
 * 쓰기는 사용자 행을 잠그고 센다. 두 기기가 동시에 저장해도 500개를 넘지 않는다.
 */

export const SAVED_SORTS = ["recent", "stars", "activity"] as const;
export type SavedSort = (typeof SAVED_SORTS)[number];
export const SAVED_FILTERS = ["all", "untried"] as const;
export type SavedFilter = (typeof SAVED_FILTERS)[number];
export const SAVED_PAGE_SIZE = 24;
/** 합치기 한 번에 받는 주소 수와 본문 크기 — 80자 주소 500개가 들어간다 */
export const MERGE_BODY_BYTES = 42 * 1024;
/** 로그아웃 목록의 카드 한 번에 받는 주소 수 */
export const SUMMARY_SLUG_LIMIT = 100;
export const SUMMARY_BODY_BYTES = 10 * 1024;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

export const isProductSlug = (value: unknown): value is string => typeof value === "string" && SLUG.test(value);

/** 화면에 내보내는 카드 — 공개 카드(ProjectCard)가 쓰는 칸 + 저장한 때·써봤는지. 날짜는 ISO 글자 */
export type SavedItem = Pick<ProductListItem, "slug" | "name" | "tagline" | "taglineSource" | "taglineKo" | "translation" | "category" | "accessMode"
  | "aiLevel" | "builder" | "builderClaim" | "ogImage" | "makerName" | "repoUrl" | "repoRenamedTo" | "unclaimed" | "activity" | "stars" | "starsPrevious"> & {
  listedAt: string;
  starsAt: string | null;
  starsPreviousAt: string | null;
  health?: { down: boolean };
};
export type SavedAccountItem = SavedItem & { savedAt: string; tried: boolean };
export type SavedPage = {
  items: SavedAccountItem[];
  /** 거르기 알약 수 — 고른 분야 안에서 */
  counts: { all: number; untried: number };
  /** 분야 알약 수 — 고른 거르기 안에서 */
  categories: { key: string; count: number }[];
  /** 지금 조건의 전체 수 */
  total: number;
  nextCursor: string | null;
};
export type SavedQuery = { sort: SavedSort; filter: SavedFilter; category: string | null; cursor: string | null };

/**
 * 공개 목록과 같은 공개 조건 — 검증·시드 제품이고 기본 목록에 싣는 것(개인 프로필은 주인이 있을 때만, visibility.ts).
 * 내리거나(banned) 검증 전인 제품은 목록에서 빠진다. 응답 없음(notDown)은 빼지 않고 카드에 밝힌다(시안 '접속 안 됨').
 */
const savedPublic = and(inArray(products.status, ["verified", "seeded"]), listedByDefault)!;

const cardColumns = Object.fromEntries(Object.keys(LIST_COLUMNS).map((key) => [key, products[key as keyof typeof LIST_COLUMNS]])) as
  { [K in keyof typeof LIST_COLUMNS]: (typeof products)[K] };
const cardSelect = { ...cardColumns, repoGone: sql<boolean>`${repoGone}`, taglineKo };

const triedBy = (userId: number) =>
  sql<boolean>`exists (select 1 from ${productReactions} r where r.product_id = ${products.id} and r.user_id = ${userId})`;

/** 공개 업데이트와 저장소 푸시 중 늦은 쪽 — 카드의 '최근 업데이트'(ProductActivityRow)와 같은 뜻 */
const activityAt = sql`greatest((select max(coalesce(u.published_at, u.observed_at)) from ${productUpdates} u
  where u.slug = ${products.slug} and u.visible and u.maker_deleted_at is null
    and coalesce(u.published_at, u.observed_at) <= now() at time zone 'utc'), ${products.repoPushedAt})`;
const micros = (value: SQL) => sql`(extract(epoch from ${value}) * 1000000)::bigint`;
/** 정렬 열쇠는 정수(마이크로초·스타)라 커서 글자를 그대로 비교한다. 같으면 제품 id 가 큰 쪽이 먼저 */
const SORT_KEYS: Record<SavedSort, SQL> = {
  recent: micros(sql`${userSavedProducts.createdAt}`),
  stars: sql`(case when ${repoGone} then null else ${products.stars} end)::bigint`,
  activity: micros(activityAt),
};

type Cursor = { sort: SavedSort; key: string | null; id: number };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.sort, cursor.key, cursor.id])).toString("base64url");
}

export function decodeCursor(value: string, sort: SavedSort): Cursor {
  try {
    if (value.length > 120) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error();
    const [cursorSort, key, id] = parsed as unknown[];
    if (cursorSort !== sort || !(key === null || (typeof key === "string" && /^-?\d{1,18}$/.test(key)))) throw new Error();
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new Error();
    return { sort, key, id };
  } catch {
    throw new PublicAuthError(400, "invalid_cursor");
  }
}

/** 큰 것부터, 없는 값은 맨 뒤(desc nulls last) — 커서 다음 행만 */
function afterCursor(key: SQL, cursor: Cursor): SQL {
  if (cursor.key === null) return sql`(${key} is null and ${products.id} < ${cursor.id})`;
  const value = sql`${cursor.key}::bigint`;
  return sql`(${key} < ${value} or (${key} = ${value} and ${products.id} < ${cursor.id}) or ${key} is null)`;
}

/** 여기 적은 칸만 나간다 — 내부 id·클릭 지표·상태는 내보내지 않는다 */
function toSavedItem(item: ProductListItem): SavedItem {
  const iso = (value: Date | string | null | undefined) => value instanceof Date ? value.toISOString() : value ?? null;
  return {
    slug: item.slug, name: item.name, tagline: item.tagline, taglineSource: item.taglineSource, taglineKo: item.taglineKo ?? null,
    translation: item.translation, category: item.category, accessMode: item.accessMode, aiLevel: item.aiLevel ?? null,
    builder: item.builder, builderClaim: item.builderClaim, ogImage: item.ogImage, makerName: item.makerName, repoUrl: item.repoUrl,
    repoRenamedTo: item.repoRenamedTo ?? null, unclaimed: item.unclaimed, activity: item.activity,
    stars: item.stars ?? null, starsPrevious: item.starsPrevious ?? null, starsAt: iso(item.starsAt), starsPreviousAt: iso(item.starsPreviousAt),
    listedAt: iso(item.listedAt) ?? "",
    ...(item.health ? { health: { down: item.health.down } } : {}),
  };
}

/** 행 → 공개 카드(생존·활동·번역까지). 번역 열쇠(id)는 붙인 뒤 뺀다 */
async function cardsFor(rows: ProductListRow[], locale: Locale): Promise<SavedItem[]> {
  const items = await localizeProductList(await withProductHealth(rows.map(toListItem)), locale);
  return items.map(toSavedItem);
}

export async function listSaved(userId: number, query: SavedQuery, locale: Locale): Promise<SavedPage> {
  const cursor = query.cursor ? decodeCursor(query.cursor, query.sort) : null;
  const key = SORT_KEYS[query.sort];
  const tried = triedBy(userId);
  const mine = and(eq(userSavedProducts.userId, userId), savedPublic);
  const inCategory = query.category ? eq(products.category, query.category) : undefined;
  const untriedOnly = query.filter === "untried" ? sql`not ${tried}` : undefined;
  const [rows, [counts], categories] = await Promise.all([
    db.select({ ...cardSelect, savedAt: userSavedProducts.createdAt, tried, sortKey: sql<string | null>`${key}::text` })
      .from(userSavedProducts).innerJoin(products, eq(products.id, userSavedProducts.productId))
      .where(and(mine, inCategory, untriedOnly, cursor ? afterCursor(key, cursor) : undefined))
      .orderBy(sql`${key} desc nulls last`, desc(products.id))
      .limit(SAVED_PAGE_SIZE + 1),
    db.select({ all: sql<number>`count(*)::int`, untried: sql<number>`(count(*) filter (where not ${tried}))::int` })
      .from(userSavedProducts).innerJoin(products, eq(products.id, userSavedProducts.productId)).where(and(mine, inCategory)),
    db.select({ key: products.category, count: sql<number>`count(*)::int` })
      .from(userSavedProducts).innerJoin(products, eq(products.id, userSavedProducts.productId))
      .where(and(mine, untriedOnly)).groupBy(products.category).orderBy(sql`count(*) desc`, products.category),
  ]);
  const page = rows.slice(0, SAVED_PAGE_SIZE);
  const cards = await cardsFor(page, locale);
  const last = rows.length > SAVED_PAGE_SIZE ? page.at(-1)! : null;
  return {
    items: cards.map((card, index) => ({ ...card, savedAt: page[index].savedAt.toISOString(), tried: page[index].tried })),
    counts: { all: counts?.all ?? 0, untried: counts?.untried ?? 0 },
    categories,
    total: query.filter === "untried" ? counts?.untried ?? 0 : counts?.all ?? 0,
    nextCursor: last ? encodeCursor({ sort: query.sort, key: last.sortKey, id: last.id }) : null,
  };
}

/** 이 계정의 공개 저장 주소 전부(최근 저장 먼저) — 브라우저가 제 목록과 맞춰 본다 */
export async function savedSlugs(userId: number): Promise<string[]> {
  const rows = await db.select({ slug: products.slug }).from(userSavedProducts)
    .innerJoin(products, eq(products.id, userSavedProducts.productId))
    .where(and(eq(userSavedProducts.userId, userId), savedPublic))
    .orderBy(desc(userSavedProducts.createdAt), desc(products.id))
    .limit(SAVED_LIMIT * 2);
  return rows.map((row) => row.slug);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 같은 사용자의 저장 쓰기를 한 줄로 세운다 — 세고 넣는 사이에 다른 기기가 끼지 않게 */
async function lockUser(tx: Tx, userId: number): Promise<void> {
  const [row] = await tx.select({ id: publicUsers.id }).from(publicUsers).where(eq(publicUsers.id, userId)).for("update");
  if (!row) throw new PublicAuthError(401, "login_required");
}

async function savedCount(tx: Tx, userId: number): Promise<number> {
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(userSavedProducts).where(eq(userSavedProducts.userId, userId));
  return row?.count ?? 0;
}

/** 저장 — 이미 있으면 그대로(멱등). 상한은 숨은 제품의 행까지 센다 */
export async function putSaved(userId: number, slug: string): Promise<{ saved: true; total: number }> {
  return db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const [product] = await tx.select({ id: products.id }).from(products).where(and(eq(products.slug, slug), savedPublic)).limit(1);
    if (!product) throw new PublicAuthError(404, "product_not_found");
    const total = await savedCount(tx, userId);
    const [existing] = await tx.select({ productId: userSavedProducts.productId }).from(userSavedProducts)
      .where(and(eq(userSavedProducts.userId, userId), eq(userSavedProducts.productId, product.id))).limit(1);
    if (existing) return { saved: true as const, total };
    if (total >= SAVED_LIMIT) throw new PublicAuthError(409, "saved_limit");
    await tx.insert(userSavedProducts).values({ userId, productId: product.id, source: "web" }).onConflictDoNothing();
    return { saved: true as const, total: total + 1 };
  });
}

/** 빼기 — 없거나 이미 내려간 제품이어도 그대로 성공(멱등) */
export async function deleteSaved(userId: number, slug: string): Promise<{ saved: false; total: number }> {
  return db.transaction(async (tx) => {
    await tx.delete(userSavedProducts).where(and(eq(userSavedProducts.userId, userId),
      inArray(userSavedProducts.productId, tx.select({ id: products.id }).from(products).where(eq(products.slug, slug)))));
    return { saved: false as const, total: await savedCount(tx, userId) };
  });
}

/**
 * 첫 로그인 합치기(L4) — 이 브라우저 목록 중 계정에 없는 공개 제품만 source='merge' 로 넣는다(합집합).
 * 모르는·공개되지 않은 주소와 상한을 넘는 것은 건너뛴다. 넘칠 때는 목록 뒤쪽(나중에 저장한 것)을 남긴다.
 * 두 번 보내도 한 번만 들어간다.
 */
export async function mergeSaved(userId: number, slugs: readonly string[]): Promise<{ merged: number; skipped: number; total: number }> {
  const unique = [...new Set(slugs)];
  return db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const found = unique.length
      ? await tx.select({ id: products.id, slug: products.slug }).from(products).where(and(inArray(products.slug, unique), savedPublic))
      : [];
    const ids = new Map(found.map((row) => [row.slug, row.id]));
    const existing = new Set((await tx.select({ productId: userSavedProducts.productId }).from(userSavedProducts)
      .where(eq(userSavedProducts.userId, userId))).map((row) => row.productId));
    const already = unique.filter((slug) => existing.has(ids.get(slug) ?? 0)).length;
    const fresh = unique.map((slug) => ids.get(slug)).filter((id): id is number => id !== undefined && !existing.has(id));
    const room = Math.max(0, SAVED_LIMIT - existing.size);
    const take = fresh.slice(Math.max(0, fresh.length - room));
    // 브라우저 목록 순서(오래된 것 먼저)를 저장한 순으로 남긴다 — 1ms 씩 앞당긴다
    const inserted = take.length ? await tx.insert(userSavedProducts)
      .values(take.map((productId, index) => ({ userId, productId, source: "merge" as const,
        createdAt: sql`now() - make_interval(secs => ${(take.length - 1 - index) / 1000})` })))
      .onConflictDoNothing().returning({ productId: userSavedProducts.productId }) : [];
    return { merged: inserted.length, skipped: unique.length - already - inserted.length, total: existing.size + inserted.length };
  });
}

/** 로그아웃 목록의 카드 — 이 브라우저가 가진 주소 중 공개 제품만, 받은 순서대로 */
export async function savedSummaries(slugs: readonly string[]): Promise<ProductListItem[]> {
  if (!slugs.length) return [];
  const rows = await db.select(cardSelect).from(products).where(and(inArray(products.slug, [...slugs]), savedPublic)).limit(slugs.length);
  const position = new Map(slugs.map((slug, index) => [slug, index]));
  return withProductHealth(rows.sort((a, b) => position.get(a.slug)! - position.get(b.slug)!).map(toListItem));
}

export async function localizeSummaries(items: ProductListItem[], locale: Locale): Promise<SavedItem[]> {
  return (await localizeProductList(items, locale)).map(toSavedItem);
}

/** 정해진 크기까지만 읽는 JSON 본문 — readLoginJson(2KB)보다 큰 합치기·카드 요청용 */
export async function readSavedJson(request: Request, limit: number): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new PublicAuthError(415, "json_required");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) throw new PublicAuthError(413, "request_too_large");
  if (!request.body) throw new PublicAuthError(400, "invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new PublicAuthError(413, "request_too_large");
      }
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PublicAuthError) throw error;
    throw new PublicAuthError(400, "invalid_request");
  } finally {
    reader.releaseLock();
  }
}

/** 주소 목록 칸 — 문자열 배열, 각 주소는 제품 slug 꼴, 개수 상한 */
export function readSlugList(body: Record<string, unknown>, limit: number): string[] {
  const slugs = body.slugs;
  if (!Array.isArray(slugs) || slugs.length > limit || !slugs.every(isProductSlug)) throw new PublicAuthError(400, "invalid_slugs");
  return slugs;
}

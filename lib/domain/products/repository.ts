import { and, eq, ilike, inArray, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  products,
  ogImages,
  clickEvents,
  productClickDaily,
  productHealth,
  takedownRequests,
  type Product,
  type NewProduct,
  type ProductStatus,
} from "@/lib/db/schema";
import { slugifyName } from "@/lib/net/normalize";
import type { Category } from "./schema";
import { METRICS_WINDOW_DAYS } from "./clicks";

/** 제품 데이터 접근 — 도메인 바깥에서 DB를 직접 만지지 않도록 여기로 모은다 */

export async function findBySlug(slug: string): Promise<Product | undefined> {
  return db.query.products.findFirst({ where: eq(products.slug, slug) });
}

export async function findByUrl(url: string): Promise<Product | undefined> {
  return db.query.products.findFirst({ where: eq(products.url, url) });
}

/**
 * 정렬 기준. 지금은 최신 검증순 하나뿐이지만, 랭킹(NMR 점수·CTR)이 붙으면
 * 이 유니온에 값을 추가하고 아래 map에 한 줄만 넣으면 된다 — 호출부는 그대로다.
 */
export type ProductSort = "recent" | "popular";

export type ListOptions = {
  statuses: ProductStatus[];
  sort?: ProductSort;
  limit: number;
  /** 카테고리 하나로 좁힌다 */
  category?: Category;
  /** 이름·소개에서 찾는다 */
  query?: string;
};

/**
 * 검색어의 와일드카드를 죽인다.
 *
 * 값은 파라미터로 나가므로 주입은 아니지만, %나 _를 그대로 두면 사용자가 친 글자가
 * 패턴 기호로 동작해 엉뚱한 것이 걸린다.
 */
function likePattern(query: string): string {
  return `%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * 등재 시각 — 검증된 제품은 검증 시점, 우리가 대신 올린 제품은 등록 시점.
 * verified_at만으로 정렬하면 seeded(null)가 목록 맨 위를 차지한다.
 */
const listedAt = sql`coalesce(${products.verifiedAt}, ${products.createdAt})`;

/**
 * 최근 창의 클릭 합.
 *
 * 서브쿼리로 두면 findMany의 정렬만 바꿔 끼울 수 있다 — 목록 조회 경로를 갈아엎지 않아도 된다.
 * 클릭이 없는 제품도 목록에서 사라지면 안 되므로 coalesce로 0을 준다.
 */
const recentClicks = sql`(
  select coalesce(count(*), 0) from click_events c
  where c.slug = ${products.slug}
    and c.occurred_at >= now() - ${sql.raw(`interval '${METRICS_WINDOW_DAYS} days'`)}
)`;

const SORTS = {
  /**
   * 검증된 제품을 먼저, 그 안에서 최신순.
   *
   * 수집기가 붙으면 미클레임 제품이 수천 개가 된다. 날짜만으로 섞으면
   * 실제로 확인된 소수의 제품이 그 아래 묻힌다.
   */
  recent: [sql`(${products.status} = 'verified') desc`, sql`${listedAt} desc`],

  /**
   * 많이 눌린 순.
   *
   * 여기서는 검증 여부를 먼저 보지 않는다. 그렇게 하면 클릭 0인 검증 제품이 클릭 5인
   * 제품 위에 올라 "많이 눌린 순"이라는 이름이 거짓말이 된다 — 실제로 그렇게 나왔다.
   * 대신 이 정렬은 랭킹 대상(검증된 제품)에만 쓴다. 순서의 이름과 내용이 맞아야 한다.
   */
  popular: [sql`${recentClicks} desc`, sql`${listedAt} desc`],
} as const;

/** 정렬 파라미터 검증용 (쿼리스트링 → ProductSort) */
export const SORT_KEYS = Object.keys(SORTS) as ProductSort[];

export async function listProducts({
  statuses,
  sort = "recent",
  limit,
  category,
  query,
}: ListOptions): Promise<Product[]> {
  const conditions = [inArray(products.status, statuses)];
  if (category) conditions.push(eq(products.category, category));
  if (query?.trim()) {
    const pattern = likePattern(query);
    conditions.push(or(ilike(products.name, pattern), ilike(products.tagline, pattern))!);
  }

  return db.query.products.findMany({
    where: and(...conditions),
    orderBy: [...SORTS[sort]],
    limit,
  });
}

/** 카테고리별 개수 — 필터 칩이 숫자를 함께 보여준다 */
export async function categoryCounts(statuses: ProductStatus[]): Promise<Record<string, number>> {
  const rows = await db
    .select({ category: products.category, count: sql<number>`count(*)::int` })
    .from(products)
    .where(inArray(products.status, statuses))
    .groupBy(products.category);
  return Object.fromEntries(rows.map((r) => [r.category, r.count]));
}

/** base 계열 slug를 한 번에 조회해 메모리에서 빈 자리를 찾는다 (후보마다 왕복하지 않음) */
export async function nextAvailableSlug(name: string): Promise<string> {
  const base = slugifyName(name);
  const taken = new Set(
    (
      await db
        .select({ slug: products.slug })
        .from(products)
        .where(or(eq(products.slug, base), like(products.slug, `${base}-%`)))
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function insert(values: NewProduct): Promise<void> {
  await db.insert(products).values(values);
}

export async function update(id: number, values: Partial<Product>): Promise<void> {
  await db.update(products).set({ ...values, updatedAt: new Date() }).where(eq(products.id, id));
}

/**
 * 제품에 딸린 기록.
 *
 * FK를 걸지 않았고 nextAvailableSlug가 비어 있는 slug를 다시 쓰므로, 지우지 않으면 같은
 * 이름으로 새로 들어온 제품이 지워진 제품의 클릭·생존 이력·내려달라 요청을 물려받는다.
 */
export async function removeTraces(slug: string): Promise<void> {
  await Promise.all([
    db.delete(clickEvents).where(eq(clickEvents.slug, slug)),
    db.delete(productClickDaily).where(eq(productClickDaily.slug, slug)),
    db.delete(productHealth).where(eq(productHealth.slug, slug)),
    db.delete(takedownRequests).where(eq(takedownRequests.slug, slug)),
  ]);
}

export async function remove(id: number): Promise<void> {
  await db.delete(products).where(eq(products.id, id));
}

export async function setOgImage(slug: string, path: string): Promise<void> {
  await db.update(products).set({ ogImage: path }).where(eq(products.slug, slug));
}

export async function putOgImage(slug: string, contentType: string, data: Buffer): Promise<void> {
  await db
    .insert(ogImages)
    .values({ slug, contentType, data })
    .onConflictDoUpdate({ target: ogImages.slug, set: { contentType, data } });
}

export async function getOgImage(slug: string): Promise<{ data: Buffer; contentType: string } | null> {
  const row = await db.query.ogImages.findFirst({ where: eq(ogImages.slug, slug) });
  return row ? { data: Buffer.from(row.data), contentType: row.contentType } : null;
}

export async function deleteOgImage(slug: string): Promise<void> {
  await db.delete(ogImages).where(eq(ogImages.slug, slug));
}

/**
 * unique 위반 제약명 추출.
 * drizzle은 드라이버 에러를 DrizzleQueryError로 감싸 원본을 cause에 넣으므로 체인을 따라간다.
 */
export function uniqueViolation(e: unknown): string | null {
  let current: unknown = e;
  for (let depth = 0; current && depth < 5; depth++) {
    const err = current as { code?: string; constraint_name?: string; cause?: unknown };
    if (err.code === "23505") return err.constraint_name ?? "";
    current = err.cause;
  }
  return null;
}

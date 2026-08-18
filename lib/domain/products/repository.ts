import { eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, ogImages, type Product, type NewProduct, type ProductStatus } from "@/lib/db/schema";
import { slugifyName } from "@/lib/net/normalize";

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
};

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
  where c.slug = ${products.slug} and c.occurred_at >= now() - interval '7 days'
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
   * 많이 눌린 순. 동률이 많으므로 최신순을 뒤에 둔다 — 클릭이 0인 제품끼리는 최신순이 된다.
   * 검증 여부를 먼저 보는 것은 recent와 같다: 확인된 제품이 위에 온다.
   */
  popular: [
    sql`(${products.status} = 'verified') desc`,
    sql`${recentClicks} desc`,
    sql`${listedAt} desc`,
  ],
} as const;

/** 정렬 파라미터 검증용 (쿼리스트링 → ProductSort) */
export const SORT_KEYS = Object.keys(SORTS) as ProductSort[];

export async function listProducts({ statuses, sort = "recent", limit }: ListOptions): Promise<Product[]> {
  return db.query.products.findMany({
    where: inArray(products.status, statuses),
    orderBy: [...SORTS[sort]],
    limit,
  });
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

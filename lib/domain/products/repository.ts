import { syncRepositoryLink } from "@/lib/domain/evidence/repository-link-sync";
import { and, eq, ilike, inArray, isNotNull, like, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { lockProductGeneration, type ProductTransaction } from "./generation";
import { DOWN_THRESHOLD } from "./health";
import {
  products,
  crawlCandidates,
  ogImages,
  clickEvents,
  productClickDaily,
  productHealth,
  productHealthDaily,
  rankingEntries,
  takedownRequests,
  mediaAssets,
  productAgents,
  productEvidenceAudit,
  productEvidenceSources,
  productLinks,
  productMedia,
  productMediaDeclarations,
  productProfiles,
  productRefreshRequests,
  productSkills,
  productUpdates,
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
  /** 제작자가 등록한 도구 이름 */
  builder?: string;
  /** 저장소 URL이 등록된 제품만. 공개 여부나 라이선스를 뜻하지 않는다. */
  hasRepository?: boolean;
  /** 건너뛸 개수. 목록이 상한에서 조용히 잘리지 않으려면 뒤를 볼 수 있어야 한다 */
  offset?: number;
  /** 연속 실패로 닿지 않는 제품을 뺀다. 공개 목록만 켠다 — 어드민은 그것을 봐야 처리한다 */
  excludeDown?: boolean;
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
const builderIsReported = or(ne(products.source, "crawler"), isNotNull(products.claimedAt))!;

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

/**
 * 닿지 않는 제품을 뺀다.
 *
 * 6시간마다 확인하므로 DOWN_THRESHOLD(3)회 연속 실패는 하루 가까이 계속 안 열렸다는 뜻이다.
 * 그 정도면 잠깐 흔들린 것이 아니다. 행은 그대로 두고 조건으로만 가리므로, 다시 열리면
 * 실패 횟수가 0으로 돌아가면서 목록에도 그대로 돌아온다 — 사람이 되돌릴 일이 없다.
 *
 * 공개 랭킹(ranking/view.ts)도 이것을 그대로 쓴다. 조건을 두 벌 두면 한쪽만 고쳐져 목록에서
 * 빠진 제품이 순위에는 남는다. products 테이블을 별칭 없이 조인한 쿼리에서만 쓸 수 있다.
 */
export const notDown = sql`not exists (
  select 1 from product_health h
  where h.slug = ${products.slug} and h.failures >= ${DOWN_THRESHOLD}
)`;

/** 목록과 개수가 같은 조건을 쓰도록 한 곳에서 만든다 */
function listConditions({ statuses, category, query, builder, hasRepository, excludeDown }: Omit<ListOptions, "limit" | "sort" | "offset">) {
  const conditions = [inArray(products.status, statuses)];
  if (excludeDown) conditions.push(notDown);
  if (category) conditions.push(eq(products.category, category));
  if (builder) conditions.push(and(eq(products.builder, builder), builderIsReported)!);
  if (hasRepository) {
    conditions.push(isNotNull(products.repoUrl));
    conditions.push(sql`btrim(${products.repoUrl}) <> ''`);
  }
  if (query?.trim()) {
    const pattern = likePattern(query);
    conditions.push(or(
      ilike(products.name, pattern),
      ilike(products.tagline, pattern),
      and(builderIsReported, ilike(products.builder, pattern)),
    )!);
  }
  return conditions;
}

export async function listProducts({ sort = "recent", limit, offset, ...options }: ListOptions): Promise<Product[]> {
  const conditions = listConditions(options);
  return db.query.products.findMany({
    where: and(...conditions),
    orderBy: [...SORTS[sort]],
    limit,
    offset,
  });
}

/**
 * 같은 조건의 전체 개수.
 *
 * 목록만 주면 "상한에 걸린 것"과 "그게 전부인 것"을 구분할 수 없다. 실제로 제품이
 * 2,986개인데 100개만 보이고 나머지로 갈 길이 없었다.
 */
export async function countProducts(options: Omit<ListOptions, "limit" | "sort" | "offset">): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` })
    .from(products).where(and(...listConditions(options)));
  return row?.count ?? 0;
}

/** 발견 보드 — 검증 상태보다 실제 등재 시각을 우선해 시드 제품도 노출한다. */
export async function listRecentlyDiscovered(limit: number): Promise<Product[]> {
  return db.query.products.findMany({
    where: and(inArray(products.status, ["verified", "seeded"]), notDown),
    orderBy: [sql`${listedAt} desc`, products.slug],
    limit,
  });
}

/**
 * sitemap이 쓰는 것만 — 검증된 제품의 주소와 갱신 시각.
 *
 * 상한이 50,000건이라 전체 컬럼(description·stack·og_image…)을 읽으면 쓰지도 않을 바이트를
 * 그만큼 실어 나른다. 정렬은 listProducts의 recent와 같다 — 검증된 것만 담으므로 그 정렬의
 * 첫 키(검증 여부)가 상수가 되어 등재 시각순만 남는다.
 */
export async function listVerifiedSlugs(limit: number): Promise<{ slug: string; updatedAt: Date }[]> {
  return db
    .select({ slug: products.slug, updatedAt: products.updatedAt })
    .from(products)
    .where(eq(products.status, "verified"))
    .orderBy(sql`${listedAt} desc`)
    .limit(limit);
}

/** 필터 셀렉트에 올릴 제작 도구 이름 */
export async function listBuilders(statuses: ProductStatus[]): Promise<string[]> {
  const rows = await db
    .select({ builder: products.builder, count: sql<number>`count(*)::int` })
    .from(products)
    .where(and(
      inArray(products.status, statuses),
      builderIsReported,
      isNotNull(products.builder),
      sql`btrim(${products.builder}) <> ''`,
    ))
    .groupBy(products.builder)
    .orderBy(sql`count(*) desc`, products.builder);
  return rows.map((row) => row.builder).filter((name): name is string => Boolean(name));
}

/**
 * 카테고리별 개수 — 필터 칩이 숫자를 함께 보여준다.
 *
 * 목록과 같은 조건을 쓴다. 갈라지면 "3개"라고 적힌 칩을 눌렀는데 아무것도 안 나온다.
 */
export async function categoryCounts(
  options: Omit<ListOptions, "limit" | "sort" | "offset">,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ category: products.category, count: sql<number>`count(*)::int` })
    .from(products)
    .where(and(...listConditions(options)))
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

export async function insert(values: NewProduct, beforeInsert?: (tx: ProductTransaction) => Promise<void>): Promise<void> {
  await db.transaction(async (tx) => {
    await beforeInsert?.(tx);
    const [product] = await tx.insert(products).values(values).returning();
    await syncRepositoryLink({ productId: product.id, slug: product.slug, repoUrl: product.repoUrl,
      declarationSource: product.source === "crawler" ? "discovered" : "maker", mode: "explicit" }, tx);
  });
}

export async function update(id: number, values: Partial<Product>): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx.select({ slug: products.slug }).from(products).where(eq(products.id, id));
    if (!current || !(await lockProductGeneration(tx, id, current.slug))) return;
    const [product] = await tx.update(products).set({ ...values, updatedAt: new Date() }).where(eq(products.id, id)).returning();
    if (values.repoUrl !== undefined) await syncRepositoryLink({ productId: product.id, slug: product.slug,
      repoUrl: product.repoUrl, declarationSource: "maker", mode: "explicit" }, tx);
  });
}

/**
 * 도메인 검증 결과를 verified로 기록한다. 기록했으면 true.
 *
 * 검증은 외부 페이지를 읽느라 수 초가 걸린다. 시작할 때 읽은 상태만 믿고 덮어쓰면 그 사이
 * 내려진 어드민 차단이 verified로 뒤집혀 공개 목록에 돌아왔다. 차단과 같은 세대 잠금 안에서
 * 조건으로 다시 확인해 차단이 우선하게 한다. 검증 토큰도 조건에 건다 — 도메인이 증명한 것은
 * 그 토큰이지 이 행이 아니다.
 */
export async function markVerified(
  id: number,
  slug: string,
  verifyToken: string,
  values: Partial<Product>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockProductGeneration(tx, id, slug))) return false;
    const updated = await tx.update(products)
      .set({ ...values, status: "verified", updatedAt: new Date() })
      .where(and(
        eq(products.id, id),
        eq(products.slug, slug),
        ne(products.status, "banned"),
        eq(products.verifyToken, verifyToken),
      ))
      .returning({ id: products.id });
    return updated.length === 1;
  });
}

/**
 * 제품에 딸린 기록.
 *
 * FK를 걸지 않았고 nextAvailableSlug가 비어 있는 slug를 다시 쓰므로, 지우지 않으면 같은
 * 이름으로 새로 들어온 제품이 지워진 제품의 클릭·생존 이력·내려달라 요청을 물려받는다.
 */
export async function removeTraces(slug: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(clickEvents).where(eq(clickEvents.slug, slug));
    await tx.delete(productClickDaily).where(eq(productClickDaily.slug, slug));
    await tx.delete(productHealth).where(eq(productHealth.slug, slug));
    await tx.delete(productHealthDaily).where(eq(productHealthDaily.slug, slug));
    await tx.delete(rankingEntries).where(eq(rankingEntries.slug, slug));
    await tx.delete(takedownRequests).where(eq(takedownRequests.slug, slug));
  });
}

export async function remove(id: number): Promise<void> {
  await db.delete(products).where(eq(products.id, id));
}

/**
 * 메이커가 승인한 완전 삭제.
 *
 * slug는 재사용될 수 있으므로 제품 소유 데이터와 집계 흔적을 제품 행과 같은 트랜잭션에서
 * 없앤다. 미디어는 관측 경로와 같은 잠금 순서(product → asset)를 사용하고, 다른 제품이
 * 참조하지 않는 바이트만 제거한다.
 */
export async function removeProductAndEvidence(id: number, slug: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockProductGeneration(tx, id, slug))) return false;
    const [current] = await tx.select({ status: products.status })
      .from(products)
      .where(and(eq(products.id, id), eq(products.slug, slug)));
    // 메이커 삭제 승인 뒤 어드민 차단이 먼저 직렬화되면 차단과 증거 보존이 우선한다.
    if (current?.status === "banned") return false;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`product-media:${slug}`}))`);
    const media = await tx.select({ hash: productMedia.assetHash })
      .from(productMedia)
      .where(eq(productMedia.slug, slug));
    const hashes = [...new Set(media.map((row) => row.hash))].sort();
    for (const hash of hashes) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`media-asset:${hash}`}))`);
    }

    await tx.delete(productRefreshRequests).where(eq(productRefreshRequests.productId, id));
    await tx.delete(productProfiles).where(eq(productProfiles.slug, slug));
    await tx.delete(productLinks).where(eq(productLinks.slug, slug));
    await tx.delete(productEvidenceSources).where(eq(productEvidenceSources.slug, slug));
    await tx.delete(productMediaDeclarations).where(eq(productMediaDeclarations.slug, slug));
    await tx.delete(productMedia).where(eq(productMedia.slug, slug));
    await tx.delete(productUpdates).where(eq(productUpdates.slug, slug));
    await tx.delete(productAgents).where(eq(productAgents.slug, slug));
    await tx.delete(productSkills).where(eq(productSkills.slug, slug));
    await tx.delete(productEvidenceAudit).where(eq(productEvidenceAudit.slug, slug));
    await tx.delete(ogImages).where(eq(ogImages.slug, slug));
    await tx.delete(clickEvents).where(eq(clickEvents.slug, slug));
    await tx.delete(productClickDaily).where(eq(productClickDaily.slug, slug));
    await tx.delete(productHealth).where(eq(productHealth.slug, slug));
    await tx.delete(productHealthDaily).where(eq(productHealthDaily.slug, slug));
    await tx.delete(rankingEntries).where(eq(rankingEntries.slug, slug));
    await tx.delete(takedownRequests).where(eq(takedownRequests.slug, slug));
    /**
     * 수집 원본과의 연결도 slug 문자열이라 같이 푼다.
     *
     * 남겨 두면 같은 slug를 얻은 새 제품이 지워진 제품의 레포·문서를 물려받아, 재검수가 남의
     * 원본으로 판정하고 생존 확인이 새 본문으로 남의 문서를 덮는다. 후보 행과 발행 상태는
     * 남긴다 — 주인이 지운 것을 수집기가 다시 올리지 않게 하는 기록이다.
     */
    await tx.update(crawlCandidates)
      .set({ publishedSlug: null, updatedAt: new Date() })
      .where(eq(crawlCandidates.publishedSlug, slug));
    await tx.delete(products).where(and(eq(products.id, id), eq(products.slug, slug)));

    for (const hash of hashes) {
      await tx.delete(mediaAssets).where(and(
        eq(mediaAssets.hash, hash),
        sql`not exists (
          select 1 from ${productMedia}
          where ${productMedia.assetHash} = ${hash}
        )`,
      ));
    }
    return true;
  });
}

export async function setStatusWithAudit(input: {
  id: number;
  slug: string;
  status: ProductStatus;
  action: "admin.product.ban" | "admin.product.unban";
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockProductGeneration(tx, input.id, input.slug))) return false;
    const [current] = await tx.select({ status: products.status })
      .from(products)
      .where(and(eq(products.id, input.id), eq(products.slug, input.slug)));
    // 같은 전환이 잠금을 기다린 경우 이미 원하는 상태면 성공으로 끝내되 감사를 중복하지 않는다.
    if (current?.status === input.status) return true;
    const updated = await tx.update(products)
      .set({ status: input.status, updatedAt: new Date() })
      .where(and(eq(products.id, input.id), eq(products.slug, input.slug)))
      .returning({ id: products.id });
    if (updated.length !== 1) return false;
    await tx.insert(productEvidenceAudit).values({
      slug: input.slug,
      actor: "admin",
      action: input.action,
      metadata: { status: input.status },
    });
    return true;
  });
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

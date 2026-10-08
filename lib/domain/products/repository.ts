import { hasSearchQuery, productSearchPredicate, productSearchRank, type SearchQuery } from './search';
import { syncRepositoryLink } from "@/lib/domain/evidence/repository-link-sync";
import { and, desc, eq, inArray, isNotNull, like, ne, notInArray, or, sql } from "drizzle-orm";
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
  productEmbeddings,
  type Product,
  type NewProduct,
  type ProductStatus,
} from "@/lib/db/schema";
import { slugifyName } from "@/lib/net/normalize";
import type { Category } from "./schema";
import { METRICS_WINDOW_DAYS } from "./clicks";
import { lockProductRepository } from "./repository-identity";
import { observedToolPredicate } from "./observed-tool";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { EMBEDDING_DOCUMENT, EMBEDDING_MODEL, vectorLiteral } from "./embedding";
import { createMemo } from "@/lib/cache/memo";
import { getSettings as getCrawlSettings } from "@/lib/crawl/settings";
export { findRepositoryProduct } from "./repository-identity";

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
export type ProductSort = "relevance" | "recent" | "popular" | "rising" | "stars";

export type ListOptions = {
  statuses: ProductStatus[];
  sort?: ProductSort;
  limit: number;
  /** 카테고리 하나로 좁힌다 */
  category?: Category;
  /** 이름·토픽·소개·본문에서 찾는다 (search.ts) */
  query?: SearchQuery;
  /** 제작자가 등록한 도구 이름 */
  builder?: string;
  /** 저장소의 마지막 완료·부분 조사에서 찾은 도구 */
  observedTool?: string;
  /** 저장소 URL이 등록된 제품만. 공개 여부나 라이선스를 뜻하지 않는다. */
  hasRepository?: boolean;
  /** 건너뛸 개수. 목록이 상한에서 조용히 잘리지 않으려면 뒤를 볼 수 있어야 한다 */
  offset?: number;
  /** 연속 실패로 닿지 않는 제품을 뺀다. 공개 목록만 켠다 — 어드민은 그것을 봐야 처리한다 */
  excludeDown?: boolean;
  /** 소개 검수가 근거로는 무엇인지 알 수 없다고 한 제품만(intro-checks.ts) — 어드민이 본다 */
  introNeedsEditor?: boolean;
  /** 마지막 두 번 확인한 사이에 GitHub 스타가 는 제품만, 스타 RISING_MAX_STARS 미만·마지막 확인 risingFreshDays() 안 — 홈 '추천'의 대체 목록 */
  rising?: boolean;
  /** 이 시각 이후에 등재된 것만(listedAt) — 홈 '이번 주 새로 나온' */
  listedSince?: Date;
  /** GitHub 스타가 이만큼 이상인 것만 */
  minStars?: number;
  /** 이 제품들만 — 관련도순 검색이 이미 줄 세운 주소의 행을 받을 때(hybrid-search.ts) */
  slugs?: readonly string[];
  /** 이 제품들은 빼고 — 관련도순 검색의 앞쪽에 이미 나온 것 */
  excludeSlugs?: readonly string[];
};

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

/**
 * 마지막 두 번 확인한 사이에 늘어난 스타 — 카드의 StarMetric 이 보여주는 수와 같은 식(star-change.ts).
 * 이전 확인이 없거나 순서가 뒤집힌 행은 셀 수 없다(null).
 */
const starGain = sql`case when ${products.starsPreviousAt} < ${products.starsAt} then ${products.stars} - ${products.starsPrevious} end`;
/**
 * 하루 평균으로 늘어난 스타 — 두 확인 사이 간격이 제품마다 1~5일로 달라(2026-10-08 운영) 합계로 줄 세우면
 * 오래 기다린 제품이 앞선다. 간격은 갱신 잡이 24시간 뒤에야 다시 보므로 하루 아래로 내려가지 않지만, 혹시 짧아도
 * 하루로 쳐서 몇 시간 사이의 몇 개가 하루치로 부풀지 않게 한다.
 */
const starGainPerDay = sql`${starGain} / greatest(extract(epoch from (${products.starsAt} - ${products.starsPreviousAt})) / 86400, 1)`;
/** 홈의 스타 구간(popular.ts)이 2천부터 따로 보여주므로 그 아래만 */
export const RISING_MAX_STARS = 2000;
/**
 * 마지막 확인이 이보다 오래된 제품은 '지금' 뜬다고 하지 않는다.
 *
 * 갱신 잡(product-stars-refresh)은 성공한 제품을 하루가 지난 뒤 차례로 다시 본다. 2026-10-08 운영에서 확인이
 * 성공하고 있는 제품의 마지막 확인은 99.9%가 2.63일 안이었고, 새 제품 밀린 몫을 더해도 한 바퀴가 3일 남짓이다.
 * 오래된 것은 확인이 계속 실패하는 것이었다(지워진 저장소의 404 — 그 사이 증가가 영영 남아 2위에 있었다).
 * 실패는 스타·확인 시각을 그대로 두므로 따로 표시하지 않아도 이 기간이 지나면 여기서 빠진다.
 * 4일로 두면 갱신 잡이 조금만 밀려도 멀쩡한 제품이 빠져, 한 바퀴의 두 배쯤인 7일로 둔다(2026-10-08 운영자 결정).
 * 잡은 하루 11,520개(5분마다 40개)가 한도라 한 바퀴는 공개 저장소 수에 비례한다 — 한 바퀴가 7일을 넘으면
 * 그만큼이 여기서 빠진다. 그때는 이 값이 아니라 갱신 예산을 늘린다.
 *
 * 운영 값은 어드민 크롤 설정(rising.freshDays, 1~30일)에서 정한다 — 이것은 그 기본값이다(settings-schema.ts 와 같다).
 */
export const RISING_FRESH_DAYS = 7;

/**
 * 설정 한 행을 공개 읽기마다 읽지 않게 웹 프로세스 안에 60초 들고 있는다. 공개 목록은 그 위에 30초를 더 담으므로
 * 어드민에서 바꾼 값은 길어야 1분 반쯤 뒤에 보인다(Cloudflare 사본은 따로 1~2분).
 */
const risingSettings = createMemo<number>({ ttlMs: 60_000, max: 1 });
export function risingFreshDays(): Promise<number> {
  return risingSettings.get("freshDays", async () => (await getCrawlSettings()).rising.freshDays);
}

function risingStars(freshDays: number) {
  // 설정은 스키마가 정수 1~30으로 막지만, SQL 에는 다시 정수로 바꿔 매개변수로만 넘긴다
  const days = Number.isSafeInteger(freshDays) && freshDays > 0 ? freshDays : RISING_FRESH_DAYS;
  return sql`${starGain} > 0 and ${products.stars} < ${RISING_MAX_STARS}
  and ${products.starsAt} > now() - make_interval(days => ${days}::int)`;
}

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

  /**
   * 검증 제품이 모자라 방문 순위를 매길 수 없는 동안 홈 '추천'이 대신 쓰는 순서 — 마지막 두 확인 사이에
   * 하루 평균 스타가 많이 는 순. 같으면 스타 많은 순, 그다음 최신.
   */
  rising: [sql`${starGainPerDay} desc nulls last`, sql`${products.stars} desc nulls last`, sql`${listedAt} desc`],
  /** 같은 사정의 '관심 많은 순' — 스타 많은 순 */
  stars: [sql`${products.stars} desc nulls last`, sql`${listedAt} desc`],
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

/** 소개 검수가 근거로는 무엇인지 알 수 없다고 한 지금 소개(product_intro_checks) — 소개가 바뀌면 빠진다 */
const introNeedsEditor = sql`exists (
  select 1 from product_intro_checks c
  where c.product_id = ${products.id} and c.outcome = 'needs_editor' and c.checked_tagline = ${products.tagline}
)`;

/** 목록과 개수가 같은 조건을 쓰도록 한 곳에서 만든다. 급상승 기간은 설정에서 읽으므로 비동기다 */
async function listConditions({ statuses, category, query, builder, observedTool, hasRepository, excludeDown, introNeedsEditor: needsEditor, rising, listedSince, minStars, slugs, excludeSlugs }: Omit<ListOptions, "limit" | "sort" | "offset">) {
  const conditions = [inArray(products.status, statuses)];
  if (slugs) conditions.push(slugs.length ? inArray(products.slug, [...slugs]) : sql`false`);
  if (excludeSlugs?.length) conditions.push(notInArray(products.slug, [...excludeSlugs]));
  if (excludeDown) conditions.push(notDown);
  if (needsEditor) conditions.push(introNeedsEditor);
  if (rising) conditions.push(risingStars(await risingFreshDays()));
  if (listedSince) conditions.push(sql`${listedAt} >= ${listedSince.toISOString()}::timestamptz`);
  if (minStars !== undefined) conditions.push(sql`${products.stars} >= ${minStars}`);
  if (category) conditions.push(eq(products.category, category));
  if (builder) conditions.push(and(eq(products.builder, builder), builderIsReported)!);
  if (observedTool) conditions.push(observedToolPredicate(observedTool));
  if (hasRepository) {
    conditions.push(isNotNull(products.repoUrl));
    conditions.push(sql`btrim(${products.repoUrl}) <> ''`);
  }
  if (hasSearchQuery(query)) conditions.push(productSearchPredicate(query!)!);
  return conditions;
}

/**
 * 공개 목록 카드가 쓰는 열(toListItem). 모든 열을 읽으면 search_vector·README·본문·토큰 해시까지 옮겨
 * 카드 9장에 78KB 였다 — 쓰는 것은 4KB(2026-10-06 실측).
 */
export const LIST_COLUMNS = {
  slug: true, name: true, repoUrl: true, tagline: true, taglineSource: true, category: true, accessMode: true, builder: true,
  stack: true, ogImage: true, makerName: true, stars: true, starsAt: true, starsPrevious: true, starsPreviousAt: true,
  verifiedAt: true, createdAt: true, status: true, source: true, claimedAt: true,
} as const;
export type ProductListRow = Pick<Product, keyof typeof LIST_COLUMNS>;

export async function listProducts(options: ListOptions): Promise<Product[]> {
  return db.query.products.findMany(await listQuery(options));
}

/** listProducts 와 같은 목록을 카드에 쓰는 열만으로 */
export async function listProductRows(options: ListOptions): Promise<ProductListRow[]> {
  return db.query.products.findMany({ ...(await listQuery(options)), columns: LIST_COLUMNS });
}

/** listProducts 와 같은 조건·순서의 주소만 — 관련도순 검색이 낱말 검색 순서를 섞을 때 */
export async function listProductSlugs(options: ListOptions): Promise<string[]> {
  const { where, orderBy, limit, offset } = await listQuery(options);
  const rows = await db.select({ slug: products.slug }).from(products).where(where).orderBy(...orderBy).limit(limit).offset(offset ?? 0);
  return rows.map((row) => row.slug);
}

/**
 * 검색어 벡터와 가까운 제품 — 목록과 같은 거르기, 코사인 하한 이상, 가까운 순.
 *
 * 색인 없이 다 잰다(공개분 3만5천 행, halfvec). 정확하고 카테고리 같은 거르기를 그대로 건다.
 * 지금 모델로 임베딩한 것만 본다 — 모델을 바꾸는 동안 옛 벡터와 새 검색어가 섞이지 않게.
 */
export async function nearestProductSlugs(
  vector: readonly number[],
  options: Omit<ListOptions, "limit" | "sort" | "offset" | "query">,
  limit: number,
  minSimilarity: number,
): Promise<string[]> {
  const distance = sql`(${productEmbeddings.embedding} <=> ${vectorLiteral(vector)}::halfvec)`;
  const rows = await db.select({ slug: products.slug }).from(products)
    .innerJoin(productEmbeddings, and(eq(productEmbeddings.productId, products.id), eq(productEmbeddings.model, EMBEDDING_MODEL)))
    .where(and(...(await listConditions(options)), sql`${distance} <= ${1 - minSimilarity}`))
    .orderBy(distance, products.slug)
    .limit(limit);
  return rows.map((row) => row.slug);
}

/** 재정렬 모델이 읽을 제품 글 — 임베딩한 것과 같은 글(EMBEDDING_DOCUMENT) */
export async function productDocuments(slugs: readonly string[]): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const rows = await db.select({ slug: products.slug, text: EMBEDDING_DOCUMENT }).from(products).where(inArray(products.slug, [...slugs]));
  return new Map(rows.map((row) => [row.slug, row.text]));
}

async function listQuery({ sort = "recent", limit, offset, ...options }: ListOptions) {
  const conditions = await listConditions(options);
  /**
   * 관련도순은 검색어가 있을 때만 있다 — 없으면 모든 행의 점수가 0이라 정렬이 아니다.
   * 그 아래는 최신순 그대로 둔다. ts_rank 는 같은 점수가 많이 나오고(무게가 네 단계뿐),
   * 동점끼리는 "검증된 것 먼저, 그 안에서 최신"이라는 목록의 기존 약속을 지켜야 한다.
   */
  const ranked = sort === "relevance" && hasSearchQuery(options.query);
  const orderBy = [
    /**
     * 관련도가 거의 같으면(소수 둘째 자리까지 같으면) 별이 많은 것이 앞이다 — 같은 말을 하는 제품
     * 사이에서는 사람들이 더 많이 고른 쪽이 나은 답일 가능성이 높다. 관련도를 이기지는 않는다.
     */
    ...(ranked ? [desc(sql`round((${productSearchRank(options.query!)})::numeric, 2)`), sql`${products.stars} desc nulls last`] : []),
    ...SORTS[sort === "relevance" ? "recent" : sort],
    products.slug,
  ];
  return { where: and(...conditions), orderBy, limit, offset };
}

/**
 * 같은 조건의 전체 개수.
 *
 * 목록만 주면 "상한에 걸린 것"과 "그게 전부인 것"을 구분할 수 없다. 실제로 제품이
 * 2,986개인데 100개만 보이고 나머지로 갈 길이 없었다.
 */
export async function countProducts(options: Omit<ListOptions, "limit" | "sort" | "offset">): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` })
    .from(products).where(and(...(await listConditions(options))));
  return row?.count ?? 0;
}

/** 상세의 급상승 배지가 보여 주는 깊이 — ProductHero 의 RISING_BADGE_MAX 와 같다 */
const RISING_RANK_DEPTH = 20;

/**
 * 급상승 순위 — 홈 '지금 뜨는' 띠와 그 뒤를 잇는 피드에서 몇 번째인가. RISING_RANK_DEPTH 밖이거나 조건 밖이면 null.
 *
 * 홈과 같은 목록 쿼리(listQuery: 같은 조건·같은 정렬·같은 동점 처리)의 앞부분에서 자리를 찾는다. 예전에는
 * "나보다 많이 는 수 + 1"로 세어 동점이 같은 순위를 나눠 가졌고, '5위' 배지를 단 제품이 홈에서는 6번째라
 * 배지가 가리키는 띠에 없었다(2026-10-08).
 */
export async function getRisingRank(slug: string): Promise<number | null> {
  const slugs = await listProductSlugs({ statuses: ["verified", "seeded"], sort: "rising", rising: true, excludeDown: true, limit: RISING_RANK_DEPTH });
  const index = slugs.indexOf(slug);
  return index < 0 ? null : index + 1;
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
    .where(and(...(await listConditions(options))))
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
    await lockProductRepository(tx, values.repoUrl);
    await beforeInsert?.(tx);
    const [product] = await tx.insert(products).values(values).returning();
    await syncRepositoryLink({ productId: product.id, slug: product.slug, repoUrl: product.repoUrl,
      declarationSource: product.source === "crawler" ? "discovered" : "maker", mode: "explicit" }, tx);
  });
}

export async function update(id: number, values: Partial<Product>): Promise<void> {
  await db.transaction(async (tx) => {
    await lockProductRepository(tx, values.repoUrl);
    const [current] = await tx.select({ slug: products.slug }).from(products).where(eq(products.id, id));
    if (!current || !(await lockProductGeneration(tx, id, current.slug))) return;
    const [locked] = await tx.select({ repoUrl: products.repoUrl }).from(products).where(eq(products.id, id));
    const resetStats = values.repoUrl !== undefined && values.repoUrl !== locked.repoUrl
      ? { stars: null, starsAt: null, starsPrevious: null, starsPreviousAt: null, ownerType: null, starsCheckedAt: null } : {};
    // 소개를 고쳐 쓰면 그 소개는 쓴 사람의 것이다 — "AI가 요약" 표시를 뗀다
    const wroteTagline = values.tagline !== undefined && values.taglineSource === undefined ? { taglineSource: "maker" as const } : {};
    const [product] = await tx.update(products).set({ ...values, ...resetStats, ...wroteTagline, updatedAt: new Date() }).where(eq(products.id, id)).returning();
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
}, transaction?: ProductTransaction): Promise<boolean> {
  const apply = async (tx: ProductTransaction) => {
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
  };
  return transaction ? apply(transaction) : db.transaction(apply);
}

export async function setOgImage(slug: string, path: string, lease?: JobLease): Promise<void> {
  await withJobLeaseWrite(lease, tx => tx.update(products).set({ ogImage: path }).where(eq(products.slug, slug)));
}

export async function putOgImage(slug: string, contentType: string, data: Buffer, lease?: JobLease): Promise<void> {
  await withJobLeaseWrite(lease, tx => tx
    .insert(ogImages)
    .values({ slug, contentType, data })
    .onConflictDoUpdate({ target: ogImages.slug, set: { contentType, data } }));
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

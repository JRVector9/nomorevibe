import type { Product, ProductStatus } from "@/lib/db/schema";
import { listProducts, type ProductSort } from "./repository";
import { clickMetrics, type ClickMetrics } from "./clicks";
import { logger } from "@/lib/observability/logger";

/**
 * 목록 화면이 쓰는 뷰모델.
 *
 * 페이지가 DB 행(Product)을 직접 쓰면 지표(클릭·CTR)나 클레임 상태가 붙을 때
 * 타입이 바뀌면서 화면 코드까지 따라 바뀐다. 여기서 한 겹 끊어두면 이후엔 필드 추가만 하면 된다.
 */

/**
 * "만든 AI" 값을 얼마나 믿을 수 있는지.
 *
 * 어느 쪽도 기술적으로 검증할 수 없다. 커밋 트레일러는 손으로 써넣으면 그만이고
 * 스킬이 보내는 값도 위조 가능하다. 그래서 검증한 척하지 않고 근거를 밝힌다.
 * - reported: 메이커가 신고했다 (스킬로 등록했거나, 우리가 올린 것을 가져간 뒤)
 * - guessed:  우리가 공개 데이터를 보고 추정했다. 아무도 확인해주지 않았다.
 */
export type BuilderClaim = "reported" | "guessed";

export type ProductListItem = {
  slug: string;
  name: string;
  tagline: string;
  category: string;
  builder: string | null;
  builderClaim: BuilderClaim;
  stack: string[];
  ogImage: string | null;
  listedAt: Date;
  status: ProductStatus;
  /** 우리가 대신 올렸고 아직 주인이 나타나지 않았다 */
  unclaimed: boolean;
  /** 지표는 아직 없다 — 클릭 집계(트랙 B)가 붙으면 여기에 채워진다 */
  metrics?: { clicks: number; delta24h: number | null };
};

/** 아직 아무도 가져가지 않은 수집 결과인가 */
export function isUnclaimed(product: Pick<Product, "source" | "claimedAt">): boolean {
  return product.source === "crawler" && product.claimedAt === null;
}

export function builderClaimOf(product: Pick<Product, "source" | "claimedAt">): BuilderClaim {
  return isUnclaimed(product) ? "guessed" : "reported";
}

export function toListItem(p: Product): ProductListItem {
  return {
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    category: p.category,
    builder: p.builder,
    builderClaim: builderClaimOf(p),
    stack: p.stack ?? [],
    ogImage: p.ogImage,
    listedAt: p.verifiedAt ?? p.createdAt,
    status: p.status,
    unclaimed: isUnclaimed(p),
  };
}

/**
 * 공개 목록.
 *
 * 검증된 제품과 우리가 대신 올린 제품을 함께 보여준다. 후자를 감추면 메이커가
 * 자기 제품이 올라와 있다는 걸 발견할 방법이 없어 시드 자체가 무의미해진다.
 * 대신 각 항목이 자기 근거를 배지로 밝히고, 확인된 것만 위에 온다.
 */
export async function getPublicList(limit: number, sort?: ProductSort): Promise<ProductListItem[]> {
  const rows = await listProducts({ statuses: ["verified", "seeded"], sort, limit });
  return withMetrics(rows.map(toListItem));
}

/**
 * 지표를 한 번에 붙인다.
 *
 * 항목마다 쿼리를 돌리면 홈이 목록 길이만큼 느려진다. 지표는 부가물이므로 실패해도 목록은
 * 그대로 나가야 한다.
 */
async function withMetrics(items: ProductListItem[]): Promise<ProductListItem[]> {
  if (items.length === 0) return items;

  let metrics: Map<string, ClickMetrics>;
  try {
    metrics = await clickMetrics(items.map((i) => i.slug));
  } catch (error) {
    // 주석만 그렇게 적어두고 실제로는 예외가 그대로 올라가 홈이 통째로 "불러올 수
    // 없습니다"가 됐다. 지표가 없는 목록은 볼 수 있지만, 목록 없는 홈은 볼 것이 없다.
    logger.warn("products.metrics_failed", { count: items.length, error });
    return items;
  }

  return items.map((item) => {
    const found = metrics.get(item.slug);
    return found ? { ...item, metrics: found } : item;
  });
}

/** 랭킹·지표 대상 — 우리가 직접 확인한 제품만 */
export async function getRankedList(limit: number, sort?: ProductSort): Promise<ProductListItem[]> {
  const rows = await listProducts({ statuses: ["verified"], sort, limit });
  return withMetrics(rows.map(toListItem));
}

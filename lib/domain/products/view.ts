import type { Product, ProductStatus } from "@/lib/db/schema";
import { listProducts, type ProductSort } from "./repository";

/**
 * 목록 화면이 쓰는 뷰모델.
 *
 * 페이지가 DB 행(Product)을 직접 쓰면 지표(클릭·CTR)나 클레임 상태가 붙을 때
 * 타입이 바뀌면서 화면 코드까지 따라 바뀐다. 여기서 한 겹 끊어두면 이후엔 필드 추가만 하면 된다.
 */
export type ProductListItem = {
  slug: string;
  name: string;
  tagline: string;
  category: string;
  builder: string | null;
  stack: string[];
  ogImage: string | null;
  listedAt: Date;
  status: ProductStatus;
  /** 지표는 아직 없다 — 클릭 집계(트랙 B)가 붙으면 여기에 채워진다 */
  metrics?: { clicks: number; delta24h: number | null };
};

function toListItem(p: Product): ProductListItem {
  return {
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    category: p.category,
    builder: p.builder,
    stack: p.stack ?? [],
    ogImage: p.ogImage,
    listedAt: p.verifiedAt ?? p.createdAt,
    status: p.status,
  };
}

/** 공개 목록 — 등록은 열려 있지만 우리가 확인한 것만 노출한다 */
export async function getPublicList(limit: number, sort?: ProductSort): Promise<ProductListItem[]> {
  const rows = await listProducts({ statuses: ["verified"], sort, limit });
  return rows.map(toListItem);
}

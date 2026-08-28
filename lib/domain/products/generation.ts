import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";

/**
 * 제품 세대(generation) 잠금.
 *
 * 같은 slug가 삭제 후 재등록될 수 있으므로, 오래 걸리는 쓰기는 "요청이 시작된 그 제품이
 * 아직 그 제품인지"를 커밋 직전에 다시 확인해야 한다. 이 확인은 products 조회와 무관하게
 * evidence·media·health가 모두 필요로 하는 프리미티브라, repository가 아니라 여기에 둔다.
 *
 * repository.ts에 있을 때는 evidence/media가 잠금 하나를 쓰려고 products repository 전체를
 * import 해야 했고, 그 결과 두 모듈이 서로를 참조했다.
 */

export type ProductTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class ProductGenerationChangedError extends Error {
  constructor() {
    super("product generation changed");
    this.name = "ProductGenerationChangedError";
  }
}

export async function findProductGenerationId(slug: string): Promise<number | null> {
  const row = await db.query.products.findFirst({
    where: eq(products.slug, slug),
    columns: { id: true },
  });
  return row?.id ?? null;
}

/** 같은 slug의 삭제·재등록 세대를 직렬화하고 요청이 시작된 제품인지 확인한다. */
export async function lockProductGeneration(
  tx: ProductTransaction,
  id: number,
  slug: string,
): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`product-lifecycle:${slug}`}))`);
  const [row] = await tx.select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, id), eq(products.slug, slug)))
    .for("update");
  return Boolean(row);
}

/**
 * 제품 세대를 잠근 트랜잭션 안에서 실행한다.
 *
 * 잠금을 잡지 못했다는 것은 요청이 시작된 그 제품이 그 사이 삭제·재등록됐다는 뜻이므로,
 * 여기까지 쌓은 것을 커밋하면 안 된다. 쓰기 경로마다 이 세 줄을 손으로 다시 쓰면 새 경로를
 * 추가할 때 빠뜨려도 아무것도 막지 않는다.
 *
 * 잠금 실패를 예외가 아니라 값으로 다뤄야 하는 경로(어드민 차단·미디어 정리 등)는 이것을
 * 쓰지 않고 직접 lockProductGeneration을 부른다 — 반환하는 값이 저마다 다르다.
 */
export async function withProductGeneration<T>(
  slug: string,
  productId: number,
  run: (tx: ProductTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (!(await lockProductGeneration(tx, productId, slug))) {
      throw new ProductGenerationChangedError();
    }
    return run(tx);
  });
}

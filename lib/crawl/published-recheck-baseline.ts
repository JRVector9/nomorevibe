import { sql } from "drizzle-orm";
import { productRecheckBaselines } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { ReviewSnapshot } from "./agent-review-contract";
import { recheckContent, recheckContentHash } from "./published-recheck-change";

/**
 * 공개분 변경 재판정의 답이 곧 새 기준이다(2026-11-09 운영자 결정) — 그 답을 적는 트랜잭션(product-audit.ts recordAuditResult)이 부른다.
 * 승인·거절·판단 보류 모두 같다: 모델이 이 내용을 봤으니 다음에는 여기서부터 바뀐 것만 다시 묻는다. 기준 내용은 모델이 본 입력의 product 부분이다.
 * 마지막으로 견준 해시도 같은 값으로 둔다 — 그 사이 바뀌지 않았으면 쓸기가 본문을 다시 읽지 않는다.
 * 이 모듈은 product-audit.ts 를 읽지 않는다(순환 없이 그쪽이 부른다).
 */
export async function saveRecheckBaseline(tx: ProductTransaction, input: { productId: number; itemId: number; product: ReviewSnapshot["product"] }): Promise<void> {
  const content = recheckContent(input.product, { packageProofKnown: true });
  const hash = recheckContentHash(content);
  const values = { source: "recheck" as const, attemptId: null, itemId: input.itemId, content: content as Record<string, unknown>, contentHash: hash,
    checkedHash: hash, judgedAt: sql`now()`, checkedAt: sql`now()`, updatedAt: sql`now()` };
  await tx.insert(productRecheckBaselines).values({ productId: input.productId, ...values })
    .onConflictDoUpdate({ target: productRecheckBaselines.productId, set: values });
}

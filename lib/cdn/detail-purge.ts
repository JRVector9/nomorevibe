import { sql } from "drizzle-orm";
import { cdnPurges } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { DETAIL_EDIT_PURGE, DETAIL_STATUS_PURGE } from "./purge";

export type DetailPurgeReason = typeof DETAIL_EDIT_PURGE | typeof DETAIL_STATUS_PURGE;

/**
 * 그 제품의 상세(언어마다·RSC 갈래·공유 카드·배지)를 Cloudflare 에서 지울 줄을 같은 트랜잭션에 적는다 — 발행 워커의 cdn-purge 잡이
 * 1분 안에 지우고 60초 뒤 한 번 더 지운다. 사람이 고친 것이 엣지 사본(최대 5분, next.config.ts)이 끝날 때까지 남지 않게 한다.
 *
 * 아직 첫 지우기도 하지 않은 줄이 그 제품에 있으면 적지 않는다 — 그 줄의 두 지우기가 모두 이 커밋 뒤에 일어나, 원 서버의 30초
 * 기억(lib/domain/products/public-reads.ts)이 지난 값을 내놓는 동안 다시 채워진 사본까지 60초 뒤의 지우기가 지운다.
 * 첫 지우기를 이미 한 줄은 두 번째 지우기가 이 커밋 직후일 수 있어 기대지 않고 새 줄을 적는다.
 * 같은 제품을 연달아 고쳐도 대기 줄은 하나라 지우기 요청이 늘지 않는다.
 */
export async function queueDetailPurge(tx: ProductTransaction, slug: string, reason: DetailPurgeReason): Promise<void> {
  if (!slug) return;
  await tx.execute(sql`
    insert into ${cdnPurges} (slug, reason)
    select ${slug}, ${reason}
    where not exists (select 1 from ${cdnPurges} where ${cdnPurges.slug} = ${slug} and ${cdnPurges.purgedAt} is null)`);
}

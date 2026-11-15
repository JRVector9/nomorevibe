import { cdnPurges } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { ogObjectStore } from "@/lib/storage/og-store";
import { OG_DELETE_PURGE } from "./purge";

/**
 * 내리거나 지운 제품의 그림을 버킷에서 지울 줄을 같은 트랜잭션에 적는다 — 발행 워커의 cdn-purge 잡이 버킷에서 지운 뒤 Cloudflare 를 지운다
 * (lib/jobs/products/cdn-purge.ts). 버킷이 꺼진 프로세스는 적지 않는다(버킷에 그 그림이 없다 — 켜는 차례는 PR 본문).
 * 버킷 지우기를 커밋 뒤에 바로 부르지 않는 까닭: 실패하거나 프로세스가 그 사이 죽으면 내린 그림이 버킷에 남아 공개로 나간다. 줄은 커밋과 함께 남는다.
 */
export async function queueOgObjectDelete(tx: ProductTransaction, slug: string): Promise<void> {
  if (!slug || !ogObjectStore()) return;
  await tx.insert(cdnPurges).values({ slug, reason: OG_DELETE_PURGE });
}

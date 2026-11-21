import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/**
 * 저장소 id 근거 표를 비운다(시험 전용). 이 표는 지울 수 없다(0191) — 같은 저장소 이름을 다른 id 로 다시 쓰는 시험은 앞 시험·앞 파일이 남긴
 * 근거 때문에 「다른 저장소」로 읽힌다. 다른 추가 전용 표의 시험 정리와 같이, 한 트랜잭션 안에서만 거절 트리거를 끄고 지운 뒤 다시 켠다.
 * 출처 표(crawl_documents·product_evidence_sources·product_star_observations)를 DELETE 로 지우면 그 값이 근거로 다시 남으므로, 출처를 지운 **뒤에** 부른다.
 */
export async function clearRepositoryIdentityAnchors(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`alter table repository_identity_anchors disable trigger repository_identity_anchors_no_change`);
    await tx.execute(sql`delete from repository_identity_anchors`);
    await tx.execute(sql`alter table repository_identity_anchors enable always trigger repository_identity_anchors_no_change`);
  });
}

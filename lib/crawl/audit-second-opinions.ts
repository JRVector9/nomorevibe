import { sql, type SQL } from "drizzle-orm";
import { productAuditSecondOpinions } from "@/lib/db/schema";

/**
 * 감사 답에 대한 두 번째 의견(0110) — 다른 모델이 같은 감사 항목을 다시 본 것(product_audit_second_opinions).
 *
 * 2026-10-21 사용자 승인으로 0.95 이상·주인 없는 감사 거절 2,755건을 grok CLI 로 따로 다시 갈랐다(감사 잡 밖, 로컬 일괄).
 * 그 결과(JSONL)는 audit-second-opinion-import.ts 가 옮겨 적는다(scripts/ops/import-audit-second-opinions.ts). 여기는 의견을 읽는 SQL 이다 —
 * 감사 보류(product-audit-hold.ts)는 두 번째 모델도 거절한 것을 사유 갈래와 상관없이 보류하고 승인한 것은 갈래로 걸지 않으며,
 * 감사 화면은 '두 모델 모두 거절'·'갈림'으로 나눠 보인다.
 */

/** 그 항목에 이 결정의 두 번째 의견이 있다. itemId 는 감사 항목 id 의 SQL(열·별칭) */
export function secondOpinionVote(itemId: SQL, decision: "approve" | "reject" | "needs_review"): SQL {
  return sql`exists (select 1 from ${productAuditSecondOpinions} o2 where o2.item_id = ${itemId} and o2.decision = ${decision})`;
}

export type SecondOpinionView = { model: string; decision: "approve" | "reject" | "needs_review"; confidence: number | null };

/** 화면 줄에 실을 두 번째 의견 — 모델 이름순. 없으면 빈 목록 */
export function secondOpinionsField(itemId: SQL) {
  return sql<SecondOpinionView[]>`(select coalesce(json_agg(json_build_object('model', o2.model, 'decision', o2.decision,
    'confidence', o2.confidence) order by o2.model), '[]'::json) from ${productAuditSecondOpinions} o2 where o2.item_id = ${itemId})`;
}

/** 감사 화면의 두 번째 의견 거르기 — 두 모델 모두 거절, 또는 갈림(두 번째가 승인했고 거절은 없다) */
export type SecondOpinionFilter = "agreed" | "split";
export function secondOpinionFilter(filter: SecondOpinionFilter, itemId: SQL): SQL {
  return filter === "agreed" ? secondOpinionVote(itemId, "reject")
    : sql`(${secondOpinionVote(itemId, "approve")} and not ${secondOpinionVote(itemId, "reject")})`;
}

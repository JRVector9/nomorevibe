import { sql, type SQL } from "drizzle-orm";
import { crawlCandidates, crawlDocuments, productAuditSecondOpinions, products } from "@/lib/db/schema";
import { SCREEN_REVIEW_SOURCES } from "./audit-import-sources";
import { QWEN_V2_AUTO_SOURCE } from "./qwen-direct-review";
import { QWEN_AUTO_MIN_CONFIDENCE, sameOpinionModel, THIN_PAGE_TEXT_CHARS } from "./second-opinion-rules";

/**
 * 글만 본 m1 의 답이 무엇을 닫을 수 있나(2026-10-22 사용자 결정) — 감사 두 번째 의견의 자동 닫기(audit-auto-close.ts)와 보류의 둘째 문
 * (product-audit-hold.ts holdGates·audit-second-opinions.ts countedSecondReject)이 같은 조건을 쓴다.
 *
 *  1. 글이 적은 페이지는 늘 화면을 보고 판정한다: 수집 본문이 THIN_PAGE_TEXT_CHARS(300자) 아래거나 수집 원본이 없으면, 글만 본 m1 의견
 *     (source qwen-v2-auto)은 의견으로만 남고 유지·숨김·보류 걸기·보류 풀기 어디에도 세지 않는다. 그 항목은 '화면 판별 대기'로 남아
 *     화면 판정(audit-screen-review.ts)을 기다린다. 화면 판정 출처(SCREEN_REVIEW_SOURCES)와 grok 일괄·첫 감사의 사유 갈래는 그대로다.
 *  2. 다른 모델이 승인했으면 숨기지 않는다: m1 의 거절에 다른 모델(이름이 다른)의 승인이 있으면 엇갈림이다 — 승인 쪽(다른 모델이 거절하면
 *     유지하지 않음)과 같다. 사람이 두 모델의 결정·사유를 보고 정한다(감사 줄의 '엇갈림' 배지·정책 처리의 '엇갈림' 거르기).
 *
 * 본문은 감사·m1 이 product.pageText 로 받는 바로 그 글이다 — crawl_documents.page_meta.textSample(정적 HTML 의 보이는 글, 6천 자까지)을
 * 수집 후보의 발행 주소(published_slug = 제품 slug)로 잇는다(product-audit.ts loadAuditInput 과 같은 길).
 */

/** 앞의 게이트웨이 자리 표시('[gpu3090] ')를 뗀 소문자 모델 이름 — second-opinion-rules.ts sameOpinionModel 과 같다 */
const bareModel = (model: SQL) => sql`lower(regexp_replace(trim(${model}), '^\\[[^]]*\\]\\s*', ''))`;

/** 그 제품의 수집 본문 글자 수(앞뒤 공백 없이) — 수집 원본이 없으면 null. productId 는 제품 id 의 SQL(열·별칭) */
export function pageTextLengthSql(productId: SQL): SQL<number | null> {
  return sql<number | null>`(select max(char_length(btrim(coalesce(td.page_meta->>'textSample', ''))))::int
    from ${products} tp join ${crawlCandidates} tc on tc.published_slug = tp.slug join ${crawlDocuments} td on td.repo = tc.repo
   where tp.id = ${productId})`;
}

/** 그 제품의 수집 본문이 적다 — THIN_PAGE_TEXT_CHARS 아래이거나 수집 원본이 없다(글을 확인할 수 없다) */
export function thinPageTextSql(productId: SQL): SQL<boolean> {
  return sql<boolean>`coalesce(${pageTextLengthSql(productId)} < ${THIN_PAGE_TEXT_CHARS}, true)`;
}

/** 그 항목에 화면을 보고 판정한 의견(SCREEN_REVIEW_SOURCES — 결정과 상관없이)이 있다 */
export function screenJudgedSql(itemId: SQL): SQL<boolean> {
  const sources = [...SCREEN_REVIEW_SOURCES];
  if (!sources.length) return sql<boolean>`false`;
  return sql<boolean>`exists (select 1 from ${productAuditSecondOpinions} so where so.item_id = ${itemId}
    and so.source in (${sql.join(sources.map((source) => sql`${source}`), sql`, `)}))`;
}

/** 화면 판별 대기 — 글이 적고 화면 판정이 아직 없다 */
export function screenWaitSql(itemId: SQL, productId: SQL): SQL<boolean> {
  return sql<boolean>`(${thinPageTextSql(productId)} and not ${screenJudgedSql(itemId)})`;
}

/**
 * 엇갈림 — 그 항목에 확신 0.90 이상인 m1 의 승인·거절과, 반대 결정을 낸 다른 모델(이름이 다른)의 의견이 함께 있다. 답으로 닫기가 'split'으로
 * 열어 둔 것과 같은 뜻이다(글이 적은 항목도 든다 — 그 항목은 화면 판별 대기로 먼저 열어 둔다)
 */
export function m1SplitSql(itemId: SQL): SQL<boolean> {
  return sql<boolean>`exists (select 1 from ${productAuditSecondOpinions} m join ${productAuditSecondOpinions} x on x.item_id = m.item_id
    where m.item_id = ${itemId} and m.source = ${QWEN_V2_AUTO_SOURCE} and m.confidence >= ${QWEN_AUTO_MIN_CONFIDENCE}
      and m.decision in ('approve', 'reject') and x.decision in ('approve', 'reject') and x.decision <> m.decision
      and ${bareModel(sql`x.model`)} <> ${bareModel(sql`m.model`)})`;
}

/** 그 의견(별칭 opinion)과 다른 모델의 승인이 같은 항목에 있다 — m1 거절의 엇갈림(countedSecondReject) */
export function otherModelApproveSql(opinion: string): SQL<boolean> {
  const alias = sql.identifier(opinion);
  return sql<boolean>`exists (select 1 from ${productAuditSecondOpinions} oa where oa.item_id = ${alias}.item_id and oa.decision = 'approve'
    and ${bareModel(sql`oa.model`)} <> ${bareModel(sql`${alias}.model`)})`;
}

type Opinion = { model: string; decision: string; source?: string | null; confidence?: number | null; reason?: string | null };

/** 글만 본 m1 의견인가(Qwen-v2 자동 의견) — 화면 판정 출처의 m1 의견(qwen-vision-m1)은 아니다 */
export const textOnlyM1 = (opinion: Pick<Opinion, "source">): boolean => opinion.source === QWEN_V2_AUTO_SOURCE;

/** 이 의견과 반대 결정(승인 ↔ 거절)을 낸 다른 모델의 의견 — 판단 보류는 어느 쪽도 아니다 */
export function opposingOpinions<T extends Opinion>(opinion: Pick<Opinion, "model" | "decision">, opinions: readonly T[]): T[] {
  const opposite = opinion.decision === "approve" ? "reject" : opinion.decision === "reject" ? "approve" : null;
  return opposite ? opinions.filter((other) => other.decision === opposite && !sameOpinionModel(other.model, opinion.model)) : [];
}

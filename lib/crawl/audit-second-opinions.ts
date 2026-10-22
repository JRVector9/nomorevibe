import { sql, type SQL } from "drizzle-orm";
import { productAuditSecondOpinions } from "@/lib/db/schema";
import { AUDIT_REASON_RULES } from "./audit-reason-category";
import { CATALOG_EXCEPTION_FAMILIES, CATALOG_LIKE_REASON, QWEN_AUTO_MIN_CONFIDENCE } from "./second-opinion-rules";
import { QWEN_V2_AUTO_SOURCE } from "./qwen-direct-review";
import { CONFIDENCE_FLOOR_SOURCES } from "./audit-import-sources";

/**
 * 감사 답에 대한 두 번째 의견(0110) — 다른 모델이 같은 감사 항목을 다시 본 것(product_audit_second_opinions).
 *
 * 2026-10-21 사용자 승인으로 0.95 이상·주인 없는 감사 거절 2,755건을 grok CLI 로 따로 다시 갈랐다(감사 잡 밖, 로컬 일괄).
 * 그 결과(JSONL)는 audit-second-opinion-import.ts 가 옮겨 적는다(scripts/ops/import-audit-second-opinions.ts). 같은 날부터 gpu3090 Qwen-v2 의견을
 * 감사 잡이 틱마다 받아 적는다(audit-second-opinion-auto.ts). 여기는 의견을 읽는 SQL 이다 — 감사 보류(product-audit-hold.ts)는 두 번째 모델의
 * 거절을 사유 갈래와 상관없이 보류의 까닭으로 세되(모델별 규칙 second-opinion-rules.ts — Qwen 거절은 카탈로그·디렉터리 같은 항목에서 세지 않는다),
 * 승인한 것은 갈래로 걸지 않으며, 감사 화면은 '두 모델 모두 거절'·'갈림'·'Qwen·grok 의견 다름'·'Qwen 거절(카탈로그 예외)'로 나눠 보인다.
 */

/** 그 항목에 이 결정의 두 번째 의견이 있다 — 모델을 가리지 않는다. itemId 는 감사 항목 id 의 SQL(열·별칭) */
export function secondOpinionVote(itemId: SQL, decision: "approve" | "reject" | "needs_review"): SQL {
  return sql`exists (select 1 from ${productAuditSecondOpinions} o2 where o2.item_id = ${itemId} and o2.decision = ${decision})`;
}

const HYPHENS = "‐‑‒–—―";

/**
 * 감사 사유의 갈래를 SQL 로 — classifyAuditReason 과 같은 글·같은 차례·같은 소문자·하이픈 바꿈이다. 글은 JS 정규식 그대로이고
 * 낱말 경계 \b 만 Postgres 의 \y 로 바꾼다(Postgres 에서 \b 는 백스페이스다). 비교는 collate "C" 로 — 낱말 글자가 JS 와 같은 ASCII 다. 사유가 없으면 'other'
 */
export function auditReasonCategorySql(reason: SQL): SQL {
  const text = sql`translate(lower(coalesce(${reason}, '')), ${HYPHENS}, '------')`;
  // collate "C": 낱말 글자를 ASCII 로만 본다 — JS 의 \b(\w = [A-Za-z0-9_])와 같게. 기본 collation 이면 é·α·한글도 낱말 글자라 \y 가 다르게 끊는다
  const cases = AUDIT_REASON_RULES.map(([key, pattern]) => sql`when (${text} collate "C") ~ ${pattern.source.replaceAll("\\b", "\\y")} then ${key}`);
  return sql`(case ${sql.join(cases, sql` `)} else 'other' end)`;
}

/** 감사 사유가 카탈로그·디렉터리 같은가 — second-opinion-rules.ts catalogLikeAuditReason 과 같다 */
export function catalogLikeReasonSql(reason: SQL): SQL {
  return sql`(${auditReasonCategorySql(reason)} = 'platform' or (coalesce(${reason}, '') collate "C") ~* ${CATALOG_LIKE_REASON.source})`;
}

/** 모델 갈래 — second-opinion-rules.ts secondOpinionFamily 와 같다(앞의 대괄호 덩이를 떼고 소문자 영문자) */
export function secondOpinionFamilySql(model: SQL): SQL {
  const bare = sql`lower(regexp_replace(trim(${model}), '^\\[[^]]*\\]\\s*', ''))`;
  return sql`coalesce(substring(${bare} from '^[a-z]+'), ${bare})`;
}

/** 카탈로그 예외가 걸린 모델 갈래의 의견(o2) — 표가 비면 거짓 */
const exceptedFamily = CATALOG_EXCEPTION_FAMILIES.length
  ? sql`${secondOpinionFamilySql(sql`o2.model`)} in (${sql.join(CATALOG_EXCEPTION_FAMILIES.map((family) => sql`${family}`), sql`, `)})`
  : sql`false`;

/**
 * 그 항목에 보류의 까닭이 되는 두 번째 거절이 있다 — secondRejectHolds·holdGates 의 SQL. reason 은 그 항목의 감사 사유(ai_reason).
 * Qwen-v2 자동 의견(source qwen-v2-auto)의 거절은 그 단계(qwenAuto.auditSecondOpinion)가 켜져 있고 확신이 0.90 이상일 때만 센다
 * (product-audit-hold.ts countedOpinion 과 같다). autoOpinions 는 그 스위치다
 */
export function countedSecondReject(itemId: SQL, reason: SQL, autoOpinions: boolean): SQL {
  return sql`exists (select 1 from ${productAuditSecondOpinions} o2 where o2.item_id = ${itemId} and o2.decision = 'reject'
    and not (${exceptedFamily} and ${catalogLikeReasonSql(reason)})
    and (o2.source is distinct from ${QWEN_V2_AUTO_SOURCE} or (${autoOpinions} and o2.confidence >= ${QWEN_AUTO_MIN_CONFIDENCE}))
    and ${flooredSourceCounts})`;
}

/**
 * 확신 하한이 있는 올린 출처(audit-import-sources.ts CONFIDENCE_FLOOR_SOURCES — m1 화면 재판정)의 의견은 하한 이상일 때만 센다
 * (product-audit-hold.ts countedOpinion 과 같다). 표가 비면 참
 */
const flooredSourceCounts = Object.keys(CONFIDENCE_FLOOR_SOURCES).length
  ? sql`(case ${sql.join(Object.entries(CONFIDENCE_FLOOR_SOURCES).map(([source, floor]) =>
    sql`when o2.source = ${source} then coalesce(o2.confidence >= ${floor}, false)`), sql` `)} else true end)`
  : sql`true`;

/** 그 항목의 두 번째 거절 가운데 카탈로그 예외로 세지 않은 것(Qwen 거절·카탈로그 같은 항목)이 있다 */
export function excludedSecondReject(itemId: SQL, reason: SQL): SQL {
  return sql`exists (select 1 from ${productAuditSecondOpinions} o2 where o2.item_id = ${itemId} and o2.decision = 'reject'
    and ${exceptedFamily} and ${catalogLikeReasonSql(reason)})`;
}

export type SecondOpinionView = { model: string; decision: "approve" | "reject" | "needs_review"; confidence: number | null };

/** 화면 줄에 실을 두 번째 의견 — 모델 이름순. 없으면 빈 목록 */
export function secondOpinionsField(itemId: SQL) {
  return sql<SecondOpinionView[]>`(select coalesce(json_agg(json_build_object('model', o2.model, 'decision', o2.decision,
    'confidence', o2.confidence) order by o2.model), '[]'::json) from ${productAuditSecondOpinions} o2 where o2.item_id = ${itemId})`;
}

/** 보류의 둘째 문(holdGate)이 읽는 의견 — 모델·결정, 그리고 자동 의견을 가르는 출처·확신 */
export type SecondOpinionVoteRow = { model: string; decision: string; source?: string | null; confidence?: number | null };
export function secondOpinionVotesField(itemId: SQL) {
  return sql<SecondOpinionVoteRow[]>`(select coalesce(json_agg(json_build_object('model', o2.model, 'decision', o2.decision,
    'source', o2.source, 'confidence', o2.confidence) order by o2.model), '[]'::json) from ${productAuditSecondOpinions} o2 where o2.item_id = ${itemId})`;
}

/**
 * 감사 화면의 두 번째 의견 거르기:
 *  agreed: 두 모델 모두 거절 — 보류의 까닭이 되는 두 번째 거절이 있다(카탈로그 예외로 세지 않은 Qwen 거절은 빠진다)
 *  split: 갈림 — 그런 거절은 없고, 두 번째 모델이 승인했거나 카탈로그 예외로 세지 않은 Qwen 거절(두 번째 의견·감사 답)이 있다(사람이 본다)
 *  disagree: Qwen·grok 의견 다름 — 두 모델의 의견이 모두 있고 결정이 다르다
 *  qwen_catalog: Qwen 거절(카탈로그 예외) — 카탈로그·디렉터리 같아 Qwen 거절(두 번째 의견이든 감사 답이든)을 보류의 까닭으로 세지 않은 것
 * reason 은 그 항목의 감사 사유(ai_reason) SQL
 */
export const SECOND_OPINION_FILTERS = ["agreed", "split", "disagree", "qwen_catalog"] as const;
export type SecondOpinionFilter = (typeof SECOND_OPINION_FILTERS)[number];
/**
 * 감사 거절을 낸 쪽이 Qwen 이고 카탈로그·디렉터리 같은 항목이다(0112 남은 감사 모델 바꾸기 뒤) — 감사 모델의 카탈로그 예외로 갈래 보류를
 * 하지 않는 것(product-audit-hold.ts holdGates). provider 는 그 항목의 ai_provider(qwen-direct 가 먼저), model 은 coalesce(ai_model, 감사 시작 model)
 */
export function primaryCatalogExcluded(primary: { provider: SQL; model: SQL }, reason: SQL): SQL {
  return sql`((coalesce(${primary.provider}, '') = 'qwen-direct' or ${secondOpinionFamilySql(primary.model)} = 'qwen') and ${catalogLikeReasonSql(reason)})`;
}

/**
 * primary 를 주면 감사 모델의 카탈로그 예외(primaryCatalogExcluded)도 갈림·Qwen 카탈로그 예외 갈래에 넣는다.
 * autoOpinions: Qwen-v2 자동 의견 단계(qwenAuto.auditSecondOpinion)가 켜져 있는가 — 꺼져 있으면 그 거절은 '두 모델 모두 거절'에 들지 않는다
 */
export function secondOpinionFilter(filter: SecondOpinionFilter, itemId: SQL, reason: SQL,
  options: { primary?: { provider: SQL; model: SQL }; autoOpinions: boolean }): SQL {
  const { primary, autoOpinions } = options;
  const primaryExcluded = primary ? primaryCatalogExcluded(primary, reason) : sql`false`;
  if (filter === "agreed") return countedSecondReject(itemId, reason, autoOpinions);
  if (filter === "split") {
    return sql`(not ${countedSecondReject(itemId, reason, autoOpinions)} and (${secondOpinionVote(itemId, "approve")} or ${excludedSecondReject(itemId, reason)}
      or ${primaryExcluded}))`;
  }
  if (filter === "qwen_catalog") return sql`(${excludedSecondReject(itemId, reason)} or ${primaryExcluded})`;
  return sql`exists (select 1 from ${productAuditSecondOpinions} q join ${productAuditSecondOpinions} g on g.item_id = q.item_id
    where q.item_id = ${itemId} and ${secondOpinionFamilySql(sql`q.model`)} = 'qwen' and ${secondOpinionFamilySql(sql`g.model`)} = 'grok'
      and q.decision <> g.decision)`;
}

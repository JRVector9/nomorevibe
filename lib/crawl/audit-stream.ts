import { sql, type SQL } from "drizzle-orm";
import { productAuditCampaigns } from "@/lib/db/schema";
import { MAX_REVIEW_ATTEMPTS } from "./agent-review-contract";

/**
 * 감사 표의 두 줄(0171) — 사람이 연 감사(status running·done·cancelled)와 공개분 변경 재검수의 늘 열린 줄(status 'rolling', 하나뿐).
 *
 * "지금 감사"(감사 화면·정책 처리·두 번째 의견·받은편지함·운영센터가 보는 마지막 감사)는 사람이 연 감사 중 마지막 것이다 — rolling 행은 뒤에 생겨
 * id 가 가장 클 수 있으므로 max(id) 를 그대로 쓰면 안 된다. "진행 중인 감사"(status = 'running')는 rolling 을 세지 않으므로 그대로 둔다.
 */
export const ROLLING_AUDIT_STATUS = "rolling" as const;

/** 사람이 연 감사(product_audit_campaigns 의 where 조건) */
export const manualAuditCampaign: SQL = sql`${productAuditCampaigns.status} <> ${ROLLING_AUDIT_STATUS}`;

/** 사람이 연 감사 중 마지막 것의 id — 없으면 null */
export const latestManualCampaignSql: SQL = sql`(select max(${productAuditCampaigns.id}) from ${productAuditCampaigns}
  where ${productAuditCampaigns.status} <> ${ROLLING_AUDIT_STATUS})`;

/** 공개분 변경 재검수 줄의 id — 아직 없으면 null */
export const rollingCampaignSql: SQL = sql`(select ${productAuditCampaigns.id} from ${productAuditCampaigns}
  where ${productAuditCampaigns.status} = ${ROLLING_AUDIT_STATUS})`;

/** 사람이 연 감사인가(행의 status 로) */
export const isManualCampaign = (campaign: { status: string }): boolean => campaign.status !== ROLLING_AUDIT_STATUS;

/**
 * 그 제품의 더 새 항목이 옛 거절을 가리는가 — 보류·자동 닫기의 "그 제품의 마지막 항목" 규칙. n·nc 는 product_audit_items·product_audit_campaigns 를
 * 부르는 이름이다. 답이 있으면 가린다. 답이 없으면 그 줄이 아직 물을 때만 가린다: 사람이 연 감사는 돌고 있을 때, 공개분 변경 재검수는 그 항목이 아직
 * 물을 수 있을 때(시도가 남았고 원본이 있다) — 재검수 줄은 끝나지 않으므로 답을 못 받은 항목이 옛 거절을 영영 가리지 않게 한다
 */
export function newerItemPending(n: string, nc: string): SQL {
  const item = (column: string) => sql`${sql.identifier(n)}.${sql.identifier(column)}`;
  const status = sql`${sql.identifier(nc)}.status`;
  return sql`(${item("ai_decision")} is not null or ${status} = 'running'
    or (${status} = ${ROLLING_AUDIT_STATUS} and ${item("attempts")} < ${MAX_REVIEW_ATTEMPTS} and ${item("error_code")} is distinct from 'no_source'))`;
}

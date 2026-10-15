import { AUDIT_REASON_CATEGORIES, isAuditReasonCategory } from "@/lib/crawl/audit-reason-category";

/**
 * 차단 사유(2026-10-08 UX 감사 ADM-06) — 차단은 사유를 하나 골라야 된다. 값은 차단 감사 행(product_evidence_audit.reason)과
 * 작업 로그 detail 에 그대로 남는다.
 *
 * 스팸 재검사가 자동으로 내린 사유(repository.ts SPAM_AUTO_BAN_REASON = "suspected_spam")와 겹치지 않는 이름을 쓴다 —
 * 그 사유로 '스팸 자동 차단' 거르기와 하루 한도를 센다.
 */
export const BAN_REASONS = [
  { value: "spam", label: "스팸·악성" },
  { value: "fraud", label: "사기·피싱" },
  { value: "not_product", label: "제품 아님" },
  { value: "takedown_request", label: "내려달라는 요청" },
  { value: "other", label: "기타" },
] as const;

export type BanReason = (typeof BAN_REASONS)[number]["value"];

export function isBanReason(value: unknown): value is BanReason {
  return BAN_REASONS.some((reason) => reason.value === value);
}

export function banReasonLabel(value: string): string {
  if (value === "uptime_consecutive_failures") return "사이트 연속 접속 실패 10회 이상 · 자동 내림";
  // 감사로 내린 것은 사유 갈래를 함께 남긴다(product-audit.ts auditBanReason) — 'audit:shop' → '감사: 쇼핑몰·판매'
  const audit = /^audit:(\w+)$/.exec(value)?.[1];
  if (audit) return `감사: ${isAuditReasonCategory(audit) ? AUDIT_REASON_CATEGORIES[audit].label : audit}`;
  return BAN_REASONS.find((reason) => reason.value === value)?.label ?? value;
}

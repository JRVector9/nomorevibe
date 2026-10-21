import type { Dictionary } from "@/lib/i18n/messages";

/** 의견 탭(OpinionList·FeedbackDeliveryStatus)이 쓰는 detail 사전의 열쇠 머리 */
export const OPINION_DETAIL_PREFIXES = ["feedback.kind.", "feedback.reason.", "feedback.reviewReason", "delivery.", "issue."] as const;

/**
 * 의견 탭에 넘길 detail 사전 몫 — 상세 사전 전체(400줄 넘게, 25KB 남짓)를 탭을 열 때마다 RSC 로 싣지 않는다.
 * 탭이 쓰지 않는 열쇠는 빠진다(tests/me-account.test.ts 가 탭의 열쇠가 모두 남는지 본다)
 */
export function opinionDetailMessages(detail: Dictionary["detail"]): Dictionary["detail"] {
  return Object.fromEntries(Object.entries(detail).filter(([key]) => OPINION_DETAIL_PREFIXES.some((prefix) => key.startsWith(prefix)))) as Dictionary["detail"];
}

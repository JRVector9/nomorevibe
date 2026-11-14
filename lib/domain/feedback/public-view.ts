import type { FeedbackView } from "./contract";

/** 공개 의견 목록 한 줄 — 상세 화면의 CompactFeedbackItem 이 그리는 항목만 */
export type PublicFeedbackItem = Pick<FeedbackView,
  "id" | "kind" | "title" | "body" | "authorDisplayName" | "reviewState" | "reviewReason" | "deliveryState" | "createdAt"
  | "githubIssueUrl" | "externalIssueState">;

export function publicFeedbackItem(item: FeedbackView): PublicFeedbackItem {
  return {
    id: item.id, kind: item.kind, title: item.title, body: item.body, authorDisplayName: item.authorDisplayName,
    reviewState: item.reviewState, reviewReason: null, deliveryState: item.deliveryState, createdAt: item.createdAt,
    githubIssueUrl: item.githubIssueUrl ?? null, externalIssueState: item.externalIssueState ?? null,
  };
}

import type { FeedbackView } from "@/lib/domain/feedback/contract";

const DELIVERY = {
  local_only: "서비스에 접수됨", queued: "GitHub 전송 대기", sending: "GitHub 전송 확인 중", delivered: "GitHub에 전송됨",
  retry_wait: "GitHub 전송 재시도 대기", uncertain: "GitHub 전송 결과 확인 중", blocked: "GitHub 전송 중지", cancelled: "GitHub 전송 취소",
};
const EXTERNAL = { open: "열림", closed: "닫힘", deleted: "삭제됨", unknown: "상태 확인 중" };

export function FeedbackDeliveryStatus({ feedback, compact = false }: { feedback: FeedbackView; compact?: boolean }) {
  if (compact && feedback.deliveryState === "local_only" && !feedback.githubIssueUrl) return null;

  return <>
    <span>{DELIVERY[feedback.deliveryState]}</span>
    {feedback.githubIssueUrl && <> · <a href={feedback.githubIssueUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">GitHub 이슈 보기</a>
      {feedback.externalIssueState && <span> · GitHub 이슈 {EXTERNAL[feedback.externalIssueState]}</span>}</>}
    {!compact && feedback.lastErrorCode && <span> · 전송 상태 코드: {feedback.lastErrorCode}</span>}
  </>;
}

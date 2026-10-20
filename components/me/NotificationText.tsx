import type { NotificationPart } from "@/lib/me/notification-view";

/** 알림 한 줄 — 서버가 나눠 보낸 조각을 그대로, 이름만 굵게 */
export function NotificationText({ parts }: { parts: NotificationPart[] }) {
  return <span className="me-note-text">{parts.map((part, index) => part.strong ? <b key={index}>{part.text}</b> : <span key={index}>{part.text}</span>)}</span>;
}

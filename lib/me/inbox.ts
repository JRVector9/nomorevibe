import "server-only";
import { translatedCategory } from "@/components/home/i18n";
import { getTranslator } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/locales";
import { listNotifications, unreadNotificationCount } from "./notifications";
import { renderNotification, type NotificationView } from "./notification-view";

export type Inbox = { items: NotificationView[]; nextCursor: number | null; unread: number };

/** 알림함 한 쪽을 그 언어의 한 줄로 — 알림 탭(서버)과 GET /api/me/notifications(종·더 보기)가 같이 쓴다 */
export async function loadInbox(userId: number, locale: Locale, options: { before?: number; limit?: number } = {}): Promise<Inbox> {
  const [page, unread, t, labels] = await Promise.all([
    listNotifications(userId, options), unreadNotificationCount(userId), getTranslator(locale, "me"), getTranslator(locale, "labels"),
  ]);
  return { items: page.items.map((row) => renderNotification(row, t, (category) => translatedCategory(category, labels), locale)), nextCursor: page.nextCursor, unread };
}

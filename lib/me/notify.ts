import "server-only";
import { db, onPrimary } from "@/lib/db";
import { notifications } from "@/lib/db/me-schema";
import type { NotificationKind } from "./contract";
import { enqueueNotificationEmails } from "./email-outbox";

export type NotificationInput = {
  userId: number;
  kind: NotificationKind;
  productId?: number | null;
  payload?: Record<string, unknown>;
  /** 같은 일에는 알림 하나 — 예: `maker_reply:<reply id>` */
  dedupeKey: string;
};

/** 사이트 안 알림함에 넣는다. 같은 (계정, dedupe_key) 가 이미 있으면 아무것도 하지 않는다. 넣었으면 true */
export async function notify(input: NotificationInput): Promise<boolean> {
  const rows = await onPrimary(() => db.insert(notifications).values({
    userId: input.userId, kind: input.kind, productId: input.productId ?? null, payload: input.payload ?? {}, dedupeKey: input.dedupeKey.slice(0, 120),
  }).onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] }).returning({ id: notifications.id }));
  // 메일 설정이 «즉시»면 발송함에 한 통(MY7) — 실패해도 던지지 않는다
  if (rows.length) await enqueueNotificationEmails([{ ...input, id: rows[0].id }]);
  return rows.length > 0;
}

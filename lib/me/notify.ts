import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { notifications } from "@/lib/db/me-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { NotificationKind } from "./contract";
import { enqueueNotificationEmails } from "./email-outbox";

/** 계정 한 명에게 알림 한 줄(메이커 답장·새 등재). 발행 워커도 부르므로 server-only 를 붙이지 않는다 */
export type NotificationInput = {
  userId: number;
  kind: NotificationKind;
  productId?: number | null;
  payload?: Record<string, unknown>;
  /** 같은 일에는 알림 하나 — 예: `maker_reply:<reply id>` */
  dedupeKey: string;
};

/**
 * 사이트 안 알림함에 넣는다. 같은 (계정, dedupe_key) 가 이미 있으면 아무것도 하지 않는다. 넣었으면 true.
 * 탈퇴한 계정에는 넣지 않는다 — 계정 행을 같은 문장에서 잠그고(for key share) 본다. 탈퇴(lib/me/account.ts)가 그 행을 for update 로
 * 잡고 알림을 지우므로, 탈퇴가 먼저면 끝난 뒤의 deleted_at 을 보고 건너뛰고, 이쪽이 먼저면 탈퇴가 넣은 줄까지 지운다.
 * executor 를 주면(발행 lease 쓰기) 그 안에서 넣고 «즉시» 메일도 같은 곳에 줄 세운다(던지지 않는다)
 */
export async function notify(input: NotificationInput, executor: typeof db | ProductTransaction = db): Promise<boolean> {
  const rows = await onPrimary(() => executor.execute<{ id: number | string }>(sql`
    insert into ${notifications} (user_id, kind, product_id, payload, dedupe_key)
    select u.id, ${input.kind}, ${input.productId ?? null}::int, ${JSON.stringify(input.payload ?? {})}::jsonb, ${input.dedupeKey.slice(0, 120)}
      from ${publicUsers} u where u.id = ${input.userId} and u.deleted_at is null
       for key share
    on conflict (user_id, dedupe_key) do nothing
    returning id`));
  if (rows.length) await enqueueNotificationEmails([{ ...input, productId: input.productId ?? null, id: Number(rows[0].id) }], executor);
  return rows.length > 0;
}

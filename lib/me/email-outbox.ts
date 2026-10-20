import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, lte, notExists, or, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { emailOutbox, notificationSettings, notifications } from "@/lib/db/me-schema";
import { publicIdentities, publicUsers } from "@/lib/db/public-user-schema";
import { products } from "@/lib/db/schema";
import { emailLoginConfigured, sendEmail, type EmailDeliveryState } from "@/lib/domain/accounts/email-delivery";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { localePath } from "@/lib/i18n/routing";
import type { Locale } from "@/lib/i18n/locales";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { logger } from "@/lib/observability/logger";
import { siteOrigin } from "@/lib/site";
import { EMAIL_SETTING_CHOICES, type EmailSettingKey, type NotificationKind } from "./contract";
import { digestEmail, instantEmail, type DigestItem, type EmailContent, type EmailKind, type EmailProduct } from "./email-copy";
import { DEFAULT_NOTIFICATION_SETTINGS, EMAIL_SETTING_FOR_KIND, emailRecipient, weeklyKinds } from "./notification-settings";
import { alertSettingsUrl, unsubscribeUrl } from "./unsubscribe";

/**
 * 메일 발송함(MY7, 로그인 설계 L8) — 알림을 넣은 뒤 메일 한 통을 줄 세우고, maintenance 잡이 보낸다.
 * github_issue_outbox 와 같은 생각: 같은 일에는 한 줄(dedupe_key), 보내기 전에 다음 시도 시각을 먼저 적어 두고(그 사이 죽어도
 * 그 시각 뒤에 다시 잡힌다) 같은 Idempotency-Key 로 다시 보내 Resend 가 한 번만 보내게 한다.
 * 발신 설정(LOGIN_EMAIL_*)이 없으면 줄을 쌓지 않고, 남은 줄은 skipped 로 닫는다 — 네트워크를 부르지 않는다.
 */
export const EMAIL_MAX_ATTEMPTS = 5;
/** n번째 시도가 실패했을 때 다음 시도까지(분) — 1·5·15·60 */
const BACKOFF_MINUTES = [1, 5, 15, 60];
export function emailRetryDelayMs(attempts: number): number {
  return BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1] * 60_000;
}

/**
 * 발송함 dedupe_key 는 표 전체에서 하나다 — 알림 dedupe_key 는 계정마다 하나라(팔로한 사람마다 같은 `followed_release:<id>`)
 * 계정 id 를 붙인다. 120자를 넘으면 뒤를 해시로 줄인다.
 */
export function notificationEmailDedupeKey(userId: number, dedupeKey: string): string {
  const key = `email:${userId}:${dedupeKey}`;
  return key.length <= 120 ? key : `email:${userId}:h:${createHash("sha256").update(dedupeKey).digest("hex").slice(0, 64)}`;
}

/** 주간 요약은 계정마다 KST 기준 ISO 주에 한 통 */
export function digestDedupeKey(userId: number, week: string): string {
  return `digest:${userId}:${week}`;
}

/** KST 시각 — 요일(0=일요일)·시·ISO 주(2026-W43). ISO 주는 그 주 목요일이 든 해를 따른다 */
export function kstClock(now: Date): { weekday: number; hour: number; week: string } {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const weekday = kst.getUTCDay();
  const thursday = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 3 - ((weekday + 6) % 7)));
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / 604_800_000);
  return { weekday, hour: kst.getUTCHours(), week: `${year}-W${String(week).padStart(2, "0")}` };
}

export type NotificationEmailSource = {
  id: number; userId: number; kind: NotificationKind; productId?: number | null; payload?: Record<string, unknown>; dedupeKey: string;
};

type Executor = typeof db | ProductTransaction;
const SETTING_COLUMNS = {
  makerReply: notificationSettings.makerReply, followedProject: notificationSettings.followedProject, followedMaker: notificationSettings.followedMaker,
  followedCategory: notificationSettings.followedCategory, newListingMine: notificationSettings.newListingMine,
} as const satisfies Record<EmailSettingKey, unknown>;
/** 이 종류를 «즉시» 메일로 받을 수 있는가 — 칸이 없거나(사이트 안에만) «즉시»를 고를 수 없는 칸(분야)이면 줄을 세지 않는다 */
function instantSetting(kind: NotificationKind): EmailSettingKey | null {
  const setting = EMAIL_SETTING_FOR_KIND[kind];
  return setting && (EMAIL_SETTING_CHOICES[setting] as readonly string[]).includes("instant") ? setting : null;
}

/**
 * 알림을 넣은 뒤 부른다 — 넣은 줄마다 그 종류의 메일 설정이 «즉시»(행이 없으면 기본값)이고 탈퇴하지 않았고 이메일 신원이 있으면
 * 발송함에 한 줄. 줄이 많아도 한 문장(INSERT … SELECT)이다. 부른 쪽 트랜잭션(lease 쓰기)을 받으면 그 안에서 savepoint 로 넣어
 * 실패해도 그 트랜잭션을 깨지 않는다. 무슨 일이 있어도 던지지 않는다: 메일은 덤이고 알림함이 본체다. 넣은 수
 */
export async function enqueueNotificationEmails(rows: readonly NotificationEmailSource[], executor: Executor = db): Promise<number> {
  const queued = rows.flatMap((row) => {
    const setting = instantSetting(row.kind);
    return setting ? [{ ...row, setting }] : [];
  });
  if (!queued.length || !emailLoginConfigured()) return 0;
  try {
    const mode = sql.join((Object.entries(SETTING_COLUMNS) as [EmailSettingKey, (typeof SETTING_COLUMNS)[EmailSettingKey]][])
      .map(([key, column]) => sql`when ${key} then coalesce(${column}, ${DEFAULT_NOTIFICATION_SETTINGS[key]})`), sql` `);
    const statement = (chunk: typeof queued) => sql`
      insert into ${emailOutbox} (user_id, kind, dedupe_key, payload)
      select n.user_id, n.kind, n.dedupe_key, jsonb_build_object('notificationId', n.id, 'setting', n.setting,
             'product', case when ${products.id} is null then null else jsonb_build_object('slug', ${products.slug}, 'name', ${products.name}) end)
        from (values ${sql.join(chunk.map((row) => sql`(${row.id}::bigint, ${row.userId}::int, ${row.kind}::varchar, ${row.productId ?? null}::int,
          ${notificationEmailDedupeKey(row.userId, row.dedupeKey)}::varchar, ${row.setting}::varchar)`), sql`, `)}) as n(id, user_id, kind, product_id, dedupe_key, setting)
        join ${publicUsers} on ${publicUsers.id} = n.user_id and ${publicUsers.deletedAt} is null
        left join ${notificationSettings} on ${notificationSettings.userId} = n.user_id
        left join ${products} on ${products.id} = n.product_id
       where (case n.setting ${mode} end) = 'instant'
         and exists (select 1 from ${publicIdentities} where ${publicIdentities.userId} = n.user_id and ${publicIdentities.provider} = 'email')
      on conflict (dedupe_key) do nothing
      returning id`;
    // 팔로가 많아도 한 문장의 인자 수(65,535)를 넘지 않게 1,000줄씩
    const insert = async (target: Executor) => {
      let total = 0;
      for (let start = 0; start < queued.length; start += 1_000) total += (await target.execute(statement(queued.slice(start, start + 1_000)))).length;
      return total;
    };
    const inserted = await onPrimary(() => executor === db ? insert(db) : executor.transaction((savepoint) => insert(savepoint)));
    return inserted;
  } catch (error) {
    logger.warn("me.email_enqueue_failed", { kinds: [...new Set(queued.map((row) => row.kind))], error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    return 0;
  }
}

type OutboxRow = typeof emailOutbox.$inferSelect;
const isEmailKind = (kind: string): kind is EmailKind => Object.hasOwn(EMAIL_SETTING_FOR_KIND, kind) && EMAIL_SETTING_FOR_KIND[kind as NotificationKind] !== null;
const productUrl = (locale: Locale, product: EmailProduct) => `${siteOrigin()}${localePath(locale, product ? `/p/${product.slug}` : "/me/alerts")}`;

function snapshot(value: unknown): EmailProduct {
  if (!value || typeof value !== "object") return null;
  const { slug, name } = value as Record<string, unknown>;
  return typeof slug === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(slug) && typeof name === "string" ? { slug, name } : null;
}

/** 보낼 글. 받을 사람이 없거나 그사이 설정을 껐으면 null(skipped) */
async function compose(row: OutboxRow): Promise<{ to: string; content: EmailContent; unsubscribe: string } | null> {
  if (!row.userId) return null;
  const recipient = await onPrimary(() => emailRecipient(row.userId!));
  if (!recipient) return null;
  const { settings, identity } = recipient;
  const locale = settings.locale;
  const settingsLink = alertSettingsUrl(locale);
  if (row.kind === "weekly_digest") {
    if (!weeklyKinds(settings).length) return null;
    const unsubscribe = unsubscribeUrl(row.userId, "weekly", locale);
    const raw = Array.isArray(row.payload.items) ? row.payload.items : [];
    const items: DigestItem[] = raw.flatMap((item) => {
      const value = item as Record<string, unknown>;
      if (typeof value.kind !== "string" || !isEmailKind(value.kind)) return [];
      const product = snapshot(value.product);
      return [{ kind: value.kind, product, url: productUrl(locale, product) }];
    });
    if (!items.length) return null;
    const total = typeof row.payload.total === "number" ? row.payload.total : items.length;
    return { to: identity.address, unsubscribe, content: await digestEmail(locale, items, total, { open: settingsLink, unsubscribe, settings: settingsLink }) };
  }
  const setting = EMAIL_SETTING_FOR_KIND[row.kind as NotificationKind];
  if (!isEmailKind(row.kind) || !setting || settings[setting] !== "instant") return null;
  const unsubscribe = unsubscribeUrl(row.userId, setting, locale);
  const product = snapshot(row.payload.product);
  return { to: identity.address, unsubscribe, content: await instantEmail(locale, row.kind, product, { open: productUrl(locale, product), unsubscribe, settings: settingsLink }) };
}

/**
 * 다음 한 줄을 잡는다 — 시도 횟수를 올리고 다음 시도 시각을 먼저 적는다(보내는 중 죽어도 그 시각 뒤 다시 잡힌다).
 * 상한까지 시도한 줄은 잡지 않는다 — attempts 가 check(0–10)를 넘어 틱마다 같은 줄에서 멈추지 않게
 */
function claimNext(lease: JobLease | undefined): Promise<OutboxRow | null> {
  return withJobLeaseWrite(lease, async (tx) => {
    const [row] = await tx.select().from(emailOutbox)
      .where(and(eq(emailOutbox.state, "pending"), lte(emailOutbox.nextAttemptAt, sql`now()`), lt(emailOutbox.attempts, EMAIL_MAX_ATTEMPTS)))
      .orderBy(emailOutbox.nextAttemptAt, emailOutbox.id).for("update", { skipLocked: true }).limit(1);
    if (!row) return null;
    const attempts = row.attempts + 1;
    const [claimed] = await tx.update(emailOutbox).set({
      attempts, nextAttemptAt: sql`now() + ${emailRetryDelayMs(attempts)} * interval '1 millisecond'`,
    }).where(eq(emailOutbox.id, row.id)).returning();
    return claimed;
  });
}

type Settled = "accepted" | "rejected" | "unknown" | "retry" | "skipped";
function settle(lease: JobLease | undefined, row: OutboxRow, result: Settled, error: string | null): Promise<void> {
  const change = result === "accepted" ? { state: "accepted" as const, sentAt: sql`now()`, lastError: null }
    : result === "retry" ? { lastError: error }
      : { state: result, lastError: error };
  return withJobLeaseWrite(lease, async (tx) => {
    await tx.update(emailOutbox).set(change).where(and(eq(emailOutbox.id, row.id), eq(emailOutbox.state, "pending")));
  });
}

export type OutboxTick = { accepted: number; rejected: number; retry: number; unknown: number; skipped: number };

/**
 * 발송함을 비운다(email-outbox-send). 한 틱에 limit 통까지, 한 통씩 차례로.
 * 발신 설정이 없으면 남은 줄을 skipped 로 닫는다 — 네트워크는 부르지 않는다.
 */
export async function sendPendingEmails(options: {
  lease?: JobLease; hasBudget?: () => boolean; signal?: AbortSignal; fetcher?: typeof fetch; limit?: number;
} = {}): Promise<OutboxTick> {
  const tick: OutboxTick = { accepted: 0, rejected: 0, retry: 0, unknown: 0, skipped: 0 };
  if (!emailLoginConfigured()) {
    const closed = await withJobLeaseWrite(options.lease, (tx) => tx.update(emailOutbox).set({ state: "skipped", lastError: "email_unconfigured" })
      .where(inArray(emailOutbox.id, tx.select({ id: emailOutbox.id }).from(emailOutbox).where(eq(emailOutbox.state, "pending")).limit(500)))
      .returning({ id: emailOutbox.id }));
    tick.skipped = closed.length;
    return tick;
  }
  // 상한까지 시도하고도 pending 으로 남은 줄(마지막 시도 중 죽었다) — 그 시도의 다음 시각이 지나면 결과를 모르는 채로 닫는다
  const exhausted = await withJobLeaseWrite(options.lease, (tx) => tx.update(emailOutbox).set({ state: "unknown", lastError: "attempts_exhausted" })
    .where(and(eq(emailOutbox.state, "pending"), lte(emailOutbox.nextAttemptAt, sql`now()`), gte(emailOutbox.attempts, EMAIL_MAX_ATTEMPTS)))
    .returning({ id: emailOutbox.id }));
  tick.unknown += exhausted.length;
  const limit = options.limit ?? 20;
  for (let sent = 0; sent < limit; sent += 1) {
    if (options.signal?.aborted || (options.hasBudget && !options.hasBudget())) break;
    const row = await claimNext(options.lease);
    if (!row) break;
    let composed: Awaited<ReturnType<typeof compose>>;
    try {
      composed = await compose(row);
    } catch (error) {
      // 끄기 열쇠의 비밀(PUBLIC_AUTH_SECRET)·주소가 없으면 여기서 멈춘다 — 줄은 그대로 두고 다음 시각에 다시 본다
      logger.error("me.email_compose_failed", { error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
      await settle(options.lease, row, row.attempts >= EMAIL_MAX_ATTEMPTS ? "unknown" : "retry", "compose_failed");
      tick[row.attempts >= EMAIL_MAX_ATTEMPTS ? "unknown" : "retry"] += 1;
      break;
    }
    if (!composed) {
      await settle(options.lease, row, "skipped", "recipient_or_setting_off");
      tick.skipped += 1;
      continue;
    }
    const state: EmailDeliveryState = await sendEmail({
      to: composed.to, subject: composed.content.subject, text: composed.content.text, html: composed.content.html,
      idempotencyKey: `nmv-email-${row.id}`,
      headers: { "List-Unsubscribe": `<${composed.unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }, options.fetcher);
    const result: Settled = state === "unknown" && row.attempts < EMAIL_MAX_ATTEMPTS ? "retry" : state;
    await settle(options.lease, row, result, state === "accepted" ? null : state);
    tick[result] += 1;
  }
  return tick;
}

/** 주간 요약에 담는 줄 수 — 나머지는 «더 있어요» 한 줄로 */
const DIGEST_ITEMS = 20;
const weeklyModes = () => or(
  eq(sql`coalesce(${notificationSettings.makerReply}, ${DEFAULT_NOTIFICATION_SETTINGS.makerReply})`, "weekly"),
  eq(sql`coalesce(${notificationSettings.followedProject}, ${DEFAULT_NOTIFICATION_SETTINGS.followedProject})`, "weekly"),
  eq(sql`coalesce(${notificationSettings.followedMaker}, ${DEFAULT_NOTIFICATION_SETTINGS.followedMaker})`, "weekly"),
  eq(sql`coalesce(${notificationSettings.followedCategory}, ${DEFAULT_NOTIFICATION_SETTINGS.followedCategory})`, "weekly"),
);

/**
 * 주간 요약을 줄 세운다(email-weekly-digest). 고른 요일(KST)에 고른 시각이 지났고 이번 주 요약이 아직 없는 계정마다
 * 지난 7일 안 읽은 «주간» 종류 알림을 한 통으로 묶는다. 묶을 것이 없으면 skipped 줄을 남겨 그 주에는 다시 보지 않는다.
 * 행이 없는 계정은 기본값(월요일 9시, 팔로한 프로젝트·분야 주간)을 따른다.
 */
export async function queueWeeklyDigests(options: { lease?: JobLease; hasBudget?: () => boolean; now?: Date; limit?: number } = {}): Promise<{ queued: number; empty: number }> {
  const result = { queued: 0, empty: 0 };
  if (!emailLoginConfigured()) return result;
  const now = options.now ?? new Date();
  const clock = kstClock(now);
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const limit = options.limit ?? 100;
  // 한 틱에 20묶음까지 — 넣은 줄은 다음 묶음에서 빠지므로 같은 계정을 두 번 보지 않는다
  for (let round = 0; round < 20; round += 1) {
    if (options.hasBudget && !options.hasBudget()) break;
    const candidates = await onPrimary(() => db.selectDistinct({ userId: publicUsers.id }).from(publicUsers)
      .innerJoin(publicIdentities, and(eq(publicIdentities.userId, publicUsers.id), eq(publicIdentities.provider, "email")))
      .leftJoin(notificationSettings, eq(notificationSettings.userId, publicUsers.id))
      .where(and(
        isNull(publicUsers.deletedAt),
        eq(sql`coalesce(${notificationSettings.digestWeekday}, ${DEFAULT_NOTIFICATION_SETTINGS.digestWeekday})`, clock.weekday),
        lte(sql`coalesce(${notificationSettings.digestHour}, ${DEFAULT_NOTIFICATION_SETTINGS.digestHour})`, clock.hour),
        weeklyModes(),
        notExists(db.select({ one: sql`1` }).from(emailOutbox)
          .where(eq(emailOutbox.dedupeKey, sql`'digest:' || ${publicUsers.id} || ':' || ${clock.week}::text`))),
      )).orderBy(publicUsers.id).limit(limit));
    if (!candidates.length) break;
    for (const { userId } of candidates) {
      const recipient = await onPrimary(() => emailRecipient(userId));
      const kinds = recipient ? weeklyKinds(recipient.settings) : [];
      const rows = kinds.length ? await onPrimary(() => db.select({ kind: notifications.kind, slug: products.slug, name: products.name }).from(notifications)
        .leftJoin(products, eq(products.id, notifications.productId))
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), gte(notifications.createdAt, since), inArray(notifications.kind, kinds)))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))) : [];
      const items = rows.slice(0, DIGEST_ITEMS).map((row) => ({ kind: row.kind, product: row.slug && row.name ? { slug: row.slug, name: row.name } : null }));
      await withJobLeaseWrite(options.lease, (tx) => tx.insert(emailOutbox).values({
        userId, kind: "weekly_digest", dedupeKey: digestDedupeKey(userId, clock.week),
        payload: { week: clock.week, items, total: rows.length },
        ...(items.length ? {} : { state: "skipped" as const, lastError: "empty" }),
      }).onConflictDoNothing({ target: emailOutbox.dedupeKey }));
      result[items.length ? "queued" : "empty"] += 1;
    }
    if (candidates.length < limit) break;
  }
  return result;
}

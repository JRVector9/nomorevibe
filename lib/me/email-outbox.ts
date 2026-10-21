import { createHash } from "node:crypto";
import { and, eq, exists, gt, gte, inArray, isNull, lt, lte, notExists, or, sql, type SQL } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { emailOutbox, notificationSettings, notifications } from "@/lib/db/me-schema";
import { publicIdentities, publicUsers } from "@/lib/db/public-user-schema";
import { products } from "@/lib/db/schema";
import { emailLoginConfigured, sendEmail } from "@/lib/domain/accounts/email-delivery";
import { publicAuthSecret } from "@/lib/domain/accounts/session";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { periodContaining } from "@/lib/domain/ranking/period";
import { localePath } from "@/lib/i18n/routing";
import type { Locale } from "@/lib/i18n/locales";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { logger } from "@/lib/observability/logger";
import { siteOrigin } from "@/lib/site";
import { EMAIL_SETTING_CHOICES, ME_TAB_PATHS, type EmailSettingKey, type NotificationKind } from "./contract";
import { digestEmail, emailDetail, instantEmail, type DigestItem, type EmailContent, type EmailDetail, type EmailKind, type EmailProduct } from "./email-copy";
import { DEFAULT_NOTIFICATION_SETTINGS, EMAIL_SETTING_FOR_KIND, emailRecipient, weeklyKinds, type EmailModes } from "./notification-settings";
import { alertSettingsUrl, unsubscribeUrl } from "./unsubscribe";

/**
 * 메일 발송함(MY7, 로그인 설계 L8) — 알림을 넣은 뒤 메일 한 통을 줄 세우고, maintenance 잡이 보낸다.
 * github_issue_outbox 와 같은 생각: 같은 일에는 한 줄(dedupe_key), 보내기 전에 다음 시도 시각을 먼저 적어 두고(그 사이 죽어도
 * 그 시각 뒤에 다시 잡힌다) 같은 Idempotency-Key 로 다시 보내 Resend 가 한 번만 보내게 한다.
 * - 줄 세우기는 DB(메일 설정·이메일 신원)만 본다 — 알림은 웹·발행·수집·maintenance 어디서든 생기고, 부른 프로세스의 발신 설정과 관계없다.
 * - 보낼지는 보내는 쪽(maintenance)이 정한다. 발신 설정(LOGIN_EMAIL_*·PUBLIC_AUTH_SECRET)이 없으면 줄을 건드리지 않고 기다리는 수만 경고한다.
 *   글 짓기 실패·키·도메인·한도처럼 우리 쪽 탓으로 못 보내면 시도로 세지 않고 미룬다 — 한 프로세스의 설정 빈틈으로 메일을 닫지 않는다.
 * - 쌓이는 양에 끝이 있다: 하루(EMAIL_STALE_MS) 안에 못 보낸 줄은 지난 소식이라 보내지 않고 닫고, 닫힌 줄은 30일 뒤 지운다(pruneEmailOutbox).
 *   발신 설정이 어디에도 없어도 발송함은 «하루치 대기 + 30일치 닫힌 줄»을 넘지 않는다.
 */
export const EMAIL_MAX_ATTEMPTS = 5;
/** n번째 시도가 실패했을 때 다음 시도까지(분) — 1·5·15·60 */
const BACKOFF_MINUTES = [1, 5, 15, 60];
export function emailRetryDelayMs(attempts: number): number {
  return BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1] * 60_000;
}
/** 우리 쪽 탓(글 짓기·키·도메인·한도)으로 못 보낸 줄을 다시 볼 때까지 — 시도로 세지 않는다 */
const DEFER_MS = 5 * 60_000;
/** 이보다 오래 못 보낸 줄은 보내지 않는다 — 발신 설정을 늦게 켜도 지난 소식이 한꺼번에 가지 않게 */
export const EMAIL_STALE_MS = 24 * 3_600_000;
/** 닫힌 줄(보냄·거절·모름·건너뜀)을 남겨 두는 날 수 */
export const EMAIL_OUTBOX_RETENTION_DAYS = 30;
const staleBefore = () => sql`now() - ${EMAIL_STALE_MS} * interval '1 millisecond'`;

/** 이 프로세스가 보낼 수 있는가 — 발신 키·보내는 주소와 끄기 링크의 서명 비밀(PUBLIC_AUTH_SECRET, 32자 이상)이 모두 있어야 한다 */
export function emailSenderConfigured(): boolean {
  if (!emailLoginConfigured()) return false;
  try {
    publicAuthSecret();
    return true;
  } catch {
    return false;
  }
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

/** KST 시각 — 요일(0=일요일)·시·주(2026-W43). 주는 분야 묶음(category_new)과 같은 periodContaining 의 주 열쇠다 */
export function kstClock(now: Date): { weekday: number; hour: number; week: string } {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  return { weekday: kst.getUTCDay(), hour: kst.getUTCHours(), week: periodContaining(now, "weekly").key };
}

export type NotificationEmailSource = {
  id: number; userId: number; kind: NotificationKind; productId?: number | null; payload?: Record<string, unknown>; dedupeKey: string;
};

type Executor = typeof db | ProductTransaction;
const SETTING_COLUMNS = {
  makerReply: notificationSettings.makerReply, followedProject: notificationSettings.followedProject, followedMaker: notificationSettings.followedMaker,
  followedCategory: notificationSettings.followedCategory, newListingMine: notificationSettings.newListingMine,
} as const satisfies Record<EmailSettingKey, unknown>;
/** 행이 없으면 기본값 — left join 한 notification_settings 의 칸 */
const mode = <K extends EmailSettingKey>(key: K) => sql<EmailModes[K]>`coalesce(${SETTING_COLUMNS[key]}, ${DEFAULT_NOTIFICATION_SETTINGS[key]})`;
/** 이 종류를 «즉시» 메일로 받을 수 있는가 — 칸이 없거나(사이트 안에만) «즉시»를 고를 수 없는 칸(분야)이면 줄을 세지 않는다 */
function instantSetting(kind: NotificationKind): EmailSettingKey | null {
  const setting = EMAIL_SETTING_FOR_KIND[kind];
  return setting && (EMAIL_SETTING_CHOICES[setting] as readonly string[]).includes("instant") ? setting : null;
}

/**
 * 알림을 넣은 뒤 부른다 — 넣은 줄마다 그 종류의 메일 설정이 «즉시»(행이 없으면 기본값)이고 탈퇴하지 않았고 이메일 신원이 있으면
 * 발송함에 한 줄. 부른 프로세스의 발신 설정은 보지 않는다(보낼지는 maintenance 가 정한다). 줄이 많아도 한 문장(INSERT … SELECT)이다.
 * 메일 글에 쓸 알림 payload(내려간 까닭)는 넣은 알림 줄을 id 로 다시 읽는다 — 부른 쪽 트랜잭션 안이면 그 줄이 보인다.
 * 부른 쪽 트랜잭션(lease 쓰기)을 받으면 그 안에서 savepoint 로 넣어 실패해도 그 트랜잭션을 깨지 않는다.
 * 무슨 일이 있어도 던지지 않는다: 메일은 덤이고 알림함이 본체다. 넣은 수
 */
export async function enqueueNotificationEmails(rows: readonly NotificationEmailSource[], executor: Executor = db): Promise<number> {
  const queued = rows.flatMap((row) => {
    const setting = instantSetting(row.kind);
    return setting ? [{ ...row, setting }] : [];
  });
  if (!queued.length) return 0;
  try {
    const choice = sql.join((Object.keys(SETTING_COLUMNS) as EmailSettingKey[]).map((key) => sql`when ${key} then ${mode(key)}`), sql` `);
    const statement = (chunk: typeof queued) => sql`
      insert into ${emailOutbox} (user_id, kind, dedupe_key, payload)
      select n.user_id, n.kind, n.dedupe_key, jsonb_build_object('notificationId', n.id, 'setting', n.setting,
             'product', case when ${products.id} is null then null else jsonb_build_object('slug', ${products.slug}, 'name', ${products.name}) end)
             || case when n.kind = 'followed_delisted' then jsonb_build_object('detail', jsonb_build_object('reason',
                  case when ${notifications.payload}->>'reason' = 'down' then 'down' else 'removed' end)) else '{}'::jsonb end
        from (values ${sql.join(chunk.map((row) => sql`(${row.id}::bigint, ${row.userId}::int, ${row.kind}::varchar, ${row.productId ?? null}::int,
          ${notificationEmailDedupeKey(row.userId, row.dedupeKey)}::varchar, ${row.setting}::varchar)`), sql`, `)}) as n(id, user_id, kind, product_id, dedupe_key, setting)
        join ${publicUsers} on ${publicUsers.id} = n.user_id and ${publicUsers.deletedAt} is null
        left join ${notificationSettings} on ${notificationSettings.userId} = n.user_id
        left join ${products} on ${products.id} = n.product_id
        left join ${notifications} on ${notifications.id} = n.id and ${notifications.userId} = n.user_id
       where (case n.setting ${choice} end) = 'instant'
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

/** 메일에서 누르면 갈 곳 — 알림함(lib/me/notification-view.ts)과 같게. 목록에서 내려간(removed) 제품은 상세가 없으므로 팔로 탭 */
function itemUrl(locale: Locale, kind: EmailKind, product: EmailProduct, detail: EmailDetail): string {
  const categories = detail.categories ?? [];
  const path = kind === "category_new" ? (categories.length && !detail.others ? `/c/${categories[0].category}?sort=recent` : ME_TAB_PATHS.following)
    : kind === "followed_delisted" && detail.reason !== "down" ? ME_TAB_PATHS.following
      : product ? `/p/${product.slug}` : ME_TAB_PATHS.alerts;
  return `${siteOrigin()}${localePath(locale, path)}`;
}

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
      const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
      if (typeof value.kind !== "string" || !isEmailKind(value.kind)) return [];
      const product = snapshot(value.product);
      const detail = emailDetail(value.kind, value.detail);
      return [{ kind: value.kind, product, detail, url: itemUrl(locale, value.kind, product, detail) }];
    });
    if (!items.length) return null;
    const total = typeof row.payload.total === "number" ? row.payload.total : items.length;
    return { to: identity.address, unsubscribe, content: await digestEmail(locale, items, total, { open: settingsLink, unsubscribe, settings: settingsLink }) };
  }
  const setting = EMAIL_SETTING_FOR_KIND[row.kind as NotificationKind];
  if (!isEmailKind(row.kind) || !setting || settings[setting] !== "instant") return null;
  const unsubscribe = unsubscribeUrl(row.userId, setting, locale);
  const product = snapshot(row.payload.product);
  const detail = emailDetail(row.kind, row.payload.detail);
  const links = { open: itemUrl(locale, row.kind, product, detail), unsubscribe, settings: settingsLink };
  return { to: identity.address, unsubscribe, content: await instantEmail(locale, row.kind, product, links, detail) };
}

/**
 * 다음 한 줄을 잡는다 — 시도 횟수를 올리고 다음 시도 시각을 먼저 적는다(보내는 중 죽어도 그 시각 뒤 다시 잡힌다).
 * 상한까지 시도한 줄은 잡지 않는다 — attempts 가 check(0–10)를 넘어 틱마다 같은 줄에서 멈추지 않게. 하루 지난 줄도 잡지 않는다
 */
function claimNext(lease: JobLease | undefined): Promise<OutboxRow | null> {
  return withJobLeaseWrite(lease, async (tx) => {
    const [row] = await tx.select().from(emailOutbox)
      .where(and(eq(emailOutbox.state, "pending"), lte(emailOutbox.nextAttemptAt, sql`now()`), lt(emailOutbox.attempts, EMAIL_MAX_ATTEMPTS),
        gt(emailOutbox.createdAt, staleBefore())))
      .orderBy(emailOutbox.nextAttemptAt, emailOutbox.id).for("update", { skipLocked: true }).limit(1);
    if (!row) return null;
    const attempts = row.attempts + 1;
    const [claimed] = await tx.update(emailOutbox).set({
      attempts, nextAttemptAt: sql`now() + ${emailRetryDelayMs(attempts)} * interval '1 millisecond'`,
    }).where(eq(emailOutbox.id, row.id)).returning();
    return claimed;
  });
}

/** deferred: 보내지 않았다 — 잡을 때 올린 시도 횟수를 되돌리고 DEFER_MS 뒤 다시 본다 */
type Settled = "accepted" | "rejected" | "unknown" | "retry" | "skipped" | "deferred";
function settle(lease: JobLease | undefined, row: OutboxRow, result: Settled, error: string | null): Promise<void> {
  const change = result === "accepted" ? { state: "accepted" as const, sentAt: sql`now()`, lastError: null }
    : result === "retry" ? { lastError: error }
      : result === "deferred" ? { attempts: Math.max(row.attempts - 1, 0), nextAttemptAt: sql`now() + ${DEFER_MS} * interval '1 millisecond'`, lastError: error }
        : { state: result, lastError: error };
  return withJobLeaseWrite(lease, async (tx) => {
    await tx.update(emailOutbox).set(change).where(and(eq(emailOutbox.id, row.id), eq(emailOutbox.state, "pending")));
  });
}

export type OutboxTick = { accepted: number; rejected: number; retry: number; unknown: number; skipped: number; deferred: number; waiting: number };

/**
 * 발송함을 비운다(email-outbox-send). 한 틱에 limit 통까지, 한 통씩 차례로.
 * 이 프로세스에 발신 설정이 없으면 줄을 건드리지 않는다 — 기다리는 수(waiting, 1,000까지)만 세어 경고하고 네트워크는 부르지 않는다.
 * 글을 짓지 못했거나(DB·문구 파일) Resend 가 키·도메인·한도로 거절하면 그 줄을 미루고 틱을 멈춘다 — 다음 줄도 같은 까닭으로 실패한다.
 */
export async function sendPendingEmails(options: {
  lease?: JobLease; hasBudget?: () => boolean; signal?: AbortSignal; fetcher?: typeof fetch; limit?: number;
} = {}): Promise<OutboxTick> {
  const tick: OutboxTick = { accepted: 0, rejected: 0, retry: 0, unknown: 0, skipped: 0, deferred: 0, waiting: 0 };
  if (!emailSenderConfigured()) {
    const [row] = await onPrimary(() => db.execute<{ waiting: number }>(sql`
      select count(*)::int as waiting from (select 1 from ${emailOutbox} where ${emailOutbox.state} = 'pending' limit 1000) pending`));
    tick.waiting = Number(row?.waiting ?? 0);
    if (tick.waiting) logger.warn("me.email_sender_unconfigured", { waiting: tick.waiting });
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
      // 보내기 전이다 — 시도로 세지 않고 미룬다(하루 안에 고치지 못하면 pruneEmailOutbox 가 닫는다)
      logger.error("me.email_compose_failed", { error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
      await settle(options.lease, row, "deferred", "compose_failed");
      tick.deferred += 1;
      break;
    }
    if (!composed) {
      await settle(options.lease, row, "skipped", "recipient_or_setting_off");
      tick.skipped += 1;
      continue;
    }
    const state = await sendEmail({
      to: composed.to, subject: composed.content.subject, text: composed.content.text, html: composed.content.html,
      idempotencyKey: `nmv-email-${row.id}`,
      headers: { "List-Unsubscribe": `<${composed.unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }, options.fetcher);
    if (state === "unavailable") {
      logger.error("me.email_provider_unavailable", {});
      await settle(options.lease, row, "deferred", "unavailable");
      tick.deferred += 1;
      break;
    }
    const result: Settled = state === "unknown" && row.attempts < EMAIL_MAX_ATTEMPTS ? "retry" : state;
    await settle(options.lease, row, result, state === "accepted" ? null : state);
    tick[result] += 1;
  }
  return tick;
}

const PRUNE_BATCH = 1_000;

/**
 * 발송함 정리 — 발신 설정과 관계없이 email-weekly-digest 잡이 먼저 부른다(15분마다).
 * 하루 안에 보내지 못한 줄은 닫는다: 보낸 적 없는 줄(attempts 0)은 skipped, 한 번이라도 보냈을 수 있는 줄은 unknown(last_error 'expired').
 * 30일 지난 닫힌 줄은 1,000줄씩 지운다. 주간 요약의 «이번 주 한 통»(dedupe)은 한 주만 있으면 된다.
 */
export async function pruneEmailOutbox(options: { lease?: JobLease; hasBudget?: () => boolean } = {}): Promise<{ expired: number; deleted: number }> {
  const result = { expired: 0, deleted: 0 };
  for (let round = 0; round < 20 && (!options.hasBudget || options.hasBudget()); round += 1) {
    const rows = await withJobLeaseWrite(options.lease, (tx) => tx.update(emailOutbox)
      .set({ state: sql`case when ${emailOutbox.attempts} = 0 then 'skipped' else 'unknown' end`, lastError: "expired" })
      .where(inArray(emailOutbox.id, tx.select({ id: emailOutbox.id }).from(emailOutbox)
        .where(and(eq(emailOutbox.state, "pending"), lte(emailOutbox.createdAt, staleBefore()))).limit(PRUNE_BATCH)))
      .returning({ id: emailOutbox.id }));
    result.expired += rows.length;
    if (rows.length < PRUNE_BATCH) break;
  }
  for (let round = 0; round < 20 && (!options.hasBudget || options.hasBudget()); round += 1) {
    const rows = await withJobLeaseWrite(options.lease, (tx) => tx.execute<{ id: string }>(sql`
      delete from ${emailOutbox} where id in (
        select id from ${emailOutbox} where state <> 'pending' and created_at < now() - make_interval(days => ${EMAIL_OUTBOX_RETENTION_DAYS})
         limit ${PRUNE_BATCH}
      ) returning id`));
    result.deleted += rows.length;
    if (rows.length < PRUNE_BATCH) break;
  }
  return result;
}

/** 주간 요약에 담는 줄 수 — 나머지는 «더 있어요» 한 줄로 */
const DIGEST_ITEMS = 20;
const weeklyModes = () => or(...(["makerReply", "followedProject", "followedMaker", "followedCategory"] as const).map((key) => eq(mode(key), "weekly")));
type DigestRow = { user_id: number; kind: NotificationKind; slug: string | null; name: string | null; payload: Record<string, unknown>; total: number };

/**
 * 주간 요약을 줄 세운다(email-weekly-digest). 고른 요일(KST)에 고른 시각이 지났고 이번 주 요약이 아직 없는 계정마다
 * 지난 7일 안 읽은 «주간» 종류 알림을 한 통으로 묶는다. 묶을 것이 없으면 skipped 줄을 남겨 그 주에는 다시 보지 않는다.
 * 행이 없는 계정은 기본값(월요일 9시, 팔로한 프로젝트·분야 주간)을 따른다. 요약 줄은 보내는 쪽이 만들므로 이 프로세스에 발신 설정이 있을 때만 넣는다.
 * 한 묶음(100계정)마다 후보·알림·넣기 세 문장 — 알림은 계정마다 최근 20줄과 전체 수를 창 함수로 한 번에 읽는다.
 */
export async function queueWeeklyDigests(options: { lease?: JobLease; hasBudget?: () => boolean; now?: Date; limit?: number } = {}): Promise<{ queued: number; empty: number }> {
  const result = { queued: 0, empty: 0 };
  if (!emailSenderConfigured()) return result;
  const now = options.now ?? new Date();
  const clock = kstClock(now);
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const limit = options.limit ?? 100;
  const modes = Object.fromEntries((Object.keys(SETTING_COLUMNS) as EmailSettingKey[]).map((key) => [key, mode(key)])) as { [K in EmailSettingKey]: SQL<EmailModes[K]> };
  // 한 틱에 20묶음까지 — 넣은 줄은 다음 묶음에서 빠지므로 같은 계정을 두 번 보지 않는다
  for (let round = 0; round < 20; round += 1) {
    if (options.hasBudget && !options.hasBudget()) break;
    const candidates = await onPrimary(() => db.select({ userId: publicUsers.id, ...modes }).from(publicUsers)
      .leftJoin(notificationSettings, eq(notificationSettings.userId, publicUsers.id))
      .where(and(
        isNull(publicUsers.deletedAt),
        exists(db.select({ one: sql`1` }).from(publicIdentities).where(and(eq(publicIdentities.userId, publicUsers.id), eq(publicIdentities.provider, "email")))),
        eq(sql`coalesce(${notificationSettings.digestWeekday}, ${DEFAULT_NOTIFICATION_SETTINGS.digestWeekday})`, clock.weekday),
        lte(sql`coalesce(${notificationSettings.digestHour}, ${DEFAULT_NOTIFICATION_SETTINGS.digestHour})`, clock.hour),
        weeklyModes(),
        notExists(db.select({ one: sql`1` }).from(emailOutbox)
          .where(eq(emailOutbox.dedupeKey, sql`'digest:' || ${publicUsers.id} || ':' || ${clock.week}::text`))),
      )).orderBy(publicUsers.id).limit(limit));
    if (!candidates.length) break;
    const wanted = candidates.flatMap((candidate) => weeklyKinds(candidate).map((kind) => sql`(${candidate.userId}::int, ${kind}::varchar)`));
    const found = wanted.length ? await onPrimary(() => db.execute<DigestRow>(sql`
      select user_id, kind, slug, name, payload, total from (
        select n.user_id, n.kind, p.slug, p.name, n.payload,
               row_number() over (partition by n.user_id order by n.created_at desc, n.id desc) as rank,
               count(*) over (partition by n.user_id)::int as total
          from ${notifications} n
          join (values ${sql.join(wanted, sql`, `)}) as w(user_id, kind) on w.user_id = n.user_id and w.kind = n.kind
          left join ${products} p on p.id = n.product_id
         where n.read_at is null and n.created_at >= ${since.toISOString()}::timestamptz
      ) ranked where rank <= ${DIGEST_ITEMS} order by user_id, rank`)) : [];
    const digests = new Map<number, { items: Record<string, unknown>[]; total: number }>();
    for (const row of found) {
      const digest = digests.get(row.user_id) ?? { items: [], total: Number(row.total) };
      const detail = emailDetail(row.kind, row.payload);
      digest.items.push({ kind: row.kind, product: row.slug && row.name ? { slug: row.slug, name: row.name } : null, ...(Object.keys(detail).length ? { detail } : {}) });
      digests.set(row.user_id, digest);
    }
    const inserted = await withJobLeaseWrite(options.lease, (tx) => tx.insert(emailOutbox).values(candidates.map(({ userId }) => {
      const digest = digests.get(userId);
      const row = { userId, kind: "weekly_digest", dedupeKey: digestDedupeKey(userId, clock.week) };
      return digest ? { ...row, payload: { week: clock.week, items: digest.items, total: digest.total } }
        : { ...row, payload: { week: clock.week, items: [], total: 0 }, state: "skipped" as const, lastError: "empty" };
    })).onConflictDoNothing({ target: emailOutbox.dedupeKey }).returning({ state: emailOutbox.state }));
    for (const row of inserted) result[row.state === "pending" ? "queued" : "empty"] += 1;
    if (candidates.length < limit) break;
  }
  return result;
}

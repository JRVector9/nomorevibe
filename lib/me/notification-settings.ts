import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { notificationSettings } from "@/lib/db/me-schema";
import { publicIdentities, publicUsers } from "@/lib/db/public-user-schema";
import { emailLoginConfigured } from "@/lib/domain/accounts/email-delivery";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { isLocale, type Locale } from "@/lib/i18n/locales";
import { EMAIL_SETTING_CHOICES, type EmailMode, type EmailSettingKey, type NotificationKind } from "./contract";

/**
 * 알림 설정(MY7, 로그인 설계 L8) — 사이트 안 알림함은 늘 켜져 있고, 여기서는 메일로 받을지만 정한다.
 * 이 모듈은 워커(메일 발송·주간 요약 잡)도 불러 쓰므로 server-only 를 붙이지 않는다.
 */
export const EMAIL_SETTING_KEYS = Object.keys(EMAIL_SETTING_CHOICES) as EmailSettingKey[];
type ModeOf<K extends EmailSettingKey> = (typeof EMAIL_SETTING_CHOICES)[K][number];
export type EmailModes = { [K in EmailSettingKey]: ModeOf<K> };
export type NotificationSettingsView = EmailModes & { digestWeekday: number; digestHour: number; newsOptIn: boolean; locale: Locale };

/** 행이 없을 때의 값 — drizzle/0108_mypage.sql 의 기본값과 같다 */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettingsView = {
  makerReply: "instant", followedProject: "weekly", followedMaker: "off", followedCategory: "weekly", newListingMine: "instant",
  digestWeekday: 1, digestHour: 9, newsOptIn: false, locale: "ko",
};

/** 알림 종류 → 메일 설정 칸. null 은 사이트 안에만 둔다(내 의견 검토 결과·받은편지함) */
export const EMAIL_SETTING_FOR_KIND: Record<NotificationKind, EmailSettingKey | null> = {
  maker_reply: "makerReply",
  followed_release: "followedProject",
  followed_delisted: "followedProject",
  maker_new_project: "followedMaker",
  category_new: "followedCategory",
  new_listing_mine: "newListingMine",
  comment_reviewed: null,
  inbox_new: null,
};

/** 이 설정에서 주간 요약으로 받는 알림 종류 */
export function weeklyKinds(settings: EmailModes): NotificationKind[] {
  return (Object.entries(EMAIL_SETTING_FOR_KIND) as [NotificationKind, EmailSettingKey | null][])
    .filter(([, key]) => key !== null && settings[key] === "weekly").map(([kind]) => kind);
}

export type NotificationSettingsInput = Partial<NotificationSettingsView>;
const INPUT_KEYS = new Set<string>([...EMAIL_SETTING_KEYS, "digestWeekday", "digestHour", "newsOptIn", "locale"]);

function allowedMode(key: EmailSettingKey, value: unknown): value is EmailMode {
  return typeof value === "string" && (EMAIL_SETTING_CHOICES[key] as readonly string[]).includes(value);
}

/** 바꿀 칸만 받는다. 모르는 칸·고를 수 없는 값·범위 밖 시각이 하나라도 있으면 null */
export function parseNotificationSettingsInput(body: Record<string, unknown>): NotificationSettingsInput | null {
  const keys = Object.keys(body);
  if (!keys.length || keys.some((key) => !INPUT_KEYS.has(key))) return null;
  const input: Record<string, unknown> = {};
  for (const key of EMAIL_SETTING_KEYS) {
    if (!(key in body)) continue;
    if (!allowedMode(key, body[key])) return null;
    input[key] = body[key];
  }
  for (const [key, max] of [["digestWeekday", 6], ["digestHour", 23]] as const) {
    if (!(key in body)) continue;
    const value = body[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) return null;
    input[key] = value;
  }
  if ("newsOptIn" in body) {
    if (typeof body.newsOptIn !== "boolean") return null;
    input.newsOptIn = body.newsOptIn;
  }
  if ("locale" in body) {
    if (!isLocale(body.locale)) return null;
    input.locale = body.locale;
  }
  return input as NotificationSettingsInput;
}

type SettingsRow = typeof notificationSettings.$inferSelect;
function view(row: SettingsRow | undefined): NotificationSettingsView {
  if (!row) return { ...DEFAULT_NOTIFICATION_SETTINGS };
  return {
    makerReply: row.makerReply, followedProject: row.followedProject, followedMaker: row.followedMaker,
    followedCategory: row.followedCategory, newListingMine: row.newListingMine,
    digestWeekday: row.digestWeekday, digestHour: row.digestHour, newsOptIn: row.newsOptInAt !== null, locale: row.locale,
  };
}

/** 메일 받는 주소 — 확인된 이메일 신원. 설정에 고른 신원이 있으면 그것, 없으면 가장 최근에 확인한 것 */
export type EmailIdentity = { id: number; address: string };
async function settingsRow(userId: number): Promise<SettingsRow | undefined> {
  const [row] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId));
  return row;
}
async function emailIdentity(userId: number, preferredId: number | null): Promise<EmailIdentity | null> {
  const rows = await db.select({ id: publicIdentities.id, address: publicIdentities.subject }).from(publicIdentities)
    .where(and(eq(publicIdentities.userId, userId), eq(publicIdentities.provider, "email")))
    .orderBy(desc(publicIdentities.verifiedAt), desc(publicIdentities.id)).limit(10);
  return rows.find((row) => row.id === preferredId) ?? rows[0] ?? null;
}

/** 메일을 받을 사람 — 탈퇴했거나 이메일 신원이 없으면 null */
export async function emailRecipient(userId: number): Promise<{ settings: NotificationSettingsView; identity: EmailIdentity } | null> {
  const [user] = await db.select({ id: publicUsers.id }).from(publicUsers).where(and(eq(publicUsers.id, userId), isNull(publicUsers.deletedAt)));
  if (!user) return null;
  const row = await settingsRow(userId);
  const identity = await emailIdentity(userId, row?.emailIdentityId ?? null);
  return identity ? { settings: view(row), identity } : null;
}

/** 보여 줄 주소 — 앞 두 글자와 도메인만. 한 글자 주소는 한 글자만 */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = address.slice(0, at);
  return `${local.slice(0, local.length > 2 ? 2 : 1)}***${address.slice(at)}`;
}

export type NotificationSettingsResponse = {
  settings: NotificationSettingsView;
  /** 메일 발신 설정이 있는가(LOGIN_EMAIL_*) — 없으면 화면은 메일 칸을 모두 숨긴다 */
  emailConfigured: boolean;
  /** 메일 받는 주소(가린 것). 이메일 신원이 없으면 null */
  emailAddress: string | null;
  /** 발신 설정이 있고 이메일 신원도 있다 — 이때만 메일 칸을 보인다 */
  emailAvailable: boolean;
};

export async function readNotificationSettings(userId: number): Promise<NotificationSettingsResponse> {
  return onPrimary(async () => {
    const row = await settingsRow(userId);
    const identity = await emailIdentity(userId, row?.emailIdentityId ?? null);
    const emailConfigured = emailLoginConfigured();
    return { settings: view(row), emailConfigured, emailAddress: identity ? maskEmail(identity.address) : null, emailAvailable: emailConfigured && identity !== null };
  });
}

/**
 * 설정을 쓰기 전에 계정 행을 잡는다(FOR SHARE). 탈퇴한 계정은 public_users 행이 deleted_at 과 함께 남는다 — 없는 계정으로 보고 쓰지 않는다.
 * 탈퇴(lib/me/account.ts)는 같은 행을 FOR UPDATE 로 잡고 설정을 지우므로, 탈퇴와 겹치면 그 뒤에 다시 보고 쓰지 않는다
 */
async function liveUser(tx: ProductTransaction, userId: number): Promise<boolean> {
  const [user] = await tx.select({ id: publicUsers.id }).from(publicUsers).where(and(eq(publicUsers.id, userId), isNull(publicUsers.deletedAt))).for("share");
  return Boolean(user);
}

/** 받은 칸만 바꾼다. 소식 동의는 처음 동의한 시각을 지키고, 끄면 지운다 */
export async function saveNotificationSettings(userId: number, input: NotificationSettingsInput): Promise<NotificationSettingsResponse> {
  await onPrimary(() => db.transaction(async (tx) => {
    if (!await liveUser(tx, userId)) return;
    const identity = await emailIdentity(userId, null);
    const modes = Object.fromEntries(EMAIL_SETTING_KEYS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
    const common = {
      ...modes,
      ...(input.digestWeekday !== undefined ? { digestWeekday: input.digestWeekday } : {}),
      ...(input.digestHour !== undefined ? { digestHour: input.digestHour } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(identity ? { emailIdentityId: identity.id } : {}),
    };
    await tx.insert(notificationSettings).values({
      userId, ...common, ...(input.newsOptIn !== undefined ? { newsOptInAt: input.newsOptIn ? sql`now()` : null } : {}),
    }).onConflictDoUpdate({
      target: notificationSettings.userId,
      set: {
        ...common, updatedAt: sql`now()`,
        ...(input.newsOptIn !== undefined ? { newsOptInAt: input.newsOptIn ? sql`coalesce(${notificationSettings.newsOptInAt}, now())` : null } : {}),
      },
    });
  }));
  return readNotificationSettings(userId);
}

/** 메일의 «이 알림 끄기» — 칸 하나, 주간 요약 전체(weekly), 소식(news) */
export const UNSUBSCRIBE_KEYS = [...EMAIL_SETTING_KEYS, "weekly", "news"] as const;
export type UnsubscribeKey = (typeof UNSUBSCRIBE_KEYS)[number];

export async function turnOffEmail(userId: number, key: UnsubscribeKey): Promise<void> {
  await onPrimary(() => db.transaction(async (tx) => {
    // 탈퇴했으면(행이 지워졌거나 deleted_at) 끌 것이 없다 — 설정 행을 다시 만들지 않는다
    if (!await liveUser(tx, userId)) return;
    const [row] = await tx.select().from(notificationSettings).where(eq(notificationSettings.userId, userId));
    const current = view(row);
    const change: Record<string, unknown> = key === "news" ? { newsOptInAt: null }
      : key === "weekly" ? Object.fromEntries(EMAIL_SETTING_KEYS.filter((name) => current[name] === "weekly").map((name) => [name, "off"]))
        : { [key]: "off" };
    await tx.insert(notificationSettings).values({ userId, ...change }).onConflictDoUpdate({
      target: notificationSettings.userId, set: { ...change, updatedAt: sql`now()` },
    });
  }));
}

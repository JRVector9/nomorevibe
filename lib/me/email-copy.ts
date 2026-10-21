import { createTranslator, type Dictionary, type MessageKey, type Translator } from "@/lib/i18n/messages";
import type { Locale } from "@/lib/i18n/locales";
import type { NotificationKind } from "./contract";
import { categoryKey, categoryOfKey } from "./follow-keys";

/**
 * 알림 메일 글 — 글자만 메일과 간단한 HTML 두 갈래. 추적 그림·추적 링크는 넣지 않는다.
 * 워커가 만들므로 lib/i18n/dictionary.ts(server-only) 대신 문구 파일을 바로 읽는다. 잡 목록이 이 파일까지 올리므로
 * 문구 파일은 보낼 때 늦게 읽는다 — messages/ 가 없는 워커 이미지(Oracle release)도 잡 목록은 올라온다.
 */
const CATALOGS: Record<Locale, () => Promise<Dictionary["me"]>> = {
  ko: () => import("@/messages/ko/me").then((module) => module.me),
  en: () => import("@/messages/en/me").then((module) => module.me),
  "zh-Hans": () => import("@/messages/zh-Hans/me").then((module) => module.me),
  "zh-Hant": () => import("@/messages/zh-Hant/me").then((module) => module.me),
};
/** 분야 이름(팔로한 분야 묶음) */
const LABELS: Record<Locale, () => Promise<Dictionary["labels"]>> = {
  ko: () => import("@/messages/ko/labels").then((module) => module.labels),
  en: () => import("@/messages/en/labels").then((module) => module.labels),
  "zh-Hans": () => import("@/messages/zh-Hans/labels").then((module) => module.labels),
  "zh-Hant": () => import("@/messages/zh-Hant/labels").then((module) => module.labels),
};
export async function meTranslator(locale: Locale): Promise<Translator<"me">> {
  return createTranslator("me", await (CATALOGS[locale] ?? CATALOGS.ko)());
}
async function labelsTranslator(locale: Locale): Promise<Translator<"labels">> {
  return createTranslator("labels", await (LABELS[locale] ?? LABELS.ko)());
}

export type EmailKind = Exclude<NotificationKind, "comment_reviewed" | "inbox_new">;
export type EmailProduct = { slug: string; name: string } | null;
export type EmailLinks = { open: string; unsubscribe: string; settings: string };
export type EmailContent = { subject: string; text: string; html: string };
/**
 * 알림 payload 가운데 메일 글에 쓰는 것 — 내려간 까닭(followed_delisted), 팔로한 분야 묶음의 분야·수(category_new).
 * 발송함에 넣을 때와 꺼내 쓸 때 모두 이 함수로 거른다
 */
export type EmailDetail = { reason?: "down" | "removed"; target?: "feedback" | "reaction"; categories?: { category: string; count: number }[]; total?: number; others?: number };
export type DigestItem = { kind: EmailKind; product: EmailProduct; url: string; detail?: EmailDetail };

const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;

export function emailDetail(kind: string, value: unknown): EmailDetail {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {};
  // 알림함(lib/me/notification-view.ts)과 같게 «down» 이 아니면 목록에서 내려간 것으로 본다
  if (kind === "followed_delisted") return { reason: payload.reason === "down" ? "down" : "removed" };
  // 알림함 줄은 원래 payload(feedbackId)를, 발송함은 줄 세울 때 적은 target 을 넘긴다
  if (kind === "maker_reply") return { target: payload.target === "feedback" || typeof payload.feedbackId === "string" ? "feedback" : "reaction" };
  if (kind !== "category_new") return {};
  const categories = (Array.isArray(payload.categories) ? payload.categories : []).flatMap((item) => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const category = typeof entry.category === "string" ? categoryOfKey(entry.category) : null;
    return category ? [{ category: categoryKey(category), count: count(entry.count) }] : [];
  }).slice(0, 3);
  return categories.length ? { categories, total: count(payload.total) || categories.reduce((sum, item) => sum + item.count, 0), others: count(payload.others) } : {};
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 제목 줄에 줄바꿈·제어 문자가 들어가지 않게 — 제품 이름은 바깥에서 온 글이다 */
function oneLine(value: string, max = 120): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function productName(t: Translator<"me">, product: EmailProduct): string {
  return product ? oneLine(product.name, 80) : t("email.someProject");
}

type Copy = { t: Translator<"me">; labels: Translator<"labels"> };

function line({ t, labels }: Copy, kind: EmailKind, product: EmailProduct, detail: EmailDetail = {}): string {
  const name = productName(t, product);
  if (kind === "followed_delisted" && detail.reason === "removed") return t("email.followed_delisted.removedBody", { product: name });
  if (kind === "category_new" && detail.categories?.length) {
    const first = categoryOfKey(detail.categories[0].category);
    // components/home/i18n 의 translatedCategory 와 같다 — 워커 이미지에는 components/ 가 없다
    const category = first ? labels(`category.${first}` as Extract<MessageKey<"labels">, `category.${string}`>) : detail.categories[0].category;
    const total = detail.total ?? detail.categories[0].count;
    return detail.others ? t("email.category_new.many", { category, count: total, others: detail.others }) : t("email.category_new.one", { category, count: total });
  }
  return t(`email.${kind}.body`, { product: name });
}

function subject(t: Translator<"me">, kind: EmailKind, product: EmailProduct, detail: EmailDetail): string {
  const name = productName(t, product);
  return kind === "followed_delisted" && detail.reason === "removed" ? t("email.followed_delisted.removedSubject", { product: name }) : t(`email.${kind}.subject`, { product: name });
}

function layout(t: Translator<"me">, body: { text: string[]; html: string }, links: EmailLinks): { text: string; html: string } {
  const text = [...body.text, "", `${t("email.footer")}`, `${t("email.unsubscribe")}: ${links.unsubscribe}`, `${t("email.settings")}: ${links.settings}`].join("\n");
  const html = [
    "<!doctype html><html><body style=\"margin:0;padding:24px;background:#ffffff;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;font-size:15px;line-height:1.6\">",
    "<p style=\"margin:0 0 16px;font-weight:600\">nomorevibe</p>",
    body.html,
    "<hr style=\"border:0;border-top:1px solid #e8e8ed;margin:24px 0 12px\">",
    `<p style="margin:0;font-size:13px;color:#6e6e73">${escapeHtml(t("email.footer"))}<br>`,
    `<a href="${escapeHtml(links.unsubscribe)}" style="color:#6e6e73">${escapeHtml(t("email.unsubscribe"))}</a> · `,
    `<a href="${escapeHtml(links.settings)}" style="color:#6e6e73">${escapeHtml(t("email.settings"))}</a></p>`,
    "</body></html>",
  ].join("");
  return { text, html };
}

async function copy(locale: Locale): Promise<Copy> {
  const [t, labels] = await Promise.all([meTranslator(locale), labelsTranslator(locale)]);
  return { t, labels };
}

export async function instantEmail(locale: Locale, kind: EmailKind, product: EmailProduct, links: EmailLinks, detail: EmailDetail = {}): Promise<EmailContent> {
  const words = await copy(locale);
  const { t } = words;
  const message = line(words, kind, product, detail);
  const body = {
    text: [message, "", `${t("email.open")}: ${links.open}`],
    html: `<p style="margin:0 0 16px">${escapeHtml(message)}</p><p style="margin:0"><a href="${escapeHtml(links.open)}" style="color:#c0323a">${escapeHtml(t("email.open"))}</a></p>`,
  };
  return { subject: oneLine(subject(t, kind, product, detail), 150), ...layout(t, body, links) };
}

/** 주간 요약 — 지난 7일 안 읽은 알림을 한 통에. total 이 items 보다 많으면 «더 있어요» 한 줄 */
export async function digestEmail(locale: Locale, items: readonly DigestItem[], total: number, links: EmailLinks): Promise<EmailContent> {
  const words = await copy(locale);
  const { t } = words;
  const lines = items.map((item) => ({ message: line(words, item.kind, item.product, item.detail), url: item.url }));
  const more = total > items.length ? t("email.digest.more", { count: total - items.length }) : null;
  const body = {
    text: [t("email.digest.intro"), "", ...lines.map((item) => `- ${item.message}\n  ${item.url}`), ...(more ? ["", more] : []), "", `${t("email.digest.open")}: ${links.open}`],
    html: [
      `<p style="margin:0 0 12px">${escapeHtml(t("email.digest.intro"))}</p><ul style="margin:0 0 16px;padding-left:20px">`,
      ...lines.map((item) => `<li style="margin:0 0 8px"><a href="${escapeHtml(item.url)}" style="color:#1d1d1f">${escapeHtml(item.message)}</a></li>`),
      "</ul>",
      more ? `<p style="margin:0 0 12px;color:#6e6e73">${escapeHtml(more)}</p>` : "",
      `<p style="margin:0"><a href="${escapeHtml(links.open)}" style="color:#c0323a">${escapeHtml(t("email.digest.open"))}</a></p>`,
    ].join(""),
  };
  return { subject: oneLine(t("email.digest.subject", { count: total }), 150), ...layout(t, body, links) };
}

import { createTranslator, type Dictionary, type Translator } from "@/lib/i18n/messages";
import type { Locale } from "@/lib/i18n/locales";
import type { NotificationKind } from "./contract";

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
export async function meTranslator(locale: Locale): Promise<Translator<"me">> {
  return createTranslator("me", await (CATALOGS[locale] ?? CATALOGS.ko)());
}

export type EmailKind = Exclude<NotificationKind, "comment_reviewed" | "inbox_new">;
export type EmailProduct = { slug: string; name: string } | null;
export type EmailLinks = { open: string; unsubscribe: string; settings: string };
export type EmailContent = { subject: string; text: string; html: string };
export type DigestItem = { kind: EmailKind; product: EmailProduct; url: string };

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

function line(t: Translator<"me">, kind: EmailKind, product: EmailProduct): string {
  return t(`email.${kind}.body`, { product: productName(t, product) });
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

export async function instantEmail(locale: Locale, kind: EmailKind, product: EmailProduct, links: EmailLinks): Promise<EmailContent> {
  const t = await meTranslator(locale);
  const message = line(t, kind, product);
  const body = {
    text: [message, "", `${t("email.open")}: ${links.open}`],
    html: `<p style="margin:0 0 16px">${escapeHtml(message)}</p><p style="margin:0"><a href="${escapeHtml(links.open)}" style="color:#c0323a">${escapeHtml(t("email.open"))}</a></p>`,
  };
  return { subject: oneLine(t(`email.${kind}.subject`, { product: productName(t, product) }), 150), ...layout(t, body, links) };
}

/** 주간 요약 — 지난 7일 안 읽은 알림을 한 통에. total 이 items 보다 많으면 «더 있어요» 한 줄 */
export async function digestEmail(locale: Locale, items: readonly DigestItem[], total: number, links: EmailLinks): Promise<EmailContent> {
  const t = await meTranslator(locale);
  const lines = items.map((item) => ({ message: line(t, item.kind, item.product), url: item.url }));
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

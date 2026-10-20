import { onPrimary } from "@/lib/db";
import { PUBLIC_PRIVATE_HEADERS } from "@/lib/domain/accounts/request-auth";
import { DEFAULT_LOCALE, isLocale, LOCALE_CONFIG, type Locale } from "@/lib/i18n/locales";
import { escapeHtml, meTranslator } from "@/lib/me/email-copy";
import { turnOffEmail, type UnsubscribeKey } from "@/lib/me/notification-settings";
import { alertSettingsUrl, verifyUnsubscribeToken } from "@/lib/me/unsubscribe";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";
import { logger } from "@/lib/observability/logger";
import { rateLimit, trustedClientIp } from "@/lib/rate-limit";

/**
 * 메일의 «이 알림 끄기»(MY7) — 로그인 없이 끈다. 서명한 열쇠(lib/me/unsubscribe.ts)가 곧 권한이라 Origin·CSRF 를 보지 않는다.
 * GET 은 확인 화면만 그린다(메일 보안 검사기가 링크를 미리 열어도 꺼지지 않게). 끄기는 그 화면의 단추와
 * 메일 앱의 한 번 끄기(RFC 8058 List-Unsubscribe-Post)가 보내는 POST 뿐이다.
 * 열쇠가 주소에 있으므로 Referer 로 새지 않게 막고, 저장하지 않는다.
 */
const HEADERS = { ...PUBLIC_PRIVATE_HEADERS, "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

function settingLabel(locale: Locale, key: UnsubscribeKey): string {
  const t = meTranslator(locale);
  return key === "weekly" ? t("unsubscribe.weekly") : key === "news" ? t("alertSettings.news") : t(`alertSettings.row.${key}`);
}

function page(locale: Locale, status: number, title: string, body: string, confirmAction?: string): Response {
  const t = meTranslator(locale);
  const html = `<!doctype html><html lang="${LOCALE_CONFIG[locale].htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · nomorevibe</title><style>`
    + ":root{color-scheme:light dark;--bg:#ffffff;--text:#1d1d1f;--text-2:#6e6e73;--border:#e8e8ed}"
    + "@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--text:#f0f3fa;--text-2:#98a2b8;--border:#232c42}}"
    + "body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Pretendard',system-ui,sans-serif}"
    + "main{max-width:480px;margin:0 auto;padding:56px 16px}h1{font-size:22px;line-height:1.3;margin:0 0 12px}p{margin:0 0 20px;color:var(--text-2)}"
    + "a,button{display:inline-flex;align-items:center;min-height:42px;padding:0 18px;border:1px solid var(--border);border-radius:980px;color:var(--text);background:none;text-decoration:none;font:inherit;font-size:14px;cursor:pointer}"
    + "form{margin:0 0 12px}button{background:var(--text);color:var(--bg);border-color:transparent;font-weight:600}"
    + `</style></head><body><main><p style="font-weight:600;color:var(--text)">nomorevibe</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`
    + (confirmAction ? `<form method="post" action="${escapeHtml(confirmAction)}"><button type="submit">${escapeHtml(t("unsubscribe.confirm"))}</button></form>` : "")
    + `<a href="${escapeHtml(alertSettingsUrl(locale))}">${escapeHtml(t("unsubscribe.settings"))}</a></main></body></html>`;
  return new Response(html, { status, headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" } });
}

async function unsubscribe(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const lang = url.searchParams.get("lang");
  const locale = isLocale(lang) ? lang : DEFAULT_LOCALE;
  const t = meTranslator(locale);
  const unavailable = () => page(locale, 503, t("unsubscribe.invalidTitle"), t("unsubscribe.unavailable"));
  try {
    // 열쇠를 먼저 본다 — 맞는 열쇠는 계정마다 넉넉히, 틀린 열쇠만 IP 로 센다(IP 를 모르면 모두가 한 통을 나눠 써 남의 끄기를 막게 된다)
    const verified = verifyUnsubscribeToken(url.searchParams.get("token"));
    if (!verified) {
      const ip = trustedClientIp(request);
      if (ip && !await onPrimary(() => rateLimit(`me-unsubscribe:ip:${ip}`, 60, 15 * 60_000))) return unavailable();
      return page(locale, 400, t("unsubscribe.invalidTitle"), t("unsubscribe.invalidBody"));
    }
    if (!await onPrimary(() => rateLimit(`me-unsubscribe:user:${verified.userId}`, 20, 15 * 60_000))) return unavailable();
    if (request.method === "GET") {
      // 같은 주소(열쇠 포함)로 POST 한다 — 상대 주소라 다른 곳으로 보내지 않는다
      const setting = settingLabel(locale, verified.key);
      return page(locale, 200, t("unsubscribe.confirmTitle"), t("unsubscribe.confirmBody", { setting }), `${url.pathname}${url.search}`);
    }
    await turnOffEmail(verified.userId, verified.key);
    return page(locale, 200, t("unsubscribe.title"), t("unsubscribe.body", { setting: settingLabel(locale, verified.key) }));
  } catch (error) {
    // 비밀이 없거나(PUBLIC_AUTH_SECRET) DB 에 쓰지 못하면 끄지 못했다고 말한다 — 메일 앱은 다시 보낸다
    logger.warn("me.unsubscribe_failed", { error: error instanceof Error ? error.name : "unknown" });
    return unavailable();
  }
}

/** 쓰는 GET 도 웹 쓰기 관문을 지난다 — fenced DB 면 쓰기 전에 거절한다(요청 언어를 모르므로 기본 언어 화면) */
const fenced = () => page(DEFAULT_LOCALE, 503, meTranslator(DEFAULT_LOCALE)("unsubscribe.invalidTitle"), meTranslator(DEFAULT_LOCALE)("unsubscribe.unavailable"));
export const GET = webWriteRoute(unsubscribe, fenced);
export const POST = webWriteRoute(unsubscribe, fenced);

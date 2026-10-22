import { ANALYTICS_OPT_OUT_KEY } from "@/lib/analytics/opt-out-key";

/**
 * 방문 분석 동의(Google Consent Mode v2) — 누구에게 켜고 누구에게 끄는가(2026-10-22).
 *
 * 광고 쪽(ad_storage·ad_user_data·ad_personalization)은 언제나 거부다. 광고 기능을 쓰지 않는다.
 *
 * analytics_storage(분석 쿠키)
 * - 기본은 허용.
 * - 끄는 경우: 이 브라우저에서 분석을 끈 사람(localStorage), Global Privacy Control(navigator.globalPrivacyControl),
 *   Do Not Track=1, 유럽 경제 지역·영국·스위스.
 *
 * 꺼진 사람에게는 쿠키 없는 신호(cookieless ping)도 보내지 않는다 — gtag 를 아예 불러오지 않는다. 더 안전한 쪽을 골랐다.
 * - 끄기·GPC·DNT 는 브라우저가 바로 알려 주므로 정확히 지킨다.
 * - 지역은 브라우저가 모른다. HTML 은 Cloudflare 에 60초씩 나라 구분 없이 저장되므로(next.config.ts) 서버가 나라 머리글로
 *   가를 수도 없다. 그래서 브라우저 시간대(Europe/* 등)로 먼저 거르고 — 넓게 잡아 러시아·터키 같은 유럽 시간대도 끈다 —
 *   시간대로 못 거른 방문자(유럽 밖 시간대를 쓰는 유럽 거주자)는 gtag 의 지역별 기본값(region 목록)으로 analytics_storage 를
 *   거부한다. 이 경우만 GA4 가 쿠키 없는 신호를 받는다(쿠키·클라이언트 ID 를 남기지 않는다).
 */

/** 유럽 경제 지역(EU 27 + 아이슬란드·리히텐슈타인·노르웨이)과 영국·스위스 — ISO 3166-1 alpha-2 */
export const CONSENT_DENIED_REGIONS: readonly string[] = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "GB", "CH",
];

/**
 * 유럽 경제 지역·영국·스위스로 보는 시간대. Europe/* 전부와 대서양 섬·EU 최외곽 지역·옛 별칭.
 * 넓게 잡는다 — 잘못 끄는 쪽이 잘못 켜는 쪽보다 낫다.
 */
const RESTRICTED_TIME_ZONES = new Set([
  "Atlantic/Reykjavik", "Atlantic/Canary", "Atlantic/Madeira", "Atlantic/Azores", "Atlantic/Faroe", "Atlantic/Faeroe",
  "Atlantic/Jan_Mayen", "Arctic/Longyearbyen", "America/Guadeloupe", "America/Martinique", "America/Cayenne",
  "America/Marigot", "America/St_Barthelemy", "Indian/Reunion", "Indian/Mayotte", "Africa/Ceuta",
  "GB", "GB-Eire", "Eire", "Iceland", "Poland", "Portugal", "WET", "CET", "MET", "EET",
]);

export function isRestrictedTimeZone(timeZone: string | null | undefined): boolean {
  if (!timeZone) return false;
  return timeZone.startsWith("Europe/") || RESTRICTED_TIME_ZONES.has(timeZone);
}

export { ANALYTICS_OPT_OUT_KEY };

export type ConsentSignals = {
  optOut: boolean;
  gpc: boolean;
  dnt: boolean;
  timeZone: string | null;
};

export type ConsentBlockReason = "opt_out" | "gpc" | "dnt" | "region";

export type ConsentDecision =
  | { load: true; reason: null }
  | { load: false; reason: ConsentBlockReason };

/** 불러올지 정한다 — 앞의 이유가 먼저 보인다(끄기 → GPC → DNT → 지역) */
export function decideConsent(signals: ConsentSignals): ConsentDecision {
  if (signals.optOut) return { load: false, reason: "opt_out" };
  if (signals.gpc) return { load: false, reason: "gpc" };
  if (signals.dnt) return { load: false, reason: "dnt" };
  if (isRestrictedTimeZone(signals.timeZone)) return { load: false, reason: "region" };
  return { load: true, reason: null };
}

/** readConsentSignals 가 읽는 브라우저 조각 — 시험에서 가짜로 넘긴다 */
export type ConsentBrowser = {
  navigator?: { globalPrivacyControl?: unknown; doNotTrack?: unknown; msDoNotTrack?: unknown };
  doNotTrack?: unknown;
  localStorage?: { getItem(key: string): string | null };
};

/** 브라우저에서 신호를 읽는다 — 어느 것이 막혀 있어도 던지지 않는다 */
export function readConsentSignals(win: ConsentBrowser | undefined = typeof window === "undefined" ? undefined : window as unknown as ConsentBrowser): ConsentSignals {
  let optOut = false;
  try { optOut = win?.localStorage?.getItem(ANALYTICS_OPT_OUT_KEY) === "1"; } catch { /* 저장소가 막혀 있으면 끄기 기록도 없다 */ }
  const nav = win?.navigator;
  const gpc = nav?.globalPrivacyControl === true;
  const dnt = [nav?.doNotTrack, win?.doNotTrack, nav?.msDoNotTrack].some((value) => value === "1" || value === "yes");
  let timeZone: string | null = null;
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null; } catch { /* 시간대를 모르면 지역으로 거르지 않는다 */ }
  return { optOut, gpc, dnt, timeZone };
}

/** gtag('consent', 'default', …) 로 보낼 두 줄 — 지역 목록이 먼저, 나머지 세계가 다음 */
export function consentDefaultCommands(): Array<Record<string, unknown>> {
  const ads = { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" };
  return [
    { ...ads, analytics_storage: "denied", region: [...CONSENT_DENIED_REGIONS] },
    { ...ads, analytics_storage: "granted" },
  ];
}

import { BRAND } from "@/lib/copy/brand";

/**
 * "✓ verified on nomorevibe" 배지.
 *
 * 메이커가 README에 붙이는 것이라 글자는 영어로 둔다. 검증된 제품에만 내주므로 배지 자체가
 * "도메인 소유권을 nomorevibe가 확인했다"는 뜻이다 — 그래서 문구가 고정이고, 고정이라
 * 글자 폭을 재지 않아도 된다.
 *
 * 남의 README에 이미 박혀 있다(<API>/badge/<slug>.svg). 주소·가로세로는 바꾸지 않는다 — 바뀌면 그 README들의 줄 맞춤이 흔들린다.
 * 글자만 브랜드 표기(소문자, UX-39)로 바꿨다. Verdana 11px 로 'NoMoreVibe' 약 66px, 'nomorevibe' 약 65px 라 왼쪽 칸(82px)에 그대로 들어간다.
 *
 * 색은 화면 토큰과 같다(--text, --up). 그라디언트 없이 두 칸으로 평평하게 그린다.
 */
const LEFT = BRAND;
const RIGHT = "✓ verified";
const LEFT_WIDTH = 82;
const RIGHT_WIDTH = 74;
const HEIGHT = 20;

export const BADGE_CONTENT_TYPE = "image/svg+xml; charset=utf-8";

export function verifiedBadgeSvg(): string {
  const width = LEFT_WIDTH + RIGHT_WIDTH;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" role="img" aria-label="Verified on ${BRAND}">`,
    `<title>Verified on ${BRAND}</title>`,
    `<clipPath id="r"><rect width="${width}" height="${HEIGHT}" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${LEFT_WIDTH}" height="${HEIGHT}" fill="#10141c"/>`,
    `<rect x="${LEFT_WIDTH}" width="${RIGHT_WIDTH}" height="${HEIGHT}" fill="#0a7d4f"/>`,
    `</g>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="${LEFT_WIDTH / 2}" y="14">${LEFT}</text>`,
    `<text x="${LEFT_WIDTH + RIGHT_WIDTH / 2}" y="14" font-weight="bold">${RIGHT}</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
}

/**
 * 공개 제품 누구나 다는 배지(SNS 설계 T12, M5) — «소개됨»과 «써본 사람 N»(3명부터). 사실만 말하고 품질 보증처럼 읽히는 말은 쓰지 않는다.
 * 기본 글자는 위 배지처럼 영어(listed), ?lang=ko 면 한국어. 위 «verified» 배지는 그대로 둔다 — 주소·가로세로를 바꾸지 않는다.
 * 오른쪽 칸 폭은 글자로 어림하고 textLength 로 맞춘다(글꼴이 달라도 칸을 넘지 않는다). 색은 SNS 설계 배지 색.
 */
export type BadgeLang = "en" | "ko";
const BADGE_LEFT_COLOR = "#2b2f38";
const LISTED_COLOR = "#c0323a";
const TRIED_COLOR = "#1e7b3c";
/** 써본 사람 숫자는 3명부터(피드백 설계의 «3명 미만이면 아직 적어요») */
export const TRIED_BADGE_MIN = 3;

export function escapeXml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function formatBadgeCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.floor(value)));
}

/** Verdana 11px 어림 폭 — 한글·한자는 한 칸, 숫자·대문자는 7px 남짓 */
export function badgeTextWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\u2e80-\u9fff\uf900-\ufaff]/.test(char)) width += 11;
    else if (/[0-9A-Z#]/.test(char)) width += 7.2;
    else if (char === " ") width += 3.9;
    else if (/[il.,:;'|!·]/.test(char)) width += 3.4;
    else if (/[mw]/.test(char)) width += 9.6;
    else width += 6.3;
  }
  return Math.ceil(width);
}

function factBadge(message: string, color: string, title: string): string {
  const textWidth = badgeTextWidth(message);
  const right = textWidth + 14;
  const width = LEFT_WIDTH + right;
  const label = escapeXml(title);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" role="img" aria-label="${label}">`,
    `<title>${label}</title>`,
    `<clipPath id="r"><rect width="${width}" height="${HEIGHT}" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${LEFT_WIDTH}" height="${HEIGHT}" fill="${BADGE_LEFT_COLOR}"/>`,
    `<rect x="${LEFT_WIDTH}" width="${right}" height="${HEIGHT}" fill="${color}"/>`,
    `</g>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="${LEFT_WIDTH / 2}" y="14">${LEFT}</text>`,
    `<text x="${LEFT_WIDTH + right / 2}" y="14" textLength="${textWidth}" lengthAdjust="spacingAndGlyphs">${escapeXml(message)}</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
}

export function listedBadgeSvg(name: string, lang: BadgeLang = "en"): string {
  return lang === "ko"
    ? factBadge("소개됨", LISTED_COLOR, `${name} — ${BRAND}에 소개됨`)
    : factBadge("listed", LISTED_COLOR, `${name} is listed on ${BRAND}`);
}

export function triedBadgeSvg(name: string, count: number, lang: BadgeLang = "en"): string {
  const value = formatBadgeCount(count);
  return lang === "ko"
    ? factBadge(`써본 사람 ${value}`, TRIED_COLOR, `${name} — ${BRAND} 써본 사람 ${value}`)
    : factBadge(`tried by ${value}`, TRIED_COLOR, `${name}: tried by ${value} on ${BRAND}`);
}

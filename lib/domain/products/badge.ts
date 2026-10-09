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

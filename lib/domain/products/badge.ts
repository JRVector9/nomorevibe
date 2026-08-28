/**
 * "✓ verified on NoMoreVibe" 배지.
 *
 * 메이커가 README에 붙이는 것이라 글자는 영어로 둔다. 검증된 제품에만 내주므로 배지 자체가
 * "도메인 소유권을 NoMoreVibe가 확인했다"는 뜻이다 — 그래서 문구가 고정이고, 고정이라
 * 글자 폭을 재지 않아도 된다.
 *
 * 색은 화면 토큰과 같다(--text, --up). 그라디언트 없이 두 칸으로 평평하게 그린다.
 */
const LEFT = "NoMoreVibe";
const RIGHT = "✓ verified";
const LEFT_WIDTH = 82;
const RIGHT_WIDTH = 74;
const HEIGHT = 20;

export const BADGE_CONTENT_TYPE = "image/svg+xml; charset=utf-8";

export function verifiedBadgeSvg(): string {
  const width = LEFT_WIDTH + RIGHT_WIDTH;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" role="img" aria-label="Verified on NoMoreVibe">`,
    `<title>Verified on NoMoreVibe</title>`,
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

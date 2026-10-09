/* eslint-disable @next/next/no-img-element -- OG 썸네일은 크기를 미리 알 수 없는 동적 이미지라 next/image 최적화 대상이 아님 */

import type { Category } from "@/lib/domain/products/categories";
import { thumbnailPresentation } from "@/lib/domain/products/thumbnails/presentation";
import { ogVariantSrc } from "@/lib/domain/products/og-variants";

/** 타일 바탕색 이름 — globals.css 의 --tile-* 토큰과 같다(다크에서는 어두운 값으로 바뀐다) */
const TILE_TINTS = ["paper", "day", "invoice", "form", "hue", "note"] as const;
export type TileTint = (typeof TILE_TINTS)[number];

/** 분야의 색 — 가까운 분야는 같은 색을 쓴다. 모노그램 타일이 이 색으로 분야를 알린다 */
const CATEGORY_TINTS: Record<Category, TileTint> = {
  Dev: "day", Data: "day", Security: "day",
  Productivity: "note", Plugin: "note", Skill: "note",
  Design: "hue", Media: "hue", Games: "hue", Social: "hue",
  Business: "invoice", Marketing: "invoice", Finance: "invoice", Commerce: "invoice",
  Education: "form", Health: "form", Sports: "form", Lifestyle: "form",
  Profile: "paper", Other: "paper",
};

/** 분야가 있으면 분야 색, 없으면 key(slug·이름)로 정한 색 — 같은 값은 늘 같은 색이다 */
export function tileTint(category: string | null | undefined, key: string): TileTint {
  const tint = category ? CATEGORY_TINTS[category as Category] : undefined;
  if (tint) return tint;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash + key.charCodeAt(index) * (index + 1)) % TILE_TINTS.length;
  }
  return TILE_TINTS[hash];
}

/** 모노그램 글자 — 이름의 첫 글자나 숫자("@scope/pkg" → S). 이모지도 반쪽으로 자르지 않는다 */
function monogramLetter(name: string): string {
  const letter = name.match(/[\p{L}\p{N}]/u)?.[0] ?? Array.from(name.trim())[0] ?? "?";
  return letter.toUpperCase();
}

/**
 * 정사각 아이콘 자리 — 사이트 아이콘·GitHub 프로필 그림만 쓴다(UX-32).
 * 대표 이미지(OG 배너)·README 그림을 정사각에 잘라 넣으면 글자 조각만 보인다. 그 그림은 대표 이미지 구획에만 둔다.
 * 아이콘이 없으면 이름 첫 글자와 분야 색으로 만든 모노그램 타일이다.
 */
export function ProductIcon({
  name,
  ogImage,
  size,
  category,
}: {
  name: string;
  ogImage: string | null;
  size: number;
  /** 모노그램 바탕색을 정하는 분야. 없으면 이름으로 색을 고른다 */
  category?: string | null;
}) {
  const presentation = ogImage ? thumbnailPresentation(ogImage) : null;
  if (ogImage && presentation?.icon) {
    // 작은 아이콘(32px 파비콘 등)은 늘리지 않는다 — 여백으로 제 크기에 두면 흐려지지 않는다
    const natural = Math.max(presentation.width, presentation.height);
    const padding = natural < size ? Math.max(4, Math.floor((size - natural) / 2)) : 4;
    return (
      <img
        src={ogVariantSrc(ogImage, size > 96 ? 320 : 192)!}
        alt={name}
        width={size}
        height={size}
        className="shrink-0 rounded-[10px] border border-line bg-bg-soft object-contain"
        style={{ width: size, height: size, padding }}
      />
    );
  }
  // 이니셜도 화면 글자다 — 작은 아이콘(28px)에서도 최소 글자 13px 아래로 내리지 않는다. 이름이 옆에 있으니 읽기 도구에는 숨긴다
  return (
    <span
      aria-hidden="true"
      className="product-monogram inline-flex shrink-0 items-center justify-center rounded-[10px] font-bold text-fg"
      style={{ width: size, height: size, background: `var(--tile-${tileTint(category, name)})`, fontSize: Math.max(13, size * 0.42) }}
    >
      {monogramLetter(name)}
    </span>
  );
}

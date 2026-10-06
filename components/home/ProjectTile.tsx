/* eslint-disable @next/next/no-img-element -- 내부에 저장한 썸네일의 원본 비율과 크기를 그대로 쓴다 */
import { ProductIcon } from "@/components/ProductIcon";
import { thumbnailPresentation } from "@/lib/domain/products/thumbnails/presentation";
import { ogVariantSrc } from "@/lib/domain/products/og-variants";

/**
 * 카드 커버 — 대표 이미지는 전체 폭으로, 아이콘은 옅은 바탕 가운데로.
 * 넓은 저장소 로고도 자르지 않고 원본 비율을 지킨다.
 * 바탕색은 slug 로 정해 같은 제품은 늘 같은 색이다.
 */
const TINTS = ["paper", "day", "invoice", "form", "hue", "note"] as const;
export type TileTint = (typeof TINTS)[number];

export function tileTintFor(slug: string): TileTint {
  let hash = 0;
  for (let index = 0; index < slug.length; index += 1) {
    hash = (hash + slug.charCodeAt(index) * (index + 1)) % TINTS.length;
  }
  return TINTS[hash];
}

export function ProjectTile({ slug, name, ogImage, size, installable = false }: {
  slug: string;
  name: string;
  ogImage: string | null;
  /** 기존 큰 카드와 작은 카드의 구분 */
  size: 64 | 44;
  installable?: boolean;
}) {
  const internalImage = ogImage?.startsWith("/") && !ogImage.startsWith("//") ? ogImage : null;
  const presentation = thumbnailPresentation(internalImage);
  return (
    <span className={`project-tile tile-${tileTintFor(slug)} tile-${size}`}>
      {internalImage && !presentation.identity ? (
        <img src={ogVariantSrc(internalImage, 640)!} alt={`${name} · ${presentation.label}`} width={presentation.width} height={presentation.height} className="tile-preview" loading="lazy" />
      ) : (
        <span className="tile-icon"><ProductIcon name={name} ogImage={internalImage} size={size === 64 ? 96 : 64} /></span>
      )}
      {installable && <span className="tile-flag">직접 설치</span>}
    </span>
  );
}

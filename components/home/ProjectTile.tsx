/* eslint-disable @next/next/no-img-element -- 내부에 저장한 썸네일의 원본 비율과 크기를 그대로 쓴다 */
import { ProductIcon, tileTint } from "@/components/ProductIcon";
import { thumbnailPresentation } from "@/lib/domain/products/thumbnails/presentation";
import { ogVariantSrc } from "@/lib/domain/products/og-variants";

/**
 * 카드 커버 — 카드의 대표 이미지 구획이다. 대표 이미지·README 그림은 전체 폭으로 자르지 않고,
 * 아이콘(사이트 아이콘·GitHub 프로필)은 옅은 바탕 가운데로, 아이콘이 없으면 분야 색 모노그램을 가운데 둔다(UX-32).
 * 바탕색은 slug 로 정해 같은 제품은 늘 같은 색이다.
 * 커버 규칙(토큰 바탕·README 그림)은 cards.css 에 있고 이 커버를 쓰는 카드(ProjectCard·CompactCard)가 가져온다 —
 * 여기서 CSS 를 가져오면 Node 에서 마크업만 그리는 검사(e2e thumbnail-fallback)가 깨진다.
 */
export function ProjectTile({ slug, name, ogImage, size, installable = false, category }: {
  slug: string;
  name: string;
  ogImage: string | null;
  /** 기존 큰 카드와 작은 카드의 구분 */
  size: 64 | 44;
  installable?: boolean;
  /** 모노그램 색을 정하는 분야 */
  category?: string;
}) {
  const internalImage = ogImage?.startsWith("/") && !ogImage.startsWith("//") ? ogImage : null;
  const presentation = thumbnailPresentation(internalImage);
  const preview = internalImage && (presentation.kind === "og" || presentation.kind === "repository_image");
  return (
    <span className={`project-tile tile-${tileTint(null, slug)} tile-${size}`}>
      {preview ? (
        <img
          src={ogVariantSrc(internalImage, 640)!}
          alt={`${name} · ${presentation.label}`}
          width={presentation.width}
          height={presentation.height}
          // 작은 README 로고는 늘리지 않는다(scale-down) — 대표 이미지는 커버에 맞춘다
          className={`tile-preview${presentation.kind === "repository_image" ? " tile-preview-readme" : ""}`}
          loading="lazy"
        />
      ) : (
        <span className="tile-icon"><ProductIcon name={name} ogImage={internalImage} size={size === 64 ? 96 : 64} category={category} /></span>
      )}
      {installable && <span className="tile-flag">직접 설치</span>}
    </span>
  );
}

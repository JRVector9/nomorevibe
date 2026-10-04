import { ProductIcon } from "@/components/ProductIcon";

/**
 * 카드 커버 — 옅은 바탕 타일 위 아이콘 하나.
 *
 * 공개 제품의 54%는 256px 사이트 아이콘·GitHub 아바타뿐이고 메이커 스크린샷은 0이다(2026-10-02).
 * 이미지 종류가 달라도 카드 모양이 같아야 하므로 어떤 이미지든 작은 아이콘으로 줄여 쓴다.
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
  /** 아이콘 한 변 — 큰 카드 64, 작은 카드 44 */
  size: 64 | 44;
  installable?: boolean;
}) {
  return (
    <span className={`project-tile tile-${tileTintFor(slug)} tile-${size}`}>
      <span className="tile-icon"><ProductIcon name={name} ogImage={ogImage?.startsWith("/") ? ogImage : null} size={size} /></span>
      {installable && <span className="tile-flag">직접 설치</span>}
    </span>
  );
}

import { ProductIcon } from "@/components/ProductIcon";
import { thumbnailPresentation } from "@/lib/domain/products/thumbnails/presentation";
const ARTS = ["paper", "day", "invoice", "form", "hue", "note"] as const;
export type CoverArt = (typeof ARTS)[number];

export function coverArtFor(slug: string): CoverArt {
  let hash = 0;
  for (let index = 0; index < slug.length; index += 1) {
    hash = (hash + slug.charCodeAt(index) * (index + 1)) % ARTS.length;
  }
  return ARTS[hash];
}

export function ProjectCover({
  name,
  ogImage,
  art,
}: {
  name: string;
  ogImage: string | null;
  art: CoverArt;
}) {
  const presentation = thumbnailPresentation(ogImage);
  const safeImage = ogImage?.startsWith("/") ? ogImage : null;
  if (safeImage) {
    return (
      <span className={`project-cover cover-photo${presentation.identity ? " cover-identity" : ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- 목록 커버는 크기를 미리 알 수 없는 동적 이미지 */}
        <img src={safeImage} alt={presentation.label} style={presentation.identity ? { width: Math.min(presentation.width, 96), height: Math.min(presentation.height, 96) } : undefined} />
        <span className="cover-brand">{name.toLowerCase()}</span>
      </span>
    );
  }

  return (
    <span className={`project-cover cover-${art}`}>
      <span className="cover-brand">{name.toLowerCase()}</span>
      <span className="cover-default"><ProductIcon name={name} ogImage={null} size={64} /><small>nomorevibe</small></span>
    </span>
  );
}

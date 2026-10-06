/* eslint-disable @next/next/no-img-element -- OG 썸네일은 크기를 미리 알 수 없는 동적 이미지라 next/image 최적화 대상이 아님 */

import { thumbnailPresentation } from "@/lib/domain/products/thumbnails/presentation";
import { ogVariantSrc } from "@/lib/domain/products/og-variants";

// OG 이미지가 있으면 썸네일, 없으면 이니셜 아바타 폴백
const AVATAR_COLORS = ["#2d4a8a", "#7a3aa0", "#2a7a5a", "#a05a2a", "#8a2d4a", "#4a2d8a", "#2a6a8a"];

export function ProductIcon({
  name,
  ogImage,
  size,
}: {
  name: string;
  ogImage: string | null;
  size: number;
}) {
  if (ogImage) {
    const presentation = thumbnailPresentation(ogImage);
    // 작은 아이콘(32px 파비콘 등)은 늘리지 않는다 — 여백으로 제 크기에 두면 흐려지지 않는다
    const natural = Math.max(presentation.width, presentation.height);
    const padding = presentation.contain && natural < size ? Math.max(4, Math.floor((size - natural) / 2)) : 4;
    return (
      <img
        src={ogVariantSrc(ogImage, size > 96 ? 320 : 192)!}
        alt={name}
        width={size}
        height={size}
        className={`shrink-0 rounded-[10px] border border-line ${presentation.contain ? "object-contain bg-bg-soft" : "object-cover"}`}
        style={{ width: size, height: size, padding: presentation.contain ? padding : undefined }}
      />
    );
  }
  const color = AVATAR_COLORS[name.length % AVATAR_COLORS.length];
  // 이니셜도 화면 글자다 — 작은 아이콘(28px)에서도 최소 글자 13px 아래로 내리지 않는다
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[10px] font-extrabold text-white"
      style={{ width: size, height: size, background: color, fontSize: Math.max(13, size * 0.42) }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

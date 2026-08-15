/* eslint-disable @next/next/no-img-element -- OG 썸네일은 크기를 미리 알 수 없는 동적 이미지라 next/image 최적화 대상이 아님 */

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
    return (
      <img
        src={ogImage}
        alt={name}
        width={size}
        height={size}
        className="shrink-0 rounded-[10px] border border-line object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  const color = AVATAR_COLORS[name.length % AVATAR_COLORS.length];
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[10px] font-extrabold text-white"
      style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

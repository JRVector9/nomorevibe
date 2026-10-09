/* eslint-disable @next/next/no-img-element -- 검증 후 내부에 보관한 이미지를 저장 치수 그대로 제공한다. */
import { formatPublicDate } from "@/lib/format/time";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { thumbnailPresentation } from "@/lib/domain/products/thumbnails/presentation";
import { ogVariantSrc } from "@/lib/domain/products/og-variants";

/**
 * 넓은 이미지가 있을 때만 — 오른쪽 열에 작게. 화면 사본이 있으면 첫 장, 없으면 넓은 대표 이미지.
 * 아이콘뿐이면(공개 제품의 54%) 아무것도 그리지 않는다. 바깥 주소는 쓰지 않는다 — '//' 로 시작하는 것도 바깥이다.
 * README 이미지는 정사각 로고여도 여기 둔다 — 히어로 아이콘 자리는 사이트 아이콘·GitHub 아바타만 쓰므로(UX-32) 다른 곳에 보일 자리가 없다.
 * 작은 로고는 늘리지 않고 원래 크기대로 가운데 둔다(카드 표지와 같다).
 */
export function PreviewFigure({ product, media }: { product: ProductDetailView["product"]; media: ProductDetailView["media"] }) {
  const first = media[0] ?? null;
  const internal = product.ogImage?.startsWith("/") && !product.ogImage.startsWith("//") ? product.ogImage : null;
  const thumbnail = internal ? thumbnailPresentation(internal) : null;
  const shown = first
    ? { src: first.src, width: first.width, height: first.height, caption: first.altText || `${product.name} 제품 화면`, at: first.lastSuccessAt, missing: first.sourceMissing, contain: false }
    : internal && thumbnail && (thumbnail.kind === "og" || thumbnail.kind === "repository_image")
      ? { src: ogVariantSrc(internal, 1200)!, width: thumbnail.width, height: thumbnail.height, caption: thumbnail.label, at: null, missing: false,
        contain: thumbnail.kind === "repository_image" }
      : null;
  if (!shown) return null;

  return (
    <figure className="m-0 flex flex-col gap-2 rounded-[18px] bg-bg-soft p-3 pb-2.5">
      <img src={shown.src} width={shown.width} height={shown.height} alt={shown.caption} loading="lazy" className={`h-auto w-full rounded-[10px] ${shown.contain ? "max-h-64 object-scale-down" : "object-cover"}`} />
      <figcaption className="flex flex-wrap justify-between gap-x-2 gap-y-1 text-[13px] text-fg-2">
        <span>{shown.caption}</span>
        {shown.at && <span>사본 갱신 {formatPublicDate(shown.at, new Date())}</span>}
        {shown.missing && <span className="w-full text-down">원본 없음 · 보관 이미지</span>}
      </figcaption>
    </figure>
  );
}

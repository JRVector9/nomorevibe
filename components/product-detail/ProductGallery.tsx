/* eslint-disable @next/next/no-img-element -- 내부에서 이미 크기 제한·WebP 정규화한 원본을 저장 치수 그대로 제공한다. */
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { formatDate } from "./format";

export function ProductGallery({ name, media }: {
  name: string;
  media: ProductDetailView["media"];
}) {
  return (
    <section className="rounded-[12px] border border-line bg-bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[17px] font-extrabold text-fg">제품 화면</h2>
        <p className="text-[13px] text-fg-3">검증 후 내부에 보관한 이미지</p>
      </div>
      {media.length === 0 ? (
        <div className="mt-5 rounded-[10px] border border-dashed border-line bg-bg-soft px-5 py-10 text-center text-[13px] leading-6 text-fg-3">
          아직 보관된 제품 화면이 없습니다.
        </div>
      ) : (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {media.map((item, index) => (
            <figure key={item.id} className={`${index === 0 ? "sm:col-span-2" : ""} overflow-hidden rounded-[10px] border border-line bg-bg-soft`}>
              <img
                src={item.src}
                width={item.width}
                height={item.height}
                alt={item.altText || `${name} 제품 화면`}
                loading={index === 0 ? "eager" : "lazy"}
                fetchPriority={index === 0 ? "high" : "auto"}
                className="h-auto w-full object-cover"
              />
              <figcaption className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3.5 py-3 text-[13px] text-fg-3">
                <span>{item.altText || `${name} 제품 화면`}</span>
                <span>사본 갱신 {formatDate(item.lastSuccessAt)}</span>
                {item.sourceMissing && (
                  <span className="w-full text-down">원본 출처는 사라졌지만 마지막 내부 사본을 표시합니다.</span>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}

import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { formatDate } from "./format";
import { SourceBadge } from "./SourceBadge";

export function EvidenceSummary({ links, freshness, profileUpdatedAt }: {
  links: ProductDetailView["links"];
  freshness: ProductDetailView["freshness"];
  profileUpdatedAt: Date | null;
}) {
  const official = links.filter((link) => link.evidenceLabel === "공식 출처에서 확인").length;
  const maker = links.filter((link) => link.evidenceLabel === "메이커 제공·미검증").length;
  const automatic = links.filter((link) => link.evidenceLabel === "자동 감지").length;
  const problems = freshness.filter((item) => item.state === "failed" || item.state === "stale" || item.state === "disconnected").length;

  return (
    <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-bg-card px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 className="text-[14px] font-bold text-fg">근거 요약</h2>
        <p className="mt-1 text-[13px] leading-5 text-fg-3">
          메이커가 제공한 정보와 외부에서 확인한 정보를 구분해 표시합니다.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SourceBadge label={`공식 출처 ${official}`} />
        <SourceBadge label={`메이커 제공·미검증 ${maker}`} />
        {automatic > 0 && <SourceBadge label={`자동 감지 ${automatic}`} />}
        {problems > 0 && (
          <span className="rounded-full border border-down/30 bg-down/5 px-2 py-0.5 text-[13px] font-semibold text-down">
            확인 필요 {problems}
          </span>
        )}
        {profileUpdatedAt && <span className="text-[13px] text-fg-3">소개 갱신 {formatDate(profileUpdatedAt)}</span>}
      </div>
    </section>
  );
}

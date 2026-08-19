import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { formatDateTime } from "./format";

const KIND_LABELS: Record<ProductDetailView["freshness"][number]["kind"], string> = {
  repository: "저장소",
  app_store: "App Store",
  play_store: "Play Store",
  npm: "npm",
  pypi: "PyPI",
  crates: "crates.io",
  documentation: "문서",
  support: "지원",
  rss: "RSS",
  changelog: "Changelog",
  video: "영상",
};

export function FreshnessPanel({ freshness }: { freshness: ProductDetailView["freshness"] }) {
  return (
    <section className="rounded-[12px] border border-line bg-bg-card p-5">
      <h2 className="text-[16px] font-extrabold text-fg">정보 갱신 상태</h2>
      {freshness.length === 0 ? (
        <p className="mt-4 rounded-[10px] bg-bg-soft px-4 py-3 text-[13px] leading-6 text-fg-3">연결된 외부 출처가 없습니다.</p>
      ) : (
        <div className="mt-4 space-y-2.5">
          {freshness.map((item) => {
            const warning = item.state === "failed" || item.state === "stale" || item.state === "disconnected";
            return (
              <div key={`${item.kind}:${item.provider}`} className="rounded-[10px] border border-line px-3.5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <strong className="text-[13px] text-fg">{KIND_LABELS[item.kind]}</strong>
                  <span className={`text-[13px] font-bold ${warning ? "text-down" : item.state === "current" ? "text-up" : "text-fg-2"}`}>{item.label}</span>
                </div>
                <p className="mt-1.5 text-[13px] text-fg-3">
                  {item.lastSuccessAt ? `마지막 성공 ${formatDateTime(item.lastSuccessAt)}` : "아직 성공한 수집 없음"}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

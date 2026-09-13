import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { formatDateTime, formatNumber } from "./format";

function MetricCard({ label, value, note, tone = "default" }: {
  label: string;
  value: string;
  note?: string;
  tone?: "default" | "up" | "down";
}) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-fg";
  return (
    <div className="min-w-0 bg-bg-card px-4 py-3.5 sm:px-5 sm:py-4">
      <p className="text-[13px] font-semibold leading-5 text-fg-3">{label}</p>
      <p className={`mt-1.5 font-mono text-[21px] font-extrabold tracking-[-0.04em] ${color}`}>{value}</p>
      {note && <p className="mt-1.5 text-[13px] leading-5 text-fg-3">{note}</p>}
    </div>
  );
}

export function ProductMetrics({ visits, health }: {
  visits: ProductDetailView["visits"];
  health: ProductDetailView["health"];
}) {
  const unique = visits.collecting || visits.uniqueVisitors === null
    ? "—"
    : formatNumber(visits.uniqueVisitors);
  const change = visits.collecting
    ? "—"
    : visits.uniqueChangePercent === null
      ? "신규"
      : `${visits.uniqueChangePercent > 0 ? "+" : ""}${visits.uniqueChangePercent}%`;
  const changeTone = visits.uniqueChangePercent === null
    ? "default"
    : visits.uniqueChangePercent >= 0 ? "up" : "down";
  const uptime = health.uptime30d === null ? "—" : `${health.uptime30d}%`;
  const healthNote = health.checkedAt === null
    ? undefined
    : `${health.latencyMs === null ? "응답 시간 미측정" : `${health.latencyMs}ms`} · ${formatDateTime(health.checkedAt)} 확인`;

  return (
    <section aria-label="NoMoreVibe 유입 및 가동 지표" className="overflow-hidden rounded-[10px] border border-line bg-line shadow-[0_8px_30px_rgba(16,20,28,0.03)]">
      <div className="grid grid-cols-2 gap-px lg:grid-cols-4">
        <MetricCard
          label={`고유 유입자 · 최근 ${visits.periodDays}일`}
          value={unique}
        />
        <MetricCard
          label={`유효 방문 · 최근 ${visits.periodDays}일`}
          value={formatNumber(visits.validVisits)}
        />
        <MetricCard
          label="고유 유입자 변동"
          value={change}
          tone={changeTone}
        />
        <MetricCard
          label="30일 가동률"
          value={uptime}
          tone={health.down ? "down" : "default"}
          note={healthNote}
        />
      </div>
    </section>
  );
}

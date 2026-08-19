import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { formatDateTime, formatNumber } from "./format";

function MetricCard({ label, value, note, tone = "default" }: {
  label: string;
  value: string;
  note: string;
  tone?: "default" | "up" | "down";
}) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-fg";
  return (
    <div className="min-w-0 bg-bg-card p-4 sm:p-5">
      <p className="text-[13px] font-semibold leading-5 text-fg-3">{label}</p>
      <p className={`mt-2 font-mono text-[23px] font-extrabold tracking-[-0.04em] ${color}`}>{value}</p>
      <p className="mt-1.5 text-[13px] leading-5 text-fg-3">{note}</p>
    </div>
  );
}

export function ProductMetrics({ visits, health }: {
  visits: ProductDetailView["visits"];
  health: ProductDetailView["health"];
}) {
  const unique = visits.collecting || visits.uniqueVisitors === null
    ? "집계 중"
    : formatNumber(visits.uniqueVisitors);
  const change = visits.collecting
    ? "집계 중"
    : visits.uniqueChangePercent === null
      ? "신규"
      : `${visits.uniqueChangePercent > 0 ? "+" : ""}${visits.uniqueChangePercent}%`;
  const changeTone = visits.uniqueChangePercent === null
    ? "default"
    : visits.uniqueChangePercent >= 0 ? "up" : "down";
  const uptime = health.uptime30d === null ? "확인 중" : `${health.uptime30d}%`;
  const healthNote = health.checkedAt === null
    ? "아직 가동 상태를 확인하지 않았습니다"
    : `${health.latencyMs === null ? "응답 시간 미측정" : `${health.latencyMs}ms`} · ${formatDateTime(health.checkedAt)} 확인`;

  return (
    <section aria-label="NoMoreVibe 유입 및 가동 지표" className="overflow-hidden rounded-[10px] border border-line bg-line">
      <div className="grid grid-cols-2 gap-px lg:grid-cols-4">
        <MetricCard
          label={`고유 유입자 · 최근 ${visits.periodDays}일`}
          value={unique}
          note="NoMoreVibe에서 제품으로 이동한 브라우저 식별자 기준"
        />
        <MetricCard
          label={`유효 방문 · 최근 ${visits.periodDays}일`}
          value={formatNumber(visits.validVisits)}
          note={visits.collecting
            ? "고유 식별자 집계 전에도 측정 · 봇과 짧은 중복 요청 제외"
            : "봇과 짧은 시간의 중복 요청을 제외한 외부 이동"}
        />
        <MetricCard
          label="고유 유입자 변동"
          value={change}
          tone={changeTone}
          note="인접한 같은 길이의 기간과 비교"
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

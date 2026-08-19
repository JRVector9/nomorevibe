import type { MarketStats as Stats } from "@/lib/domain/products/stats";

/**
 * 목록 위의 숫자 넷.
 *
 * 문장보다 빨리 말한다 — 몇 개를 모았고, 얼마나 늘고 있고, 사람들이 실제로 누르는지,
 * 그중 우리가 직접 확인한 것은 얼마인지.
 */
const FORMAT = new Intl.NumberFormat("ko-KR");

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="flex-1 border-r border-line px-[22px] py-[18px] last:border-r-0">
      <div className="text-[13px] font-semibold text-fg-3">{label}</div>
      <div className="mt-1 font-mono text-[22px] font-extrabold tracking-tight">
        {FORMAT.format(value)}
      </div>
      {note && <div className="mt-0.5 text-[13px] font-semibold text-fg-2">{note}</div>}
    </div>
  );
}

export function MarketStats({ stats, windowHours = 24 }: { stats: Stats; windowHours?: number }) {
  const clickChange = stats.clicksChangePercent;
  return (
    <div className="mt-5 flex overflow-hidden rounded-[12px] border border-line bg-bg-card">
      <Stat label="제품" value={stats.products} />
      <Stat
        label="이번 주 신규"
        value={stats.newThisWeek}
        note={stats.newThisWeek > 0 ? "▲ 7일" : undefined}
      />
      <Stat
        label={`유효 클릭 ${windowHours}h`}
        value={stats.clicks24h}
        note={clickChange === null
          ? undefined
          : `${clickChange >= 0 ? "▲" : "▼"} ${Math.abs(clickChange)}%`}
      />
      <Stat
        label="검증됨"
        value={stats.verified}
        note={stats.products > 0 ? `전체의 ${Math.round((stats.verified / stats.products) * 100)}%` : undefined}
      />
    </div>
  );
}

import type { MarketStats as Stats } from "@/lib/domain/products/stats";

/**
 * 탑메뉴 위의 한 줄.
 *
 * 문장보다 빨리 말한다 — 몇 개를 모았고, 얼마나 늘고 있고, 사람들이 실제로 누르는지,
 * 그중 우리가 직접 확인한 것은 얼마인지.
 *
 * 화면 맨 위에 얇게 지나가고 스크롤과 함께 사라진다. 목록보다 먼저 나오지만 자리를
 * 차지하지 않아야 해서, 카드 넷이 아니라 한 줄이다. 헤더만 sticky로 남는다.
 */
const FORMAT = new Intl.NumberFormat("ko-KR");

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      <span className="text-fg-3">{label}</span>
      <span className="font-mono font-bold tabular-nums text-fg">{FORMAT.format(value)}</span>
      {note && <span className="text-fg-3">{note}</span>}
    </span>
  );
}

export function MarketStats({ stats, windowHours = 24 }: { stats: Stats; windowHours?: number }) {
  const clickChange = stats.clicksChangePercent;
  return (
    <div className="border-b border-line bg-bg-soft">
      {/* 좁은 화면에서 문서 전체가 가로로 밀리지 않게 이 줄 안에서만 스크롤한다 */}
      <div className="mx-auto flex max-w-[1280px] items-baseline gap-5 overflow-x-auto px-4 py-2 text-[13px] sm:px-6">
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
    </div>
  );
}

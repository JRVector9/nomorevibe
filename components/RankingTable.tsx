import Link from "next/link";
import type { RankingListItem } from "@/lib/domain/ranking/view";

function changeLabel(change: number | null): string {
  if (change === null) return "신규";
  return `${change > 0 ? "+" : ""}${change}%`;
}

export function RankingTable({ items, windowHours }: { items: RankingListItem[]; windowHours: number }) {
  return (
    <div className="overflow-x-auto rounded-[14px] border border-line bg-bg-card">
      <table className="w-full min-w-[760px] text-left text-[12.5px]">
        <thead className="text-fg-3">
          <tr>
            <th className="w-12 px-4 py-3 font-medium">#</th>
            <th className="min-w-48 px-3 py-3 font-medium">제품</th>
            <th className="whitespace-nowrap px-3 py-3 text-right font-medium">이번 시즌 클릭</th>
            <th className="whitespace-nowrap px-3 py-3 text-right font-medium">{windowHours}h 변동률</th>
            <th className="whitespace-nowrap px-3 py-3 text-right font-medium">순위 반영</th>
            <th className="whitespace-nowrap px-4 py-3 text-right font-medium">상태</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const factor = item.cooldownFactorBasisPoints / 100;
            return (
              <tr key={item.slug} className="border-t border-line">
                <td className="px-4 py-3 font-mono text-[13px] font-extrabold">{item.rank}</td>
                <td className="px-3 py-3">
                  <Link href={`/p/${item.slug}`} className="block font-bold hover:text-accent">
                    {item.name}
                  </Link>
                  <span className="block max-w-64 truncate text-[11px] text-fg-3">{item.tagline}</span>
                </td>
                <td className="px-3 py-3 text-right font-mono font-bold">
                  {item.validClicks.toLocaleString("ko-KR")}
                </td>
                <td className={`px-3 py-3 text-right font-mono font-semibold ${
                  item.changePercent !== null && item.changePercent < 0 ? "text-down" : "text-up"
                }`}>
                  {changeLabel(item.changePercent)}
                </td>
                <td className={`px-3 py-3 text-right font-mono font-bold ${factor < 100 ? "text-down" : "text-fg-2"}`}>
                  {factor}%
                </td>
                <td className="px-4 py-3 text-right text-fg-2">
                  {item.previousRank === null ? "첫 시즌" : `지난 시즌 ${item.previousRank}위`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

import Link from "next/link";
import { StatusBadge } from "@/components/TrustBadges";
import type { RankingListItem } from "@/lib/domain/ranking/view";

function changeLabel(change: number | null): string {
  if (change === null) return "신규";
  return `${change > 0 ? "+" : ""}${change}%`;
}

function seasonStatus(item: RankingListItem): string {
  return item.previousRank === null ? "첫 시즌" : `지난 시즌 ${item.previousRank}위`;
}

function ProductIdentity({ item, mobileDetails }: {
  item: RankingListItem;
  mobileDetails?: React.ReactNode;
}) {
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Link href={`/p/${item.slug}`} className="min-w-0 truncate font-bold hover:text-accent">
          {item.name}
        </Link>
        <StatusBadge status={item.status} unclaimed={item.unclaimed} />
        {item.health?.down && (
          <span className="shrink-0 rounded-full border border-down/40 bg-down/10 px-2 py-0.5 text-[10px] font-semibold text-down">
            응답 없음
          </span>
        )}
      </div>
      <span className="block max-w-64 truncate text-[11px] text-fg-3">{item.tagline}</span>
      {mobileDetails}
    </>
  );
}

export function RankingTable({
  items,
  windowHours,
  mode = "season",
}: {
  items: RankingListItem[];
  windowHours: number;
  mode?: "season" | "all-time";
}) {
  const seasonal = mode === "season";
  const clickHeader = seasonal ? "이번 시즌 클릭" : "누적 클릭";

  return (
    <div className="overflow-x-auto rounded-[14px] border border-line bg-bg-card">
      <table className="w-full min-w-full sm:min-w-[760px] text-left text-[12.5px]">
        <thead className="text-fg-3">
          <tr>
            <th className="w-8 px-2 py-3 font-medium sm:w-12 sm:px-4">#</th>
            <th className="w-full min-w-28 px-2 py-3 font-medium sm:min-w-48 sm:px-3">제품</th>
            <th className="whitespace-nowrap px-2 py-3 text-right font-medium sm:px-3">
              <span className="sm:hidden">{seasonal ? "클릭" : "누적"}</span>
              <span className="hidden sm:inline">{clickHeader}</span>
            </th>
            {seasonal && (
              <>
                <th className="whitespace-nowrap px-2 py-3 text-right font-medium sm:px-3">
                  <span className="sm:hidden">{windowHours}h 변동률</span>
                  <span className="hidden sm:inline">{windowHours}h 변동률</span>
                </th>
                <th className="hidden sm:table-cell whitespace-nowrap px-3 py-3 text-right font-medium">순위 반영</th>
                <th className="hidden sm:table-cell whitespace-nowrap px-4 py-3 text-right font-medium">상태</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const factor = item.cooldownFactorBasisPoints / 100;
            const status = seasonStatus(item);
            return (
              <tr key={item.slug} className="border-t border-line">
                <td className="px-2 py-3 font-mono text-[13px] font-extrabold sm:px-4">{item.rank}</td>
                <td className="min-w-0 px-2 py-3 sm:px-3">
                  <ProductIdentity
                    item={item}
                    mobileDetails={seasonal ? (
                      <span className="mt-1 flex flex-wrap gap-x-2 text-[10.5px] text-fg-3 sm:hidden">
                        <span className={factor < 100 ? "font-semibold text-down" : undefined}>반영 {factor}%</span>
                        <span>{status}</span>
                      </span>
                    ) : undefined}
                  />
                </td>
                <td className="whitespace-nowrap px-2 py-3 text-right font-mono font-bold sm:px-3">
                  {item.validClicks.toLocaleString("ko-KR")}
                </td>
                {seasonal && (
                  <>
                    <td className={`whitespace-nowrap px-2 py-3 text-right font-mono font-semibold sm:px-3 ${
                      item.changePercent === null ? "text-fg-2" : item.changePercent < 0 ? "text-down" : "text-up"
                    }`}>
                      {changeLabel(item.changePercent)}
                    </td>
                    <td className={`hidden px-3 py-3 text-right font-mono font-bold sm:table-cell ${
                      factor < 100 ? "text-down" : "text-fg-2"
                    }`}>
                      {factor}%
                    </td>
                    <td className="hidden px-4 py-3 text-right text-fg-2 sm:table-cell">{status}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

import { notFound } from "next/navigation";
import { RankingTable } from "@/components/RankingTable";
import { SeasonPolicy } from "@/components/SeasonPolicy";
import { getSeasonByKey } from "@/lib/domain/ranking/view";

export const dynamic = "force-dynamic";

export default async function RankingSeasonPage({
  params,
}: PageProps<"/rankings/[key]">) {
  const { key } = await params;
  const result = await getSeasonByKey(key);
  if (!result) notFound();

  return (
    <main className="mx-auto max-w-[1280px] px-6 pb-20 pt-9">
      <h1 className="text-[26px] font-extrabold">{result.season.key} 랭킹</h1>
      <div className="mt-6 rounded-[12px] border border-line bg-bg-card p-5">
        <SeasonPolicy season={result.season} />
      </div>
      <div className="mt-6">
        <RankingTable
          items={result.items}
          windowHours={result.season.policy.trend.windowHours}
          scoreMode={result.season.policy.scoring.mode}
          mode="season"
        />
      </div>
    </main>
  );
}

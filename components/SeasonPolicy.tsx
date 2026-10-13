import type { RankingPolicy } from "@/lib/domain/ranking/policy";
import type { SeasonSummary } from "@/lib/domain/ranking/view";
import { createTranslator, type Dictionary } from "@/lib/i18n/messages";
import { browse as koreanBrowse } from "@/messages/ko/browse";
import { formatNumber, formatDateTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";

type SeasonPolicyProps =
  | { policy: RankingPolicy; locale?: Locale; messages?: Dictionary["browse"] }
  /** now 는 날짜의 "올해"를 정한다 — 화면이 읽은 시각을 넘긴다(lib/format/time.ts formatPublicDateTime) */
  | { season: SeasonSummary; now: Date; locale?: Locale; messages?: Dictionary["browse"] };

export function SeasonPolicy(props: SeasonPolicyProps) {
  const locale=props.locale ?? "ko";
  const t=createTranslator("browse",props.messages ?? koreanBrowse);
  const count=(n:number)=>formatNumber(n,locale);
  const projects=(n:number)=>t("count.projects",{count:count(n)});
  const days=(n:number)=>t("season.days",{count:count(n)});
  const season = "season" in props ? props.season : undefined;
  const now = "season" in props ? props.now : undefined;
  const policy = "season" in props ? props.season.policy : props.policy;
  const launchWindowDays = season?.effectiveLaunchWindowDays
    ?? policy.eligibility.launchWindowDays;
  const uniqueScoring = policy.scoring.mode === "unique_visitors";
  const trendMinimum = uniqueScoring ? t("season.people", {count:count(policy.trend.minimumPreviousUniqueVisitors)}) : t("season.visits", {count:count(policy.trend.minimumPreviousClicks)});
  const scoringMethod = policy.scoring.mode === "unique_visitors" ? t("season.uniqueMethod", {weight:count(policy.scoring.repeatVisitWeightBasisPoints/100),max:count(policy.scoring.maxExtraVisitsPerUnique)}) : t("season.visitMethod");
  const minimumUniqueVisitors = policy.scoring.mode === "unique_visitors"
    ? policy.scoring.minimumUniqueVisitors
    : null;

  return (
    <div className="grid grid-cols-1 gap-5 text-[13px] sm:grid-cols-2">
      {season && now && (
        <div className="sm:col-span-2">
          <PolicyGroup title={t("season.snapshotTitle")}>
            <PolicyRow
              label={t("season.period")}
              value={`${formatDateTime(season.startsAt,now,locale)} – ${formatDateTime(season.endsAt,now,locale)}`}
            />
            <PolicyRow label={t("season.status")} value={t(season.state === "active" ? "season.active" : "season.closed")} />
            <PolicyRow label={t("season.transition")} value={t(season.isTransition ? "season.transitionSeason" : "season.regularSeason")} />
            <PolicyRow
              label={t("season.lastAggregation")}
              value={season.refreshedAt ? formatDateTime(season.refreshedAt,now,locale) : t("season.snapshotPending")}
            />
          </PolicyGroup>
        </div>
      )}
      <PolicyGroup title={t("season.participation")}>
        <PolicyRow label={t("season.cadence")} value={`${t(policy.season.cadence === "weekly" ? "season.weekly" : "season.monthly")} · ${policy.season.timezone}`} />
        <PolicyRow label={t(season ? "season.confirmedWindow" : "season.launchWindow")} value={days(launchWindowDays)} />
        <PolicyRow label={t("season.minimumProjects")} value={projects(policy.eligibility.minimumProducts)} />
        <PolicyRow label={t("season.maximumWindow")} value={days(policy.eligibility.maximumWindowDays)} />
        <PolicyRow
          label={t(uniqueScoring ? "season.uniqueCriteria" : "season.visitCriteria")}
          value={scoringMethod}
        />
        {minimumUniqueVisitors !== null && (
          <PolicyRow label={t("season.minimumUnique")} value={t("season.people", {count:count(minimumUniqueVisitors)})} />
        )}
      </PolicyGroup>
      <PolicyGroup title={t("season.exposure")}>
        <PolicyRow label={t("season.fullRanking")} value={projects(policy.leaderboard.limit)} />
        <PolicyRow label={t("season.boards")} value={t("season.boardCounts", {weekly:count(policy.boards.weeklyLimit),verified:count(policy.boards.verifiedNewLimit),discovered:count(policy.boards.discoveredNewLimit)})} />
        <PolicyRow label={t("season.changeRate")} value={t("season.trendWindow", {hours:count(policy.trend.windowHours),minimum:trendMinimum})} />
        <PolicyRow label={t("season.trending")} value={projects(policy.trend.limit)} />
      </PolicyGroup>
      <div className="sm:col-span-2">
        <h3 className="mb-2 font-semibold text-fg-2">{t("season.cooldown")}</h3>
        {!policy.cooldown.enabled ? (
          <p className="text-fg-2">{t("season.disabled")}</p>
        ) : policy.cooldown.tiers.length === 0 ? (
          <p className="text-fg-2">{t("season.noTiers")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {policy.cooldown.tiers.map((tier, index) => (
              <li key={`${tier.rankFrom}-${tier.rankTo}-${index}`} className="flex flex-wrap gap-x-2">
                <span className="font-semibold">{t("season.rankRange", {from:count(tier.rankFrom),to:count(tier.rankTo)})}</span>
                <span className="font-mono text-fg-2">
                  {tier.factorsBasisPoints.map((factor) => `${count(factor / 100)}%`).join(" → ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PolicyGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 font-semibold text-fg-2">{title}</h3>
      <dl className="flex flex-col gap-1.5">{children}</dl>
    </div>
  );
}

function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      {/* 라벨은 한 줄로 두고 줄바꿈은 값 쪽에서 한다 — 모바일에서 '유효 방문 기준'이 두 줄로 끊겼다(ROB-04) */}
      <dt className="shrink-0 whitespace-nowrap text-fg-2">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{value}</dd>
    </div>
  );
}

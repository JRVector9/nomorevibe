import type { RankingPolicy } from "@/lib/domain/ranking/policy";
import type { SeasonSummary } from "@/lib/domain/ranking/view";
import { formatCount } from "@/lib/format/number";
import { formatPublicDateTime } from "@/lib/format/time";

function cadenceLabel(cadence: RankingPolicy["season"]["cadence"]): string {
  return cadence === "weekly" ? "주간" : "월간";
}

type SeasonPolicyProps =
  | { policy: RankingPolicy }
  /** now 는 날짜의 "올해"를 정한다 — 화면이 읽은 시각을 넘긴다(lib/format/time.ts formatPublicDateTime) */
  | { season: SeasonSummary; now: Date };

export function SeasonPolicy(props: SeasonPolicyProps) {
  const season = "season" in props ? props.season : undefined;
  const now = "season" in props ? props.now : undefined;
  const policy = "season" in props ? props.season.policy : props.policy;
  const launchWindowDays = season?.effectiveLaunchWindowDays
    ?? policy.eligibility.launchWindowDays;
  const uniqueScoring = policy.scoring.mode === "unique_visitors";
  const trendMinimum = uniqueScoring
    ? `${formatCount(policy.trend.minimumPreviousUniqueVisitors)}명`
    : `${formatCount(policy.trend.minimumPreviousClicks)}회`;
  const scoringMethod = policy.scoring.mode === "unique_visitors"
    ? `제품별 고유 브라우저 · 반복 유효 방문 ${policy.scoring.repeatVisitWeightBasisPoints / 100}% 반영 · 최대 ${policy.scoring.maxExtraVisitsPerUnique}회`
    : "봇 제외 · 방문자·제품별 10분 중복 제외 · 외부 이동 방문";
  const minimumUniqueVisitors = policy.scoring.mode === "unique_visitors"
    ? policy.scoring.minimumUniqueVisitors
    : null;

  return (
    <div className="grid grid-cols-1 gap-5 text-[13px] sm:grid-cols-2">
      {season && now && (
        <div className="sm:col-span-2">
          <PolicyGroup title="시즌 스냅샷">
            <PolicyRow
              label="기간"
              value={`${formatPublicDateTime(season.startsAt, now)} – ${formatPublicDateTime(season.endsAt, now)}`}
            />
            <PolicyRow label="상태" value={season.state === "active" ? "진행 중" : "종료"} />
            <PolicyRow label="전환" value={season.isTransition ? "전환 시즌" : "정규 시즌"} />
            <PolicyRow
              label="마지막 집계"
              value={formatPublicDateTime(season.refreshedAt, now, "집계 대기")}
            />
          </PolicyGroup>
        </div>
      )}
      <PolicyGroup title="시즌과 참가">
        <PolicyRow label="주기" value={`${cadenceLabel(policy.season.cadence)} · ${policy.season.timezone}`} />
        <PolicyRow label={season ? "확정 참가 기간" : "출시 참가 기간"} value={`${launchWindowDays}일`} />
        <PolicyRow label="최소 참가 제품" value={`${formatCount(policy.eligibility.minimumProducts)}개`} />
        <PolicyRow label="최대 확장 기간" value={`${policy.eligibility.maximumWindowDays}일`} />
        <PolicyRow
          label={uniqueScoring ? "고유 유입자 기준" : "유효 방문 기준"}
          value={scoringMethod}
        />
        {minimumUniqueVisitors !== null && (
          <PolicyRow label="최소 고유 유입자" value={`${formatCount(minimumUniqueVisitors)}명`} />
        )}
      </PolicyGroup>
      <PolicyGroup title="노출과 급상승">
        <PolicyRow label="전체 랭킹" value={`${formatCount(policy.leaderboard.limit)}개`} />
        <PolicyRow label="보드" value={`${formatCount(policy.boards.weeklyLimit)} / ${formatCount(policy.boards.verifiedNewLimit)} / ${formatCount(policy.boards.discoveredNewLimit)}개`} />
        <PolicyRow label="변동률" value={`${formatCount(policy.trend.windowHours)}시간 · 이전 ${trendMinimum} 이상`} />
        <PolicyRow label="급상승" value={`${formatCount(policy.trend.limit)}개`} />
      </PolicyGroup>
      <div className="sm:col-span-2">
        <h3 className="mb-2 font-semibold text-fg-2">소프트 쿨다운</h3>
        {!policy.cooldown.enabled ? (
          <p className="text-fg-2">사용하지 않음</p>
        ) : policy.cooldown.tiers.length === 0 ? (
          <p className="text-fg-2">설정된 구간 없음</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {policy.cooldown.tiers.map((tier, index) => (
              <li key={`${tier.rankFrom}-${tier.rankTo}-${index}`} className="flex flex-wrap gap-x-2">
                <span className="font-semibold">{tier.rankFrom}–{tier.rankTo}위</span>
                <span className="font-mono text-fg-2">
                  {tier.factorsBasisPoints.map((factor) => `${factor / 100}%`).join(" → ")}
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
      <dt className="text-fg-2">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

import type { RankingPolicy } from "@/lib/domain/ranking/policy";
import type { SeasonSummary } from "@/lib/domain/ranking/view";

const KST_DATE_TIME = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function cadenceLabel(cadence: RankingPolicy["season"]["cadence"]): string {
  return cadence === "weekly" ? "주간" : "월간";
}

type SeasonPolicyProps =
  | { policy: RankingPolicy }
  | { season: SeasonSummary };

export function SeasonPolicy(props: SeasonPolicyProps) {
  const season = "season" in props ? props.season : undefined;
  const policy = "season" in props ? props.season.policy : props.policy;
  const launchWindowDays = season?.effectiveLaunchWindowDays
    ?? policy.eligibility.launchWindowDays;

  return (
    <div className="grid grid-cols-1 gap-5 text-[12.5px] sm:grid-cols-2">
      {season && (
        <div className="sm:col-span-2">
          <PolicyGroup title="시즌 스냅샷">
            <PolicyRow
              label="기간"
              value={`${KST_DATE_TIME.format(season.startsAt)} – ${KST_DATE_TIME.format(season.endsAt)} KST`}
            />
            <PolicyRow label="상태" value={season.state === "active" ? "진행 중" : "종료"} />
            <PolicyRow label="전환" value={season.isTransition ? "전환 시즌" : "정규 시즌"} />
            <PolicyRow
              label="마지막 집계"
              value={season.refreshedAt ? `${KST_DATE_TIME.format(season.refreshedAt)} KST` : "집계 대기"}
            />
          </PolicyGroup>
        </div>
      )}
      <PolicyGroup title="시즌과 참가">
        <PolicyRow label="주기" value={`${cadenceLabel(policy.season.cadence)} · ${policy.season.timezone}`} />
        <PolicyRow label={season ? "확정 참가 기간" : "출시 참가 기간"} value={`${launchWindowDays}일`} />
        <PolicyRow label="최소 참가 제품" value={`${policy.eligibility.minimumProducts}개`} />
        <PolicyRow label="최대 확장 기간" value={`${policy.eligibility.maximumWindowDays}일`} />
        <PolicyRow label="유효 클릭 기준" value="봇 제외 · 방문자·제품별 10분 중복 제외 · 외부 이동 클릭" />
      </PolicyGroup>
      <PolicyGroup title="노출과 급상승">
        <PolicyRow label="전체 랭킹" value={`${policy.leaderboard.limit}개`} />
        <PolicyRow label="보드" value={`${policy.boards.weeklyLimit} / ${policy.boards.verifiedNewLimit} / ${policy.boards.discoveredNewLimit}개`} />
        <PolicyRow label="변동률" value={`${policy.trend.windowHours}시간 · 이전 ${policy.trend.minimumPreviousClicks}클릭 이상`} />
        <PolicyRow label="급상승" value={`${policy.trend.limit}개`} />
      </PolicyGroup>
      <div className="sm:col-span-2">
        <h3 className="mb-2 font-semibold text-fg-2">소프트 쿨다운</h3>
        {!policy.cooldown.enabled ? (
          <p className="text-fg-3">사용하지 않음</p>
        ) : policy.cooldown.tiers.length === 0 ? (
          <p className="text-fg-3">설정된 구간 없음</p>
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
      <dt className="text-fg-3">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

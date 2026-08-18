"use client";

import { useActionState, useState } from "react";
import { Panel } from "@/components/Panel";
import type { RankingPolicy } from "@/lib/domain/ranking/policy";
import { saveRankingPolicy } from "./actions";

const field = "w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-[13px] text-fg outline-none focus:border-accent";
const label = "block text-[12px] font-semibold text-fg-2";
const hint = "mt-1 text-[11.5px] leading-[1.6] text-fg-3";

export function percentList(value: string): number[] {
  return value.split(",").map((item) => Math.round(Number(item.trim()) * 100));
}

export function numberOrPrevious(value: string, previous: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : previous;
}

export function RankingPolicyForm({ initialPolicy }: { initialPolicy: RankingPolicy }) {
  const [policy, setPolicy] = useState<RankingPolicy>(initialPolicy);
  const [state, action, pending] = useActionState(saveRankingPolicy, null);

  function updateEligibility(key: keyof RankingPolicy["eligibility"], value: string) {
    setPolicy((previous) => ({
      ...previous,
      eligibility: {
        ...previous.eligibility,
        [key]: numberOrPrevious(value, previous.eligibility[key]),
      },
    }));
  }

  function updateBoard(key: keyof RankingPolicy["boards"], value: string) {
    setPolicy((previous) => ({
      ...previous,
      boards: {
        ...previous.boards,
        [key]: numberOrPrevious(value, previous.boards[key]),
      },
    }));
  }

  function updateTrend(key: keyof RankingPolicy["trend"], value: string) {
    setPolicy((previous) => ({
      ...previous,
      trend: {
        ...previous.trend,
        [key]: numberOrPrevious(value, previous.trend[key]),
      },
    }));
  }

  function updateTier(index: number, patch: Partial<RankingPolicy["cooldown"]["tiers"][number]>) {
    setPolicy((previous) => ({
      ...previous,
      cooldown: {
        ...previous.cooldown,
        tiers: previous.cooldown.tiers.map((tier, tierIndex) => (
          tierIndex === index ? { ...tier, ...patch } : tier
        )),
      },
    }));
  }

  function addTier() {
    setPolicy((previous) => {
      const lastRank = previous.cooldown.tiers.at(-1)?.rankTo ?? 0;
      if (lastRank >= previous.leaderboard.limit) return previous;
      const rank = lastRank + 1;
      return {
        ...previous,
        cooldown: {
          ...previous.cooldown,
          tiers: [
            ...previous.cooldown.tiers,
            { rankFrom: rank, rankTo: rank, factorsBasisPoints: [10_000] },
          ],
        },
      };
    });
  }

  function removeTier(index: number) {
    setPolicy((previous) => ({
      ...previous,
      cooldown: {
        ...previous.cooldown,
        tiers: previous.cooldown.tiers.filter((_, tierIndex) => tierIndex !== index),
      },
    }));
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="policy" value={JSON.stringify(policy)} />

      <div aria-live="polite">
        {state?.issues && state.issues.length > 0 && (
          <div className="rounded-[10px] border border-down/40 bg-down/10 px-4 py-3 text-[12.5px] text-down">
            {state.issues.map((issue) => <p key={issue}>{issue}</p>)}
          </div>
        )}
        {state?.ok && (
          <div className="rounded-[10px] border border-up/40 bg-up/10 px-4 py-3 text-[12.5px] text-up">
            다음 시즌 설정으로 예약했습니다.
          </div>
        )}
        {state?.warnings && state.warnings.length > 0 && (
          <div className="mt-2 rounded-[10px] border border-accent bg-accent-soft px-4 py-3 text-[12.5px] text-fg-2">
            {state.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          </div>
        )}
      </div>

      <Panel title="시즌" note="예약한 값은 현재 시즌을 바꾸지 않고 다음 경계부터 적용됩니다.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="ranking-cadence">주기</label>
            <select
              id="ranking-cadence"
              value={policy.season.cadence}
              onChange={(event) => setPolicy((previous) => ({
                ...previous,
                season: { ...previous.season, cadence: event.target.value as "weekly" | "monthly" },
              }))}
              className={`${field} mt-1.5`}
            >
              <option value="weekly">주간</option>
              <option value="monthly">월간</option>
            </select>
          </div>
          <div>
            <span className={label}>시간대</span>
            <p className="mt-3 font-mono text-[13px]">Asia/Seoul</p>
            <p className={hint}>시즌 경계 해석을 고정하기 위해 변경할 수 없습니다.</p>
          </div>
        </div>
      </Panel>

      <Panel title="참가 범위" note="기본 기간으로 최소 제품 수를 채우지 못하면 최대 기간까지 자동으로 넓힙니다.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NumberField id="launch-window" label="출시 참가 기간(일)" value={policy.eligibility.launchWindowDays} onChange={(value) => updateEligibility("launchWindowDays", value)} />
          <NumberField id="minimum-products" label="최소 참가 제품" value={policy.eligibility.minimumProducts} onChange={(value) => updateEligibility("minimumProducts", value)} />
          <NumberField id="maximum-window" label="최대 확장 기간(일)" value={policy.eligibility.maximumWindowDays} onChange={(value) => updateEligibility("maximumWindowDays", value)} />
        </div>
      </Panel>

      <Panel title="노출 개수">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField id="leaderboard-limit" label="전체 랭킹" value={policy.leaderboard.limit} onChange={(value) => setPolicy((previous) => ({
            ...previous,
            leaderboard: { limit: numberOrPrevious(value, previous.leaderboard.limit) },
          }))} />
          <NumberField id="weekly-limit" label="이번 시즌 보드" value={policy.boards.weeklyLimit} onChange={(value) => updateBoard("weeklyLimit", value)} />
          <NumberField id="verified-limit" label="새로 검증됨" value={policy.boards.verifiedNewLimit} onChange={(value) => updateBoard("verifiedNewLimit", value)} />
          <NumberField id="discovered-limit" label="새로 발견됨" value={policy.boards.discoveredNewLimit} onChange={(value) => updateBoard("discoveredNewLimit", value)} />
        </div>
      </Panel>

      <Panel title="소프트 쿨다운" note="직전 시즌 상위 제품의 점수를 단계적으로 낮춥니다. 퍼센트는 다음 시즌부터 순서대로 적용됩니다.">
        <label className="flex items-center gap-2.5 text-[13px]">
          <input
            type="checkbox"
            checked={policy.cooldown.enabled}
            onChange={(event) => setPolicy((previous) => ({
              ...previous,
              cooldown: { ...previous.cooldown, enabled: event.target.checked },
            }))}
            className="accent-[var(--accent)]"
          />
          쿨다운 사용
        </label>

        <div className="mt-4 flex flex-col gap-2">
          {policy.cooldown.tiers.map((tier, index) => (
            <div key={index} className="grid grid-cols-1 gap-2 rounded-lg border border-line p-3 sm:grid-cols-[90px_90px_1fr_auto]">
              <NumberField id={`tier-from-${index}`} label="시작 순위" value={tier.rankFrom} onChange={(value) => updateTier(index, { rankFrom: numberOrPrevious(value, tier.rankFrom) })} />
              <NumberField id={`tier-to-${index}`} label="끝 순위" value={tier.rankTo} onChange={(value) => updateTier(index, { rankTo: numberOrPrevious(value, tier.rankTo) })} />
              <div>
                <label className={label} htmlFor={`tier-factors-${index}`}>적용률(%)</label>
                <input
                  id={`tier-factors-${index}`}
                  value={tier.factorsBasisPoints.map((factor) => factor / 100).join(", ")}
                  onChange={(event) => {
                    const factors = percentList(event.target.value);
                    if (factors.every(Number.isFinite)) updateTier(index, { factorsBasisPoints: factors });
                  }}
                  className={`${field} mt-1.5 font-mono`}
                  aria-label={`${tier.rankFrom}위부터 ${tier.rankTo}위 적용률`}
                />
              </div>
              <button type="button" onClick={() => removeTier(index)} className="self-end px-2 py-2 text-[12px] font-semibold text-down">
                구간 삭제
              </button>
            </div>
          ))}
        </div>
        <button type="button" onClick={addTier} className="mt-3 text-[12.5px] font-semibold text-accent">
          + 구간
        </button>
      </Panel>

      <Panel title="급상승" note="최근 구간과 바로 앞의 같은 길이 구간을 비교합니다. 이전 클릭이 기준보다 적으면 변동률을 계산하지 않습니다.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NumberField id="trend-window" label="비교 구간(시간)" value={policy.trend.windowHours} onChange={(value) => updateTrend("windowHours", value)} />
          <NumberField id="trend-baseline" label="이전 최소 클릭" value={policy.trend.minimumPreviousClicks} onChange={(value) => updateTrend("minimumPreviousClicks", value)} />
          <NumberField id="trend-limit" label="급상승 노출 수" value={policy.trend.limit} onChange={(value) => updateTrend("limit", value)} />
        </div>
      </Panel>

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-[10px] bg-accent-solid px-5 py-2.5 text-[13.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
      >
        {pending ? "예약 중…" : "다음 시즌에 예약"}
      </button>
    </form>
  );
}

function NumberField({
  id,
  label: text,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className={label} htmlFor={id}>{text}</label>
      <input
        id={id}
        type="number"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${field} mt-1.5`}
      />
    </div>
  );
}

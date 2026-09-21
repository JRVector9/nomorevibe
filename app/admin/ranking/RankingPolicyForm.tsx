"use client";

import { useActionState, useState, type ReactNode } from "react";
import {
  DEFAULT_RANKING_POLICY,
  UNIQUE_FIRST_RANKING_POLICY,
  type RankingPolicy,
} from "@/lib/domain/ranking/policy";
import { saveRankingPolicy } from "./actions";
import styles from "./ranking.module.css";

const field = styles.field;
const label = styles.label;
const hint = styles.hint;

export function percentList(value: string): number[] {
  return value.split(",").map((item) => item.trim() === ""
    ? Number.NaN
    : Math.round(Number(item.trim()) * 100));
}

function cooldownDraftIssue(draft: string): string {
  const factors = percentList(draft);
  const valid = factors.length <= 52 && factors.every((factor, index) => (
    Number.isFinite(factor) && factor >= 1 && factor <= 10_000
    && (index === 0 || factor >= factors[index - 1])
  ));
  return valid ? "" : "0.01~100%를 작은 값부터 쉼표로 구분해 입력해주세요. 최대 52개까지 가능합니다.";
}

/** Even an invalid draft must reach validation, never fall back to older saved factors. */
export function policyWithCooldownDrafts(policy: RankingPolicy, drafts: string[]): RankingPolicy {
  return {
    ...policy,
    cooldown: {
      ...policy.cooldown,
      tiers: policy.cooldown.tiers.map((tier, index) => ({
        ...tier,
        factorsBasisPoints: percentList(drafts[index] ?? ""),
      })),
    },
  };
}

export function numberOrPrevious(value: string, previous: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : previous;
}

export function policyForScoringMode(
  policy: RankingPolicy,
  mode: RankingPolicy["scoring"]["mode"],
): RankingPolicy {
  const template = mode === "unique_visitors"
    ? UNIQUE_FIRST_RANKING_POLICY
    : DEFAULT_RANKING_POLICY;
  return {
    ...policy,
    scoring: { ...template.scoring },
    trend: {
      ...policy.trend,
      minimumPreviousUniqueVisitors: template.trend.minimumPreviousUniqueVisitors,
    },
  };
}

export function RankingPolicyForm({ initialPolicy }: { initialPolicy: RankingPolicy }) {
  const [policy, setPolicy] = useState<RankingPolicy>(initialPolicy);
  const [cooldownDrafts, setCooldownDrafts] = useState(() => initialPolicy.cooldown.tiers
    .map((tier) => tier.factorsBasisPoints.map((factor) => factor / 100).join(", ")));
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

  function updateUniqueScoring(
    key: "repeatVisitWeightBasisPoints" | "maxExtraVisitsPerUnique" | "minimumUniqueVisitors",
    value: number,
  ) {
    setPolicy((previous) => previous.scoring.mode === "unique_visitors"
      ? { ...previous, scoring: { ...previous.scoring, [key]: value } }
      : previous);
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
    const lastRank = policy.cooldown.tiers.at(-1)?.rankTo ?? 0;
    if (lastRank >= policy.leaderboard.limit || policy.cooldown.tiers.length >= 20) return;
    const rank = lastRank + 1;
    setPolicy((previous) => {
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
    setCooldownDrafts((previous) => [...previous, "100"]);
  }

  function removeTier(index: number) {
    setPolicy((previous) => ({
      ...previous,
      cooldown: {
        ...previous.cooldown,
        tiers: previous.cooldown.tiers.filter((_, tierIndex) => tierIndex !== index),
      },
    }));
    setCooldownDrafts((previous) => previous.filter((_, tierIndex) => tierIndex !== index));
  }

  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="policy" value={JSON.stringify(policyWithCooldownDrafts(policy, cooldownDrafts))} />

      <div aria-live="polite" className={styles.formFeedback}>
        {state?.issues && state.issues.length > 0 && (
          <div className="rounded-[10px] border border-down/40 bg-down/10 px-4 py-3 text-[13px] text-down">
            {state.issues.map((issue) => <p key={issue}>{issue}</p>)}
          </div>
        )}
        {state?.ok && (
          <div className="rounded-[10px] border border-up/40 bg-up/10 px-4 py-3 text-[13px] text-up">
            다음 시즌 설정으로 예약했습니다.
          </div>
        )}
        {state?.warnings && state.warnings.length > 0 && (
          <div className="mt-2 rounded-[10px] border border-accent bg-accent-soft px-4 py-3 text-[13px] text-fg-2">
            {state.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          </div>
        )}
      </div>

      <FormSection number="01" title="랭킹 기준" note="점수를 집계할 기준을 선택합니다. 고유 유입자는 7일 집계 후 예약할 수 있습니다.">
        <div className={styles.fieldsTwo}>
          <div>
            <label className={label} htmlFor="ranking-scoring-mode">점수 기준</label>
            <select
              id="ranking-scoring-mode"
              value={policy.scoring.mode}
              onChange={(event) => setPolicy((previous) => policyForScoringMode(
                previous,
                event.target.value as RankingPolicy["scoring"]["mode"],
              ))}
              className={`${field} mt-1.5`}
            >
              <option value="valid_visits">유효 방문</option>
              <option value="unique_visitors">고유 유입자</option>
            </select>
          </div>
          <div>
            <span className={label}>적용 시점</span>
            <p className={styles.staticValue}>다음 시즌 경계부터</p>
          </div>
        </div>
        {policy.scoring.mode === "unique_visitors" && (
          <div className={`${styles.fieldsThree} mt-4`}>
            <NumberField
              id="repeat-visit-weight"
              label="반복 방문 가중치(%)"
              min={0} max={100} step={0.01}
              value={policy.scoring.repeatVisitWeightBasisPoints / 100}
              onChange={(value) => updateUniqueScoring(
                "repeatVisitWeightBasisPoints",
                Math.round(numberOrPrevious(
                  value,
                  policy.scoring.mode === "unique_visitors"
                    ? policy.scoring.repeatVisitWeightBasisPoints / 100
                    : 0,
                ) * 100),
              )}
            />
            <NumberField
              id="extra-visit-cap"
              label="고유 유입자당 추가 방문 상한"
              min={0} max={10} unit="회"
              value={policy.scoring.maxExtraVisitsPerUnique}
              onChange={(value) => updateUniqueScoring(
                "maxExtraVisitsPerUnique",
                numberOrPrevious(value, policy.scoring.mode === "unique_visitors"
                  ? policy.scoring.maxExtraVisitsPerUnique
                  : 0),
              )}
            />
            <NumberField
              id="minimum-unique-visitors"
              label="최소 고유 유입자"
              max={100_000} unit="명"
              value={policy.scoring.minimumUniqueVisitors}
              onChange={(value) => updateUniqueScoring(
                "minimumUniqueVisitors",
                numberOrPrevious(value, policy.scoring.mode === "unique_visitors"
                  ? policy.scoring.minimumUniqueVisitors
                  : 1),
              )}
            />
          </div>
        )}
      </FormSection>

      <FormSection number="02" title="시즌" note="랭킹을 새로 시작하는 주기입니다.">
        <div className={styles.fieldsTwo}>
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
            <p className={styles.staticValue}>Asia/Seoul</p>
            <p className={hint}>시즌 경계 해석을 고정하기 위해 변경할 수 없습니다.</p>
          </div>
        </div>
      </FormSection>

      <FormSection number="03" title="참가 범위" note="최소 제품 수가 부족하면 출시 참가 기간을 최대 기간까지 넓힙니다.">
        <div className={styles.fieldsThree}>
          <NumberField id="launch-window" max={3650} unit="일" label="출시 참가 기간(일)" value={policy.eligibility.launchWindowDays} onChange={(value) => updateEligibility("launchWindowDays", value)} />
          <NumberField id="minimum-products" max={50_000} unit="개" label="최소 참가 제품" value={policy.eligibility.minimumProducts} onChange={(value) => updateEligibility("minimumProducts", value)} />
          <NumberField id="maximum-window" max={3650} unit="일" label="최대 확장 기간(일)" value={policy.eligibility.maximumWindowDays} onChange={(value) => updateEligibility("maximumWindowDays", value)} />
        </div>
      </FormSection>

      <FormSection number="04" title="노출 개수" note="공개 랭킹과 각 보드에 표시할 제품 수입니다.">
        <div className={styles.fieldsFour}>
          <NumberField id="leaderboard-limit" max={100} unit="개" label="전체 랭킹" value={policy.leaderboard.limit} onChange={(value) => setPolicy((previous) => ({
            ...previous,
            leaderboard: { limit: numberOrPrevious(value, previous.leaderboard.limit) },
          }))} />
          <NumberField id="weekly-limit" max={20} unit="개" label="이번 시즌 보드" value={policy.boards.weeklyLimit} onChange={(value) => updateBoard("weeklyLimit", value)} />
          <NumberField id="verified-limit" max={20} unit="개" label="새로 검증됨" value={policy.boards.verifiedNewLimit} onChange={(value) => updateBoard("verifiedNewLimit", value)} />
          <NumberField id="discovered-limit" max={20} unit="개" label="새로 발견됨" value={policy.boards.discoveredNewLimit} onChange={(value) => updateBoard("discoveredNewLimit", value)} />
        </div>
      </FormSection>

      <FormSection number="05" title="소프트 쿨다운" note="직전 시즌 상위 제품에 적용할 점수 비율입니다. 다음 시즌부터 순서대로 적용됩니다.">
        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={policy.cooldown.enabled}
            onChange={(event) => setPolicy((previous) => ({
              ...previous,
              cooldown: { ...previous.cooldown, enabled: event.target.checked },
            }))}
            className={styles.checkbox}
          />
          쿨다운 사용
        </label>

        <div className="mt-4 flex flex-col gap-2">
          {policy.cooldown.tiers.map((tier, index) => (
            <div key={index} className={styles.tier}>
              <NumberField id={`tier-from-${index}`} max={100} unit="위" label="시작 순위" value={tier.rankFrom} onChange={(value) => updateTier(index, { rankFrom: numberOrPrevious(value, tier.rankFrom) })} />
              <NumberField id={`tier-to-${index}`} max={100} unit="위" label="끝 순위" value={tier.rankTo} onChange={(value) => updateTier(index, { rankTo: numberOrPrevious(value, tier.rankTo) })} />
              <div>
                <label className={label} htmlFor={`tier-factors-${index}`}>적용률(%)</label>
                <input
                  id={`tier-factors-${index}`}
                  value={cooldownDrafts[index] ?? ""}
                  required
                  ref={(input) => {
                    // Index keys can reuse a field after removing an earlier tier.
                    input?.setCustomValidity(cooldownDraftIssue(cooldownDrafts[index] ?? ""));
                  }}
                  onChange={(event) => {
                    const draft = event.target.value;
                    setCooldownDrafts((previous) => previous.map((value, draftIndex) => draftIndex === index ? draft : value));
                  }}
                  className={`${field} mt-1.5 font-mono`}
                  aria-label={`${tier.rankFrom}위부터 ${tier.rankTo}위 적용률`}
                  aria-describedby="cooldown-format-hint"
                />
              </div>
              <button type="button" onClick={() => removeTier(index)} className={styles.removeTier}>
                구간 삭제
              </button>
            </div>
          ))}
        </div>
        <p id="cooldown-format-hint" className={hint}>예: 35, 55.5, 75, 100 · 작은 값부터 쉼표로 구분</p>
        <button type="button" onClick={addTier} className={styles.addTier}
          disabled={(policy.cooldown.tiers.at(-1)?.rankTo ?? 0) >= policy.leaderboard.limit || policy.cooldown.tiers.length >= 20}>
          + 쿨다운 구간 추가
        </button>
      </FormSection>

      <FormSection number="06" title="급상승" note="최근 구간과 직전의 같은 길이 구간을 비교합니다. 선택한 점수 기준의 최소 방문 수를 충족해야 변동률을 계산합니다.">
        <div className={styles.fieldsFour}>
          <NumberField id="trend-window" max={168} unit="시간" label="비교 구간(시간)" value={policy.trend.windowHours} onChange={(value) => updateTrend("windowHours", value)} />
          <NumberField id="trend-baseline" max={100_000} unit="회" label="이전 최소 유효 방문" value={policy.trend.minimumPreviousClicks} onChange={(value) => updateTrend("minimumPreviousClicks", value)} />
          <NumberField id="trend-unique-baseline" max={100_000} unit="명" label="이전 최소 고유 유입자" value={policy.trend.minimumPreviousUniqueVisitors} onChange={(value) => updateTrend("minimumPreviousUniqueVisitors", value)} />
          <NumberField id="trend-limit" max={20} unit="개" label="급상승 노출 수" value={policy.trend.limit} onChange={(value) => updateTrend("limit", value)} />
        </div>
      </FormSection>

      <div className={styles.submitBar}>
        <div>
          <strong>다음 시즌부터 적용됩니다</strong>
          <p>현재 시즌의 순위와 집계 기준은 유지됩니다.</p>
        </div>
        <button
          type="submit"
          disabled={pending}
          className={styles.submitButton}
        >
          {pending ? "예약 중…" : "다음 시즌에 예약"}
        </button>
      </div>
    </form>
  );
}

function NumberField({
  id,
  label: text,
  value,
  onChange,
  min = 1,
  max,
  step = 1,
  unit,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}) {
  return (
    <div>
      <label className={label} htmlFor={id}>{text}</label>
      <div className={styles.numberInput}>
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={field}
        />
        {unit && <span aria-hidden="true">{unit}</span>}
      </div>
    </div>
  );
}

function FormSection({ number, title, note, children }: {
  number: string;
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.formSection} aria-labelledby={`ranking-form-${number}`}>
      <div className={styles.formSectionLead}>
        <span className={styles.sectionNumber} aria-hidden="true">{number}</span>
        <h3 id={`ranking-form-${number}`}>{title}</h3>
        <p>{note}</p>
      </div>
      <div className={styles.formSectionBody}>{children}</div>
    </section>
  );
}

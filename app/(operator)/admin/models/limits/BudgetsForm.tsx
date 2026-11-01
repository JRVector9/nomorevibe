"use client";
import { useState } from "react";
import type { BudgetRow } from "@/lib/operations/admin-runtime-settings";
import { GroupForm, INPUT_WIDE, OverrideBadge, TD, TH } from "./fields";

const seconds = (ms: number | null) => ms === null ? "—" : `${Math.round(ms) / 1000}초`;
const laneText = (lane: BudgetRow["lane"]) => {
  if (!lane) return "관측 없음";
  if (lane.state === "running") return `도는 중 ${lane.ageMs === null ? "" : `${Math.round(lane.ageMs / 1000)}초`}${lane.budgetMs ? ` (알린 예산 ${seconds(lane.budgetMs)})` : ""}`;
  return lane.state === "polling" ? "확인 중" : lane.state === "stopping" ? "멈추는 중" : "쉬는 중";
};

/** 예산 한 줄 — auto 를 켜면 초 칸은 잠그되 폼에는 남긴다. disabled 이면 value: 가 빠져 auto·「기본값으로」가 저장되지 않는다 */
function BudgetCell({ row, readOnly }: { row: BudgetRow; readOnly?: boolean }) {
  const [auto, setAuto] = useState(row.auto);
  const path = row.field.path;
  return <span className="inline-grid gap-0.5">
    <span className="flex items-center gap-1">
      <input name={`value:${path}`} defaultValue={row.field.input} aria-label={row.field.label} title={row.field.note ?? row.field.label} inputMode="decimal"
        placeholder={row.declared ? undefined : "25"} disabled={readOnly} readOnly={auto} className={INPUT_WIDE} />
      <span className="text-[13px] text-fg-3">초</span>
      <label className="flex items-center gap-1 text-[13px]"><input type="checkbox" name={`auto:${path}`} checked={auto} disabled={readOnly || row.ceilingMs === null}
        onChange={event => setAuto(event.target.checked)} /> auto</label>
      <OverrideBadge overridden={row.field.overridden} />
    </span>
    <input type="hidden" name={`initial:${path}`} value={row.field.input} />
    <input type="hidden" name={`initialAuto:${path}`} value={row.auto ? "1" : "0"} />
    <input type="hidden" name={`stored:${path}`} value={row.field.overridden ? "1" : "0"} />
    <span className="flex flex-wrap items-center gap-2 text-[13px] text-fg-3">
      <span>기본 {row.defaultAuto ? `auto(${row.field.defaultInput}초)` : row.field.defaultInput === "" ? "없음(runner 25초)" : `${row.field.defaultInput}초`}</span>
      {auto && row.autoNote && <span>{row.autoNote}</span>}
      {row.field.overridden && <label className="flex items-center gap-1"><input type="checkbox" name={`reset:${path}`} disabled={readOnly} /> 기본값으로</label>}
    </span>
  </span>;
}

/**
 * 틱 예산(budgets) — 잡마다 알린 예산(초)·auto·호출 상한(파생)·감독 하한(env, 최근 관측 laneLimits.jobMs)·지금 도는 틱.
 * 예산은 호출 상한 + 2초 이상이어야 저장되고, 15초 안쪽이면 경고가 붙는다(lib/operations/runtime-settings-schema.ts).
 */
export function BudgetsForm({ budgets, revision, readOnly }: { budgets: BudgetRow[]; revision: number | null; readOnly?: boolean }) {
  // 역할별 묶음(입력 순서 유지) — 화면 모형이 이미 역할 순으로 정렬해 준다
  const groups = [...new Map(budgets.map(row => [row.role, { role: row.role, roleLabel: row.roleLabel, rows: budgets.filter(entry => entry.role === row.role) }])).values()];
  return <GroupForm group="budgets" revision={revision} readOnly={readOnly}>
    <p className="text-[13px] text-fg-3">예산은 워커가 lane heartbeat 로 알리고 감독은 env 하한과 「예산 + 45초」 중 큰 쪽을 job_timeout 으로 씁니다 — 긴 틱도 env·재배포 없이 삽니다.
      auto 는 호출 상한 + 공개 번역 틱 여유입니다.</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[960px] text-left text-[13px]"><thead><tr className="border-b border-line">
      <th className={TH}>잡</th><th className={TH}>예산(초)</th><th className={TH}>호출 상한(초)</th><th className={TH}>감독 하한(env)</th><th className={TH}>지금 도는 틱</th></tr></thead>
      {groups.map(group => <tbody key={group.role}>
        <tr className="border-b border-line bg-bg"><th colSpan={5} className="py-1.5 pr-3 text-left text-[13px] font-semibold text-fg-2">{group.roleLabel} <code className="font-normal text-fg-3">{group.role}</code></th></tr>
        {group.rows.map(row => <tr key={row.job} className="border-b border-line">
          <td className={TD}>{row.label}<br /><code className="text-[13px] text-fg-3">{row.job}</code>
            {row.warning && <p role="note" className="mt-1 max-w-[320px] text-[13px] text-amber-700">⚠ {row.warning}</p>}</td>
          <td className={TD}><BudgetCell row={row} readOnly={readOnly} /></td>
          <td className={`${TD} tabular-nums`}>{seconds(row.ceilingMs)}</td>
          <td className={`${TD} tabular-nums`}>{seconds(row.supervisorFloorMs)}</td>
          <td className={`${TD} text-[13px]`}>{laneText(row.lane)}</td>
        </tr>)}
      </tbody>)}</table></div>
  </GroupForm>;
}

"use client";

import { AI_TASK_POOL_MEMBER_SLOTS_MAX } from "@/lib/llm/ai-task-execution-config";
import type { AiRankChoice } from "@/lib/operations/admin-ai-tasks";

/**
 * 「동시에」의 모델별 칸 수(0179) — 이 단계에 그 모델이 내줄 칸 수. 모두 비우면 예전 작업 분산(단계 동시 수를 함께 나눠 씀).
 * 칸 수를 적으면 칸 수의 합만큼 함께 처리하고, 한 모델이 서도 남은 모델이 계속한다. 장비·모델 한도와 장부는 그대로 거친다.
 * 작업 배정의 실행 방식 폼과 단계 패널의 「동시에」가 같이 쓴다(운영 콘솔 통합). 모델은 사용자가 정한 이름(nameOf)으로만 적는다.
 */
export function PoolSlotFields({ value, slots, disabled, onChange, lanes, nameOf }: { value: readonly (AiRankChoice | null)[]; slots: readonly string[];
  disabled: boolean; onChange: (index: number, raw: string) => void; lanes: number | null; nameOf: (choice: AiRankChoice) => string }) {
  const rows = value.flatMap((choice, index) => choice ? [{ choice, index }] : []);
  if (!rows.length) return null;
  return <div className="grid min-w-0 gap-1 text-[13px]" data-pool-slots="true">
    <table className="w-full table-fixed border-collapse">
      <colgroup><col style={{ width: "72px" }} /><col /><col style={{ width: "96px" }} /></colgroup>
      <thead><tr className="text-left text-fg-3"><th className="font-normal">자리</th><th className="font-normal">고른 모델</th><th className="text-right font-normal">칸 수</th></tr></thead>
      <tbody>{rows.map(({ choice, index }) => <tr key={index}>
        <td className="tabular-nums">함께 {index + 1}</td>
        <td className="truncate" title={nameOf(choice)}>{nameOf(choice)}</td>
        <td className="text-right"><input type="number" inputMode="numeric" min={1} max={AI_TASK_POOL_MEMBER_SLOTS_MAX} step={1} placeholder="정하지 않음"
          aria-label={`함께 ${index + 1} 칸 수`} value={slots[index] ?? ""} disabled={disabled} onChange={event => onChange(index, event.target.value)}
          className="min-h-8 w-[88px] rounded-lg border border-line bg-bg-card px-2 text-right tabular-nums" /></td>
      </tr>)}</tbody>
    </table>
    <p className="text-fg-3">{lanes !== null ? `함께 최대 ${lanes}건을 처리합니다. 모델마다 적은 칸 수를 넘겨 보내지 않습니다.`
      : "칸 수를 비우면 예전처럼 단계 동시 수를 모델끼리 나눠 씁니다. 칸 수를 적으면 그 합만큼 함께 처리합니다."}</p>
  </div>;
}

/** 예비 켜기 — 묶은 모델이 모두 설 때 이 작업의 순위(1·2·3)로 이어서 처리 */
export function PoolReserveField({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex min-w-0 items-start gap-2 text-[13px]" data-pool-reserve="true">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="mt-1" />
    <span>예비 · 묶은 모델이 모두 설 때(실패·한도 초과·쉼) 이 작업의 순위(1·2·3)로 이어서 처리합니다. 끄면 예비 없이 기다립니다.</span>
  </label>;
}

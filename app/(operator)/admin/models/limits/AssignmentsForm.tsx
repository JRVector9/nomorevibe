"use client";
import type { SettingField } from "@/lib/operations/admin-runtime-settings";
import { ChoiceCell, GroupForm } from "./fields";

/**
 * 모델 배정 읽기(assignments 그룹, PR 3b-E) — 열거 칸 하나(배정 표 읽기: 끔·켬). 실시간 한도(/admin/models/limits)와 모델 배정(/admin/models/assignments)이
 * 같은 폼을 그린다. 저장은 다른 묶음과 같은 길(saveRuntimeSettingsGroup → saveRuntimeSettings → operations_audit)이고, 모든 역할이 30초 안에 같은 값을 읽는다.
 */
export function AssignmentsForm({ fields, revision, readOnly, compact }: { fields: SettingField[]; revision: number | null; readOnly?: boolean; compact?: boolean }) {
  return <GroupForm group="assignments" revision={revision} readOnly={readOnly}>
    {!compact && <h3 className="text-[15px] font-semibold">배정 표 읽기</h3>}
    <dl className="grid gap-3">
      {fields.map(field => <div key={field.path} className="grid gap-1">
        <dt className="text-[13px] font-semibold">{field.label}</dt>
        <dd><ChoiceCell field={field} readOnly={readOnly} />
          {field.note && <p className="mt-1 max-w-prose text-[13px] text-fg-3">{field.note}</p>}</dd>
      </div>)}
    </dl>
  </GroupForm>;
}

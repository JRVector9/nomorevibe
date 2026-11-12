"use client";
import type { SettingField } from "@/lib/operations/admin-runtime-settings";
import type { RuntimeSettingGroup } from "@/lib/operations/runtime-settings-schema";
import { GroupForm, ValueCell } from "./fields";

/**
 * 실시간 한도의 칸 몇 개를 그 값을 쓰는 화면에 그리는 폼(2026-11-11 실시간 한도 개편 — 공개 번역 화면의 번역 한도, 작업 배정 화면의 동시 업무).
 * 그룹 하나만 저장한다(saveRuntimeSettingsGroup → saveRuntimeSettings, 숨은 revision CAS). 칸 이름 규약은 ValueCell(value:·initial:·stored:·reset:) 그대로다.
 */
export function SettingsFieldsForm({ group, fields, revision, readOnly, units = {} }: { group: RuntimeSettingGroup; fields: SettingField[]; revision: number | null;
  readOnly?: boolean; units?: Readonly<Record<string, string>> }) {
  return <GroupForm group={group} revision={revision} readOnly={readOnly}>
    <dl className="grid gap-3 sm:grid-cols-2">
      {fields.map(field => <div key={field.path} className="grid gap-1">
        <dt className="text-[13px] font-semibold">{field.label}</dt>
        <dd><ValueCell field={field} readOnly={readOnly} unit={units[field.path]} />
          {field.note && <p className="mt-1 max-w-prose text-[13px] text-fg-3">{field.note}</p>}</dd>
      </div>)}
    </dl>
  </GroupForm>;
}

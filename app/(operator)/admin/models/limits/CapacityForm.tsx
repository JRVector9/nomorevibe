"use client";
import type { SettingField } from "@/lib/operations/admin-runtime-settings";
import { GroupForm, ValueCell } from "./fields";

/**
 * 모델 장부 점유(capacity 그룹, 2026-11-10 소유자 결정 「결과 미확정 점유」) — 결과 미확정 행이 칸을 계속 차지하는 시간(초) 한 칸.
 * 저장은 다른 묶음과 같은 길(saveRuntimeSettingsGroup → saveRuntimeSettings → operations_audit)이고, 입장 TX 가 행을 바로 읽어 저장 즉시 다음 입장부터 바뀐다.
 */
export function CapacityForm({ fields, revision, readOnly }: { fields: SettingField[]; revision: number | null; readOnly?: boolean }) {
  return <GroupForm group="capacity" revision={revision} readOnly={readOnly} summary="저장하면 배포 없이 다음 모델 입장부터 씁니다(30초 스냅숏을 거치지 않습니다).">
    <dl className="grid gap-3">
      {fields.map(field => <div key={field.path} className="grid gap-1">
        <dt className="text-[13px] font-semibold">{field.label}</dt>
        <dd><ValueCell field={field} readOnly={readOnly} unit="초" />
          {field.note && <p className="mt-1 max-w-prose text-[13px] text-fg-3">{field.note}</p>}</dd>
      </div>)}
    </dl>
  </GroupForm>;
}

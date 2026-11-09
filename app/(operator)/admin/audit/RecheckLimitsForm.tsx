"use client";
import { useActionState, useState } from "react";
import type { RecheckLimitField } from "@/lib/operations/admin-runtime-settings";
import { ConfirmSubmit } from "../models/ConfirmSubmit";
import { ValueCell } from "../models/limits/fields";
import { saveRecheckLimits, type RecheckLimitsSaveState } from "./actions";

/**
 * 공개분 변경 재판정의 한도 다섯 칸(jobs.published-recheck)을 보이는 그 자리에서 고친다(2026-11-09 운영자 요청). 칸마다 폼 하나 — 입력·「저장」(두 단계 확인)·결과.
 * 칸 이름 규약(value:·initial:·stored:·reset:)은 실시간 한도 화면과 같다(lib/operations/admin-runtime-settings.ts runtimeSettingsPatchFromForm).
 * 저장은 saveRecheckLimits(saveRuntimeSettings group jobs, 숨은 expectedRevision CAS)이고, 저장 뒤 화면이 저장 행을 다시 읽어 새 값·revision 을 그린다.
 * readOnly(저장 행을 못 읽음·읽기 전용 미리보기)이면 칸과 단추가 꺼진다 — 서버의 쓰기 관문도 거절한다.
 */
export function RecheckLimitsForm({ fields, revision, readOnly, readOnlyReason }: { fields: RecheckLimitField[]; revision: number | null; readOnly: boolean;
  readOnlyReason: string | null }) {
  return <div className="grid gap-2">
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {fields.map((field) => <RecheckLimitCell key={field.path} field={field} revision={revision} readOnly={readOnly} />)}
    </div>
    <p className="text-fg-3">
      잡별 묶음의 <code>published-recheck</code> 줄입니다(실시간 한도 화면과 같은 저장 행{revision !== null ? <> · revision <span className="font-mono">{revision}</span></> : null}).
      저장하면 배포 없이 각 워커가 30초 안에 다음 틱부터 씁니다.{readOnly && readOnlyReason ? ` ${readOnlyReason}` : ""}
    </p>
  </div>;
}

function RecheckLimitCell({ field, revision, readOnly }: { field: RecheckLimitField; revision: number | null; readOnly: boolean }) {
  const [state, action, pending] = useActionState<RecheckLimitsSaveState, FormData>(saveRecheckLimits, null);
  const [dirty, setDirty] = useState(false);
  return <form action={action} data-dirty={dirty || undefined} onChange={() => setDirty(true)}
    className="grid gap-1 rounded-lg border border-line bg-bg px-3 py-2" aria-label={field.label}>
    <input type="hidden" name="expectedRevision" value={revision ?? ""} />
    <input type="hidden" name={`unit:${field.path}`} value={field.unit} />
    <span className="text-[13px] font-semibold text-fg">{field.label}</span>
    <ValueCell field={field} readOnly={readOnly} unit={field.unit} />
    <span className="text-[13px] text-fg-3">범위 {field.min.toLocaleString("ko-KR")}~{field.max.toLocaleString("ko-KR")}{field.unit}{field.note ? ` · ${field.note}` : ""}</span>
    <span className="flex flex-wrap items-center gap-2">
      <ConfirmSubmit label="저장" pending={pending} disabled={readOnly || revision === null} savedKey={revision}
        summary="저장하면 배포 없이 각 워커가 30초 안에 다음 틱부터 씁니다." />
    </span>
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.issues?.map((text) => <p key={text} role="alert" className="text-[13px] text-red-600">저장 거절 — {text}</p>)}
  </form>;
}

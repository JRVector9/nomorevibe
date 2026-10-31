"use client";
import Link from "next/link";
import { useActionState } from "react";
// 형만 가져온다 — 서버 모듈(DB·node:crypto)
import type { AssignmentImportPreview } from "@/lib/operations/admin-model-assignments";
import { applyAssignmentImportAction, type AssignmentImportState } from "./actions";

const TH = "py-2 pr-3 text-[13px] font-semibold text-fg-3";
const TD = "py-2 pr-3 align-top";

/**
 * 「현재 설정 → 배정 표 가져오기」 — 「계획 보기」(쓰지 않는다)가 만들기·고치기·그대로 행과 경고를 보이고, 확인 「배정」 + 「적용」이 서버에서 계획을 다시 만들어
 * 보여 준 계획(hash)과 같을 때만 행마다 같은 저장 함수로 저장한다. 행마다 결과(저장 판·거절 문장·건너뜀)를 아래에 보인다.
 */
export function ImportCard({ preview, readOnly, confirmWord }: { preview: AssignmentImportPreview | null; readOnly?: boolean; confirmWord: string }) {
  const [state, action, pending] = useActionState<AssignmentImportState, FormData>(applyAssignmentImportAction, null);
  const pendingRows = preview ? preview.counts.create + preview.counts.update : 0;
  return <div className="grid gap-3 rounded-xl border border-line bg-bg-card p-5 text-[14px]">
    <div className="flex flex-wrap items-center gap-3">
      <Link href="/admin/models/assignments?import=plan#import" prefetch={false} className="rounded border border-line px-3 py-2 font-semibold">
        {preview ? "계획 다시 보기" : "계획 보기"}</Link>
      <span className="text-[13px] text-fg-3">지금 설정(1차·추가 1차·2차 투표·2차 대체·단계별 모델 풀)을 배정 표 행으로 옮기는 계획입니다. 보기만으로는 아무것도 쓰지 않습니다.</span>
    </div>
    {preview?.error && <p role="alert" className="text-[13px] text-red-600">계획을 만들지 못했습니다: {preview.error}</p>}
    {preview && !preview.error && <>
      <p className="text-[13px] text-fg-2">만들기 <strong>{preview.counts.create}</strong> · 고치기 <strong>{preview.counts.update}</strong> · 그대로 {preview.counts.unchanged}
        {preview.hash && <> · 계획 <code title={preview.hash}>{preview.hash.slice(0, 12)}</code></>}</p>
      {preview.warnings.map(text => <p key={text} role="note" className="text-[13px] text-amber-700">경고 — {text}</p>)}
      {preview.rows.length === 0 ? <p className="text-[13px] text-fg-3">옮길 행이 없습니다.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-left text-[13px]"><thead><tr className="border-b border-line">
          <th className={TH}>동작</th><th className={TH}>설정의 출처</th><th className={TH}>배정 이름</th><th className={TH}>단계</th><th className={TH}>장비</th>
          <th className={TH}>모델</th><th className={TH}>전송</th><th className={TH}>순위</th><th className={TH}>모드</th><th className={TH}>바뀐 칸</th></tr></thead>
          <tbody>{preview.rows.map(row => <tr key={row.index} className="border-b border-line" data-action={row.action}>
            <td className={`${TD} font-semibold`}>{row.actionLabel}</td><td className={TD}><code>{row.origin}</code></td>
            <td className={TD}><code className="break-all">{row.assignmentId}</code></td><td className={TD}>{row.stageLabel}</td>
            <td className={TD}><code>{row.deviceId}</code></td><td className={TD}><code>{row.registryKey}</code></td><td className={TD}>{row.transport}</td>
            <td className={`${TD} tabular-nums`}>{row.rank ?? "—"}</td><td className={TD}>{row.mode === "live" ? "실전" : "꺼짐"}{row.vote ? " · 투표" : ""}</td>
            <td className={TD}>{row.changes.length ? row.changes.map(line => <div key={line}>{line}</div>) : "—"}</td>
          </tr>)}</tbody></table></div>}
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="planHash" value={preview.hash ?? ""} />
        <label className="grid gap-0.5 text-[13px]"><span className="font-semibold text-fg-2">확인 — 「{confirmWord}」 을 적으세요</span>
          <input name="confirm" autoComplete="off" placeholder={confirmWord} disabled={readOnly} aria-label="가져오기 확인"
            className="w-40 rounded border border-line bg-bg px-2 py-1 text-[13px]" /></label>
        <button type="submit" disabled={pending || readOnly || pendingRows === 0} className="rounded bg-fg px-3 py-2 text-bg disabled:opacity-50">
          {pending ? "적용 중…" : `적용(행 ${pendingRows}개를 하나씩 저장)`}</button>
        <span className="text-[13px] text-fg-3">행마다 따로 저장합니다 — 한 행이 거절돼도 다음 행을 계속하고, 그 사이 계획이 바뀌었으면 아무것도 쓰지 않습니다.</span>
      </form>
    </>}
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">적용 거절 — {text}</p>)}
    {state?.rows && state.rows.length > 0 && <ul className="grid gap-0.5 text-[13px]" aria-label="행마다 결과">{state.rows.map(row =>
      <li key={row.index} data-ok={row.ok} className={row.ok ? "" : "text-red-600"}><code>{row.assignmentId}</code> ({row.origin}) — {row.message}</li>)}</ul>}
  </div>;
}

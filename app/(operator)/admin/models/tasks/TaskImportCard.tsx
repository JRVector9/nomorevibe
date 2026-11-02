"use client";
import Link from "next/link";
import { useActionState } from "react";
import { aiTask, aiTaskSlotLabel } from "@/lib/llm/ai-tasks";
// 형만 가져온다 — 서버 모듈(DB·node:crypto)
import type { AiImportPreview } from "@/lib/operations/admin-ai-tasks-repository";
import { aiModelsErrorText } from "@/lib/operations/admin-ai-tasks";
import { applyAiTaskImportAction, type AiTaskActionState } from "./actions";

const TH = "py-2 pr-3 text-[13px] font-semibold text-fg-3";
const TD = "py-2 pr-3 align-top";
const CONNECTION_ACTIONS = { create: "만들기", update: "모델 이름 더하기", existing: "그대로" } as const;
const SLOT_ACTIONS = { create: "채우기", unchanged: "그대로", differs: "다름 — 건너뜀", empty: "옮길 것 없음" } as const;

/**
 * 「지금 설정 → 작업 ↔ 모델 가져오기」 — 「계획 보기」(쓰지 않는다; 아직 연결이 없는 엔진의 GET /models 만 읽는다)가 만들 연결과 칸마다의 순위·경고를 보이고,
 * 확인 「가져오기」 + 「적용」이 서버에서 계획을 다시 만들어 보여 준 hash 와 같을 때만 한 번에 쓴다. 이미 순위가 있는 칸은 덮지 않는다.
 */
export function TaskImportCard({ preview, confirmWord }: { preview: AiImportPreview | null; confirmWord: string }) {
  const [state, action, pending] = useActionState<AiTaskActionState, FormData>(applyAiTaskImportAction, null);
  const plan = preview?.plan ?? null;
  const writes = plan ? plan.connections.filter(row => row.action !== "existing").length + plan.slots.filter(row => row.action === "create").length : 0;
  const label = (key: string) => preview?.connectionLabels[key] ?? key.replace(/^api:|^cli:/, "");
  return <div className="grid gap-3 rounded-xl border border-line bg-bg-card p-5 text-[14px]">
    <div className="flex flex-wrap items-center gap-3">
      <Link href="/admin/models/tasks?import=plan#import" prefetch={false} className="rounded border border-line px-3 py-2 font-semibold">{preview ? "계획 다시 보기" : "계획 보기"}</Link>
      <span className="text-[13px] text-fg-3">지금 잡이 고르는 모델(설정·단계 풀·등록부·env·배정 표·연결 계약)을 연결과 1·2·3순위로 옮기는 계획입니다. 보기만으로는 아무것도 쓰지 않습니다.
        서버 주소는 지금 쓰는 연결 계약·등록부·env 의 주소만 씁니다(지어내지 않습니다).</span>
    </div>
    {preview?.error && <p role="alert" className="text-[13px] text-red-600">계획을 만들지 못했습니다: {preview.error}</p>}
    {plan && <>
      <p className="text-[13px] text-fg-2">연결 {plan.connections.filter(row => row.action === "create").length}개 만들기 · 순위 채울 칸 {plan.slots.filter(row => row.action === "create").length}개
        · 그대로 {plan.slots.filter(row => row.action === "unchanged").length}개{preview?.hash && <> · 계획 <code title={preview.hash}>{preview.hash.slice(0, 12)}</code></>}</p>
      {preview && preview.servers.length > 0 && <ul className="grid gap-0.5 text-[13px]" aria-label="새 연결의 모델 목록 읽기">{preview.servers.map(server =>
        <li key={server.baseUrl}><code>{server.baseUrl}</code> — {server.error ? <span className="text-amber-700">목록 못 읽음({aiModelsErrorText(server.error)})</span> : `모델 ${server.count}개`}</li>)}</ul>}
      {plan.warnings.map(text => <p key={text} role="note" className="text-[13px] text-amber-700">경고 — {text}</p>)}
      {plan.connections.length > 0 && <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-[13px]"><thead><tr className="border-b border-line">
        <th className={TH}>연결</th><th className={TH}>동작</th><th className={TH}>주소 · 도구</th><th className={TH}>장비 · 칸</th><th className={TH}>키</th></tr></thead>
        <tbody>{plan.connections.map(row => <tr key={row.key} className="border-b border-line" data-action={row.action}>
          <td className={`${TD} font-semibold`}>{row.label}</td><td className={TD}>{CONNECTION_ACTIONS[row.action]}</td>
          <td className={TD}>{row.kind === "api" ? <code className="break-all">{row.baseUrl}</code> : <>{row.cliTool} · <code>{row.cliModels.join(" ")}</code></>}</td>
          <td className={TD}><code>{row.deviceId}</code> · {row.capacitySlots}칸</td>
          <td className={TD}>{row.keyFrom ? `계약 ${row.keyFrom.routeId}의 저장 키를 옮김` : row.keyEnv ? `env ${row.keyEnv} 를 옮김` : "—"}</td>
        </tr>)}</tbody></table></div>}
      {plan.slots.length > 0 && <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-[13px]"><thead><tr className="border-b border-line">
        <th className={TH}>작업</th><th className={TH}>동작</th><th className={TH}>1·2·3순위(출처)</th></tr></thead>
        <tbody>{plan.slots.map(row => { const task = aiTask(row.task); return <tr key={`${row.task}#${row.slot}`} className="border-b border-line" data-action={row.action}>
          <td className={`${TD} font-semibold`}>{task ? aiTaskSlotLabel(task, row.slot) : row.task}</td><td className={TD}>{SLOT_ACTIONS[row.action]}</td>
          <td className={TD}>{row.ranks.length ? row.ranks.map(rank => <div key={rank.rank}>{rank.rank}. {label(rank.connectionKey)} · <code>{rank.model}</code>
            <span className="text-fg-3"> ({rank.origin}{Object.keys(rank.options).length ? ` · ${JSON.stringify(rank.options)}` : ""})</span></div>) : "—"}</td>
        </tr>; })}</tbody></table></div>}
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="planHash" value={preview?.hash ?? ""} />
        <label className="grid gap-0.5 text-[13px]"><span className="font-semibold text-fg-2">확인 — 「{confirmWord}」를 적으세요</span>
          <input name="confirm" autoComplete="off" placeholder={confirmWord} aria-label="가져오기 확인" className="w-40 rounded border border-line bg-bg px-2 py-1 text-[13px]" /></label>
        <button type="submit" disabled={pending || writes === 0} className="rounded bg-fg px-3 py-2 text-bg disabled:opacity-50">{pending ? "적용 중…" : `적용(쓰기 ${writes}건)`}</button>
        <span className="text-[13px] text-fg-3">한 번에 씁니다 — 계획이 그 사이 바뀌었으면 아무것도 쓰지 않습니다. 계약·용량 경로·장비는 만들지 않습니다(오늘 없는 것은 오늘도 없습니다).</span>
      </form>
    </>}
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.warnings?.map(text => <p key={text} role="note" className="text-[13px] text-amber-700">알림 — {text}</p>)}
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">적용 거절 — {text}</p>)}
  </div>;
}

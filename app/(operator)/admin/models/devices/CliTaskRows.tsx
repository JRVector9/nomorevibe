"use client";

import { useActionState, useId, useState } from "react";
import type { CliTaskUsage } from "@/lib/operations/cli-task-usage";
import { saveCliTaskModelAction, type CliTaskSaveState } from "./cli-actions";
import "./cli-rows.css";

const NO_EFFORT = "이 모델은 추론 강도를 받지 않습니다";

/**
 * 장비 표의 CLI 장비 줄 아래에 붙는 작업 줄들(한 작업 = 한 `<tr class="child">`). 1열 = 작업 이름 + 작게 순위·출처, 가운데(columns − 2칸) = 모델·추론 강도,
 * 마지막 열 = 저장. 모델을 바꾸면 그 모델이 받는 강도로 목록을 다시 만든다(「기본」 = 강도를 넘기지 않음 — 어댑터 기본값이 있으면 괄호로 보인다).
 * 실행 쪽이 순위를 읽지 않거나 다른 설정에서 오는 줄은 값만 보이고 실제 설정 위치로 보낸다(lib/operations/cli-task-usage.ts).
 */
export function CliTaskRows({ usages, columns = 7 }: { usages: readonly CliTaskUsage[]; columns?: number }) {
  return <>{usages.map(usage => <CliTaskRow key={usage.key} usage={usage} columns={columns} />)}</>;
}

function CliTaskRow({ usage, columns }: { usage: CliTaskUsage; columns: number }) {
  const [state, action, pending] = useActionState<CliTaskSaveState, FormData>(saveCliTaskModelAction, null);
  const [model, setModel] = useState(usage.model);
  const [effort, setEffort] = useState(usage.effort ?? "");
  const formId = `cli-task-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const efforts = usage.effortsByModel[model] ?? [];
  const savedEffort = usage.effort ?? "";
  const changed = model !== usage.model || effort !== savedEffort;
  const editable = usage.edit !== null;
  const label = `${usage.taskLabel} ${usage.connectionLabel}`;
  const middle = Math.max(1, columns - 2);
  const pickModel = (next: string) => {
    setModel(next);
    if (!(usage.effortsByModel[next] ?? []).includes(effort)) setEffort("");
  };
  return <tr className="child cli-task-row" data-cli={usage.cliTool} data-source={usage.source}>
    <td className="cli-task">{usage.taskLabel}<small>{usage.where}</small></td>
    <td colSpan={middle}>
      {editable ? <span className="cli-sel-pair">
        <span className="cli-lb">모델</span>
        <select className="cli-sel" form={formId} name="model" value={model} disabled={pending} data-changed={model !== usage.model || undefined}
          aria-label={`${label} 모델`} onChange={event => pickModel(event.target.value)}>
          {usage.models.map(entry => <option key={entry} value={entry}>{entry}</option>)}
        </select>
        <span className="cli-lb">추론 강도</span>
        <select className="cli-sel" form={formId} name="reasoningEffort" value={effort} disabled={pending || efforts.length === 0}
          title={efforts.length ? undefined : NO_EFFORT} data-changed={effort !== savedEffort || undefined}
          aria-label={`${label} 추론 강도`} onChange={event => setEffort(event.target.value)}>
          <option value="">{usage.defaultEffort ? `기본(${usage.defaultEffort})` : "기본"}</option>
          {efforts.map(entry => <option key={entry} value={entry}>{entry}</option>)}
          {effort && !efforts.includes(effort) && <option value={effort} disabled>{effort} (이 모델은 받지 않음)</option>}
        </select>
      </span> : <span className="cli-sel-pair">
        <span className="cli-lb">모델</span><span className="cli-value">{usage.model}</span>
        <span className="cli-lb">추론 강도</span>
        <span className="cli-value" title={efforts.length || usage.effort ? undefined : NO_EFFORT}>{usage.effort ?? (usage.defaultEffort ? `기본(${usage.defaultEffort})` : "기본")}</span>
      </span>}
      {usage.readOnly && <span className="cli-note">{usage.readOnly.reason} · <a href={usage.readOnly.href}>{usage.readOnly.linkLabel} →</a></span>}
    </td>
    <td>{editable && <form id={formId} action={action} className="cli-save">
      <input type="hidden" name="task" value={usage.task} />
      <input type="hidden" name="slot" value={usage.slot} />
      <input type="hidden" name="rank" value={usage.rank ?? ""} />
      <input type="hidden" name="revision" value={usage.edit!.revision} />
      <input type="hidden" name="connectionId" value={usage.connectionId ?? ""} />
      <button type="submit" disabled={!changed || pending} aria-label={`${label} 저장`}>{pending ? "저장 중" : "저장"}</button>
      {state?.ok && !changed && <span role="status" className="cli-result">{state.message}</span>}
      {state?.issues?.map(issue => <span key={issue} role="alert" className="cli-result">{issue}</span>)}
      {state?.warnings?.map(text => <span key={text} role="note" className="cli-result">{text}</span>)}
    </form>}</td>
  </tr>;
}

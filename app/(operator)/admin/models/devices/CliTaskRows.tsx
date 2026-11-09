"use client";

import { useActionState, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CliTaskUsage } from "@/lib/operations/cli-task-usage";
import { codexOperation } from "../../status/actions";
import { saveCliStageModelAction, saveCliTaskModelAction, type CliTaskSaveState } from "./cli-actions";
import "./cli-rows.css";

const NO_EFFORT = "이 모델은 추론 강도를 받지 않습니다";
const CONNECT_POLL_MS = 2_000, CONNECT_WAIT_MS = 120_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 장비 표의 CLI 장비 줄 아래에 붙는 작업 줄들(한 작업 = 한 `<tr class="child">`). 1열 = 작업 이름 + 작게 순위·출처, 가운데(columns − 2칸) = 모델·추론 강도,
 * 마지막 열 = 저장. 모델을 바꾸면 그 모델이 받는 강도로 목록을 다시 만든다(「기본」 = 강도를 저장하지 않음 — 어댑터 기본값이 있으면 괄호로 보인다).
 * 저장 길은 줄마다 실행 쪽이 읽는 자리다(lib/operations/cli-task-usage.ts): 순위(saveCliTaskModelAction)·소개 검수 단계 풀(saveCliStageModelAction)·
 * connect 에이전트(운영센터 AI 연결과 같은 codexOperation 검사 → 적용). 다른 출처의 줄은 값만 보이고 실제 설정 위치로 보낸다.
 */
export function CliTaskRows({ usages, columns = 7 }: { usages: readonly CliTaskUsage[]; columns?: number }) {
  return <>{usages.map(usage => <CliTaskRow key={usage.key} usage={usage} columns={columns} />)}</>;
}

function CliTaskRow({ usage, columns }: { usage: CliTaskUsage; columns: number }) {
  const save = usage.edit?.kind === "stage" ? saveCliStageModelAction : saveCliTaskModelAction;
  const [formState, action, formPending] = useActionState<CliTaskSaveState, FormData>(save, null);
  const [connectState, setConnectState] = useState<CliTaskSaveState>(null);
  const [connectPending, startConnect] = useTransition();
  const router = useRouter();
  const [model, setModel] = useState(usage.model);
  const [effort, setEffort] = useState(usage.effort ?? "");
  const formId = `cli-task-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const edit = usage.edit;
  const connect = edit?.kind === "connect";
  const pending = formPending || connectPending;
  const state = connect ? connectState : formState;
  const efforts = usage.effortsByModel[model] ?? [];
  const savedEffort = usage.effort ?? "";
  const changed = model !== usage.model || effort !== savedEffort;
  const label = `${usage.taskLabel} ${usage.connectionLabel}`;
  const middle = Math.max(1, columns - 2);
  const nameOf = (value: string) => usage.modelLabels?.[value] ?? value;
  const pickModel = (next: string) => {
    setModel(next);
    const list = usage.effortsByModel[next] ?? [];
    // connect 설정은 강도가 늘 있어야 한다(두 도구 모두 high 를 받는다) — 나머지는 「기본」으로 돌린다
    if (!list.includes(effort)) setEffort(connect ? (list.includes("high") ? "high" : list[0] ?? "") : "");
  };

  /** 운영센터 AI 연결과 같은 길: 지금 설정·판을 읽고 → 이 칸만 바꾼 설정을 검사(test) → 검사 통과를 기다려 → 적용(apply). */
  const applyConnect = () => startConnect(async () => {
    if (edit?.kind !== "connect") return;
    setConnectState(null);
    const fail = (text: string) => setConnectState({ issues: [text] });
    const read = await codexOperation("status");
    if (read.error || !read.status) return fail(read.error ?? "connect 에이전트 상태를 읽지 못했습니다.");
    const base = read.status.config;
    const next = { ...base, [edit.which]: { model, effort } } as typeof base;
    const test = await codexOperation("test", { config: next });
    if (test.error || !test.status) return fail(test.error ?? "검사를 시작하지 못했습니다.");
    const id = test.status.verification?.id;
    if (!id) return fail("검사를 시작하지 못했습니다.");
    let last = test.status;
    for (const startedAt = Date.now(); Date.now() - startedAt < CONNECT_WAIT_MS;) {
      if (last.verification?.id === id && last.verification.state !== "running") break;
      await sleep(CONNECT_POLL_MS);
      const polled = await codexOperation("status");
      if (polled.error || !polled.status) return fail(polled.error ?? "검사 결과를 읽지 못했습니다.");
      last = polled.status;
    }
    const verification = last.verification;
    if (!verification || verification.id !== id) return fail("그사이 다른 검사가 시작되었습니다 — 다시 시도하세요.");
    if (verification.state === "running") return fail("검사가 아직 끝나지 않았습니다 — AI 연결·설정에서 결과를 확인하세요.");
    if (verification.state !== "verified")
      return fail(`검사를 통과하지 못했습니다(${verification.results.map(row => `${row.model} ${row.result}`).join(" · ") || verification.state}).`);
    const applied = await codexOperation("apply", { config: next, verificationId: id, expectedVersion: last.configVersion });
    if (applied.error) return fail(applied.error);
    setConnectState({ ok: true, message: `카테고리 분류 ${edit.which === "primary" ? "우선" : "예비"}: ${model} · ${effort}로 검사 후 적용했습니다.` });
    router.refresh();
  });

  const effortLocked = efforts.length <= (connect ? 1 : 0);
  return <tr className="child cli-task-row" data-cli={usage.cliTool} data-source={usage.source}>
    <td className="cli-task">{usage.taskLabel}<small>{usage.where}</small></td>
    <td colSpan={middle}>
      {edit ? <span className="cli-sel-pair">
        <span className="cli-lb">모델</span>
        <select className="cli-sel" form={formId} name="model" value={model} disabled={pending} data-changed={model !== usage.model || undefined}
          aria-label={`${label} 모델`} onChange={event => pickModel(event.target.value)}>
          {usage.models.map(entry => <option key={entry} value={entry}>{nameOf(entry)}</option>)}
        </select>
        <span className="cli-lb">추론 강도</span>
        <select className="cli-sel" form={formId} name="reasoningEffort" value={effort} disabled={pending || effortLocked}
          title={efforts.length === 0 ? NO_EFFORT : effortLocked ? `이 모델은 ${efforts[0]}만 받습니다` : undefined}
          data-changed={effort !== savedEffort || undefined} aria-label={`${label} 추론 강도`} onChange={event => setEffort(event.target.value)}>
          {!connect && <option value="">{usage.defaultEffort ? `기본(${usage.defaultEffort})` : "기본"}</option>}
          {efforts.map(entry => <option key={entry} value={entry}>{entry}</option>)}
          {effort && !efforts.includes(effort) && <option value={effort} disabled>{effort} (이 모델은 받지 않음)</option>}
        </select>
      </span> : <span className="cli-sel-pair">
        <span className="cli-lb">모델</span><span className="cli-value">{nameOf(usage.model)}</span>
        <span className="cli-lb">추론 강도</span>
        <span className="cli-value" title={efforts.length || usage.effort ? undefined : NO_EFFORT}>{usage.effort ?? (usage.defaultEffort ? `기본(${usage.defaultEffort})` : "기본")}</span>
      </span>}
      {usage.readOnly && <span className="cli-note">{usage.readOnly.reason} · <a href={usage.readOnly.href}>{usage.readOnly.linkLabel} →</a></span>}
      {connect && <span className="cli-note">저장하면 connect 에이전트가 표본 분류로 이 설정을 검사하고, 통과하면 적용합니다(모델당 최대 35초).</span>}
    </td>
    <td>{edit && <form id={formId} action={connect ? undefined : action} className="cli-save"
      onSubmit={connect ? event => { event.preventDefault(); applyConnect(); } : undefined}>
      {edit.kind === "rank" && <>
        <input type="hidden" name="task" value={usage.task} />
        <input type="hidden" name="slot" value={usage.slot} />
        <input type="hidden" name="rank" value={usage.rank ?? ""} />
        <input type="hidden" name="revision" value={edit.revision} />
        <input type="hidden" name="connectionId" value={usage.connectionId ?? ""} />
      </>}
      {edit.kind === "stage" && <>
        <input type="hidden" name="stage" value={edit.stage} />
        <input type="hidden" name="settingsVersion" value={edit.settingsVersion} />
        <input type="hidden" name="currentKey" value={edit.currentKey} />
      </>}
      <button type="submit" disabled={!changed || pending} aria-label={`${label} 저장`}>
        {pending ? (connect ? "검사 중" : "저장 중") : connect ? "검사 후 적용" : "저장"}</button>
      {state?.ok && !changed && <span role="status" className="cli-result">{state.message}</span>}
      {state?.issues?.map(issue => <span key={issue} role="alert" className="cli-result">{issue}</span>)}
      {state?.warnings?.map(text => <span key={text} role="note" className="cli-result">{text}</span>)}
    </form>}</td>
  </tr>;
}

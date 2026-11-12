"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { aiRankReasoningEfforts, AI_RANK_SLOT_NAMES, type AiRankChoice, type AiRankOption, type AiConnectionView } from "@/lib/operations/admin-ai-tasks";
import { aiTaskEditTarget } from "@/lib/operations/ai-task-edit-target";
import { FLOW_RANK_LOCKS, flowOptionBlocked, flowRankIssues, needsAcknowledge, rankForm, rankWarnings, type FlowRankEditor, type FlowRankLine } from "@/lib/operations/flow-rank-editor";
import { assignmentPreview, MODE_LABELS, poolMemberIssues, type AssignmentState, type PreviewContext, type StageModelLine } from "@/lib/operations/stage-panel-model";
import { RankSelects } from "../models/RankSelects";
import { modelPickerConnectionLabel, modelPickerModelLabel } from "../models/model-picker-display";
import { saveAiTaskRanksAction } from "../models/tasks/actions";
import { saveTaskExecutionAction } from "../models/tasks/execution-actions";

/**
 * 단계 패널 「모델」 구역(운영 콘솔 개편 조각 2a) — 지금 배정(순위대로: 1·2·3순위 / 동시에: 함께 쓰는 모델)을 보이고 그 자리에서 고친다.
 * 저장은 새 길이 없다: 순위는 작업 배정·흐름 서랍과 같은 saveAiTaskRanksAction(같은 폼 칸 rankForm·같은 검사 flowRankIssues),
 * 방식 전환·함께 쓰는 모델은 작업 배정 「실행 방식」과 같은 saveTaskExecutionAction(같은 판 expectedRevision)을 부른다. 작업 로그에 전·후가 남고 홈 「바꾼 것 지켜보기」에 한 줄이 생긴다.
 * 차례: 고르기 → 저장 전 확인(바뀌는 값 전 → 후 · 영향을 받는 단계, assignmentPreview) → 저장됨. 「동시에」는 그 작업이 지금 받을 때만 켠다(line.poolSupported).
 */
type Step = "view" | "edit" | "confirm" | "saving" | "done";
type Props = { lines: StageModelLine[]; editor: FlowRankEditor | null; context: PreviewContext; lockReason: string | null };
type Answer = { ok?: true; message?: string; issues?: string[]; warnings?: string[] } | null;

const POOL_SLOTS = Array.from({ length: 4 }, (_, index) => ({ provider: `pool${index + 1}Connection`, model: `pool${index + 1}Model`,
  reasoningEffort: `pool${index + 1}ReasoningEffort` }));

export function StageModels({ lines, editor, context, lockReason }: Props) {
  return <div className="sp-models">{lines.map(line => <ModelLine key={line.key} line={line} showLabel={lines.length > 1}
    flowLine={editor?.lines.find(entry => entry.key === line.key) ?? null} editor={editor} context={context} lockReason={lockReason} />)}</div>;
}

/** 저장된 작업 분산 구성원 → 선택 값 */
function savedMembers(flowLine: FlowRankLine | null): AiRankChoice[] {
  return (flowLine?.execution?.members ?? []).map(member => ({ provider: member.connectionId, model: member.model,
    ...(typeof member.options.reasoningEffort === "string" && member.options.reasoningEffort ? { reasoningEffort: member.options.reasoningEffort } : {}) }));
}

/** 작업 분산 선택지 — 작업 배정 실행 방식 폼과 같다(발행 분류는 API·OpenCode 만, 저장된 값은 목록에 없어도 보인다) */
function poolOptions(flowLine: FlowRankLine, connections: readonly AiConnectionView[], apiOnly: boolean): AiRankOption[] {
  const options: AiRankOption[] = flowLine.options.filter(option => !option.off && (!apiOnly
    || connections.some(connection => connection.id === option.provider && (connection.kind === "api" || connection.cliTool === "opencode"))));
  for (const member of flowLine.execution?.members ?? []) if (!options.some(option => option.provider === member.connectionId && option.model === member.model)) {
    const connection = connections.find(row => row.id === member.connectionId);
    options.push({ provider: member.connectionId, model: member.model, saved: true,
      label: `${connection ? modelPickerConnectionLabel(connection) : "연결 없음"} · ${member.model} (저장된 값)`,
      group: connection ? modelPickerConnectionLabel(connection) : "연결 없음", text: connection ? modelPickerModelLabel(connection, member.model) : member.model,
      reasoningEfforts: connection ? aiRankReasoningEfforts(flowLine.task, connection, member.model) : [] });
  }
  return options;
}

function ModelLine({ line, showLabel, flowLine, editor, context, lockReason }: { line: StageModelLine; showLabel: boolean; flowLine: FlowRankLine | null;
  editor: FlowRankEditor | null; context: PreviewContext; lockReason: string | null }) {
  const router = useRouter();
  const savedMode = flowLine?.execution?.mode ?? line.mode;
  const before: AssignmentState = { mode: savedMode, ranks: flowLine?.saved ?? [], members: savedMembers(flowLine) };
  const [step, setStep] = useState<Step>("view");
  const [draft, setDraft] = useState<AssignmentState>(before);
  const [ack, setAck] = useState(false);
  const [results, setResults] = useState<{ ok: boolean; text: string; issues: string[]; warnings: string[] }[]>([]);
  // 바꿀 수 없는 까닭 — 순위를 못 읽음 · 화면에서 못 바꾸는 작업(소개 검수) · 실제 적용 설정이 따로 있는 작업
  const locked = !flowLine || !editor ? "순위를 읽지 못해 여기서 바꿀 수 없습니다." : FLOW_RANK_LOCKS[line.task] ?? null;
  const elsewhere = flowLine && !flowLine.live && line.task !== "publish-classify" ? aiTaskEditTarget(line.task) : null;
  const rankEditable = !locked && !elsewhere && !line.apiOnly;
  const canEdit = !locked && !elsewhere && (rankEditable || line.poolSupported);
  const preview = flowLine && editor ? assignmentPreview({ task: line.task, slot: line.slot, before, after: draft, context }) : null;
  const rankIssues = flowLine && editor && draft.mode === "fallback" && preview?.saves.includes("ranks") ? flowRankIssues(editor, flowLine, draft.ranks) : [];
  const poolIssues = editor && draft.mode === "workload_pool" ? poolMemberIssues(draft.members, editor.connections, line.apiOnly) : [];
  const warnings = flowLine && editor && preview?.saves.includes("ranks") ? rankWarnings(editor, [flowLine], { [flowLine.key]: draft.ranks }) : [];
  const mustAck = needsAcknowledge(warnings);
  const issues = [...rankIssues, ...(draft.mode === "workload_pool" ? poolIssues : [])];

  const start = (mode: AssignmentState["mode"]) => { setDraft({ ...before, mode }); setAck(false); setResults([]); setStep("edit"); };
  const cancel = () => { setDraft(before); setStep("view"); };
  const submit = async () => {
    if (!flowLine || !preview) return;
    setStep("saving");
    const done: typeof results = [];
    for (const kind of preview.saves) {
      let answer: Answer = null;
      try {
        if (kind === "execution") {
          const form = new FormData();
          form.set("task", line.task); form.set("slot", String(line.slot));
          form.set("expectedRevision", flowLine.execution?.revision == null ? "" : String(flowLine.execution.revision));
          form.set("mode", draft.mode);
          // 같은 자리·같은 모델의 구성원은 저장된 id 를 이어 쓴다(작업 배정 실행 방식 폼과 같은 규칙)
          const members = draft.mode === "workload_pool" ? draft.members.flatMap((choice, index) => {
            if (!choice) return [];
            const previous = flowLine.execution?.members.find(member => member.position === index + 1 && member.connectionId === choice.provider && member.model === choice.model);
            return [{ ...(previous ? { memberId: previous.memberId } : {}), connectionId: choice.provider, model: choice.model,
              ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}) }];
          }) : [];
          form.set("members", JSON.stringify(members));
          answer = await saveTaskExecutionAction(null, form);
        } else answer = await saveAiTaskRanksAction(null, rankForm(flowLine, draft.ranks));
      } catch {
        answer = { issues: ["저장 요청이 서버에 닿지 않았습니다 — 다시 누르기 전에 기록에서 저장됐는지 보세요."] };
      }
      const ok = !!answer?.ok;
      done.push({ ok, text: answer?.message ?? "", issues: answer?.issues ?? (ok ? [] : ["저장하지 못했습니다."]), warnings: answer?.warnings ?? [] });
      if (!ok) break;
    }
    setResults(done);
    setStep("done");
    if (done.some(row => row.ok)) router.refresh();
  };

  const mode = step === "view" || step === "done" ? savedMode : draft.mode;
  const poolChoices = flowLine && editor ? poolOptions(flowLine, editor.connections, line.apiOnly) : [];
  return <section className="sp-line" data-task={line.task} data-mode={savedMode} data-dirty={step === "edit" || step === "confirm" ? true : undefined}
    aria-label={`${line.label} 배정`}>
    {showLabel && <h4>{line.label}</h4>}
    <div className="sp-seg" role="group" aria-label={`${line.label} 방식`}>
      {(["fallback", "workload_pool"] as const).map(value => {
        const unsupported = value === "workload_pool" && !line.poolSupported;
        const disabled = !canEdit || !!lockReason || unsupported || step === "saving" || (value === "fallback" && line.apiOnly && savedMode === "fallback");
        return <button key={value} type="button" aria-pressed={mode === value} disabled={disabled && mode !== value}
          title={unsupported ? "이 작업은 아직 「동시에」를 받지 않습니다" : undefined}
          onClick={() => { if (mode !== value && !disabled) start(value); }}>{value === "fallback" && line.apiOnly ? "기존 CLI 분류" : MODE_LABELS[value]}</button>;
      })}
    </div>
    {step !== "edit" && step !== "confirm" && <ol className="sp-rank">
      {line.members.map(member => <li key={`${member.tag}:${member.connectionId}:${member.model}`}>
        <span className="sp-tag">{member.tag}</span>
        <span className="sp-name">{member.name}<small>{member.model}</small></span>
        <span className="sp-facts">{member.facts}</span>
      </li>)}
      {!line.members.length && <li className="sp-empty"><span className="sp-tag">—</span><span>{line.mode === "workload_pool" ? "함께 쓰는 모델 없음" : line.apiOnly ? "기존 CLI 분류(모델 순위를 쓰지 않음)" : "순위 없음"}</span></li>}
      {canEdit && !lockReason && <li className="sp-add">
        <span className="sp-tag" aria-hidden="true">＋</span>
        <button type="button" className="text-button" onClick={() => start(savedMode)}>{line.members.length ? "모델 붙이기·고치기" : "모델 붙이기"}</button>
        <span className="sp-facts">{line.idle.length ? `남는 모델 ${line.idle.length}개 · ${line.idle.map(entry => `${entry.name}(${entry.text})`).join(" · ")}` : "남는 모델 없음"}</span>
      </li>}
    </ol>}
    {line.archived && step === "view" && <p className="sp-note">보관된 순위(지금은 쓰지 않음): {line.archived}</p>}
    {locked && <p className="sp-note" role="note">{locked}{!flowLine && <> <Link prefetch={false} href="/admin/models/tasks">작업 배정 →</Link></>}</p>}
    {elsewhere && <p className="sp-note">실행 쪽은 이 순위를 읽지 않습니다 — <Link prefetch={false} href={elsewhere.href}>{elsewhere.label} →</Link></p>}
    {lockReason && canEdit && <p className="sp-note" role="note">{lockReason}</p>}

    {step === "edit" && flowLine && editor && <div className="sp-edit">
      {draft.mode === "fallback" ? rankEditable
        ? <RankSelects<AiRankChoice> stage={{ id: `sp-${line.key}`, label: line.label, slots: 3 }} options={flowLine.options} connections={editor.connections}
          value={draft.ranks} onChange={ranks => setDraft(current => ({ ...current, ranks }))} slotNames={AI_RANK_SLOT_NAMES} showProvider={false} note={null}
          blocked={(option, index, slots) => flowOptionBlocked(editor, flowLine, index, option, slots)} validate={slots => flowRankIssues(editor, flowLine, slots)} layout="rows" />
        : <p className="sp-note">{line.apiOnly ? "기존 CLI 분류로 돌아갑니다." : "보관된 순위로 돌아갑니다."} 순위는 돌아간 뒤에 고칩니다.</p>
        : <>
          <p className="sp-note">고른 모델이 일을 나눠 처리합니다. 같은 모델을 두 번 고르면 그 모델이 더 많이 맡습니다. 동시 실행 수는 장비 칸이 정합니다.</p>
          <RankSelects<AiRankChoice> stage={{ id: `sp-pool-${line.key}`, label: line.label, slots: 4 }} selectionKind="pool" options={poolChoices}
            connections={editor.connections} value={draft.members} onChange={members => setDraft(current => ({ ...current, members }))} slotNames={POOL_SLOTS}
            showProvider={false} note={null} validate={values => poolMemberIssues(values, editor.connections, line.apiOnly)} />
        </>}
      {line.idle.length > 0 && <p className="sp-note">남는 모델: {line.idle.map(entry => `${entry.name}(${entry.text})`).join(" · ")}</p>}
      <div className="sp-acts">
        <button type="button" className="button small primary" disabled={!preview?.rows.length || issues.length > 0} onClick={() => { setAck(false); setStep("confirm"); }}>바뀌는 내용 확인</button>
        <button type="button" className="button small" onClick={cancel}>취소</button>
      </div>
    </div>}

    {(step === "confirm" || step === "saving") && preview && <div className="sp-dlg" role="group" aria-label="저장 전 확인">
      <h4>{line.label} 배정을 바꿉니다</h4>
      <ul className="sp-diff">{preview.rows.map(row => <li key={row.label}><span>{row.label}</span><span><s>{row.before}</s> {row.after}</span></li>)}</ul>
      {preview.impact.length > 0 && <ul className="sp-impact" aria-label="영향">{preview.impact.map(item => <li key={item.text} data-tone={item.tone}>{item.text}</li>)}</ul>}
      {warnings.filter(warning => !warning.existing).map(warning => <p key={warning.code} className="sp-warn" data-tone={warning.tone}>{warning.text}</p>)}
      <p className="sp-note">저장은 작업 배정과 같은 서버 동작입니다({preview.saves.map(kind => kind === "ranks" ? "순위 저장" : "실행 방식 저장").join(" → ")}). 작업 로그에 전·후가 남고
        홈 「바꾼 것 지켜보기」에 한 줄이 생깁니다 — 10분·1시간·24시간 뒤 처리량을 바꾸기 전과 견줍니다.</p>
      {lockReason && <p className="sp-warn" role="alert">{lockReason}</p>}
      {mustAck && <label className="sp-ack"><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} disabled={step === "saving"} />위 경고를 읽었습니다 — 그래도 바꿉니다</label>}
      <div className="sp-acts">
        <button type="button" className="button small primary" onClick={submit} disabled={step === "saving" || !!lockReason || issues.length > 0 || (mustAck && !ack)}>
          {step === "saving" ? "저장 중…" : "바꾸기"}</button>
        <button type="button" className="button small" onClick={() => setStep("edit")} disabled={step === "saving"}>← 고치기</button>
        <button type="button" className="button small" onClick={cancel} disabled={step === "saving"}>취소</button>
      </div>
    </div>}

    {step === "done" && <div className="sp-done" role="status">
      {results.map((row, index) => <p key={index} data-ok={row.ok ? "yes" : "no"}><b>{row.ok ? "저장함" : "저장 못 함"}</b> {row.text}
        {row.warnings.map(text => <span key={text} className="sp-warn" data-tone="warn"> 알림 — {text}</span>)}
        {row.issues.map(text => <span key={text} className="sp-warn" data-tone="bad"> {text}</span>)}</p>)}
      {results.every(row => row.ok) && <p className="sp-note">홈 「바꾼 것 지켜보기」에서 그 뒤 처리량을 봅니다. 되돌리기는 기록의 그 줄에서 합니다.</p>}
      <button type="button" className="button small" onClick={() => { setStep("view"); setDraft(before); }}>닫기</button>
    </div>}
  </section>;
}

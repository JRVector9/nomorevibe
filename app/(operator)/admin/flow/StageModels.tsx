"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { aiTaskPoolCappedLanes } from "@/lib/llm/ai-task-execution-config";
import { aiModelChoiceName, aiRankReasoningEfforts, AI_RANK_SLOT_NAMES, type AiRankChoice, type AiRankOption, type AiConnectionView } from "@/lib/operations/admin-ai-tasks";
import { aiTaskEditTarget } from "@/lib/operations/ai-task-edit-target";
import { FLOW_RANK_LOCKS, flowOptionBlocked, flowRankIssues, needsAcknowledge, rankForm, rankWarnings, type FlowRankEditor, type FlowRankLine } from "@/lib/operations/flow-rank-editor";
import { SAMPLE_COMPARE_SUPPORTED } from "@/lib/operations/model-sample-compare";
import { assignmentPreview, MODE_LABELS, type AssignmentState, type PreviewContext, type StageModelLine } from "@/lib/operations/stage-panel-model";
import { poolExecutionForm, poolMemberIssues, poolMembersInput, poolSlotOf, poolSlotTexts } from "@/lib/operations/task-pool-form";
import { RankSelects } from "../models/RankSelects";
import { saveAiTaskRanksAction } from "../models/tasks/actions";
import { saveTaskExecutionAction } from "../models/tasks/execution-actions";
import { PoolReserveField, PoolSlotFields } from "../models/tasks/PoolSlotFields";
import { PoolHelpTip, PoolMemberWarnings } from "../models/tasks/PoolHelp";
import { modelPickerOptionName } from "../models/model-picker-display";
import { buildPoolHelp, poolHelpWarnings, type PoolHelpContext } from "@/lib/operations/pool-help";
import { saveAssignmentChanges, type AssignmentSaveResult } from "@/lib/operations/model-assignment-save";
import { unifiedTaskSwitchMode } from "@/lib/operations/model-unified-task-view";

/**
 * 단계 패널 「모델」 구역(운영 콘솔 개편 조각 2a) — 지금 배정(순위대로: 1·2·3순위 / 동시에: 함께 쓰는 모델)을 보이고 그 자리에서 고친다.
 * 저장은 새 길이 없다: 순위는 작업 배정·흐름 서랍과 같은 saveAiTaskRanksAction(같은 폼 칸 rankForm·같은 검사 flowRankIssues),
 * 방식 전환·함께 쓰는 모델·모델별 칸 수·예비는 작업 배정 「실행 방식」과 같은 saveTaskExecutionAction(같은 판 expectedRevision, 같은 폼 칸 poolExecutionForm)을 부른다.
 * 작업 로그에 전·후가 남고 홈 「바꾼 것 지켜보기」에 한 줄이 생긴다.
 * 차례: 고르기 → 저장 전 확인(바뀌는 값 전 → 후 · 영향을 받는 단계, assignmentPreview) → 저장됨. 「동시에」는 그 작업이 지금 받을 때만 켠다(line.poolSupported),
 * 칸 수·예비는 실행 쪽이 따르는 작업에서만 보인다(line.features — aiTaskPoolFeatures). 구성원 검사는 작업 배정 폼과 같은 함수(task-pool-form poolMemberIssues).
 */
type Step = "view" | "edit" | "confirm" | "saving" | "done";
/** 처음 열 때의 걸음(시험·화면 확인용 — RankDrawer 의 initial 과 같은 뜻). 없으면 늘 「보기」에서 시작한다 */
export type StageModelsInitial = { key: string; step: "edit" | "confirm"; draft: AssignmentState };
type Props = { lines: StageModelLine[]; editor: FlowRankEditor | null; context: PreviewContext; lockReason: string | null; initial?: StageModelsInitial;
  /** 「동시에」 도움말이 읽은 한도(장비·실시간 한도·수집·판정 설정) — 없으면 도움말이 「읽지 못함」이라고 적는다 */
  poolHelp?: PoolHelpContext | null;
  /** 단계 이름(흐름 표의 말) — 작업이 하나인 단계의 저장 전 확인 제목(「AI 1차 배정을 바꿉니다」) */
  stageLabel?: string };

const POOL_SLOTS = Array.from({ length: 4 }, (_, index) => ({ provider: `pool${index + 1}Connection`, model: `pool${index + 1}Model`,
  reasoningEffort: `pool${index + 1}ReasoningEffort` }));

export function StageModels({ lines, editor, context, lockReason, initial, stageLabel, poolHelp = null }: Props) {
  return <div className="sp-models">{lines.map(line => <ModelLine key={line.key} line={line} showLabel={lines.length > 1}
    title={lines.length > 1 || !stageLabel ? line.label : stageLabel}
    flowLine={editor?.lines.find(entry => entry.key === line.key) ?? null} editor={editor} context={context} lockReason={lockReason}
    initial={initial?.key === line.key ? initial : undefined} poolHelp={poolHelp} />)}</div>;
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
      label: `${connection ? aiModelChoiceName(connection, member.model) : "연결 없음"} (저장된 값)`,
      group: connection ? aiModelChoiceName(connection) : "연결 없음", text: `${connection ? aiModelChoiceName(connection, member.model, { short: true }) : member.model} (저장된 값)`,
      reasoningEfforts: connection ? aiRankReasoningEfforts(flowLine.task, connection, member.model) : [] });
  }
  return options;
}

function ModelLine({ line, showLabel, title, flowLine, editor, context, lockReason, initial, poolHelp }: { line: StageModelLine; showLabel: boolean; title: string; flowLine: FlowRankLine | null;
  editor: FlowRankEditor | null; context: PreviewContext; lockReason: string | null; initial?: StageModelsInitial; poolHelp: PoolHelpContext | null }) {
  const router = useRouter();
  const savedMode = flowLine?.execution?.mode ?? line.mode;
  const before: AssignmentState = { mode: savedMode, ranks: flowLine?.saved ?? [], members: savedMembers(flowLine),
    slots: poolSlotTexts(flowLine?.execution?.members ?? []), reserve: flowLine?.execution?.reserveRanks ?? false };
  const [step, setStep] = useState<Step>(initial?.step ?? "view");
  const [draft, setDraft] = useState<AssignmentState>(initial?.draft ?? before);
  const [ack, setAck] = useState(false);
  const [results, setResults] = useState<AssignmentSaveResult[]>([]);
  const unconfirmed = results.some(result => result.unconfirmed);
  // 바꿀 수 없는 까닭 — 순위를 못 읽음 · 화면에서 못 바꾸는 작업(소개 검수) · 실제 적용 설정이 따로 있는 작업
  const locked = !flowLine || !editor ? "순위를 읽지 못해 여기서 바꿀 수 없습니다." : FLOW_RANK_LOCKS[line.task] ?? null;
  const elsewhere = flowLine && !flowLine.live && line.task !== "publish-classify" ? aiTaskEditTarget(line.task) : null;
  const rankEditable = !locked && !elsewhere && !line.apiOnly;
  const canEdit = !unconfirmed && !locked && !elsewhere && (rankEditable || line.poolSupported);
  const preview = flowLine && editor ? assignmentPreview({ task: line.task, slot: line.slot, before, after: draft, context }) : null;
  const rankIssues = flowLine && editor && draft.mode === "fallback" && preview?.saves.includes("ranks") ? flowRankIssues(editor, flowLine, draft.ranks) : [];
  const poolRules = { apiOnly: line.apiOnly, features: line.features };
  const poolIssues = editor && draft.mode === "workload_pool" ? poolMemberIssues(draft.members, draft.slots ?? [], editor.connections, poolRules) : [];
  const warnings = flowLine && editor && preview?.saves.includes("ranks") ? rankWarnings(editor, [flowLine], { [flowLine.key]: draft.ranks }) : [];
  const mustAck = needsAcknowledge(warnings);
  const issues = [...rankIssues, ...(draft.mode === "workload_pool" ? poolIssues : [])];

  const start = (mode: AssignmentState["mode"]) => {
    // Match the models drawer: a first pool starts with the existing ranks, each at one reviewed slot.
    const current = step === "edit" || step === "confirm" ? draft : before;
    setDraft(flowLine ? unifiedTaskSwitchMode(current, mode, flowLine) : { ...current, mode });
    setAck(false); setResults([]); setStep("edit");
  };
  const cancel = () => { setDraft(before); setStep("view"); };
  const submit = async () => {
    if (!flowLine || !preview) return;
    setStep("saving");
    const changes = preview.saves.map(kind => ({ kind, form: kind === "execution"
      ? poolExecutionForm({ task: line.task, slot: line.slot, revision: flowLine.execution?.revision ?? null, mode: draft.mode,
        members: poolMembersInput(draft.members, draft.slots ?? [], flowLine.execution?.members ?? [], line.features), reserve: line.features.reserve && !!draft.reserve })
      : rankForm(flowLine, draft.ranks) }));
    const done = await saveAssignmentChanges(changes,
      { execution: saveTaskExecutionAction, ranks: saveAiTaskRanksAction }, () => router.refresh());
    setResults(done);
    setStep("done");
  };

  const mode = step === "view" || step === "done" ? savedMode : draft.mode;
  const poolChoices = flowLine && editor ? poolOptions(flowLine, editor.connections, line.apiOnly) : [];
  // 고르는 상자와 같은 이름 하나(modelPickerOptionName — 별칭은 한 이름)
  const nameOf = (choice: AiRankChoice) => { const connection = editor?.connections.find(row => row.id === choice.provider); return connection ? modelPickerOptionName(connection, choice.model) : "지워진 연결"; };
  const draftLanes = aiTaskPoolCappedLanes({ task: line.task, slot: line.slot, mode: "workload_pool",
    members: draft.members.flatMap((choice, index) => choice ? [{ maxSlots: poolSlotOf(draft.slots?.[index], line.features) ?? null }] : []) });
  // 「동시에」 도움말 — 고치는 중이면 고른 모델·칸 수로, 아니면 저장된 묶음으로 센다(권장 칸 수 · 같은 모델 두 줄 · 장비 한도 넘김)
  const editing = step === "edit" || step === "confirm" || step === "saving";
  const helpState = editing ? draft : before;
  const help = buildPoolHelp({ task: line.task, slot: line.slot, taskLabel: title, members: helpState.mode === "workload_pool" ? helpState.members : [],
    slots: helpState.slots ?? [], connections: editor?.connections ?? [], context: poolHelp, nameOf: modelPickerOptionName });
  const savedWarnings = savedMode === "workload_pool" ? poolHelpWarnings(buildPoolHelp({ task: line.task, slot: line.slot, taskLabel: title, members: before.members,
    slots: before.slots ?? [], connections: editor?.connections ?? [], context: poolHelp, nameOf: modelPickerOptionName })) : null;
  const savedLanes = aiTaskPoolCappedLanes({ task: line.task, slot: line.slot, mode: line.mode, members: line.members.map(member => ({ maxSlots: member.slots })) });
  return <section className="sp-line" data-task={line.task} data-mode={savedMode} data-dirty={step === "edit" || step === "confirm" ? true : undefined}
    aria-label={`${line.label} 배정`}>
    {showLabel && <h4>{line.label}</h4>}
    <div className="sp-seg-row">
    <div className="sp-seg" role="group" aria-label={`${line.label} 방식`}>
      {(["fallback", "workload_pool"] as const).map(value => {
        const unsupported = value === "workload_pool" && !line.poolSupported;
        const disabled = !canEdit || !!lockReason || unsupported || step === "saving" || (value === "fallback" && line.apiOnly && savedMode === "fallback");
        return <button key={value} type="button" aria-pressed={mode === value} disabled={unconfirmed || disabled && mode !== value}
          title={unsupported ? "이 작업은 아직 「동시에」를 받지 않습니다" : undefined}
          onClick={() => { if (mode !== value && !disabled) start(value); }}>{value === "fallback" && line.apiOnly ? "기존 CLI 분류" : MODE_LABELS[value]}</button>;
      })}
    </div>
    {line.poolSupported && <PoolHelpTip view={help} label="「동시에」" />}
    </div>
    {step !== "edit" && step !== "confirm" && <ol className="sp-rank">
      {line.members.map((member, index) => <li key={`${member.tag}:${member.connectionId}:${member.model}`}>
        <span className="sp-tag">{member.tag}</span>
        <span className="sp-name">{member.name}{savedWarnings && <PoolMemberWarnings warnings={savedWarnings[index] ?? []} />}</span>
        <span className="sp-facts">{member.facts}</span>
      </li>)}
      {!line.members.length && <li className="sp-empty"><span className="sp-tag">—</span><span>{line.mode === "workload_pool" ? "함께 쓰는 모델 없음" : line.apiOnly ? "기존 CLI 분류(모델 순위를 쓰지 않음)" : "순위 없음"}</span></li>}
      {canEdit && !lockReason && <li className="sp-add">
        <span className="sp-tag" aria-hidden="true">＋</span>
        <button type="button" className="text-button" onClick={() => start(savedMode)}>{line.members.length ? "모델 붙이기·고치기" : "모델 붙이기"}</button>
        <span className="sp-facts">{line.idle.length ? `남는 모델 ${line.idle.length}개 · ${line.idle.map(entry => `${entry.name}(${entry.text})`).join(" · ")}` : "남는 모델 없음"}</span>
      </li>}
      {/* 표본 비교를 받는 작업(한국어 소개)은 붙이기 전에 결과를 나란히 보는 길을 함께(시안 흐름 2, 3a /admin/models/compare) */}
      {SAMPLE_COMPARE_SUPPORTED.includes(line.task) && <li className="sp-add sp-compare">
        <span className="sp-tag" aria-hidden="true">⇄</span>
        <Link prefetch={false} className="text-button" href={`/admin/models/compare?task=${encodeURIComponent(line.task)}${line.idle[0]
          ? `&candidate=${encodeURIComponent(line.idle[0].connectionId)}` : ""}`}>표본 비교로 먼저 보기</Link>
        <span className="sp-facts">{line.idle[0] ? `${line.idle[0].name}과(와) 지금 모델의 결과를 같은 입력으로 견줍니다` : "후보 모델을 골라 지금 모델과 견줍니다"}</span>
      </li>}
    </ol>}
    {/* 시안 화면 2 의 안내 — 「동시에」를 받는 단계만, 지금 순위대로일 때 */}
    {step === "view" && savedMode === "fallback" && line.poolSupported && canEdit && !lockReason && <p className="sp-note" data-pool-hint="true">
      「동시에」로 바꾸면 묶은 모델이 함께 일합니다. 저장하기 전에 달라지는 동시 처리 수를 먼저 보여 줍니다.</p>}
    {line.mode === "workload_pool" && step === "view" && <p className="sp-note" data-pool-summary="true">
      {savedLanes !== null ? `함께 최대 ${savedLanes}건(모델별 칸 수 합)` : "모델별 칸 수 없음 — 장비 칸을 다른 단계와 나눠 씀"}
      {line.features.reserve ? ` · 예비 ${line.reserve ? "켬" : "끔"}` : ""}</p>}
    {line.archived && step === "view" && <p className="sp-note">{line.reserve ? "예비로 쓰는 순위(묶음이 모두 서면)" : "보관된 순위(지금은 쓰지 않음)"}: {line.archived}</p>}
    {locked && <p className="sp-note" role="note">{locked}{!flowLine && <> <Link prefetch={false} href="/admin/models#tasks">작업 배정 →</Link></>}</p>}
    {elsewhere && <p className="sp-note">실행 쪽은 이 순위를 읽지 않습니다 — <Link prefetch={false} href={elsewhere.href}>{elsewhere.label} →</Link></p>}
    {lockReason && canEdit && <p className="sp-note" role="note">{lockReason}</p>}

    {step === "edit" && flowLine && editor && <div className="sp-edit">
      {draft.mode === "fallback" ? rankEditable
        ? <RankSelects<AiRankChoice> stage={{ id: `sp-${line.key}`, label: line.label, slots: 3 }} options={flowLine.options} connections={editor.connections}
          value={draft.ranks} onChange={ranks => setDraft(current => ({ ...current, ranks }))} slotNames={AI_RANK_SLOT_NAMES} showProvider={false} note={null}
          blocked={(option, index, slots) => flowOptionBlocked(editor, flowLine, index, option, slots)} validate={slots => flowRankIssues(editor, flowLine, slots)} layout="rows" />
        : <p className="sp-note">{line.apiOnly ? "기존 CLI 분류로 돌아갑니다." : "보관된 순위로 돌아갑니다."} 순위는 돌아간 뒤에 고칩니다.</p>
        : <>
          <p className="sp-note">{line.features.slotCaps
            ? "고른 모델이 함께 처리합니다. 모델마다 이 단계에 내줄 칸 수를 적으면 그 합만큼 함께 돌고, 한 모델이 서도 남은 모델이 계속합니다."
            : "고른 모델이 일을 나눠 처리합니다. 같은 모델은 한 줄만 넣으세요 — 두 줄로 넣으면 그 모델을 고를 차례만 늘고 동시 처리 수는 늘지 않습니다(이 작업은 아직 모델별 칸 수·예비를 따르지 않습니다)."}</p>
          {/* 좁은 패널에서는 순위 고르기와 같은 가로 줄(rows) — 화면 폭 기준 네 칸 격자를 쓰지 않는다 */}
          <RankSelects<AiRankChoice> stage={{ id: `sp-pool-${line.key}`, label: line.label, slots: 4 }} selectionKind="pool" options={poolChoices}
            connections={editor.connections} value={draft.members} onChange={members => setDraft(current => ({ ...current, members }))} slotNames={POOL_SLOTS}
            showProvider={false} note={null} layout="rows" validate={values => poolMemberIssues(values, draft.slots ?? [], editor.connections, poolRules)} />
          {line.features.slotCaps && <PoolSlotFields value={draft.members} slots={draft.slots ?? []} disabled={false} nameOf={nameOf} lanes={draftLanes}
            help={<PoolHelpTip view={help} label="칸 수" />} warnings={poolHelpWarnings(help)}
            onChange={(index, raw) => setDraft(current => ({ ...current,
              slots: Array.from({ length: 4 }, (_, at) => at === index ? raw : current.slots?.[at] ?? "") }))} />}
          {line.features.reserve && <PoolReserveField checked={!!draft.reserve} disabled={false} onChange={reserve => setDraft(current => ({ ...current, reserve }))} />}
        </>}
      {line.idle.length > 0 && <p className="sp-note">남는 모델: {line.idle.map(entry => `${entry.name}(${entry.text})`).join(" · ")}</p>}
      <div className="sp-acts">
        <button type="button" className="button small primary" disabled={!preview?.rows.length || issues.length > 0} onClick={() => { setAck(false); setStep("confirm"); }}>바뀌는 내용 확인</button>
        <button type="button" className="button small" onClick={cancel}>취소</button>
      </div>
    </div>}

    {(step === "confirm" || step === "saving") && preview && <div className="sp-dlg" role="group" aria-label="저장 전 확인">
      <h4>{title} 배정을 바꿉니다</h4>
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
      {results.map((row, index) => <p key={index} data-ok={row.ok ? "yes" : "no"}><b>{row.unconfirmed ? "저장 여부 미확인" : row.ok ? "저장함" : "저장 못 함"}</b> {row.message}
        {row.warnings.map(text => <span key={text} className="sp-warn" data-tone="warn"> 알림 — {text}</span>)}
        {row.issues.map(text => <span key={text} className="sp-warn" data-tone="bad"> {text}</span>)}</p>)}
      {results.length > 0 && results.every(row => row.ok && !row.issues.length) && <p className="sp-note">설정 저장을 확인했습니다. 실제 호출 성공은 아직 확인 전입니다. 홈 「바꾼 것 지켜보기」에서 그 뒤 처리량을 봅니다.</p>}
      {unconfirmed && <p className="sp-note">새로고침으로 현재 배정과 최근 변경 기록을 확인한 뒤 다시 편집하세요.</p>}
      <button type="button" className="button small" onClick={() => {
        if (unconfirmed) window.location.reload();
        else { setStep("view"); setDraft(before); }
      }}>{unconfirmed ? "새로고침해서 적용 확인" : "닫기"}</button>
    </div>}
  </section>;
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { AI_TASK_POOL_MEMBER_SLOTS_MAX, aiTaskPoolCappedLanes, aiTaskPoolFeatures, aiTaskSupportsPool, aiTaskWorkloadPoolApiOnly,
  aiTaskWorkloadPoolUnsupportedReason } from "@/lib/llm/ai-task-execution-config";
import { AI_RANK_SLOT_NAMES, aiConnectionModelIds, aiModelDisplayName, type AiRankChoice } from "@/lib/operations/admin-ai-tasks";
import { flowOptionBlocked, flowRankIssues, needsAcknowledge, rankDeviceImpact, rankWarnings,
  type FlowRankEditor, type FlowRankLine, type RankDeviceLimit } from "@/lib/operations/flow-rank-editor";
import { ledgerModelText, type TaskAssignRow } from "@/lib/operations/llm-task-assign-view";
import { attachPreviewContext, attachSaveForms, savedAssignment } from "@/lib/operations/model-attach";
import { UNIFIED_TASK_GROUPS, unifiedTaskActualNote, unifiedTaskEditTarget, unifiedTaskHomeHref, unifiedTaskInitialDraft, unifiedTaskLock,
  unifiedTaskPoolMembers, unifiedTaskPoolOptions, unifiedTaskSavesConfirmed, unifiedTaskSwitchMode } from "@/lib/operations/model-unified-task-view";
import { buildPoolHelp, poolHelpWarnings, type PoolHelpContext } from "@/lib/operations/pool-help";
import { assignmentPreview, type AssignmentState } from "@/lib/operations/stage-panel-model";
import { poolMemberIssues, poolMembersInput } from "@/lib/operations/task-pool-form";
import { saveAssignmentChanges } from "@/lib/operations/model-assignment-save";
import { RankSelects } from "../../RankSelects";
import { modelPickerModelCount, modelPickerOptionName, modelPickerVisibleText } from "../../model-picker-display";
import { saveAiTaskRanksAction } from "../../tasks/actions";
import { saveTaskExecutionAction } from "../../tasks/execution-actions";
import { PoolHelpContent, PoolMemberWarnings } from "../../tasks/PoolHelp";
import { UnifiedTaskImpact, UnifiedTaskResult, type UnifiedTaskSaveResult } from "./UnifiedTaskFeedback";
import { UnifiedTaskEmptyPoolSlot } from "./UnifiedTaskEmptyPoolSlot";
import "./unified-tasks.css";

const MEMBER_FIELDS = Array.from({ length: 4 }, (_, index) => ({ provider: `pool${index + 1}Connection`, model: `pool${index + 1}Model`, reasoningEffort: `pool${index + 1}ReasoningEffort` }));
const fmt = (value: number) => value.toLocaleString("ko-KR");
type Step = "edit" | "confirm" | "saving" | "done";

export type UnifiedTaskEditorProps = {
  taskKey: string; editor: FlowRankEditor; devices: readonly RankDeviceLimit[] | null;
  lockReason: string | null; poolHelp: PoolHelpContext | null; onClose: () => void;
  row?: TaskAssignRow | null; attachConnectionId?: string | null; onModelOpen?: (connectionId: string) => void;
};

/** Both model attachment and task rows open this editor; every write uses the existing server actions and CAS forms. */
export function UnifiedTaskEditor(props: UnifiedTaskEditorProps) {
  const line = props.editor.lines.find(entry => entry.key === props.taskKey);
  return <TaskEditor key={`${props.taskKey}:${props.attachConnectionId ?? ""}`} {...props} line={line ?? null} />;
}

function TaskEditor({ editor, devices, lockReason, poolHelp, onClose, row = null, attachConnectionId, onModelOpen, line }: UnifiedTaskEditorProps & { line: FlowRankLine | null }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  // A refresh can replace props after one of two sequential saves. Keep the reviewed snapshot and its revisions until this drawer closes.
  const [snapshot] = useState(line);
  const [before] = useState(() => snapshot ? savedAssignment(snapshot) : null);
  const [initial] = useState(() => snapshot ? unifiedTaskInitialDraft(editor, snapshot, attachConnectionId) : null);
  const [draft, setDraft] = useState<AssignmentState | null>(() => initial?.draft ?? null);
  const [step, setStep] = useState<Step>("edit");
  const [ack, setAck] = useState(false);
  const [resave, setResave] = useState(false);
  const [results, setResults] = useState<UnifiedTaskSaveResult[]>([]);
  const [pending, startTransition] = useTransition();
  const busy = pending || step === "saving";
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open && typeof node.showModal === "function") node.showModal();
  }, []);

  const close = () => {
    if (busy) return;
    if (results.some(result => result.unconfirmed)) window.location.reload();
    else onClose();
  };
  const target = snapshot ? unifiedTaskEditTarget(snapshot) : null;
  const lineLock = snapshot ? unifiedTaskLock(snapshot) : null;
  const locked = lockReason ?? lineLock;
  const pool = draft?.mode === "workload_pool";
  const supported = snapshot ? aiTaskSupportsPool(snapshot.task, snapshot.slot) : false;
  const apiOnly = snapshot ? aiTaskWorkloadPoolApiOnly(snapshot.task) : false;
  const features = aiTaskPoolFeatures(snapshot?.task ?? "", snapshot?.slot ?? 1);
  const editableLine = snapshot ? { ...snapshot, lock: lineLock } : null;
  const nameOf = (choice: AiRankChoice) => {
    const connection = editor.connections.find(entry => entry.id === choice.provider);
    return connection ? modelPickerOptionName(connection, choice.model) : `지워진 연결 · ${choice.model}`;
  };
  const names = (id: string) => {
    const connection = editor.connections.find(entry => entry.id === id)!;
    return { label: aiModelDisplayName(connection), models: aiConnectionModelIds(connection), modelGroups: modelPickerModelCount(connection) };
  };
  // Unknown held/limit values must not become an invented zero in the shared preview helper.
  const knownDevices = devices?.every(device => device.held !== null && device.limit !== null)
    ? devices.map(device => ({ deviceId: device.deviceId, active: device.held!, limitSlots: device.limit })) : null;
  const context = attachPreviewContext(editor, knownDevices, names);
  const preview = snapshot && before && draft ? assignmentPreview({ task: snapshot.task, slot: snapshot.slot, before, after: draft, context }) : null;
  const rankChanged = !!preview?.saves.includes("ranks");
  const saves = [...preview?.saves ?? []];
  if (!saves.includes("ranks") && resave && !pool && snapshot?.pending?.length && snapshot.saved.length) saves.push("ranks");
  const rules = { apiOnly, features };
  const issuesOf = (value: readonly (AiRankChoice | null)[]) => poolMemberIssues(value, draft?.slots ?? [], editor.connections, rules);
  const issues = !snapshot || !draft || !editableLine ? [] : pool ? issuesOf(draft.members)
    : !apiOnly && (rankChanged || resave) ? flowRankIssues(editor, editableLine, draft.ranks) : [];
  const warnings = editableLine && draft && !pool && !apiOnly && (rankChanged || resave)
    ? rankWarnings(editor, [editableLine], { [editableLine.key]: draft.ranks }) : [];
  const mustAck = needsAcknowledge(warnings);
  const help = snapshot && draft ? buildPoolHelp({ task: snapshot.task, slot: snapshot.slot, taskLabel: snapshot.label,
    members: pool ? draft.members : [], slots: draft.slots ?? [], connections: editor.connections, context: poolHelp, nameOf: modelPickerOptionName }) : null;
  const memberWarnings = help ? poolHelpWarnings(help) : [];
  const members = draft && snapshot ? poolMembersInput(draft.members, draft.slots ?? [], snapshot.execution?.members ?? [], features) : [];
  const lanes = snapshot && pool ? aiTaskPoolCappedLanes({ task: snapshot.task, slot: snapshot.slot, mode: "workload_pool", members }) : null;
  const attached = editor.connections.find(entry => entry.id === attachConnectionId);
  const draftDuplicate = draft?.ranks.some((choice, index) => choice && draft.ranks.slice(0, index).some(previous => previous?.provider === choice.provider && previous.model === choice.model));
  const canSave = !locked && !target && !!saves.length && !issues.length && (!pool || supported);
  const chain = (state: AssignmentState) => {
    const values = state.mode === "workload_pool" ? state.members : state.ranks;
    const parts = values.flatMap((choice, index) => choice ? [`${state.mode === "fallback" ? `${index + 1}. ` : ""}${nameOf(choice)}${choice.reasoningEffort ? ` · 추론 ${choice.reasoningEffort}` : ""}${state.mode === "workload_pool" && features.slotCaps && state.slots?.[index] ? ` ${state.slots[index]}칸` : ""}`] : []);
    return parts.length ? parts.join(state.mode === "workload_pool" ? " + " : " → ") : "배정 없음";
  };
  const deviceImpact = editableLine && draft && saves.includes("ranks") ? rankDeviceImpact(editor,
    [{ line: editableLine, before: editableLine.saved, after: [...draft.ranks], beforeText: "", afterText: "" }], devices) : [];
  const deviceNotes = deviceImpact.map(device => `${device.connections.join(" · ")} · ${device.create !== null ? `저장하면 장비 한도 ${device.create}칸을 만듭니다`
    : device.limit === null ? "장비 한도 관측 불가" : `장비 한도 ${device.limit}칸 · ${device.held === null ? "사용 중인 칸 관측 불가" : `${device.held}칸 사용 중`}`}`
    + (device.sharing.length ? ` · 함께 쓰는 다른 작업: ${device.sharing.join(" · ")}` : ""));
  const confirmed = step === "done" && unifiedTaskSavesConfirmed(results, saves);

  const submit = () => {
    if (!snapshot || !draft || !canSave || busy || mustAck && !ack) return;
    setStep("saving");
    startTransition(async () => {
      const done = await saveAssignmentChanges(attachSaveForms({ line: snapshot, after: draft, features, saves }),
        { execution: saveTaskExecutionAction, ranks: saveAiTaskRanksAction }, () => router.refresh());
      setResults(done);
      setStep("done");
    });
  };

  return <dialog ref={dialog} className="unified-task-editor ut-drawer" aria-labelledby="ut-drawer-title"
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) {
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    } }}>
    <header className="ut-drawer-head"><div><span className="ut-eyebrow">{confirmed ? snapshot?.label : step === "confirm" || step === "saving" ? "저장 전 확인" : step === "done" ? "저장 결과" : target ? "실제 적용 설정" : "작업 배정"}</span>
      <h2 id="ut-drawer-title">{confirmed ? "배정을 반영했습니다" : <>{snapshot?.label ?? "작업을 찾을 수 없습니다"}{(step === "confirm" || step === "saving") && " 배정을 바꿉니다"}</>}</h2></div>
      <button type="button" className="ut-icon-btn" aria-label="닫기" onClick={close} disabled={busy}>×</button></header>
    <div className="ut-drawer-content">
      {!snapshot || !before || !draft ? <><p className="ut-callout ut-warn" role="alert">이 작업 설정을 읽지 못했습니다. 새로고침 후 다시 확인하세요.</p>
        <button type="button" className="ut-btn" onClick={close}>닫기</button></> : <>
      {step === "edit" && <>
        <p className="ut-drawer-lead">{row ? UNIFIED_TASK_GROUPS[row.group] : "작업 배정"} · {snapshot.slot > 1 ? `투표자 ${snapshot.slot}` : "다음에 시작하는 업무부터 적용"}</p>
        {attachConnectionId && <div className={`ut-callout${initial?.issue ? " ut-warn" : ""}`}>{initial?.issue ?? <><b>{attached ? aiModelDisplayName(attached) : "고른 모델"}</b>을(를) 이 작업에 붙입니다. 기존 순위와 함께 확인하세요.</>}</div>}
        {locked && <p className="ut-callout ut-warn" role="alert">{modelPickerVisibleText(locked, editor.connections)}</p>}
        {target ? <>
          <p className="ut-drawer-lead">실제 호출에 적용되는 설정을 확인하고 해당 위치에서 변경합니다.</p>
          <div className="ut-preview-chain"><div className="ut-label">현재 적용 모델</div>{row?.choices.length ? row.choices.map(choice => {
            const connection = editor.connections.find(entry => entry.id === choice.connectionId);
            return <p key={`${choice.position}:${choice.connectionId}:${choice.model}`}>{connection ? modelPickerOptionName(connection, choice.model) : ledgerModelText(choice.model)}</p>;
          }) : "실제 적용 모델을 읽지 못했습니다."}</div>
          {row?.source && <p className="ut-scope-note">출처: {modelPickerVisibleText(row.source, editor.connections)}</p>}
          <Link className="ut-btn ut-primary" href={target.href} prefetch={false}>{target.label} →</Link>
          {!!snapshot.saved.length && <p className="ut-help-text">남아 있는 옛 순위는 이 작업의 실행에 사용되지 않습니다.</p>}
        </> : <>
          <div className="ut-mode-title"><h3>실행 방식</h3></div>
          <div className="ut-mode-picker" role="group" aria-label="실행 방식"><button type="button" aria-pressed={!pool} disabled={busy || !!locked}
            onClick={() => setDraft(unifiedTaskSwitchMode(draft, "fallback", snapshot))}>순위대로</button>
            <button type="button" aria-pressed={!!pool} disabled={busy || !!locked || !supported}
              title={!supported ? aiTaskWorkloadPoolUnsupportedReason(snapshot.task, snapshot.slot) ?? undefined : undefined}
              onClick={() => setDraft(unifiedTaskSwitchMode(draft, "workload_pool", snapshot))}>동시에</button></div>
          <p className="ut-help-text">{pool ? "서로 다른 업무를 모델들에 나눕니다. 모델별 칸 수 안에서 함께 처리합니다."
            : apiOnly ? "현재 기존 CLI 분류를 사용합니다. API·OpenCode 모델을 쓰려면 「동시에」로 전환하세요."
              : "1순위 모델을 먼저 쓰고, 호출할 수 없을 때 다음 순위로 전환합니다."}</p>
          {pool ? <div className="ut-editor-rows ut-pool-rows" data-caps={features.slotCaps ? "true" : undefined}>
            <RankSelects<AiRankChoice> stage={{ id: `unified-pool-${snapshot.key}`, label: snapshot.label, slots: 4 }} selectionKind="pool" layout="rows"
              value={draft.members} onChange={value => setDraft(unifiedTaskPoolMembers(draft, value, features))} options={unifiedTaskPoolOptions(editor, snapshot)} connections={editor.connections}
              slotNames={MEMBER_FIELDS} disabled={busy || !!locked || !supported} showProvider={false} note={null} validate={issuesOf}
              blocked={option => !editor.connections.some(connection => connection.id === option.provider && connection.enabled)}
              renderAfterEmptySlot={features.slotCaps ? index => <UnifiedTaskEmptyPoolSlot index={index} /> : undefined}
              renderAfterSlot={(choice, index) => <>
                {features.slotCaps && <label className="ut-slot"><input type="number" inputMode="numeric" min={1} max={AI_TASK_POOL_MEMBER_SLOTS_MAX} step={1} value={draft.slots?.[index] ?? ""}
                  placeholder="자동" aria-label={`모델 ${index + 1} 동시 칸 수`} disabled={busy || !!locked}
                  onChange={event => setDraft({ ...draft, slots: Array.from({ length: 4 }, (_, at) => at === index ? event.target.value : draft.slots?.[at] ?? "") })} /><span>칸</span></label>}
                <PoolMemberWarnings warnings={memberWarnings[index] ?? []} />
              </>} />
            {features.reserve && <label className="ut-check-label"><input type="checkbox" checked={!!draft.reserve} disabled={busy || !!locked}
              onChange={event => setDraft({ ...draft, reserve: event.target.checked })} />모두 사용할 수 없으면 보관된 순위를 예비로 사용</label>}
            <p className="ut-help-text">{lanes === null ? "칸 수를 모두 비우면 단계의 동시 처리 수를 모델들이 나눠 씁니다." : `함께 최대 ${fmt(lanes)}건`} · 실제 호출은 장비 한도를 함께 따릅니다.</p>
            {!features.slotCaps && <p className="ut-help-text">이 작업은 아직 모델별 상한·예비를 따르지 않습니다. 업무마다 모델 하나를 고릅니다.</p>}
            {snapshot.task === "second-review" && <p className="ut-help-text">후보별 모델 하나를 고르며 투표 수는 늘리지 않습니다.</p>}
            {features.reserve && draft.reserve && <details className="ut-archived"><summary>보관된 예비 순위 보기</summary><p>{chain({ ...draft, mode: "fallback" })}</p></details>}
          </div> : !apiOnly && <div className="ut-editor-rows">
            <RankSelects<AiRankChoice> stage={{ id: `unified-ranks-${snapshot.key}`, label: snapshot.label, slots: 3 }} layout="rows"
              value={draft.ranks} onChange={value => setDraft({ ...draft, ranks: value })} options={snapshot.options} connections={editor.connections}
              slotNames={AI_RANK_SLOT_NAMES} disabled={busy || !!locked} showProvider={false} note={null}
              validate={value => rankChanged || resave ? flowRankIssues(editor, editableLine!, value) : []}
              blocked={(option, index, value) => flowOptionBlocked(editor, editableLine!, index, option, value)} />
          </div>}
          {!pool && !apiOnly && !!snapshot.notes?.length && <ul className="ut-notes">{snapshot.notes.map(note => <li data-tone={note.tone} key={`${note.tone}:${note.text}`}>{modelPickerVisibleText(note.text, editor.connections)}</li>)}</ul>}
          {!pool && !apiOnly && !rankChanged && !!snapshot.pending?.length && !!snapshot.saved.length && <div className="ut-callout ut-resave">
            <p>빠진 계약·경로·장비가 있습니다. 순위를 그대로 다시 저장하면 준비합니다.</p><ul>{snapshot.pending.map(text => <li key={text}>{modelPickerVisibleText(text, editor.connections)}</li>)}</ul>
            <label className="ut-check-label"><input type="checkbox" checked={resave} disabled={busy || !!locked} onChange={event => setResave(event.target.checked)} />바꾸지 않고 다시 저장</label></div>}
          {!pool && draftDuplicate && <div className="ut-callout ut-warn ut-duplicate-note">현재 같은 모델이 두 순위에 있습니다. 다른 모델을 고르면 대체 경로가 생깁니다.</div>}
          {warnings.map(warning => <p className="ut-callout ut-warn" key={`${warning.code}:${warning.line}`}>{warning.text}</p>)}
        </>}
        <section className="ut-recent-execution"><h3>최근 실행</h3><dl className="ut-key-values"><dt>상태</dt><dd>{row ? <span className="ut-dot" data-tone={row.status.level}
          title={[row.status.reason, row.status.detail].filter(Boolean).join(" · ") || undefined}>{row.status.text}</span> : "관측 불가"}</dd>
          {row?.status.reason && row.status.level !== "ok" && <><dt>상태 사유</dt><dd>{modelPickerVisibleText(row.status.reason, editor.connections)}</dd></>}
          <dt>최근 1시간</dt><dd>{row ? <>{row.actual.calls.map(call => {
            const connection = editor.connections.find(entry => entry.id === call.connectionId);
            return <p key={call.key}>{fmt(call.settled)}건 · {connection && onModelOpen ? <button type="button" className="ut-text-btn" onClick={() => onModelOpen(connection.id)}>{modelPickerOptionName(connection, call.model)}</button>
              : connection ? modelPickerOptionName(connection, call.model) : ledgerModelText(call.model)}{call.failed ? ` · 실패 ${fmt(call.failed)}건 포함` : ""}</p>;
          })}{row.actual.empty}{!row.actual.calls.length && !row.actual.empty ? row.actual.settled === null ? "관측 불가" : `${fmt(row.actual.settled)}건` : null}
            {row.actual.note && unifiedTaskActualNote(row) === row.actual.note && <p className="ut-help-text">{row.actual.note}</p>}{row.actual.shared && row.actual.calls.length > 0 && <p className="ut-help-text">투표자 구분 없이 작업 전체 장부</p>}
            {row.actual.warnings.map(warning => <p className="ut-actual-warning" key={warning}>{warning}</p>)}</> : "최근 실행을 읽지 못했습니다."}</dd></dl></section>
        {row?.manage && <p className="ut-scope-note"><Link href={row.manage.href} prefetch={false} className="ut-text-btn" onClick={close}>{row.manage.label} →</Link></p>}
        <div className="ut-editor-foot"><p>홈의 단계 패널과 같은 배정을 사용합니다.</p><div className="ut-buttons"><button type="button" className="ut-btn" onClick={close}>취소</button>
          {!target && <button type="button" className="ut-btn ut-primary" disabled={!canSave} onClick={() => { setAck(false); setStep("confirm"); }}>변경 내용 확인 →</button>}</div></div>
        <div className="ut-home-link"><Link href={unifiedTaskHomeHref(snapshot.task)} prefetch={false} className="ut-text-btn">홈에서 이 작업 보기 ↗</Link></div>
      </>}
      {(step === "confirm" || step === "saving") && <>
        <div className="ut-preview-chain"><div className="ut-label">지금 · {before.mode === "workload_pool" ? "동시에" : "순위대로"}</div>{chain(before)}</div>
        <div className="ut-confirm-arrow" aria-hidden="true">↓</div>
        <div className="ut-preview-chain ut-after"><div className="ut-label">변경 후 · {pool ? "동시에" : "순위대로"}</div>{chain(draft)}</div>
        {resave && !rankChanged && <p className="ut-scope-note">배정은 그대로 두고 빠진 계약·경로·장비를 다시 준비합니다.</p>}
        {pool && <p className="ut-scope-note">{lanes !== null ? <>함께 최대 <b className="ut-num">{fmt(lanes)}건</b>을 처리합니다. </> : "단계·장비 한도 안에서 나눠 처리합니다. "}
          예비 순위 {features.reserve && draft.reserve ? "사용" : "사용 안 함"}.</p>}
        {!pool && draftDuplicate && <div className="ut-callout ut-warn">같은 모델을 반복 배정했습니다. 앞 순위가 실패하면 같은 모델로 다시 요청하게 됩니다.</div>}
        {warnings.map(warning => <p className="ut-callout ut-warn" key={`${warning.code}:${warning.line}`}>{warning.text}</p>)}
        <UnifiedTaskImpact taskLabel={snapshot.label} impact={preview?.impact ?? []} deviceNotes={deviceNotes}
          help={help && supported ? <PoolHelpContent view={help} /> : null} />
        {mustAck && <label className="ut-check-label"><input type="checkbox" checked={ack} disabled={busy} onChange={event => setAck(event.target.checked)} />작업이 멈추는 경고를 읽었습니다. 그래도 저장합니다.</label>}
        {locked && <p className="ut-callout ut-warn" role="alert">{locked}</p>}
        <div className="ut-editor-foot"><p>변경 전·후가 최근 기록에 남습니다.</p><div className="ut-buttons"><button type="button" className="ut-btn" disabled={busy} onClick={() => setStep("edit")}>다시 고르기</button>
          <button type="button" className="ut-btn ut-primary" disabled={busy || !canSave || mustAck && !ack} onClick={submit}>{busy ? "저장 중…" : "변경 저장"}</button></div></div>
      </>}
      {step === "done" && <UnifiedTaskResult results={results} expected={saves} mode={draft.mode} chain={chain(draft)} homeHref={unifiedTaskHomeHref(snapshot.task)} onClose={close} />}
      </>}
    </div>
  </dialog>;
}

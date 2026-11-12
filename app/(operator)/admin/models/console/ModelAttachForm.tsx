"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { aiTaskPoolCappedLanes } from "@/lib/llm/ai-task-execution-config";
import { aiConnectionModelIds, aiModelDisplayName, type AiRankChoice } from "@/lib/operations/admin-ai-tasks";
import { flowRankIssues, needsAcknowledge, rankWarnings, type FlowRankEditor } from "@/lib/operations/flow-rank-editor";
import { ATTACH_RANKS, attachDraft, attachPoolFull, attachPreviewContext, attachRankPosition, attachSaveForms, attachTargets, savedAssignment, type AttachMode } from "@/lib/operations/model-attach";
import { buildPoolHelp, objectParticle, poolHelpWarnings, type PoolHelpContext } from "@/lib/operations/pool-help";
import { assignmentPreview } from "@/lib/operations/stage-panel-model";
import { poolMemberIssues, poolSlotOf } from "@/lib/operations/task-pool-form";
import { modelPickerChoiceKey, modelPickerModelCount, modelPickerOptionName, presentPickerOptions } from "../model-picker-display";
import { saveAiTaskRanksAction } from "../tasks/actions";
import { saveTaskExecutionAction } from "../tasks/execution-actions";
import { PoolHelpTip } from "../tasks/PoolHelp";
import { PoolReserveField, PoolSlotFields } from "../tasks/PoolSlotFields";

type Step = "edit" | "confirm" | "saving" | "done";
type Answer = { ok?: true; message?: string; issues?: string[]; warnings?: string[] } | null;
/** 시험·화면 확인용 처음 상태 */
export type ModelAttachInitial = { key?: string; mode?: AttachMode; rank?: number; slots?: string[]; step?: "edit" | "confirm" };

/**
 * 모델 상세 「쓰는 단계」의 붙이기(2026-11-12 소유자 「작업 배정을 따로 하지 않아도 모델에서 바로」) — 단계 고르기 → 순위대로 N순위 / 함께(동시에) → 저장 전 확인 → 저장.
 * 저장은 작업 배정·단계 패널과 같은 서버 동작이다: 순위는 saveAiTaskRanksAction(rankForm — 같은 판 비교), 방식·구성원·칸 수·예비는 saveTaskExecutionAction
 * (poolExecutionForm — 같은 expectedRevision). 둘 다 웹 쓰기 관문·작업 로그를 그대로 거친다. 고르는 이름은 모델 목록과 같은 이름 하나다.
 */
export function ModelAttachForm({ connectionId, editor, devices, poolHelp, readOnly, initial }: {
  connectionId: string; editor: FlowRankEditor | null;
  devices: readonly { deviceId: string; active: number; limitSlots: number | null }[] | null;
  poolHelp: PoolHelpContext | null; readOnly: boolean; initial?: ModelAttachInitial;
}) {
  const router = useRouter();
  const targets = editor ? attachTargets(editor, connectionId) : [];
  const [key, setKey] = useState(initial?.key ?? targets.find(target => !target.using)?.key ?? targets[0]?.key ?? "");
  const target = targets.find(entry => entry.key === key) ?? null;
  const line = editor?.lines.find(entry => entry.key === key) ?? null;
  const [modeChoice, setMode] = useState<AttachMode | null>(initial?.mode ?? null);
  const mode: AttachMode = target ? modeChoice === "pool" && target.pool ? "pool" : modeChoice === "rank" && target.rank ? "rank" : target.rank ? "rank" : "pool" : "rank";
  const [variant, setVariant] = useState<string>("");
  const [rank, setRank] = useState<number>(initial?.rank ?? 0);
  const [slotDraft, setSlotDraft] = useState<string[] | null>(initial?.slots ?? null);
  const [reserve, setReserve] = useState<boolean | null>(null);
  const [step, setStep] = useState<Step>(initial?.step ?? "edit");
  const [ack, setAck] = useState(false);
  const [results, setResults] = useState<{ ok: boolean; text: string; issues: string[]; warnings: string[] }[]>([]);

  if (!editor) return <p className="mc-muted">작업 배정을 읽지 못해 여기서 붙일 수 없습니다. <Link prefetch={false} href="/admin/models/tasks">전체 작업 배정 보기 →</Link></p>;
  const connection = editor.connections.find(row => row.id === connectionId);
  if (!connection?.enabled) return <p className="mc-muted">꺼진 모델은 단계에 붙일 수 없습니다 — 먼저 켜세요.</p>;
  if (!targets.length || !line || !target) return <p className="mc-muted">이 모델을 받을 수 있는 단계가 없습니다(모델 종류·쓸 단계 제한). <Link prefetch={false} href="/admin/models/tasks">전체 작업 배정 보기 →</Link></p>;

  // 이 단계에서 이 모델의 선택지 — 고르는 상자와 같은 이름 하나(별칭은 한 줄). 서로 다른 모델을 여럿 내는 연결만 고른다
  const variants = presentPickerOptions(line.options.filter(option => option.provider === connectionId && !option.off && !option.saved), editor.connections, null);
  const picked = variants.find(option => option.model === variant) ?? variants[0];
  const choice: AiRankChoice = { provider: connectionId, model: picked.model };
  const before = savedAssignment(line);
  const wantedRank = rank || Math.min(before.ranks.filter(row => row && row.provider !== connectionId).length + 1, ATTACH_RANKS);
  const after = attachDraft({ before, choice, mode, rank: wantedRank, slots: slotDraft, reserve, features: target.features });
  const atRank = attachRankPosition(before, choice, wantedRank);
  const names = (id: string) => {
    const row = editor.connections.find(entry => entry.id === id)!;
    return { label: aiModelDisplayName(row), models: aiConnectionModelIds(row), modelGroups: modelPickerModelCount(row) };
  };
  const context = attachPreviewContext(editor, devices, names);
  const preview = assignmentPreview({ task: line.task, slot: line.slot, before, after, context });
  const rules = { apiOnly: target.apiOnly, features: target.features };
  const full = mode === "pool" && attachPoolFull(before, choice);
  const issues = [...(full ? ["함께 쓰는 모델은 4개까지입니다 — 하나를 빼려면 전체 작업 배정에서 고치세요."] : []),
    ...(mode === "rank" ? flowRankIssues(editor, line, after.ranks) : poolMemberIssues(after.members, after.slots ?? [], editor.connections, rules))];
  const warnings = preview.saves.includes("ranks") ? rankWarnings(editor, [line], { [line.key]: after.ranks }) : [];
  const mustAck = needsAcknowledge(warnings);
  const same = !preview.rows.length;
  const nameOf = (row: AiRankChoice) => { const found = editor.connections.find(entry => entry.id === row.provider); return found ? modelPickerOptionName(found, row.model) : "지워진 연결"; };
  const help = buildPoolHelp({ task: line.task, slot: line.slot, taskLabel: line.label, members: mode === "pool" ? after.members : [], slots: after.slots ?? [],
    connections: editor.connections, context: poolHelp, nameOf: modelPickerOptionName });
  const lanes = aiTaskPoolCappedLanes({ task: line.task, slot: line.slot, mode: "workload_pool",
    members: after.members.flatMap((row, index) => row ? [{ maxSlots: poolSlotOf(after.slots?.[index], target.features) ?? null }] : []) });
  const reset = () => { setStep("edit"); setAck(false); setResults([]); };

  const submit = async () => {
    setStep("saving");
    const done: typeof results = [];
    // 작업 배정·단계 패널과 같은 서버 동작·같은 폼 칸(attachSaveForms — poolExecutionForm · rankForm)
    for (const { kind, form } of attachSaveForms({ line, after, features: target.features, saves: preview.saves })) {
      let answer: Answer = null;
      try {
        answer = kind === "execution" ? await saveTaskExecutionAction(null, form) : await saveAiTaskRanksAction(null, form);
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

  const editing = step === "edit";
  return <div id="model-attach" className="mc-attach" data-dirty={step === "edit" && !same || step === "confirm" ? "true" : undefined}>
    <span className="mc-lab">단계에 붙이기</span>
    <div className="mc-form">
      <label><span>단계</span><select value={key} disabled={!editing || readOnly} onChange={event => { setKey(event.target.value); setMode(null); setRank(0); setSlotDraft(null); setReserve(null); setVariant(""); }}>
        {targets.map(entry => <option key={entry.key} value={entry.key}>{entry.label}{entry.using ? " · 지금 쓰는 중" : ""}</option>)}
      </select></label>
      {variants.length > 1 ? <label><span>모델</span><select value={picked.model} disabled={!editing || readOnly} onChange={event => setVariant(event.target.value)}>
        {variants.map(option => <option key={modelPickerChoiceKey(option, editor.connections)} value={option.model}>{option.text}</option>)}
      </select></label> : <label><span>모델</span><span className="mc-attach-name">{picked.text}</span></label>}
      <fieldset><legend>방식</legend>
        <div className="mc-acts">
          {target.rank && <label><input type="radio" name="attach-mode" checked={mode === "rank"} disabled={!editing || readOnly} onChange={() => setMode("rank")} /> 순위대로</label>}
          {mode === "rank" && <select aria-label="몇 순위에" value={atRank} disabled={!editing || readOnly} onChange={event => setRank(Number(event.target.value))}>
            {Array.from({ length: ATTACH_RANKS }, (_, index) => index + 1).map(value => <option key={value} value={value}
              disabled={value > Math.min(before.ranks.filter(row => row && row.provider !== connectionId).length + 1, ATTACH_RANKS)}>{value}순위</option>)}
          </select>}
          {target.pool && <label><input type="radio" name="attach-mode" checked={mode === "pool"} disabled={!editing || readOnly} onChange={() => setMode("pool")} /> 함께(동시에)</label>}
          {target.pool && <PoolHelpTip view={help} label="「동시에」" />}
        </div>
      </fieldset>
      {mode === "rank" && <p className="mc-hint">{atRank}순위에 넣습니다. 그 자리와 뒤 순위는 한 칸씩 밀리고, 3순위 밖으로 밀린 모델은 빠집니다.
        {before.mode === "workload_pool" ? " 지금 이 단계는 「동시에」라 순위대로로 돌아갑니다." : ""}</p>}
      {mode === "pool" && <>
        <p className="mc-hint">{before.mode === "workload_pool" ? "지금 함께 쓰는 모델에 더합니다." : "지금 1순위와 이 모델이 함께 처리하도록 「동시에」로 바꿉니다."}</p>
        {target.features.slotCaps && <PoolSlotFields value={after.members} slots={after.slots ?? []} disabled={!editing || readOnly} nameOf={nameOf} lanes={lanes}
          help={<PoolHelpTip view={help} label="칸 수" />} warnings={poolHelpWarnings(help)}
          onChange={(index, raw) => setSlotDraft(Array.from({ length: 4 }, (_, at) => at === index ? raw : after.slots?.[at] ?? ""))} />}
        {target.features.reserve && <PoolReserveField checked={!!after.reserve} disabled={!editing || readOnly} onChange={setReserve} />}
      </>}
      {issues.length > 0 && <ul role="alert" className="mc-msg">{issues.map(text => <li key={text}>{text}</li>)}</ul>}
      {editing && <div className="mc-acts">
        <button type="button" className="button small primary" disabled={readOnly || same || issues.length > 0} onClick={() => { setAck(false); setStep("confirm"); }}>바뀌는 내용 확인</button>
        <Link prefetch={false} className="text-button" href={`/admin/models/tasks#mode-${line.task}-${line.slot}`}>전체 작업 배정 보기</Link>
      </div>}
      {same && editing && <p className="mc-hint">이 모델은 이미 그 자리에 있습니다 — 바뀌는 것이 없습니다.</p>}
    </div>

    {(step === "confirm" || step === "saving") && <div className="mc-dlg" role="group" aria-label="저장 전 확인">
      <h4>{line.label}에 {picked.text}{objectParticle(picked.text ?? "")} {mode === "rank" ? `${atRank}순위로` : "함께(동시에)로"} 붙입니다</h4>
      <ul className="mc-diff">{preview.rows.map(row => <li key={row.label}><span>{row.label}</span><span><s>{row.before}</s>{row.after}</span></li>)}</ul>
      {preview.impact.length > 0 && <ul className="mc-diff">{preview.impact.map(item => <li key={item.text} data-tone={item.tone}><span>영향</span><span>{item.text}</span></li>)}</ul>}
      {warnings.filter(warning => !warning.existing).map(warning => <p key={warning.code} className="mc-msg" data-warn="true">{warning.text}</p>)}
      <p className="mc-hint">저장은 작업 배정과 같은 서버 동작입니다({preview.saves.map(kind => kind === "ranks" ? "순위 저장" : "실행 방식 저장").join(" → ")}). 작업 로그에 전·후가 남고
        홈 「바꾼 것 지켜보기」에 한 줄이 생깁니다.</p>
      {mustAck && <label className="mc-ack"><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} disabled={step === "saving"} />위 경고를 읽었습니다 — 그래도 바꿉니다</label>}
      <div className="mc-acts">
        <button type="button" className="button small primary" onClick={submit} disabled={readOnly || step === "saving" || issues.length > 0 || (mustAck && !ack)}>
          {step === "saving" ? "저장 중…" : "붙이기"}</button>
        <button type="button" className="button small" onClick={reset} disabled={step === "saving"}>← 고치기</button>
      </div>
    </div>}

    {step === "done" && <div className="mc-dlg" role="status">
      {results.map((row, index) => <p key={index} data-ok={row.ok ? "yes" : "no"}><b>{row.ok ? "저장함" : "저장 못 함"}</b> {row.text}
        {row.warnings.map(text => <span key={text} className="mc-msg" data-warn="true"> 알림 — {text}</span>)}
        {row.issues.map(text => <span key={text} className="mc-msg"> {text}</span>)}</p>)}
      <div className="mc-acts"><button type="button" className="button small" onClick={() => { reset(); setSlotDraft(null); setReserve(null); setRank(0); }}>닫기</button></div>
    </div>}
  </div>;
}

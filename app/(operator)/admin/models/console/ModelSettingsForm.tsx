"use client";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { AI_TASK_GROUP_LABELS, AI_TASKS } from "@/lib/llm/ai-tasks";
import { formatCount } from "@/lib/operations/console-tasks";
import { connectionFormEntries, deviceRowFormEntries, MODEL_CONSOLE_LIMITS, modelSavePlan, modelSettingsOf, type ModelConsoleRow, type ModelDeviceState,
  type ModelSavePlan, type ModelSettings } from "@/lib/operations/model-console";
import { saveAiConnectionAction } from "../tasks/actions";
import { saveDeviceRowAction } from "../devices/actions";

type Draft = { name: string; machine: string; limit: string; maxTokens: string; reasoningReserve: string; keyValidDays: string; allowedTasks: string[];
  enabled: boolean; newKey: string };
export type ModelSettingsConfirmationState = { pending: boolean } | null;
export type ModelSettingsPreview = { before: { name: string; limit: number }; after: { name: string; limit: number }; taskCount: number | null };
const draftOf = (settings: ModelSettings): Draft => ({ name: settings.name, machine: settings.machine, limit: String(settings.limit),
  maxTokens: settings.maxTokens === null ? "" : String(settings.maxTokens), reasoningReserve: settings.reasoningReserve === null ? "" : String(settings.reasoningReserve),
  keyValidDays: settings.keyValidDays === null ? "" : String(settings.keyValidDays), allowedTasks: [...settings.allowedTasks], enabled: settings.enabled, newKey: "" });
const optional = (text: string) => text.trim() === "" ? null : Number(text.replace(/,/g, ""));

/** 화면 칸 → 저장할 설정. 숫자 모양이 틀리면 그 칸의 문장(저장 검증은 기존 저장이 다시 한다) */
export function settingsFromDraft(draft: Draft, kind: "api" | "cli"): { settings: ModelSettings | null; issues: string[] } {
  const issues: string[] = [];
  const limit = Number(draft.limit);
  if (!/^\d{1,3}$/.test(draft.limit.trim()) || limit < 1 || limit > MODEL_CONSOLE_LIMITS.limitMax) issues.push(`동시 한도는 1~${MODEL_CONSOLE_LIMITS.limitMax}의 정수입니다.`);
  const numbers = kind === "api" ? { maxTokens: optional(draft.maxTokens), reasoningReserve: optional(draft.reasoningReserve), keyValidDays: optional(draft.keyValidDays) }
    : { maxTokens: null, reasoningReserve: null, keyValidDays: null };
  for (const [key, label] of [["maxTokens", "최대 토큰"], ["reasoningReserve", "추론 토큰 여유"], ["keyValidDays", "키 유효 기간"]] as const) {
    const value = numbers[key];
    if (value !== null && (!Number.isSafeInteger(value) || value < 1)) issues.push(`${label}은(는) 1 이상의 정수이거나 비워 둡니다.`);
  }
  if (!draft.name.trim()) issues.push("이름을 적으세요.");
  if (draft.name.trim().length > 80 || draft.machine.trim().length > 80) issues.push("이름·장비는 80자까지입니다.");
  if (issues.length) return { settings: null, issues };
  return { settings: { name: draft.name.trim(), machine: draft.machine.trim(), limit, ...numbers, allowedTasks: draft.allowedTasks, enabled: draft.enabled,
    newKey: draft.newKey.trim() !== "" }, issues };
}

/**
 * 모델 상세의 설정·조치(2026-11-12 시안 화면 4 「설정」·「조치」, 다섯 걸음의 「저장 전 확인」).
 * - 고치기: 이름 · 장비 · 동시 한도 · 최대 토큰 · 추론 여유 · 키 유효 기간 · 쓸 수 있는 단계 · 새 키 → 「저장 전 확인」(바뀌는 값 전 → 후,
 *   한도를 함께 쓸 곳, 영향을 받는 단계) → 「바꾸기」.
 * - 쉬게 하기 = 지우지 않고 모든 단계에서 잠시 빼기 — 연결 끄기(enabled=0). 순위는 그대로 남고 다시 켜면 돌아온다.
 * - 저장은 기존 서버 동작 둘을 차례로 부른다: 연결 저장(saveAiConnectionAction — 감사 ai-connection-save) → (한도가 장비에도 걸리면) 장비 한 줄 저장
 *   (saveDeviceRowAction — 같은 장비의 모델 한도 합 검증·감사). 새 쓰기 경로는 없다.
 */
export function ModelSettingsForm({ row, device, secretBox, readOnly, siblings = [], compact = false, advancedDetails, revealAdvanced = false,
  drawerConfirmation = false, onConfirmationChange, renderContent, taskCount }: { row: ModelConsoleRow; device: ModelDeviceState | null; secretBox: boolean; readOnly: boolean;
  /** 같은 장비를 쓰는 다른 모델(사용자가 정한 이름과 그 서버 이름들) — 저장 전 확인이 장비의 다른 모델 한도를 이름으로 적는다 */
  siblings?: readonly { name: string; models: readonly string[] }[];
  /** The unified drawer starts with the approved name/limit fields; existing controls remain in its expandable details. */
  compact?: boolean; advancedDetails?: ReactNode; revealAdvanced?: boolean;
  drawerConfirmation?: boolean; onConfirmationChange?: (state: ModelSettingsConfirmationState) => void;
  renderContent?: (settings: ReactNode, confirmation: ReactNode | null) => ReactNode; taskCount?: number | null }) {
  const router = useRouter();
  const base = useMemo(() => draftOf(modelSettingsOf(row)), [row]);
  const [mode, setMode] = useState<"view" | "edit" | "confirm">(compact ? "edit" : "view");
  const [draftValue, setDraft] = useState<Draft | null>(null);
  const draft = draftValue ?? base;
  const [advancedChoice, setAdvancedChoice] = useState<{ reveal: boolean; open: boolean } | null>(null);
  const advancedOpen = advancedChoice?.reveal === revealAdvanced ? advancedChoice.open : revealAdvanced;
  const [plan, setPlan] = useState<ModelSavePlan | null>(null);
  const [preview, setPreview] = useState<ModelSettingsPreview | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [messages, setMessages] = useState<{ text: string; tone: "ok" | "warn" | "bad" }[]>([]);
  const [pending, start] = useTransition();
  const keyField = useRef<HTMLInputElement>(null);
  const reviewedConnection = useRef(row.connection);
  const { connection } = row;
  const api = connection.kind === "api";
  const tasks = AI_TASKS.filter(task => api ? task.api : (task.cliTools as readonly string[]).includes(connection.cliTool ?? ""));
  const set = (patch: Partial<Draft>) => setDraft(current => ({ ...(current ?? base), ...patch }));

  const review = (next: Draft) => {
    if (readOnly || pending) return;
    const parsed = settingsFromDraft(next, connection.kind);
    setIssues(parsed.issues);
    if (!parsed.settings) return;
    const made = modelSavePlan(row, device, parsed.settings, model => siblings.find(entry => entry.models.includes(model))?.name ?? null);
    if (!made.changed) { setIssues(["바뀐 값이 없습니다."]); return; }
    reviewedConnection.current = connection;
    setPreview({ before: { name: row.name, limit: row.limit }, after: { name: parsed.settings.name, limit: parsed.settings.limit },
      taskCount: taskCount === undefined ? row.stageCount : taskCount });
    setDraft(next); setPlan(made); setMode("confirm");
    if (drawerConfirmation) onConfirmationChange?.({ pending: false });
  };
  const cancel = () => {
    setDraft(null); setPlan(null); setPreview(null); setIssues([]); setMode(compact ? "edit" : "view");
    if (drawerConfirmation) onConfirmationChange?.(null);
  };
  const apply = () => {
    if (readOnly || pending) return;
    if (drawerConfirmation) onConfirmationChange?.({ pending: true });
    start(async () => {
      let complete = false;
      try {
        const parsed = settingsFromDraft(draft, connection.kind);
        if (!parsed.settings || !plan) return;
        const out: { text: string; tone: "ok" | "warn" | "bad" }[] = [];
        const form = new FormData();
        for (const [name, value] of connectionFormEntries(reviewedConnection.current, { ...parsed.settings, newKey: draft.newKey.trim() || null })) form.append(name, value);
        const saved = await saveAiConnectionAction(null, form);
        if (!saved?.ok) {
          setMessages((saved?.issues ?? ["저장 결과를 확인하지 못했습니다. 새로고침해 상태를 확인하세요."]).map(text => ({ text, tone: "bad" })));
          return;
        }
        out.push({ text: saved.message ?? "저장했습니다.", tone: "ok" }, ...(saved.warnings ?? []).map(text => ({ text, tone: "warn" as const })));
        if (plan.device) {
          const deviceForm = new FormData();
          for (const [name, value] of deviceRowFormEntries(plan.device)) deviceForm.append(name, value);
          const deviceSaved = await saveDeviceRowAction(null, deviceForm);
          if (deviceSaved?.ok) out.push({ text: `장비 ${row.machine}: ${deviceSaved.message ?? "저장했습니다."}`, tone: "ok" },
            ...(deviceSaved.changes ?? []).map(text => ({ text, tone: "ok" as const })), ...(deviceSaved.warnings ?? []).map(text => ({ text, tone: "warn" as const })));
          else out.push(...(deviceSaved?.issues ?? ["저장 결과를 확인하지 못했습니다."]).map(text => ({ text: `연결은 저장했지만 장비 한도는 저장하지 못했습니다: ${text}`, tone: "bad" as const })));
        }
        setMessages(out); setPlan(null); setPreview(null); setDraft(null); setMode(compact ? "edit" : "view");
        complete = true;
        router.refresh();
      } finally {
        if (drawerConfirmation) onConfirmationChange?.(complete ? null : { pending: false });
      }
    });
  };

  const extraFields = <>
    {api && <>
      <label><span>최대 토큰</span><input className="num" type="number" min={1} step={1} value={draft.maxTokens} placeholder="서버가 알려 주면 비움"
        disabled={readOnly || pending} onChange={event => set({ maxTokens: event.target.value })} /></label>
      <label><span>추론 토큰 여유</span><input className="num" type="number" min={1} step={1} value={draft.reasoningReserve} placeholder="일반 모델은 비움"
        disabled={readOnly || pending} onChange={event => set({ reasoningReserve: event.target.value })} /></label>
      <label><span>키 유효 기간(일)</span><input className="num" type="number" min={1} step={1} value={draft.keyValidDays} placeholder="만료 없으면 비움"
        disabled={readOnly || pending} onChange={event => set({ keyValidDays: event.target.value })} /></label>
      <label><span>새 키</span><input ref={keyField} type="password" value={draft.newKey} disabled={!secretBox || readOnly || pending} autoComplete="off"
        placeholder={secretBox ? (connection.hasKey ? "비워 두면 저장된 키 그대로" : "없으면 비워 둡니다") : "이 서버에는 키 암호화 설정이 없습니다"}
        onChange={event => set({ newKey: event.target.value })} /></label>
    </>}
    <fieldset><legend>쓸 수 있는 단계 — 아무것도 고르지 않으면 모든 단계</legend>
      <div className="mc-tasks">{tasks.map(task => <label key={task.id}><input type="checkbox" checked={draft.allowedTasks.includes(task.id)} disabled={readOnly || pending}
        onChange={event => set({ allowedTasks: event.target.checked ? [...draft.allowedTasks, task.id] : draft.allowedTasks.filter(id => id !== task.id) })} />
        {AI_TASK_GROUP_LABELS[task.group]} · {task.label}</label>)}</div></fieldset>
    <p className="mc-hint">동시 한도는 이 칸 하나로 받아 연결 칸 수와, 장비에 모델별 한도가 있으면 그 줄 · 없으면 장비 한도에 함께 씁니다. 어긋나는 곳은 저장 전 확인에서 보입니다.</p>
  </>;

  const feedback = <>
    {issues.map(text => <p key={text} role="alert" className="mc-msg">{text}</p>)}
    {messages.map(message => <p key={message.text} role={message.tone === "bad" ? "alert" : "status"} className="mc-msg" data-warn={message.tone === "warn" ? "true" : undefined}>{message.text}</p>)}
  </>;
  const settings = <div className={compact ? "mc-form mc-compact-settings" : "mc-form"}
    data-dirty={(compact ? mode === "confirm" || JSON.stringify(draft) !== JSON.stringify(base) : mode !== "view") ? "true" : undefined}>
    {mode === "edit" && <form className="mc-form" onSubmit={event => { event.preventDefault(); review(draft); }}>
      {compact ? <>
        <div className="mc-settings-fields">
          <label><span>화면에서 부를 이름</span><input type="text" value={draft.name} maxLength={80} disabled={readOnly || pending}
            onChange={event => set({ name: event.target.value })} autoComplete="off" /></label>
          <label><span>동시 한도</span><input className="num" type="number" min={1} max={MODEL_CONSOLE_LIMITS.limitMax} step={1} value={draft.limit}
            disabled={readOnly || pending} onChange={event => set({ limit: event.target.value })} /></label>
        </div>
        <p className="mc-settings-help">같은 장비를 쓰는 작업들이 이 한도를 나눠 씁니다.</p>
        <div id="model-connection-details" className="mc-settings-advanced" hidden={!advancedOpen}>
          <label><span>장비</span><input type="text" value={draft.machine} maxLength={80} disabled={readOnly || pending}
            onChange={event => set({ machine: event.target.value })} autoComplete="off" placeholder={row.deviceId} /></label>
          {extraFields}
          {!readOnly && <div id="model-actions" className="mc-acts" aria-label="조치">
            <button type="button" className="button small" onClick={() => { setMessages([]); review({ ...base, enabled: !connection.enabled }); }}>{connection.enabled ? "쉬게 하기" : "다시 켜기"}</button>
            {api && <button type="button" className="button small" disabled={!secretBox} onClick={() => { setMessages([]); setTimeout(() => keyField.current?.focus(), 0); }}>키 바꾸기</button>}
          </div>}
          <p className="mc-hint">쉬게 하기는 모델을 지우지 않고 모든 단계에서 잠시 뺍니다. 순위는 그대로 남고, 다시 켜면 돌아옵니다.</p>
          {advancedDetails}
        </div>
        <div className="mc-settings-foot">
          <button type="button" className="text-button" aria-expanded={advancedOpen} aria-controls="model-connection-details"
            onClick={() => setAdvancedChoice({ reveal: revealAdvanced, open: !advancedOpen })}>
            {advancedOpen ? "연결 세부 설정 접기 ↑" : "주소·키·서빙 계약 보기 →"}</button>
          <button type="submit" className="button primary" disabled={readOnly || pending}>변경 확인</button>
        </div>
      </> : <>
      <label><span>이름</span><input type="text" value={draft.name} maxLength={80} onChange={event => set({ name: event.target.value })} autoComplete="off" /></label>
      <label><span>장비</span><input type="text" value={draft.machine} maxLength={80} onChange={event => set({ machine: event.target.value })} autoComplete="off"
        placeholder={row.deviceId} /></label>
      <label><span>동시 한도</span><input className="num" type="number" min={1} max={MODEL_CONSOLE_LIMITS.limitMax} step={1} value={draft.limit}
        onChange={event => set({ limit: event.target.value })} /></label>
      {extraFields}
      <div className="mc-acts"><button type="submit" className="button small primary">저장 전 확인</button>
        <button type="button" className="button small" onClick={cancel}>그만두기</button></div>
      </>}
    </form>}
    {mode === "confirm" && plan && !drawerConfirmation && <SavePlanDialog title={`${row.name}${draft.enabled !== connection.enabled ? (draft.enabled ? "을(를) 다시 켭니다" : "을(를) 쉬게 합니다") : " 설정을 바꿉니다"}`}
      plan={plan} pending={pending} disabled={readOnly} onApply={apply} onCancel={cancel} />}
    {/* id — ⌘K 「쉬게 하기·다시 켜기」가 이 자리로 보낸다(조각 4b). 누르면 저장 전 확인이 열린다 */}
    {mode === "view" && !readOnly && <div id="model-actions" className="mc-acts" aria-label="조치">
      <button type="button" className="button small" onClick={() => { setMessages([]); setMode("edit"); }}>고치기</button>
      {connection.enabled
        ? <button type="button" className="button small primary" onClick={() => { setMessages([]); review({ ...base, enabled: false }); }}>쉬게 하기</button>
        : <button type="button" className="button small primary" onClick={() => { setMessages([]); review({ ...base, enabled: true }); }}>다시 켜기</button>}
      {api && <button type="button" className="button small" onClick={() => { setMessages([]); setMode("edit"); setTimeout(() => keyField.current?.focus(), 0); }}>키 바꾸기</button>}
    </div>}
    {mode === "view" && !readOnly && <p className="mc-hint">쉬게 하기는 모델을 지우지 않고 모든 단계에서 잠시 뺍니다. 순위는 그대로 남고, 다시 켜면 돌아옵니다.</p>}
    {feedback}
  </div>;
  const confirmation = drawerConfirmation && mode === "confirm" && plan && preview
    ? <CompactModelSavePlan plan={plan} preview={preview} pending={pending} disabled={readOnly} onApply={apply} onCancel={cancel}>{feedback}</CompactModelSavePlan> : null;
  return renderContent ? renderContent(settings, confirmation) : confirmation ?? settings;
}

/** Same reviewed plan and actions, presented as the approved full-drawer before/after step. */
export function CompactModelSavePlan({ plan, preview, pending, disabled, onApply, onCancel, children }: {
  plan: ModelSavePlan; preview: ModelSettingsPreview; pending: boolean; disabled: boolean;
  onApply?: () => void; onCancel?: () => void; children?: ReactNode;
}) {
  const additional = plan.lines.filter(line => line.key !== "name" && line.key !== "limit");
  const routineImpacts = plan.impacts.filter(text => text.startsWith("이 모델을 쓰는 단계") || text.startsWith("같은 장비의 다른 모델 한도:"));
  const criticalImpacts = plan.impacts.filter(text => !routineImpacts.includes(text));
  return <div className="mc-settings-confirmation" role="group" aria-label="저장 전 확인" data-dirty="true">
    <div className="mc-settings-preview"><div className="mc-preview-label">지금</div>{preview.before.name} · {formatCount(preview.before.limit)}칸</div>
    <div className="mc-settings-preview mc-settings-after"><div className="mc-preview-label">변경 후</div>{preview.after.name} · {formatCount(preview.after.limit)}칸</div>
    <p className="mc-settings-scope">{preview.taskCount === null ? "이 모델의 표시와 동시 한도에 적용합니다. 쓰는 작업 전체는 읽지 못했습니다."
      : `이 모델을 쓰는 ${formatCount(preview.taskCount)}개 작업의 표시와 동시 한도에 적용합니다.`}</p>
    {additional.length > 0 && <ul className="mc-diff">{additional.map(line => <li key={line.key}><span>{line.label}</span><span><s>{line.before}</s>{line.after}</span></li>)}</ul>}
    {criticalImpacts.length > 0 && <ul className="mc-diff">{criticalImpacts.map(text => <li key={text}><span>영향</span><span>{text}</span></li>)}</ul>}
    {plan.warnings.map(text => <p key={text} className="mc-msg" role="alert" data-warn="true">{text}</p>)}
    {(plan.writes.length > 0 || routineImpacts.length > 0) && <details className="mc-settings-impact"><summary>영향 자세히</summary>
      <div>{plan.writes.length > 0 && <ul className="mc-diff">{plan.writes.map(text => <li key={text}><span>함께 씀</span><span>{text}</span></li>)}</ul>}
        {routineImpacts.length > 0 && <ul className="mc-diff">{routineImpacts.map(text => <li key={text}><span>영향</span><span>{text}</span></li>)}</ul>}</div>
    </details>}
    {children}
    <div className="mc-settings-foot"><button type="button" className="button" disabled={pending} onClick={onCancel}>돌아가기</button>
      <button type="button" className="button primary" disabled={pending || disabled} onClick={onApply}>{pending ? "저장 중…" : "바꾸기"}</button></div>
  </div>;
}

/** 저장 전 확인 — 바뀌는 값(전 → 후) · 함께 쓸 곳 · 영향 · 주의. 「바꾸기」를 눌러야 기존 저장을 부른다 */
export function SavePlanDialog({ title, plan, pending, disabled, onApply, onCancel }: { title: string; plan: ModelSavePlan; pending: boolean; disabled: boolean;
  onApply?: () => void; onCancel?: () => void }) {
  return <div className="mc-dlg" role="group" aria-label="저장 전 확인">
    <h4>{title}</h4>
    <ul className="mc-diff">{plan.lines.map(line => <li key={line.key}><span>{line.label}</span><span><s>{line.before}</s>{line.after}</span></li>)}</ul>
    {plan.writes.length > 0 && <ul className="mc-diff">{plan.writes.map(text => <li key={text}><span>함께 씀</span><span>{text}</span></li>)}</ul>}
    {plan.impacts.length > 0 && <ul className="mc-diff">{plan.impacts.map(text => <li key={text}><span>영향</span><span>{text}</span></li>)}</ul>}
    {plan.warnings.map(text => <p key={text} className="mc-msg" data-warn="true">{text}</p>)}
    <div className="mc-acts"><button type="button" className="button small primary" disabled={pending || disabled} onClick={onApply}>{pending ? "저장 중…" : "바꾸기"}</button>
      <button type="button" className="button small" disabled={pending} onClick={onCancel}>취소</button></div>
  </div>;
}

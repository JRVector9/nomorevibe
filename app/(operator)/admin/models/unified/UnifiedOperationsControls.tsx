"use client";

import Link from "next/link";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { aiTask, aiTaskSlotLabel } from "@/lib/llm/ai-tasks";
import { AI_TASK_IMPORT_CONFIRM } from "@/lib/operations/admin-ai-tasks";
import type { ModelUnifiedRead } from "@/lib/operations/model-unified-read";
import type { AssistControlView } from "@/lib/operations/llm-assist-controls";
import type { SettingsControlView } from "@/lib/operations/admin-runtime-settings";
import { unifiedAssistDraft, unifiedAssistForm, unifiedAssistModeLabel, unifiedConcurrencyForm, type UnifiedAssistDraft } from "@/lib/operations/model-unified-controls";
import { saveAssistControlAction } from "../tasks/assist-actions";
import { applyAiTaskImportAction, clearUnreadAiTaskRanksAction, type AiTaskActionState } from "../tasks/actions";
import { saveRuntimeSettingsGroup } from "../limits/actions";
import { ModelDrawer } from "../console/ModelDrawer";

type Data = Pick<ModelUnifiedRead, "assist" | "concurrency" | "importPreview" | "retired" | "retiredReadable" | "retiredError">;
type Panel = { kind: "assist"; task: string } | { kind: "limits" | "import" | "cleanup" } | null;
type Step = "edit" | "confirm" | "done";
type Save = (previous: AiTaskActionState, form: FormData) => Promise<AiTaskActionState>;

function useControlSave(action: Save, readOnly: boolean) {
  const router = useRouter();
  const [state, setState] = useState<AiTaskActionState>(null), [pending, startTransition] = useTransition(), [uncertain, setUncertain] = useState(false);
  const save = (form: FormData) => {
    if (readOnly || pending || uncertain || state?.ok) return;
    startTransition(async () => {
      try { const result = await action(null, form); setState(result); if (result?.ok) router.refresh(); }
      catch { setUncertain(true); setState({ issues: ["저장 응답을 확인하지 못했습니다. 현재 기록과 설정을 새로 확인한 뒤 다시 여세요."] }); }
    });
  };
  return { state, pending, uncertain, save };
}

function Result({ state }: { state: AiTaskActionState }) {
  return <>{state?.ok && <p role="status" className="mu-success">✓ {state.message ?? "저장했습니다."}</p>}
    {state?.warnings?.map(message => <p role="note" className="mu-callout" key={message}>{message}</p>)}
    {state?.issues?.map(message => <p role="alert" className="mu-callout mu-warn" key={message}>{message}</p>)}</>;
}
function Footer({ children, note }: { children: ReactNode; note?: string }) {
  return <div className="mu-editor-foot">{note && <p>{note}</p>}<div>{children}</div></div>;
}
const button = "button small", primary = "button small primary";
function Preview({ label, children, after = false }: { label: string; children: ReactNode; after?: boolean }) {
  return <div className={`mu-preview-chain${after ? " mu-after" : ""}`}><small>{label}</small>{children}</div>;
}
const assistText = (value: UnifiedAssistDraft) => `${unifiedAssistModeLabel(value.mode)} · 보내기 ${value.dispatchEnabled ? "켬" : "끔"} · 제품 반영 ${value.applyEnabled ? "켬" : "끔"}`;

export function UnifiedAssistDrawer({ control, readOnly, onClose }: { control: AssistControlView; readOnly: boolean; onClose: () => void }) {
  const [snapshot] = useState(control), [draft, setDraft] = useState<UnifiedAssistDraft>(() => unifiedAssistDraft(control)), [step, setStep] = useState<Step>("edit");
  const result = useControlSave(saveAssistControlAction, readOnly);
  const done = !!result.state?.ok;
  const changed = draft.mode !== snapshot.mode || draft.dispatchEnabled !== snapshot.dispatchEnabled || draft.applyEnabled !== snapshot.applyEnabled;
  const irrevocable = draft.mode === "confirm" && !snapshot.confirmationRequired;
  const update = (patch: Partial<UnifiedAssistDraft>) => setDraft(value => unifiedAssistDraft({ ...value, ...patch }));
  return <ModelDrawer title={done ? "보강 제어를 저장했습니다" : step === "confirm" ? `${snapshot.label} 제어를 바꿉니다` : snapshot.label}
    eyebrow={step === "confirm" && !done ? "저장 전 확인" : "LLM 보강 제어"} titleId="mu-assist-title" onClose={() => { if (!result.pending) onClose(); }}>
    <div className="mu-control-drawer" data-dirty={changed && !done || undefined}>
      {!done && step === "edit" ? <>
        <div className="mu-callout">보강에 쓸 모델은 작업별 적용 현황의 ‘{snapshot.aiTaskLabel}’에서 정합니다.</div>
        <label className="mu-field"><span>운영 방식</span><select aria-label={`${snapshot.label} 운영 방식`} value={draft.mode} disabled={readOnly}
          onChange={event => update({ mode: event.target.value as UnifiedAssistDraft["mode"] })}>
          {(["off", "shadow", "confirm"] as const).map(mode => <option key={mode} value={mode}>{unifiedAssistModeLabel(mode)}</option>)}</select></label>
        <label className="mu-switch-row">보내기 <span>모델을 호출</span><input type="checkbox" aria-label={`${snapshot.label} 보내기`} checked={draft.dispatchEnabled}
          disabled={readOnly || draft.mode === "off"} onChange={event => update({ dispatchEnabled: event.target.checked })} /></label>
        <label className="mu-switch-row">제품에 반영 <span>확인 후 반영일 때 사용</span><input type="checkbox" aria-label={`${snapshot.label} 제품에 반영`} checked={draft.applyEnabled}
          disabled={readOnly || draft.mode !== "confirm" || !draft.dispatchEnabled} onChange={event => update({ applyEnabled: event.target.checked })} /></label>
        {snapshot.confirmationRequired && <p className="mu-help">관리자 확인 필수(끌 수 없음){snapshot.task === "uptime" ? " — 옛 자동 내림이 보강 확인을 기다립니다." : "."}</p>}
        <p className="mu-help">{snapshot.queue ? Object.entries(snapshot.queue).filter(([, count]) => count > 0).map(([state, count]) => `${state} ${count.toLocaleString("ko-KR")}건`).join(" · ") || "끝나지 않은 일 없음" : "끝나지 않은 일 수를 읽지 못했습니다."}</p>
        <Footer note={readOnly ? "읽기 전용 미리보기 — 저장할 수 없습니다." : `현재 값: ${assistText(snapshot)}`}>
          <button type="button" className={primary} disabled={readOnly || !changed} onClick={() => setStep("confirm")}>변경 확인</button></Footer>
      </> : !done && <>
        <Preview label="지금">{assistText(snapshot)}</Preview><Preview label="변경 후" after>{assistText(draft)}</Preview>
        {irrevocable && <p className="mu-callout mu-warn">「확인 후 반영」으로 저장하면 관리자 확인 필수가 켜지고 다시 끌 수 없습니다(DB 규칙).</p>}
        <p className="mu-scope-note">이 일의 판이 바뀌면 진행 중이던 호출은 모델을 부르기 전에 멈춥니다. 모델 배정은 바뀌지 않습니다.</p>
      </>}
      <Result state={result.state} />
      {done ? <Footer><button type="button" className={primary} onClick={onClose}>확인</button></Footer> : step === "confirm" && <Footer>
        <button type="button" className={button} disabled={result.pending} onClick={() => setStep("edit")}>돌아가기</button>
        <button type="button" className={primary} disabled={readOnly || result.pending || result.uncertain} onClick={() => result.save(unifiedAssistForm(snapshot, draft))}>{result.pending ? "저장 중…" : "저장"}</button>
      </Footer>}
    </div>
  </ModelDrawer>;
}

export function UnifiedConcurrencyDrawer({ control, readOnly, onClose }: { control: SettingsControlView; readOnly: boolean; onClose: () => void }) {
  const [snapshot] = useState(control), [step, setStep] = useState<Step>("edit");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(control.fields.map(field => [field.path, field.input])));
  const [resets, setResets] = useState<Record<string, boolean>>({});
  const result = useControlSave(saveRuntimeSettingsGroup, readOnly || snapshot.revision === null);
  const locked = readOnly || snapshot.revision === null, done = !!result.state?.ok;
  const changed = snapshot.fields.some(field => resets[field.path] || values[field.path] !== field.input);
  const valid = snapshot.fields.every(field => resets[field.path] || /^\d+$/.test(values[field.path]) && Number(values[field.path]) >= 1 && Number(values[field.path]) <= 4);
  const after = (field: SettingsControlView["fields"][number]) => resets[field.path] ? `${field.defaultInput} (기본값)` : values[field.path];
  return <ModelDrawer title={done ? "동시 업무를 저장했습니다" : step === "confirm" ? "동시 업무를 바꿉니다" : "동시 업무·호출 한도"}
    eyebrow={step === "confirm" && !done ? "저장 전 확인" : "운영 설정"} titleId="mu-limits-title" onClose={() => { if (!result.pending) onClose(); }}>
    <div className="mu-control-drawer" data-dirty={changed && !done || undefined}>
      {!done && step === "edit" ? <>
        <p className="mu-drawer-lead">작업이 한꺼번에 맡는 업무 수입니다. 실제 모델 호출은 장비와 모델별 한도 안에서 실행됩니다.</p>
        <div className="mu-split-fields">{snapshot.fields.map(field => <label className="mu-field" key={field.path}><span>{field.label} · {field.path.includes("second-review") ? "건" : "개"}</span>
          <input type="number" min={1} max={4} aria-label={field.label} value={values[field.path]} disabled={locked || !!resets[field.path]}
            onChange={event => setValues(value => ({ ...value, [field.path]: event.target.value }))} />
          <small>운영 범위 1~4 · 기본 {field.defaultInput}</small>
          {field.overridden && <span className="mu-reset"><input type="checkbox" aria-label={`${field.label} 기본값으로`} checked={!!resets[field.path]} disabled={locked}
            onChange={event => setResets(value => ({ ...value, [field.path]: event.target.checked }))} />기본값으로</span>}</label>)}</div>
        <div className="mu-callout">개별 분산 모델의 칸 수와 예비 순위는 해당 작업의 배정 상세에서 관리합니다.</div>
        <Link prefetch={false} href="/admin/models/limits" className="mu-control-link">작업별 호출 상한·틱 시간 보기 →</Link>
        {snapshot.rowError && <p role="alert" className="mu-callout mu-warn">설정 행을 읽지 못했습니다({snapshot.rowError}). 표시된 기본값을 저장할 수 없습니다.</p>}
        <Footer note={locked ? "읽기 전용 — 저장할 수 없습니다." : "진행 중인 호출은 유지합니다."}><button type="button" className={primary}
          disabled={locked || !changed || !valid} onClick={() => setStep("confirm")}>변경 확인</button></Footer>
      </> : !done && <>
        <Preview label="지금">{snapshot.fields.map(field => <div key={field.path}>{field.label}: {field.input}</div>)}</Preview>
        <Preview label="변경 후" after>{snapshot.fields.map(field => <div key={field.path}>{field.label}: {after(field)}</div>)}</Preview>
        <p className="mu-scope-note">작업이 맡는 업무 수만 바뀝니다. 장비·모델별 동시 한도는 그대로 적용됩니다. 각 워커는 30초 안에 다음 틱부터 씁니다.</p>
      </>}
      <Result state={result.state} />
      {done ? <Footer><button type="button" className={primary} onClick={onClose}>확인</button></Footer> : step === "confirm" && <Footer>
        <button type="button" className={button} disabled={result.pending} onClick={() => setStep("edit")}>돌아가기</button>
        <button type="button" className={primary} disabled={locked || result.pending || result.uncertain} onClick={() => result.save(unifiedConcurrencyForm(snapshot, values, resets))}>{result.pending ? "저장 중…" : "저장"}</button>
      </Footer>}
    </div>
  </ModelDrawer>;
}

function ImportDrawer({ preview, readOnly, onClose }: { preview: Data["importPreview"]; readOnly: boolean; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState(preview), [received, setReceived] = useState(preview), [confirm, setConfirm] = useState("");
  const result = useControlSave(applyAiTaskImportAction, readOnly);
  if (received !== preview) {
    setReceived(preview);
    if (!confirm && !result.pending && !result.state?.ok) setSnapshot(preview);
  }
  const plan = snapshot?.plan, writes = plan ? plan.connections.filter(row => row.action !== "existing").length + plan.slots.filter(row => row.action === "create").length : 0;
  const unchanged = plan?.slots.filter(row => row.action === "unchanged") ?? [], empty = plan?.slots.filter(row => row.action === "empty") ?? [];
  const apply = () => { const form = new FormData(); form.set("planHash", snapshot?.hash ?? ""); form.set("confirm", confirm); result.save(form); };
  return <ModelDrawer title="옛 설정 가져오기" eyebrow="옛 설정 정리" titleId="mu-import-title" onClose={() => { if (!result.pending) onClose(); }}>
    <div className="mu-control-drawer"><p className="mu-drawer-lead">현재 순위가 없는 작업에만 옛 설정을 옮깁니다. 기존 배정은 유지합니다.</p>
      {!snapshot && <div className="mu-callout">가져오기 계획을 아직 읽지 않았습니다. <Link prefetch={false} href="/admin/models?import=plan#import">계획 읽기 →</Link><p>저장하지 않고 현재 설정과 필요한 서버 모델 목록만 읽습니다.</p></div>}
      {snapshot?.error && <p role="alert" className="mu-callout mu-warn">계획을 만들지 못했습니다: {snapshot.error} <Link prefetch={false} href="/admin/models?import=plan#import">계획 다시 읽기 →</Link></p>}
      {plan && <>
        <div className="mu-callout"><b>{writes ? `가져올 항목 ${writes}개` : "가져올 항목 없음"}</b><p>{writes ? "계획의 대상과 경고를 확인한 뒤 적용하세요." : "옮길 연결이나 빈 작업 순위가 없습니다."}</p></div>
        {plan.connections.map(row => <div className="mu-manage-row" key={row.key}><span>{row.label}<small>{row.kind === "api" ? row.baseUrl : row.cliTool} · {row.deviceId} {row.capacitySlots}칸</small>
          {row.keyFrom && <small>계약 {row.keyFrom.routeId}의 저장 키를 옮깁니다.</small>}{row.keyEnv && <small>환경변수 {row.keyEnv}의 키를 옮깁니다.</small>}</span>
          <span className="mu-pill">{row.action === "create" ? "연결 만들기" : row.action === "update" ? "모델 이름 더하기" : "유지"}</span></div>)}
        {plan.slots.filter(row => row.action === "create" || row.action === "differs").map(row => { const task = aiTask(row.task); return <div className="mu-manage-row" key={`${row.task}#${row.slot}`}><span>{task ? aiTaskSlotLabel(task, row.slot) : row.task}
          <small>{row.ranks.map(rank => `${rank.rank}순위 ${snapshot?.connectionLabels[rank.connectionKey] ?? rank.model}`).join(" → ") || "옮길 순위 없음"}</small></span>
          <span className="mu-pill">{row.action === "create" ? "빈 칸 채우기" : row.action === "differs" ? "다름 · 건너뜀" : "유지"}</span></div>; })}
        {unchanged.length > 0 && <div className="mu-manage-row"><span>기존 배정 {unchanged.length}개<small>빈 칸만 채우므로 건너뜁니다.</small></span><span className="mu-pill">유지</span></div>}
        {empty.length > 0 && <div className="mu-manage-row"><span>{empty.every(row => row.task === "second-review" && row.slot > 1) ? `선택하지 않은 2차 투표자 ${empty.length}칸` : `옮길 순위 없는 작업 ${empty.length}개`}
          <small>사용하지 않는 칸은 자동으로 채우지 않습니다.</small></span><span className="mu-pill">유지</span></div>}
        {plan.warnings.map(warning => <p role="note" className="mu-callout mu-warn" key={warning}>{warning}</p>)}
        {snapshot?.servers.map(server => <p className="mu-help" key={server.baseUrl}>{server.host ?? server.baseUrl} · {server.error ? `모델 목록 읽기 실패(${server.error})` : `모델 ${server.count}개`}</p>)}
        {writes > 0 && !result.state?.ok && <><p className="mu-scope-note">계획이 그 사이 바뀌었으면 아무것도 쓰지 않습니다. 계약·용량 경로·장비는 만들지 않습니다.</p>
          <label className="mu-field"><span>확인 — 「{AI_TASK_IMPORT_CONFIRM}」를 적으세요</span><input aria-label="가져오기 확인" value={confirm} disabled={readOnly || result.pending}
            onChange={event => setConfirm(event.target.value)} autoComplete="off" /></label></>}
      </>}
      <Result state={result.state} /><Footer note={readOnly ? "읽기 전용 미리보기 — 가져오기를 적용할 수 없습니다." : "가져오기 계획을 확인한 뒤 적용합니다."}>
        {writes > 0 && !result.state?.ok && <button type="button" className={primary} disabled={readOnly || result.pending || result.uncertain || confirm !== AI_TASK_IMPORT_CONFIRM || !snapshot?.hash}
          onClick={apply}>{result.pending ? "적용 중…" : `적용(쓰기 ${writes}건)`}</button>}
        <button type="button" className={button} disabled={result.pending} onClick={onClose}>확인</button>
      </Footer></div>
  </ModelDrawer>;
}

function RetiredRecord({ entry, readOnly }: { entry: Data["retired"][number]; readOnly: boolean }) {
  const result = useControlSave(clearUnreadAiTaskRanksAction, readOnly);
  const clear = () => { const form = new FormData(); form.set("task", entry.task); form.set("slot", String(entry.slot)); form.set("revision", entry.revision); result.save(form); };
  return <section className="mu-retired-record" id={`execution-${entry.task}-${entry.slot}`}><Preview label="실행에서 사용하지 않음"><b>{entry.label}</b><p>남은 순위 {entry.count}개</p></Preview>
    <Result state={result.state} />{!result.state?.ok && <button type="button" className={button} disabled={readOnly || result.pending || result.uncertain} onClick={clear}
      aria-label={`${entry.label} 옛 순위 기록 ${entry.count}개 지우기`}>{result.pending ? "지우는 중…" : `이 기록 ${entry.count}개 지우기`}</button>}</section>;
}

export function UnifiedOperationsControls({ data, readOnly, openImport = false }: { data: Data; readOnly: boolean; openImport?: boolean }) {
  const [panel, setPanel] = useState<Panel>(openImport ? { kind: "import" } : null);
  useEffect(() => {
    const reveal = () => { if (window.location.hash === "#import") setPanel({ kind: "import" }); if (window.location.hash === "#retired-records"
      || data.retired.some(entry => window.location.hash === `#execution-${entry.task}-${entry.slot}`)) setPanel({ kind: "cleanup" }); };
    reveal(); window.addEventListener("hashchange", reveal); return () => window.removeEventListener("hashchange", reveal);
  }, [data.retired]);
  const { assist, concurrency, retired, retiredReadable, retiredError } = data;
  const sending = assist.controls.filter(control => control.mode !== "off" && control.dispatchEnabled).length;
  const selected = panel?.kind === "assist" ? assist.controls.find(control => control.task === panel.task) : null;
  const close = () => setPanel(null);
  return <>
    <div className="mu-folds">
      <details id="assist-controls"><summary>LLM 보강 제어 <span>{assist.error ? "읽지 못함" : `보내기 ${sending} / ${assist.controls.length}개`}</span></summary>
        <div className="mu-fold-content"><p>보강 작업의 모델은 위 작업 목록에서 고릅니다. 여기서는 호출과 제품 반영을 제어합니다.</p>
          {assist.error ? <p role="alert">LLM 보강 제어를 읽지 못했습니다({assist.error}).</p> : !assist.controls.length ? <p>보강 제어 행이 없습니다.</p> : assist.controls.map(control => <div className="mu-assist-row" key={control.task}>
            <span className="mu-assist-label">{control.label}<small>{unifiedAssistModeLabel(control.mode)}{control.confirmationRequired ? " · 확인 필수" : ""}</small></span>
            <span className="mu-dot" data-idle={!control.dispatchEnabled}>{`보내기 ${control.dispatchEnabled ? "켬" : "끔"}`}</span>
            <button type="button" className="mu-text-btn" aria-label={`${control.label} 보강 제어 설정`} onClick={() => setPanel({ kind: "assist", task: control.task })}>설정 →</button>
          </div>)}
        </div>
      </details>
      <details id="concurrency"><summary>동시 업무·호출 한도 <span>{concurrency.rowError ? "읽지 못함" : `2차 ${concurrency.fields[0]?.input ?? "?"}건 · 발행 분류 ${concurrency.fields[1]?.input ?? "?"}개`}</span></summary>
        <div className="mu-fold-content"><p>모델별 칸 수는 작업 상세에서, 작업 전체의 동시 업무와 호출 상한은 아래에서 관리합니다.</p>
          {concurrency.fields.map(field => <div className="mu-manage-row" key={field.path}><span>{field.label}<small>한꺼번에 맡는 업무 {field.input}{field.path.includes("second-review") ? "건" : "개"}</small></span>
            <button type="button" className="mu-text-btn" onClick={() => setPanel({ kind: "limits" })}>한도 보기 →</button></div>)}
          {concurrency.rowError && <p role="alert">동시 업무 설정을 읽지 못했습니다. 현재 기본값을 보이며 저장할 수 없습니다.</p>}
        </div>
      </details>
      <details id="cleanup"><summary>옛 설정 정리 <span>가져오기 · {retiredReadable ? "쓰지 않는 순위 기록" : "순위 기록 읽지 못함"}</span></summary>
        <div className="mu-fold-content"><div id="import" className="mu-manage-row"><span>옛 설정 가져오기<small>비어 있는 작업의 순위만 채웁니다.</small></span>
          <button type="button" className="mu-text-btn" onClick={() => setPanel({ kind: "import" })}>계획 보기 →</button></div>
          <div id="retired-records" className="mu-manage-row"><span>없앤 작업의 순위 기록<small>{!retiredReadable ? "기록을 읽지 못함" : retired.length ? retired.map(entry => `${entry.label} ${entry.count}개`).join(" · ") : "남은 옛 순위 기록 없음"}</small></span>
            <button type="button" className="mu-text-btn" disabled={!retiredReadable} onClick={() => setPanel({ kind: "cleanup" })}>기록 정리 →</button></div>
          {!retiredReadable && <p role="alert">옛 순위 기록을 읽지 못했습니다{retiredError ? `(${retiredError})` : ""}. 현재 기록을 확인할 때까지 정리할 수 없습니다.</p>}
        </div>
      </details>
    </div>
    {selected && <UnifiedAssistDrawer key={selected.task} control={selected} readOnly={readOnly} onClose={close} />}
    {panel?.kind === "limits" && <UnifiedConcurrencyDrawer control={concurrency} readOnly={readOnly} onClose={close} />}
    {panel?.kind === "import" && <ImportDrawer preview={data.importPreview} readOnly={readOnly} onClose={close} />}
    {panel?.kind === "cleanup" && <ModelDrawer title={retired.length ? "쓰지 않는 순위 기록 정리" : "옛 순위 기록"} eyebrow="옛 설정 정리" titleId="mu-cleanup-title" onClose={close}>
      <div className="mu-control-drawer"><p className="mu-drawer-lead">없앤 작업의 기록입니다. 현재 모델 호출과 배정에는 쓰이지 않습니다.</p>
        {!retiredReadable ? <p role="alert" className="mu-callout mu-warn">옛 순위 기록을 읽지 못했습니다. 현재 기록을 확인할 때까지 정리할 수 없습니다.</p>
          : retired.length ? retired.map(entry => <RetiredRecord key={`${entry.task}#${entry.slot}#${entry.revision}`} entry={entry} readOnly={readOnly} />) : <div className="mu-callout">정리할 기록이 없습니다.</div>}
        <Footer note={readOnly ? "읽기 전용 — 기록을 지울 수 없습니다." : "현재 동작에 쓰이는 순위는 지우지 않습니다."}><button type="button" className={button} onClick={close}>확인</button></Footer>
      </div></ModelDrawer>}
  </>;
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isFlowPromptStage, type FlowPromptResponse, type FlowPromptSection, type FlowPromptStage } from "@/lib/operations/flow-prompts-contract";
import "./FlowPrompt.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: FlowPromptResponse }
  | { kind: "error"; message: string; canRetry: boolean };

const asPlaceholder = (variable: string) => variable.startsWith("{{") && variable.endsWith("}}") ? variable : `{{${variable}}}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function parseSection(value: unknown): FlowPromptSection | null {
  if (!isRecord(value)) return null;
  const { id, title, source, system, userTemplate, variables, notes, version, error } = value;
  if (typeof id !== "string" || typeof title !== "string") return null;
  if (!isStringArray(source) || !isStringArray(variables) || !isStringArray(notes)) return null;
  if (!(typeof system === "string" || system === null)) return null;
  if (!(typeof userTemplate === "string" || userTemplate === null)) return null;
  if (version !== undefined && typeof version !== "string") return null;
  if (error !== undefined && typeof error !== "string") return null;
  return {
    id,
    title,
    source: [...source],
    system,
    userTemplate,
    variables: [...variables],
    notes: [...notes],
    ...(typeof version === "string" ? { version } : {}),
    ...(typeof error === "string" ? { error } : {}),
  };
}

function parseResponse(value: unknown, requestedStage: FlowPromptStage): FlowPromptResponse | null {
  if (!isRecord(value)) return null;
  const { stage, label, observedAt, sections, note } = value;
  if (typeof stage !== "string" || !isFlowPromptStage(stage) || stage !== requestedStage) return null;
  if (typeof label !== "string" || typeof observedAt !== "string" || typeof note !== "string") return null;
  if (!Array.isArray(sections)) return null;
  const parsedSections: FlowPromptSection[] = [];
  for (const section of sections) {
    const parsed = parseSection(section);
    if (!parsed) return null;
    parsedSections.push(parsed);
  }
  return { stage, label, observedAt, sections: parsedSections, note };
}

function PromptSectionView({ section }: { section: FlowPromptSection }) {
  const hasPlaceholder = section.userTemplate ? /\{\{[^}]*\}\}/.test(section.userTemplate) : false;
  return <section className="flow-prompt-section">
    <div className="flow-prompt-section-head">
      <h3>{section.title}</h3>
      <span className="flow-prompt-version">버전 {section.version ?? "미확인"}</span>
    </div>
    {section.error !== undefined && <p className="flow-prompt-section-error">오류: {section.error || "내용 없음"}</p>}
    <dl className="flow-prompt-facts">
      <dt>소스 경로</dt>
      <dd>{section.source.length ? <ul className="flow-prompt-source-list">{section.source.map((path, index) => <li key={`${path}-${index}`}><code>{path}</code></li>)}</ul> : <span className="flow-prompt-muted">없음</span>}</dd>
      <dt>변수</dt>
      <dd>{section.variables.length ? <ul className="flow-prompt-variable-list">{section.variables.map((variable, index) => <li key={`${variable}-${index}`}><code>{asPlaceholder(variable)}</code></li>)}</ul> : <span className="flow-prompt-muted">없음</span>}</dd>
    </dl>
    <div className="flow-prompt-block">
      <h4>system</h4>
      {section.system === null ? <p className="flow-prompt-muted">없음</p> : <pre className="flow-prompt-code">{section.system}</pre>}
    </div>
    <div className="flow-prompt-block">
      <h4>userTemplate</h4>
      {section.userTemplate === null ? <p className="flow-prompt-muted">없음</p> : <pre className="flow-prompt-code">{section.userTemplate}</pre>}
      {(hasPlaceholder || section.variables.length > 0) && <p className="flow-prompt-placeholder-note"><code>{"{{...}}"}</code>는 실제 실행 때 채워지는 동적 입력입니다. 이 화면은 실제 후보·사용자 자료를 조회하지 않습니다.</p>}
    </div>
    <div className="flow-prompt-block">
      <h4>notes</h4>
      {section.notes.length ? <ul className="flow-prompt-notes-list">{section.notes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}</ul> : <p className="flow-prompt-muted">없음</p>}
    </div>
  </section>;
}

function FlowPromptContent({ data }: { data: FlowPromptResponse }) {
  return <article className="flow-prompt-response">
    <header className="flow-prompt-response-head">
      <h2>{data.label}</h2>
      <span className="flow-prompt-stage-code">{data.stage}</span>
    </header>
    <p className="flow-prompt-meta">관측 시각: <span className="mono">{data.observedAt}</span></p>
    <p className="flow-prompt-note">{data.note}</p>
    <p className="flow-prompt-caveat">현재 소스 템플릿과 명시적 자리표시자만 표시합니다. 실제 요청 본문 기록이 아닙니다.</p>
    <div className="flow-prompt-sections">
      {data.sections.map((section, index) => <PromptSectionView key={`${section.id}-${index}`} section={section} />)}
    </div>
    {!data.sections.length && <p className="flow-prompt-status">표시할 프롬프트 섹션이 없습니다.</p>}
  </article>;
}

function FlowPromptDialog({ stage, target, onClose }: { stage: FlowPromptStage; target: HTMLElement; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const headingId = useId();
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10_000);

    void (async () => {
      try {
        const response = await fetch(`/api/admin/flow/prompts?stage=${encodeURIComponent(stage)}`, {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!active) return;
        if (timedOut) {
          setLoad({ kind: "error", message: "프롬프트 응답 시간이 초과되었습니다.", canRetry: true });
          return;
        }
        if (response.status === 403) {
          setLoad({ kind: "error", message: "로그인이 필요합니다. 다시 로그인한 뒤 시도해 주세요.", canRetry: false });
          return;
        }
        if (!response.ok) {
          setLoad({ kind: "error", message: `프롬프트를 불러오지 못했습니다. (HTTP ${response.status})`, canRetry: true });
          return;
        }
        const body: unknown = await response.json();
        if (!active) return;
        if (timedOut) {
          setLoad({ kind: "error", message: "프롬프트 응답 시간이 초과되었습니다.", canRetry: true });
          return;
        }
        const parsed = parseResponse(body, stage);
        if (!parsed) {
          setLoad({ kind: "error", message: "서버 응답 형식이 예상과 다릅니다.", canRetry: true });
          return;
        }
        setLoad({ kind: "ready", data: parsed });
      } catch {
        if (!active) return;
        setLoad({
          kind: "error",
          message: timedOut ? "프롬프트 응답 시간이 초과되었습니다." : "프롬프트를 불러오지 못했습니다.",
          canRetry: true,
        });
      } finally {
        window.clearTimeout(timer);
      }
    })();

    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [attempt, stage]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <dialog ref={dialogRef} className="flow-prompt-dialog" aria-labelledby={headingId}
      onClose={() => onClose()}>
      <div className="flow-prompt-dialog-inner">
        <header className="flow-prompt-dialog-head">
          <div>
            <p className="eyebrow">읽기 전용 프롬프트</p>
            <h2 id={headingId}>프롬프트 확인</h2>
          </div>
          <button type="button" className="button small flow-prompt-close" onClick={() => dialogRef.current?.close()} aria-label="프롬프트 확인 창 닫기">닫기</button>
        </header>
        <div className="flow-prompt-dialog-body">
          {load.kind === "loading" && <p className="flow-prompt-status" role="status">프롬프트를 불러오는 중입니다…</p>}
          {load.kind === "error" && <div className="flow-prompt-status flow-prompt-error" role="alert"><p>{load.message}</p>{load.canRetry && <button type="button" className="button small" onClick={() => { setLoad({ kind: "loading" }); setAttempt(value => value + 1); }}>다시 시도</button>}</div>}
          {load.kind === "ready" && <FlowPromptContent data={load.data} />}
        </div>
      </div>
    </dialog>,
    target
  );
}

export function FlowPromptButton({ stage, label = "프롬프트 확인" }: { stage: FlowPromptStage; label?: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  if (!isFlowPromptStage(stage)) return null;
  const close = () => {
    setTarget(null);
    trigger.current?.focus();
  };
  return <>
    <button ref={trigger} type="button" className="button small flow-prompt-button" aria-haspopup="dialog" aria-expanded={target !== null}
      onClick={event => {
        event.stopPropagation();
        setTarget(event.currentTarget.closest<HTMLElement>(".admin-prototype") ?? document.body);
      }}>{label}</button>
    {target && <FlowPromptDialog key={stage} stage={stage} target={target} onClose={close} />}
  </>;
}

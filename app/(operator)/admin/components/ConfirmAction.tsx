"use client";

import { useEffect, useId, useRef, useState } from "react";
import { resultError } from "./Toast";

/**
 * 되돌리기 번거로운 일 앞의 확인 창(2026-10-08 UX 감사 ADM-06) — 내리기·차단·저장소 내리기·일괄 결정·기본값 되돌리기·발행 보호 끄기.
 *
 * 대상 이름을 한 번 훑게 하고(targets, 수와 함께), 무엇이 바뀌는지 보여 주고(summary — 결정 요약·바뀔 값 diff·영향),
 * 필요하면 사유 선택(reasons, 필수)과 메모(note)를 받는다. window.confirm 은 쓰지 않는다.
 *
 * 여는 법은 둘이다.
 * - 버튼 하나: trigger 에 버튼을 그려 넘긴다 — 창이 스스로 열고 닫는다.
 *     <ConfirmAction title="“auto-claude-skills”를 차단합니다" confirmLabel="차단"
 *       reasons={{ label: "차단 사유", options: BAN_REASONS }}
 *       onConfirm={({ reason }) => banProduct(slug, reason)}
 *       trigger={(open) => <button type="button" onClick={open}>차단</button>} />
 * - 일괄 도구줄·단축키: open/onOpenChange 로 바깥에서 연다(고른 대상은 바깥 상태에 둔다).
 *     <ConfirmAction open={picked !== null} onOpenChange={(open) => !open && setPicked(null)}
 *       title={`${picked?.length}건을 거부합니다`} targets={names(picked ?? [])} confirmLabel="거부" onConfirm={...} />
 *
 * onConfirm 이 끝날 때까지 버튼은 "처리 중…"으로 막힌다. 돌려준 값이 실패면(문자열, {error}, {issues} — resultError 규칙)
 * 창을 열어 둔 채 사유를 보이고, 아니면 닫는다. 결과를 바깥 상태(useActionState)로 받는 화면은 onConfirm 에서
 * startTransition 으로 액션만 띄우고 바로 끝내면 된다 — 그때는 곧장 닫힌다.
 *
 * 키보드: 열리면 첫 입력(사유·메모), 없으면 확인 버튼에 포커스가 간다 — Enter 가 곧 확인이다. Esc 는 닫는다(처리 중에는 막는다).
 * 창 밖은 모달(showModal)이라 포커스가 갇히고, 닫히면 연 자리로 돌아간다. 창 안의 키는 화면 단축키로 새지 않는다.
 * <form> 을 쓰지 않으므로 다른 form 안에 둬도 된다(중첩 form 이 되지 않는다).
 */

export type ConfirmValues = { reason?: string; note?: string };

export type ConfirmActionProps = {
  title: string;
  /** 대상 이름 — 수를 붙여 스크롤 목록으로 보인다 */
  targets?: readonly string[];
  /** 결정 요약·바뀔 값(이전→이후)·영향 목록 */
  summary?: React.ReactNode;
  confirmLabel: string;
  /** danger(빨강, 기본): 내리기·차단처럼 되돌리기 번거로운 일 · neutral(파랑): 그 밖 */
  tone?: "danger" | "neutral";
  /** 있으면 사유를 꼭 골라야 확인된다 */
  reasons?: { label: string; options: readonly { value: string; label: string }[] };
  /** 자유 메모. 기본은 필수, optional 이면 비워도 된다 */
  note?: { label: string; placeholder?: string; optional?: boolean; maxLength?: number };
  onConfirm: (values: ConfirmValues) => unknown;
  /** 바깥에서 열 때 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 버튼 하나로 열 때 — 받은 open 을 버튼의 onClick 에 단다 */
  trigger?: (open: () => void) => React.ReactNode;
};

export function ConfirmAction({ title, targets, summary, confirmLabel, tone = "danger", reasons, note, onConfirm, open, onOpenChange, trigger }: ConfirmActionProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const isOpen = open ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (open === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const id = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      // showModal 은 첫 버튼(취소)에 포커스를 준다 — 첫 입력, 없으면 확인 버튼으로 옮긴다
      dialog.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    } else if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  return (
    <>
      {trigger?.(() => setOpen(true))}
      <dialog ref={dialogRef} className="admin-confirm" data-tone={tone} aria-labelledby={`${id}-title`}
        aria-describedby={summary ? `${id}-summary` : undefined}
        // 창 안의 키는 화면 단축키(J/K/X 등)로 새지 않게 한다. Esc 는 닫는다 — 처리 중에는 결과를 잃으므로 막는다
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); if (!pending) setOpen(false); }
        }}
        onCancel={(event) => event.preventDefault()}
        onClose={() => {
          // 브라우저가 스스로 닫은 경우에도 바깥 상태를 맞춘다
          if (isOpen) setOpen(false);
          if (returnTo.current?.isConnected) returnTo.current.focus();
        }}>
        {isOpen && <ConfirmBody id={id} title={title} targets={targets} summary={summary} confirmLabel={confirmLabel} tone={tone}
          reasons={reasons} note={note} onConfirm={onConfirm} pending={pending} setPending={setPending} onClose={() => setOpen(false)} />}
      </dialog>
    </>
  );
}

/** 창 안 — 열 때마다 새로 그려 사유·메모·오류가 지난번 값을 들고 있지 않다 */
function ConfirmBody({ id, title, targets, summary, confirmLabel, tone, reasons, note, onConfirm, pending, setPending, onClose }:
  Omit<ConfirmActionProps, "open" | "onOpenChange" | "trigger"> & {
    id: string; pending: boolean; setPending: (pending: boolean) => void; onClose: () => void;
  }) {
  const [reason, setReason] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLSelectElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const needsNote = note !== undefined && !note.optional;

  async function confirm() {
    if (reasons && !reason) { setError(`${reasons.label} — 하나를 골라 주세요`); reasonRef.current?.focus(); return; }
    if (needsNote && !text.trim()) { setError(`${note.label} — 적어 주세요`); noteRef.current?.focus(); return; }
    setError(null);
    setPending(true);
    try {
      const failure = resultError(await onConfirm({ reason: reasons ? reason : undefined, note: note ? text.trim() : undefined }));
      if (failure) setError(failure);
      else onClose();
    } catch {
      setError("처리하지 못했습니다 — 잠시 뒤 다시 해 주세요");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="admin-confirm-body">
      <h2 id={`${id}-title`}>{title}</h2>
      {targets && targets.length > 0 && <>
        <p className="admin-confirm-count">대상 {targets.length.toLocaleString("ko-KR")}건</p>
        <ul className="admin-confirm-targets" aria-label={`대상 ${targets.length}건`} tabIndex={0}>
          {targets.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}
        </ul>
      </>}
      {summary && <div id={`${id}-summary`}>{summary}</div>}
      {reasons && <label>{reasons.label}
        <select ref={reasonRef} value={reason} onChange={(event) => setReason(event.target.value)} required
          aria-invalid={error !== null && !reason} data-initial-focus>
          <option value="">고르세요</option>
          {reasons.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>}
      {note && <label>{note.label}{note.optional && <span className="text-fg-3"> (선택)</span>}
        <textarea ref={noteRef} value={text} onChange={(event) => setText(event.target.value)} rows={2} maxLength={note.maxLength ?? 1000}
          placeholder={note.placeholder} required={needsNote} aria-invalid={error !== null && needsNote && !text.trim()}
          data-initial-focus={reasons ? undefined : true} />
      </label>}
      {error && <p className="admin-confirm-error" role="alert">{error}</p>}
      <div className="admin-confirm-actions">
        <button type="button" className="admin-button" onClick={onClose} disabled={pending}>취소</button>
        <button type="button" className="admin-button" data-tone={tone === "danger" ? "danger" : "primary"} disabled={pending}
          onClick={() => void confirm()} data-initial-focus={reasons || note ? undefined : true}>
          {pending ? "처리 중…" : confirmLabel}
        </button>
      </div>
    </div>
  );
}

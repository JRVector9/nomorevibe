"use client";
import { useActionState, useState } from "react";
import { contactLabels, type contactStates, type reviewStates } from "@/lib/operations/admin-requests-contract";
import { createContactAction, updateContactAction } from "./actions";
import { reviewMakerReplyAction } from "../maker-replies/actions";

type Csrf = { csrfToken: string; expiresAt: number };
function CsrfFields({ csrfToken, expiresAt }: Csrf) {
  return <><input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="csrfExpiresAt" value={expiresAt} /></>;
}
function Result({ state, pending }: { state: { ok?: true; error?: string } | null; pending: boolean }) {
  return <p role="status" className="text-sm">{pending ? "처리 중입니다." : state?.error ?? (state?.ok ? "반영했습니다." : "")}</p>;
}
const field = "mt-1 block w-full rounded-lg border border-line p-3";
// React는 commit 중 이벤트 처리를 멈추고 form.reset()을 부른다. native reset을 막아
// controlled select도 오류 후 DOM 값이 초기값으로 돌아가지 않게 한다. 성공한 접수는 draft를 직접 비운다.
function preserveFormInputs(form: HTMLFormElement | null) {
  if (!form) return;
  const preventReset = (event: Event) => event.preventDefault();
  form.addEventListener("reset", preventReset);
  return () => form.removeEventListener("reset", preventReset);
}
const button = "min-h-11 rounded-lg border border-line px-4 text-sm disabled:opacity-50";
export function ContactCreateForm(props: Csrf) {
  const empty = { senderEmail: "", receivedAt: "", subject: "", body: "" };
  const [draft, setDraft] = useState(empty);
  const [state, action, pending] = useActionState(async (previous: { ok?: true; error?: string } | null, form: FormData) => {
    const result = await createContactAction(previous, form);
    if (result?.ok) setDraft(empty);
    return result;
  }, null);
  return <form action={action} ref={preserveFormInputs} data-dirty={Object.values(draft).some(Boolean) || undefined} className="space-y-3"><CsrfFields {...props} />
    <label className="block">보낸 사람 이메일<input required disabled={pending} type="email" name="senderEmail" value={draft.senderEmail} onChange={event => setDraft({ ...draft, senderEmail: event.target.value })} maxLength={254} className={field} /></label>
    <label className="block">수신 시각 (UTC)<input required disabled={pending} type="datetime-local" name="receivedAt" value={draft.receivedAt} onChange={event => setDraft({ ...draft, receivedAt: event.target.value })} className={field} /></label>
    <label className="block">제목<input required disabled={pending} name="subject" value={draft.subject} onChange={event => setDraft({ ...draft, subject: event.target.value })} maxLength={200} className={field} /></label>
    <label className="block">문의 내용<textarea required disabled={pending} name="body" value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })} maxLength={10000} rows={5} className={field} /></label>
    <button disabled={pending} className={button}>수동 접수</button><Result state={state} pending={pending} />
  </form>;
}
export function ContactUpdateForm(props: Csrf & { id: string; version: number; status: typeof contactStates[number]; handlingNote: string }) {
  const [status, setStatus] = useState(props.status);
  const [handlingNote, setHandlingNote] = useState(props.handlingNote);
  const [state, action, pending] = useActionState(updateContactAction, null);
  return <form action={action} ref={preserveFormInputs} data-dirty={status !== props.status || handlingNote !== props.handlingNote || undefined} className="space-y-3"><CsrfFields {...props} />
    <input type="hidden" name="id" value={props.id} /><input type="hidden" name="version" value={props.version} />
    <label className="block">처리 상태<select disabled={pending} name="status" value={status} onChange={event => setStatus(event.target.value as typeof status)} className={field}>
      {Object.entries(contactLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <label className="block">처리 메모 (마지막 메모를 교체합니다)<textarea required disabled={pending} name="handlingNote" value={handlingNote} onChange={event => setHandlingNote(event.target.value)} maxLength={2000} rows={3} className={field} /></label>
    <button disabled={pending} className={button}>처리 저장</button><Result state={state} pending={pending} />
  </form>;
}
export function MakerReplyReviewForm(props: Csrf & { id: string; version: number; reviewState: typeof reviewStates[number] }) {
  const [state, action, pending] = useActionState(reviewMakerReplyAction, null);
  return <form action={action} className="space-y-3"><CsrfFields {...props} />
    <input type="hidden" name="id" value={props.id} /><input type="hidden" name="version" value={props.version} /><input type="hidden" name="expectedState" value={props.reviewState} />
    <div className="flex gap-3">{props.reviewState !== "accepted" && <button disabled={pending} name="decision" value="accepted" className={button}>공개 승인·복원</button>}
      {props.reviewState !== "rejected" && <button disabled={pending} name="decision" value="rejected" className={button}>공개 거절·숨김</button>}</div>
    <Result state={state} pending={pending} />
  </form>;
}

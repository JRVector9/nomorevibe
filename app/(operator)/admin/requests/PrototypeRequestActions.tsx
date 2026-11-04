"use client";

import { useActionState, useRef, useState } from "react";
import type { IntroRequestEntry, TakedownEntry } from "@/lib/domain/products/takedown-view";
import { DISMISS_REASONS } from "@/lib/domain/products/takedown-view";
import { LIMITS } from "@/lib/domain/products/limits";
import { resolveTakedownRequest, type ReviewState } from "../actions";
import { fixIntroRequest, resolveIntroRequestAction, type AuditActionState } from "../audit/actions";
import { ConfirmAction } from "../components/ConfirmAction";
import { resultError, useAdminToast } from "../components/Toast";

export function PrototypeTakedownAction({ entry }: { entry: { slug: TakedownEntry["slug"]; product: { name: string } | null } }) {
  const [state, action, pending] = useActionState<ReviewState, FormData>(resolveTakedownRequest, null);
  const [confirming, setConfirming] = useState(false), [dirty, setDirty] = useState(false);
  const formRef = useRef<HTMLFormElement>(null), toast = useAdminToast();
  return <form ref={formRef} action={action} className="stack" data-dirty={dirty || undefined} onChange={() => setDirty(true)}>
    <input type="hidden" name="slug" value={entry.slug} /><div className="field"><label>처리 메모·사유<textarea name="note" maxLength={1000} rows={3} placeholder="처리 근거와 다음 행동을 기록해 주세요." /></label></div>
    <div className="field"><label>유지 사유<select name="dismissReason" defaultValue="test_spam">{Object.entries(DISMISS_REASONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <div className="decision-bar"><button className="button primary" type="button" disabled={!entry.product || pending} onClick={() => setConfirming(true)}>공개 중단</button><button className="button" name="action" value="dismiss" disabled={pending}>유지·사유 기록</button></div>
    <ConfirmAction open={confirming} onOpenChange={setConfirming} title={`“${entry.product?.name ?? entry.slug}”을 내립니다`} confirmLabel="공개 중단" summary={<ul><li>공개 목록과 상세에서 사라집니다.</li><li>같은 주소의 재수집·등록이 차단됩니다.</li><li>되돌리려면 프로젝트 관리에서 해제해야 합니다.</li></ul>} onConfirm={async () => {
      const form = new FormData(formRef.current ?? undefined); form.set("action", "remove");
      const result = await resolveTakedownRequest(null, form), error = resultError(result); if (error) return { error };
      toast.show({ message: `${entry.product?.name ?? entry.slug} 공개를 중단했습니다.`, link: { label: "기록 보기", href: `/admin/activity?target=${encodeURIComponent(entry.slug)}` } }); return null;
    }} />{state && <p className={state.error ? "error" : "small"} role="status">{state.error ?? "처리했습니다."}</p>}
  </form>;
}

export function PrototypeIntroAction({ entry }: { entry: { id: IntroRequestEntry["id"]; slug: string; product: { name: string; tagline: string; status: string } | null } }) {
  const [fixState, fixAction, fixing] = useActionState<AuditActionState, FormData>(fixIntroRequest, null);
  const [doneState, doneAction, closing] = useActionState<AuditActionState, FormData>(resolveIntroRequestAction, null);
  const [dirty, setDirty] = useState(false), product = entry.product;
  const editable = product !== null && ["seeded", "verified"].includes(product.status);
  return <div className="stack" data-dirty={dirty || undefined}>
    <div className="field"><label>현재 소개</label><div className="evidence-box">{product?.tagline ?? "프로젝트 —"}</div></div>
    {editable && <form action={fixAction} onChange={() => setDirty(true)}><input type="hidden" name="id" value={entry.id} /><input type="hidden" name="slug" value={entry.slug} /><div className="field"><label>수정할 소개<input name="tagline" defaultValue={product.tagline} required maxLength={LIMITS.tagline} /></label></div><div className="decision-bar"><button className="button primary" disabled={fixing || closing}>소개 수정 반영</button></div></form>}
    <form action={doneAction} onChange={() => setDirty(true)}><input type="hidden" name="id" value={entry.id} /><input type="hidden" name="slug" value={entry.slug} /><div className="field"><label>처리 메모·사유<textarea name="note" maxLength={1000} rows={2} /></label></div><div className="decision-bar"><button className="button" name="outcome" value="fixed" disabled={fixing || closing}>확인·처리 완료</button><button className="button" name="outcome" value="dismissed" disabled={fixing || closing}>기존 유지</button></div></form>
    {[fixState, doneState].map((state, index) => state && <p key={index} role="status" className={state.error ? "error" : "small"}>{state.error ?? "처리했습니다."}</p>)}
  </div>;
}

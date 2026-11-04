"use client";
import { startTransition, useActionState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmAction } from "../components/ConfirmAction";
import { decideAuditFinding } from "../audit/actions";
import { resolvePublishedSecondReview } from "../review/actions";

/** Uses the original per-item actions; IDs and source-state validation remain on the server. */
export function PrototypeQualityDecision({ kind, id, slug, name }: { kind:"audit"|"published";id:number;slug:string;name:string }) {
  const router=useRouter();
  const [state,action,pending]=useActionState(async(previous:Awaited<ReturnType<typeof decideAuditFinding>>,form:FormData)=>{
    const result=await (kind==="audit"?decideAuditFinding:resolvePublishedSecondReview)(previous,form);
    if(result?.message)router.refresh();return result;
  },null);
  return <form action={action}><input type="hidden" name={kind==="audit"?"item":"id"} value={id}/><input type="hidden" name="slug" value={slug}/>{kind==="audit"&&<input name="note" maxLength={500} placeholder="유지 사유 (선택)" aria-label={`${name} 유지 사유`}/>}
    <div className="flex"><button type="submit" className="button small" name="decision" value="keep" disabled={pending}>유지</button><ConfirmAction title={`“${name}”을(를) 공개 목록에서 내립니다`} targets={[name]} confirmLabel="내림" summary={<p>행은 남아 재수집을 막습니다. 원본 처리 상태가 바뀌면 서버가 거절합니다.</p>} trigger={open=><button type="button" className="button small danger" onClick={open} disabled={pending}>내림</button>} onConfirm={()=>{const values=new FormData();values.set(kind==="audit"?"item":"id",String(id));values.set("slug",slug);values.set("decision",kind==="audit"?"remove":"ban");startTransition(()=>action(values));}}/></div><p className="small muted" role="status">{state?.error??state?.message}</p></form>;
}

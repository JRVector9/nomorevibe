"use client";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { markClaimInvite } from "../actions";
import { editIntroAction } from "./actions";
import { LIMITS } from "@/lib/domain/products/limits";

export function PrototypeIntroForm({ slug, tagline }: { slug: string; tagline: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(async (previous: Awaited<ReturnType<typeof editIntroAction>>, form: FormData) => { const result=await editIntroAction(previous,form);if(result?.ok)router.refresh();return result; }, null);
  return <form action={action}><input type="hidden" name="slug" value={slug} /><div className="field"><label htmlFor="project-intro">소개 편집</label><textarea id="project-intro" name="tagline" defaultValue={tagline} required maxLength={LIMITS.tagline} /><p>소개 확인이 필요한 현재 원문에 적용합니다. 원문이나 처리 상태가 바뀌면 기존 서버 검사가 거절합니다.</p></div><div className="save-bar"><p role="status">{state?.error ?? state?.message ?? "변경 전·후는 작업 기록에 남습니다."}</p><button className="button primary" disabled={pending} type="submit">{pending ? "확인 중" : "소개 변경 저장"}</button></div></form>;
}
export function PrototypeClaimInvite({ slug, inviteUrl, invitedAt }: { slug: string; inviteUrl: string | null; invitedAt: string | null }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(async (previous: Awaited<ReturnType<typeof markClaimInvite>>, form: FormData) => { const result=await markClaimInvite(previous,form);if(!result?.error)router.refresh();return result; }, null);
  if (!inviteUrl) return <p className="small muted">클레임 초대가 가능한 공개 저장소·사이트 주소가 확인되지 않았습니다.</p>;
  return <div><p className="small muted">미리 채운 GitHub 이슈를 직접 확인·제출한 뒤 보냈음으로 표시합니다.</p><div className="decision-bar"><a className="button" href={inviteUrl} target="_blank" rel="noopener noreferrer">클레임 초대 미리보기 ↗</a><form action={action}><input type="hidden" name="slug" value={slug} /><button className="button" disabled={pending || !!invitedAt}>보냈음으로 표시</button></form></div><p role="status" className="small muted">{state?.error ?? (invitedAt ? `초대 기록 ${invitedAt}` : "아직 보냈음으로 기록되지 않았습니다.")}</p></div>;
}

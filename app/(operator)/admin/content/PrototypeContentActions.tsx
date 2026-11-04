"use client";
import { useActionState } from "react";
import { decideTalkHome, decideTalkPosts } from "../talk/actions";
import { decideNews } from "../news/actions";

export function PrototypeContentActions({ id, kind, state }: { id: number; kind: "social" | "news"; state: string }) {
  const [result, action, pending] = useActionState(kind === "news" ? decideNews : decideTalkPosts, null);
  return <form action={action}><input type="hidden" name="id" value={id} /><div className="decision-bar"><button type="submit" className="button primary" name="decision" value={kind === "news" ? "approved" : "visible"} disabled={pending || state === (kind === "news" ? "approved" : "visible")}>{kind === "news" ? "게시 승인" : "노출·복원"}</button><button type="submit" className="button" name="decision" value="hidden" disabled={pending || state === "hidden"}>숨김</button></div><p className="small muted" role="status">{result?.error ?? result?.ok}</p></form>;
}
export function PrototypeHomeDecision({ repository }: { repository: string }) {
  const [result, action, pending] = useActionState(decideTalkHome, null);
  return <form action={action}><input type="hidden" name="repository" value={repository} /><div className="decision-bar"><button className="button" name="decision" value="approved" disabled={pending}>홈 1위 허용</button><button className="button" name="decision" value="talk_only" disabled={pending}>화제에만 표시</button><button className="button" name="decision" value="clear" disabled={pending}>결정 해제</button></div><p role="status" className="small muted">{result?.error ?? result?.ok ?? "허용과 실제 홈 순위는 구분합니다. 공개 목록의 원래 순위 조건을 적용합니다."}</p></form>;
}

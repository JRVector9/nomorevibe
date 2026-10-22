import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { adminRequestToken } from "@/lib/operations/admin-requests-csrf";
import { reviewStates } from "@/lib/operations/admin-requests-contract";
import { makerReplyQueue } from "@/lib/operations/maker-reply-review";
import { PageStamp } from "../components/PageStamp";
import { MakerReplyReviewForm } from "../requests/RequestForms";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "메이커 답장 검수 — NoMoreVibe", robots: { index: false, follow: false } };
const labels = { held: "보류", accepted: "공개", rejected: "거절·숨김", all: "전체" };
export default async function MakerRepliesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const admin = await currentAdmin(); if (!admin) redirect("/admin/login");
  const secret = authSecret(); if (!secret) throw new Error("admin_auth_unconfigured");
  const params = await searchParams;
  const state = typeof params.state === "string" && (["all", ...reviewStates] as string[]).includes(params.state) ? params.state as typeof reviewStates[number] | "all" : "held";
  const rawOffset = typeof params.offset === "string" ? Number(params.offset) : 0;
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? Math.min(rawOffset, 100000) : 0;
  const queue = await makerReplyQueue({ state, offset });
  const csrf = { csrfToken: adminRequestToken("maker-replies", admin, secret), expiresAt: admin.exp };
  return <main className="space-y-5 p-5"><PageStamp /><h1 className="text-[22px] font-semibold">메이커 답장 검수</h1>
    <p>보류한 답장을 공개 승인하거나 숨깁니다. 공개 답장도 숨김·복원할 수 있습니다. 작성자나 다른 관리자가 바꾸면 새로고침 후 다시 검토하세요.</p>
    <form action="/admin/maker-replies" className="flex gap-3"><label>상태 <select name="state" defaultValue={state} className="min-h-11 rounded-lg border border-line px-3">
      {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="min-h-11 rounded-lg border border-line px-4">조회</button></form>
    <p>답장 {queue.count.toLocaleString("ko-KR")}건 · 오래된 것부터</p>
    {queue.items.map(({ reply, slug, productName, authorName, targetBody }) => <section key={`${reply.id}-${reply.reviewVersion}`} className="space-y-3 rounded-xl border border-line p-4">
      <Link prefetch={false} href={`/p/${slug}`} className="underline">{productName}</Link>
      <p className="whitespace-pre-wrap break-words text-sm text-fg-2">원문: {targetBody ?? "원문이 삭제되었거나 공개되지 않습니다."}</p>
      <p className="whitespace-pre-wrap break-words">{reply.body}</p><p className="text-sm">작성자 {authorName} · {labels[reply.reviewState]} · 수정 {reply.updatedAt.toISOString()}</p>
      <MakerReplyReviewForm {...csrf} id={reply.id} version={reply.reviewVersion} reviewState={reply.reviewState} />
    </section>)}
    {!queue.items.length && <p>조건에 맞는 답장이 없습니다.</p>}
    {queue.nextOffset !== null && <Link prefetch={false} href={`/admin/maker-replies?state=${state}&offset=${queue.nextOffset}`} className="underline">다음 답장</Link>}
  </main>;
}

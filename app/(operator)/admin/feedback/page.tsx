import { createHmac } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { feedbackAdminQueue } from "@/lib/domain/feedback/repository";
import type { FeedbackReviewState } from "@/lib/domain/feedback/contract";
import { FeedbackItem } from "@/components/product-detail/FeedbackList";
import { FeedbackReviewForm } from "./FeedbackReviewForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "피드백 검수 — NoMoreVibe", robots: { index: false } };

const STATES = { held: "보류", accepted: "공개", rejected: "거절·숨김", all: "전체" };

export default async function AdminFeedbackPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const secret = authSecret();
  if (!secret) throw new Error("admin_auth_unconfigured");
  const csrfToken = createHmac("sha256", secret).update(`feedback-admin:${admin.login}:${admin.exp}`).digest("hex");
  const params = await searchParams;
  const state = typeof params.state === "string" && Object.hasOwn(STATES, params.state) ? params.state as FeedbackReviewState | "all" : "held";
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 120) : "";
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
  const queue = await feedbackAdminQueue({ state, q, cursor });
  const next = new URLSearchParams({ state, q });
  if (queue.nextCursor) next.set("cursor", queue.nextCursor);
  return <main className="space-y-5 p-5">
    <h1 className="text-[22px] font-semibold">피드백 검수</h1>
    <p className="text-[14px] text-fg-2">원문을 확인하고 공개 승인·숨김·복원을 선택하세요. 처리자·사유·시각이 기록됩니다. 오래된 댓글부터 표시합니다.</p>
    <form className="flex flex-wrap gap-3" action="/admin/feedback">
      <label className="text-[14px]">상태<select name="state" defaultValue={state} className="ml-2 min-h-11 rounded-lg border border-line px-3">{Object.entries(STATES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="text-[14px]">찾기<input name="q" defaultValue={q} maxLength={120} placeholder="댓글 ID·제품·제목" className="ml-2 min-h-11 rounded-lg border border-line px-3" /></label>
      <button className="min-h-11 rounded-lg border border-line px-4 text-[14px]">조회</button>
    </form>
    <p className="text-[14px] text-fg-2">조건에 맞는 댓글 {queue.count.toLocaleString("ko-KR")}건</p>
    <p className="text-[13px] leading-6 text-fg-2">숨김은 사이트 공개만 중단합니다. 아직 보내지 않은 GitHub 전송은 취소하지만 전송 중·결과 확인 필요·이미 전송된 외부 이슈는 남을 수 있습니다. 공개 복원은 GitHub에 다시 보내지 않습니다.</p>
    {queue.items.length === 0 && <p className="text-[14px]">조건에 맞는 피드백이 없습니다.</p>}
    {queue.items.map((item) => <section key={`${item.id}-${item.reviewState}`} className="space-y-3 rounded-xl border border-line p-4">
      <Link prefetch={false} href={`/p/${item.slug}`} className="text-[14px] underline">{item.productName}</Link>
      <FeedbackItem feedback={item} />
      <p className="break-all text-[13px] text-fg-3">댓글 {item.id} · 작성자 #{item.authorUserId}</p>
      <FeedbackReviewForm id={item.id} reviewState={item.reviewState} csrfToken={csrfToken} expiresAt={admin.exp} />
    </section>)}
    {queue.nextCursor && <Link prefetch={false} href={`/admin/feedback?${next}`} className="inline-block min-h-11 py-3 text-[14px] underline">다음 댓글</Link>}
  </main>;
}

import { createHmac } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { feedbackReviewQueue } from "@/lib/domain/feedback/repository";
import { FeedbackItem } from "@/components/product-detail/FeedbackList";
import { reviewFeedbackAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "피드백 검수 — NoMoreVibe", robots: { index: false } };

export default async function AdminFeedbackPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const secret = authSecret();
  if (!secret) throw new Error("admin_auth_unconfigured");
  const csrfToken = createHmac("sha256", secret).update(`feedback-admin:${admin.login}:${admin.exp}`).digest("hex");
  const feedback = await feedbackReviewQueue();
  return <main className="space-y-5 p-5">
    <h1 className="text-[22px] font-semibold">피드백 검수</h1>
    <p className="text-[14px] text-fg-2">보류된 원문을 확인하고 공개 승인 또는 거절을 선택하세요. 처리자·사유·시각이 기록됩니다.</p>
    {feedback.length === 0 && <p className="text-[14px]">검토할 피드백이 없습니다.</p>}
    {feedback.map((item) => <section key={item.id} className="space-y-3 rounded-xl border border-line p-4">
      <Link prefetch={false} href={`/p/${item.slug}`} className="text-[14px] underline">{item.productName}</Link>
      <FeedbackItem feedback={item} />
      <form action={reviewFeedbackAction} className="space-y-3">
        <input type="hidden" name="id" value={item.id} /><input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="csrfExpiresAt" value={admin.exp} />
        <label className="block text-[14px]">검토 사유<input required name="reason" maxLength={1000} className="mt-1 block w-full rounded-lg border border-line p-3" /></label>
        <div className="flex gap-2">
          <button type="submit" name="decision" value="accepted" className="min-h-11 rounded-lg bg-accent-solid px-4 text-[14px] text-white">공개 승인</button>
          <button type="submit" name="decision" value="rejected" className="min-h-11 rounded-lg border border-line px-4 text-[14px]">공개 거절</button>
        </div>
      </form>
    </section>)}
  </main>;
}

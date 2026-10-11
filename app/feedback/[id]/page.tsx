import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { getPublicSession } from "@/lib/domain/accounts/request-auth";
import { getFeedback } from "@/lib/domain/feedback/repository";
import { FeedbackItem } from "@/components/product-detail/FeedbackList";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "제품 피드백 — NoMoreVibe", robots: { index: false, follow: false } };

export default async function FeedbackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [session, admin] = await Promise.all([getPublicSession(), currentAdmin()]);
  const feedback = await getFeedback(id, { userId: session?.user.id, admin: Boolean(admin) });
  if (!feedback) notFound();
  return <main className="mx-auto max-w-3xl space-y-5 px-5 py-10">
    <Link prefetch={false} href={`/p/${feedback.slug}`} className="text-[14px] underline underline-offset-2">{feedback.productName} 제품으로 돌아가기</Link>
    <h1 className="text-[22px] font-semibold">제품 피드백 원문</h1>
    <FeedbackItem feedback={feedback} />
  </main>;
}

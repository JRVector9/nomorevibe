import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { listCandidates } from "@/lib/crawl/repository";
import { REVIEW_REJECT_REASONS } from "@/lib/crawl/review";
import { ReviewItem } from "./ReviewItem";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "심사 큐 — NoMoreVibe", robots: { index: false } };

/** 한 화면에 올리는 수. 밀리면 기준을 고칠 때이지 목록을 늘릴 때가 아니다 */
const PAGE_SIZE = 50;

export default async function ReviewPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const candidates = await listCandidates(["needs_review"], PAGE_SIZE);

  return (
    <main className="mx-auto max-w-[900px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">심사 큐</h1>
        <span className="text-[12.5px] text-fg-3">{candidates.length}건</span>
        <Link href="/admin" className="ml-auto text-[12.5px] font-semibold text-fg-2 hover:text-fg">
          크롤 설정
        </Link>
      </div>

      <p className="mt-2 max-w-[68ch] text-[13.5px] leading-[1.7] text-fg-2">
        규칙이 가르지 못한 것만 여기로 옵니다. 발행 대상으로 넘기면 다음 발행 틱이 목록에 올리고,
        거부하면 사유가 함께 남아 규칙을 고칠 근거가 됩니다.
      </p>

      {candidates.length === 0 ? (
        <p className="mt-8 rounded-[14px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">
          심사할 후보가 없습니다.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {candidates.map((candidate) => (
            <ReviewItem key={candidate.repo} candidate={candidate} reasons={REVIEW_REJECT_REASONS} />
          ))}
        </ul>
      )}
    </main>
  );
}

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { listCandidates } from "@/lib/crawl/repository";
import { REVIEW_REJECT_REASONS } from "@/lib/crawl/review";
import { pendingTakedowns } from "@/lib/domain/products/takedown";
import { ReviewItem } from "./ReviewItem";
import { TakedownItem } from "./TakedownItem";
import { AdminNav } from "../AdminNav";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "심사 큐 — NoMoreVibe", robots: { index: false } };

/** 한 화면에 올리는 수. 밀리면 기준을 고칠 때이지 목록을 늘릴 때가 아니다 */
const PAGE_SIZE = 50;

export default async function ReviewPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const [candidates, takedowns] = await Promise.all([
    listCandidates(["needs_review"], PAGE_SIZE),
    pendingTakedowns(),
  ]);

  return (
    <main className="mx-auto max-w-[900px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">심사 큐</h1>
        <span className="text-[13px] text-fg-3">{candidates.length}건</span>
        <div className="ml-auto">
          <AdminNav current="/admin/review" />
        </div>
      </div>

      <p className="mt-2 max-w-[68ch] text-[13.5px] leading-[1.7] text-fg-2">
        규칙이 가르지 못한 것만 여기로 옵니다. 발행 대상으로 넘기면 다음 발행 틱이 목록에 올리고,
        거부하면 사유가 함께 남아 규칙을 고칠 근거가 됩니다.
      </p>

      {takedowns.length > 0 && (
        <section className="mt-6">
          <h2 className="text-[15px] font-bold">
            내려달라는 요청 <span className="ml-1 text-[13px] font-semibold text-down">{takedowns.length}</span>
          </h2>
          <p className="mt-1.5 max-w-[68ch] text-[13px] leading-[1.7] text-fg-2">
            우리가 대신 올린 제품의 주인이 내려달라고 한 것입니다. 먼저 처리합니다. 내리면 행은 남고
            차단 상태가 되어 수집기가 같은 URL을 다시 주워 오지 않습니다.
          </p>
          <ul className="mt-4 flex flex-col gap-3">
            {takedowns.map((request) => (
              <TakedownItem
                key={request.slug}
                slug={request.slug}
                reason={request.reason}
                requestedAt={request.requestedAt.toLocaleString("ko-KR", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              />
            ))}
          </ul>
        </section>
      )}

      {candidates.length === 0 ? (
        <p className="mt-8 rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">
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

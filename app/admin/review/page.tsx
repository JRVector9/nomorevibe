import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { listAdminReviewEntries } from "@/lib/crawl/admin-review";
import { getSettings } from "@/lib/crawl/settings";
import { REVIEW_REJECT_REASONS } from "@/lib/crawl/review";
import { pendingTakedowns } from "@/lib/domain/products/takedown";
import { ReviewItem } from "./ReviewItem";
import { TakedownItem } from "./TakedownItem";
import { ReviewModeForm } from "./ReviewModeForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "심사 큐 — NoMoreVibe", robots: { index: false } };

/** 한 화면에 올리는 수. 밀리면 기준을 고칠 때이지 목록을 늘릴 때가 아니다 */
const PAGE_SIZE = 50;

export default async function ReviewPage({ searchParams }: {
  searchParams: Promise<{ state?: string | string[]; after?: string | string[] }>;
}) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const params = await searchParams;
  const state = params.state === 'needs_review' || params.state === 'rejected' || params.state === 'published' ? params.state : 'pending';
  const rawAfter = Number(params.after ?? 0);
  const after = Number.isSafeInteger(rawAfter) && rawAfter > 0 ? rawAfter : 0;
  const [settings, takedowns] = await Promise.all([
    getSettings(),
    pendingTakedowns(),
  ]);
  const { entries, nextAfter } = await listAdminReviewEntries(settings, { state, after, limit: PAGE_SIZE });

  return (
    <main className="mx-auto max-w-[900px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">심사 큐</h1>
        <span className="text-[13px] text-fg-3">현재 페이지 {entries.length}건</span>

      </div>

      <p className="mt-2 max-w-[68ch] text-[13.5px] leading-[1.7] text-fg-2">
        규칙과 AI 심사 결과, 현재 근거를 확인합니다. 승인된 후보도 최종 발행 조건을 통과해야 목록에 올라갑니다.
        관리자 판단과 추가 수집에는 사유가 기록됩니다.
      </p>

      <ReviewModeForm key={settings.reviewMode} mode={settings.reviewMode} ready={process.env.CRAWL_REVIEW_READY === 'true'} />

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

      <nav aria-label="심사 상태 필터" className="mt-6 flex flex-wrap gap-2 text-[13px]">
        {([['pending', '진행 중'], ['needs_review', '보류'], ['rejected', '거부'], ['published', '발행 완료']] as const).map(([value, label]) => (
          <Link key={value} href={`/admin/review?state=${value}`} aria-current={state === value ? 'page' : undefined}
            className={`rounded-lg border px-3 py-2 ${state === value ? 'border-accent text-accent' : 'border-line text-fg-2'}`}>{label}</Link>
        ))}
        {after > 0 && <Link href={`/admin/review?state=${state}`} className="ml-auto py-2 text-fg-2">처음으로</Link>}
      </nav>

      {entries.length === 0 ? (
        <p className="mt-8 rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">
          심사할 후보가 없습니다.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {entries.map((entry) => (
            <ReviewItem key={`${entry.candidate.id}:${entry.candidateRevisionHash}:${entry.sourceRevisionHash}`} entry={entry} reasons={REVIEW_REJECT_REASONS} />
          ))}
        </ul>
      )}
      {nextAfter !== null && <Link href={`/admin/review?state=${state}&after=${nextAfter}`} className="mt-6 inline-block rounded-lg border border-line px-4 py-2 text-[13px] font-semibold">다음 {PAGE_SIZE}건</Link>}
    </main>
  );
}

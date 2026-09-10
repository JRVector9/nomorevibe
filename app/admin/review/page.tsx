import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { listAdminReviewEntries, reviewQueueCauses, REVIEW_QUEUE_SCAN_LIMIT } from "@/lib/crawl/admin-review";
import { getSettings } from "@/lib/crawl/settings";
import { REVIEW_REJECT_REASONS } from "@/lib/crawl/review";
import { pendingTakedowns } from "@/lib/domain/products/takedown";
import { ReviewItem } from "./ReviewItem";
import { TakedownItem } from "./TakedownItem";
import { ReviewModeForm } from "./ReviewModeForm";
import { BulkDecision } from "./BulkDecision";
import { RequeueResolved } from "./RequeueResolved";
import { CAUSE_GUIDE, type CauseKey } from "./causes";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "심사 큐 — NoMoreVibe", robots: { index: false } };

/** 한 화면에 올리는 수. 밀리면 기준을 고칠 때이지 목록을 늘릴 때가 아니다 */
const PAGE_SIZE = 50;
const BULK_FORM = "review-bulk";
const STATES = [['pending', '진행 중'], ['needs_review', '보류'], ['rejected', '거부'], ['published', '발행 완료']] as const;

export default async function ReviewPage({ searchParams }: {
  searchParams: Promise<{ state?: string | string[]; after?: string | string[]; cause?: string | string[] }>;
}) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const params = await searchParams;
  const state = params.state === 'needs_review' || params.state === 'rejected' || params.state === 'published' ? params.state : 'pending';
  const rawAfter = Number(params.after ?? 0);
  const after = Number.isSafeInteger(rawAfter) && rawAfter > 0 ? rawAfter : 0;
  const rawCause = typeof params.cause === 'string' ? params.cause : '';
  const cause = (rawCause in CAUSE_GUIDE ? rawCause : '') as CauseKey | '';

  const settings = await getSettings();
  const [takedowns, causes] = await Promise.all([pendingTakedowns(), reviewQueueCauses(settings)]);

  // 갈래는 규칙을 되짚어 얻은 값이라 SQL로 거를 수 없다 — 해당하는 id 만 넘긴다
  const ids = cause ? (causes.ids.get(cause) ?? []) : undefined;
  const { entries, nextAfter } = await listAdminReviewEntries(settings, {
    state: cause ? 'needs_review' : state, after, limit: PAGE_SIZE, ids,
  });
  const query = (next: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) if (value !== undefined && value !== '') search.set(key, String(value));
    return `/admin/review${search.size ? `?${search}` : ''}`;
  };

  return (
    <main className="mx-auto max-w-[1000px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">심사 큐</h1>
        <span className="text-[13px] text-fg-3">보류 {causes.total}건{causes.truncated && ` 이상 (${REVIEW_QUEUE_SCAN_LIMIT}건까지 셈)`} · 현재 페이지 {entries.length}건</span>
      </div>

      <p className="mt-2 max-w-[68ch] text-[13.5px] leading-[1.7] text-fg-2">
        저장된 사유는 전부 &ldquo;규칙으로 못 가름&rdquo;이라 목록만으로는 무엇을 정해야 하는지 알 수 없습니다.
        보관한 원본으로 규칙을 다시 태워 <b className="font-semibold">어디까지 통과했고 어디서 왜 멈췄는지</b>를
        보여줍니다. 같은 갈래는 판단도 같으므로 묶어서 처리할 수 있습니다.
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
              <TakedownItem key={request.slug} slug={request.slug} reason={request.reason}
                requestedAt={request.requestedAt.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })} />
            ))}
          </ul>
        </section>
      )}

      {causes.counts.length > 0 && (
        <section className="mt-7">
          <h2 className="text-[15px] font-bold">보류 갈래</h2>
          <p className="mt-1.5 text-[13px] text-fg-3">한 갈래를 고르면 같은 판단만 모아 봅니다.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {causes.counts.map(({ cause: key, count }) => {
              const active = cause === key;
              return (
                <Link key={key} href={query({ cause: active ? undefined : key })}
                  aria-current={active ? 'page' : undefined}
                  className={`flex max-w-[340px] flex-col gap-1 rounded-[10px] border px-3 py-2.5 ${
                    active ? 'border-accent bg-accent-soft' : 'border-line bg-bg-card hover:bg-bg-hover'}`}>
                  <span className="flex items-center gap-2 text-[13.5px] font-bold">
                    {CAUSE_GUIDE[key].label}
                    <span className={`rounded-full px-2 font-mono text-[13px] ${active ? 'text-accent' : 'text-fg-2'}`}>{count}</span>
                  </span>
                  <span className="text-[13px] leading-[1.6] text-fg-3">{CAUSE_GUIDE[key].summary}</span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {(() => {
        const resolved = causes.counts.find((row) => row.cause === "resolved");
        return resolved && (!cause || cause === "resolved") ? <RequeueResolved count={resolved.count} /> : null;
      })()}

      <nav aria-label="심사 상태 필터" className="mt-6 flex flex-wrap gap-2 text-[13px]">
        {STATES.map(([value, label]) => (
          <Link key={value} href={query({ state: value })} aria-current={!cause && state === value ? 'page' : undefined}
            className={`rounded-lg border px-3 py-2 ${!cause && state === value ? 'border-accent text-accent' : 'border-line text-fg-2'}`}>{label}</Link>
        ))}
        {(after > 0 || cause) && <Link href={query({ state })} className="ml-auto py-2 text-fg-2">처음으로</Link>}
      </nav>

      {entries.length === 0 ? (
        <p className="mt-8 rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">
          {cause ? '이 갈래로 보류된 후보가 없습니다.' : '심사할 후보가 없습니다.'}
        </p>
      ) : (
        <>
          <BulkDecision formId={BULK_FORM} reasons={REVIEW_REJECT_REASONS} total={entries.length} />
          <ul className="mt-4 flex flex-col gap-3">
            {entries.map((entry) => (
              <ReviewItem key={`${entry.candidate.id}:${entry.candidateRevisionHash}:${entry.sourceRevisionHash}`}
                entry={entry} reasons={REVIEW_REJECT_REASONS} bulkFormId={BULK_FORM} />
            ))}
          </ul>
        </>
      )}
      {nextAfter !== null && (
        <Link href={query({ state, cause: cause || undefined, after: nextAfter })}
          className="mt-6 inline-block rounded-lg border border-line px-4 py-2 text-[13px] font-semibold">다음 {PAGE_SIZE}건</Link>
      )}
    </main>
  );
}

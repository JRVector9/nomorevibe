import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { listAdminReviewEntries, reviewQueueAiDecisions, reviewQueueCauses, REVIEW_QUEUE_SCAN_LIMIT, type ReviewAiDecision } from "@/lib/crawl/admin-review";
import { getSettings } from "@/lib/crawl/settings";
import { REVIEW_REJECT_REASONS } from "@/lib/crawl/review";
import { pendingTakedowns } from "@/lib/domain/products/takedown";
import { TakedownItem } from "./TakedownItem";
import { ReviewModeForm } from "./ReviewModeForm";
import { BulkDecision } from "./BulkDecision";
import { RequeueResolved } from "./RequeueResolved";
import { ReviewConsole } from "./ReviewConsole";
import { CAUSE_GUIDE, type CauseKey } from "./causes";
import { pageWindow } from "../paging";
import { publishedSecondReviews, secondReviewSummary } from "@/lib/crawl/second-review";
import { PublishedSecondReviews } from "./PublishedSecondReviews";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "심사 큐 — NoMoreVibe", robots: { index: false } };

/** 한 쪽. 줄 높이 34px로 한 화면(약 1,150px)에 머리·필터와 함께 들어가는 수 */
const PAGE_SIZE = 25;
const BULK_FORM = "review-bulk";
const STATES = [['pending', '진행 중'], ['needs_review', '보류'], ['rejected', '거부'], ['published', '발행 완료']] as const;
const AI_FILTERS: [ReviewAiDecision, string][] = [['reject', 'AI 거부'], ['approve', 'AI 승인'], ['needs_review', 'AI 보류'], ['none', '판단 없음']];
/** 2차 심사 거르기 — 같은 결론끼리 모아 한 번에 확정한다 */
const SECOND_FILTERS = [['agreed_reject', '2차 일치·거부'], ['agreed_approve', '2차 일치·승인'], ['needs_human', '2차 사람 확인']] as const;
type SecondFilter = typeof SECOND_FILTERS[number][0] | 'published';

type Search = { state?: string | string[]; page?: string | string[]; cause?: string | string[]; ai?: string | string[]; second?: string | string[]; focus?: string | string[] };
const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '');

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const params = await searchParams;
  const rawState = one(params.state);
  const state = rawState === 'needs_review' || rawState === 'rejected' || rawState === 'published' ? rawState : 'pending';
  const rawCause = one(params.cause);
  const cause = (rawCause in CAUSE_GUIDE ? rawCause : '') as CauseKey | '';
  const ai = (AI_FILTERS.some(([key]) => key === one(params.ai)) ? one(params.ai) : '') as ReviewAiDecision | '';
  const rawPage = Number(one(params.page) || 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const focus = Number(one(params.focus)) || undefined;
  const second = ([...SECOND_FILTERS.map(([key]) => key), 'published'] as string[]).includes(one(params.second)) ? one(params.second) as SecondFilter : '';

  const settings = await getSettings();
  const [takedowns, causes, decisions, seconds] = await Promise.all([pendingTakedowns(), reviewQueueCauses(settings), reviewQueueAiDecisions(), secondReviewSummary()]);

  // 갈래·AI 판단은 계산으로 얻은 값이라 SQL로 거를 수 없다 — 해당하는 id 만 넘긴다. 둘 다 고르면 겹치는 것만
  const causeIds = cause ? (causes.ids.get(cause) ?? []) : undefined;
  const aiIds = ai ? (decisions.ids.get(ai) ?? []) : undefined;
  const secondIds = second && second !== 'published' ? seconds.ids[second] : undefined;
  const ids = [causeIds, aiIds, secondIds].filter((list): list is number[] => Boolean(list))
    .reduce<number[] | undefined>((acc, list) => acc ? acc.filter((id) => list.includes(id)) : list, undefined);
  const filtered = Boolean(cause || ai || second);
  const { entries, total } = await listAdminReviewEntries(settings, {
    state: filtered ? 'needs_review' : state, offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE, ids,
  });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const query = (next: Partial<Record<'state' | 'cause' | 'ai' | 'second' | 'page', string | number | undefined>>) => {
    const merged = { state: filtered ? undefined : state === 'pending' ? undefined : state, cause: cause || undefined, ai: ai || undefined, second: second || undefined, ...next };
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) if (value !== undefined && value !== '' && !(key === 'page' && value === 1)) search.set(key, String(value));
    return `/admin/review${search.size ? `?${search}` : ''}`;
  };
  const chip = (active: boolean) => `rounded-full border px-2.5 py-1 text-[13px] ${active ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-line bg-bg-card text-fg-2 hover:bg-bg-hover'}`;
  const resolved = causes.counts.find((row) => row.cause === "resolved");

  return (
    <main className="flex flex-col gap-2.5 pb-10 pt-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-[22px] font-extrabold tracking-tight">심사 큐</h1>
        <span className="text-[13px] text-fg-3">
          보류 {causes.total}건{causes.truncated && ` 이상 (${REVIEW_QUEUE_SCAN_LIMIT}건까지 셈)`} · 이 조건 {total.toLocaleString("ko-KR")}건 · {page}/{pages}쪽
        </span>
        <div className="ml-auto"><ReviewModeForm key={settings.reviewMode} mode={settings.reviewMode} ready={process.env.CRAWL_REVIEW_READY === 'true'} /></div>
      </div>

      {takedowns.length > 0 && (
        <section className="rounded-[12px] border border-down/40 bg-down/5 px-3 py-2">
          <h2 className="text-[13px] font-bold text-down">내려달라는 요청 {takedowns.length}건 — 먼저 처리합니다</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {takedowns.map((request) => (
              <TakedownItem key={request.slug} slug={request.slug} reason={request.reason}
                requestedAt={request.requestedAt.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })} />
            ))}
          </ul>
        </section>
      )}

      <nav aria-label="심사 거르기" className="flex flex-wrap items-center gap-1.5">
        {STATES.map(([value, label]) => (
          <Link key={value} href={query({ state: value, cause: undefined, ai: undefined, page: 1 })}
            aria-current={!filtered && state === value ? 'page' : undefined} className={chip(!filtered && state === value)}>{label}</Link>
        ))}
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        {AI_FILTERS.map(([key, label]) => (
          <Link key={key} href={query({ ai: ai === key ? undefined : key, state: undefined, page: 1 })}
            aria-current={ai === key ? 'page' : undefined} className={chip(ai === key)}>
            {label} <span className="font-mono">{decisions.counts[key]}</span>
          </Link>
        ))}
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        {SECOND_FILTERS.map(([key, label]) => {
          const count = key === 'agreed_reject' ? seconds.counts.agreedReject : key === 'agreed_approve' ? seconds.counts.agreedApprove : seconds.counts.needsHuman;
          return (
            <Link key={key} href={query({ second: second === key ? undefined : key, state: undefined, page: 1 })}
              aria-current={second === key ? 'page' : undefined} className={chip(second === key)}>
              {label} <span className="font-mono">{count}</span>
            </Link>
          );
        })}
        <Link href={query({ second: second === 'published' ? undefined : 'published', cause: undefined, ai: undefined, state: undefined, page: 1 })}
          aria-current={second === 'published' ? 'page' : undefined} className={chip(second === 'published')}>
          2차 공개분 확인 <span className="font-mono">{seconds.counts.published}</span>
        </Link>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        {causes.counts.map(({ cause: key, count }) => (
          <Link key={key} href={query({ cause: cause === key ? undefined : key, state: undefined, page: 1 })}
            title={CAUSE_GUIDE[key].summary} aria-current={cause === key ? 'page' : undefined} className={chip(cause === key)}>
            {CAUSE_GUIDE[key].label} <span className="font-mono">{count}</span>
          </Link>
        ))}
        {filtered && <Link href="/admin/review" className="ml-auto text-[13px] text-fg-2">거르기 지우기</Link>}
      </nav>

      {resolved && (!cause || cause === "resolved") ? <RequeueResolved count={resolved.count} /> : null}

      {second === 'published' ? (
        <PublishedSecondReviews rows={(await publishedSecondReviews()).map((row) => ({ id: row.id, slug: row.publishedSlug ?? '', repo: row.repo,
          decision: row.secondDecision, confidence: row.secondConfidence, reason: row.secondReason, trigger: row.trigger, signals: row.signals }))} />
      ) : entries.length === 0 ? (
        <p className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">
          {filtered ? '이 조건으로 보류된 후보가 없습니다.' : '심사할 후보가 없습니다.'}
        </p>
      ) : (
        <>
          <BulkDecision formId={BULK_FORM} reasons={REVIEW_REJECT_REASONS} total={entries.length} />
          <ReviewConsole key={`${page}:${state}:${cause}:${ai}:${second}`} entries={entries} reasons={REVIEW_REJECT_REASONS} bulkFormId={BULK_FORM} focus={focus} />
        </>
      )}

      {pages > 1 && (
        <nav aria-label="심사 목록 쪽 이동" className="flex flex-wrap items-center gap-1 text-[13px]">
          {page > 1 && <Link href={query({ page: page - 1 })} className="rounded-lg border border-line px-2.5 py-1">이전</Link>}
          {pageWindow(page, pages).map((item, i) => item === null
            ? <span key={`gap-${i}`} className="px-1 text-fg-3">…</span>
            : <Link key={item} href={query({ page: item })} aria-current={item === page ? 'page' : undefined}
                className={`min-w-8 rounded-lg border px-2.5 py-1 text-center font-mono ${item === page ? 'border-accent bg-accent text-white' : 'border-line text-fg-2'}`}>{item}</Link>)}
          {page < pages && <Link href={query({ page: page + 1 })} className="rounded-lg border border-line px-2.5 py-1">다음</Link>}
        </nav>
      )}
    </main>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { candidateStateCounts, listAdminReviewEntries, reviewQueueAiDecisions, reviewQueueCauses, REVIEW_QUEUE_SCAN_LIMIT, type ReviewAiDecision } from "@/lib/crawl/admin-review";
import { getSettings } from "@/lib/crawl/settings";
import { REVIEW_REJECT_REASONS } from "@/lib/crawl/review";
import { pendingTakedowns } from "@/lib/domain/products/takedown";
import { TakedownItem } from "./TakedownItem";
import { ReviewModeForm } from "./ReviewModeForm";
import { BulkDecision } from "./BulkDecision";
import { RequeueResolved } from "./RequeueResolved";
import { ReviewConsole } from "./ReviewConsole";
import { CAUSE_GUIDE, type CauseKey } from "./causes";
import { heldStages, STAGE_GROUPS, STAGE_KEYS, STAGE_STATE, type StageKey } from "./stages";
import { ListToolbar, UPDATED_DAYS, UPDATED_WINDOWS, type UpdatedWindow } from "./ListToolbar";
import { pageWindow } from "../paging";
import { publishedSecondReviews, secondReviewSummary } from "@/lib/crawl/second-review";
import { PublishedSecondReviews } from "./PublishedSecondReviews";
import { ReasonLanguageToggle } from "./ReasonText";
import { translationProgress, translationsFor } from "@/lib/crawl/translations";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "심사 큐 — NoMoreVibe", robots: { index: false } };

/**
 * 한 쪽에 보이는 수.
 *
 * 25는 1,150px 화면을 기준으로 잡은 값이라, 더 큰 화면에서는 목록이 끝난 뒤 쪽 번호까지
 * 빈 자리가 남았다. 목록이 화면을 채우도록 늘린다 — 작은 화면에서는 스크롤이 생기지만
 * 그쪽은 어차피 25로도 스크롤이었다.
 */
const PAGE_SIZE = 50;
const BULK_FORM = "review-bulk";
const AI_FILTERS: [ReviewAiDecision, string][] = [['reject', '거부'], ['approve', '승인'], ['needs_review', '보류'], ['none', '판단 없음']];
/** 2차 심사 거르기 — 같은 결론끼리 모아 한 번에 확정한다 */
const SECOND_FILTERS = [['unanimous_reject', '만장일치·거부'], ['unanimous_approve', '만장일치·승인'],
  ['agreed_reject', '2표 일치·거부'], ['agreed_approve', '2표 일치·승인'], ['needs_human', '사람 확인']] as const;
type SecondFilter = typeof SECOND_FILTERS[number][0] | 'published';

type Search = { state?: string | string[]; stage?: string | string[]; q?: string | string[]; updated?: string | string[]; page?: string | string[]; cause?: string | string[]; ai?: string | string[]; second?: string | string[]; focus?: string | string[] };
const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '');

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const params = await searchParams;
  const rawState = one(params.state);
  const state = rawState === 'needs_review' || rawState === 'rejected' || rawState === 'published' ? rawState : 'pending';
  const rawStage = one(params.stage);
  const stage = ((STAGE_KEYS as string[]).includes(rawStage) ? rawStage : '') as StageKey | '';
  const rawCause = one(params.cause);
  const cause = (rawCause in CAUSE_GUIDE ? rawCause : '') as CauseKey | '';
  const ai = (AI_FILTERS.some(([key]) => key === one(params.ai)) ? one(params.ai) : '') as ReviewAiDecision | '';
  const rawPage = Number(one(params.page) || 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const focus = Number(one(params.focus)) || undefined;
  const second = ([...SECOND_FILTERS.map(([key]) => key), 'published'] as string[]).includes(one(params.second)) ? one(params.second) as SecondFilter : '';
  const q = one(params.q).trim().slice(0, 100);
  const updated = (UPDATED_WINDOWS.some(([value]) => value === one(params.updated)) ? one(params.updated) : '') as UpdatedWindow;

  const settings = await getSettings();
  const [takedowns, causes, decisions, seconds, translation, stateCounts] = await Promise.all([pendingTakedowns(), reviewQueueCauses(settings), reviewQueueAiDecisions(), secondReviewSummary(settings.secondReview.agreeAt), translationProgress(), candidateStateCounts()]);
  const held = heldStages(decisions.ids, seconds.ids, [...(causes.ids.get('second_review_split') ?? []), ...(causes.ids.get('no_description') ?? [])]);
  const stageCount: Record<StageKey, number> = {
    judge: stateCounts.new, ai: held.ids.ai.length, second: held.ids.second.length, agreed: held.ids.agreed.length,
    human: held.ids.human.length, publish: stateCounts.approved, published: stateCounts.published, rejected: stateCounts.rejected,
  };

  /*
   * 구간과 세부 거르기는 겹쳐 고를 수 있다(겹치는 것만 남는다). 세부 거르기는 보류 안에서만 뜻이 있어,
   * 결과 구간(판정 대기·발행 대기·발행 완료·거부)을 고르면 닿지 않는다.
   * 갈래·AI 판단은 계산으로 얻은 값이라 SQL로 거를 수 없다 — 해당하는 id 만 넘긴다.
   */
  const heldStage = stage === 'ai' || stage === 'second' || stage === 'agreed' || stage === 'human' ? stage : null;
  const detailable = !stage || heldStage !== null;
  const causeIds = detailable && cause ? (causes.ids.get(cause) ?? []) : undefined;
  const aiIds = detailable && ai ? (decisions.ids.get(ai) ?? []) : undefined;
  const secondIds = detailable && second && second !== 'published' ? seconds.ids[second] : undefined;
  const ids = [heldStage ? held.ids[heldStage] : undefined, causeIds, aiIds, secondIds].filter((list): list is number[] => Boolean(list))
    .reduce<number[] | undefined>((acc, list) => { if (!acc) return list; const keep = new Set(list); return acc.filter((id) => keep.has(id)); }, undefined);
  const detailed = detailable && Boolean(cause || ai || second);
  const filtered = Boolean(stage) || detailed;
  const { entries, total, hiddenByAge } = await listAdminReviewEntries(settings, {
    state: stage ? STAGE_STATE[stage] : detailed ? 'needs_review' : state, offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE, ids,
    search: q || undefined, pushedWithinDays: updated ? UPDATED_DAYS[updated] : undefined,
  });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const query = (next: Partial<Record<'state' | 'stage' | 'cause' | 'ai' | 'second' | 'q' | 'updated' | 'page', string | number | undefined>>) => {
    const merged = { state: filtered || state === 'pending' ? undefined : state, stage: stage || undefined,
      cause: cause || undefined, ai: ai || undefined, second: second || undefined, q: q || undefined, updated: updated || undefined, ...next };
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) if (value !== undefined && value !== '' && !(key === 'page' && value === 1)) search.set(key, String(value));
    return `/admin/review${search.size ? `?${search}` : ''}`;
  };
  // 0건인 칩은 흐리게 — 자리는 그대로 두어 칩이 날마다 옮겨 다니지 않게 하고, 볼 것이 있는 칩만 눈에 띄게 한다
  const chip = (active: boolean, count?: number) => `rounded-full border px-2.5 py-1 text-[13px] ${active ? 'border-accent bg-accent-soft font-semibold text-accent'
    : count === 0 ? 'border-line bg-bg-card text-fg-3 hover:bg-bg-hover' : 'border-line bg-bg-card text-fg-2 hover:bg-bg-hover'}`;
  const resolved = causes.counts.find((row) => row.cause === "resolved");

  return (
    <main className="flex flex-col gap-2.5 pb-10 pt-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-[22px] font-extrabold tracking-tight">심사 큐</h1>
        <span className="text-[13px] text-fg-3">
          <Link href="/admin/review?state=needs_review" className="hover:text-fg">보류 {causes.total.toLocaleString("ko-KR")}건</Link>
          {causes.truncated && ` 이상 (${REVIEW_QUEUE_SCAN_LIMIT.toLocaleString("ko-KR")}건까지 셈)`} · 이 조건 {total.toLocaleString("ko-KR")}건 · {page}/{pages}쪽
          {(filtered || state !== 'pending' || q || updated) && <Link href="/admin/review" className="ml-2 text-fg-2 hover:text-fg">거르기 지우기</Link>}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <ReasonLanguageToggle done={translation.done} total={translation.total} />
          <ReviewModeForm key={settings.reviewMode} mode={settings.reviewMode} ready={process.env.CRAWL_REVIEW_READY === 'true'} />
        </div>
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

      {/*
        심사 구간 — 후보가 파이프라인의 어디에 서 있는가(stages.ts). 왼쪽에서 오른쪽으로 흐른다.
        사람이 할 일은 4번 칸에 모인다. 칸은 겹치지 않아, 보류 칸들의 합이 보류 수다.
      */}
      <nav aria-label="심사 구간" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {STAGE_GROUPS.map((group) => (
          <section key={group.step} aria-label={group.title} className="flex flex-col gap-1.5 rounded-[12px] border border-line bg-bg-card p-2.5">
            <h2 className="text-[13px] font-semibold text-fg-3"><span className="font-mono">{group.step}</span> · {group.title}</h2>
            {group.stages.map((item) => {
              const active = stage === item.key;
              const count = stageCount[item.key];
              const toResult = !(item.key === 'ai' || item.key === 'second' || item.key === 'agreed' || item.key === 'human');
              return (
                <Link key={item.key} aria-current={active ? 'page' : undefined}
                  href={query({ stage: active ? undefined : item.key, state: undefined, page: 1,
                    ...(toResult ? { cause: undefined, ai: undefined, second: undefined } : {}) })}
                  className={`flex flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 ${active ? 'border-accent bg-accent-soft' : 'border-line hover:bg-bg-hover'}`}>
                  <span className="flex items-baseline justify-between gap-2 text-[13px]">
                    <b className={`font-semibold ${active ? 'text-accent' : count === 0 ? 'text-fg-3' : 'text-fg'}`}>{item.label}</b>
                    <span className={`font-mono ${count === 0 ? 'text-fg-3' : active ? 'text-accent' : 'text-fg'}`}>{count.toLocaleString("ko-KR")}</span>
                  </span>
                  {/* 좁은 화면에서는 설명을 접는다 — 칸이 세로로 쌓여 한 화면을 넘긴다. 일치 건의 거부·승인 내역은 남긴다 */}
                  <span className={`text-[13px] leading-[1.4] text-fg-3 ${item.key === 'agreed' ? '' : 'hidden sm:block'}`}>
                    {item.key === 'agreed' ? `거부 ${held.agreedReject.toLocaleString("ko-KR")} · 승인 ${held.agreedApprove.toLocaleString("ko-KR")}` : item.hint}
                  </span>
                </Link>
              );
            })}
          </section>
        ))}
      </nav>

      {/* 보류 안에서 더 좁히는 거르기. 구간이 먼저이고 이것은 필요할 때 연다 — 고른 것이 있으면 열어 둔다 */}
      <details open={detailed} className="rounded-[12px] border border-line bg-bg-card px-3 py-2">
        <summary className="cursor-pointer text-[13px] font-semibold text-fg-2">
          세부 거르기 <span className="font-normal text-fg-3">— 보류 안에서 보류 이유·1차 AI 결론·2차 표로 좁힌다</span>
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <FilterRow label="보류 이유" hint="규칙이 멈춘 곳">
            {causes.counts.map(({ cause: key, count }) => (
              <Link key={key} href={query({ cause: cause === key ? undefined : key, state: undefined, page: 1 })}
                title={CAUSE_GUIDE[key].summary} aria-current={cause === key ? 'page' : undefined} className={chip(cause === key, count)}>
                {CAUSE_GUIDE[key].label} <span className="font-mono">{count.toLocaleString("ko-KR")}</span>
              </Link>
            ))}
          </FilterRow>
          <FilterRow label="1차 AI" hint="마지막 심사의 결론">
            {AI_FILTERS.map(([key, label]) => (
              <Link key={key} href={query({ ai: ai === key ? undefined : key, state: undefined, page: 1 })}
                aria-current={ai === key ? 'page' : undefined} className={chip(ai === key, decisions.counts[key])}>
                {label} <span className="font-mono">{decisions.counts[key].toLocaleString("ko-KR")}</span>
              </Link>
            ))}
          </FilterRow>
          <FilterRow label="2차 심사" hint="다른 모델의 표">
            {SECOND_FILTERS.map(([key, label]) => {
              const count = key === 'unanimous_reject' ? seconds.counts.unanimousReject : key === 'unanimous_approve' ? seconds.counts.unanimousApprove
                : key === 'agreed_reject' ? seconds.counts.agreedReject : key === 'agreed_approve' ? seconds.counts.agreedApprove : seconds.counts.needsHuman;
              return (
                <Link key={key} href={query({ second: second === key ? undefined : key, state: undefined, page: 1 })}
                  aria-current={second === key ? 'page' : undefined} className={chip(second === key, count)}>
                  {label} <span className="font-mono">{count.toLocaleString("ko-KR")}</span>
                </Link>
              );
            })}
            <span className="mx-1 h-4 w-px bg-line" aria-hidden />
            <Link href={query({ second: second === 'published' ? undefined : 'published', stage: undefined, cause: undefined, ai: undefined, state: undefined, page: 1 })}
              aria-current={second === 'published' ? 'page' : undefined} className={chip(second === 'published', seconds.counts.published)}>
              공개분 확인 <span className="font-mono">{seconds.counts.published.toLocaleString("ko-KR")}</span>
            </Link>
          </FilterRow>
        </div>
      </details>

      {resolved && (!cause || cause === "resolved") ? <RequeueResolved count={resolved.count} /> : null}

      {second !== 'published' && (
        <ListToolbar q={q} updated={updated} total={total} hiddenByAge={hiddenByAge}
          keep={{ state: filtered || state === 'pending' ? undefined : state, stage: stage || undefined, cause: cause || undefined, ai: ai || undefined, second: second || undefined }}
          clearHref={query({ q: undefined, updated: undefined, page: 1 })} />
      )}

      {second === 'published' ? (
        <PublishedSecondReviews rows={await (async () => {
          const rows = await publishedSecondReviews();
          const korean = await translationsFor(rows.map((row) => row.secondReason));
          return rows.map((row) => ({ id: row.id, slug: row.publishedSlug ?? '', repo: row.repo, decision: row.secondDecision,
            confidence: row.secondConfidence, reason: row.secondReason, reasonKo: row.secondReason ? korean.get(row.secondReason) ?? null : null,
            trigger: row.trigger, signals: row.signals }));
        })()} />
      ) : entries.length === 0 ? (
        <p className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">
          {filtered ? '이 조건에 해당하는 후보가 없습니다.' : '심사할 후보가 없습니다.'}
        </p>
      ) : (
        <>
          <BulkDecision formId={BULK_FORM} reasons={REVIEW_REJECT_REASONS} total={entries.length} />
          <ReviewConsole key={`${page}:${state}:${stage}:${cause}:${ai}:${second}:${q}:${updated}`} entries={entries} reasons={REVIEW_REJECT_REASONS} bulkFormId={BULK_FORM} focus={focus} />
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

/** 거르기 한 줄 — 왼쪽에 무엇을 거르는지 이름을 붙인다. 좁은 화면에서는 이름이 위로 올라간다 */
function FilterRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <p className="shrink-0 text-[13px] sm:w-[128px]">
        <b className="font-semibold text-fg-2">{label}</b>
        {hint ? <span className="ml-1.5 text-fg-3 sm:ml-0 sm:block">{hint}</span> : null}
      </p>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

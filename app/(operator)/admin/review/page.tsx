import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { candidateStateCounts, publicationChange24h, listAdminReviewEntries, reviewQueueCauses, REVIEW_QUEUE_SCAN_LIMIT, REVIEW_SORTS, type ReviewAiDecision, type ReviewSort } from "@/lib/crawl/admin-review";
import { getSettings } from "@/lib/crawl/settings";
import { REVIEW_REJECT_REASONS } from "@/lib/crawl/review";
import { takedownSummary } from "@/lib/domain/products/takedown";
import { TakedownStrip } from "../TakedownStrip";
import { RequeueResolved } from "./RequeueResolved";
import { ReviewConsole } from "./ReviewConsole";
import { CAUSE_GUIDE, causeShort, type CauseKey } from "./causes";
import { SECOND_FILTER_KEYS, SECOND_FILTERS, STAGE_GROUPS, STAGE_KEYS, STAGE_STATE, type SecondFilter, type StageKey } from "./stages";
import { ListToolbar, UPDATED_DAYS, UPDATED_WINDOWS, type UpdatedWindow } from "./ListToolbar";
import { pageWindow } from "../paging";
import { publishedSecondReviews } from "@/lib/crawl/second-review";
import { PublishedSecondReviews } from "./PublishedSecondReviews";
import { ReasonLanguageToggle } from "./ReasonText";
import { translationProgress, translationsFor } from "@/lib/crawl/translations";
import { modelHealth } from "@/lib/operations/dashboard";
import { humanQueueOverview, taglineProgress } from "@/lib/crawl/review-overview";
import { ReviewStatusChips } from "./ReviewStatusChips";
import { ReviewStageRail } from "./ReviewStageRail";
import { ScrollToHash } from "../ScrollToHash";
import "../status/dashboard/dashboard.css";
import "./review.css";

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
const AI_FILTERS: [ReviewAiDecision, string][] = [['reject', '거부'], ['approve', '승인'], ['needs_review', '보류'], ['none', '판단 없음']];
/** 머리의 읽기 전용 칩에 적는 리뷰 운영 모드 — 바꾸는 곳은 설정 화면 #second 한 곳이다(ADM-24) */
const MODE_LABEL = { off: '끄기', observe: '관측', enforce: '적용' } as const;

type Search = { state?: string | string[]; stage?: string | string[]; q?: string | string[]; updated?: string | string[]; page?: string | string[]; cause?: string | string[]; ai?: string | string[]; second?: string | string[]; focus?: string | string[]; sort?: string | string[] };
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
  const second = (SECOND_FILTER_KEYS as readonly string[]).includes(one(params.second)) ? one(params.second) as SecondFilter : '';
  const q = one(params.q).trim().slice(0, 100);
  const updated = (UPDATED_WINDOWS.some(([value]) => value === one(params.updated)) ? one(params.updated) : '') as UpdatedWindow;
  const sort = ((REVIEW_SORTS as readonly string[]).includes(one(params.sort)) ? one(params.sort) : '') as ReviewSort;

  const settings = await getSettings();
  // 머리의 번역 진행은 느린 바깥 읽기다(번역 집계 캐시가 비면 2.2초) — 먼저 띄워 두고 그 자리만 따로 흘려보낸다.
  // 모델 상태도 갈래 셈을 기다릴 까닭이 없어 같이 띄운다
  const translation = translationProgress().catch(() => null);
  const modelsLoad = modelHealth(settings).catch(() => null);
  // 구간·2차 칩·사람 몫의 수는 운영센터와 같은 humanQueueOverview 하나에서 온다 — 두 화면의 숫자가 갈리지 않게
  const [takedowns, causes, overview, stateCounts, publicationChange] = await Promise.all([takedownSummary().catch(() => null), reviewQueueCauses(settings), humanQueueOverview(settings), candidateStateCounts(), publicationChange24h()]);
  const decisions = overview.aiDecisions;
  const stageCount: Record<StageKey, number> = {
    judge: stateCounts.new, ...overview.stages, publish: stateCounts.approved, published: stateCounts.published, rejected: stateCounts.rejected,
  };
  // 머리 칩·할 일 카드의 숫자. 하나가 실패해도 큐는 그려야 하므로 각각 비운 채 넘긴다
  const [models, taglines] = await Promise.all([
    modelsLoad,
    taglineProgress(causes.ids.get('no_description') ?? []).catch(() => null),
  ]);

  /*
   * 구간과 세부 거르기는 겹쳐 고를 수 있다(겹치는 것만 남는다). 세부 거르기는 보류 안에서만 뜻이 있어,
   * 결과 구간(판정 대기·발행 대기·발행 완료·거부)을 고르면 닿지 않는다.
   * 갈래·AI 판단은 계산으로 얻은 값이라 SQL로 거를 수 없다 — 해당하는 id 만 넘긴다.
   */
  const heldStage = stage === 'ai' || stage === 'second' || stage === 'agreed' || stage === 'human' ? stage : null;
  const detailable = !stage || heldStage !== null;
  const causeIds = detailable && cause ? (causes.ids.get(cause) ?? []) : undefined;
  const aiIds = detailable && ai ? (decisions.ids.get(ai) ?? []) : undefined;
  const secondIds = detailable && second && second !== 'published' ? overview.secondIds[second] : undefined;
  const ids = [heldStage ? overview.ids[heldStage] : undefined, causeIds, aiIds, secondIds].filter((list): list is number[] => Boolean(list))
    .reduce<number[] | undefined>((acc, list) => { if (!acc) return list; const keep = new Set(list); return acc.filter((id) => keep.has(id)); }, undefined);
  const detailed = detailable && Boolean(cause || ai || second);
  const filtered = Boolean(stage) || detailed;
  const { entries, total, hiddenByAge } = await listAdminReviewEntries(settings, {
    state: stage ? STAGE_STATE[stage] : detailed ? 'needs_review' : state, offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE, ids,
    search: q || undefined, pushedWithinDays: updated ? UPDATED_DAYS[updated] : undefined, sort,
  });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const listParams = (next: Partial<Record<'state' | 'stage' | 'cause' | 'ai' | 'second' | 'q' | 'updated' | 'sort' | 'page', string | number | undefined>>) => {
    const merged = { state: filtered || state === 'pending' ? undefined : state, stage: stage || undefined,
      cause: cause || undefined, ai: ai || undefined, second: second || undefined, q: q || undefined,
      updated: updated || undefined, sort: sort || undefined, ...next };
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) if (value !== undefined && value !== '' && !(key === 'page' && value === 1)) search.set(key, String(value));
    return search;
  };
  const query = (next: Parameters<typeof listParams>[0]) => {
    const search = listParams(next);
    return `/admin/review${search.size ? `?${search}` : ''}`;
  };
  // 지금 거르기 그대로 내보낸다(계약 C1) — 쪽 번호 없이 거르기만
  const exportSearch = listParams({});
  const exportHref = `/admin/export?view=review&format=csv${exportSearch.size ? `&${exportSearch}` : ''}`;
  // 0건인 칩은 흐리게 — 자리는 그대로 두어 칩이 날마다 옮겨 다니지 않게 하고, 볼 것이 있는 칩만 눈에 띄게 한다
  const chip = (active: boolean, count?: number) => `rounded-full border px-2.5 py-1 text-[13px] ${active ? 'border-accent bg-accent-soft font-semibold text-accent'
    : count === 0 ? 'border-line bg-bg-card text-fg-3 hover:bg-bg-hover' : 'border-line bg-bg-card text-fg-2 hover:bg-bg-hover'}`;
  const resolved = causes.counts.find((row) => row.cause === "resolved");

  const n = (value: number) => value.toLocaleString("ko-KR");
  const causeCount = (key: CauseKey) => causes.counts.find((row) => row.cause === key)?.count ?? 0;
  // 할 일 카드는 구간 탭의 배지로 합쳤다(ADM-09) — 카드가 말하던 갈래 수는 직접 판단 탭의 title 로
  const humanDetail = `2차 갈림 ${n(causeCount('second_review_split'))} · 재시도 소진 ${n(causeCount('ai_review_exhausted'))} · 스팸·악성 의심 ${n(causeCount('suspected_spam'))}`
    + ` · 소개 없음 ${n(causeCount('no_description'))}${taglines ? `(AI 소개 지음 ${n(taglines.written)} · 근거로는 모름 ${n(taglines.unknown)} · 실패 ${n(taglines.failed)} · 시도 전 ${n(taglines.untried)})` : ''}`;
  // 내려달라는 요청은 머리의 한 줄(TakedownStrip)과 내릴 후보 화면이 맡는다 — 여기서는 2차가 다시 본 공개분만
  const todoTabs = [{ key: 'published', label: '공개분 확인', count: overview.secondPublished, active: second === 'published',
    title: `2차가 다시 본 공개분 — 내릴지 둘지 사람이 정합니다 · ${n(overview.secondPublished)}건`, tone: overview.secondPublished > 0 ? 'warn' as const : undefined,
    href: second === 'published' ? '/admin/review#review-list' : '/admin/review?second=published#review-list' }];
  // 지금 걸린 세부 거르기 — 하나씩 풀 수 있게 거르기 ▾ 옆에 칩으로 보인다
  const activeFilters = [
    cause && { key: 'cause', label: `갈래 · ${causeShort(cause)}`, href: query({ cause: undefined, page: 1 }) },
    ai && { key: 'ai', label: `1차 AI · ${AI_FILTERS.find(([key]) => key === ai)?.[1]}`, href: query({ ai: undefined, page: 1 }) },
    second && second !== 'published' && { key: 'second', label: `2차 · ${SECOND_FILTERS.find(([key]) => key === second)?.[1]}`, href: query({ second: undefined, page: 1 }) },
  ].filter((item): item is { key: string; label: string; href: string } => Boolean(item));
  const voters = settings.secondReview.voters.map((voter) => voter.model).join(', ');
  const fallbacks = (settings.secondReview.fallbacks ?? []).map((voter) => voter.model).join(', ');
  const listTitle = `${stage ? STAGE_GROUPS.flatMap(group => group.stages).find(item => item.key === stage)?.label : '심사 후보'} · ${total.toLocaleString("ko-KR")}건`;
  const pagination = pages > 1 ? (
    <nav aria-label="심사 목록 쪽 이동" className="ml-auto flex flex-wrap items-center gap-1 text-[13px]">
      {page > 1 && <Link href={query({ page: page - 1 })} className="rounded-lg border border-line px-2.5 py-1">이전</Link>}
      {pageWindow(page, pages).map((item, i) => item === null
        ? <span key={`gap-${i}`} className="px-1 text-fg-3">…</span>
        : <Link key={item} href={query({ page: item })} aria-current={item === page ? 'page' : undefined}
            className={`min-w-8 rounded-lg border px-2.5 py-1 text-center font-mono ${item === page ? 'border-accent bg-accent text-white' : 'border-line text-fg-2'}`}>{item}</Link>)}
      {page < pages && <Link href={query({ page: page + 1 })} className="rounded-lg border border-line px-2.5 py-1">다음</Link>}
    </nav>
  ) : null;
  const pageHref = { prev: page > 1 ? query({ page: page - 1 }) : null, next: page < pages ? query({ page: page + 1 }) : null };

  return (
    <main className="rq">
      <header className="rq-top">
        <div className="l">
          <h1 className="text-[22px] font-extrabold tracking-tight">심사 큐</h1>
          <span className="text-[13px] text-fg-3">
            <Link href="/admin/review?state=needs_review" className="hover:text-fg">보류 {causes.total.toLocaleString("ko-KR")}건</Link>
            {causes.truncated && ` 이상 (${REVIEW_QUEUE_SCAN_LIMIT.toLocaleString("ko-KR")}건까지 셈)`} · 이 조건 {total.toLocaleString("ko-KR")}건 · {page}/{pages}쪽
            {(filtered || state !== 'pending' || q || updated || sort) && <Link href="/admin/review" className="ml-2 text-accent hover:text-fg">거르기 지우기</Link>}
          </span>
        </div>
        <div className="r">
          <Suspense fallback={<ReasonLanguageToggle done={null} total={null} />}>
            <TranslationToggleSlot progress={translation} />
          </Suspense>
          {/* 2차 표·운영 모드는 읽기만 — 바꾸는 폼은 설정 화면 한 곳에 있다(ADM-24) */}
          <Link href="/admin#second" className="dash-pill hover:text-fg" title="2차 심사 모델과 AI 리뷰 운영 모드 — 설정에서 바꿉니다">
            2차: <span className="font-mono">{voters || '없음'}</span> · {MODE_LABEL[settings.reviewMode]} 모드
          </Link>
          <a href={exportHref} className="dash-pill hover:text-fg" title="지금 거르기 그대로 CSV 로 내려받습니다(최대 10,000행)">CSV 내보내기</a>
        </div>
      </header>

      <ReviewStatusChips models={models} human={overview.decided24h} publication={publicationChange} takedowns={takedowns?.pending ?? 0}
        inflow={overview.wait?.in24h ?? null} />

      <TakedownStrip summary={takedowns} />

      <ReviewStageRail stage={stage} counts={stageCount} overview={overview} publication={publicationChange} todo={todoTabs} humanDetail={humanDetail} />

      {/* 거르기 — 구간 안에서 더 좁힌다(겹쳐 고르면 겹치는 것만). 갈래는 표 머리의 드롭다운이 고른다 */}
      <div className="rq-bar">
        <details className="rq-filter">
          <summary className={chip(activeFilters.length > 0)}>거르기{activeFilters.length ? ` ${activeFilters.length}` : ''} ▾</summary>
          <div className="rq-filters" role="group" aria-label="거르기">
            <FilterRow label="1차 AI" hint="마지막 심사의 결론">
              {AI_FILTERS.map(([key, label]) => (
                <Link key={key} href={query({ ai: ai === key ? undefined : key, state: undefined, page: 1 })}
                  aria-current={ai === key ? 'page' : undefined} className={chip(ai === key, decisions.counts[key])}>
                  {label} <span className="font-mono">{decisions.counts[key].toLocaleString("ko-KR")}</span>
                </Link>
              ))}
            </FilterRow>
            <FilterRow label="2차 표" hint={fallbacks ? `${voters} · 대체 ${fallbacks}` : voters}>
              {SECOND_FILTERS.map(([key, label]) => {
                // 보류 안의 후보로 좁힌 수 — 칩을 누른 목록의 건수와 같다
                const count = overview.second[key];
                return (
                  <Link key={key} href={query({ second: second === key ? undefined : key, state: undefined, page: 1 })}
                    aria-current={second === key ? 'page' : undefined} className={chip(second === key, count)}>
                    {label} <span className="font-mono">{count.toLocaleString("ko-KR")}</span>
                  </Link>
                );
              })}
            </FilterRow>
          </div>
        </details>
        {activeFilters.map((item) => (
          <Link key={item.key} href={item.href} className={chip(true)} title="이 거르기 풀기">{item.label} ✕</Link>
        ))}
        {second !== 'published' && (
          <ListToolbar q={q} updated={updated} sort={sort} total={total} hiddenByAge={hiddenByAge}
            keep={{ state: filtered || state === 'pending' ? undefined : state, stage: stage || undefined, cause: cause || undefined, ai: ai || undefined, second: second || undefined }}
            clearHref={query({ q: undefined, updated: undefined, sort: undefined, page: 1 })} />
        )}
      </div>

      {resolved && (!cause || cause === "resolved") ? <RequeueResolved count={resolved.count} /> : null}

      <div id="review-list" className="flex scroll-mt-4 flex-col gap-3">
        {second === 'published' ? (
          <>
            <h2 className="text-[15px] font-bold text-fg">공개분 확인</h2>
            <PublishedSecondReviews rows={await (async () => {
              const rows = await publishedSecondReviews();
              const korean = await translationsFor(rows.map((row) => row.secondReason));
              return rows.map((row) => ({ id: row.id, slug: row.publishedSlug ?? '', repo: row.repo, decision: row.secondDecision,
                confidence: row.secondConfidence, reason: row.secondReason, reasonKo: row.secondReason ? korean.get(row.secondReason) ?? null : null,
                trigger: row.trigger, signals: row.signals }));
            })()} />
          </>
        ) : entries.length === 0 ? (
          <>
            <h2 className="text-[15px] font-bold text-fg">{listTitle}</h2>
            <p className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">
              {filtered ? '이 조건에 해당하는 후보가 없습니다.' : '심사할 후보가 없습니다.'}
            </p>
          </>
        ) : (
          <ReviewConsole key={`${page}:${state}:${stage}:${cause}:${ai}:${second}:${q}:${updated}:${sort}`}
            entries={entries} reasons={REVIEW_REJECT_REASONS} focus={focus} title={listTitle}
            footer={pagination} pageHref={pageHref}
            sort={sort} sortHref={Object.fromEntries(REVIEW_SORTS.map((key) => [key, query({ sort: key || undefined, page: 1 })])) as Record<ReviewSort, string>}
            cause={cause} causes={[{ value: '', label: '갈래 전체', count: causes.total, href: query({ cause: undefined, state: undefined, page: 1 }) },
              ...causes.counts.map(({ cause: key, count }) => ({ value: key, label: CAUSE_GUIDE[key].label, count,
                href: query({ cause: key, state: undefined, page: 1 }) }))]} />
        )}
        {(second === 'published' || entries.length === 0) && pagination}
      </div>
      <ScrollToHash />
    </main>
  );
}

/** 번역 진행이 오면 수를 붙인다 — 못 세면 수 없이 단추만 */
async function TranslationToggleSlot({ progress }: { progress: Promise<{ done: number; total: number } | null> }) {
  const value = await progress;
  return <ReasonLanguageToggle done={value?.done ?? null} total={value?.total ?? null} />;
}

/** 거르기 한 줄 — 이름 칸과 값 칸. rq-filters 격자의 두 칸에 그대로 선다(좁은 화면에서는 이름이 위로) */
function FilterRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <>
      <p className="k">{label}{hint ? <small>{hint}</small> : null}</p>
      <div className="v">{children}</div>
    </>
  );
}

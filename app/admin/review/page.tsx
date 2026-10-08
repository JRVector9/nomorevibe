import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { candidateStateCounts, publicationChange24h, listAdminReviewEntries, reviewQueueAiDecisions, reviewQueueCauses, REVIEW_QUEUE_SCAN_LIMIT, REVIEW_SORTS, type ReviewAiDecision, type ReviewSort } from "@/lib/crawl/admin-review";
import { getSettings } from "@/lib/crawl/settings";
import { REVIEW_REJECT_REASONS } from "@/lib/crawl/review";
import { takedownSummary } from "@/lib/domain/products/takedown";
import { TakedownStrip } from "../TakedownStrip";
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
import { modelHealth } from "@/lib/operations/dashboard";
import { humanDecisions24h, taglineProgress, waitingAge } from "@/lib/crawl/review-overview";
import { ReviewStatusChips } from "./ReviewStatusChips";
import { ReviewStageRail } from "./ReviewStageRail";
import { ReviewTodo, type TodoCard } from "./ReviewTodo";
import { SecondVoterSwitch } from "./SecondVoterSwitch";
import { voterChoices } from "./voters";
import { listGatewayModels } from "@/lib/crawl/agent-review-gateway";
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
const BULK_FORM = "review-bulk";
const AI_FILTERS: [ReviewAiDecision, string][] = [['reject', '거부'], ['approve', '승인'], ['needs_review', '보류'], ['none', '판단 없음']];
/** 2차 심사 거르기 — 같은 결론끼리 모아 한 번에 확정한다 */
const SECOND_FILTERS = [['unanimous_reject', '만장일치·거부'], ['unanimous_approve', '만장일치·승인'],
  ['agreed_reject', '2표 일치·거부'], ['agreed_approve', '2표 일치·승인'], ['needs_human', '사람 확인']] as const;
type SecondFilter = typeof SECOND_FILTERS[number][0] | 'published';

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
  const second = ([...SECOND_FILTERS.map(([key]) => key), 'published'] as string[]).includes(one(params.second)) ? one(params.second) as SecondFilter : '';
  const q = one(params.q).trim().slice(0, 100);
  const updated = (UPDATED_WINDOWS.some(([value]) => value === one(params.updated)) ? one(params.updated) : '') as UpdatedWindow;
  const sort = ((REVIEW_SORTS as readonly string[]).includes(one(params.sort)) ? one(params.sort) : '') as ReviewSort;

  const settings = await getSettings();
  // 머리의 번역 진행·2차 표 전환은 느린 바깥 읽기다(번역 집계 캐시가 비면 2.2초, 게이트웨이 모델 목록 0.3~1.1초) —
  // 먼저 띄워 두고 그 자리만 따로 흘려보낸다. 모델 상태도 갈래 셈을 기다릴 까닭이 없어 같이 띄운다
  const translation = translationProgress().catch(() => null);
  // 2차 표 전환의 선택지 — 닿지 않으면 Grok·Claude 만
  const gatewayModels = listGatewayModels();
  const modelsLoad = modelHealth(settings).catch(() => null);
  const [takedowns, causes, decisions, seconds, stateCounts, publicationChange] = await Promise.all([takedownSummary().catch(() => null), reviewQueueCauses(settings), reviewQueueAiDecisions(), secondReviewSummary(settings.secondReview.agreeAt), candidateStateCounts(), publicationChange24h()]);
  const held = heldStages(decisions.ids, seconds.ids, [...(causes.ids.get('second_review_split') ?? []), ...(causes.ids.get('no_description') ?? [])]);
  const stageCount: Record<StageKey, number> = {
    judge: stateCounts.new, ai: held.ids.ai.length, second: held.ids.second.length, agreed: held.ids.agreed.length,
    human: held.ids.human.length, publish: stateCounts.approved, published: stateCounts.published, rejected: stateCounts.rejected,
  };
  // 머리 칩·할 일 카드의 숫자. 하나가 실패해도 큐는 그려야 하므로 각각 비운 채 넘긴다
  const [models, human, humanAge, taglines] = await Promise.all([
    modelsLoad,
    humanDecisions24h().catch(() => null),
    waitingAge(held.ids.human).catch(() => null),
    taglineProgress(causes.ids.get('no_description') ?? []).catch(() => null),
  ]);
  const currentVoter = settings.secondReview.voters[0] ?? null;

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
    search: q || undefined, pushedWithinDays: updated ? UPDATED_DAYS[updated] : undefined, sort,
  });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const query = (next: Partial<Record<'state' | 'stage' | 'cause' | 'ai' | 'second' | 'q' | 'updated' | 'sort' | 'page', string | number | undefined>>) => {
    const merged = { state: filtered || state === 'pending' ? undefined : state, stage: stage || undefined,
      cause: cause || undefined, ai: ai || undefined, second: second || undefined, q: q || undefined,
      updated: updated || undefined, sort: sort || undefined, ...next };
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) if (value !== undefined && value !== '' && !(key === 'page' && value === 1)) search.set(key, String(value));
    return `/admin/review${search.size ? `?${search}` : ''}`;
  };
  // 0건인 칩은 흐리게 — 자리는 그대로 두어 칩이 날마다 옮겨 다니지 않게 하고, 볼 것이 있는 칩만 눈에 띄게 한다
  const chip = (active: boolean, count?: number) => `rounded-full border px-2.5 py-1 text-[13px] ${active ? 'border-accent bg-accent-soft font-semibold text-accent'
    : count === 0 ? 'border-line bg-bg-card text-fg-3 hover:bg-bg-hover' : 'border-line bg-bg-card text-fg-2 hover:bg-bg-hover'}`;
  const resolved = causes.counts.find((row) => row.cause === "resolved");

  const n = (value: number) => value.toLocaleString("ko-KR");
  const causeCount = (key: CauseKey) => causes.counts.find((row) => row.cause === key)?.count ?? 0;
  const todo: TodoCard[] = [
    { key: 'agreed', title: '확정만 하면 됨 — 두 모델이 같은 결론', count: stageCount.agreed, tone: stageCount.agreed > 0 ? 'ok' : undefined,
      detail: `훑어보고 한 번에 확정 · 거부 ${n(held.agreedReject)} · 승인 ${n(held.agreedApprove)}`, href: '/admin/review?stage=agreed#review-list' },
    { key: 'human', title: '직접 판단 — 모델이 갈렸거나 표가 모자람', count: stageCount.human, tone: stageCount.human > 500 ? 'warn' : undefined,
      detail: `2차 갈림 ${n(causeCount('second_review_split'))} · 재시도 소진 ${n(causeCount('ai_review_exhausted'))} · 오래된 것부터`,
      href: '/admin/review?stage=human&sort=wait#review-list' },
    { key: 'tagline', title: '소개 문구 없음', count: causeCount('no_description'),
      detail: taglines ? `AI 소개 지음 ${n(taglines.written)} · 근거로는 모름 ${n(taglines.unknown)} · 실패 ${n(taglines.failed)} · 시도 전 ${n(taglines.untried)}`
        : '페이지를 열어 한 줄로 적으면 그 소개로 승인합니다', href: '/admin/review?cause=no_description#review-list' },
    // 내려달라는 요청은 머리의 한 줄(TakedownStrip)과 내릴 후보 화면이 맡는다 — 여기서는 2차가 다시 본 공개분만
    { key: 'published', title: '공개분 확인 — 2차가 다시 본 공개분', count: seconds.counts.published,
      detail: `내릴지 둘지 사람이 정합니다 · ${n(seconds.counts.published)}건`, href: '/admin/review?second=published#review-list' },
  ];
  // 보류 이유는 꼬리가 길다 — 앞의 일곱 개(와 지금 고른 것)만 칩으로, 나머지는 펼침 목록으로
  const CAUSE_CHIPS = 7;
  const visibleCauses = causes.counts.filter((row, index) => index < CAUSE_CHIPS || row.cause === cause);
  const moreCauses = causes.counts.filter((row) => !visibleCauses.includes(row));
  const causeChip = ({ cause: key, count }: { cause: CauseKey; count: number }) => (
    <Link key={key} href={query({ cause: cause === key ? undefined : key, state: undefined, page: 1 })}
      title={CAUSE_GUIDE[key].summary} aria-current={cause === key ? 'page' : undefined} className={chip(cause === key, count)}>
      {CAUSE_GUIDE[key].label} <span className="font-mono">{count.toLocaleString("ko-KR")}</span>
    </Link>
  );
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
          <Suspense fallback={<VoterSwitchPending model={currentVoter?.model ?? null} />}>
            <VoterSwitchSlot key={currentVoter ? `${currentVoter.provider}|${currentVoter.model}` : 'none'} current={currentVoter}
              gatewayModels={gatewayModels} firstModel={settings.firstReview?.model ?? null} />
          </Suspense>
          <ReviewModeForm key={settings.reviewMode} mode={settings.reviewMode} ready={process.env.CRAWL_REVIEW_READY === 'true'} />
        </div>
      </header>

      <ReviewStatusChips models={models} human={human} publication={publicationChange} takedowns={takedowns?.pending ?? 0} />

      <TakedownStrip summary={takedowns} />

      <ReviewStageRail stage={stage} counts={stageCount} agreed={{ reject: held.agreedReject, approve: held.agreedApprove }}
        publication={publicationChange} humanAge={humanAge} />

      <ReviewTodo cards={todo} />

      {/* 거르기 — 구간 안에서 더 좁힌다(겹쳐 고르면 겹치는 것만). 넷째 줄은 목록 자체의 검색·기간·정렬 */}
      <section className="dash-card" aria-label="거르기">
        <div className="rq-filters">
          <FilterRow label="보류 이유" hint="규칙이 멈춘 곳">
            {visibleCauses.map(causeChip)}
            {moreCauses.length > 0 && (
              <details className="rq-more">
                <summary className={chip(false)}>그 밖 {moreCauses.length}가지 ▾</summary>
                <div>{moreCauses.map(causeChip)}</div>
              </details>
            )}
          </FilterRow>
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
          {second !== 'published' && (
            <ListToolbar q={q} updated={updated} sort={sort} total={total} hiddenByAge={hiddenByAge}
              keep={{ state: filtered || state === 'pending' ? undefined : state, stage: stage || undefined, cause: cause || undefined, ai: ai || undefined, second: second || undefined }}
              clearHref={query({ q: undefined, updated: undefined, sort: undefined, page: 1 })} />
          )}
        </div>
      </section>

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
            entries={entries} reasons={REVIEW_REJECT_REASONS} bulkFormId={BULK_FORM} focus={focus}
            toolbar={<BulkDecision formId={BULK_FORM} reasons={REVIEW_REJECT_REASONS} title={listTitle} />}
            footer={pagination}
            sort={sort} sortHref={Object.fromEntries(REVIEW_SORTS.map((key) => [key, query({ sort: key || undefined, page: 1 })])) as Record<ReviewSort, string>}
            cause={cause} causes={[{ value: '', label: '갈래 전체', count: causes.total, href: query({ cause: undefined, state: undefined, page: 1 }) },
              ...causes.counts.map(({ cause: key, count }) => ({ value: key, label: CAUSE_GUIDE[key].label, count,
                href: query({ cause: key, state: undefined, page: 1 }) }))]} />
        )}
        {(second === 'published' || entries.length === 0) && pagination}
      </div>
    </main>
  );
}

/** 번역 진행이 오면 수를 붙인다 — 못 세면 수 없이 단추만 */
async function TranslationToggleSlot({ progress }: { progress: Promise<{ done: number; total: number } | null> }) {
  const value = await progress;
  return <ReasonLanguageToggle done={value?.done ?? null} total={value?.total ?? null} />;
}

/** 게이트웨이 모델 목록이 오면 2차 표 전환을 그린다 */
async function VoterSwitchSlot({ current, gatewayModels, firstModel }: {
  current: { provider: string; model: string } | null; gatewayModels: Promise<string[] | null>; firstModel: string | null;
}) {
  const models = await gatewayModels;
  return <SecondVoterSwitch current={current} choices={voterChoices(models, current, firstModel)} gatewayReachable={models !== null} />;
}

/** 목록을 기다리는 동안 — 지금 누가 2차를 보는지는 설정만으로 안다 */
function VoterSwitchPending({ model }: { model: string | null }) {
  return <p aria-busy="true" className="rounded-lg border border-line bg-bg-card px-3 py-1.5 text-[13px] font-semibold text-fg-2">
    2차 표 · <span className="font-mono text-accent">{model ?? '없음'}</span></p>;
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

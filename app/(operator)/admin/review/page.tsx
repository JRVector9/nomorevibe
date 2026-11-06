import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { listAdminReviewEntries, reviewQueueCauses } from "@/lib/crawl/admin-review";
import { getSettings } from "@/lib/crawl/settings";
import { REVIEW_REJECT_REASONS } from "@/lib/crawl/review";
import { humanQueueOverview } from "@/lib/crawl/review-overview";
import { readPublishedReviewPage } from "@/lib/crawl/published-review-page";
import { PageStamp } from "../components/PageStamp";
import { encodeReviewCursor } from "@/lib/crawl/admin-review-cursor";
import { PrototypeReviewConsole } from "./PrototypeReviewConsole";
import { prototypeReviewFilter, prototypeReviewNeeds, prototypeReviewOptions } from "./PrototypeReviewQuery";
import { STAGE_GROUPS } from "./stages";
import { PrototypeReviewFilters, PrototypeReviewLanguage, PrototypeReviewManagement } from "./PrototypeReviewPanels";
import { DeferredReviewPanel } from "./DeferredReviewPanel";
import { PrototypeReviewPublished } from "./PrototypeReviewPublished";
import "./PrototypeReview.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "검수 및 발행 — NoMoreVibe", robots: { index: false } };
type Search = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => typeof value === "string" ? value : "";
const PAGE_SIZE = 30;

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await currentAdmin(); if (!admin) redirect("/admin/login");
  const params = await searchParams;
  try { return await Workspace({ params }); }
  catch { return <main className="stack"><PageStamp /><h1 className="sr-only">검수 및 발행</h1><div className="notice amber" role="status">검수 데이터를 불러오지 못했습니다. 현재 후보 수와 상태는 확인할 수 없습니다. 새로고침해 다시 확인하세요.</div></main>; }
}

async function Workspace({ params }: { params: Search }) {
  const observedAt = new Date().getTime();
  const filter = prototypeReviewFilter(params);
  const filtersOpen = one(params.review_filters) === "1", managementOpen = one(params.review_management) === "1";
  const { tab, stage, cause, ai, second, q, updated, sort, rawState, reason } = filter;
  const rawPage = Number(one(params.page) || 1), page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const focusNumber = Number(one(params.focus) || one(params.id)), focus = Number.isSafeInteger(focusNumber) && focusNumber > 0 ? focusNumber : undefined;
  const settings = await getSettings();
  // Share only this render's Promise. Filter membership is never served from a stale display cache.
  let causesRead: ReturnType<typeof reviewQueueCauses> | undefined;
  const loadCauses = () => causesRead ??= reviewQueueCauses(settings);
  const needs = prototypeReviewNeeds(filter);
  const [causes, overview] = await Promise.all([
    needs.causes ? loadCauses() : null,
    needs.overview ? humanQueueOverview(settings) : null,
  ]);
  const options = prototypeReviewOptions(filter, causes, overview);
  const state = options.state!;
  const publishedPage = second === "published" ? await readPublishedReviewPage(undefined, q) : null;
  const publishedRows = publishedPage?.rows ?? null;
  const queue = publishedRows ? { entries: [], total: publishedPage?.total ?? 0, hiddenByAge: 0 } : await listAdminReviewEntries(settings, { ...options, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const focusedEntry = second !== "published" && focus && !queue.entries.some(entry => entry.candidate.id === focus)
    ? (await listAdminReviewEntries(settings, { state: "all", ids: [focus], limit: 1 })).entries[0] ?? null : null;
  const query = (patch: Record<string, string | number | undefined> = {}) => {
    const search = new URLSearchParams(); const values = { tab, state: rawState || undefined, stage: stage || undefined, cause: cause || undefined, ai: ai || undefined,
      second: second || undefined, q: q || undefined, updated: updated || undefined, sort: sort || undefined,
      reason: reason || undefined,
      review_filters: filtersOpen ? "1" : undefined, review_management: managementOpen ? "1" : undefined, ...patch };
    for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") search.set(key, String(value));
    // The empty sort is an explicit incoming-order choice; omitting it selects recent waiting order.
    if (second !== "published") search.set("sort", sort);
    return `/admin/review?${search}`;
  };
  const listTitle = second === "published" ? "공개 후 다시 확인할 프로젝트" : tab === "human" ? "지금 사람이 확인할 후보"
    : tab === "publish" ? "승인 후 발행을 기다리는 후보" : tab === "rejected" ? "반려 기록" : "모든 단계의 후보";
  const exportQuery = new URLSearchParams(query().split("?")[1]); exportQuery.set("state", state);
  const scrollQuery = new URLSearchParams(query().split("?")[1]);
  const nextCursor = "nextCursor" in queue ? encodeReviewCursor(queue.nextCursor ?? null, filter) : null;

  return <main className="stack prototype-review"><PageStamp /><h1 className="sr-only">검수 및 발행</h1>
    <div className="toolbar"><Link href="/admin/settings?tab=collection" className="button">심사 운영 설정</Link>{(tab === "publish" || stage === "publish") && second !== "published" && <Link href="/admin/status?tab=manual" prefetch={false} className="button">수동 카테고리 지정·발행 검토</Link>}{second !== "published" && <a href={`/admin/export?view=review&format=csv&${exportQuery}`} className="button">CSV 내보내기</a>}<span className="spacer" /><Suspense fallback={null}><PrototypeReviewLanguage /></Suspense></div>
    <form action="/admin/review" className="toolbar"><input type="hidden" name="tab" value={tab} />{filtersOpen && <input type="hidden" name="review_filters" value="1" />}{managementOpen && <input type="hidden" name="review_management" value="1" />}{rawState && <input type="hidden" name="state" value={rawState} />}{reason && <input type="hidden" name="reason" value={reason} />}<input className="search-input" type="search" name="q" defaultValue={q} maxLength={100} aria-label="후보 검색" placeholder="후보명·저장소 검색 후 Enter" />
      {second !== "published" && <select name="stage" defaultValue={stage} aria-label="후보 단계"><option value="">{tab === "human" ? "사람 확인 대상 전체" : "단계 전체"}</option>{STAGE_GROUPS.flatMap(group => group.stages).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select>}
      {second !== "published" && <select name="sort" defaultValue={sort} aria-label="후보 정렬"><option value="wait">오래 기다린 순</option><option value="wait_short">최근 대기순</option><option value="">들어온 순</option><option value="stars">별 많은 순</option><option value="push">최근 푸시순</option><option value="push_old">오래된 푸시순</option></select>}
      {cause && <input type="hidden" name="cause" value={cause} />}{ai && <input type="hidden" name="ai" value={ai} />}{second && <input type="hidden" name="second" value={second} />}{updated && <input type="hidden" name="updated" value={updated} />}<button className="button">조회</button><span className="spacer small muted">{second === "published" ? `공개분 확인 ${queue.total.toLocaleString("ko-KR")}건` : `전체 ${queue.total.toLocaleString("ko-KR")}건 · 처음 30개 이후 스크롤 추가 조회`}</span>
    </form>
    {second !== "published" ? <DeferredReviewPanel panel="filters" expanded={filtersOpen} title="갈래·AI 판단·기간으로 더 좁히기">{filtersOpen && <Suspense fallback={<p className="panel-body small muted" role="status">갈래 집계를 읽는 중입니다.</p>}><PrototypeReviewFilters filter={filter} loadCauses={loadCauses} /></Suspense>}</DeferredReviewPanel> : <Link className="text-button" href={`/admin/review?tab=${tab}`}>후보 단계 검수로 돌아가기 →</Link>}
    {queue.hiddenByAge > 0 && <p className="small muted">최근 푸시 조건으로 {queue.hiddenByAge.toLocaleString("ko-KR")}건을 목록에서 제외했습니다. 후보 상태는 유지됩니다.</p>}
    {second === "published" ? <PrototypeReviewPublished rows={publishedRows ?? []} total={publishedPage?.total} nextCursor={publishedPage?.nextCursor} q={q} />
      : <PrototypeReviewConsole key={`${page}:${tab}:${state}:${stage}:${cause}:${ai}:${second}:${q}:${updated}:${sort}:${reason}`} now={observedAt} entries={queue.entries} focusedEntry={focusedEntry} nextCursor={nextCursor} scrollQuery={scrollQuery.toString()} reasons={REVIEW_REJECT_REASONS} focus={focus} title={listTitle} total={queue.total} />}
    <DeferredReviewPanel panel="management" expanded={managementOpen} title="심사 운영·보류 재심사 관리">{managementOpen && <Suspense fallback={<p className="panel-body small muted" role="status">심사 운영 상태를 읽는 중입니다.</p>}><PrototypeReviewManagement settings={settings} loadCauses={loadCauses} /></Suspense>}</DeferredReviewPanel>
  </main>;
}

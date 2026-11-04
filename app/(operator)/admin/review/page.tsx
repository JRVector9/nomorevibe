import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { currentModelEnv } from "@/lib/operations/model-env";
import { listAdminReviewEntries, reviewQueueCauses } from "@/lib/crawl/admin-review";
import { getSettings } from "@/lib/crawl/settings";
import { REVIEW_REJECT_REASONS } from "@/lib/crawl/review";
import { humanQueueOverview } from "@/lib/crawl/review-overview";
import { publishedSecondReviews } from "@/lib/crawl/second-review";
import { translationsFor } from "@/lib/crawl/translations";
import { heldQwenRetryStatus } from "@/lib/crawl/held-qwen-retry";
import { splitTiebreakStatus } from "@/lib/crawl/gate-split-tiebreak-read";
import { PageStamp } from "../components/PageStamp";
import { pageWindow } from "../paging";
import { CAUSE_GUIDE } from "./causes";
import { SECOND_FILTERS, STAGE_GROUPS } from "./stages";
import { UPDATED_WINDOWS } from "./ListToolbar";
import { PrototypeReviewConsole } from "./PrototypeReviewConsole";
import { prototypeReviewFilter, prototypeReviewOptions, PROTOTYPE_AI_FILTERS } from "./PrototypeReviewQuery";
import { PrototypeReviewPublished } from "./PrototypeReviewPublished";
import { ReasonLanguageToggle } from "./ReasonText";
import { RequeueResolved } from "./RequeueResolved";
import { SplitTiebreakSwitch } from "./SplitTiebreakSwitch";
import { HeldQwenRetryPanel } from "./HeldQwenRetryPanel";
import "./PrototypeReview.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "검수 및 발행 — NoMoreVibe", robots: { index: false } };
type Search = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => typeof value === "string" ? value : "";
const PAGE_SIZE = 50;

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await currentAdmin(); if (!admin) redirect("/admin/login");
  const params = await searchParams;
  try { return await Workspace({ params }); }
  catch { return <main className="stack"><PageStamp /><h1 className="sr-only">검수 및 발행</h1><div className="notice amber" role="status">검수 데이터를 불러오지 못했습니다. 현재 후보 수와 상태는 확인할 수 없습니다. 새로고침해 다시 확인하세요.</div></main>; }
}

async function Workspace({ params }: { params: Search }) {
  const observedAt = new Date().getTime();
  const filter = prototypeReviewFilter(params);
  const { tab, stage, cause, ai, second, q, updated, sort, rawState } = filter;
  const rawPage = Number(one(params.page) || 1), page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const focusNumber = Number(one(params.focus) || one(params.id)), focus = Number.isSafeInteger(focusNumber) && focusNumber > 0 ? focusNumber : undefined;
  const settings = await getSettings();
  const [causes, overview] = await Promise.all([reviewQueueCauses(settings), humanQueueOverview(settings)]);
  const options = prototypeReviewOptions(filter, causes, overview);
  const state = options.state!;
  const publishedSource = second === "published" ? await (async () => { const rows = await publishedSecondReviews(); const korean = await translationsFor(rows.flatMap(row => [row.secondReason, row.autoOpinion?.reason ?? null])); return rows.map(row => ({ id: row.id, slug: row.publishedSlug ?? "", repo: row.repo, decision: row.secondDecision, confidence: row.secondConfidence, reason: row.secondReason, reasonKo: row.secondReason ? korean.get(row.secondReason) ?? null : null, trigger: row.trigger, signals: row.signals, qwen: row.autoOpinion ? { decision: row.autoOpinion.decision, confidence: row.autoOpinion.confidence, reason: row.autoOpinion.reason, reasonKo: row.autoOpinion.reason ? korean.get(row.autoOpinion.reason) ?? null : null } : null })); })() : null;
  const publishedRows = publishedSource?.filter(row => !q || `${row.slug} ${row.repo} ${row.reason ?? ""}`.toLocaleLowerCase().includes(q.toLocaleLowerCase())) ?? null;
  const queue = publishedRows ? { entries: [], total: publishedRows.length, hiddenByAge: 0 } : await listAdminReviewEntries(settings, { ...options, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const pages = Math.max(1, Math.ceil(queue.total / PAGE_SIZE));
  const query = (patch: Record<string, string | number | undefined> = {}) => {
    const search = new URLSearchParams(); const values = { tab, state: rawState || undefined, stage: stage || undefined, cause: cause || undefined, ai: ai || undefined,
      second: second || undefined, q: q || undefined, updated: updated || undefined, sort: sort || undefined, ...patch };
    for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") search.set(key, String(value));
    return `/admin/review?${search}`;
  };
  const listTitle = second === "published" ? "공개 후 다시 확인할 프로젝트" : tab === "human" ? "지금 사람이 확인할 후보"
    : tab === "publish" ? "승인 후 발행을 기다리는 후보" : tab === "rejected" ? "반려 기록" : "모든 단계의 후보";
  const resolved = causes.counts.find(row => row.cause === "resolved");
  const [heldQwen, tiebreak, modelEnv] = await Promise.all([heldQwenRetryStatus(settings).catch(() => null), splitTiebreakStatus().catch(() => null), currentModelEnv().catch(() => null)]);
  const exportQuery = new URLSearchParams(query().split("?")[1]); exportQuery.set("state", state);
  const pagination = pages > 1 ? <nav aria-label="검수 목록 페이지" className="flex">{page > 1 && <Link className="button small" href={query({ page: page - 1 })}>이전</Link>}{pageWindow(page, pages).map((item, index) => item === null ? <span key={`gap:${index}`}>…</span> : <Link className={`button small${page === item ? " primary" : ""}`} key={`page:${item}`} aria-current={page === item ? "page" : undefined} href={query({ page: item })}>{item}</Link>)}{page < pages && <Link className="button small" href={query({ page: page + 1 })}>다음</Link>}</nav> : null;
  return <main className="stack prototype-review"><PageStamp /><h1 className="sr-only">검수 및 발행</h1>
    <div className="toolbar"><Link href="/admin/settings?tab=collection" className="button">심사 운영 설정</Link>{(tab === "publish" || stage === "publish") && second !== "published" && <Link href="/admin/status?tab=manual" prefetch={false} className="button">수동 카테고리 지정·발행 검토</Link>}{second !== "published" && <a href={`/admin/export?view=review&format=csv&${exportQuery}`} className="button">CSV 내보내기</a>}<span className="spacer" /><ReasonLanguageToggle model={modelEnv?.translate || "작업별 순위에서 확인"} done={null} total={null} /></div>
    <form action="/admin/review" className="toolbar"><input type="hidden" name="tab" value={tab} />{rawState && <input type="hidden" name="state" value={rawState} />}<input className="search-input" type="search" name="q" defaultValue={q} maxLength={100} aria-label="후보 검색" placeholder="후보명·저장소 검색 후 Enter" />
      {second !== "published" && <select name="stage" defaultValue={stage} aria-label="후보 단계"><option value="">{tab === "human" ? "사람 확인 대상 전체" : "단계 전체"}</option>{STAGE_GROUPS.flatMap(group => group.stages).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select>}
      {second !== "published" && <select name="sort" defaultValue={sort} aria-label="후보 정렬"><option value="wait">오래 기다린 순</option><option value="wait_short">최근 대기순</option><option value="">들어온 순</option><option value="stars">별 많은 순</option><option value="push">최근 푸시순</option><option value="push_old">오래된 푸시순</option></select>}
      {cause && <input type="hidden" name="cause" value={cause} />}{ai && <input type="hidden" name="ai" value={ai} />}{second && <input type="hidden" name="second" value={second} />}{updated && <input type="hidden" name="updated" value={updated} />}<button className="button">조회</button><span className="spacer small muted">{second === "published" ? `공개분 확인 ${queue.total.toLocaleString("ko-KR")}건` : `전체 ${queue.total.toLocaleString("ko-KR")}건 · ${page}/${pages}쪽`}</span>
    </form>
    {second !== "published" ? <details className="panel"><summary>갈래·AI 판단·기간으로 더 좁히기</summary><form action="/admin/review" className="panel-body toolbar"><input type="hidden" name="tab" value={tab} />{rawState && <input type="hidden" name="state" value={rawState} />}<input type="hidden" name="stage" value={stage} /><input type="hidden" name="q" value={q} /><input type="hidden" name="sort" value={sort} />
      <select name="cause" defaultValue={cause} aria-label="검수 갈래"><option value="">갈래 전체</option>{causes.counts.map(row => <option value={row.cause} key={row.cause}>{CAUSE_GUIDE[row.cause].label} · {row.count}</option>)}</select>
      <select name="ai" defaultValue={ai} aria-label="1차 AI 판단"><option value="">1차 판단 전체</option>{PROTOTYPE_AI_FILTERS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select name="second" defaultValue={second} aria-label="2차 판단"><option value="">2차 판단 전체</option>{SECOND_FILTERS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="published">공개분 확인</option></select>
      <select name="updated" defaultValue={updated} aria-label="최근 푸시 기간">{UPDATED_WINDOWS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button className="button">적용</button><Link className="text-button" href={`/admin/review?tab=${tab}`}>조건 초기화</Link>
    </form></details> : <Link className="text-button" href={`/admin/review?tab=${tab}`}>후보 단계 검수로 돌아가기 →</Link>}
    {queue.hiddenByAge > 0 && <p className="small muted">최근 푸시 조건으로 {queue.hiddenByAge.toLocaleString("ko-KR")}건을 목록에서 제외했습니다. 후보 상태는 유지됩니다.</p>}
    {second === "published" ? <PrototypeReviewPublished rows={publishedRows ?? []} />
      : <PrototypeReviewConsole key={`${page}:${tab}:${state}:${stage}:${cause}:${ai}:${second}:${q}:${updated}:${sort}`} now={observedAt} entries={queue.entries} reasons={REVIEW_REJECT_REASONS} focus={focus} title={listTitle} total={queue.total} footer={pagination} />}
    <details className="panel"><summary>심사 운영·보류 재심사 관리</summary><div className="panel-body stack">{resolved && <RequeueResolved count={resolved.count} />}<SplitTiebreakSwitch value={settings.qwenAuto.splitTiebreak} status={tiebreak} /><HeldQwenRetryPanel status={heldQwen} /><p className="small muted">운영 설정은 현재 값을 다시 확인하고 변경 사유를 남기는 기존 절차를 사용합니다.</p></div></details>
  </main>;
}

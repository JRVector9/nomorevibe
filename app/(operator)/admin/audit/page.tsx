import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { auditDecisionHistory, auditFindingReasons, auditRemovalGroups, GROUP_REMOVE_MAX, GROUP_REMOVE_MIN_CONFIDENCE, heldFindingReasons,
  listAuditFindings, listHeldFindings, productAuditOverview, type AuditOverview } from "@/lib/crawl/product-audit";
import { AUDIT_REASON_CATEGORIES, AUDIT_REASON_KEYS, classifyAuditReason, groupAuditReasons, isAuditReasonCategory,
  type AuditReasonCategory } from "@/lib/crawl/audit-reason-category";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { translationsFor } from "@/lib/crawl/translations";
import { formatListTime } from "@/lib/format/time";
import { AuditFinding } from "./AuditFinding";
import { AuditGroups } from "./AuditGroups";
import { AuditHoldSettingsForm, CancelAudit, ReleaseAllHolds, RestartStalledAudit, StartAudit } from "./AuditControls";
import { ScrollTable } from "../components/ScrollTable";
import { ReasonLanguageToggle, ReasonText } from "../review/ReasonText";
import { pageWindow } from "../paging";
import { IntroRequestList, TakedownQueue } from "./TakedownQueue";
import { introRequestQueue, pendingIntroRequestCount } from "@/lib/domain/products/intro-requests";
import { takedownHistory, takedownQueue, takedownSummary } from "@/lib/domain/products/takedown";
import { DISMISS_REASONS, formatWait, isBurst, isDismissReason, senderLabel, takedownSignal, type TakedownSummary } from "@/lib/domain/products/takedown-view";
import "../status/dashboard/dashboard.css";
import "./takedown.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "내릴 후보 — NoMoreVibe", robots: { index: false } };

/** 한 쪽. 줄마다 사람이 페이지를 열어 보고 누르므로 한 화면에 다 들어갈 필요가 없다 */
const PAGE_SIZE = 50;

/**
 * 갈래 — 모델이 "아니다"라고 한 것과 "모르겠다"고 한 것. 둘 다 사람이 본다.
 * 보류 중: 감사 보류로 이미 공개 목록에서 빠져 사람을 기다리는 것(회차와 상관없이, 오래된 것부터) — 있으면 이 갈래부터 연다.
 * 두 모델 모두 거절·갈림: 내릴 후보 중 두 번째 모델(audit-second-opinions.ts)도 거절한 것과, 두 번째 모델은 승인한 것
 */
const VIEWS = {
  held: { label: "보류 중(목록에서 빠짐)", empty: "보류 중인 것이 없습니다." },
  reject: { label: "내릴 후보", empty: "사람이 볼 내릴 후보가 없습니다." },
  agreed: { label: "두 모델 모두 거절", empty: "두 번째 모델도 거절한 내릴 후보가 없습니다." },
  split: { label: "갈림 (2차 승인)", empty: "두 번째 모델이 승인한 내릴 후보가 없습니다." },
  needs_review: { label: "판단 보류", empty: "AI가 판단을 미룬 것이 없습니다." },
} as const;
type View = keyof typeof VIEWS;

const STATUS: Record<string, string> = { running: "진행 중", done: "끝남", cancelled: "중단됨" };
const count = (value: number) => value.toLocaleString("ko-KR");

type Props = { searchParams: Promise<{ view?: string; page?: string; tab?: string; reason?: string }> };

/**
 * 탭 — 사람이 부탁한 것(내려달라는 요청), 감사가 걸러낸 것, 처리 기록. 기다리는 요청이 있으면 요청이 먼저다:
 * 상세 페이지가 내려 준다고 약속했다. 감사의 갈래(?view=)로 들어오면 감사 탭이다.
 */
const TABS = { requests: "내려달라는 요청", audit: "감사 거절", history: "처리 기록" } as const;
type Tab = keyof typeof TABS;

export default async function AdminAuditPage({ searchParams }: Props) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const { view: rawView, page: rawPage, tab: rawTab, reason: rawReason } = await searchParams;
  // 사유 갈래 — 모델의 사유 문장을 낱말로 나눈 것(audit-reason-category). 판단은 바꾸지 않고 묶어 보기만 한다
  const reason: AuditReasonCategory | null = isAuditReasonCategory(rawReason) ? rawReason : null;
  const parsedPage = Number(rawPage ?? 1);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;

  // 목록의 "13:38 (3분 전)"은 이 시각을 기준으로 센다
  const now = new Date();
  const [overview, summary, introPending] = await Promise.all([productAuditOverview(), takedownSummary(), pendingIntroRequestCount()]);
  const { campaign, counts } = overview;
  // 보류 중인 것이 있으면 그것부터 — 이미 목록에서 빠져 사람을 기다린다.
  // `in`은 프로토타입 키까지 통과시킨다 — 제품 관리의 ?filter=constructor 와 같은 함정
  const defaultView: View = overview.held > 0 ? "held" : "reject";
  const view: View = rawView && Object.hasOwn(VIEWS, rawView) ? rawView as View : defaultView;
  // 소개 수정 요청(UX-18)도 요청 탭에 있다 — 그것만 기다려도 요청 탭을 먼저 연다
  const tab: Tab = rawTab && Object.hasOwn(TABS, rawTab) ? rawTab as Tab : rawView ? "audit" : summary.pending + introPending > 0 ? "requests" : "audit";
  const [queue, introRequests, history, auditHistory] = await Promise.all([
    tab === "requests" ? takedownQueue() : Promise.resolve([]),
    tab === "requests" ? introRequestQueue() : Promise.resolve([]),
    tab === "history" ? takedownHistory() : Promise.resolve([]),
    tab === "history" ? auditDecisionHistory() : Promise.resolve([]),
  ]);
  const auditHistoryKorean = auditHistory.length ? await translationsFor(auditHistory.map((row) => row.reason)) : new Map<string, string>();
  const open: Record<View, number> = { held: overview.held, reject: counts.openReject, agreed: counts.openAgreed, split: counts.openSplit,
    needs_review: counts.openNeedsReview };
  // 보류 갈래의 사유는 패널의 갈래별 수에도 쓴다 — 감사 탭이면 늘 읽는다(보류된 것만, 수천 건 안)
  const heldReasonIds = tab === "audit" ? groupAuditReasons(await heldFindingReasons()) : null;
  const second = view === "agreed" || view === "split" ? view : undefined;
  const decision = view === "needs_review" ? "needs_review" : "reject";
  const reasonIds = !campaign || tab !== "audit" ? null : view === "held" ? heldReasonIds
    : groupAuditReasons(await auditFindingReasons(campaign.id, decision, second));
  const filteredIds = reason && reasonIds ? reasonIds[reason] : undefined;
  const paging = { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, ids: filteredIds };
  const [findings, groups] = campaign && tab === "audit" ? await Promise.all([
    view === "held" ? listHeldFindings(paging) : listAuditFindings(campaign.id, decision, { ...paging, second }),
    view === "reject" ? auditRemovalGroups(campaign.id)
      : view === "held" || view === "agreed" ? auditRemovalGroups(campaign.id, view) : Promise.resolve([]),
  ]) : [[], []];
  // 사유의 한국어 — 미리 옮겨 둔 것이 있을 때만(lib/crawl/translations). 없으면 원문과 "번역 대기"
  const korean = findings.length ? await translationsFor(findings.map((finding) => finding.reason)) : new Map<string, string>();
  const pages = Math.max(1, Math.ceil((filteredIds?.length ?? open[view]) / PAGE_SIZE));
  // 갈래를 바꾸면(view) 사유 거르기는 푼다 — 두 갈래의 사유는 섞여 세지 않는다
  const href = (nextView: View, nextPage = 1, nextReason: AuditReasonCategory | null = nextView === view ? reason : null) => {
    const params = new URLSearchParams({ tab: "audit" });
    if (nextView !== defaultView) params.set("view", nextView);
    if (nextReason) params.set("reason", nextReason);
    if (nextPage > 1) params.set("page", String(nextPage));
    return `/admin/audit${params.size ? `?${params}` : ""}`;
  };

  const signal = takedownSignal(summary);
  const auditOpen = open.reject + open.needs_review;
  return (
    <main className="flex flex-col gap-3 pb-10 pt-6">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line pb-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-[22px] font-extrabold tracking-tight">내릴 후보</h1>
          <span className="text-[13px] text-fg-3">공개된 것 중 내릴지 정할 것 — 사람이 부탁한 것과 감사가 걸러낸 것</span>
        </div>
        <TakedownChips summary={summary} />
      </div>

      <nav className="td-tabs" aria-label="내릴 후보 갈래">
        {(Object.keys(TABS) as Tab[]).map((name) => (
          <Link key={name} href={`/admin/audit?tab=${name}`} aria-current={name === tab ? "page" : undefined}>
            {TABS[name]}
            {name === "requests" && (signal ? <b className="admin-nav-badge" data-tone={signal.tone}>{count(summary.pending)}</b> : <span className="td-count">0</span>)}
            {name === "requests" && introPending > 0 && <span className="td-count">소개 {count(introPending)}</span>}
            {name === "audit" && <span className="td-count">{count(auditOpen)}</span>}
            {name === "audit" && overview.held > 0 && <span className="td-count">보류 {count(overview.held)}</span>}
          </Link>
        ))}
      </nav>

      {tab === "requests" && (
        <>
          {isBurst(summary) && (
            <div className="td-burst" role="status">
              <i aria-hidden />
              <div>
                <b>지난 1시간에 요청 {count(summary.lastHour.requests)}건 — 평소(하루 0~1건)보다 훨씬 많습니다.</b><br />
                서로 다른 계정 {count(summary.lastHour.owners)}곳 · 보낸이 {count(summary.lastHour.senders)} · 사유 없음 {count(summary.lastHour.noReason)}건
                {summary.lastHour.topReason && summary.lastHour.topReason.count > 1 && ` · 같은 사유 "${summary.lastHour.topReason.text.slice(0, 40)}" ${summary.lastHour.topReason.count}건`}.
                장난일 수 있으니 &ldquo;같은 보낸이&rdquo;나 &ldquo;들어온 시각&rdquo;으로 묶어 확인하세요.
              </div>
            </div>
          )}
          <TakedownQueue entries={queue} />
          <IntroRequestList entries={introRequests} />
        </>
      )}

      {tab === "history" && <>
        <h2 className="text-[15px] font-bold">내려달라는 요청</h2>
        <TakedownHistory rows={history} now={now} />
        <h2 className="mt-3 text-[15px] font-bold">감사 처리</h2>
        <AuditHistory rows={auditHistory} korean={auditHistoryKorean} now={now} />
      </>}

      {tab === "audit" && <>
      <p className="max-w-[80ch] text-[13px] leading-[1.7] text-fg-2">
        이미 공개된 제품을 1차 심사 글로 다시 본 결과입니다. 감사는 <b className="font-semibold">아무것도 내리지 않습니다</b> —
        AI가 제품이 아니라고 했거나 판단을 미룬 것을 여기 모을 뿐입니다. 확신이 높고 사유 갈래가 확실한 것(또는 두 번째 모델도 거절한 것)은
        <b className="font-semibold"> 보류</b> — 차단하지 않고 공개 목록에서만 빼 사람을 기다립니다. 주소를 열어 확인하고 한 건씩
        <b className="font-semibold"> 내리기</b>(차단 — 행은 남고 제품 관리에서 되돌릴 수 있음) 또는
        <b className="font-semibold"> 유지</b>(90일 동안, 페이지가 그대로인 한 다음 감사에서 뺌)를 누릅니다.
        확신이 아주 높은 것은 같은 분류끼리 묶어 이름을 훑고 한 번에 내릴 수 있습니다.
      </p>

      <CampaignPanel overview={overview} now={now} />
      <HoldPanel overview={overview} heldReasons={heldReasonIds} />

      {campaign && (
        <>
          <AuditGroups groups={groups} minConfidence={GROUP_REMOVE_MIN_CONFIDENCE} max={GROUP_REMOVE_MAX} />

          <nav className="flex flex-wrap items-center gap-1.5">
            {(Object.keys(VIEWS) as View[]).map((name) => (
              <Link key={name} href={href(name)} aria-current={name === view ? "page" : undefined}
                className={`rounded-full border px-2.5 py-1 text-[13px] ${
                  name === view ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line bg-bg-card text-fg-2 hover:bg-bg-hover"
                }`}>
                {VIEWS[name].label} {count(open[name])}
              </Link>
            ))}
            <span className="ml-auto flex flex-wrap items-center gap-3">
              <ReasonLanguageToggle done={null} total={null} />
              {/* 내보내기의 view 는 화면 갈래라 감사의 갈래는 decision 으로 싣는다 — 보류·두 번째 의견 갈래는 내보내지 않는다 */}
              {(view === "reject" || view === "needs_review") &&
                <a href={`/admin/export?view=audit&format=csv&decision=${view}`} className="text-[13px] text-accent hover:underline">CSV 내보내기</a>}
            </span>
          </nav>

          {reasonIds && <ReasonChips counts={reasonIds} total={open[view]} active={reason} href={(next) => href(view, 1, next)} />}

          {findings.length === 0 ? (
            <p className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">
              {reason ? `‘${AUDIT_REASON_CATEGORIES[reason].label}’ 갈래에 남은 것이 없습니다.` : VIEWS[view].empty}</p>
          ) : (
            // relative: 표 머리의 sr-only(절대 위치)가 가로 스크롤 상자를 벗어나 390px 화면 전체를 넓히지 않게
            <div className="relative overflow-hidden rounded-[12px] border border-line bg-bg-card">
              <ScrollTable label="감사가 짚은 제품">
              <table className="w-full min-w-[760px] text-[13px]">
                <thead className="bg-bg-soft text-left text-fg-3">
                  <tr>
                    <th className="px-3 py-2 font-semibold">제품 · AI 사유</th>
                    <th className="px-2 py-2 font-semibold">지금 분류</th>
                    <th className="px-2 py-2 font-semibold">확신 · 본 시각</th>
                    <th className="px-3 py-2"><span className="sr-only">결정</span></th>
                  </tr>
                </thead>
                <tbody>
                  {findings.map((finding) => (
                    <AuditFinding key={finding.id} finding={{ ...finding, reasonKo: finding.reason ? korean.get(finding.reason) ?? null : null,
                      reasonCategory: AUDIT_REASON_CATEGORIES[classifyAuditReason(finding.reason)].label,
                      reviewedAt: finding.reviewedAt ? formatListTime(finding.reviewedAt, now) : null,
                      heldAt: finding.heldAt ? formatListTime(finding.heldAt, now) : null }} />
                  ))}
                </tbody>
              </table>
              </ScrollTable>
            </div>
          )}

          {pages > 1 && (
            <nav aria-label="내릴 후보 쪽 이동" className="flex flex-wrap items-center gap-1 text-[13px]">
              {page > 1 && <Link href={href(view, page - 1)} className="rounded-lg border border-line px-2.5 py-1">이전</Link>}
              {pageWindow(page, pages).map((item, i) => item === null
                ? <span key={`gap-${i}`} className="px-1 text-fg-3">…</span>
                : <Link key={item} href={href(view, item)} aria-current={item === page ? "page" : undefined}
                    className={`min-w-8 rounded-lg border px-2.5 py-1 text-center font-mono ${item === page ? "border-accent bg-accent text-white" : "border-line text-fg-2"}`}>{item}</Link>)}
              {page < pages && <Link href={href(view, page + 1)} className="rounded-lg border border-line px-2.5 py-1">다음</Link>}
            </nav>
          )}
        </>
      )}
      </>}
    </main>
  );
}

/**
 * 사유 갈래 칩 — 내릴 까닭이 같은 것끼리 몰아 본다(2026-10-11 운영자 요청). 수는 지금 갈래(view)의 사람이 볼 것 전부를 센다.
 * 많은 갈래부터, '기타'는 맨 뒤. 0건인 갈래는 빼서 칩이 할 일만 보이게 한다
 */
function ReasonChips({ counts, total, active, href }: {
  counts: Record<AuditReasonCategory, number[]>; total: number; active: AuditReasonCategory | null; href: (reason: AuditReasonCategory | null) => string;
}) {
  const keys = AUDIT_REASON_KEYS.filter((key) => counts[key].length > 0)
    .sort((a, b) => Number(a === "other") - Number(b === "other") || counts[b].length - counts[a].length);
  if (keys.length === 0) return null;
  const chip = (on: boolean) => `rounded-full border px-2.5 py-1 text-[13px] ${on ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line bg-bg-card text-fg-2 hover:bg-bg-hover"}`;
  return (
    <nav aria-label="내릴 사유 갈래" className="flex flex-wrap items-center gap-1.5">
      <span className="text-[13px] font-semibold text-fg-3">사유</span>
      <Link href={href(null)} aria-current={active === null ? "page" : undefined} className={chip(active === null)}>전체 {count(total)}</Link>
      {keys.map((key) => (
        <Link key={key} href={href(key)} aria-current={active === key ? "page" : undefined} title={AUDIT_REASON_CATEGORIES[key].hint} className={chip(active === key)}>
          {AUDIT_REASON_CATEGORIES[key].label} {count(counts[key].length)}
        </Link>
      ))}
    </nav>
  );
}

/** 머리 칩 — 24시간 넘은 요청, 지난 24시간 처리, 지난 30일 처리 */
function TakedownChips({ summary }: { summary: TakedownSummary }) {
  return (
    <div className="dash-chips" aria-label="요청 처리 요약">
      {summary.overdue > 0 && <span className="dash-pill" data-tone="bad"><span className="dash-dot" data-tone="bad" aria-hidden />24시간 넘음 {count(summary.overdue)}
        {summary.oldestHours !== null && ` · 최장 ${formatWait(summary.oldestHours)}`}</span>}
      <span className="dash-pill">24h 처리 {count(summary.handled24h.removed + summary.handled24h.dismissed)} · 내림 {count(summary.handled24h.removed)}</span>
      <span className="dash-pill">30일 · 내림 {count(summary.last30d.removed)} · 둠 {count(summary.last30d.dismissed)}</span>
    </div>
  );
}

/** 처리 기록 — 누가(어디서) 언제 내렸거나 두었고, 왜 두었는지. 관리자 작업 로그에서 읽으므로 지워지지 않는다 */
function TakedownHistory({ rows, now }: { rows: Awaited<ReturnType<typeof takedownHistory>>; now: Date }) {
  if (rows.length === 0) return <p className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">아직 처리한 요청이 없습니다.</p>;
  return (
    <div className="overflow-hidden rounded-[12px] border border-line bg-bg-card">
      <ScrollTable label="처리 기록">
      <table className="td-history">
        <thead><tr><th>제품</th><th>결과</th><th>요청 사유</th><th>메모</th><th>보낸이</th><th>처리</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td><b className="font-semibold">{row.name ?? row.slug}</b>{row.requestCount > 1 && <span className="text-fg-3"> · {row.requestCount}번 요청</span>}<br />
                <span className="font-mono text-fg-3">{row.url?.replace(/^https?:\/\//, "") ?? row.slug}</span></td>
              <td>{row.outcome === "removed" ? <span className="font-semibold text-down">내림</span>
                : <span className="font-semibold">둠{isDismissReason(row.dismissReason) ? ` · ${DISMISS_REASONS[row.dismissReason]}` : ""}</span>}</td>
              <td className="max-w-[320px] text-fg-2">{row.reason ?? <span className="text-fg-3">사유 없음</span>}</td>
              <td className="max-w-[240px] text-fg-2">{row.note ?? <span className="text-fg-3">—</span>}</td>
              <td className="font-mono text-fg-2">{senderLabel(row.requesterHash)}</td>
              <td className="whitespace-nowrap text-fg-3">{formatListTime(row.handledAt, now)} · {row.handledBy}{row.ip && <span className="font-mono"> · {row.ip}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </ScrollTable>
    </div>
  );
}

/**
 * 감사 처리 기록 — 감사 거절에서 사람이 내렸거나 둔 것. 무엇 때문에 내렸는지 사유 갈래와 AI 사유를 함께 보인다(2026-10-11 운영자 요청).
 * 내린 것은 차단 기록에도 같은 갈래가 남는다(product-audit.ts auditBanReason) — 제품 화면의 기록에서도 보인다
 */
function AuditHistory({ rows, korean, now }: { rows: Awaited<ReturnType<typeof auditDecisionHistory>>; korean: Map<string, string>; now: Date }) {
  if (rows.length === 0) return <p className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">아직 감사에서 처리한 것이 없습니다.</p>;
  const removed = rows.filter((row) => row.decision === "removed");
  const byCategory = AUDIT_REASON_KEYS.map((key) => [key, removed.filter((row) => classifyAuditReason(row.reason) === key).length] as const)
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return (
    <div className="overflow-hidden rounded-[12px] border border-line bg-bg-card">
      <p className="border-b border-line px-3 py-2 text-[13px] text-fg-2">
        최근 {count(rows.length)}건 · 내림 {count(removed.length)} · 유지 {count(rows.length - removed.length)}
        {byCategory.length > 0 && <> — 내린 사유: {byCategory.map(([key, n]) => `${AUDIT_REASON_CATEGORIES[key].label} ${count(n)}`).join(" · ")}</>}
      </p>
      <ScrollTable label="감사 처리 기록">
      <table className="td-history">
        <thead><tr><th>제품</th><th>결과</th><th>사유 갈래</th><th>AI 사유</th><th>메모</th><th>처리</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td><b className="font-semibold">{row.name}</b><br />
                <a href={row.url} target="_blank" rel="noreferrer noopener" className="break-all font-mono text-fg-3 hover:text-accent">{row.url.replace(/^https?:\/\//, "")}</a></td>
              <td>{row.decision === "removed" ? <span className="font-semibold text-down">내림</span> : <span className="font-semibold">유지</span>}</td>
              <td><span className="whitespace-nowrap rounded bg-bg-soft px-1.5 py-0.5 font-semibold text-fg-2">{AUDIT_REASON_CATEGORIES[classifyAuditReason(row.reason)].label}</span></td>
              <td className="max-w-[360px] text-fg-2">{row.reason
                ? <span className="line-clamp-3"><ReasonText text={row.reason} korean={korean.get(row.reason) ?? null} /></span>
                : <span className="text-fg-3">사유 없음</span>}
                {typeof row.confidence === "number" && <span className="block font-mono text-fg-3">확신 {row.confidence.toFixed(2)}</span>}</td>
              <td className="max-w-[200px] text-fg-2">{row.note ?? <span className="text-fg-3">—</span>}</td>
              <td className="whitespace-nowrap text-fg-3">{row.at ? formatListTime(row.at, now) : "—"} · {row.by ?? "—"} · 감사 #{row.campaignId}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </ScrollTable>
    </div>
  );
}

/**
 * 감사 보류 — 지금 켜져 있는지, 어떤 문으로 거는지(확신·사유 갈래·두 번째 모델), 보류 중인 수와 갈래별 수. 설정과 '보류 모두 풀기'.
 * 보류는 차단이 아니다 — 상태는 그대로이고 상세 주소는 열린다. 사람이 유지·내리기·차단 해제하면 풀린다(product-audit-hold.ts)
 */
function HoldPanel({ overview, heldReasons }: { overview: AuditOverview; heldReasons: Record<AuditReasonCategory, number[]> | null }) {
  const { hold, held } = overview;
  const byCategory = heldReasons ? AUDIT_REASON_KEYS.filter((key) => heldReasons[key].length > 0) : [];
  return (
    <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-bg-card p-4" aria-labelledby="audit-hold-title">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="audit-hold-title" className="text-[14.5px] font-bold">자동 보류</h2>
        <span className={`rounded px-1.5 py-0.5 text-[13px] font-semibold ${hold.enabled ? "bg-accent-soft text-accent" : "bg-bg-soft text-fg-2"}`}>
          {hold.enabled ? "켬" : "끔"}</span>
        <span className="text-[13px] text-fg-3">
          확신 {hold.minConfidence.toFixed(2)} 이상 · 주인 없는 공개 제품 · 갈래 {hold.categories.length
            ? hold.categories.map((key) => AUDIT_REASON_CATEGORIES[key].label).join(", ") : "없음"}
          {" · 두 번째 모델이 승인한 것은 갈래로 걸지 않음"}
          {hold.secondOpinionReject && " · 두 번째 모델도 거절하면 갈래와 상관없이"}
        </span>
      </div>
      <p className="text-[13px] tabular-nums text-fg-2">
        보류 중 <b className="font-semibold text-warn">{count(held)}</b>건 — 차단이 아니라 공개 목록·검색·sitemap 에서만 빠졌습니다.
        {byCategory.length > 0 && <> 갈래별: {byCategory.map((key) => `${AUDIT_REASON_CATEGORIES[key].label} ${count(heldReasons![key].length)}`).join(" · ")}</>}
      </p>
      <AuditHoldSettingsForm hold={hold} />
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <ReleaseAllHolds held={held} />
        <span className="text-[13px] text-fg-3">끄거나 문턱·갈래를 좁혀도 이미 건 보류는 남습니다. 모두 풀면 목록에 돌아오고, 감사 거절 목록에는 그대로 남습니다.</span>
      </div>
    </section>
  );
}

/** 지금 감사가 어디까지 왔고, 무엇으로, 누가 열었는지. 새 감사는 여기서 연다 */
function CampaignPanel({ overview, now }: { overview: AuditOverview; now: Date }) {
  const { campaign, counts, paused, stalled } = overview;
  const running = campaign?.status === "running";
  const percent = counts.total ? Math.floor((counts.reviewed / counts.total) * 100) : 0;
  return (
    <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-bg-card p-4">
      {campaign ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-[14.5px] font-bold">감사 #{campaign.id}</h2>
            {/* 글이 바뀌어 멈춘 감사는 "진행 중"이 아니다 — 사람이 중단하고 새로 열어야 풀린다(ADM-15) */}
            {stalled
              ? <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[13px] font-semibold text-warn">멈춤 · 사람 필요</span>
              : <span className={`rounded px-1.5 py-0.5 text-[13px] font-semibold ${running ? "bg-accent-soft text-accent" : "bg-bg-soft text-fg-2"}`}>
                {STATUS[campaign.status] ?? campaign.status}
              </span>}
            {stalled && <RestartStalledAudit campaignId={campaign.id}
              from={`${campaign.promptVersion}·${campaign.rulesVersion}`} to={`${REVIEW_PROMPT_VERSION}·${REVIEW_RULES_VERSION}`} />}
            <span className="text-[13px] text-fg-3">
              {formatListTime(campaign.startedAt, now)} · {campaign.startedBy} · 심사 글 {campaign.promptVersion} · {campaign.provider} {campaign.model}
              {campaign.reauditKept && " · 유지 판정 포함"}
            </span>
          </div>
          <p className="text-[13px] text-fg-2">{campaign.reason}</p>
          <p className="text-[13px] tabular-nums text-fg-2">
            검토 <b className="font-semibold">{count(counts.reviewed)}</b> / {count(counts.total)} ({percent}%) ·
            제품 아님 <b className="font-semibold text-down">{count(counts.reject)}</b> ·
            판단 보류 <b className="font-semibold text-warn">{count(counts.needsReview)}</b> ·
            답 못 받음 {count(counts.failed)} · 내림 {count(counts.removed)} · 유지 {count(counts.kept)}
            {counts.skipped > 0 && ` · 묻기 전에 내려가 건너뜀 ${count(counts.skipped)}`}
          </p>
          {paused && <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] leading-[1.7] text-fg-2">{paused}</p>}
          {running && !stalled && <CancelAudit />}
        </>
      ) : (
        <p className="text-[13px] text-fg-2">아직 연 감사가 없습니다.</p>
      )}
      <StartAudit first={!campaign}
        blockedReason={stalled ? "멈춘 감사가 열려 있습니다 — 위의 \u201c이 감사 중단 → 새 감사 시작\u201d을 누르세요."
          : running ? "감사가 진행 중입니다. 한 번에 하나만 돕니다 — 끝나거나 중단한 뒤에 시작할 수 있습니다." : null} />
    </section>
  );
}

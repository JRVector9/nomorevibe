import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { listAuditFindings, productAuditOverview, type AuditOverview } from "@/lib/crawl/product-audit";
import { AuditFinding } from "./AuditFinding";
import { CancelAudit, StartAudit } from "./AuditControls";
import { pageWindow } from "../paging";
import { TakedownQueue } from "./TakedownQueue";
import { takedownHistory, takedownQueue, takedownSummary } from "@/lib/domain/products/takedown";
import { DISMISS_REASONS, formatWait, isBurst, isDismissReason, senderLabel, takedownSignal, type TakedownSummary } from "@/lib/domain/products/takedown-view";
import "../status/dashboard/dashboard.css";
import "./takedown.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "내릴 후보 — NoMoreVibe", robots: { index: false } };

/** 한 쪽. 줄마다 사람이 페이지를 열어 보고 누르므로 한 화면에 다 들어갈 필요가 없다 */
const PAGE_SIZE = 50;

/** 갈래 — 모델이 "아니다"라고 한 것과 "모르겠다"고 한 것. 둘 다 사람이 본다 */
const VIEWS = {
  reject: { label: "내릴 후보", empty: "사람이 볼 내릴 후보가 없습니다." },
  needs_review: { label: "판단 보류", empty: "AI가 판단을 미룬 것이 없습니다." },
} as const;
type View = keyof typeof VIEWS;

const STATUS: Record<string, string> = { running: "진행 중", done: "끝남", cancelled: "중단됨" };
const time = (value: Date | null) =>
  value ? value.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }) : null;
const count = (value: number) => value.toLocaleString("ko-KR");

type Props = { searchParams: Promise<{ view?: string; page?: string; tab?: string }> };

/**
 * 탭 — 사람이 부탁한 것(내려달라는 요청), 감사가 걸러낸 것, 처리 기록. 기다리는 요청이 있으면 요청이 먼저다:
 * 상세 페이지가 내려 준다고 약속했다. 감사의 갈래(?view=)로 들어오면 감사 탭이다.
 */
const TABS = { requests: "내려달라는 요청", audit: "감사 거절", history: "처리 기록" } as const;
type Tab = keyof typeof TABS;

export default async function AdminAuditPage({ searchParams }: Props) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const { view: rawView, page: rawPage, tab: rawTab } = await searchParams;
  // `in`은 프로토타입 키까지 통과시킨다 — 제품 관리의 ?filter=constructor 와 같은 함정
  const view: View = rawView && Object.hasOwn(VIEWS, rawView) ? rawView as View : "reject";
  const parsedPage = Number(rawPage ?? 1);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;

  const [overview, summary] = await Promise.all([productAuditOverview(), takedownSummary()]);
  const { campaign, counts } = overview;
  const tab: Tab = rawTab && Object.hasOwn(TABS, rawTab) ? rawTab as Tab : rawView ? "audit" : summary.pending > 0 ? "requests" : "audit";
  const [queue, history] = await Promise.all([
    tab === "requests" ? takedownQueue() : Promise.resolve([]),
    tab === "history" ? takedownHistory() : Promise.resolve([]),
  ]);
  const open = { reject: counts.openReject, needs_review: counts.openNeedsReview };
  const findings = campaign && tab === "audit"
    ? await listAuditFindings(campaign.id, view, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
    : [];
  const pages = Math.max(1, Math.ceil(open[view] / PAGE_SIZE));
  const href = (nextView: View, nextPage = 1) => {
    const params = new URLSearchParams({ tab: "audit" });
    if (nextView !== "reject") params.set("view", nextView);
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
            {name === "audit" && <span className="td-count">{count(auditOpen)}</span>}
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
        </>
      )}

      {tab === "history" && <TakedownHistory rows={history} />}

      {tab === "audit" && <>
      <p className="max-w-[80ch] text-[13px] leading-[1.7] text-fg-2">
        이미 공개된 제품을 1차 심사 글로 다시 본 결과입니다. 감사는 <b className="font-semibold">아무것도 내리지 않습니다</b> —
        AI가 제품이 아니라고 했거나 판단을 미룬 것을 여기 모을 뿐입니다. 주소를 열어 확인하고 한 건씩
        <b className="font-semibold"> 내리기</b>(차단 — 행은 남고 제품 관리에서 되돌릴 수 있음) 또는
        <b className="font-semibold"> 유지</b>(90일 동안, 페이지가 그대로인 한 다음 감사에서 뺌)를 누릅니다.
      </p>

      <CampaignPanel overview={overview} />

      {campaign && (
        <>
          <nav className="flex flex-wrap gap-1.5">
            {(Object.keys(VIEWS) as View[]).map((name) => (
              <Link key={name} href={href(name)} aria-current={name === view ? "page" : undefined}
                className={`rounded-full border px-2.5 py-1 text-[13px] ${
                  name === view ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line bg-bg-card text-fg-2 hover:bg-bg-hover"
                }`}>
                {VIEWS[name].label} {count(open[name])}
              </Link>
            ))}
          </nav>

          {findings.length === 0 ? (
            <p className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">{VIEWS[view].empty}</p>
          ) : (
            <div className="overflow-x-auto rounded-[12px] border border-line bg-bg-card">
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
                    <AuditFinding key={finding.id} finding={{ ...finding, reviewedAt: time(finding.reviewedAt) }} />
                  ))}
                </tbody>
              </table>
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
function TakedownHistory({ rows }: { rows: Awaited<ReturnType<typeof takedownHistory>> }) {
  if (rows.length === 0) return <p className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">아직 처리한 요청이 없습니다.</p>;
  return (
    <div className="overflow-x-auto rounded-[12px] border border-line bg-bg-card">
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
              <td className="whitespace-nowrap text-fg-3">{time(row.handledAt)} · {row.handledBy}{row.ip && <span className="font-mono"> · {row.ip}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 지금 감사가 어디까지 왔고, 무엇으로, 누가 열었는지. 새 감사는 여기서 연다 */
function CampaignPanel({ overview }: { overview: AuditOverview }) {
  const { campaign, counts, paused } = overview;
  const running = campaign?.status === "running";
  const percent = counts.total ? Math.floor((counts.reviewed / counts.total) * 100) : 0;
  return (
    <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-bg-card p-4">
      {campaign ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-[14.5px] font-bold">감사 #{campaign.id}</h2>
            <span className={`rounded px-1.5 py-0.5 text-[13px] font-semibold ${running ? "bg-accent-soft text-accent" : "bg-bg-soft text-fg-2"}`}>
              {STATUS[campaign.status] ?? campaign.status}
            </span>
            <span className="text-[13px] text-fg-3">
              {time(campaign.startedAt)} · {campaign.startedBy} · 심사 글 {campaign.promptVersion} · {campaign.provider} {campaign.model}
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
          {running && <CancelAudit />}
        </>
      ) : (
        <p className="text-[13px] text-fg-2">아직 연 감사가 없습니다.</p>
      )}
      <StartAudit first={!campaign}
        blockedReason={running ? "감사가 진행 중입니다. 한 번에 하나만 돕니다 — 끝나거나 중단한 뒤에 시작할 수 있습니다." : null} />
    </section>
  );
}

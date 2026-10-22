import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { auditDecisionHistory, auditFindingReasons, auditRemovalGroups, GROUP_REMOVE_MAX, GROUP_REMOVE_MIN_CONFIDENCE, heldFindingReasons,
  listAuditFindings, listHeldFindings, productAuditOverview, type AuditOverview } from "@/lib/crawl/product-audit";
import { AUDIT_REASON_CATEGORIES, AUDIT_REASON_KEYS, classifyAuditReason, groupAuditReasons, isAuditReasonCategory,
  type AuditReasonCategory } from "@/lib/crawl/audit-reason-category";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { SECOND_OPINION_FILTERS, type SecondOpinionFilter } from "@/lib/crawl/audit-second-opinions";
import { qwenSecondOpinionStatus, type QwenAutoStatus } from "@/lib/crawl/audit-second-opinion-auto";
import { qwenDirectServerLabel } from "@/lib/crawl/qwen-direct-review";
import { QWEN_AUTO_MAX_PER_TICK } from "@/lib/crawl/settings-schema";
import { QwenAutoStepSwitch } from "../components/QwenAutoStepSwitch";
import { auditReviewer, auditReviewerLabel, auditReviewerSwitched, QWEN_AUDIT_PROVIDER } from "@/lib/crawl/product-audit-reviewer";
import { translationsFor } from "@/lib/crawl/translations";
import { formatListTime } from "@/lib/format/time";
import { AuditFinding } from "./AuditFinding";
import { AuditGroups } from "./AuditGroups";
import { AuditHoldSettingsForm, CancelAudit, RestartStalledAudit, StartAudit, SwitchAuditModel } from "./AuditControls";
import { ScrollTable } from "../components/ScrollTable";
import { ReasonLanguageToggle, ReasonText } from "../review/ReasonText";
import { pageWindow } from "../paging";
import { IntroRequestList, TakedownQueue } from "./TakedownQueue";
import { introRequestQueue, pendingIntroRequestCount } from "@/lib/domain/products/intro-requests";
import { takedownHistory, takedownQueue, takedownSummary } from "@/lib/domain/products/takedown";
import { DISMISS_REASONS, formatWait, isBurst, isDismissReason, senderLabel, takedownSignal, type TakedownSummary } from "@/lib/domain/products/takedown-view";
import "../status/dashboard/dashboard.css";
import "./takedown.css";
import { PageStamp } from "@/app/(operator)/admin/components/PageStamp";
import { AUDIT_BACKLOG_OVERDUE_DAYS, auditThroughput, expiringKeepCount, KEEP_EXTEND_WITHIN_DAYS, listPolicyRuns, policyFilterOptions,
  type AuditThroughput } from "@/lib/crawl/audit-policy";
import { KeepExtend } from "./KeepExtend";
import { PolicyBuilder, type PolicyPreset } from "./PolicyBuilder";
import { PolicyRuns, type PolicyRunRow } from "./PolicyRuns";
import { ImportOpinions } from "./ImportOpinions";
import { latestStagedImport } from "@/lib/crawl/audit-second-opinion-upload";
import { QWEN_VISION_M1_SOURCE } from "@/lib/crawl/audit-import-sources";
import { AUTO_CLOSE_KEEP_DAYS, AUTO_CLOSE_MIN_CONFIDENCE, autoCloseToday, autoRunLabel, type AutoCloseToday } from "@/lib/crawl/audit-auto-close";
import type { QwenAutoSettings } from "@/lib/crawl/settings-schema";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "내릴 후보 — NoMoreVibe", robots: { index: false } };

/** 한 쪽. 줄마다 사람이 페이지를 열어 보고 누르므로 한 화면에 다 들어갈 필요가 없다 */
const PAGE_SIZE = 50;

/**
 * 갈래 — 모델이 "아니다"라고 한 것과 "모르겠다"고 한 것. 둘 다 사람이 본다.
 * 보류 중: 감사 보류로 이미 공개 목록에서 빠져 사람을 기다리는 것(회차와 상관없이, 오래된 것부터) — 있으면 이 갈래부터 연다.
 * 두 모델 모두 거절·갈림·의견 다름·Qwen 카탈로그: 내릴 후보를 두 번째 의견(audit-second-opinions.ts)으로 거른 것. 모두 거절은 보류의 까닭이 되는
 * 두 번째 거절이 있는 것, 갈림은 두 번째 모델이 승인했거나 카탈로그·디렉터리 같아 Qwen 거절(의견·감사 답)을 세지 않은 것, Qwen 거절(카탈로그 예외)은 그 뒤의 것만
 */
const VIEWS = {
  held: { label: "보류 중(목록에서 빠짐)", empty: "보류 중인 것이 없습니다." },
  reject: { label: "내릴 후보", empty: "사람이 볼 내릴 후보가 없습니다." },
  agreed: { label: "두 모델 모두 거절", empty: "두 번째 모델도 거절한 내릴 후보가 없습니다." },
  split: { label: "갈림 (2차 승인·카탈로그)", empty: "두 번째 모델이 승인했거나 카탈로그 같아 Qwen 거절을 세지 않은 내릴 후보가 없습니다.",
    hint: "두 번째 모델이 승인했거나, 카탈로그·디렉터리 같아 Qwen 거절(두 번째 의견·Qwen 이 낸 감사 답)을 보류의 까닭으로 세지 않은 것 — 사람이 한 건씩 봅니다" },
  disagree: { label: "Qwen·grok 의견 다름", empty: "Qwen 과 grok 의 의견이 다른 내릴 후보가 없습니다.",
    hint: "두 모델의 두 번째 의견이 모두 있고 결정이 다른 것" },
  qwen_catalog: { label: "Qwen 거절(카탈로그 예외)", empty: "카탈로그·디렉터리 같아 Qwen 거절을 보류에서 뺀 내릴 후보가 없습니다.",
    hint: "Qwen 이 거절했지만(두 번째 의견이든 감사 답이든) 카탈로그·디렉터리 같아(사유 갈래 '남의 플랫폼·목록' 또는 directory·catalog·awesome·curated list·list of) 그 거절로는 보류하지 않은 것" },
  needs_review: { label: "판단 보류", empty: "AI가 판단을 미룬 것이 없습니다." },
} as const satisfies Record<string, { label: string; empty: string; hint?: string }>;
type View = keyof typeof VIEWS;

const STATUS: Record<string, string> = { running: "진행 중", done: "끝남", cancelled: "중단됨" };
const count = (value: number) => value.toLocaleString("ko-KR");

type Props = { searchParams: Promise<{ view?: string; page?: string; tab?: string; reason?: string; preset?: string }> };

/**
 * 탭 — 사람이 부탁한 것(내려달라는 요청), 감사가 걸러낸 것, 처리 기록. 기다리는 요청이 있으면 요청이 먼저다:
 * 상세 페이지가 내려 준다고 약속했다. 감사의 갈래(?view=)로 들어오면 감사 탭이다.
 */
const TABS = { requests: "내려달라는 요청", audit: "감사 거절", policy: "정책 처리", history: "처리 기록" } as const;
type Tab = keyof typeof TABS;

export default async function AdminAuditPage({ searchParams }: Props) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const { view: rawView, page: rawPage, tab: rawTab, reason: rawReason, preset } = await searchParams;
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
  const [queue, introRequests, history, auditHistory, policyOptions, policyRuns, stagedImport, throughput, expiringKeeps, autoToday] = await Promise.all([
    tab === "requests" ? takedownQueue() : Promise.resolve([]),
    tab === "requests" ? introRequestQueue() : Promise.resolve([]),
    tab === "history" ? takedownHistory() : Promise.resolve([]),
    tab === "history" ? auditDecisionHistory() : Promise.resolve([]),
    tab === "policy" ? policyFilterOptions() : Promise.resolve(null),
    tab === "policy" ? listPolicyRuns() : Promise.resolve([]),
    tab === "policy" ? latestStagedImport() : Promise.resolve(null),
    // 처리 속도·적체 — 감사 탭은 한 줄, 정책 처리 탭은 날마다. 못 읽어도 화면은 그린다
    tab === "audit" || tab === "policy" ? auditThroughput().catch(() => null) : Promise.resolve(null),
    tab === "policy" ? expiringKeepCount() : Promise.resolve(0),
    // 감사 두 번째 의견이 오늘(UTC) 답으로 닫은 수 — 못 읽어도 화면은 그린다
    tab === "policy" ? autoCloseToday().catch(() => null) : Promise.resolve(null),
  ]);
  const auditHistoryKorean = auditHistory.length ? await translationsFor(auditHistory.map((row) => row.reason)) : new Map<string, string>();
  const open: Record<View, number> = { held: overview.held, reject: counts.openReject, agreed: counts.openAgreed, split: counts.openSplit,
    disagree: counts.openDisagree, qwen_catalog: counts.openQwenCatalog, needs_review: counts.openNeedsReview };
  // Qwen-v2 자동 단계의 상태 — 감사 탭에서만 읽는다(남은 수를 센다)
  const qwen = tab === "audit" ? await qwenSecondOpinionStatus({ auditHold: overview.hold, qwenAuto: overview.qwenAuto }) : null;
  // 보류 갈래의 사유는 패널의 갈래별 수에도 쓴다 — 감사 탭이면 늘 읽는다(보류된 것만, 수천 건 안)
  const heldReasonIds = tab === "audit" ? groupAuditReasons(await heldFindingReasons()) : null;
  const second = (SECOND_OPINION_FILTERS as readonly string[]).includes(view) ? view as SecondOpinionFilter : undefined;
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
    // 보류 갈래는 늘 view=held 를 싣는다 — 보류가 다 풀린 뒤에 그 주소로 와도 보류 갈래다
    if (nextView === "held" || nextView !== defaultView) params.set("view", nextView);
    if (nextReason) params.set("reason", nextReason);
    if (nextPage > 1) params.set("page", String(nextPage));
    return `/admin/audit${params.size ? `?${params}` : ""}`;
  };

  const signal = takedownSignal(summary);
  const auditOpen = open.reject + open.needs_review;
  return (
    <main className="flex flex-col gap-3 pb-10 pt-6"><PageStamp />
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

      {tab === "policy" && <>
        <p className="max-w-[80ch] text-[13px] leading-[1.7] text-fg-2">
          열린 감사 거절을 한 건씩 누르지 않고 <b className="font-semibold">정책으로</b> 닫습니다. 거르기를 만들어 미리 보고(수·사유 갈래별 수·표본·건너뛸 것과 까닭),
          손댈 수를 그대로 적어 적용합니다. 적용은 몇십 건씩 나눠 돌고, 실행 하나를 통째로 되돌릴 수 있습니다. 주인 있는 제품은 묶어서 내리지 않습니다.
        </p>
        {throughput && <ThroughputPanel throughput={throughput} detailed />}
        <PolicyBuilder reviewers={policyOptions?.reviewers ?? []} sources={policyOptions?.sources ?? []} presets={policyPresets(campaign)}
          initialPreset={preset ?? null} />
        <ImportOpinions staged={stagedImport ? { ...stagedImport, createdAt: formatListTime(stagedImport.createdAt, now) } : null} />
        <KeepExtend expiring={expiringKeeps} withinDays={KEEP_EXTEND_WITHIN_DAYS} />
        <AutoClosePanel step={overview.qwenAuto.auditSecondOpinion} today={autoToday} />
        <PolicyRuns runs={policyRuns.map((run): PolicyRunRow => ({ ...run, createdAt: formatListTime(run.createdAt, now),
          appliedAt: run.appliedAt ? formatListTime(run.appliedAt, now) : null, undoneAt: run.undoneAt ? formatListTime(run.undoneAt, now) : null,
          auto: run.auto?.action ?? null,
          label: run.auto ? autoRunLabel(run.auto) : POLICY_RUN_LABELS[`${run.kind}:${run.action}`] ?? `${run.kind}:${run.action}` }))} />
      </>}

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

      {throughput && <ThroughputPanel throughput={throughput} detailed={false} />}
      <CampaignPanel overview={overview} now={now} />
      <HoldPanel overview={overview} heldReasons={heldReasonIds} qwen={qwen} now={now} />

      {campaign && (
        <>
          {(view === "reject" || view === "held" || view === "agreed") &&
            <AuditGroups groups={groups} minConfidence={GROUP_REMOVE_MIN_CONFIDENCE} max={GROUP_REMOVE_MAX} scope={view} />}

          <nav className="flex flex-wrap items-center gap-1.5">
            {(Object.keys(VIEWS) as View[]).map((name) => (
              <Link key={name} href={href(name)} aria-current={name === view ? "page" : undefined}
                title={(VIEWS[name] as { hint?: string }).hint}
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
                      // 남은 감사 모델 바꾸기 뒤 Qwen 이 낸 답 — 확신이 늘 0.95·1.00 이라 사람이 가려 읽는다
                      answeredBy: finding.aiProvider === QWEN_AUDIT_PROVIDER ? auditReviewerLabel({ provider: finding.aiProvider, model: "" }) : null,
                      reviewedAt: finding.reviewedAt ? formatListTime(finding.reviewedAt, now) : null,
                      waitDays: finding.reviewedAt ? Math.max(0, Math.floor((now.getTime() - finding.reviewedAt.getTime()) / 86_400_000)) : null,
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
 * 처리 속도 — 닫은 수(사람의 유지·내리기, 정책, m1 자동 유지 포함)와 새로 들어온 AI 거절을 날마다 견주고, 어제까지 7일 평균으로 다 닫는 날을 낸다.
 * 줄지 않으면 '줄지 않음 — 하루 N건 더 닫아야'. 가장 오래 기다린 것과 문턱(AUDIT_BACKLOG_OVERDUE_DAYS)을 넘은 수.
 * detailed 면 지난 14일 표까지(정책 처리 탭), 아니면 한 줄(감사 탭)
 */
function ThroughputPanel({ throughput, detailed }: { throughput: AuditThroughput; detailed: boolean }) {
  const t = throughput;
  const per = (value: number) => value.toLocaleString("ko-KR", { maximumFractionDigits: 1 });
  const verdict = t.open === 0 ? "남은 것 없음"
    : t.daysToClear !== null ? `지금 속도면 약 ${count(t.daysToClear)}일 뒤 다 닫힘`
      : `줄지 않음 — 하루 ${per(Math.max(1, t.incomingPerDay - t.closedPerDay))}건 더 닫아야 줄기 시작`;
  const stale = t.oldestWaitDays !== null && t.oldestWaitDays > AUDIT_BACKLOG_OVERDUE_DAYS;
  const max = Math.max(1, ...t.days.map((day) => Math.max(day.closed, day.incoming)));
  return (
    <section className="flex flex-col gap-2 rounded-[12px] border border-line bg-bg-card p-4 text-[13px]" aria-labelledby="audit-throughput-title">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="audit-throughput-title" className="text-[14.5px] font-bold">처리 속도</h2>
        <span className="tabular-nums text-fg-2">
          열린 거절 <b className="font-semibold">{count(t.open)}</b>건(보류 중 {count(t.held)}) · 하루 닫음 <b className="font-semibold">{per(t.closedPerDay)}</b> /
          들어옴 <b className="font-semibold">{per(t.incomingPerDay)}</b>(어제까지 7일 평균) · <b className={`font-semibold ${t.daysToClear === null && t.open > 0 ? "text-warn" : ""}`}>{verdict}</b>
        </span>
      </div>
      <p className={`tabular-nums ${stale ? "text-warn" : "text-fg-2"}`}>
        가장 오래 기다린 것 {t.oldestWaitDays === null ? "—" : `${count(t.oldestWaitDays)}일`} · {AUDIT_BACKLOG_OVERDUE_DAYS}일 넘게 기다린 것 {count(t.overdue)}건
        {stale && ` — 메뉴 배지와 오늘 할 일에 보입니다(${AUDIT_BACKLOG_OVERDUE_DAYS}일 넘은 것이 없어지면 꺼집니다)`}
        {!detailed && <> · <Link href="/admin/audit?tab=policy" className="text-accent hover:underline">정책으로 닫기 →</Link></>}
      </p>
      {detailed && (
        <table className="w-full max-w-[640px] text-left tabular-nums">
          <caption className="sr-only">지난 14일 닫은 수와 들어온 수</caption>
          <thead className="text-fg-3"><tr><th className="py-1 font-semibold">날짜</th><th className="py-1 font-semibold">들어옴</th><th className="py-1 font-semibold">닫음</th></tr></thead>
          <tbody>{t.days.map((day) => (
            <tr key={day.day} className="border-t border-line">
              <td className="whitespace-nowrap py-1 pr-3 font-mono text-fg-3">{day.day.slice(5)}</td>
              <td className="w-[45%] py-1 pr-2"><span className="inline-block h-2 rounded-sm bg-warn/60 align-middle" style={{ width: `${Math.round((day.incoming / max) * 100)}%` }} />
                <span className="ml-1.5">{count(day.incoming)}</span></td>
              <td className="w-[45%] py-1"><span className="inline-block h-2 rounded-sm bg-accent align-middle" style={{ width: `${Math.round((day.closed / max) * 100)}%` }} />
                <span className="ml-1.5">{count(day.closed)}</span></td>
            </tr>))}</tbody>
        </table>
      )}
    </section>
  );
}

/**
 * 감사 두 번째 의견의 답으로 닫기(audit-auto-close.ts) — 켬/끔, 오늘(UTC) 자동으로 유지·숨긴 수, 규칙과 되돌리는 길. 실행은 아래 정책 실행 목록의
 * 'm1 자동 유지·숨김 · 날짜(UTC)'다
 */
function AutoClosePanel({ step, today }: { step: QwenAutoSettings["auditSecondOpinion"]; today: AutoCloseToday | null }) {
  const on = step.enabled && step.autoClose;
  return (
    <section className="flex flex-col gap-1.5 rounded-[12px] border border-line bg-bg-card p-4 text-[13px] text-fg-2" aria-labelledby="audit-auto-close-title">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="audit-auto-close-title" className="text-[14.5px] font-bold text-fg">m1 자동 닫기 (Qwen-v2 두 번째 의견)</h2>
        <span className={`rounded px-1.5 py-0.5 font-semibold ${on ? "bg-accent-soft text-accent" : "bg-bg-soft text-fg-2"}`}>{on ? "켬" : "끔"}</span>
        {today && <span className="tabular-nums">오늘({today.day} UTC) 자동 유지 <b className="font-semibold text-fg">{count(today.kept)}</b> ·
          자동 숨김 <b className="font-semibold text-fg">{count(today.held)}</b>{today.undone > 0 && ` · 그중 되돌림 ${count(today.undone)}`}</span>}
      </div>
      <p>승인(확신 {AUTO_CLOSE_MIN_CONFIDENCE.toFixed(2)} 이상, 다른 모델의 거절 없음) → 유지 {AUTO_CLOSE_KEEP_DAYS}일(보류 중이면 풂) ·
        주인 없는 제품의 거절(확신 {AUTO_CLOSE_MIN_CONFIDENCE.toFixed(2)} 이상) → 숨김(보류). 그 밖(확신 낮음·판단 보류·모델 갈림·주인 있는 제품의 거절)은 열어 둡니다.
        아무것도 내리지 않습니다 — 내리기는 위 정책으로 사람이 합니다.</p>
      <p className="text-fg-3">하루(UTC)·행동마다 아래 &lsquo;m1 자동 …&rsquo; 실행 하나에 적힙니다. 그 실행을 되돌리면 그날 자동으로 한 것만 돌아갑니다 — 유지는 지우고 풀었던 보류를 다시 걸고,
        숨김은 보류를 풀어 다시 걸지 않습니다. Qwen 의견은 남아 다시 묻지 않습니다. 끄려면 감사 거절 탭의 &lsquo;Qwen-v2 감사 두 번째 의견&rsquo;에서 답으로 닫기를 끕니다.</p>
    </section>
  );
}

/** 정책 실행의 화면 이름(실행 종류:행동) */
const POLICY_RUN_LABELS: Record<string, string> = {
  "close:remove": "내리기", "close:keep": "유지", "close:release": "보류 풀기", "import:import": "두 번째 의견 올리기", "extend:extend": "유지 연장",
};

/**
 * 자주 쓰는 거르기(2026-10-22 프로드의 큰 무리) — 누르면 거르기와 할 일만 채운다. 적용은 미리보기·수 적기를 거친다.
 * 이전 모델은 이 감사가 시작할 때의 심사자다(남은 감사 모델 바꾸기 전 답)
 */
function policyPresets(campaign: AuditOverview["campaign"]): PolicyPreset[] {
  const start = campaign ? `${campaign.provider}|${campaign.model}` : null;
  return [
    { key: "low", label: "이전 모델 · 확신 0.90–0.95 · 보류 아님 · 2차 없음", action: "none",
      hint: "확신이 묶어 내리기 문턱(0.95) 아래라 내리기는 건너뜁니다 — 표본을 보고 유지하거나 그대로 둡니다",
      filter: { reviewers: start ? [start] : [], confidenceMin: 0.9, confidenceBelow: 0.95, held: "not_held", second: "none", owner: "unowned" } },
    { key: "agreed", label: "두 모델 모두 거절 · 보류 중", action: "remove",
      hint: "확신 0.95 이상이고 두 번째 모델도 거절해 이미 목록에서 빠진 것 — 내리기 후보",
      filter: { confidenceMin: 0.95, held: "held", second: "agreed", owner: "unowned" } },
    { key: "split", label: "모델 갈림 · 2차 승인 · 보류 아님", action: "none",
      hint: "감사 모델은 거절, 두 번째 모델은 승인 — 내리기는 건너뜁니다. 표본을 보고 유지하거나 그대로 둡니다",
      filter: { confidenceMin: 0.95, held: "not_held", second: "approve" } },
    { key: "held-alone", label: "보류 중 · 2차 없음", action: "none",
      hint: "확신·사유 갈래만으로 보류된 것 — 두 번째 의견이 아직 없다",
      filter: { confidenceMin: 0.95, held: "held", second: "none", owner: "unowned" } },
    { key: "unheld-alone", label: "확신 0.95 이상 · 보류 아님 · 2차 없음", action: "none",
      hint: "대부분 Qwen 이 감사한 것(카탈로그 예외·확신 문턱으로 보류하지 않은 것)",
      filter: { confidenceMin: 0.95, held: "not_held", second: "none", owner: "unowned" } },
    { key: "held", label: "보류 중 전체", action: "release",
      hint: "'보류 모두 풀기'의 고른 판 — 거르기를 더 좁혀 풀거나 유지합니다. 실행째 되돌릴 수 있습니다",
      filter: { held: "held" } },
    { key: "m1-approve", label: "m1 화면 재판정 승인", action: "keep",
      hint: "스크린샷까지 본 m1 Qwen 이 승인한 것 — 표본을 보고 유지합니다(보류면 풀립니다)",
      filter: { second: "approve", secondSource: QWEN_VISION_M1_SOURCE } },
    { key: "m1-reject", label: "m1 화면 재판정 거절 · 보류 중", action: "remove",
      hint: "감사 모델과 스크린샷까지 본 m1 Qwen 이 모두 거절한 보류 — 내리기 후보(두 번째 모델 승인이 있으면 건너뜀)",
      filter: { second: "reject", secondSource: QWEN_VISION_M1_SOURCE, held: "held", confidenceMin: 0.95, owner: "unowned" } },
  ];
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
 * 감사 보류 — 지금 켜져 있는지, 어떤 문으로 거는지(확신·사유 갈래·두 번째 모델), 보류 중인 수와 갈래별 수. 설정과 '보류 골라 풀기'(정책 처리).
 * 보류는 차단이 아니다 — 상태는 그대로이고 상세 주소는 열린다. 사람이 유지·내리기·차단 해제하면 풀린다(product-audit-hold.ts)
 */
function HoldPanel({ overview, heldReasons, qwen, now }: {
  overview: AuditOverview; heldReasons: Record<AuditReasonCategory, number[]> | null; qwen: QwenAutoStatus | null; now: Date;
}) {
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
          {hold.secondOpinionReject && " · 두 번째 모델도 거절하면 갈래와 상관없이(Qwen 거절은 카탈로그·디렉터리 같은 것에서는 세지 않음)"}
        </span>
      </div>
      <p className="text-[13px] tabular-nums text-fg-2">
        보류 중 <b className="font-semibold text-warn">{count(held)}</b>건 — 차단이 아니라 공개 목록·검색·sitemap 에서만 빠졌습니다.
        {byCategory.length > 0 && <> 갈래별: {byCategory.map((key) => `${AUDIT_REASON_CATEGORIES[key].label} ${count(heldReasons![key].length)}`).join(" · ")}</>}
      </p>
      {qwen && <QwenStatus status={qwen} now={now} />}
      {qwen && <div className="flex flex-col gap-1">
        <QwenAutoStepSwitch key={`a:${JSON.stringify(overview.qwenAuto.auditSecondOpinion)}`} step="auditSecondOpinion"
          value={overview.qwenAuto.auditSecondOpinion} title="Qwen-v2 감사 두 번째 의견" maxPerTick={QWEN_AUTO_MAX_PER_TICK}
          choices={[{ name: "scope", label: "묻는 범위", widens: "all",
            options: [{ value: "all", label: "열린 거절 전부" }, { value: "hold", label: "보류 후보만" }] }]}
          toggles={[{ name: "autoClose", label: "답으로 닫기(승인 유지·거절 숨김)" }]}
          enableNotes={[`${qwenDirectServerLabel()} Qwen-v2 의 두 번째 의견을 받아 적습니다(감사 잡, 출처 qwen-v2-auto) — 범위가 '열린 거절 전부'면 지금 감사의 열린 거절 모두(확신·주인과 상관없이), '보류 후보만'이면 보류 후보.`,
            `답으로 닫기: 승인(확신 ${AUTO_CLOSE_MIN_CONFIDENCE.toFixed(2)} 이상, 다른 모델 거절 없음)은 유지 ${AUTO_CLOSE_KEEP_DAYS}일로 닫고, 주인 없는 제품의 거절(확신 ${AUTO_CLOSE_MIN_CONFIDENCE.toFixed(2)} 이상)은 숨깁니다(보류). 내리지 않습니다 — 정책 처리 탭의 'm1 자동 …' 실행으로 되돌립니다.`,
            hold.secondOpinionReject ? "답으로 닫기가 꺼져 있으면 승인은 그 항목의 보류를 풀고, 거절은 두 번째 모델 거절로 보류의 까닭이 됩니다 — 카탈로그·디렉터리 같은 것은 빼고."
              : "답으로 닫기가 꺼져 있으면 승인은 그 항목의 보류를 풀고, 거절은 기록만 남습니다(두 번째 모델 거절로 보류가 꺼져 있음).",
            "감사 답을 같은 Qwen 이 낸 항목은 묻지 않습니다."]} />
        <QwenAutoStepSwitch key={`p:${JSON.stringify(overview.qwenAuto.publishedFilter)}`} step="publishedFilter"
          value={overview.qwenAuto.publishedFilter} title="Qwen-v2 공개분 2차 거르기" maxPerTick={QWEN_AUTO_MAX_PER_TICK}
          enableNotes={["공개분 2차가 사람 확인으로 넘긴 행을 Qwen-v2 로 한 번 더 봅니다(감사 잡).",
            "승인(확신 0.90 이상)이면 사람의 '유지'와 같은 길로 닫습니다 — 누가 qwen-v2-auto. 내리지도 숨기지도 않습니다.",
            "거절·판단 보류·낮은 확신이면 행을 그대로 두고 «Qwen-v2도 거절»·«판단 보류»로 사람 확인 목록 앞에 둡니다."]} />
      </div>}
      {/* 저장된 값이 바뀌면 새로 그린다 — 오류가 나면 고친 값을 그대로 둔다 */}
      <AuditHoldSettingsForm key={JSON.stringify(hold)} hold={hold} />
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Link href="/admin/audit?tab=policy&preset=held" className="admin-button">보류 골라 풀기·유지·내리기 →</Link>
        <span className="text-[13px] text-fg-3">끄거나 문턱·갈래를 좁혀도 이미 건 보류는 남습니다. 정책 처리에서 거르기로 골라 미리 보고 풀며(목록에 돌아오고 감사 거절
          목록에는 남음), 실행째 되돌릴 수 있습니다 — &lsquo;보류 모두 풀기&rsquo;를 대신합니다.</span>
      </div>
    </section>
  );
}

const ERROR_TARGET = { audit: "감사 두 번째 의견", published: "공개분 2차 거르기" } as const;

/**
 * Qwen-v2 자동 단계(audit-second-opinion-auto.ts) — Qwen 직접 서버를 바로 불러 감사 거절에 두 번째 의견을 적고, 공개분 2차의 사람 확인 행을 한 번 더 본다.
 * 서버 이름은 설정에서 읽는다(qwenDirectServerLabel — AUDIT_SECOND_OPINION_LABEL 또는 주소의 호스트).
 * 켬/끔·틱당 수, 지난 1시간·24시간에 적은 수(공개분은 그중 유지로 닫은 수), 남은 것, 마지막 오류
 */
function QwenStatus({ status, now }: { status: QwenAutoStatus; now: Date }) {
  const at = (iso: string | null) => iso ? formatListTime(new Date(iso), now) : "—";
  const onOff = (on: boolean) => <span className={`rounded px-1.5 py-0.5 font-semibold ${on ? "bg-accent-soft text-accent" : "bg-bg-soft text-fg-2"}`}>
    {on ? "켬" : "끔"}</span>;
  const { audit, published, lastError, autoClose } = status;
  const recovered = lastError && status.lastSuccessAt && status.lastSuccessAt > lastError.at;
  return (
    <div className="flex flex-col gap-1 border-t border-line pt-3 text-[13px] tabular-nums text-fg-2" aria-label="Qwen-v2 자동 단계">
      <p><b className="font-semibold">Qwen-v2 두 번째 의견</b> {onOff(audit.enabled)} 틱마다 {count(audit.perTick)}건 ·
        {audit.scope === "all" ? " 열린 거절 전부" : " 보류 후보만"} ·
        지난 1시간 {count(audit.lastHour)} · 24시간 {count(audit.lastDay)} · 남은 것 <b className="font-semibold">{count(audit.remaining)}</b></p>
      <p><b className="font-semibold">답으로 닫기</b> {onOff(audit.enabled && audit.autoClose)} 오늘({autoClose.day} UTC) 자동 유지 {count(autoClose.kept)} ·
        자동 숨김 {count(autoClose.held)}{autoClose.undone > 0 && ` · 그중 되돌림 ${count(autoClose.undone)}`} — 확신 {autoClose.minConfidence.toFixed(2)} 이상만 ·
        {" "}<Link href="/admin/audit?tab=policy" className="text-accent hover:underline">실행·되돌리기 →</Link></p>
      <p><b className="font-semibold">공개분 2차 거르기</b> {onOff(published.enabled)} 틱마다 {count(published.perTick)}건 ·
        지난 1시간 {count(published.lastHour)}(유지로 닫음 {count(published.keptHour)}) · 24시간 {count(published.lastDay)}(유지로 닫음 {count(published.keptDay)}) ·
        남은 것 <b className="font-semibold">{count(published.remaining)}</b></p>
      <p className="text-fg-3">{status.model ?? "모델 설정 오류"} · {status.url ?? "주소 설정 오류"} · 글 {status.promptVersion} ·
        마지막으로 돈 때 {at(status.lastRunAt)}{status.givenUp > 0 && ` · 답을 못 받아 그만 물은 것 ${count(status.givenUp)}건`}</p>
      {status.endpointBackoff && <p className="text-warn">{qwenDirectServerLabel()} 이(가) 탈 나 {at(status.endpointBackoff.until)}까지 모두 물러납니다
        (<span className="font-mono">{status.endpointBackoff.code ?? "qwen_unreachable"}</span>, 연속 {count(status.endpointBackoff.failures)}번) —
        Qwen 직접 감사·두 번째 의견·공개분 거르기·갈림 판가름·보류 재심사가 그동안 묻지 않습니다.</p>}
      {lastError && <p className={recovered ? "text-fg-3" : "text-warn"}>마지막 오류: <span className="font-mono">{lastError.code}</span>
        {lastError.detail && ` (${lastError.detail})`} · {ERROR_TARGET[lastError.target] ?? lastError.target} · {at(lastError.at)}
        {recovered && ` — 그 뒤 ${at(status.lastSuccessAt)}에 다시 받음`}</p>}
    </div>
  );
}

/**
 * 지금 감사가 어디까지 왔고, 무엇으로, 누가 열었는지. 새 감사는 여기서 연다.
 * 남은 감사 모델 바꾸기(0112) 뒤면 '모델 전환: 시작 모델 → 지금 모델 (시각)'과 바꾼 뒤 답한 수를 보인다
 */
function CampaignPanel({ overview, now }: { overview: AuditOverview; now: Date }) {
  const { campaign, counts, paused, stalled, switchTo } = overview;
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
          {auditReviewerSwitched(campaign) && (
            <p className="text-[13px] text-fg-2">
              <b className="font-semibold">모델 전환: {auditReviewerLabel(campaign)} → {auditReviewerLabel(auditReviewer(campaign))}</b>
              {campaign.switchedAt && ` (${formatListTime(campaign.switchedAt, now)}${campaign.switchedBy ? ` · ${campaign.switchedBy}` : ""})`}
              {` · 바꾼 뒤 답 ${count(counts.answeredByCurrent ?? 0)}건 · 그 전 답은 그대로`}
            </p>
          )}
          <p className="text-[13px] text-fg-2">{campaign.reason}</p>
          <p className="text-[13px] tabular-nums text-fg-2">
            검토 <b className="font-semibold">{count(counts.reviewed)}</b> / {count(counts.total)} ({percent}%) ·
            제품 아님 <b className="font-semibold text-down">{count(counts.reject)}</b> ·
            판단 보류 <b className="font-semibold text-warn">{count(counts.needsReview)}</b> ·
            답 못 받음 {count(counts.failed)} · 내림 {count(counts.removed)} · 유지 {count(counts.kept)}
            {counts.skipped > 0 && ` · 묻기 전에 내려가 건너뜀 ${count(counts.skipped)}`}
          </p>
          {paused && <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] leading-[1.7] text-fg-2">{paused}</p>}
          {running && !stalled && (
            <div className="flex flex-wrap items-center gap-2">
              {switchTo && <SwitchAuditModel campaignId={campaign.id} unanswered={Math.max(0, counts.total - counts.reviewed - counts.failed - counts.skipped)}
                from={{ ...auditReviewer(campaign), label: auditReviewerLabel(auditReviewer(campaign)) }}
                to={{ model: switchTo.model, label: auditReviewerLabel(switchTo), server: qwenDirectServerLabel() }} />}
              <CancelAudit />
            </div>
          )}
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

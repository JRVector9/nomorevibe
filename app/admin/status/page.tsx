import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { frontierCounts, candidateCounts, rejectionBreakdown, yieldBySignal } from "@/lib/crawl/repository";
import { getSettings } from "@/lib/crawl/settings";
import { listJobStates } from "@/lib/jobs/runner";
import { downProducts, DOWN_THRESHOLD } from "@/lib/domain/products/health";
import { topClickedSince } from "@/lib/domain/products/clicks";
import { JOB_NAMES, JOB_CATALOG } from "@/lib/jobs/catalog";
import { jobStatusLabel } from "@/lib/jobs/status";
import { getCurrentSeason, RANKING_STALE_MS } from "@/lib/domain/ranking/view";
import { getEvidenceStatusSummary } from "@/lib/domain/evidence/admin";
import { Panel } from "@/components/Panel";
import { OperationsCenter } from "./OperationsCenter";
import { operationsData } from "@/lib/operations/admin";
import { latestServiceInstance } from "@/lib/operations/instance";
import { pipelineFlow, oldestReviewWaitDays, stalledReviewCount } from "@/lib/operations/pipeline";
import { pipelineThroughput } from "@/lib/operations/throughput";
import { buildWorkerProgress } from "@/lib/operations/worker-progress-query";
import { attentionCounts, hourlyThroughput, modelHealth, signalYields, todayPublications } from "@/lib/operations/dashboard";
import { roleOverview, SHARED_IMAGE_ROLES } from "@/lib/operations/roles";
import { takedownSummary } from "@/lib/domain/products/takedown";
import { formatWait, isBurst } from "@/lib/domain/products/takedown-view";
import { listGitHubCollectorAccounts, parseCoreQuota } from "@/lib/crawl/github-accounts";
import { KpiStrip } from "./dashboard/KpiStrip";
import { StageRail } from "./dashboard/StageRail";
import { RolesTable } from "./dashboard/RolesTable";
import { ModelCards, type ConnectionProbe } from "./dashboard/ModelCards";
import { AttentionList, type ActionItem } from "./dashboard/AttentionList";
import { SignalTable } from "./dashboard/SignalTable";
import { TodayFeed } from "./dashboard/TodayFeed";
import { StatusChips } from "./dashboard/StatusChips";
import type { AgentStatus } from "@/lib/operations/contracts";
import { manualCandidates } from "@/lib/operations/categories";
import { logger, redact } from "@/lib/observability/logger";
import { listAdminReviewEntries, reviewQueueAiDecisions, reviewQueueCauses } from "@/lib/crawl/admin-review";
import { QueuePreview } from "./QueuePreview";
import { intersectQueueIds, parseQueueFilters, queueFilterHref, QUEUE_PAGE_SIZE, type QueueSearch } from './queue-filters';
import { recentSecondReviewFailures, secondReviewSummary } from "@/lib/crawl/second-review";
import { translationProgress } from "@/lib/crawl/translations";
import { TranslationProgress } from "./TranslationProgress";
import { REASON_LABELS } from "../reasons";
import { searchLogSummary } from "@/lib/domain/products/search-log";
import { readSearchHealth, searchHealthAlerts } from "@/lib/operations/search-health-model";
import { SearchHealthPanel } from "./SearchHealthPanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "운영센터 — NoMoreVibe", robots: { index: false } };


const STATE_LABELS: Record<string, string> = {
  pending: "조사 대기",
  fetching: "가져오는 중",
  done: "확보 완료",
  failed: "실패",
  skipped: "건너뜀",
  new: "판정 대기",
  approved: "발행 대기",
  rejected: "거부",
  needs_review: "심사 대기",
  published: "발행됨",
};

function when(at: Date | null): string {
  if (!at) return "없음";
  const minutes = Math.round((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}시간 전` : `${Math.round(hours / 24)}일 전`;
}

function rankingSnapshotIsStale(at: Date | null): boolean {
  return !at || Date.now() - at.getTime() > RANKING_STALE_MS;
}

function Counts({ counts, empty }: { counts: Record<string, number>; empty: string }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <p className="text-[13px] text-fg-3">{empty}</p>;
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2">
      {rows.map(([key, count]) => (
        <div key={key} className="flex items-baseline gap-2">
          <dt className="text-[13px] text-fg-2">{STATE_LABELS[key] ?? key}</dt>
          <dd className="font-mono text-[14px] font-bold">{count.toLocaleString("ko-KR")}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function StatusPage({ searchParams }: { searchParams: Promise<QueueSearch> }) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const params = await searchParams;
  const filters = parseQueueFilters(params);
  const initialTab = params.tab === 'ai' || params.tab === 'jobs' || params.tab === 'manual' ? params.tab : 'overview';

  const [settings, frontier, candidates, rejections, jobStates, signalRows, rankingSeason, evidenceSummary] = await Promise.all([
    getSettings(),
    frontierCounts(),
    candidateCounts(),
    rejectionBreakdown(),
    listJobStates(),
    yieldBySignal(),
    getCurrentSeason(),
    getEvidenceStatusSummary(new Date()),
  ]);
  const [down, topClicked, ops, manual] = await Promise.all([downProducts(), topClickedSince(30), operationsData(), manualCandidates()]);
  const [flow, oldestWait, stalled, decisions, causes, seconds, translation, secondFailures, throughput] = await Promise.all([pipelineFlow(), oldestReviewWaitDays(), stalledReviewCount(),
    reviewQueueAiDecisions(), filters.cause ? reviewQueueCauses(settings) : Promise.resolve(null),
    secondReviewSummary(settings.secondReview.agreeAt), translationProgress(), recentSecondReviewFailures(), pipelineThroughput(settings).catch(error => {
      logger.warn("operations.throughput_unavailable", { errorName: error instanceof Error ? error.name : "unknown" });
      return null;
    })]);
  // Filter the whole queue before pagination, not the fourteen rows already on screen.
  const queue = await listAdminReviewEntries(settings, {
    state: 'needs_review', limit: QUEUE_PAGE_SIZE, offset: (filters.page - 1) * QUEUE_PAGE_SIZE,
    ids: intersectQueueIds(filters.cause ? causes?.ids.get(filters.cause) ?? [] : undefined,
      filters.ai ? decisions.ids.get(filters.ai) ?? [] : undefined),
    search: filters.q || undefined,
    minStars: filters.minStars ? Number(filters.minStars) : undefined,
    pushedWithinDays: filters.updated ? Number(filters.updated) : undefined,
  });
  const lastQueuePage = Math.max(1, Math.ceil(queue.total / QUEUE_PAGE_SIZE));
  if (filters.page > lastQueuePage) redirect(queueFilterHref(filters, { page: lastQueuePage }));

  /**
   * 운영센터 격자가 쓰는 묶음 — 실패해도 화면은 나가야 한다. 24시간·7일 집계는 모듈 안에서 60초 담아 둔다.
   */
  const warn = (event: string) => (error: unknown) => {
    logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
    return null;
  };
  const [hourly, models, yields, today, attention, roles, accounts, takedowns] = await Promise.all([
    hourlyThroughput().catch(warn("operations.hourly_unavailable")),
    modelHealth(settings).catch(warn("operations.models_unavailable")),
    signalYields(settings).catch(warn("operations.signals_unavailable")),
    todayPublications().catch(warn("operations.today_unavailable")),
    attentionCounts().catch(warn("operations.attention_unavailable")),
    roleOverview().catch(warn("operations.roles_unavailable")),
    listGitHubCollectorAccounts().catch(warn("operations.accounts_unavailable")),
    takedownSummary().catch(warn("operations.takedowns_unavailable")),
  ]);

  const states = new Map(jobStates.map((job) => [job.name, job]));
  const workerProgress = throughput ? buildWorkerProgress(throughput, jobStates, ops.observations, new Date(ops.fetchedAt)) : null;
  const rejectedTotal = rejections.reduce((sum, r) => sum + r.count, 0);
  const rankingStale = rankingSnapshotIsStale(rankingSeason?.refreshedAt ?? null);
  const evidenceJob = states.get("product-evidence-refresh");

  /**
   * 지금 사람이 손대야 하는 것.
   *
   * 막고 있는 순서대로 놓는다 — AI 연결이 끊겨 있으면 심사 큐가 쌓이는 것은 결과이지
   * 원인이 아니다. 원인을 위에 두어야 아래가 저절로 풀린다.
   */
  const agent = latestServiceInstance(ops.serviceInstances, "connect-agent")?.value as AgentStatus | undefined;
  /** 웹 두 대의 릴리스 — 머리말 칩과 릴리스 불일치 판단이 본다 */
  const web = ops.serviceInstances.filter((instance) => instance.role === "app")
    .map((instance) => ({ instance: instance.instanceId, release: typeof instance.value.release === "string" ? instance.value.release : null }));
  const failedJobs = jobStates.filter(job => job.lastError);
  const actions: ActionItem[] = [];
  const healthObservation = ops.observations.find(row => row.key === "job:product-search-health");
  const health = states.get("product-search-health")?.lastError ? null : readSearchHealth(healthObservation);
  if (health) {
    actions.push(...searchHealthAlerts(health).map(alert => ({ ...alert, key: `search-${alert.key}`,
      action: { label: "점검 작업", href: "/admin/status?tab=jobs" } })));
  }

  if (!agent?.configReady) {
    actions.push({
      key: "ai", tone: "critical", count: "!", title: "AI 계정이 연결돼 있지 않습니다",
      detail: <>AI 심사(<span className="font-mono">crawl-agent-review</span>)가 매 틱 건너뛰고, 발행 워커는 카테고리를 정하지 못해 승인 후보를 보류합니다. 아래 쌓인 것들의 원인입니다.</>,
      action: { label: "연결 상태", href: "/admin/status?tab=ai" },
    });
  }
  if (failedJobs.length > 0) {
    actions.push({
      key: "jobs", tone: "critical", count: failedJobs.length, title: "마지막 회차가 실패한 작업",
      detail: <>{failedJobs.map(job => job.name).join(", ")} — 실패한 작업 뒤의 단계는 새 일감을 받지 못합니다.</>,
    });
  }
  const needsReview = candidates.needs_review ?? 0;
  if (needsReview > 0) {
    actions.push({
      key: "review", tone: "hold", count: needsReview, title: "사람이 가려야 할 후보",
      detail: <>
        {oldestWait !== null && <>가장 오래 기다린 것 <span className="font-mono">{oldestWait}일</span>. </>}
        {stalled > 0 && <>그중 <span className="font-mono">{stalled}건</span>은 판정한 지 2주가 넘었습니다 — 갈래별로 묶으면 한 번에 처리할 수 있습니다.</>}
      </>,
      action: { label: "심사 큐", href: "/admin/review" },
    });
  }
  const secondAgreed = seconds.counts.unanimousReject + seconds.counts.unanimousApprove + seconds.counts.agreedReject + seconds.counts.agreedApprove;
  const secondOpen = secondAgreed + seconds.counts.needsHuman + seconds.counts.published;
  if (secondOpen > 0) {
    actions.push({
      key: "second", tone: "hold", count: secondOpen, title: "2차 심사 확인",
      detail: <>일치 {secondAgreed}건은 한 번에 확정(그중 만장일치 {seconds.counts.unanimousReject + seconds.counts.unanimousApprove}건) · 엇갈림 {seconds.counts.needsHuman}건 · 공개분 {seconds.counts.published}건은 사람이 봅니다.</>,
      // 비어 있는 칩을 열지 않는다 — 할 일이 있다고 해 놓고 빈 화면을 주면 신뢰를 잃는다
      action: { label: "2차 심사", href: `/admin/review?second=${
        (["needs_human", "unanimous_reject", "unanimous_approve", "agreed_reject", "agreed_approve"] as const)
          .find((key) => seconds.ids[key].length) ?? "needs_human"}` },
    });
  }
  /**
   * 2차가 실패하고 있으면 대기 수만 보여 줘선 안 된다.
   *
   * 게이트웨이는 모델 목록이 예고 없이 바뀌어, 없는 모델을 적어 두면 매 틱 404 로 끝난다 —
   * 화면에는 "대기 N건"만 늘어나 멈춘 줄 모른다. 어느 모델이 무슨 까닭으로 실패했는지 적는다.
   */
  if (secondFailures.length > 0) {
    const total = secondFailures.reduce((sum, row) => sum + row.count, 0);
    const gone = secondFailures.some((row) => row.errorCode === "model_unavailable" || row.errorCode === "not_configured");
    actions.push({
      key: "second-failed", tone: gone ? "critical" : "hold", count: total, title: "2차 심사가 실패하고 있습니다",
      detail: <>
        최근 24시간 미해결 오류 · {secondFailures.slice(0, 3).map((row) => `${row.model ?? "모델 미상"} ${row.errorCode} ${row.count}건`).join(" · ")}
        {gone && <> — 설정한 모델을 게이트웨이가 더 이상 갖고 있지 않습니다.</>}
      </>,
      action: { label: "2차 심사 설정", href: "/admin#second-review" },
    });
  }
  if (ops.held > 0) {
    actions.push({
      key: "held", tone: "hold", count: ops.held, title: "분류를 못 정해 발행이 멈춘 후보",
      detail: <>승인은 끝났고 카테고리만 없습니다. 수동으로 지정하면 다음 발행 틱에 올라갑니다.</>,
      action: { label: "카테고리 기준", href: "/admin/categories" },
    });
  }
  if (down.length > 0) {
    actions.push({
      key: "down", tone: "critical", count: down.length, title: "응답하지 않는 공개 제품",
      detail: <>{DOWN_THRESHOLD}회 넘게 연속으로 실패해 공개 목록에서 빠져 있습니다. 지우거나 차단하지는 않습니다 — 다시 열리면 그대로 돌아옵니다. 끝난 서비스인지는 사람이 보고 정합니다.</>,
      action: { label: "제품 관리", href: "/admin/products" },
    });
  }
  /**
   * 역할·워커·모델·한도 — 전에는 스크립트와 접힌 표에만 있던 것들. 예비가 일하면 주가 죽은 것과 같은 무게로 올린다.
   */
  const standbyActive = roles?.roles.filter((row) => row.reason === "standby_active") ?? [];
  if (standbyActive.length > 0) {
    actions.push({
      key: "standby", tone: "critical", count: standbyActive.length, title: "예비가 일하고 있는 역할",
      detail: <>{standbyActive.map((row) => row.role).join(", ")} — 주(M3)가 lease 를 되찾지 못합니다. 예비를 잠깐 0으로 줄여 돌려놓습니다(runbook).</>,
      action: { label: "역할 표", href: "/admin/status#roles" },
    });
  }
  // 공통 이미지 역할과 웹만 비교한다 — maintenance·text 는 git 빌드라 릴리스가 다른 것이 정상이다(2026-10-03 오경보)
  const releases = new Set([...(roles?.roles ?? []).filter((row) => SHARED_IMAGE_ROLES.has(row.role)).map((row) => row.ownerRelease),
    ...web.map((row) => row.release)].filter((value): value is string => Boolean(value)));
  if (releases.size > 1) {
    actions.push({
      key: "release", tone: "hold", count: releases.size, title: "공통 이미지 릴리스가 갈렸습니다",
      detail: <>{[...releases].map((value) => value.slice(0, 7)).join(" · ")} — 릴리스 도구(deploy_shared_images.py)로 8개 앱을 같은 SHA 로 맞춥니다.</>,
    });
  }
  const workerAlarms = workerProgress?.liveness.filter((row) => row.alarm) ?? [];
  if (workerAlarms.length > 0) {
    actions.push({
      key: "liveness", tone: "critical", count: workerAlarms.length, title: "워커 관측이 끊겼거나 반복 재시작 중",
      detail: <>{workerAlarms.map((row) => `${row.role} ${row.reason === "restart_loop" ? "5분 내 반복 재시작" : "관측 끊김"}`).join(" · ")}</>,
      action: { label: "작업 흐름", href: "/admin/status?tab=jobs" },
    });
  }
  if (workerProgress?.scheduler.reason === "scheduler_missed") {
    actions.push({
      key: "scheduler", tone: "critical", count: workerProgress.scheduler.overdueJobs.length, title: "스케줄러 예약이 밀렸습니다",
      detail: <>{workerProgress.scheduler.overdueJobs.join(", ")}</>,
    });
  }
  if (workerProgress?.scheduler.reason === "unknown_schedule") {
    actions.push({
      key: "scheduler-unknown", tone: "hold", count: "?", title: "스케줄러 예약 상태를 확인할 수 없습니다",
      detail: <>다음 예약 시각이 없는 작업이 있습니다 — 스케줄러 관측과 작업 표를 확인합니다.</>,
      action: { label: "작업 흐름", href: "/admin/status?tab=jobs" },
    });
  }
  // 워커는 관측되는데 저장 진행이 없는 단계 — 관측 끊김(liveness)과 달리 프로세스는 살아 있다
  const stuckStages = workerProgress?.stages.filter((row) => row.alarm && row.reason === "no_progress") ?? [];
  if (stuckStages.length > 0) {
    actions.push({
      key: "stage-progress", tone: "critical", count: stuckStages.length, title: "워커는 살아 있는데 단계가 나아가지 않습니다",
      detail: <>{stuckStages.map((row) => throughput?.stages.find((stage) => stage.key === row.stage)?.label ?? row.stage).join(" · ")} — 오래 기다린 후보가 있는데 5분간 저장 진행이 없습니다.</>,
      action: { label: "작업 흐름", href: "/admin/status?tab=jobs" },
    });
  }
  // 내려달라는 요청 — 상세 페이지가 내려 준다고 약속했다. 24시간을 넘기면 다른 경보처럼 맨 앞 급으로
  if (takedowns && takedowns.pending > 0) {
    const oldest = takedowns.oldestHours === null ? "" : ` · 최장 ${formatWait(takedowns.oldestHours)}`;
    actions.push({
      key: "takedowns", tone: takedowns.overdue > 0 ? "critical" : "hold", count: takedowns.pending,
      title: takedowns.overdue > 0 ? `내려달라는 요청 — 24시간 넘음 ${takedowns.overdue}` : "내려달라는 요청",
      detail: <>대기 {takedowns.pending}{oldest}{isBurst(takedowns) ? ` · 지난 1시간 ${takedowns.lastHour.requests}건 몰림` : ""} — 내릴 후보에서 처리</>,
      action: { label: "처리", href: "/admin/audit?tab=requests" },
    });
  }
  if (attention && attention.auditRejectsOpen > 0) {
    actions.push({
      key: "audit", tone: "hold", count: attention.auditRejectsOpen, title: "감사가 거절 판정한 발행분이 처리되지 않았습니다",
      detail: <>발행 뒤 감사가 &ldquo;제품 아님&rdquo;으로 본 것 — 사람이 내리거나 유지로 정해야 합니다.</>,
      action: { label: "내릴 후보", href: "/admin/audit" },
    });
  }
  if (attention && attention.healthOverdue > 0) {
    actions.push({
      key: "health-overdue", tone: attention.healthOverdue > 5_000 ? "hold" : "clear", count: attention.healthOverdue, title: "생존 확인이 6시간 넘게 밀린 제품",
      detail: <>uptime-ping 처리량이 목표(시간당 {attention.healthTargetPerHour.toLocaleString("ko-KR")})에 못 미치면 쌓입니다.</>,
    });
  }
  if (attention && attention.introNeedsEditor > 0) {
    actions.push({
      key: "intro", tone: "hold", count: attention.introNeedsEditor, title: "소개 확인이 필요한 제품",
      detail: <>소개 검수가 근거로는 알 수 없다고 한 것 — 검수 잡은 멈춰 있습니다.</>,
      action: { label: "제품 관리", href: "/admin/products?filter=intro" },
    });
  }
  const quotaAccount = accounts?.find((row) => row.enabled && row.coreQuota);
  const quota = quotaAccount ? parseCoreQuota(quotaAccount.coreQuota) : null;
  if (quota && quota.limit > 0 && quota.remaining / quota.limit < 0.1) {
    actions.push({
      key: "quota", tone: "critical", count: quota.remaining, title: "GitHub API 한도가 거의 남지 않았습니다",
      detail: <>{quota.remaining}/{quota.limit} · {new Date(quota.reset * 1000).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false })} 초기화</>,
      action: { label: "수집 계정", href: "/admin/github-accounts" },
    });
  }
  if (actions.length === 0) {
    actions.push({
      key: "clear", tone: "clear", count: "0", title: "지금 손댈 것이 없습니다",
      detail: <>실패한 작업이 없고, 사람이 가려야 할 후보도 없습니다.</>,
    });
  }

  /** 신호별로 조사한 수와 그중 목록에 오른 수 */
  const signals = new Map<string, { judged: number; kept: number }>();
  for (const row of signalRows) {
    const entry = signals.get(row.signal) ?? { judged: 0, kept: 0 };
    entry.judged += row.count;
    if (row.state === "approved" || row.state === "published") entry.kept += row.count;
    signals.set(row.signal, entry);
  }

  const search = await searchLogSummary(7).catch(() => null);

  const probes: ConnectionProbe[] = (["claude", "codex"] as const).map((provider) => ({
    provider, result: agent?.accounts?.[provider]?.probe?.result ?? agent?.accounts?.[provider]?.result ?? null,
    checkedAt: agent?.accounts?.[provider]?.probe?.checkedAt ?? null,
  }));
  // Grok 은 reviewer 의 grok-session-check 잡이 4시간마다 남기는 관측(service:grok:<instance>) — 가장 최근 것 하나
  const grok = ops.observations.filter((row) => row.key.startsWith("service:grok:"))
    .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())[0];
  if (grok) probes.push({ provider: "grok", result: typeof grok.value.result === "string" ? grok.value.result : null, checkedAt: grok.observedAt });
  const roleRows = roles?.roles ?? [];
  const scheduler = roles?.scheduler ?? { freshReplicas: 0, alarm: true };
  const dashboard = (
    <>
      <KpiStrip series={hourly} textPending={health?.pendingGeneration ?? 0} verifyPending={health?.pendingVerification ?? 0} />
      <StageRail snapshot={throughput} flow={flow} humanQueue={needsReview} humanOldestDays={oldestWait} humanSplit={seconds.counts.needsHuman}
        signals={workerProgress?.stages} liveness={workerProgress?.liveness} />
      <RolesTable roles={roleRows} scheduler={scheduler} web={web} />
      <ModelCards rows={models ?? []} probes={probes} />
      <AttentionList items={actions} />
      <SignalTable rows={yields ?? []} />
      <TodayFeed today={today ?? { total24h: 0, korean24h: 0, latest: [] }} down={down.length} />
    </>
  );
  const statusChips = <StatusChips roles={roleRows} scheduler={scheduler} web={web} models={models ?? []}
    quota={quota ? { remaining: quota.remaining, limit: quota.limit, resetAt: new Date(quota.reset * 1000).toISOString() } : null} />;

  return (
    <main className="pb-10">
      <OperationsCenter dashboard={dashboard} statusChips={statusChips} searchHealth={<><SearchHealthPanel health={health} observedAt={healthObservation?.observedAt} /><TranslationProgress progress={translation} /></>} key={initialTab} initialTab={initialTab} queue={<QueuePreview entries={queue.entries} total={queue.total} counts={decisions.counts} filters={filters} totalWaiting={needsReview} filterScanTruncated={causes?.truncated || Object.values(decisions.counts).reduce((sum, count) => sum + count, 0) < needsReview} />} data={ops} candidates={manual} reviewMode={settings.reviewMode} enabled={settings.enabled}
        jobs={JOB_NAMES.map(name => {
          const job = states.get(name);
          return { name, status: jobStatusLabel(job), lastRunAt: job?.lastRunAt?.toISOString() ?? null,
            lastSuccessAt: job?.lastSuccessAt?.toISOString() ?? null, nextScheduledAt: job?.nextScheduledAt?.toISOString() ?? null,
            notBefore: job?.notBefore?.toISOString() ?? null, workerSeenAt: job?.workerSeenAt?.toISOString() ?? null,
            requestedVersion: job?.requestedVersion ?? 0, processedVersion: job?.processedVersion ?? 0, runs: job?.runs ?? 0,
            lastError: job?.lastError?.slice(0,1000) ?? null, cursor: JSON.stringify(redact(job?.cursor ?? null),null,2).slice(0,8000) };
        })}>
      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        <Panel
          title="작업"
          note="예약과 실행, 워커 생존을 구분합니다. 마지막 tick 성공은 대기 중인 모든 항목의 처리 완료를 뜻하지 않습니다."
        >
          {/* 좁은 화면에서 표가 밀려 나가지 않게 감싼다 */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-[13px]">
              <thead className="text-fg-3">
                <tr className="text-left">
                  <th className="pb-2 font-medium">이름</th>
                  <th className="pb-2 font-medium">상태</th>
                  <th className="pb-2 font-medium">워커 관측</th>
                <th className="pb-2 font-medium">마지막 실행</th>
                <th className="pb-2 font-medium">tick 성공</th>
                <th className="pb-2 font-medium">횟수</th>
              </tr>
            </thead>
            <tbody>
              {JOB_NAMES.map((name) => {
                const state = states.get(name);
                return (
                  <tr key={name} className="border-t border-line">
                    <td className="py-2 font-mono">{name}<span className="block text-[13px] text-fg-3">{JOB_CATALOG.find(job => job.name === name)?.role}</span></td>
                    <td className="py-2 text-fg-2">{name === "heartbeat" ? "스케줄러 관측" : jobStatusLabel(state)}</td>
                    <td className="py-2 text-fg-2">{when(state?.workerSeenAt ?? null)}</td>
                    <td className="py-2 text-fg-2">{state?.lastRunAt ? when(state.lastRunAt) : "실행 기록 없음"}</td>
                    <td className="py-2 text-fg-2">{state ? when(state.lastSuccessAt) : "—"}</td>
                    <td className="py-2 font-mono text-fg-2">{state?.runs ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>

          {jobStates
            .filter((job) => job.lastError)
            .map((job) => (
              <p key={job.name} className="mt-3 rounded-[10px] border border-down/40 bg-down/10 px-3 py-2 text-[13px] text-down">
                <span className="font-mono font-semibold">{job.name}</span> {job.lastError}
              </p>
            ))}
        </Panel>

        <Panel
          title="제품 근거 수집"
          note="오류 원문은 위 작업 표 한 곳에서만 보고, 여기서는 처리해야 할 출처 수와 마지막 성공 시각만 봅니다."
        >
          <dl className="flex flex-wrap gap-x-8 gap-y-3 text-[13px]">
            <div><dt className="text-fg-3">수집 기한 지난 출처</dt><dd className="mt-1 font-mono font-bold">{evidenceSummary.due}</dd></div>
            <div><dt className="text-fg-3">오래됨</dt><dd className="mt-1 font-mono font-bold">{evidenceSummary.stale}</dd></div>
            <div><dt className="text-fg-3">실패·연결 끊김</dt><dd className="mt-1 font-mono font-bold">{evidenceSummary.failed}</dd></div>
            <div><dt className="text-fg-3">마지막 성공</dt><dd className="mt-1 font-semibold">{evidenceJob ? when(evidenceJob.lastSuccessAt) : "실행 기록 없음"}</dd></div>
          </dl>
        </Panel>

        <Panel
          title="랭킹 스냅샷"
          note="작업 실행 상태는 위 표의 ranking-refresh 한 곳에서만 확인하고, 여기서는 마지막으로 저장된 시즌 결과의 나이만 봅니다."
        >
          {rankingSeason ? (
            <dl className="flex flex-wrap gap-x-8 gap-y-3 text-[13px]">
              <div>
                <dt className="text-fg-3">현재 시즌</dt>
                <dd className="mt-1 font-mono font-semibold">{rankingSeason.key}</dd>
              </div>
              <div>
                <dt className="text-fg-3">기간</dt>
                <dd className="mt-1 font-semibold">
                  {rankingSeason.startsAt.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}
                  {" – "}
                  {rankingSeason.endsAt.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}
                </dd>
              </div>
              <div>
                <dt className="text-fg-3">마지막 집계</dt>
                <dd className={`mt-1 font-semibold ${rankingStale ? "text-down" : "text-up"}`}>
                  {rankingSeason.refreshedAt ? when(rankingSeason.refreshedAt) : "집계 없음"}
                  {rankingSeason.refreshedAt && rankingStale && " · 오래됨"}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-[13px] text-fg-3">아직 생성된 랭킹 시즌이 없습니다.</p>
          )}
        </Panel>

        {down.length > 0 && (
          <Panel
            title="응답하지 않는 제품"
            note={`${DOWN_THRESHOLD}회 넘게 연속으로 실패해 공개 목록에서 빠진 것입니다. 지우거나 차단하지는 않습니다 — 다시 열리면 그대로 돌아옵니다.`}
          >
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {down.map((item) => (
                <li key={item.slug} className="flex flex-wrap items-baseline gap-x-2">
                  <a href={`/p/${item.slug}`} className="font-semibold hover:text-accent">
                    {item.name}
                  </a>
                  <span className="font-mono text-[13px] text-fg-3">
                    {item.status === 0 ? "접속 실패" : `HTTP ${item.status}`} · {item.failures}회 연속
                    {item.downSince && ` · ${when(item.downSince)}부터`}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel title="프론티어" note="조사 대상 큐입니다. 대기가 0이면 crawl-seed가 더 찾아야 합니다.">
          <Counts counts={frontier} empty="아직 발견한 레포가 없습니다." />
        </Panel>

        <Panel title="후보" note="판정 결과입니다. 심사 대기는 사람이 가를 것, 발행 대기는 다음 발행 틱이 올릴 것입니다.">
          <Counts counts={candidates} empty="아직 판정한 것이 없습니다." />
        </Panel>

        {topClicked.length > 0 && (
          <Panel
            title="많이 눌린 제품 (30일)"
            note="하루 단위로 굴린 집계입니다. 원천은 35일이면 지우므로 오래된 구간은 여기서만 볼 수 있습니다."
          >
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {topClicked.map((item) => (
                <li key={item.slug} className="flex items-baseline gap-2">
                  <a href={`/p/${item.slug}`} className="font-semibold hover:text-accent">
                    {item.slug}
                  </a>
                  <span className="font-mono text-fg-3">{item.clicks}회</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel
          title="신호별 수율"
          note="어떤 검색어가 쓸 만한 것을 데려오는지입니다. 켜고 끄기 전에 숫자로 봅니다."
        >
          {signals.size === 0 ? (
            <p className="text-[13px] text-fg-3">아직 판정한 것이 없습니다.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-[13px]">
                <thead className="text-fg-3">
                  <tr className="text-left">
                    <th className="pb-2 font-medium">신호</th>
                  <th className="pb-2 font-medium">판정한 수</th>
                  <th className="pb-2 font-medium">목록에 오른 수</th>
                  <th className="pb-2 font-medium">수율</th>
                </tr>
              </thead>
              <tbody>
                {[...signals]
                  .sort((a, b) => b[1].kept / b[1].judged - a[1].kept / a[1].judged)
                  .map(([signal, { judged, kept }]) => (
                    <tr key={signal} className="border-t border-line">
                      <td className="py-2">{signal}</td>
                      <td className="py-2 font-mono text-fg-2">{judged}</td>
                      <td className="py-2 font-mono text-fg-2">{kept}</td>
                      <td className="py-2 font-mono font-bold">{Math.round((kept / judged) * 100)}%</td>
                    </tr>
                  ))}
              </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="검색"
          note="지난 7일 동안 사람들이 무엇을 찾았고 무엇을 못 찾았는지입니다. 못 찾은 말이 다음에 고칠 곳입니다."
        >
          {!search || search.searches === 0 ? (
            <p className="text-[13px] text-fg-3">아직 기록된 검색이 없습니다.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-fg-2">
                <span>검색 <b className="font-semibold">{search.searches.toLocaleString("ko-KR")}</b>회</span>
                <span>0건 <b className={`font-semibold ${search.zero > 0 ? "text-down" : ""}`}>{search.zero.toLocaleString("ko-KR")}</b>회
                  ({Math.round((search.zero / search.searches) * 100)}%)</span>
                <span>한국어 번역 <b className="font-semibold">{search.translated.toLocaleString("ko-KR")}</b>회</span>
                <span>p95 <b className="font-semibold">{search.p95Ms === null ? "—" : `${search.p95Ms.toLocaleString("ko-KR")}ms`}</b></span>
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <h4 className="text-[13px] font-semibold text-down">못 찾은 말</h4>
                  {search.misses.length === 0 ? <p className="mt-1 text-[13px] text-fg-3">없습니다.</p> : (
                    <ul className="mt-1 flex flex-col gap-1 text-[13px]">
                      {search.misses.map((row) => (
                        <li key={row.query} className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-fg-2">{row.query}
                            {row.keywords && <span className="ml-1.5 font-mono text-fg-3">→ {row.keywords}</span>}</span>
                          <span className="shrink-0 font-mono text-fg-3">{row.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h4 className="text-[13px] font-semibold text-fg-2">찾은 말</h4>
                  {search.hits.length === 0 ? <p className="mt-1 text-[13px] text-fg-3">없습니다.</p> : (
                    <ul className="mt-1 flex flex-col gap-1 text-[13px]">
                      {search.hits.map((row) => (
                        <li key={row.query} className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-fg-2">{row.query}</span>
                          <span className="shrink-0 font-mono text-fg-3">{row.count}회 · {row.results}건</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
        </Panel>

        <Panel
          title="거부 사유"
          note="어떤 규칙이 얼마나 거르고 있는지입니다. 한 사유가 압도적이면 그 기준부터 의심합니다."
        >
          {rejections.length === 0 ? (
            <p className="text-[13px] text-fg-3">아직 거부한 것이 없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {rejections.map((row) => (
                <li key={row.reason} className="flex items-center gap-3 text-[13px]">
                  <span className="w-[150px] shrink-0 text-fg-2">{REASON_LABELS[row.reason] ?? row.reason}</span>
                  <span className="h-[6px] rounded-full bg-accent/60" style={{ width: `${(row.count / rejectedTotal) * 60}%` }} />
                  <span className="font-mono text-fg-3">
                    {row.count} · {Math.round((row.count / rejectedTotal) * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      </OperationsCenter>
    </main>
  );
}

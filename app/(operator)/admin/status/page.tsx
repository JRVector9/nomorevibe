import { cache, Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { frontierCounts, candidateCounts, rejectionBreakdown } from "@/lib/crawl/repository";
import { getSettings } from "@/lib/crawl/settings";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { downProducts, DOWN_THRESHOLD } from "@/lib/domain/products/health";
import { topClickedSince } from "@/lib/domain/products/clicks";
import { JOB_NAMES } from "@/lib/jobs/catalog";
import { jobStatusLabel } from "@/lib/jobs/status";
import { getCurrentSeason, RANKING_STALE_MS } from "@/lib/domain/ranking/view";
import { Panel } from "@/components/Panel";
import { OperationsCenter } from "./OperationsCenter";
import { PipelineControlStatus } from "./PipelineControlStatus";
import { PipelineCompletions } from "./PipelineCompletions";
import { ModelRouteContracts } from "./ModelRouteContracts";
import { readModelRouteStatus } from "@/lib/operations/model-route-status";
import { currentModelEnv } from "@/lib/operations/model-env";
import { SOURCE_BUFFER_OBSERVATION_KEY, SourceBufferCard } from "./SourceBufferCard";
import { sourceBufferCsrf } from "./source-buffer-csrf";
import { jobControlCsrf } from "./job-control-csrf";
import { CollectorTotalsDetail, CrawlerActivity } from "./CrawlerActivity";
import { readDeferrals, readTallies } from "@/lib/operations/flow-reads";
import { buildCrawlerActivity, COLLECTOR_JOBS } from "@/lib/operations/crawler-activity";
import { signalYields, todayPublications } from "@/lib/operations/dashboard";
import { JOB_LABELS, ROLE_LABELS } from "@/lib/operations/contracts";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { catalogJobsForBatch } from "@/lib/jobs/batches";
import { splitServiceRoleRows } from "@/lib/operations/split-service-roles";
import { ATTENTION_HISTORY_KEY, attentionAcks, readAttentionHistory, recordAttentionSample } from "@/lib/operations/attention";
import { webWritable } from "@/lib/operations/dr/web-gate";
import { readXStatus } from "@/lib/operations/x-status";
import { formatAgo, formatDay, formatListTime } from "@/lib/format/time";
import { KpiStrip } from "./dashboard/KpiStrip";
import { StageRail } from "./dashboard/StageRail";
import { RolesTable } from "./dashboard/RolesTable";
import { ModelCards, type ConnectionProbe } from "./dashboard/ModelCards";
import { AttentionList } from "./dashboard/AttentionList";
import { SignalTable } from "./dashboard/SignalTable";
import { TodayFeed } from "./dashboard/TodayFeed";
import { RepoHealthCard } from "./dashboard/RepoHealthCard";
import { StatusChips } from "./dashboard/StatusChips";
import { OperationsGuidance } from "./OperationsGuidance";
import { StarObservationCard } from "./StarObservationCard";
import { getStarGrowthPage } from "@/lib/domain/products/star-growth";
import { manualCandidates } from "@/lib/operations/categories";
import { ManualClassification } from "./ManualClassification";
import { logger, redact } from "@/lib/observability/logger";
import { humanWaitLabel } from "@/lib/crawl/human-queue";
import { ACTION_LINKS } from "./action-links";
import { translationProgress } from "@/lib/crawl/translations";
import { TranslationProgress } from "./TranslationProgress";
import { REASON_LABELS } from "../reasons";
import { searchLogSummary } from "@/lib/domain/products/search-log";
import { SearchHealthPanel } from "./SearchHealthPanel";
import { ScrollToHash } from "../ScrollToHash";
import { ScrollTable } from "../components/ScrollTable";
import { actionCounts, buildActions, deriveJobHealth, deriveStatus, loadActionInputs, rememberCriticalCount, splitActions, type DerivedStatus } from "./attention";
import { completionsOnce, controlStatusOnce, flowOnce, hourlyOnce } from "./render-reads";
import { EnrichmentDot, EnrichmentDotSlot, FlowSideCells } from "./flow-slots";
import { FlowDetailSlot } from "./FlowDetail";
import { flowVerdict, otherModelSlots } from "./flow-model";
import { workOwnersByAction } from "./work-owners";
import { OPS_FRESH_COOKIE } from "./fresh";
import { PageStamp } from "@/app/(operator)/admin/components/PageStamp";
import { withDeadline } from "@/lib/operations/deadline";

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

const n = (value: number) => value.toLocaleString("ko-KR");

/** 한 묶음이 실패해도 화면은 나가야 한다 — 그 칸만 비운다 */
const warn = (event: string) => (error: unknown) => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};

function Counts({ counts, empty }: { counts: Record<string, number>; empty: string }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <p className="text-[13px] text-fg-3">{empty}</p>;
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2">
      {rows.map(([key, count]) => (
        <div key={key} className="flex items-baseline gap-2">
          <dt className="text-[13px] text-fg-2">{STATE_LABELS[key] ?? key}</dt>
          <dd className="font-mono text-[14px] font-bold">{n(count)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 느린 조각이 오기 전의 자리 — 같은 칸 수를 차지해 격자가 흔들리지 않게 */
function CardPending({ span, label }: { span: string; label: string }) {
  return <section className={`dash-card ${span}`} aria-label={label} aria-busy="true"><p className="text-[13px] text-fg-3">{label} 세는 중…</p></section>;
}

/*
 * 아래 조각들은 따로 흘려보낸다(2026-10-08 UX 감사 ADM-35) — 머리 칩과 조치할 일을 먼저 그리고, 느린 집계는 오는 대로 채운다.
 * 각 조각은 실패하면 그 칸만 비운다.
 */

async function PipelineControlSlot() {
  return <PipelineControlStatus status={await controlStatusOnce()} />;
}

/** 모델 경로 계약·전환 진행(ops-v8 PR8) — 운영 CLI status 와 같은 readback 을 복제본에서만. 못 읽으면 보류 */
async function ModelRouteSlot() {
  return <ModelRouteContracts status={await readModelRouteStatus(await currentModelEnv())} />;
}

/** PR13c 처리 지표 — 복제본에서 따로 센다. 못 읽으면 칸마다 미확인으로 남는다 */
async function PipelineCompletionsSlot() {
  return <PipelineCompletions status={await completionsOnce()} />;
}

async function KpiSlot({ derived, fresh }: { derived: DerivedStatus; fresh: boolean }) {
  const hourly = await withDeadline(hourlyOnce(fresh)).catch(warn("operations.hourly_unavailable"));
  return <KpiStrip series={hourly} textPending={derived.health?.pendingGeneration ?? null} verifyPending={derived.health?.pendingVerification ?? null} />;
}

async function StageSlot({ inputs, derived }: { inputs: Awaited<ReturnType<typeof loadActionInputs>>; derived: DerivedStatus }) {
  const flow = await flowOnce();
  return <StageRail snapshot={inputs.throughput} flow={flow} human={inputs.overview}
    signals={derived.workerProgress?.stages} liveness={derived.workerProgress?.liveness} />;
}

async function SignalSlot({ settings, fresh }: { settings: CrawlSettings; fresh: boolean }) {
  const rows = await withDeadline(signalYields(settings, 7, { fresh })).catch(warn("operations.signals_unavailable"));
  return rows ? <SignalTable rows={rows} /> : <p className="dash-card dash-4">신호별 수율을 읽지 못했습니다.</p>;
}

async function TodaySlot({ down, now }: { down: number; now: string }) {
  const today = await withDeadline(todayPublications()).catch(warn("operations.today_unavailable"));
  return today ? <TodayFeed today={today} down={down} now={now} /> : <p className="dash-card dash-12">최근 24시간 발행 집계를 읽지 못했습니다.</p>;
}

/**
 * 크롤러 활동 — 회차 누적(job-tally)·미룸(defer)을 복제본 전용 15초 캐시로 읽어 함께 짓는다. 첫 그림을 기다리게 하지 않게
 * 따로 흘려보내고(복제본이 느려도 나머지 화면은 나간다), 같은 렌더의 표·작업 상세 창이 한 번만 읽는다(React cache).
 */
const crawlerReportFor = cache(async (inputs: Awaited<ReturnType<typeof loadActionInputs>>, fresh: boolean) => {
  const [tallies, deferrals] = await Promise.all([
    readTallies(fresh).catch(() => ({ ok: false as const, reason: "error" as const })),
    readDeferrals(fresh).catch(() => ({ ok: false as const, reason: "error" as const })),
  ]);
  return buildCrawlerActivity({ settings: inputs.settings, jobs: inputs.jobStates, observations: inputs.ops.observations,
    roles: inputs.roles?.roles ?? null, throughput: inputs.throughput, now: new Date(inputs.ops.fetchedAt),
    tallies: tallies.ok ? tallies.value.jobs : null, deferrals: deferrals.ok ? deferrals.value.jobs : null });
});

async function CrawlerActivitySlot({ inputs, fresh }: { inputs: Awaited<ReturnType<typeof loadActionInputs>>; fresh: boolean }) {
  const report = await withDeadline(crawlerReportFor(inputs, fresh)).catch(warn("operations.crawler_activity_unavailable"));
  // X 칸은 이미 읽은 관측 줄의 X 수집기 보고(readXStatus) — 흐름 상세·X 보고 끊김 조치와 같은 값, 새 쿼리 없음
  return report ? <CrawlerActivity report={report} x={readXStatus(inputs.ops.observations, inputs.ops.fetchedAt)} />
    : <p className="ops-note">크롤러 활동을 제때 읽지 못했습니다 — 미확인. 다음 갱신에서 다시 읽습니다.</p>;
}

/** 작업 상세 창의 "최근 1시간 · 24시간 누적" — 수집기만 */
async function JobTotalsSlot({ name, inputs, fresh }: { name: string; inputs: Awaited<ReturnType<typeof loadActionInputs>>; fresh: boolean }) {
  const report = await withDeadline(crawlerReportFor(inputs, fresh)).catch(() => null);
  if (!report) return <p className="ops-note">누적을 제때 읽지 못했습니다 — 미확인.</p>;
  const row = report.jobs.find((job) => job.name === name);
  return row ? <CollectorTotalsDetail row={row} now={inputs.ops.fetchedAt} /> : null;
}

async function ManualSlot() {
  const candidates = await withDeadline(manualCandidates()).catch(warn("operations.manual_candidates_unavailable"));
  return candidates ? <ManualClassification candidates={candidates} /> : <p className="ops-note">분류할 후보를 제때 읽지 못했습니다 — 미확인.</p>;
}

/**
 * 사유 번역 진행은 캐시가 비면 2초 넘게 센다(translations.ts) — 진단 칸 하나 때문에 화면 전체를 붙잡지 않게
 * 따로 흘려보낸다. 못 세면 이 줄만 비운다.
 */
async function TranslationProgressSlot({ now }: { now: string }) {
  const progress = await withDeadline(translationProgress()).catch(warn("operations.translation_unavailable"));
  return progress ? <TranslationProgress progress={progress} now={now} /> : <TranslationProgressPending failed />;
}

function TranslationProgressPending({ failed = false }: { failed?: boolean }) {
  return <p aria-busy={!failed} className="rounded-[12px] border border-line bg-bg-card px-3 py-2 text-[13px] text-fg-3">
    사유 번역 {failed ? "진행을 읽지 못했습니다" : "진행을 세는 중"}</p>;
}

async function StarObservationSlot({ now }: { now: string }) {
  const page = await withDeadline(getStarGrowthPage({ now: new Date(now), limit: 0 })).catch(warn("operations.star_observation_unavailable"));
  return <StarObservationCard page={page} />;
}

/**
 * 진단 탭의 표들 — 전에는 전체 현황 아래 접힌 "수집·근거·랭킹 상세 지표"였다(ADM-16).
 * 신호별 수율은 전체 현황의 카드 하나만 남기고 여기서는 뺐다(같은 표가 두 번 나왔다).
 */
async function DiagnosticsPanels({ inputs, derived }: { inputs: Awaited<ReturnType<typeof loadActionInputs>>; derived: DerivedStatus }) {
  const { jobStates, evidenceSummary, downCount, ops } = inputs;
  const now = ops.fetchedAt;
  const read = await withDeadline(Promise.all([
    frontierCounts(), candidateCounts(), rejectionBreakdown(), getCurrentSeason(), downProducts(), topClickedSince(30),
    searchLogSummary(7).catch(() => null),
  ])).catch(warn("operations.diagnostics_unavailable"));
  if (!read) return <p className="mt-3 text-[13px] text-fg-2">진단 지표를 제때 읽지 못했습니다 — 미확인. 다음 갱신에서 다시 읽습니다.</p>;
  const [frontier, candidates, rejections, rankingSeason, down, topClicked, search] = read;
  const rejectedTotal = rejections.reduce((sum, r) => sum + r.count, 0);
  const rankingStale = !rankingSeason?.refreshedAt || Date.parse(now) - rankingSeason.refreshedAt.getTime() > RANKING_STALE_MS;
  const evidenceJob = derived.states.get("product-evidence-refresh");
  const activeJobs = new Set(catalogJobsForBatch(inputs.jobBatch).map((job) => job.name));
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
      <Panel
        title="작업"
        note="예약과 실행, 워커 생존을 구분합니다. 마지막 회차 성공은 대기 중인 모든 항목의 처리 완료를 뜻하지 않습니다."
      >
        <ScrollTable label="작업 표">
          <table className="w-full min-w-[420px] text-[13px]">
            <thead className="text-fg-3">
              <tr className="text-left">
                <th className="pb-2 font-medium">이름</th>
                <th className="pb-2 font-medium">상태</th>
                <th className="pb-2 font-medium">워커 관측</th>
                <th className="pb-2 font-medium">마지막 실행</th>
                <th className="pb-2 font-medium">회차 성공</th>
                <th className="pb-2 font-medium">횟수</th>
              </tr>
            </thead>
            <tbody>
              {JOB_NAMES.map((name) => {
                const state = derived.states.get(name);
                const role = JOB_CATALOG.find((job) => job.name === name)?.role;
                // 스케줄러 관측(heartbeat)은 실행되는 잡이 아니다 — 스케줄러가 틱마다 워커 관측 시각만 남긴다(markSchedulerSeen)
                const heartbeat = name === "heartbeat";
                // 지금 batch 방식에서 돌지 않는 잡(versioned 전용, 예: 공식 사이트 근거는 legacy 에서 crawler 가 대신 한다) — 고장이 아니다
                const resting = !heartbeat && !activeJobs.has(name);
                return (
                  <tr key={name} className="border-t border-line">
                    <td className="py-2" title={name}>{JOB_LABELS[name] ?? name}<span className="block text-[13px] text-fg-3" title={role}>{role ? ROLE_LABELS[role] ?? role : ""}</span></td>
                    <td className="py-2 text-fg-2">{heartbeat ? "스케줄러 관측" : resting ? `${inputs.jobBatch.mode} 모드라 쉼(정상)` : jobStatusLabel(state)}</td>
                    <td className="py-2 text-fg-2">{formatAgo(state?.workerSeenAt, now, "없음")}</td>
                    <td className="py-2 text-fg-2">{heartbeat ? `스케줄러 마지막 틱 ${formatAgo(state?.workerSeenAt, now, "관측 없음")}`
                      : state?.lastRunAt ? formatAgo(state.lastRunAt, now) : "실행 기록 없음"}</td>
                    <td className="py-2 text-fg-2">{heartbeat || !state ? "—" : formatAgo(state.lastSuccessAt, now, "없음")}</td>
                    <td className="py-2 font-mono text-fg-2">{heartbeat ? "—" : state?.runs ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollTable>

        {jobStates
          .filter((job) => job.lastError)
          .map((job) => (
            <p key={job.name} className="mt-3 rounded-[10px] border border-down/40 bg-down/10 px-3 py-2 text-[13px] text-down">
              <span className="font-semibold" title={job.name}>{JOB_LABELS[job.name] ?? job.name}</span> {job.lastError}
            </p>
          ))}
      </Panel>

      <Panel
        title="제품 근거 수집"
        note="오류 원문은 위 작업 표 한 곳에서만 보고, 여기서는 처리해야 할 출처 수와 마지막 성공 시각만 봅니다."
      >
        <dl className="flex flex-wrap gap-x-8 gap-y-3 text-[13px]">
          <div><dt className="text-fg-3">수집 기한 지난 출처</dt><dd className="mt-1 font-mono font-bold">{n(evidenceSummary.due)}건</dd></div>
          <div><dt className="text-fg-3">오래됨</dt><dd className="mt-1 font-mono font-bold">{n(evidenceSummary.stale)}건</dd></div>
          <div><dt className="text-fg-3">실패·연결 끊김</dt><dd className="mt-1 font-mono font-bold">{n(evidenceSummary.failed)}건</dd></div>
          <div><dt className="text-fg-3">마지막 성공</dt><dd className="mt-1 font-semibold">{evidenceJob ? formatListTime(evidenceJob.lastSuccessAt, now, "없음") : "실행 기록 없음"}</dd></div>
        </dl>
      </Panel>

      <Panel
        title="랭킹 스냅샷"
        note="작업 실행 상태는 위 표의 랭킹 갱신 한 곳에서만 확인하고, 여기서는 마지막으로 저장된 시즌 결과의 나이만 봅니다."
      >
        {rankingSeason ? (
          <dl className="flex flex-wrap gap-x-8 gap-y-3 text-[13px]">
            <div>
              <dt className="text-fg-3">현재 시즌</dt>
              <dd className="mt-1 font-mono font-semibold">{rankingSeason.key}</dd>
            </div>
            <div>
              <dt className="text-fg-3">기간</dt>
              <dd className="mt-1 font-semibold">{formatDay(rankingSeason.startsAt)} – {formatDay(rankingSeason.endsAt)}</dd>
            </div>
            <div>
              <dt className="text-fg-3">마지막 집계</dt>
              <dd className={`mt-1 font-semibold ${rankingStale ? "text-down" : "text-up"}`}>
                {rankingSeason.refreshedAt ? formatListTime(rankingSeason.refreshedAt, now) : "집계 없음"}
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
          note={`${DOWN_THRESHOLD}회 넘게 연속으로 실패해 공개 목록에서 빠진 것 ${n(downCount)}건${downCount > down.length ? ` 중 실패가 많은 ${down.length}건` : ""}입니다. 지우거나 차단하지는 않습니다 — 다시 열리면 그대로 돌아옵니다.`}
        >
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {down.map((item) => (
              <li key={item.slug} className="flex flex-wrap items-baseline gap-x-2">
                <a href={`/p/${item.slug}`} className="font-semibold hover:text-accent">
                  {item.name}
                </a>
                <span className="font-mono text-[13px] text-fg-3">
                  {item.status === 0 ? "접속 실패" : `HTTP ${item.status}`} · {item.failures}회 연속
                  {item.downSince && ` · ${formatListTime(item.downSince, now)}부터`}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="프론티어" note="조사 대상 큐입니다. 대기가 0이면 수집 대상 탐색이 더 찾아야 합니다.">
        <Counts counts={frontier} empty="아직 발견한 레포가 없습니다." />
      </Panel>

      <Panel title="후보" note="판정 결과입니다. 심사 대기는 사람이 가를 것, 발행 대기는 다음 발행 회차가 올릴 것입니다.">
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
        title="검색"
        note="지난 7일 동안 사람들이 무엇을 찾았고 무엇을 못 찾았는지입니다. 못 찾은 말이 다음에 고칠 곳입니다."
      >
        {!search || search.searches === 0 ? (
          <p className="text-[13px] text-fg-3">아직 기록된 검색이 없습니다.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-fg-2">
              <span>검색 <b className="font-semibold">{n(search.searches)}</b>회</span>
              <span>0건 <b className={`font-semibold ${search.zero > 0 ? "text-down" : ""}`}>{n(search.zero)}</b>회
                ({Math.round((search.zero / search.searches) * 100)}%)</span>
              <span>한국어 번역 <b className="font-semibold">{n(search.translated)}</b>회</span>
              <span>p95 <b className="font-semibold">{search.p95Ms === null ? "—" : `${n(search.p95Ms)}ms`}</b></span>
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
  );
}

export default async function StatusPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const settings = await getSettings();
  // 수동 새로고침(5초 쿠키)이면 15·20초 캐시와 1분 집계 캐시를 건너뛴다(fresh.ts, 1분 집계는 분당 상한) — 지금 숫자는 원래 렌더마다 읽는다
  const fresh = (await cookies()).has(OPS_FRESH_COOKIE);
  // 조치할 일과 머리 칩에 드는 것만 기다린다 — 나머지는 아래 Suspense 조각이 따로 센다
  const [inputs, acks] = await Promise.all([loadActionInputs(settings),
    attentionAcks().catch((error) => { warn("operations.attention_acks_unavailable")(error); return new Map(); })]);
  const derived = deriveStatus(inputs);
  // 작업 띠의 색 — 돈 시각이 아니라 진짜 성공·제 일 못 함으로(조치할 일과 같은 판단)
  const jobHealth = new Map(deriveJobHealth(inputs, derived.workerProgress).map((issue) => [issue.job, issue]));
  const { ops, overview, roles, models, attention, downCount } = inputs;
  const now = ops.fetchedAt;

  const actions = buildActions(inputs, derived);
  // 메뉴의 긴급 배지가 이 화면과 같은 수를 보이게(attention.tsx criticalActionCount)
  rememberCriticalCount(actions);
  const history = ops.observations.find((row) => row.key === ATTENTION_HISTORY_KEY);
  const split = splitActions(actions, { samples: readAttentionHistory(history?.value), acks, now: new Date(now) });
  // 24시간 변화를 재려고 한 시간에 한 번 수를 남긴다 — 응답을 보낸 뒤에. fenced DB 에는 남기지 않는다(캐시 관문만)
  after(async () => {
    if (await webWritable()) await recordAttentionSample(actionCounts(actions)).catch(warn("operations.attention_sample_failed"));
  });

  // 작업 상세 창의 "최근 1시간 · 24시간 누적" — 수집기만, 서버가 따로 흘려보내는 조각으로 넘긴다
  const jobTotals = Object.fromEntries(COLLECTOR_JOBS.map(({ name }) => [name,
    <Suspense key={name} fallback={<p className="ops-note" aria-busy="true">누적을 읽는 중…</p>}><JobTotalsSlot name={name} inputs={inputs} fresh={fresh} /></Suspense>]));

  const { agent, web, quota, health, healthObservation } = derived;
  const probes: ConnectionProbe[] = (["claude", "codex"] as const).map((provider) => ({
    provider, result: agent?.accounts?.[provider]?.probe?.result ?? agent?.accounts?.[provider]?.result ?? null,
    checkedAt: agent?.accounts?.[provider]?.probe?.checkedAt ?? null,
  }));
  // Grok 은 reviewer 의 grok-session-check 잡이 4시간마다 남기는 관측(service:grok:<instance>) — 가장 최근 것 하나.
  // 심사에 Grok 을 쓰지 않으면 잡이 아무것도 남기지 않아 옛 관측이 초록으로 남았다(2026-10-08, 34시간 전 것) — 쓸 때만, 5시간 넘으면 오래됨
  const grokConfigured = [settings.firstReview, ...settings.secondReview.voters, ...(settings.secondReview.fallbacks ?? [])]
    .some((voter) => voter?.provider === "grok-cli");
  const grok = ops.observations.filter((row) => row.key.startsWith("service:grok:"))
    .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())[0];
  if (grokConfigured) probes.push({ provider: "grok", checkedAt: grok?.observedAt ?? null,
    result: !grok ? null : derived.ageMs(grok.observedAt) > 5 * 3_600_000 ? "오래됨" : typeof grok.value.result === "string" ? grok.value.result : null });
  const roleRows = roles?.roles ?? null;
  const scheduler = roles?.scheduler ?? null;
  // 판정 알약(v8) — 조치와 같은 동기 입력만으로 센다. 새 쿼리가 없어 첫 그림을 기다리게 하지 않는다
  const verdict = flowVerdict({ split, throughput: inputs.throughput, workerProgress: derived.workerProgress, human: overview });
  const flowSlot = { inputs, derived, actions, fresh };
  // 칸마다 맡은 장비·LLM·작업 일정 — 새로 읽지 않고 이미 읽은 역할 담당·서비스 관측·작업 표·설정·AI 연결·모델 집계에서 모은다
  const owners = workOwnersByAction(actions, { settings, roles: roleRows, instances: ops.serviceInstances, jobs: derived.states,
    batch: inputs.jobBatch, agent: derived.agent, models, modelServers: inputs.modelServers, now });

  /*
   * 전체 현황 — 지금 조치 · 쌓인 일 · 사람 확인 한 줄, 그다음 지표.
   * 폰(ADM-30)에서는 상태 칩 + 조치할 일 + 역할 표만 보이고, ops-phone-rest 로 감싼 지표는 "나머지 지표 보기"로 편다.
   * 심사 대기 표(QueuePreview)는 뺐다 — 같은 후보가 두 화면에서 다른 갈래·다른 거르기로 보였다(ADM-16). 처리는 심사 큐에서.
   */
  const attentionCards = (
    <>
      <AttentionList urgent={split.urgent} backlog={split.backlog} hidden={split.hidden} now={now} owners={owners} />
      <p className="dash-card dash-12 ops-human-line">
        사람 확인 <b>{n(overview.stages.human)}</b>건 · {humanWaitLabel(overview)}
        <Link href={ACTION_LINKS.reviewHuman}>→ 심사 큐</Link>
      </p>
    </>
  );
  const dashboard = (
    <>
      <div className="ops-phone-rest">
        <Suspense fallback={<CardPending span="dash-12" label="지금 처리량" />}><KpiSlot derived={derived} fresh={fresh} /></Suspense>
        <Suspense fallback={<CardPending span="dash-8" label="파이프라인" />}><StageSlot inputs={inputs} derived={derived} /></Suspense>
        {/* 레일 오른쪽의 빈 4칸(1,181px 이상) — 들어오는 곳·발행 후 보강·설정 전환(v8). 레일 높이 안, 칸마다 따로 흐른다 */}
        <FlowSideCells variant="rail" {...flowSlot} />
        {/* 파이프라인 제어·처리 지표도 지표다 — 폰에서는 역할 표 위가 아니라 "나머지 지표 보기" 아래(ADM-30) */}
        <Suspense fallback={<CardPending span="dash-12" label="파이프라인 제어 상태" />}><PipelineControlSlot /></Suspense>
        <Suspense fallback={<CardPending span="dash-12" label="처리 지표" />}><PipelineCompletionsSlot /></Suspense>
      </div>
      <RolesTable roles={roleRows} scheduler={scheduler} web={web} />
      <div className="ops-phone-rest">
        {models ? <ModelCards rows={models} probes={probes} others={otherModelSlots(settings)} /> : <p className="dash-card dash-12">모델 상태를 읽지 못했습니다.</p>}
        <Suspense fallback={<CardPending span="dash-4" label="신호별 수율" />}><SignalSlot settings={settings} fresh={fresh} /></Suspense>
        <Suspense fallback={<CardPending span="dash-12" label="최근 24시간 발행" />}><TodaySlot down={downCount} now={now} /></Suspense>
        {attention && <RepoHealthCard health={attention.repoHealth} review={attention.repoReview} />}
      </div>
    </>
  );
  const statusChips = <StatusChips roles={roleRows} scheduler={scheduler} web={web} models={models} now={now} quota={quota} />;
  const diagnostics = (
    <>
      <SearchHealthPanel health={health} observedAt={healthObservation?.observedAt} />
      <OperationsGuidance quota={quota} now={now} />
      <Suspense fallback={<CardPending span="dash-12" label="8시간 스타 관측" />}><StarObservationSlot now={now} /></Suspense>
      <Suspense fallback={<TranslationProgressPending />}><TranslationProgressSlot now={now} /></Suspense>
      <Suspense fallback={<p className="mt-3 text-[13px] text-fg-3" aria-busy="true">진단 지표를 세는 중…</p>}>
        <DiagnosticsPanels inputs={inputs} derived={derived} />
      </Suspense>
    </>
  );

  // 진단 탭 맨 끝의 새 칸(ops-v8 PR8) — 원본 공급 조절은 이미 읽은 설정·관측만 쓰고, 경로 계약은 복제본에서만 따로 읽는다
  const secret = authSecret();
  const controls = (
    <div className="mt-3 grid grid-cols-1 gap-3">
      <SourceBufferCard enabled={settings.discover.sourceBuffer.enabled}
        observation={ops.observations.find((row) => row.key === SOURCE_BUFFER_OBSERVATION_KEY)}
        csrf={secret ? { token: sourceBufferCsrf(admin, secret), expiresAt: admin.exp } : null} />
      <Suspense fallback={<p className="text-[13px] text-fg-3" aria-busy="true">모델 경로 계약을 읽는 중…</p>}><ModelRouteSlot /></Suspense>
    </div>
  );

  // 흐름 상세 탭(v8) — 레일 옆 칸과 같은 칸을 맨 위에(좁은 화면에서도 여기서 본다)
  const flowDetail = (
    <div className="ops-flow-detail">
      <FlowSideCells variant="tab" {...flowSlot} />
      <p className="ops-v8-note">전체 현황의 레일 옆 칸과 같은 내용입니다 · 1,180px 이하 화면에서는 여기서 봅니다</p>
      {/* 소스 → 심사 흐름 → 보강, 노드 상세 · 장부 쉬운 말 요약 · 모델 자리 전체 · 미룬 이유(v8 PR6) */}
      <Suspense fallback={<p className="ops-v8-note" aria-busy="true">흐름 상세를 읽는 중…</p>}><FlowDetailSlot {...flowSlot} /></Suspense>
    </div>
  );

  return (
    <main className="pb-10"><PageStamp />
      <OperationsCenter attention={attentionCards} controls={controls} dashboard={dashboard} statusChips={statusChips} diagnostics={diagnostics}
        jobControlCsrf={secret ? { token: jobControlCsrf(admin, secret), expiresAt: admin.exp } : undefined}
        verdict={verdict} flow={flowDetail}
        enrichmentDot={<Suspense fallback={<EnrichmentDot title="발행 후 보강 세는 중" />}><EnrichmentDotSlot {...flowSlot} /></Suspense>}
        crawlers={<Suspense fallback={<p className="ops-note" aria-busy="true">크롤러 활동을 읽는 중…</p>}><CrawlerActivitySlot inputs={inputs} fresh={fresh} /></Suspense>}
        jobTotals={jobTotals}
        manual={<Suspense fallback={<p className="ops-note" aria-busy="true">분류할 후보를 읽는 중…</p>}><ManualSlot /></Suspense>}
        // 시간별 조치 수는 화면에 쓰지 않는다 — 브라우저로 보내지 않는다
        data={{ ...ops, observations: ops.observations.filter((row) => row.key !== ATTENTION_HISTORY_KEY) }}
        reviewMode={settings.reviewMode} enabled={settings.enabled}
        // 분리 역할 생존 행 — versioned 이거나 그 역할의 후보가 최근에 있을 때만, 경보는 versioned 에서만
        splitRoles={splitServiceRoleRows({ batchMode: inputs.jobBatch.mode, observations: ops.observations, now: new Date(now).getTime() })}
        // 지금 batch 상태에서 돌지 않는 versioned 전용 잡은 생존 띠·실행 요청에 올리지 않는다(실패로 보이고 요청해도 안 돈다)
        jobs={catalogJobsForBatch(inputs.jobBatch).map(({ name }) => {
          const job = derived.states.get(name);
          const health = jobHealth.get(name);
          // 랭킹은 주기가 없어(집계가 요청한다) 잡 판단에 들지 않는다 — 랭킹 멈춤 조치와 같은 색을 단다
          const ranking = name === "ranking-refresh" ? actions.find((item) => item.key === "ranking-stale") : undefined;
          return { name, status: jobStatusLabel(job), lastRunAt: job?.lastRunAt?.toISOString() ?? null,
            lastSuccessAt: job?.lastSuccessAt?.toISOString() ?? null, nextScheduledAt: job?.nextScheduledAt?.toISOString() ?? null,
            notBefore: job?.notBefore?.toISOString() ?? null, workerSeenAt: job?.workerSeenAt?.toISOString() ?? null,
            requestedVersion: job?.requestedVersion ?? 0, processedVersion: job?.processedVersion ?? 0, runs: job?.runs ?? 0,
            lastError: job?.lastError?.slice(0,1000) ?? null, cursor: JSON.stringify(redact(job?.cursor ?? null),null,2).slice(0,8000),
            health: health ? { level: health.level, text: health.degraded
              ? `제 일 못 함 ${health.degraded.code}${health.degraded.detail ? ` (${health.degraded.detail})` : ""} · 연속 ${health.degraded.streak}회`
              : `성공 없음${health.deferral ? ` · 마지막 미룸 ${health.deferral.reason}` : ""}` }
              : ranking && ranking.tone !== "clear" ? { level: ranking.tone, text: ranking.title } : null };
        })} />
      <ScrollToHash />
    </main>
  );
}

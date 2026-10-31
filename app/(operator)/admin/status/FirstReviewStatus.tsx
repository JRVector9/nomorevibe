import Link from "next/link";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { DISCOVERY_HARD_PRESSURE_COUNT, DISCOVERY_PRESSURE_AGE_MINUTES, DISCOVERY_PRESSURE_COUNT } from "@/lib/crawl/discovery-admission";
import { formatAgo, formatDetailTime } from "@/lib/format/time";
import { jobStatusLabel, type ObservedJob } from "@/lib/jobs/status";
import { FIRST_REVIEW_SAMPLE_LIMIT, type FirstReviewStatus } from "@/lib/operations/first-review-status";
import type { PipelineCompletions, QueueMetric } from "@/lib/operations/pipeline-completions";
import type { PipelineControlStatus } from "@/lib/operations/pipeline-control-status";
import { replicaHoldText, type ReplicaRead } from "@/lib/operations/replica-hold";
import { resolveModelSlots } from "@/lib/operations/stage-registry";
import type { ThroughputSnapshot } from "@/lib/operations/throughput-model";
import type { WorkerProgressReport } from "@/lib/operations/worker-progress-query";
import { JOB_LABELS } from "@/lib/operations/contracts";
import { ACTION_LINKS, jobHref } from "./action-links";
import { age, worker } from "./dashboard/StageRail";
import { ScrollTable } from "../components/ScrollTable";

type Job = ObservedJob & { name: string; lastSuccessAt?: Date | null; nextScheduledAt?: Date | null; cursor?: unknown };
export type FirstReviewStatusProps = {
  settings: CrawlSettings; throughput: ThroughputSnapshot | null; progress: WorkerProgressReport | null;
  jobs: Job[]; now: string; read: ReplicaRead<FirstReviewStatus>; completions: PipelineCompletions;
  control: Pick<PipelineControlStatus, "stages"> & Partial<Pick<PipelineControlStatus, "runtime" | "controls" | "observedAt">>;
};
const n = (value: number) => value.toLocaleString("ko-KR");
const DECISIONS = { approve: "승인", reject: "거절", needs_review: "사람 확인" };
const MODES: Record<string, string> = { legacy: "기존 워커", items: "항목 소비자", draining: "전환을 위해 비우는 중" };
const stale = (at: string, now: string) => !Number.isFinite(Date.parse(at)) || Date.parse(now) - Date.parse(at) > 90_000
  || Date.parse(at) - Date.parse(now) > 60_000;
const queueText = (row: QueueMetric | undefined) => row?.state === "value" && row.count !== null ? `${n(row.count)}건` : "미확인";

/** The primary homepage review and the independent second-review vote have different roles. */
export function FirstReviewPurpose() {
  return <p className="dash-note">저장된 홈페이지 본문·README·저장소 설명·수집 근거를 바탕으로, 게시 대상인 제품·개인 프로필에 해당하는지 처음 AI가 분류·검수합니다.
    승인·거절·사람 확인을 결정하며, 설치형 예외는 README·패키지 근거를 봅니다.
    AI 2차는 1차와 다른 모델로 결정을 다시 검토하는 별도 단계입니다. AI 사용 여부·제작 단계 판정은 개발 AI 근거 단계에서 처리합니다.</p>;
}

/** All queue/progress/control facts are already read for this page. Only the bounded recent sample is new. */
export function FirstReviewStatusCard({ settings, throughput, progress, jobs, now, read, completions, control }: FirstReviewStatusProps) {
  const stage = throughput?.stages.find(row => row.key === "first");
  const signal = progress?.stages.find(row => row.stage === "first");
  const state = stage ? worker(stage, signal, progress?.liveness) : null;
  const job = jobs.find(row => row.name === "crawl-agent-review");
  const seed = jobs.find(row => row.name === "crawl-seed");
  const cursor = seed?.cursor && typeof seed.cursor === "object" ? seed.cursor as Record<string, unknown> : null;
  const throttle = typeof cursor?.admissionThrottled === "boolean" ? cursor.admissionThrottled : null;
  const first = completions.stages.find(row => row.key === "ai1");
  const mode = control.stages.find(row => row.stage === "ai1");
  const modelSlots = resolveModelSlots(settings);
  const slots = modelSlots.filter(row => row.stage === "first");
  const second = modelSlots.filter(row => row.stage === "second");
  const modelControl = control.controls?.find(row => row.key === "model");
  const groups = control.runtime?.modelGroups;
  const relatedGroups = groups?.filter(group => group.waitingFirst > 0
    || group.firstModels.some(model => slots.some(slot => slot.provider === model.provider && slot.model === model.model)));
  // 2026-10-30: 확인 못함(indeterminate)은 점유가 아니다 — 포화는 유효 예약·보낸 호출만 센다(lib/llm/capacity-states.ts).
  const blocked = modelControl?.mode === "open" && modelControl.policy === "verified" && relatedGroups?.some(group =>
    group.waitingFirst > 0 && group.limit !== null && group.reserved + group.dispatched >= group.limit);
  const globalMetric = (label: string) => modelControl?.metrics.find(row => row.label === label)?.value ?? null;
  const capacityNumber = (value: number | null) => value === null ? "미확인" : n(value);
  const stats = read.ok ? read.value : null;
  const pressure = !stage || (throughput && stale(throughput.measuredAt, now)) ? null
    : stage.waiting >= DISCOVERY_HARD_PRESSURE_COUNT ? true : stage.waiting < DISCOVERY_PRESSURE_COUNT ? false
      : stage.oldestMinutes === null ? null : stage.oldestMinutes >= DISCOVERY_PRESSURE_AGE_MINUTES;
  return <section id="first-review-status" className="dash-card dash-12 scroll-mt-24" aria-labelledby="first-review-title">
    <div className="dash-card-h"><h2 id="first-review-title">AI 1차 검수 · 상세 상태</h2>
      <small>{blocked ? "공유 모델 슬롯 대기" : state?.text ?? "진행 미확인"}{throughput && stale(throughput.measuredAt, now) ? " · 오래된 관측" : ""}</small></div>
    <FirstReviewPurpose />
    <dl className="mt-3 grid gap-2 text-[13px] sm:grid-cols-2">
      <div><dt className="text-fg-3">AI 1차 설정</dt><dd>{slots.map(slot => <span key={slot.key} className="block break-words">
        {slot.label} · {slot.provider ?? "제공자 미설정"} / {slot.model ?? "모델 미설정"}
        {slot.source === "env" && " (웹 환경변수 기준 · 워커와 다를 수 있음)"}</span>)}</dd></div>
      <div><dt className="text-fg-3">AI 2차 설정 · {settings.secondReview.enabled ? "켜짐" : "꺼짐"}</dt><dd>{second.length
        ? second.map(slot => <span key={slot.key} className="block break-words">{slot.label} · {slot.provider} / {slot.model}</span>) : "설정된 모델 없음"}</dd></div>
    </dl>
    <dl className="mt-4 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
      <div><dt className="text-fg-3">실행 가능 대기</dt><dd className="font-mono text-lg">{stage ? `${n(stage.waiting)}건` : "미확인"}</dd></div>
      <div><dt className="text-fg-3">최장 대기 · 추정</dt><dd className="text-lg">{stage ? age(stage.oldestMinutes, stage.waiting) : "미확인"}</dd></div>
      <div><dt className="text-fg-3">재시도 유예</dt><dd className="font-mono text-lg">{queueText(first?.queue.find(row => row.key === "backoff"))}</dd></div>
      <div><dt className="text-fg-3">시도 소진 · 사람 확인</dt><dd className="font-mono text-lg">{queueText(first?.queue.find(row => row.key === "human"))}</dd></div>
    </dl>
    <p className="dash-note">대기 집계 {throughput ? formatAgo(throughput.measuredAt, now) : "미확인"} · 진행 중·재시도 유예를 제외한 실행 가능 후보입니다.
      최장은 후보·원본 갱신 이후의 추정입니다. 재시도·사람 확인 집계 {completions.observedAt ? formatAgo(completions.observedAt, now) : "미확인"}
      {completions.observedAt && stale(completions.observedAt, now) ? " · 오래된 집계" : ""}.</p>
    <p className="dash-note">처리 방식: {mode?.mode ? MODES[mode.mode] ?? mode.mode : "미확인"}
      {mode?.mode === "items" ? ` · 유효 항목 점유 ${mode.live === null ? "미확인" : `${n(mode.live)}건`} (외부 모델 호출 중이라는 뜻은 아님)`
        : mode?.mode === "legacy" ? ` · 작업 ${jobStatusLabel(job, Date.parse(now))}` : ""}
      {" "}· 모델 슬롯 대기 {queueText(first?.queue.find(row => row.key === "slotWaiting"))} · 예약·호출 점유 {queueText(first?.queue.find(row => row.key === "slotActive"))}.</p>
    <p className="dash-note">최근 작업 실행 {formatAgo(job?.lastRunAt, now, "기록 없음")} · 회차 성공 {formatAgo(job?.lastSuccessAt, now, "기록 없음")}
      {job?.notBefore && job.notBefore > new Date(now) && <> · 다음 작업 허용 {formatDetailTime(job.notBefore)}</>}.
      회차 성공과 후보 검수 완료는 각각의 기록입니다.</p>
    <div className="mt-4 rounded-[10px] border border-line p-3">
      <h3 className="text-[13px] font-semibold">공유 모델 용량 · 다른 단계의 점유 포함</h3>
      <p className="dash-note">전역 설정 상한 {capacityNumber(globalMetric("설정 상한"))} · 예약 {capacityNumber(globalMetric("예약"))}
        {" "}· 호출 미정산 {capacityNumber(globalMetric("dispatched"))} · 확인 못함(사람 검토 · 점유 아님) {capacityNumber(globalMetric("indeterminate"))}.
        조회 {control.observedAt ? formatAgo(control.observedAt, now) : "미확인"}{control.observedAt && stale(control.observedAt, now) ? " · 오래된 집계" : ""}.</p>
      {groups == null ? <p className="dash-note">공유 물리 그룹의 점유는 미확인입니다(조회 실패·상한 초과 등). AI 1차 오류가 없다는 이유로 정상으로 판정하지 않습니다.</p>
        : relatedGroups?.length ? <ul className="mt-2 grid gap-2 text-[13px]">{relatedGroups.map(group => <li key={group.group} className="break-words">
          <b>{group.group}</b> · 유효 예약·호출 {n(group.reserved + group.dispatched)} / 상한 {capacityNumber(group.limit)}
          {" "}· AI 1차 슬롯 대기 {n(group.waitingFirst)}건
          {group.indeterminate > 0 && <> · <Link href={ACTION_LINKS.unknownReview} prefetch={false}>확인 못함 {n(group.indeterminate)}건 · 사람 검토</Link> (슬롯 점유 아님)</>}
          {group.occupants.length > 0 && <ul className="mt-1 grid gap-1 pl-3 text-fg-2">{group.occupants.map(row => <li key={`${row.route}:${row.state}`}>
            {JOB_LABELS[row.route] ?? row.route} ({row.route}) · {row.state === "indeterminate" ? "확인 못함 · 사람 검토(점유 아님)" : row.state === "dispatched" ? "호출 미정산" : "예약"} {n(row.count)}건
          </li>)}</ul>}
        </li>)}</ul> : <p className="dash-note">현재 설정의 AI 1차 모델에 연결된 공유 그룹이 확인되지 않습니다. 모델 경로 계약을 확인해야 합니다.</p>}
      <p className="dash-note">같은 물리 그룹을 쓰는 번역·다른 검수의 유효 예약·보낸 호출(dispatched)도 AI 1차를 막을 수 있습니다. 보낸 호출은 정산 근거가 올 때까지 점유합니다.
        결과를 확인하지 못한 호출(indeterminate)은 슬롯을 점유하지 않고 아무 단계도 막지 않습니다 — <Link href={ACTION_LINKS.unknownReview} prefetch={false}>확인 못함 · 사람 검토 목록</Link>에서 봅니다.
        AI 1차 실행0·실패0만으로 용량이 비었다고 판단하지 않습니다.</p>
      <Link href={ACTION_LINKS.modelCapacity} prefetch={false} className="mt-2 inline-block text-[13px]">전체 모델 슬롯·전역 제어 장부 보기 →</Link>
    </div>
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="text-[13px] font-semibold">최근 5·15·60분 처리 · 종료 시각 기준</h3>
      {stats ? <>
        <p className="dash-note">복제본 조회 <time dateTime={stats.at}>{formatDetailTime(stats.at)}</time> · 최대 60초 캐시
          {stale(stats.at, now) ? " · 오래된 집계" : ""} · 최신 시도 최대 {n(FIRST_REVIEW_SAMPLE_LIMIT)}행 중 {n(stats.sampled)}행 표본.
          {stats.truncated ? " 조회 상한에 닿았습니다. 창 밖에서 시작한 시도·누락 행이 있을 수 있어 전체 수량·전체 성공률이 아닙니다." : " 전체 시도 이력 안에서 집계했습니다."}</p>
        <ScrollTable label="AI 1차 최근 처리와 기술 성공률"><table className="mt-2 w-full min-w-[620px] text-left text-[13px]">
          <thead className="text-fg-3"><tr><th className="py-1 font-medium">기간</th><th className="font-medium">완료 시도 / 고유 후보</th>
            <th className="font-medium">기술 실패</th><th className="font-medium">기술 성공률 · 표본</th><th className="font-medium">승인 / 거절 / 사람 확인</th></tr></thead>
          <tbody>{stats.windows.map(window => {
            const denominator = window.succeeded + window.failed;
            return <tr key={window.minutes} className="border-t border-line"><th className="py-2 font-medium">{window.minutes}분</th>
              <td className="font-mono">{n(window.succeeded)}회 / {n(window.unique)}건</td><td className="font-mono">{n(window.failed)}회</td>
              <td className="font-mono">{denominator ? `${(window.succeeded / denominator * 100).toFixed(1)}% (${n(window.succeeded)}/${n(denominator)})` : "해당 없음 · 종료 시도 0회"}</td>
              <td className="font-mono">{n(window.approve)} / {n(window.reject)} / {n(window.handoff)}</td></tr>;
          })}</tbody></table></ScrollTable>
        <p className="dash-note">분모는 표본 안 모델 완료 시도 + 기술 실패 시도입니다. 승인·거절·사람 확인 모두 기술 성공이며 승인률과 다릅니다.
          취소·연기, 규칙 종료, 결과 재사용, 대체·실행 중 기록은 분모에서 제외합니다. 현재 설정과 다른 과거 모델도 포함합니다.</p>
        <h3 className="mt-3 text-[13px] font-semibold">최근 종료 기록 · 60분 표본 안 최대 5건</h3>
        {stats.recent.length ? <ul className="mt-2 grid gap-1 text-[13px]">{stats.recent.map(row => <li key={row.id} className="break-words">
          <span className={row.state === "failed" ? "text-down" : "text-fg-2"}>{row.state === "failed" ? "기술 실패" : row.decision ? DECISIONS[row.decision] : "결정 미확인"}</span>
          {" "}· 후보 #{row.candidateId} · {row.provider ?? "제공자 미기록"} / {row.model ?? "모델 미기록"} · {formatAgo(row.completedAt, now)}
        </li>)}</ul> : <p className="dash-note">이 표본의 최근 60분 안에 종료된 모델 시도가 없습니다.</p>}
      </> : <p className="dash-note">처리 집계 미확인 — {!read.ok ? replicaHoldText(read.reason) : "읽지 못했습니다"}. 0건을 뜻하지 않습니다. 주 DB로 넘기지 않습니다.</p>}
    </div>
    <div className="mt-4 border-t border-line pt-3 text-[13px]">
      <h3 className="font-semibold">수집 속도와의 연결</h3>
      <p className="dash-note">{pressure === null ? "AI 1차의 수집 압력 여부는 미확인입니다." : pressure
        ? "파이프라인 대기 지표로 보면 AI 1차가 수집 압력 기준에 해당합니다(참고)." : "파이프라인 대기 지표는 새 수집 압력 진입 기준 미만입니다(참고)."}
        {" "}기준: 대기 {n(DISCOVERY_PRESSURE_COUNT)}건 이상·최장 {DISCOVERY_PRESSURE_AGE_MINUTES}분 이상, 또는 {n(DISCOVERY_HARD_PRESSURE_COUNT)}건 이상.
        수집기의 재시도 시각·작업 허용 여부를 반영한 판정과 다를 수 있습니다. 다른 단계 적체·조회 실패도 수집을 줄일 수 있으며, 해제에는 별도 완화 기준을 사용합니다.</p>
      <p className="dash-note">마지막 저장된 수집 커서: {throttle === null ? "압력 완화 여부 미확인" : throttle ? `압력 완화 켜짐 · 해당 판단 시 페이지 예산 1 (설정 ${settings.discover.pagesPerTick})` : "압력 완화 꺼짐"}
        {" "}· 수집 작업 마지막 실행 {formatAgo(seed?.lastRunAt, now, "기록 없음")}.
        수집기는 매 회차 다시 판단하므로 현재 페이지 실행량·원인 확정값과는 다릅니다.</p>
    </div>
    <div className="mt-3 flex flex-wrap gap-4 text-[13px]"><Link href={jobHref("crawl-agent-review")} prefetch={false}>AI 1차 작업 자세히 →</Link>
      <Link href={jobHref("crawl-seed")} prefetch={false}>수집 작업 자세히 →</Link></div>
  </section>;
}

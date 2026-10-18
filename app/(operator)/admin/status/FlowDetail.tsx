import Link from "next/link";
import type { HumanQueueOverview } from "@/lib/crawl/human-queue";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { formatAgo } from "@/lib/format/time";
import { jobStatusLabel, type ObservedJob } from "@/lib/jobs/status";
import { JOB_LABELS } from "@/lib/operations/contracts";
import type { HourlySeries, ModelHealth } from "@/lib/operations/dashboard";
import { readDeferrals, readModelSlotWeek, readModelSlotWindows, type DeferralsRead, type EvidenceVerdicts, type SlotWindows,
  type SourceSplit } from "@/lib/operations/flow-reads";
import type { PipelineFlow } from "@/lib/operations/pipeline";
import type { PipelineCompletions } from "@/lib/operations/pipeline-completions";
import type { PipelineControlStatus } from "@/lib/operations/pipeline-control-status";
import { replicaHoldText, type ReplicaRead } from "@/lib/operations/replica-hold";
import { PIPELINE_STAGES, resolveModelSlots } from "@/lib/operations/stage-registry";
import type { ThroughputSnapshot } from "@/lib/operations/throughput-model";
import type { WorkerProgressReport } from "@/lib/operations/worker-progress-query";
import { readXStatus, type XStatusView } from "@/lib/operations/x-status";
import { ScrollTable } from "../components/ScrollTable";
import { ACTION_LINKS } from "./action-links";
import { DOT_TONE } from "./dashboard/FlowCells";
import { modelName } from "./dashboard/ModelCards";
import { Sparkline } from "./dashboard/Sparkline";
import { FlowNodes, type FlowLane } from "./FlowNodes";
import { dbClock, defaultNode, deferralLabel, deferralText, enrichmentFlowNodes, enrichmentNodes, ledgerRows, reviewNodes, slotRows,
  sourceNodes, sourceSummary, xSummary, type EnrichmentNode, type FlowNode, type SlotRow } from "./flow-model";
import { CompletionsStage } from "./PipelineCompletions";
import { completionsOnce, controlStatusOnce, flowOnce, hourlyOnce } from "./render-reads";
import { evidenceFor, sourceSplitOnce, type FlowSlotProps } from "./flow-slots";

/**
 * 흐름 상세 탭(운영센터 개편 v8 PR6) — 소스 → 심사 흐름 → 발행 → 보강을 한 장에.
 *
 * 노드를 누르면 아래에 그 노드의 상세가 열린다: 처리 지표 카드의 그 단계 칸 그대로(CompletionsStage), 그 단계의 모델 자리, 미룬 이유, 잡 상태.
 * 지금 숫자(레일·장부·처리 지표·시간별)는 같은 렌더의 cache() 결과를 나눠 쓰고, 새 숫자(나눔·근거 판정·모델 자리 24h/7일·미룬 이유)는
 * 복제본 전용이라 DB 기준 시각을 달고 못 읽으면 보류다. 쉬운 말은 코드 이름을 괄호로 함께 적는다.
 */
export type FlowDetailData = {
  now: string; settings: CrawlSettings; models: ModelHealth[] | null; held: number;
  quota: { sources: { quota: unknown; stale: boolean }[] } | null;
  throughput: ThroughputSnapshot | null; workerProgress: WorkerProgressReport | null; human: HumanQueueOverview;
  jobs: (Partial<ObservedJob> & { name: string; lastError?: string | null; notBefore: Date | null; lastRunAt?: Date | null; nextScheduledAt?: Date | null })[];
  flow: PipelineFlow; hourly: HourlySeries | null; completions: PipelineCompletions; control: PipelineControlStatus;
  split: ReplicaRead<SourceSplit>; x: XStatusView; evidence: ReplicaRead<EvidenceVerdicts>; enrichment: EnrichmentNode[];
  slots: SlotRow[]; day: ReplicaRead<SlotWindows>; week: ReplicaRead<SlotWindows>; deferrals: ReplicaRead<DeferralsRead>;
};

const stamp = (read: ReplicaRead<{ at: string }>) => read.ok ? `기준 ${dbClock(read.value.at)} (DB)` : `보류 — ${replicaHoldText(read.reason)}`;

function Lane({ title, note }: { title: string; note: string }) {
  return <h2 className="ops-flow-lane-h">{title} <span>{note}</span></h2>;
}

/** 노드 카드 — 이름·상태, 큰 수, 24시간 선(맨 오른쪽이 이번 시), 한 줄 설명, 모델 */
function NodeCard({ node }: { node: FlowNode }) {
  return <>
    <span className="hd"><span className="nm">{node.label}</span><span className="dash-pill" data-tone={DOT_TONE[node.tone]}>{node.state}</span></span>
    {node.big !== null && <span className="big">{node.big}{node.unit && <small>{node.unit}</small>}</span>}
    {node.bars && <Sparkline values={node.bars} />}
    <span className="io" title={node.io}>{node.io}</span>
    {node.models && node.models.length > 0 && <span className="ms">{node.models.map((model, index) =>
      <span key={index} className="m" title={model.title}><b>{model.name}</b>{model.chip.text && <span className="dash-pill" data-tone={model.chip.tone}>{model.chip.text}</span>}</span>)}</span>}
  </>;
}

function SlotTable({ rows, label }: { rows: SlotRow[]; label: string }) {
  return <ScrollTable label={label}>
    <table className="dash-table ops-flow-slots">
      <thead><tr><th>단계 · 자리</th><th>모델</th><th>최근 1시간</th><th className="num">24h</th><th className="num">7일</th><th className="num">일치</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}>
        <td>{row.title}{row.approximated && <span className="ops-flow-ref">참고 · 결과 행 기준</span>}</td>
        <td className="ops-flow-model" title={`${row.model ?? "설정 없음"} · ${row.source}${row.observed && row.observed !== row.model ? ` · 관측 ${row.observed}` : ""}`}>
          {row.model ? modelName(row.model) : "설정 없음"}</td>
        <td><span className="dash-pill" data-tone={row.chip.tone}>{row.chip.text}</span></td>
        <td className="num ops-flow-grey">{row.day}</td><td className="num ops-flow-grey">{row.week}</td><td className="num">{row.agree ?? ""}</td>
      </tr>)}</tbody>
    </table>
  </ScrollTable>;
}

function JobLines({ jobs, names, now }: { jobs: FlowDetailData["jobs"]; names: readonly string[]; now: string }) {
  if (!names.length) return null;
  return <ul className="ops-flow-jobs">{names.map((name) => {
    const state = jobs.find((job) => job.name === name);
    return <li key={name}><b>{JOB_LABELS[name] ?? name}</b> <span className="ops-flow-code">({name})</span> · {jobStatusLabel(state as ObservedJob | undefined, Date.parse(now))}
      {" "}· 마지막 실행 {formatAgo(state?.lastRunAt, now, "기록 없음")}{state?.nextScheduledAt ? ` · 다음 예약 ${formatAgo(state.nextScheduledAt, now)}` : ""}
      {state?.lastError && <span className="ops-flow-error" title={state.lastError}> · 오류 {state.lastError.slice(0, 120)}</span>}</li>;
  })}</ul>;
}

function NodeDetail({ node, data }: { node: FlowNode; data: FlowDetailData }) {
  const def = PIPELINE_STAGES.find((row) => row.key === node.key);
  const others = data.enrichment.filter((row) => !row.headline);
  const names = node.key === "others" ? others.flatMap((row) => PIPELINE_STAGES.find((stage) => stage.key === row.key)?.jobs ?? []) : def?.jobs ?? [];
  const completion = def?.completionKey ? data.completions.stages.find((stage) => stage.key === def.completionKey) : undefined;
  const slots = data.slots.filter((slot) => slot.stage === node.key);
  const deferred = data.deferrals.ok ? deferralText(data.deferrals.value.jobs, names) : null;
  const report = data.x.report;
  return <div className="ops-flow-detail-in" aria-label={`${node.label} 상세`}>
    <h2 className="ops-flow-lane-h">{node.label} <span>({node.code}) · {node.state}{node.big !== null ? ` · ${node.big}${node.unit ? ` ${node.unit}` : ""}` : ""}</span></h2>
    <div className="ops-flow-detail-grid">
      {completion && <div><h3>처리 지표 <span>지금 처리 지표 카드의 이 단계 칸 그대로 · {data.completions.observedAt ? `DB 조회 ${dbClock(data.completions.observedAt)}` : "조회 시각 미확인"}</span></h3>
        <CompletionsStage stage={completion} /></div>}
      <div>
        <h3>이 단계의 모델과 대기 이유</h3>
        {slots.length > 0 && <SlotTable rows={slots} label={`${node.label} 모델 자리`} />}
        <p className="ops-flow-line">미룬 이유(최근 1시간): {data.deferrals.ok ? deferred ?? "기록 없음" : "보류"} · {stamp(data.deferrals)}</p>
        <p className="ops-flow-line">{node.io}</p>
        <JobLines jobs={data.jobs} names={names} now={data.now} />
        {node.key === "human" && <p className="ops-flow-line">사람이 하는 단계라 잡이 없습니다. <Link href={ACTION_LINKS.reviewHuman}>심사 큐에서 처리 →</Link></p>}
        {node.key === "x" && <p className="ops-flow-line">X 수집기(osaka-smoke) 하루 보고 · {xSummary(data.x).note}
          {report && <> · 오늘 읽기 {report.reads.used}/{report.reads.limit} · 후보 {report.candidates} · 마지막 성공 {formatAgo(report.lastSuccessAt, data.now, "없음")}</>}</p>}
        {node.key === "others" && <ul className="ops-flow-jobs">{others.map((row) => <li key={row.key}>
          <span className="dash-dot" data-tone={DOT_TONE[row.tone]} aria-hidden /> <b>{row.label}</b> <span className="ops-flow-code">({row.code})</span> · {row.state}
          {row.value !== null ? ` · ${row.value}` : ""} · {row.note}</li>)}</ul>}
      </div>
    </div>
  </div>;
}

export function FlowDetailView(data: FlowDetailData) {
  const summary = sourceSummary(data.split, data.settings);
  const sources = sourceNodes({ settings: data.settings, split: data.split, x: data.x, quota: data.quota, jobs: data.jobs, now: data.now });
  const review = reviewNodes({ throughput: data.throughput, workerProgress: data.workerProgress, human: data.human, flow: data.flow,
    hourly: data.hourly, held: data.held, slots: data.slots });
  const enrichment = enrichmentFlowNodes(data.enrichment, data.slots);
  const all = [...sources, ...review, ...enrichment];
  const card = (node: FlowNode) => ({ key: node.key, tone: DOT_TONE[node.tone], card: <NodeCard node={node} /> });
  const lanes: FlowLane[] = [
    { key: "sources", label: "들어오는 곳", className: "ops-flow-grid ops-flow-sources", nodes: sources.map(card),
      heading: <Lane title="들어오는 곳" note={summary.counts ? `${summary.value} · 이번 시 · 기준 ${dbClock(summary.at!)} (DB)` : `보류 — ${summary.note}`} /> },
    { key: "review", label: "심사 흐름", className: "ops-flow-grid ops-flow-chain", nodes: review.map(card),
      heading: <Lane title="심사 흐름" note="대기·최장·5분은 레일과 같은 값(같은 렌더에서 한 번 읽음) · 선은 24시간, 맨 오른쪽이 이번 시" /> },
    { key: "enrichment", label: "발행 후 보강", className: "ops-flow-grid ops-flow-enrich", nodes: enrichment.map(card),
      heading: <Lane title="발행 후 보강 · 12단계" note={`근거 판정 ${stamp(data.evidence)} · 새 숫자에만 기준 시각을 단다`} /> },
  ];
  const details = Object.fromEntries(all.map((node) => [node.key, <NodeDetail key={node.key} node={node} data={data} />]));
  const deferrals = data.deferrals.ok ? data.deferrals.value.jobs.filter((row) => row.lastHour > 0) : [];
  return <>
    <FlowNodes lanes={lanes} details={details} initial={defaultNode(all)} />
    <div className="ops-flow-two">
      <section className="dash-card" aria-labelledby="flow-ledger">
        <h2 id="flow-ledger" className="ops-flow-lane-h">장부 쉬운 말 요약 <span>전체 현황 장부와 같은 값 · 코드 이름 함께 · {data.control.observedAt ? `DB 조회 ${dbClock(data.control.observedAt)}` : "조회 시각 미확인"}</span></h2>
        <ScrollTable label="장부 쉬운 말 요약"><table className="dash-table ops-flow-ledger">
          <thead><tr><th>장부</th><th>상태</th><th>숫자</th></tr></thead>
          <tbody>{ledgerRows(data.control).map((row) => <tr key={row.name}><td>{row.name}</td><td>{row.state}</td><td>{row.numbers}</td></tr>)}</tbody>
        </table></ScrollTable>
      </section>
      <section className="dash-card" aria-labelledby="flow-slots">
        <h2 id="flow-slots" className="ops-flow-lane-h">모델 자리 전체 <span>모델 카드와 같은 판정 · 근사 자리는 중립 색 · 24h·7일은 회색 참고(24h {stamp(data.day)} · 7일 {stamp(data.week)})</span></h2>
        <SlotTable rows={data.slots} label="모델 자리 전체" />
      </section>
    </div>
    <section className="dash-card" aria-labelledby="flow-deferrals">
      <h2 id="flow-deferrals" className="ops-flow-lane-h">미룬 이유 · 최근 1시간 <span>잡이 왜 미뤘는지(defer:&lt;job&gt;) · {stamp(data.deferrals)}</span></h2>
      {!data.deferrals.ok ? <p className="ops-flow-line">보류 — {replicaHoldText(data.deferrals.reason)}</p>
        : deferrals.length === 0 ? <p className="ops-flow-line">최근 1시간 동안 미룬 잡이 없습니다.</p>
        : <ul className="ops-flow-jobs">{deferrals.map((row) => <li key={row.job}><b>{JOB_LABELS[row.job] ?? row.job}</b> <span className="ops-flow-code">({row.job})</span>
          {" "}· 마지막 {deferralLabel(row.reason)} {formatAgo(row.lastDeferredAt, data.now)} · {deferralText([row], [row.job])}</li>)}</ul>}
    </section>
  </>;
}

const EMPTY_FLOW: PipelineFlow = { stages: [], bottleneck: null, published: 0 };

/** 흐름 상세 탭의 조각 — 지금 숫자는 같은 렌더의 cache() 결과, 새 숫자는 복제본 전용 캐시 */
export async function FlowDetailSlot({ inputs, derived, actions, fresh }: FlowSlotProps) {
  const slots = resolveModelSlots(inputs.settings);
  const [flow, completions, control, hourly, split, evidence, day, week, deferrals] = await Promise.all([
    flowOnce().catch(() => EMPTY_FLOW), completionsOnce(), controlStatusOnce(), hourlyOnce().catch(() => null), sourceSplitOnce(),
    evidenceFor(inputs, fresh), readModelSlotWindows(slots), readModelSlotWeek(slots), readDeferrals(fresh)]);
  const now = inputs.ops.fetchedAt;
  return <FlowDetailView now={now} settings={inputs.settings} models={inputs.models} held={inputs.ops.held} quota={derived.quota}
    throughput={inputs.throughput} workerProgress={derived.workerProgress} human={inputs.overview} jobs={inputs.jobStates}
    flow={flow} hourly={hourly} completions={completions} control={control} split={split} x={readXStatus(inputs.ops.observations, now)}
    evidence={evidence} enrichment={enrichmentNodes({ actions, jobs: inputs.jobStates, evidence, health: derived.health, attention: inputs.attention, now })}
    slots={slotRows({ settings: inputs.settings, slots, models: inputs.models, day, week })} day={day} week={week} deferrals={deferrals} />;
}

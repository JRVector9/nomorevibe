import Link from "next/link";
import type { ThroughputSnapshot, ThroughputStage } from "@/lib/operations/throughput-model";
import type { PipelineFlow } from "@/lib/operations/pipeline";
import type { StageProgress, classifyLiveness } from "@/lib/operations/worker-progress";
import { FLOW_NOTE, humanFlowLabel, humanWaitLabel, WAIT_REFERENCE, type HumanQueueOverview } from "@/lib/crawl/human-queue";
import { JOB_LABELS } from "@/lib/operations/contracts";
import { ACTION_LINKS } from "../action-links";

type Liveness = ReturnType<typeof classifyLiveness>;
const n = (value: number) => value.toLocaleString("ko-KR");
// 워커 진행 판정(worker-progress)을 한 칸에 들어가게 짧게
const PROGRESS: Record<StageProgress["reason"], string> = {
  paused: "설정상 중지", no_work: "일감 없음", progressing: "진행 중", backoff: "재시도 대기",
  upstream_or_job_error: "오류 확인", unknown_age: "시각 미확인", warming_up: "판별 대기",
  worker_missing: "워커 끊김", no_progress: "진행 없음", manual_attention: "사람 확인",
};
const roleOf = (key: string) => key === "fetch" ? "crawler" : key === "publish" ? "publisher" : "reviewer";

/** 단계 아래 줄 — 워커가 살아 있고 지금 무엇을 하는지. 옛 처리량 띠의 runtimeState 와 같은 판단. */
function worker(stage: ThroughputStage, signal: StageProgress | undefined, liveness: Liveness[] | undefined): { text: string; alarm: boolean } {
  const live = liveness?.find((row) => row.role === roleOf(stage.key));
  if (live?.reason === "worker_missing") return { text: "워커 관측 끊김", alarm: true };
  if (live?.reason === "restart_loop") return { text: "워커 반복 재시작", alarm: true };
  if (stage.key === "fetch" && stage.waiting === 0 && stage.deferred) return { text: `재시도 예약 ${n(stage.deferred)}건`, alarm: false };
  if (signal) return { text: PROGRESS[signal.reason], alarm: signal.alarm };
  return { text: live ? "워커 정상" : "워커 미관측", alarm: false };
}

function age(minutes: number | null, waiting: number): string {
  if (minutes === null) return waiting === 0 ? "대기 없음" : "시각 미확인";
  if (minutes < 1) return "1분 미만";
  if (minutes < 60) return `${Math.floor(minutes)}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}시간`;
  return `${Math.floor(hours / 24)}일`;
}

/**
 * 파이프라인 — 지금 어디에 쌓여 있나.
 *
 * 단계마다 대기 수·가장 오래 기다린 것·최근 5분 처리를 한 칸에 둔다. 사람 확인 칸은 자동 단계가
 * 아니라서 처리 속도 대신 큐의 나이를 적는다. 맨 아래 줄은 워커 진행 판정이라 "쌓였는데 아무도 안 움직인다"가
 * 바로 보인다. 병목은 24시간 흐름(들어옴·나감)으로 짚는다.
 * 사람 확인 칸의 수와 문구는 심사 큐 구간과 같은 humanQueueOverview·human-queue.ts 함수로 그린다 — 전에는 보류 전체를
 * 세어 "1,355 · 최장 39일"이라 했고 심사 큐는 "직접 판단 1,075 · 최장 7일"이라 했다.
 */
export function StageRail({ snapshot, flow, human, signals, liveness }: {
  snapshot: ThroughputSnapshot | null; flow: PipelineFlow; human: HumanQueueOverview;
  signals?: StageProgress[]; liveness?: Liveness[];
}) {
  const humanQueue = human.stages.human;
  const stages = snapshot?.stages ?? [];
  // 24시간 유입·유출(흐름 집계)은 같은 키의 단계에만 있다 — 칸을 늘리지 않고 툴팁으로
  const flowNote = (key: string) => {
    const row = flow.stages.find((stage) => stage.key === key);
    return row && row.entered !== null && row.left !== null ? `24시간 들어옴 ${n(row.entered)} · 나감 ${n(row.left)}` : undefined;
  };
  const tone = (status: string, manual: number, alarm: boolean) => status === "stalled" || alarm ? "bad" : status === "backlog" || manual > 0 ? "warn" : undefined;
  const bottleneck = flow.stages.find((stage) => stage.key === flow.bottleneck);
  return (
    <section className="dash-card dash-8" aria-label="파이프라인">
      <div className="dash-card-h"><h2>파이프라인 · 지금 어디에 쌓여 있나</h2><small>대기 수 · 가장 오래 기다린 것 · 최근 5분 처리</small></div>
      <ol className="dash-rail">
        {stages.map((stage) => {
          const state = worker(stage, signals?.find((row) => row.stage === stage.key), liveness);
          return (
            <li key={stage.key} data-tone={tone(stage.status, stage.manualAttention ?? 0, state.alarm)} title={flowNote(stage.key)}>
              <span className="t">{stage.label}</span>
              <span className="n">{n(stage.waiting)}</span>
              <span className="s">{stage.waiting > 0 ? `최장 ${age(stage.oldestMinutes, stage.waiting)}`
                : (stage.manualAttention ?? 0) > 0 ? <Link href={ACTION_LINKS.reviewHuman}>직접 확인 {n(stage.manualAttention ?? 0)}건</Link>
                : stage.enabled ? "대기 없음" : "일시 중지"}</span>
              <span className="s">5분 {n(stage.completed5m)}{stage.unit}{stage.errors5m ? ` · 오류 ${n(stage.errors5m)}` : ""}</span>
              <span className="s w" data-tone={state.alarm ? "bad" : undefined}><span className="dash-dot" data-tone={state.alarm ? "bad" : "ok"} aria-hidden /> {state.text}</span>
            </li>
          );
        })}
        <li data-tone={humanQueue > 500 ? "warn" : undefined} title={`사람 확인 · 직접 판단 — 대기는 ${WAIT_REFERENCE} · ${FLOW_NOTE}`}>
          <span className="t">사람 확인 · 직접 판단</span>
          <span className="n">{n(humanQueue)}</span>
          <span className="s">{humanWaitLabel(human)}</span>
          <span className="s">확정만 하면 됨 {n(human.stages.agreed)}</span>
          <span className="s w"><span className="dash-dot" aria-hidden /> {humanFlowLabel(human)}</span>
        </li>
      </ol>
      <p className="dash-line">
        <span className="dash-dot" data-tone={bottleneck ? "warn" : "ok"} aria-hidden />
        <span>
          {bottleneck?.key === "review"
            // 사람 심사 단계는 보류 전체가 아니라 사람 몫(직접 판단·확정만)으로 말한다 — 심사 큐와 같은 수
            ? <><b>병목은 {bottleneck.label}.</b> 직접 판단 {n(humanQueue)}건 · 확정만 하면 됨 {n(human.stages.agreed)}건이 쌓였는데 24시간 동안 사람이 처리한 것이 없습니다. <Link href={ACTION_LINKS.reviewHuman}>심사 큐에서 처리 →</Link></>
            : bottleneck
            ? <><b>병목은 {bottleneck.label}.</b> {n(bottleneck.waiting)}건이 쌓였는데 24시간 동안 빠진 것이 없습니다{bottleneck.job ? <> · <span title={bottleneck.job}>{JOB_LABELS[bottleneck.job] ?? bottleneck.job}</span> 확인</> : " · 사람이 처리하는 단계"}.</>
            : humanQueue > 500
              ? <><b>자동 단계는 흐르고 있습니다.</b> 직접 판단 {n(humanQueue)}건이 가장 큰 적체입니다. <Link href={ACTION_LINKS.reviewHuman}>심사 큐에서 처리 →</Link></>
              : <>24시간 흐름 기준으로 막힌 단계가 없습니다.</>}
        </span>
      </p>
    </section>
  );
}

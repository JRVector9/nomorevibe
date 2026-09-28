import type { ThroughputSnapshot, ThroughputStage, ThroughputStatus } from "@/lib/operations/throughput-model";
import type { ProgressReason, SchedulerProgress, StageProgress, classifyLiveness } from "@/lib/operations/worker-progress";
import { LiveRefresh } from "./LiveRefresh";
import styles from "./throughput.module.css";

const STATUS_LABEL: Record<ThroughputStatus, string> = {
  paused: "일시 중지",
  stalled: "정체 의심",
  backlog: "대기 많음",
  processing: "처리 기록 있음",
  idle: "처리 대기",
};
const REASON_LABEL: Record<ProgressReason, string> = {
  paused: "설정상 중지", no_work: "실행 가능 일감 없음", progressing: "최근 저장 진행 있음",
  backoff: "재시도 시각 대기", upstream_or_job_error: "최근 오류 기록 확인 필요",
  unknown_age: "대기 시각 확인 필요", warming_up: "판별 대기 중",
  worker_missing: "워커 관측 끊김", no_progress: "저장 진행 없음",
};

const count = (value: number) => value.toLocaleString("ko-KR");

function runtimeState(stage: ThroughputStage, signal: StageProgress | undefined,
  liveness: ReturnType<typeof classifyLiveness>[] | undefined): { text: string; alert: boolean } {
  if (!stage.enabled) return { text: "자동 처리 일시 중지", alert: false };
  const role = stage.key === "fetch" ? "crawler" : stage.key === "publish" ? "publisher" : "reviewer";
  const worker = liveness?.find(row => row.role === role);
  const roleName = role === "crawler" ? "수집" : role === "publisher" ? "발행" : "심사";
  if (worker?.reason === "worker_missing") return { text: `${roleName} 워커 관측 끊김 · 확인 필요`, alert: true };
  if (worker?.reason === "restart_loop") return { text: `${roleName} 워커 반복 재시작 · 확인 필요`, alert: true };
  const prefix = worker?.reason === "present" ? "워커 정상" : "워커 상태 미확인";
  if (stage.key === "fetch" && stage.waiting === 0 && stage.deferred) {
    return { text: `${prefix} · 재시도 예약 ${count(stage.deferred)}건`, alert: false };
  }
  if (signal) return { text: `${prefix} · ${REASON_LABEL[signal.reason]}`, alert: signal.alarm };
  return { text: `${prefix} · 단계 판별 자료 없음`, alert: false };
}

function waitingTime(minutes: number | null, waiting: number): string {
  if (minutes === null) return waiting === 0 ? "대기 없음" : "시각 미확인";
  if (minutes < 1) return "1분 미만";
  if (minutes < 60) return `${Math.floor(minutes)}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 ${Math.floor(minutes % 60)}분`;
  return `${Math.floor(hours / 24)}일 ${hours % 24}시간`;
}

export function ThroughputStrip({ snapshot, signals, scheduler, liveness }: {
  snapshot: ThroughputSnapshot | null; signals?: StageProgress[]; scheduler?: SchedulerProgress;
  liveness?: ReturnType<typeof classifyLiveness>[];
}) {
  if (!snapshot) return <section className={styles.strip} aria-labelledby="throughput-title">
    <div className={styles.heading}><h2 id="throughput-title">단계별 처리 속도</h2><LiveRefresh /></div>
    <p role="status">처리 속도를 불러오지 못했습니다. 다음 갱신에서 다시 확인합니다.</p>
  </section>;
  const attention = snapshot.stages.filter((stage) => stage.status === "stalled" || stage.status === "backlog");
  const measuredTime = new Date(snapshot.measuredAt).toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });

  return (
    <section className={styles.strip} aria-labelledby="throughput-title">
      <div className={styles.heading}>
        <div>
          <h2 id="throughput-title">단계별 처리 속도</h2>
          <p className={styles.description}>최근 1분 완료량 · <time dateTime={snapshot.measuredAt}>{measuredTime}</time> KST 기준</p>
        </div>
        <div className={styles.refresh}><LiveRefresh /><span>10초 간격</span></div>
      </div>

      {attention.length > 0 && (
        <p className={styles.attention}>
          <strong>확인할 단계</strong>
          {attention.map((stage) => <span key={stage.key}>{stage.label} · {STATUS_LABEL[stage.status]}</span>)}
        </p>
      )}
      {signals?.some(signal => signal.alarm) && <p className={styles.attention}>
        <strong>확인할 워커</strong>
        {signals.filter(signal => signal.alarm).map(signal => <span key={signal.stage}>
          {signal.role === "crawler" ? "수집" : "심사"} · {REASON_LABEL[signal.reason]}
        </span>)}
      </p>}
      {scheduler?.reason === "scheduler_missed" && <p className={styles.attention}>
        <strong>스케줄러 예약 지연</strong><span>{scheduler.overdueJobs.join(", ")}</span>
      </p>}
      {scheduler?.reason === "unknown_schedule" && <p className={styles.attention}>
        <strong>스케줄러 예약 상태 미확인</strong>
      </p>}
      {liveness?.some(row => row.alarm) && <p className={styles.attention}>
        <strong>워커 생존 확인</strong>
        {liveness.filter(row => row.alarm).map(row => <span key={row.role}>
          {row.role === "crawler" ? "수집" : row.role === "reviewer" ? "심사" : "스케줄러"} 워커 {row.reason === "restart_loop" ? "5분 내 반복 재시작" : "관측 끊김"}
        </span>)}
      </p>}

      <ol className={styles.stages}>
        {snapshot.stages.map((stage, index) => {
          const state = runtimeState(stage, signals?.find(signal => signal.stage === stage.key), liveness);
          return (
          <li key={stage.key} className={styles.stage} data-status={stage.status} aria-labelledby={`throughput-${stage.key}`}>
            <div className={styles.stageHeading}>
              <h3 id={`throughput-${stage.key}`}><span className={styles.step} aria-hidden="true">{index + 1}</span>{stage.label}</h3>
              <span className={styles.status}>{stage.status === "idle" && stage.waiting === 0 ? "대기 없음" : STATUS_LABEL[stage.status]}</span>
            </div>
            <div className={styles.rate}>
              <div className={styles.current}><strong>{count(stage.completed1m)}</strong><span>{stage.unit}/1분</span></div>
              <p className={styles.average}>5분 평균 <b>{(stage.completed5m / 5).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}</b> {stage.unit}/분</p>
            </div>
            <p className={styles.runtimeState} data-alert={state.alert ? "true" : undefined}>{state.text}</p>
            <dl className={styles.stats}>
              <div><dt>대기</dt><dd>{count(stage.waiting)}<span>{stage.unit}</span></dd></div>
              <div><dt>{stage.ageLabel ?? "가장 오래된 대기"}</dt><dd>{waitingTime(stage.oldestMinutes, stage.waiting)}</dd></div>
              {stage.errors5m !== null && <div><dt>5분 내 오류 기록</dt><dd data-error={stage.errors5m > 0 ? "true" : undefined}>{count(stage.errors5m)}<span>{stage.unit}</span></dd></div>}
            </dl>
            {stage.queueNote && <p className={styles.queueNote}>{stage.queueNote}</p>}
          </li>
        ); })}
      </ol>

      <details className={styles.details}>
        <summary>집계 범위와 상태 기준</summary>
        <div className={styles.explanation}>
          <p>예약 작업은 한 번에 처리하므로 최근 1분이 0이어도 잠시 쉬는 중일 수 있습니다. 5분 평균과 대기 시간을 함께 확인하세요.</p>
          <dl className={styles.statusGuide}>
            <div><dt>정체 의심</dt><dd>대기 항목의 경과 시간이 5분 이상이고, 최근 5분 처리 기록이 없습니다. AI 1차는 규칙 처리와 결과 재사용도 진행으로 봅니다. 실행 가능 시각을 정확히 기록하지 않는 단계는 경과 시간을 추정하므로 작업 상태도 함께 확인하세요.</dd></div>
            <div><dt>대기 많음</dt><dd>대기 항목의 경과 시간이 5분 이상이고, 대기량이 최근 5분 처리 속도로 30분 동안 처리할 양보다 많습니다.</dd></div>
            <div><dt>일시 중지</dt><dd>해당 단계의 자동 처리가 설정에서 꺼져 있습니다.</dd></div>
            <div><dt>처리 기록 있음</dt><dd>최근 5분에 완료된 작업이 있습니다. 현재 실행 중이라는 뜻은 아닙니다.</dd></div>
          </dl>
          <dl className={styles.stageGuide}>
            {snapshot.stages.map((stage) => <div key={stage.key}>
              <dt>{stage.label}</dt>
              <dd>{stage.detail}</dd>
            </div>)}
          </dl>
          <p>AI 2차는 제품 수가 아닌 심사 표 수입니다. 오류 기록은 저장된 기록 기준이며, 집계할 수 없는 단계는 오류 수를 표시하지 않습니다.</p>
        </div>
      </details>
    </section>
  );
}

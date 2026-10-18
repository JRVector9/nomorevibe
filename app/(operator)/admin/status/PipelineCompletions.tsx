import { DEFERRED, type CellState, type PipelineCompletions as Snapshot, type QueueMetric, type StageCompletions, type WindowMetric } from '@/lib/operations/pipeline-completions';
import { formatDetailTime } from '@/lib/format/time';

const STATES: Record<Exclude<CellState, 'value'>, string> = { unknown: '미확인', deferred: '미계산', none: '해당 없음' };
const number = (value: number) => value.toLocaleString('ko-KR');
const missing = (state: CellState) => STATES[state === 'value' ? 'unknown' : state];
const note = 'mt-1 text-[13px] text-fg-3';

function Values({ row }: { row: WindowMetric }) {
  if (row.state !== 'value' || !row.values) return <td colSpan={2} className="py-1 text-right text-fg-3">{missing(row.state)}</td>;
  return <><td className="py-1 text-right font-mono">{number(row.values['1h'])}</td><td className="py-1 pl-2 text-right font-mono">{number(row.values['24h'])}</td></>;
}

function Waiting({ row }: { row: QueueMetric }) {
  if (row.state !== 'value' || row.count === null) return <span className="text-fg-3">{missing(row.state)}</span>;
  return <>{number(row.count)}{row.aged && row.oldestMin !== null && <span className="text-fg-2"> · 최장 {number(row.oldestMin)}분</span>}</>;
}

/** 단계 하나의 칸 — 처리 지표 카드와 흐름 상세 탭의 노드 상세(운영센터 v8)가 같은 칸을 그린다 */
export function CompletionsStage({ stage }: { stage: StageCompletions }) {
  return <section className="min-w-0 rounded-[10px] border border-line p-3" aria-labelledby={`completions-${stage.key}`}>
        <h3 id={`completions-${stage.key}`} className="text-[13px] font-semibold">{stage.label}</h3>
        <table className="mt-1 w-full text-left text-[13px]">
          <caption className="sr-only">{stage.label} 최근 1시간·24시간 처리 지표</caption>
          <thead className="text-fg-3"><tr><th scope="col" className="py-1 font-medium">지표</th>
            <th scope="col" className="py-1 text-right font-medium">1시간</th><th scope="col" className="py-1 pl-2 text-right font-medium">24시간</th></tr></thead>
          <tbody>{stage.metrics.map(row => <tr key={row.key} className="border-t border-line align-top">
            <th scope="row" className="py-1 pr-2 font-normal">{row.label}{row.note && <span className="block text-fg-3">{row.note}</span>}</th>
            <Values row={row} /></tr>)}</tbody>
        </table>
        <h4 className="mt-2 text-[13px] font-medium">지금 대기</h4>
        <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[13px]">{stage.queue.map(row => <div key={row.key} className="contents">
          <dt className="text-fg-2">{row.label}{row.note && <span className="block text-fg-3">{row.note}</span>}</dt>
          <dd className="text-right font-mono"><Waiting row={row} /></dd></div>)}</dl>
      </section>;
}

/** 읽기 전용 관측. 고유 완료·실제 호출·재사용·AI2 표를 더하거나 서로 바꿔 읽지 않는다 */
export function PipelineCompletions({ status }: { status: Snapshot }) {
  return <section className="dash-card dash-12" aria-labelledby="pipeline-completions-title">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="pipeline-completions-title" className="text-[15px] font-bold">처리 지표 · 최근 1시간 / 24시간</h2>
      <span className="text-[13px] text-fg-3">{status.observedAt
        ? <>DB 조회 <time dateTime={status.observedAt}>{formatDetailTime(status.observedAt)}</time></>
        : '조회 시각 미확인'}</span>
    </div>
    <p className={note}>고유 완료·실제 호출·재사용·AI2 표는 서로 다른 수라 더하지 않습니다. 도메인 기록(legacy 포함)과 모델 장부는 같은 호출을 따로 적은 것이라 겹칠 수 있습니다.</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {status.stages.map(stage => <CompletionsStage key={stage.key} stage={stage} />)}
    </div>
    <details className="mt-3">
      <summary className="cursor-pointer text-[13px] font-medium">정의 · 측정 도구 대응 · 미계산 항목</summary>
      <ul className="mt-2 space-y-1 text-[13px] text-fg-2">
        <li>AI1 호출·기술 실패·취소·재사용·규칙 종료·대체는 측정 도구(pipeline-capacity-live)의 calls.ai1·exclusions 와 같은 분류입니다. 시각 이상·현재 설정 identity 거르기는 하지 않습니다.</li>
        <li>AI1 고유 완료는 창 안에서 모델 결정이 난 후보 수입니다. 후보마다 창 안 첫 결정으로 재심사 여부를 봅니다. 측정 도구의 최종 고유 완료(승인은 AI2 칸 규칙까지)와 다릅니다.</li>
        <li>AI2 호출·표는 측정 도구 ai2Calls 와 같은 경계로, 창 안에서 만든 fallback 사슬만 확정합니다. 창 이전에 만든 표가 창 안에서 끝나면 세지 않아 적체가 길면 1시간 수가 작게 보입니다.</li>
        <li>모델 장부는 model_capacity_events 의 dispatch·정산·불명·회수 기록입니다. 장부를 거치지 않은 legacy 호출은 여기에 없습니다.</li>
        <li>발행은 후보가 발행 상태로 바뀐 기록(crawl_publication_changes)입니다. 대기 나이는 DB 조회 시각 기준 분입니다.</li>
        <li>시각 인덱스가 없는 표는 24시간+1시간 안에 시작한 행만 읽습니다. 시작부터 종료까지 1시간을 넘긴 시도는 세지 않습니다.</li>
      </ul>
      <h3 className="mt-3 text-[13px] font-semibold">미계산 (주기 계산·캐시 설계만)</h3>
      <ul className="mt-1 space-y-1 text-[13px] text-fg-2">{DEFERRED.map(row => <li key={row.key}>
        <span className="font-medium">{row.label}</span> — {row.reason} <span className="text-fg-3">설계: {row.design}</span></li>)}</ul>
    </details>
  </section>;
}

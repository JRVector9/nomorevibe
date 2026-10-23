import Link from "next/link";
import type { CrawlerActivityReport } from "@/lib/operations/crawler-activity";
import { JOB_LABELS, ROLE_LABELS } from "@/lib/operations/contracts";
import { formatDetailTime, formatListTime } from "@/lib/format/time";
import { ScrollTable } from "../components/ScrollTable";
import { ACTION_LINKS } from "./action-links";
import { X_COLLECTOR_SCHEDULE, type XStatusView } from "@/lib/operations/x-status";
import { deferralLabel, xSummary } from "./flow-model";
import "./crawler-activity.css";

const jobLabel = (name: string) => name === "ai-level-refresh" ? "AI 제작 단계 확인" : JOB_LABELS[name] ?? name;
const STATES = { disabled: "설정 꺼짐", paused: "사람이 중단", running: "실행 중", "stale-lock": "중단·회수 대기",
  retrying: "재시도 대기", queued: "실행 요청 대기", error: "최근 회차 오류", "never-run": "실행 기록 없음", idle: "다음 예약 대기" };
const INSTANCE_STATES = { active: "담당 중", standby: "예비 대기", stale: "관측 지연", stopping: "종료 중", unknown: "담당 여부 미확인" };
const LANES = { main: "기본 줄", sources: "공개 근거 줄", scan: "개발 AI 조사 줄", evidence: "AI 단계 줄", stars: "8시간 스타 줄", screen: "화면 판별 줄", assist: "근거 보강 줄" };
const LANE_STATES = { idle: "일감 확인 대기", polling: "요청 확인 중", running: "실행 중", stopping: "종료 중",
  standby: "예비 대기", stale: "관측 지연", unknown: "진행 미확인", "other-job": "다른 역할 작업 중" };
const ERROR_LABELS = { timeout: "시간 초과", "rate-limited": "공급자 한도", authentication: "인증 확인 필요", "job-error": "실행 오류" };
const COUNTERS: Record<string, string> = { discovered: "발견", drained: "이번 탐색 완료", page: "페이지", incompleteWindows: "남은 탐색 구간",
  throttled: "수용 제한", fetched: "원본 확보", skipped: "건너뜀", failed: "오류", gated: "근거 미달", recovered: "회수",
  examined: "확인", backlogPages: "이전 페이지", attempted: "시도", succeeded: "성공", factsChanged: "근거 변경",
  eventsInserted: "업데이트 추가", mediaInserted: "이미지 추가", observations: "흔적", cached: "저장 결과 사용",
  checked: "점검", due: "이번 대상", verified: "단계 확인", restUsed: "REST 요청", remaining: "남은 한도", updated: "갱신",
  ok: "정상", missing: "없음", empty: "빈 저장소", blocked: "접근 제한", unknown: "미확인", renamed: "이름 변경", archived: "보관",
  batches: "묶음", recorded: "관측 저장", targets: "회차 대상", runs: "회차", refreshed: "갱신", superseded: "원본 변경",
  alive: "응답 있음", down: "응답 없음", added: "추가", autoApprove: "자동 승인", unfinished: "다음 회차에 이어짐",
  filled: "이미지 확보", defaults: "기본 이미지", reviewed: "재확인", keep: "유지", human: "사람 확인", delist_candidate: "내릴 후보",
  delisted: "내림", operatorKeep: "운영자 유지", capped: "한도 대기", limit: "한도" };
const n = (value: number) => value.toLocaleString("ko-KR");
function counters(value: Record<string, number | boolean>) {
  return Object.entries(value).map(([key, value]) => `${COUNTERS[key] ?? key} ${typeof value === "boolean" ? value ? "예" : "아니오" : n(value)}`).join(" · ");
}
type Totals = NonNullable<CrawlerActivityReport["jobs"][number]["totals"]>["hour"];
/** 누적 한 창의 이벤트 — "원본 수집 결과 원본 확보 120 · 건너뜀 30", 숫자 없는 이벤트는 "원본 공급자 한도 대기 3회" */
function eventLine(event: Totals["events"][number]) {
  const numbers = counters(event.counts);
  return `${event.label}${numbers ? ` ${numbers}` : ""}${event.times ? ` ${n(event.times)}회` : ""}`;
}
/** 누적 한 창의 머리 — "회차 60 · 제 일 못 함 2 · 실패 1 · 미룸 3" */
function tickLine(totals: Totals, deferred: number | null) {
  return [`회차 ${n(totals.ticks)}`, totals.degraded ? `제 일 못 함 ${n(totals.degraded)}` : null, totals.failed ? `실패 ${n(totals.failed)}` : null,
    deferred ? `미룸 ${n(deferred)}` : null].filter(Boolean).join(" · ");
}
const TOTALS_NOTE = "성공 회차의 숫자를 10분(최근 1시간)·정시(최근 24시간) 단위로 묶어 더합니다 — 최근 1시간은 최대 10분, 24시간은 이번 시를 포함한 24칸입니다. 실패한 회차의 숫자는 더하지 않고 횟수만 셉니다.";
function TotalsCell({ row, failed }: { row: CrawlerActivityReport["jobs"][number]; failed: boolean }) {
  if (!row.totals) return <span className="crawler-muted">{failed ? "누적 미확인" : "누적 없음"}</span>;
  return <div className="crawler-totals" title={TOTALS_NOTE}>
    {([["최근 1시간", row.totals.hour, row.deferredHour], ["최근 24시간", row.totals.day, null]] as const).map(([label, totals, deferred]) => <div key={label}>
      <span>{label} · {tickLine(totals, deferred)}</span>
      {totals.events.length ? totals.events.slice(0, 3).map((event, index) => <small key={index}>{eventLine(event)}</small>)
        : <small>{totals.ticks ? "숫자를 남기지 않은 회차" : "회차 없음"}</small>}
    </div>)}
  </div>;
}
function Tone({ state, children }: { state: string; children: React.ReactNode }) {
  const tone = ["error", "stale-lock", "stale", "item-errors", "event-errors", "provider-error"].includes(state) ? "bad"
    : ["paused", "disabled", "retrying", "unknown", "waiting"].includes(state) ? "warn" : state === "running" || state === "active" ? "ok" : "muted";
  return <span className="crawler-state" data-tone={tone}>{children}</span>;
}
function ResultStatus({ result }: { result: CrawlerActivityReport["recent"][number] }) {
  return <Tone state={result.outcome}>{result.outcome === "item-errors" ? result.itemErrors !== null ? `항목 오류 ${n(result.itemErrors)}` : `오류 이벤트 ${n(result.errorEvents)} · 보존분`
    : result.outcome === "event-errors" ? `오류 이벤트 ${n(result.errorEvents)} · 보존분`
    : result.outcome === "provider-error" ? "공급자 오류 · 항목 수 미확인"
    : result.outcome === "unknown" ? "수집 결과 미확인"
    : result.outcome === "waiting" ? "공급자·다음 회차 대기" : "회차 성공"}</Tone>;
}

/**
 * 운영센터 작업 상세 창의 "최근 1시간 · 24시간 누적" — 수집기만(누적은 수집기에만 쌓는다). 서버가 그려 창에 넘긴다.
 * 마지막 성공보다 나중에 실패·미룬 회차가 있으면 먼저 적는다.
 */
export function CollectorTotalsDetail({ row, now }: { row: CrawlerActivityReport["jobs"][number]; now: string }) {
  return <div className="crawler-activity">
    {row.lastFailedAt && <p>마지막 성공 뒤 실패한 회차 · <time dateTime={row.lastFailedAt}>{formatListTime(row.lastFailedAt, now)}</time></p>}
    {row.lastDeferred && <p>마지막 성공 뒤 미룸 · {deferralLabel(row.lastDeferred.reason)} · <time dateTime={row.lastDeferred.at}>{formatListTime(row.lastDeferred.at, now)}</time></p>}
    <p className="crawler-muted">{TOTALS_NOTE}</p>
    {row.totals ? <ul className="crawler-detail-totals">
      {([["최근 1시간", row.totals.hour, row.deferredHour], ["최근 24시간", row.totals.day, null]] as const).map(([label, totals, deferred]) => <li key={label}>
        <strong>{label} · {tickLine(totals, deferred)}</strong>
        {totals.events.map((event, index) => <span key={index}>{eventLine(event)}</span>)}
      </li>)}
    </ul> : <p className="crawler-muted">누적을 읽지 못했거나 아직 없습니다.</p>}
  </div>;
}

/**
 * X 칸 — 예약된 크롤러 잡이 아니라 osaka 서버의 X 수집기가 하루 한 번 보고를 보낸다(2026-10-20부터 매일 자동 수집).
 * 상태는 운영센터 흐름 상세·X 보고 끊김 조치와 같은 readXStatus → xSummary 다. 전에는 "자동 수집 안 함 · 수동 API 파일럿"으로 굳어 있었다.
 */
function XCollectorCard({ x }: { x: XStatusView }) {
  const summary = xSummary(x);
  const minLikes = x.report?.v === 3 ? x.report.query.minLikes : null;
  // 색은 흐름 상세의 X 칸과 같다 — 정상 초록, 끊김·오류·모양 어긋남 주황, 연결 전·꺼짐 회색
  const tone = summary.tone === "ok" ? "ok" : summary.tone === "warn" ? "warn" : "muted";
  return <section className="dash-card crawler-x"><div className="dash-card-h"><h2>X</h2><span className="crawler-state" data-tone={tone}>{summary.value}</span></div>
    <p>예약된 크롤러 잡이 아니라 osaka 서버(osaka-smoke)의 X 수집기가 {X_COLLECTOR_SCHEDULE}에 한 번 GitHub 주소가 있고 많이 퍼진 글
      {minLikes !== null && <>(<code>url:github.com min_likes:{minLikes}</code>)</>}을 검색해 후보 게시물과 하루 보고를 보냅니다. 받은 글은 SNS 화제에서 봅니다.</p>
    <p className="crawler-muted">{summary.note}</p>
    <div className="crawler-links"><Link href="/admin/talk?source=x" prefetch={false}>SNS 화제의 X 글 →</Link></div>
  </section>;
}

/** A server-rendered slot: the browser receives only this bounded read-only projection. */
export function CrawlerActivity({ report, x }: { report: CrawlerActivityReport; x?: XStatusView }) {
  const { measuredAt: now, jobs, instances, recent } = report;
  const running = jobs.filter(row => row.state === "running").length;
  const errors = jobs.filter(row => row.error || row.latest?.outcome === "item-errors" || row.latest?.outcome === "event-errors" || row.latest?.outcome === "provider-error").length;
  return <div className="crawler-activity">
    <section className="dash-card">
      <div className="dash-card-h"><h2>크롤러 활동</h2><small>수집기 {jobs.length}개 · 실행 중 {running}개 · 최근 오류 관측 {errors}개</small></div>
      <p>탐색부터 원본·근거·스타·사이트·소식·이미지 수집까지, 역할이 다른 수집기도 함께 봅니다. 회차 성공과 항목별 수집 성공은 별개입니다.</p>
      <div className="crawler-links"><Link href={ACTION_LINKS.collectorSettings} prefetch={false}>검색 신호 설정 →</Link><Link href={ACTION_LINKS.githubAccounts} prefetch={false}>GitHub 수집 계정 →</Link></div>
      {report.queueReadFailed && <p className="crawler-notice">대기 집계를 읽지 못했습니다. 미확인은 대기 0건을 뜻하지 않습니다.</p>}
      {(report.totalsReadFailed || report.deferralsReadFailed) && <p className="crawler-notice">{report.totalsReadFailed ? "회차 누적" : "미룬 기록"}을 읽지 못했습니다(복제본 보류). 미확인은 0건을 뜻하지 않습니다.</p>}
      <ScrollTable label="수집기 활동 표"><table className="crawler-table">
        <thead><tr><th scope="col">수집기 · 역할/줄</th><th scope="col">현재 상태</th><th scope="col">대기</th><th scope="col">마지막 실행 · 성공</th><th scope="col">다음 예약 · 재시도</th><th scope="col">최근 결과</th><th scope="col" title={TOTALS_NOTE}>누적 · 최근 1시간 / 24시간</th></tr></thead>
        <tbody>{jobs.map(row => <tr key={row.name}>
          <th scope="row"><strong>{jobLabel(row.name)}</strong><code>{row.name}</code><small>{ROLE_LABELS[row.role]} · {LANES[row.lane]} · {row.intervalMs === null ? "요청 시" : `${n(row.intervalMs / 60_000)}분 주기`}</small>{row.note && <small className="crawler-note">{row.note}</small>}</th>
          <td><Tone state={row.state}>{STATES[row.state]}</Tone>{!row.enabled && row.state !== "disabled" && <small>설정 꺼짐 · 현재 회차 관측</small>}{row.paused && row.state !== "paused" && <small>사람이 중단 요청</small>}{row.error && <small>최근 오류 · {ERROR_LABELS[row.error]}</small>}{row.runs !== null && <small>누적 {n(row.runs)}회</small>}</td>
          <td><span>{row.waiting === null ? "대기 미확인" : `대기 ${n(row.waiting)}`}</span>{row.deferred !== null && <small>재시도 예약 {n(row.deferred)}</small>}</td>
          <td><time title={formatDetailTime(row.lastRunAt)} dateTime={row.lastRunAt ?? undefined}>{formatListTime(row.lastRunAt, now, "실행 기록 없음")}</time><small>성공 {formatListTime(row.lastSuccessAt, now, "기록 없음")}</small></td>
          <td><time title={formatDetailTime(row.nextScheduledAt)} dateTime={row.nextScheduledAt ?? undefined}>{formatListTime(row.nextScheduledAt, now, "예약 미확인")}</time>{row.retryAt && <small>재시도 {formatListTime(row.retryAt, now)}</small>}</td>
          <td>
            {/* 마지막 성공보다 나중에 실패·미룬 틱 — 지난 성공 숫자만 남아 멈춘 것처럼 보이지 않게 먼저 적는다 */}
            {row.lastFailedAt && <><Tone state="error">실패한 회차</Tone><small><time dateTime={row.lastFailedAt} title={formatDetailTime(row.lastFailedAt)}>{formatListTime(row.lastFailedAt, now)}</time></small></>}
            {row.lastDeferred && <><Tone state="waiting">미룸 · {deferralLabel(row.lastDeferred.reason)}</Tone><small><time dateTime={row.lastDeferred.at} title={formatDetailTime(row.lastDeferred.at)}>{formatListTime(row.lastDeferred.at, now)}</time>{row.lastDeferred.lastHour > 0 ? ` · 최근 1시간 ${n(row.lastDeferred.lastHour)}회` : ""}</small></>}
            {row.latest ? <>{(row.lastFailedAt || row.lastDeferred) && <small>마지막 성공 회차</small>}<ResultStatus result={row.latest}/><small>{formatListTime(row.latest.observedAt, now)}{row.latest.durationMs !== null ? ` · ${(row.latest.durationMs / 1000).toFixed(1)}초` : ""}</small>{row.latest.itemErrors === null && <small>항목 오류 미집계</small>}</> : <span className="crawler-muted">회차 결과 없음</span>}</td>
          <td><TotalsCell row={row} failed={report.totalsReadFailed} /></td>
        </tr>)}</tbody>
      </table></ScrollTable>
    </section>

    <section className="dash-card">
      <div className="dash-card-h"><h2>담당·예비 인스턴스와 작업 줄</h2><small>프로세스 관측 45초 · 후보 관측 60초 기준</small></div>
      <p>담당 표시는 유효한 역할 lease와 관측을 함께 확인합니다. 예비는 자동 인계를 기다리며, 관측이 오래된 줄을 현재 실행으로 세지 않습니다.</p>
      {report.roleReadFailed && <p className="crawler-notice">역할 담당 정보를 읽지 못했습니다. 담당 여부를 확인할 수 없습니다.</p>}
      {instances.length === 0 ? <p className="crawler-muted">관측된 수집 인스턴스가 없습니다.</p> : <div className="crawler-instances">{instances.map(instance => <article className="crawler-instance" key={`${instance.role}:${instance.instanceId}`}>
        <div className="crawler-instance-heading"><div><strong>{instance.instanceId}</strong><small>{ROLE_LABELS[instance.role]} · {instance.kind === "primary" ? "주 후보" : instance.kind === "standby" ? "예비 후보" : instance.kind === "consumer" ? "consumer · 역할 담당 없이 claim" : "후보 종류 미확인"}{instance.release ? ` · ${instance.release}` : ""}</small></div><Tone state={instance.state}>{instance.kind === "consumer" ? (instance.state === "active" ? "실행 관측" : "관측 지연") : INSTANCE_STATES[instance.state]}</Tone></div>
        <p className="crawler-muted">마지막 관측 {formatListTime(instance.observedAt, now)}{instance.runtimeStale && instance.state !== "standby" ? " · 프로세스 진행 관측 지연/없음" : ""}</p>
        <ul className="crawler-lanes">{instance.lanes.map(lane => <li key={lane.name}><div><b>{LANES[lane.name]}</b><small>{lane.jobs.map(jobLabel).join(" · ")}</small></div><div><Tone state={lane.state}>{LANE_STATES[lane.state]}</Tone>{lane.currentJob && <small>{jobLabel(lane.currentJob)} · 시작 {formatListTime(lane.startedAt, now)}</small>}</div></li>)}</ul>
      </article>)}</div>}
      <p className="crawler-muted crawler-footnote">현재 관측은 모두 표시하고, 오래된 배포 인스턴스는 최근 20개까지 표시합니다.</p>
    </section>

    <section className="dash-card">
      <div className="dash-card-h"><h2>수집기별 최근 실행</h2><small>최근 결과 {recent.length}개 · 최대 30개</small></div>
      <p>수집기마다 저장된 가장 최근 성공 회차입니다. 전체 실행 이력은 저장되지 않으며, 이후 실패·미룬 회차는 위 표의 최근 결과에 먼저 적습니다. 숫자는 그 회차의 관측값이고, 최근 1시간·24시간 합계는 위 표의 누적 칸에 있습니다.</p>
      {recent.length === 0 ? <p className="crawler-muted">저장된 수집 회차 결과가 없습니다.</p> : <div className="crawler-results">{recent.map(result => <details key={result.name}>
        <summary><strong>{jobLabel(result.name)}</strong><time dateTime={result.observedAt}>{formatListTime(result.observedAt, now)}</time><ResultStatus result={result}/>{result.durationMs !== null && <span>{(result.durationMs / 1000).toFixed(1)}초</span>}</summary>
        {result.itemErrors === null && <p className="crawler-muted">항목 오류 미집계 — 오류가 없다고 판단할 수 없습니다.</p>}
        {result.errorEvents > 0 && <p className="crawler-muted">오류 이벤트는 보존된 최근 12개 이벤트 안의 관측 횟수입니다. 전체 실패 항목 수와 같지 않을 수 있습니다.</p>}
        {result.events.length ? <ul>{result.events.map((event,index) => <li key={index}><strong>{event.label}</strong>{Object.keys(event.counts).length > 0 && <span>{counters(event.counts)}</span>}</li>)}</ul> : <p className="crawler-muted">저장된 항목별 숫자가 없습니다.</p>}
      </details>)}</div>}
    </section>

    {x ? <XCollectorCard x={x} /> : <section className="dash-card crawler-x"><div className="dash-card-h"><h2>X</h2><Tone state="unknown">보고 미확인</Tone></div><p>X 수집기 보고를 넘겨받지 못했습니다 — 미확인. 운영센터 흐름 상세의 X 칸을 봅니다.</p></section>}
  </div>;
}

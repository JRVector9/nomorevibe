import Link from "next/link";
import { formatDetailTime, formatListTime } from "@/lib/format/time";
import type { AdminModelsObservation } from "@/lib/operations/admin-models-observation";
import { kstClock } from "@/lib/operations/admin-models-view";
import { LLM_HISTORY_KIND_IDS, LLM_HISTORY_KINDS, llmHistoryHref, llmHistoryKindOf, recentFailures, type LlmHistoryFilter, type RetryView } from "@/lib/operations/llm-ops-history";
import type { LlmChangeLog } from "@/lib/operations/llm-ops-read";
import { actionLabel, targetLabel } from "../../activity/labels";
import { isScriptRow, summaryLine, summaryLines } from "../../activity/summary";
import { DataTable } from "../../flow/PrototypeParts";
import { LevelBadge, ObservedAt } from "../LlmOpsParts";
import { ModelCallsPanel } from "../ModelCallsPanel";
import { CloseReviewForm, RequeueButton } from "./RetryActions";

const fmt = (value: number) => value.toLocaleString("ko-KR");
const stamp = (value: string | null) => value ? `${kstClock(value)} KST` : "—";
/** 미확정 사유마다 근거 한 줄 — 엔진이 아직 생성 중일 수 있는지, 다시 넣어도 되는지. 사유를 쓰기 전에 본다. */
const GROUND: Readonly<Record<string, string>> = {
  client_timeout: "클라이언트 기한 뒤 응답 없음 · mlx-lm 은 취소가 없어 엔진이 아직 생성 중일 수 있음",
  transport_unknown: "전송 뒤 소켓이 끊김 · 서버 종료 기록은 따로 확인 · 같은 작업 키 재시도는 막지 않음",
  local_abort: "로컬에서 호출을 중단함 · 엔진이 끝까지 생성했을 수 있음",
  process_exit: "워커 프로세스가 끝나 결과를 받지 못함",
  commit_unknown: "정산 commit 결과를 모름 · 장부와 업무 기록을 대조",
};

function RetryPanel({ retry, readOnly }: { retry: RetryView; readOnly: boolean }) {
  const supported = retry.groups.filter(group => group.supported);
  return <section className="llm-panel" id="retry" aria-labelledby="llm-retry-title">
    <div className="llm-panel-head"><h2 id="llm-retry-title">재실행 대기</h2>
      <LevelBadge level={!retry.readable ? "unknown" : retry.total > 0 ? "warn" : "ok"}>{!retry.readable ? "확인 불가" : `결과 미확정 ${fmt(retry.total)}건`}</LevelBadge></div>
    <div className="llm-panel-body">
      <p className="llm-empty">결과를 받지 못한 호출입니다. 칸을 차지하지 않습니다. 「다시 대기열」은 그 단계의 작업을 다시 실행하고 다시 넣은 행만 닫습니다.
        「닫기」는 작업을 다시 넣지 않고 사유를 남겨 행만 닫습니다.</p>
      {retry.error && <p role="alert" className="llm-notice">재실행 목록을 읽지 못했습니다 · {retry.error}</p>}
      {retry.readable && retry.total === 0 && <p className="llm-empty">다시 실행할 미확정 호출이 없습니다.</p>}
      {retry.groups.length > 0 && <DataTable heads={["단계", "모델", "건수", "까닭", "근거", "조치"]} min={760}
        note={retry.truncated ? "모델·까닭·근거는 오래된 100건에서 셉니다. 「다시 대기열」은 그 단계의 미확정 행 전부(최대 500건)에 적용됩니다." : null}>
        {retry.groups.map(group => <tr key={group.routeId} data-retry-route={group.routeId}>
          <td><b>{group.label}</b><p className="llm-muted">{group.routeId}</p></td>
          <td>{group.models.map(model => <div key={model.key}><code>{model.label}</code>{group.models.length > 1 && <span className="llm-muted"> {fmt(model.count)}</span>}</div>)}</td>
          <td className="llm-num">{fmt(group.count)}</td>
          <td>{group.reasons.map(reason => `${reason.label} ${fmt(reason.count)}`).join(" · ") || "—"}</td>
          <td>{[group.localEnded ? `로컬 종료 기록 ${fmt(group.localEnded)}` : "로컬 종료 기록 없음", group.oldPolicy ? `옛 정책 세대 ${fmt(group.oldPolicy)}` : null,
            group.oldestAt ? `가장 오래된 전송 ${stamp(group.oldestAt)}` : null].filter((line): line is string => !!line).map(line => <div key={line}>{line}</div>)}</td>
          <td>{group.supported ? <RequeueButton routeId={group.routeId} label={group.label} count={group.count} readOnly={readOnly} />
            : <span className="llm-muted">이 단계는 다시 대기열을 아직 지원하지 않습니다 — 아래에서 한 건씩 닫습니다.</span>}</td>
        </tr>)}
      </DataTable>}
      {supported.length > 1 && <div className="llm-retry-all"><RequeueButton routeId="" label="지원하는 단계 모두의" count={retry.supportedTotal} readOnly={readOnly} /></div>}
      {retry.items.length > 0 && <details className="llm-retry-items">
        <summary>한 건씩 보기 · 닫기 ({fmt(retry.items.length)}건{retry.truncated ? ", 오래된 순 100건까지" : ""})</summary>
        <ul>{retry.items.map(item => <li key={item.requestId} id={`rv-${item.requestId}`} className="llm-retry-item">
          <p className="llm-retry-item-head"><code title={item.requestId}>{item.requestId.slice(0, 8)}</code><b>{retry.groups.find(group => group.routeId === item.routeId)?.label ?? item.routeId}</b>
            <span className="llm-muted">{item.provider} · {item.model} · 장비 {item.groupId}</span>
            {item.oldPolicy && <span className="llm-muted">옛 정책 세대</span>}</p>
          <p className="llm-muted">전송 {stamp(item.dispatchedAt)} · 미확정 처리 {stamp(item.markedAt)}{item.localEndRecorded ? " · 로컬 종료 기록 있음" : ""} · 소유 프로세스 {item.ownerInstanceId}</p>
          <p className="llm-muted">근거: {item.reason ? GROUND[item.reason] ?? `사유 코드 ${item.reason}` : "사유 기록 없음 — 장부 이벤트를 확인"}</p>
          <p className="llm-muted llm-break">작업 키 {item.workKey}{item.logicalWorkKey && item.logicalWorkKey !== item.workKey ? ` · 논리 키 ${item.logicalWorkKey}` : ""}</p>
          <CloseReviewForm requestId={item.requestId} readOnly={readOnly} />
        </li>)}</ul>
      </details>}
    </div>
  </section>;
}

function FailuresPanel({ observation }: { observation: AdminModelsObservation }) {
  const rows = recentFailures(observation);
  return <section className="llm-panel" id="failures" aria-labelledby="llm-failures-title">
    <div className="llm-panel-head"><h2 id="llm-failures-title">최근 1시간 실패</h2>
      <LevelBadge level={rows === null ? "unknown" : rows.length ? "bad" : "ok"}>{rows === null ? "확인 불가" : `${fmt(rows.reduce((sum, row) => sum + row.failed, 0))}건`}</LevelBadge></div>
    <div className="llm-panel-body">
      {rows === null ? <p className="llm-empty">장부를 읽지 못했습니다.</p> : !rows.length ? <p className="llm-empty">최근 1시간에 실패로 정산된 호출이 없습니다.</p>
        : <DataTable heads={["단계", "모델", "장비", "실패", "성공", "마지막 성공"]} min={640}
          note={<>실패한 작업은 각 잡이 정한 횟수만큼 스스로 다시 시도합니다. 연결 상태와 까닭은 <Link prefetch={false} className="llm-link" href="/admin/models/llm">LLM 운영</Link>에서 봅니다.</>}>
          {rows.map(row => <tr key={row.key}><td><b>{row.label}</b></td><td><code>{row.model}</code></td><td>{row.groupId}</td>
            <td className="llm-num">{fmt(row.failed)}</td><td className="llm-num">{fmt(row.succeeded)}</td><td>{stamp(row.lastSuccessAt)}</td></tr>)}
        </DataTable>}
    </div>
  </section>;
}

function ChangeLogPanel({ changes, filter, now }: { changes: LlmChangeLog; filter: LlmHistoryFilter; now: Date }) {
  const chip = (active: boolean) => `llm-filter${active ? " active" : ""}`;
  const last = changes.rows.at(-1);
  return <section className="llm-panel" id="audit" aria-labelledby="llm-audit-title">
    <div className="llm-panel-head"><h2 id="llm-audit-title">설정·조치 변경 기록</h2>
      <Link prefetch={false} className="llm-link" href="/admin/activity?workspace=models&group=llm">작업 로그에서 보기 →</Link></div>
    <div className="llm-panel-body">
      <nav className="llm-filters" aria-label="변경 기록 거르기">
        <Link prefetch={false} className={chip(!filter.kind)} aria-current={!filter.kind ? "page" : undefined} href={llmHistoryHref({ failedOnly: filter.failedOnly })}>전체</Link>
        {LLM_HISTORY_KIND_IDS.map(kind => <Link key={kind} prefetch={false} className={chip(filter.kind === kind)} aria-current={filter.kind === kind ? "page" : undefined}
          href={llmHistoryHref({ kind, failedOnly: filter.failedOnly })}>{LLM_HISTORY_KINDS[kind].label}</Link>)}
        <Link prefetch={false} className={chip(filter.failedOnly)} aria-current={filter.failedOnly ? "page" : undefined} href={llmHistoryHref({ kind: filter.kind, failedOnly: !filter.failedOnly })}>실패만</Link>
      </nav>
      {changes.error ? <p role="alert" className="llm-notice">변경 기록을 읽지 못했습니다.</p>
        : !changes.rows.length ? <p className="llm-empty">{filter.before ? "더 이전 기록이 없습니다." : "조건에 맞는 기록이 없습니다."}</p>
        : <DataTable heads={["시각", "누가", "갈래", "작업", "대상", "내용"]} min={860}>
          {changes.rows.map(row => {
            const kind = llmHistoryKindOf(row.action);
            const lines = summaryLines(row);
            return <tr key={row.id} data-audit-action={row.action}>
              <td className="llm-num" title={formatDetailTime(row.createdAt)}>{formatListTime(row.createdAt, now)}</td>
              <td>{row.actor}{isScriptRow(row) && <p className="llm-muted">스크립트</p>}</td>
              <td>{kind ? LLM_HISTORY_KINDS[kind].label : "—"}</td>
              <td><b>{actionLabel(row.action)}</b>{!row.ok && <p><LevelBadge level="bad">실패</LevelBadge>{row.error && <span className="llm-muted"> {row.error}</span>}</p>}</td>
              <td className="llm-break">{targetLabel(row.target).text}</td>
              <td className="llm-break">{lines.length > 2 ? <details><summary>{summaryLine(row)}</summary>{lines.map(line => <div key={line}>{line}</div>)}</details> : summaryLine(row)}</td>
            </tr>;
          })}
        </DataTable>}
      <p className="llm-pager">
        {filter.before && <Link prefetch={false} className="llm-link" href={llmHistoryHref({ kind: filter.kind, failedOnly: filter.failedOnly })}>← 최근으로</Link>}
        {changes.more && last && <Link prefetch={false} className="llm-link" href={llmHistoryHref({ kind: filter.kind, failedOnly: filter.failedOnly, before: last.id })}>이전 기록 더 보기 →</Link>}
      </p>
    </div>
  </section>;
}

/**
 * 기록(/admin/models/history) — 「무엇이 언제 바뀌었고, 무엇이 실패했나?」(2026-11-07 승인 시안 PR 3).
 * 재실행 패널(결과 미확정 단계별 묶음 · 다시 대기열 · 사유 받는 닫기) → 최근 1시간 실패 → 호출 기록 → 설정·조치 변경 기록(연결·한도·순위·조치로 거르기).
 * 예전에는 다시 대기열이 고급 영역에만, 닫기는 고급 영역과 운영 홈 대화상자에, 변경 기록은 하위 화면마다 따로 있었다.
 */
export function ModelsHistory({ retry, observation, changes, filter, now, readOnly }: {
  retry: RetryView; observation: AdminModelsObservation; changes: LlmChangeLog; filter: LlmHistoryFilter; now: Date; readOnly: boolean;
}) {
  return <div className="stack llm-ops" data-llm-page="history">
    <div className="llm-toolbar"><ObservedAt label="장부 관측" at={observation.observedAt} /></div>
    <RetryPanel retry={retry} readOnly={readOnly} />
    <FailuresPanel observation={observation} />
    <ModelCallsPanel observation={observation} limit={30} />
    <ChangeLogPanel changes={changes} filter={filter} now={now} />
  </div>;
}

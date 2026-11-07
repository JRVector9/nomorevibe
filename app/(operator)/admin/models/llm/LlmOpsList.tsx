import Link from "next/link";
import type { LlmOpsRow, LlmOpsView, LlmTaskChip } from "@/lib/operations/llm-ops-view";
import { MODEL_REQUEST_REVIEW_HREF } from "../ModelCallsPanel";
import { LevelBadge, LevelLegend, ObservedAt } from "../LlmOpsParts";
import { modelPickerModelLabel } from "../model-picker-display";
import { DeleteConnectionButton, RereadModelsButton } from "../tasks/ConnectionButtons";
import { ConnectionForm, type ConnectionLimitField } from "../tasks/ConnectionForm";

const NEW_LIMIT: ConnectionLimitField = { deviceId: "", current: null, expectedVersion: null, policyHash: null, eligible: false, reason: null, sharedWith: [] };
const fmt = (value: number) => value.toLocaleString("ko-KR");
const kst = (at: string | null) => at ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at)) : null;

function TaskChip({ chip }: { chip: LlmTaskChip }) {
  const rank = chip.rank !== null ? String(chip.rank) : chip.source === "pool" ? "분산" : "설정";
  const title = `${chip.label} · ${chip.rank !== null ? `${chip.rank}순위` : chip.source === "pool" ? "작업 분산 구성원" : chip.source === "classifier" ? "분류 설정" : "정책 경로·계약"} · ${chip.model}${chip.enabled ? "" : " · 순위 꺼짐"}${chip.paused ? " · 잡 일시중지" : ""}`;
  return <Link prefetch={false} href={chip.href} className="llm-chip" data-source={chip.source} data-off={chip.enabled ? undefined : "true"} data-paused={chip.paused ? "true" : undefined} title={title}>
    <span className="llm-chip-rank">{rank}</span>{chip.label}{chip.paused ? " · 중지" : ""}</Link>;
}

const modelLabel = (row: LlmOpsRow, id: string) => row.connection ? modelPickerModelLabel(row.connection, id) : id;

function ModelsBlock({ row, readOnly }: { row: LlmOpsRow; readOnly: boolean }) {
  const { connection } = row;
  const read = kst(row.models.readAt);
  const used = row.tasks.some(chip => chip.source === "rank" || chip.source === "pool");
  return <section className="llm-models" aria-label={`${row.label} 모델 목록`}>
    <h3>{connection?.kind === "api" ? "이 서버의 모델" : "모델"} · {row.models.ids.length}개{read ? ` · ${read} 읽음` : ""}</h3>
    {row.models.error && <p className="llm-notice">마지막 목록 오류: {row.models.error}</p>}
    {row.models.ids.length ? <ul>{row.models.ids.map(id => <li key={id}><code>{modelLabel(row, id)}</code>
      {(row.modelTasks[id] ?? []).length ? (row.modelTasks[id] ?? []).map(chip => <TaskChip key={chip.key} chip={chip} />) : <span className="llm-muted">배정 없음</span>}</li>)}</ul>
      : <p className="llm-empty">{connection?.kind === "api" ? "아직 읽은 모델이 없습니다 — 주소·키를 확인하고 저장하거나 다시 읽으세요." : "적힌 모델이 없습니다."}</p>}
    <p className="llm-empty">모델 옆 칩은 그 모델을 쓰는 작업과 순위입니다. 누르면 작업 배정으로 이동합니다.</p>
    {connection && !readOnly && <div className="llm-edit-links">
      {connection.kind === "api" && <RereadModelsButton id={connection.id} />}
      {!used && <DeleteConnectionButton id={connection.id} label={connection.label} version={connection.version} />}
    </div>}
  </section>;
}

function CliToolDetail({ row }: { row: LlmOpsRow }) {
  return <div className="llm-models">
    <h3>이 CLI 도구를 쓰는 곳</h3>
    <p className="llm-empty">AI 연결 행이 없는 CLI 도구입니다. 정책 경로·장부·CLI 계약·분류 설정에서 모았습니다. 바꾸는 곳은 아래 화면입니다.</p>
    <div className="llm-edit-links">{row.editLinks.map(link => <Link key={link.href} prefetch={false} className="button small" href={link.href}>{link.label} →</Link>)}</div>
    {row.otherDevices.length > 0 && <p className="llm-empty">다른 장비: {row.otherDevices.join(" · ")}</p>}
  </div>;
}

function ConnectionRow({ row, view, secretBox, readOnly, open }: { row: LlmOpsRow; view: LlmOpsView; secretBox: boolean; readOnly: boolean; open: boolean }) {
  const { capacity, status } = row;
  const first = row.models.ids[0];
  return <article id={row.anchor} className="llm-conn llm-conn-cols" data-source={row.source} data-row={row.key}>
    <div className="llm-conn-grid">
      <div className="llm-cell llm-cell-wide">
        <span className="llm-conn-name">{row.label}</span>
        <span className="llm-conn-meta">{[row.kindText, row.address, row.version ? `${row.kind === "cli" ? "" : "버전 "}${row.version}${row.versionSource ? `(${row.versionSource})` : ""}` : row.kind === "cli" ? "CLI 버전 미확인" : null, row.keyText].filter(Boolean).join(" · ")}</span>
        {row.connection && <span className="llm-conn-meta">장비 <code>{row.connection.deviceId}</code></span>}
        {!row.enabled && <LevelBadge level="idle">꺼짐</LevelBadge>}
      </div>
      <div className="llm-cell"><span className="llm-cell-label">모델</span>
        {first ? <span><code>{modelLabel(row, first)}</code>{row.models.ids.length > 1 && <span className="llm-muted"> 외 {row.models.ids.length - 1}</span>}</span> : <span className="llm-muted">없음</span>}
        <span className="llm-muted">{row.models.title}</span>
      </div>
      <div className="llm-cell"><span className="llm-cell-label">한도 · 점유</span>
        {capacity ? <>
          <span className="llm-cap" title="점유(예약+실행 중) / 장비 행 한도">{capacity.text}</span>
          {capacity.mismatch && <span className="llm-flag"><span aria-hidden="true">▲</span>연결 폼 {fmt(capacity.stored!)}칸과 다름</span>}
          {capacity.note && !capacity.mismatch && <span className="llm-muted">{capacity.note}</span>}
          {capacity.waiting ? <span className="llm-muted">대기 {fmt(capacity.waiting)}</span> : null}
          {capacity.sharedWith.length > 0 && <span className="llm-muted">함께 씀: {capacity.sharedWith.join(" · ")}</span>}
        </> : <span className="llm-muted">장비 없음</span>}
      </div>
      <div className="llm-cell llm-cell-wide"><span className="llm-cell-label">배정된 작업</span>
        {row.tasks.length ? <span className="llm-chips">{row.tasks.map(chip => <TaskChip key={chip.key} chip={chip} />)}</span> : <span className="llm-muted">배정 없음</span>}
      </div>
      <div className="llm-cell" data-status={status.level}><span className="llm-cell-label">상태</span>
        <LevelBadge level={status.level} title={status.detail ?? undefined}>{status.text}</LevelBadge>
        {status.reason && <span className="llm-conn-status-reason">{status.reason}</span>}
      </div>
      <div className="llm-cell"><span className="llm-cell-label">재실행</span>
        {row.retry === null ? <span className="llm-muted">확인 불가</span> : row.retry > 0
          ? <Link prefetch={false} className="llm-link" href={MODEL_REQUEST_REVIEW_HREF}>대기 {fmt(row.retry)} →</Link> : <span className="llm-muted">대기 0</span>}
      </div>
    </div>
    <details className="llm-conn-edit" open={open || undefined}>
      <summary>{row.connection ? "펼치기 · 연결 편집" : "펼치기 · 자세히"}</summary>
      <div className="llm-conn-edit-body">
        {row.connection ? <ConnectionForm key={`${row.connection.id}#${row.connection.version}`} initial={row.connection} secretBox={secretBox} limit={row.limitForm}
          cancelHref="/admin/models/llm" readOnly={readOnly} savedModels={view.rows.filter(entry => entry.connection).map(entry => ({ id: entry.key, models: entry.models.ids, error: entry.models.error }))} />
          : <CliToolDetail row={row} />}
        <ModelsBlock row={row} readOnly={readOnly} />
      </div>
    </details>
  </article>;
}

/**
 * LLM 운영(/admin/models/llm) — 「어떤 LLM을 쓸 수 있고, 얼마나, 어디에 쓰고 있나?」(2026-11-07 승인 시안 PR 2).
 * 연결(서버)과 연결 행이 없는 CLI 도구가 한 줄씩: 모델 · 동시 실행 한도/점유 · 배정된 작업 · 운영 상태와 까닭 · 재실행 대기.
 * 행을 펼치면 기존 연결 폼(saveAiConnectionAction)으로 고치고, 동시 실행 한도는 장비 행 한 곳(saveCapacityDevice)에서만 바꾼다.
 */
export function LlmOpsList({ view, secretBox, readOnly, editId, adding }: { view: LlmOpsView; secretBox: boolean; readOnly: boolean; editId: string | null; adding: boolean }) {
  const { totals } = view;
  const saved = view.rows.filter(row => row.connection).map(row => ({ id: row.key, models: row.models.ids, error: row.models.error }));
  return <div className="stack llm-ops" data-llm-page="llm">
    <div className="llm-toolbar">
      <p className="llm-totals"><span>연결 <b>{fmt(totals.connections)}</b></span><span>CLI 도구 <b>{fmt(totals.cliTools)}</b></span><span>모델 <b>{fmt(totals.models)}</b></span>
        <span>동시 실행 한도 합계 <b>{totals.limitSum === null ? "확인 불가" : fmt(totals.limitSum)}</b></span></p>
      <ObservedAt label="장부 관측" at={view.observedAt} />
    </div>
    {view.errors.map(error => <p key={error} role="alert" className="llm-notice">{error}</p>)}
    <details className="llm-add" id="connection-new" open={adding || undefined}>
      <summary>+ 연결 추가</summary>
      <div className="llm-add-body">
        <p className="llm-empty">API 주소(OpenAI 호환 …/v1)나 CLI 도구를 등록합니다. API 는 저장할 때 /models 로 목록을 바로 읽어 아래에 보입니다.</p>
        <ConnectionForm initial={null} secretBox={secretBox} limit={NEW_LIMIT} cancelHref="/admin/models/llm" readOnly={readOnly} savedModels={saved} />
      </div>
    </details>
    <section className="llm-conn-list" aria-label="LLM 연결과 CLI 도구">
      <div className="llm-conn-head llm-conn-cols" aria-hidden="true"><span>LLM(연결)</span><span>모델</span><span>한도 · 점유</span><span>배정된 작업</span><span>상태</span><span>재실행</span></div>
      {view.rows.map(row => <ConnectionRow key={row.key} row={row} view={view} secretBox={secretBox} readOnly={readOnly} open={editId === row.key} />)}
      {!view.rows.length && <p className="llm-empty">{view.errors.length ? "연결을 읽지 못했습니다." : "아직 연결이 없습니다. 「+ 연결 추가」로 만드세요."}</p>}
    </section>
    <LevelLegend />
    <p className="llm-empty">상태 옆 회색 글자가 까닭입니다(예: 계약 없음 · 키 없음 · 연결 꺼짐 · 서버 응답 없음 · 시간 초과). 실행 쪽이 마지막 틱(30분 안)에 남긴 순위 사정과 장부의 최근 1시간 정산에서 읽습니다.
      한도·점유는 장비 행 기준이라 같은 장비를 쓰는 연결은 같은 수를 보입니다.</p>
  </div>;
}

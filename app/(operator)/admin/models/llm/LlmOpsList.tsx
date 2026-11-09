import Link from "next/link";
import type { ReactNode } from "react";
import type { LlmFix, LlmFixField, LlmOpsLevel, LlmOpsRow, LlmOpsView, LlmTaskChip } from "@/lib/operations/llm-ops-view";
import { llmAllocationHref } from "@/lib/operations/llm-ops-links";
import { MODEL_REQUEST_REVIEW_HREF } from "../ModelCallsPanel";
import { LevelBadge, LevelLegend, ObservedAt } from "../LlmOpsParts";
import { modelPickerModelGroups } from "../model-picker-display";
import { DeleteConnectionButton, HideModelButton, RereadModelsButton } from "../tasks/ConnectionButtons";
import { UnknownRequeueStatus } from "../history/RetryActions";
import { ConnectionForm, type ConnectionLimitField } from "../tasks/ConnectionForm";

const NEW_LIMIT: ConnectionLimitField = { deviceId: "", current: null, expectedVersion: null, policyHash: null, eligible: false, reason: null, sharedWith: [] };
const fmt = (value: number) => value.toLocaleString("ko-KR");
const kst = (at: string | null) => at ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at)) : null;

/**
 * 문제 표시 하나 — 누르면 고치는 곳으로 간다. 문제 글자 뒤에 파란 동작 글자(「— 맞추기 →」)를 붙여 누를 수 있음이 보이게 한다.
 * 고칠 곳이 없으면(엔진 쪽 사정 등) 링크 없이 글자만.
 */
function FixLink({ fix, level, className, title, children }: { fix: LlmFix | null; level?: LlmOpsLevel; className?: string; title?: string; children: ReactNode }) {
  if (!fix) return <span className={className} data-level={level} title={title}>{children}</span>;
  return <Link prefetch={false} href={fix.href} className={`llm-fix${className ? ` ${className}` : ""}`} data-level={level} title={title}>
    {children}<span className="llm-fix-sep"> — </span><span className="llm-fix-action">{fix.label} →</span></Link>;
}

function TaskChip({ chip }: { chip: LlmTaskChip }) {
  // 옛 = 실행 쪽이 읽지 않는 작업의 옛 순위 행(실행 안 함), 실제 = 그 작업의 실제 출처(단계 풀·감사 설정·등록부)
  const rank = chip.source === "record" ? "옛" : chip.source === "current" ? "실제" : chip.rank !== null ? String(chip.rank) : chip.source === "pool" ? "분산" : "설정";
  const title = `${chip.label} · ${chip.source === "record" ? `옛 ${chip.rank}순위 기록 — 실행 쪽이 읽지 않음(작업 배정에서 「기록 지우기」)` : chip.source === "current" ? "실제 출처(단계 풀·감사 설정)"
    : chip.rank !== null ? `${chip.rank}순위` : chip.source === "pool" ? "작업 분산 구성원" : chip.source === "classifier" ? "분류 설정" : "정책 경로·계약"} · ${chip.model}${chip.enabled ? "" : " · 순위 꺼짐"}${chip.paused ? " · 잡 일시중지" : ""}`;
  // 한 작업 = 표의 한 칸(순위 칸 너비 고정 · 이름). 잡 중지 표시는 같은 칸 안에 붙여 다른 칸으로 밀리지 않게 한다.
  return <span className="llm-task">
    <Link prefetch={false} href={chip.href} className="llm-chip" data-source={chip.source} data-off={chip.enabled ? undefined : "true"} data-paused={chip.paused ? "true" : undefined} title={title}>
      <span className="llm-chip-rank">{rank}</span>{chip.label}{chip.paused ? " · 중지" : ""}</Link>
    {chip.fix && <Link prefetch={false} href={chip.fix.href} className="llm-fix llm-fix-chip" data-level="idle" aria-label={`${chip.label} 잡 일시중지 — ${chip.fix.label}`}>
      <span aria-hidden="true">‖</span><span className="llm-fix-action">{chip.fix.label} →</span></Link>}
  </span>;
}

type ModelLine = { label: string; ids: string[]; chips: LlmTaskChip[]; listed: boolean };
/**
 * 연결의 모델 줄(2026-11-08). 같은 모델의 별칭(Supa 두 이름·M1 Gemma 옛·새 이름)은 한 줄로 합치고 칩도 모은다 — 전에는 같은 이름이 두 줄로 나와
 * 한 줄은 「배정 없음」이었다. 순위가 가리키는데 지금 서버 목록에 없는 모델도 줄로 남긴다(칩이 사라지지 않게).
 */
function modelLines(row: LlmOpsRow): ModelLine[] {
  const listed = new Set(row.models.ids);
  const ids = [...row.models.ids, ...Object.keys(row.modelTasks).filter(id => !listed.has(id))];
  const groups = row.connection ? modelPickerModelGroups(row.connection, ids) : ids.map(id => ({ label: id, ids: [id] }));
  return groups.map(group => {
    const seen = new Set<string>();
    const chips = group.ids.flatMap(id => row.modelTasks[id] ?? []).filter(chip => !seen.has(chip.key) && Boolean(seen.add(chip.key)));
    return { label: group.label, ids: group.ids, chips, listed: group.ids.some(id => listed.has(id)) };
  });
}
const listedLines = (row: LlmOpsRow) => modelLines(row).filter(line => line.listed);
/** 화면 이름과 다른 실제 이름(별칭)·목록에 없음을 줄 아래 작게 */
const lineNote = (line: ModelLine) => [line.ids.length > 1 || line.ids[0] !== line.label ? `이름 ${line.ids.join(" · ")}` : null,
  line.listed ? null : "지금 서버 목록에 없음"].filter(Boolean).join(" · ");

function ModelsBlock({ row, readOnly }: { row: LlmOpsRow; readOnly: boolean }) {
  const { connection } = row;
  const read = kst(row.models.readAt);
  const used = row.tasks.some(chip => chip.source === "rank" || chip.source === "pool" || chip.source === "record");
  const lines = modelLines(row), listed = lines.filter(line => line.listed).length;
  return <section className="llm-models" aria-label={`${row.label} 모델 목록`}>
    <h3>{connection?.kind === "api" ? "이 서버의 모델" : "모델"} · {listed}개{read ? ` · ${read} 읽음` : ""}</h3>
    {row.models.error && <p className="llm-notice">마지막 목록 오류: {row.models.error}</p>}
    {lines.length ? <ul>{lines.map(line => { const note = lineNote(line);
      return <li key={line.ids.join("\u0000")} data-model-line={line.ids.join(" ")}><span className="llm-model-name"><code>{line.label}</code>
        {note && <span className="llm-muted llm-model-note">{note}</span>}</span>
      {line.chips.length ? <span className="llm-chips">{line.chips.map(chip => <TaskChip key={chip.key} chip={chip} />)}</span>
        : <span className="llm-model-free"><span className="llm-muted">배정 없음</span>
          {connection && !readOnly && line.listed && <HideModelButton id={connection.id} version={connection.version} models={line.ids} label={line.label} hidden />}</span>}</li>; })}</ul>
      : <p className="llm-empty">{connection?.kind === "api" ? "아직 읽은 모델이 없습니다 — 주소·키를 확인하고 저장하거나 다시 읽으세요." : "적힌 모델이 없습니다."}</p>}
    {connection && (connection.hiddenModels?.length ?? 0) > 0 && <details className="llm-hidden-models">
      <summary>삭제한 모델 {connection.hiddenModels!.length}개 — 다시 추가</summary>
      <ul>{connection.hiddenModels!.map(model => <li key={model}><code>{model}</code>
        {readOnly ? <span className="llm-muted">삭제함</span> : <HideModelButton id={connection.id} version={connection.version} models={[model]} label={model} hidden={false} />}</li>)}</ul>
    </details>}
    <p className="llm-empty">모델 옆 칩은 그 모델을 쓰는 작업과 순위입니다. 누르면 작업 배정으로 이동합니다. 배정 없는 모델은 「삭제」 → 「삭제 확인」으로 이 연결의 목록과
      모든 관리 화면에서 뺍니다(서버 쪽 모델은 그대로). {connection?.kind === "api" ? "서버에 새로 생긴 모델은 「다시 읽기」로 추가됩니다."
        : connection ? "모델 추가·이름 정정은 이 연결의 고치기에서 합니다." : ""}</p>
    {connection && connection.kind === "cli" && !readOnly && <Link prefetch={false} className="button small" href={`/admin/models/llm?edit=${connection.id}#conn-${connection.id}`}>
      모델 추가·정정 →</Link>}
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

/** 이름 아래 한 줄(종류 · 주소 · 버전 · 키). CLI 버전을 모르는 CLI 연결은 그 조각이 버전 칸으로 가는 링크다. */
function ConnectionMeta({ row }: { row: LlmOpsRow }) {
  const version = row.version ? `${row.kind === "cli" ? "" : "버전 "}${row.version}${row.versionSource ? `(${row.versionSource})` : ""}` : row.kind === "cli" ? "CLI 버전 미확인" : null;
  const parts: ReactNode[] = [row.kindText, row.address,
    version && !row.version && row.versionFix ? <FixLink key="version" fix={row.versionFix}>{version}</FixLink> : version, row.keyText].filter(Boolean);
  return <span className="llm-conn-meta">{parts.map((part, index) => <span key={index}>{index > 0 && " · "}{part}</span>)}</span>;
}

function ConnectionRow({ row, view, secretBox, readOnly, open, fix }: { row: LlmOpsRow; view: LlmOpsView; secretBox: boolean; readOnly: boolean; open: boolean;
  fix: LlmFixField | null }) {
  const { capacity, status } = row;
  const lines = listedLines(row), first = lines[0];
  return <article id={row.anchor} className="llm-conn llm-conn-cols" data-source={row.source} data-row={row.key}>
    <div className="llm-conn-grid">
      <div className="llm-cell llm-cell-wide">
        <span className="llm-conn-name">{row.label}</span>
        <ConnectionMeta row={row} />
        {/* 장비 이름은 같은 장비를 쓰는 연결 이름들 — 이 연결 이름과 같으면 다시 적지 않는다. 장비 id 는 title 에만 */}
        {row.connection && row.deviceName && row.deviceName !== row.label
          && <span className="llm-conn-meta" title={`장비 id ${row.connection.deviceId}`}>장비 {row.deviceName}</span>}
        {!row.enabled && <LevelBadge level="idle">꺼짐</LevelBadge>}
      </div>
      <div className="llm-cell"><span className="llm-cell-label">모델</span>
        {first ? <span><code>{first.label}</code>{lines.length > 1 && <span className="llm-muted"> 외 {lines.length - 1}</span>}</span> : <span className="llm-muted">없음</span>}
        <span className="llm-muted">{row.connection?.kind === "api" && row.connection.models ? `${lines.length}개` : row.models.title}</span>
      </div>
      <div className="llm-cell"><span className="llm-cell-label">점유 / 한도</span>
        {capacity ? <>
          <span className="llm-cap" title="점유(예약+실행 중) / 장비 행 한도">{capacity.text}</span>
          {capacity.mismatch ? <FixLink fix={capacity.fix} level="warn" className="llm-flag"
            title="연결에 저장된 옛 칸 수가 장비 행 한도(실제로 쓰는 값)와 다릅니다. 연결 폼을 저장하면 같은 값으로 맞춰집니다.">
            <span aria-hidden="true">▲ </span>{capacity.note}</FixLink>
            : capacity.note && <FixLink fix={capacity.fix} className="llm-muted">{capacity.note}</FixLink>}
          {capacity.waiting ? <span className="llm-muted">대기 {fmt(capacity.waiting)}</span> : null}
          {capacity.sharedWith.length > 0 && <span className="llm-muted">함께 씀: {capacity.sharedWith.join(" · ")}</span>}
          {capacity.source === "table" && <Link prefetch={false} className="llm-link" href={llmAllocationHref(capacity.deviceId)}>작업별 칸 배분 →</Link>}
        </> : <span className="llm-muted">장비 없음</span>}
      </div>
      <div className="llm-cell llm-cell-wide"><span className="llm-cell-label">배정된 작업</span>
        {row.tasks.length ? <span className="llm-chips">{row.tasks.map(chip => <TaskChip key={chip.key} chip={chip} />)}</span> : <span className="llm-muted">배정 없음</span>}
      </div>
      <div className="llm-cell" data-status={status.level}><span className="llm-cell-label">상태</span>
        {/* 「미확정 있음」은 누르면 이 연결(장비)·CLI 도구의 결과 미확정을 그 자리에서 다시 대기열에 넣는다 — 결과 한 줄도 이 칸에 */}
        <UnknownRequeueStatus badge={<LevelBadge level={status.level} title={status.detail ?? undefined}>{status.text}</LevelBadge>}
          unknownBadge={status.text === "미확정 있음"} count={row.retry} groupId={row.retryScope.groupId} provider={row.retryScope.provider} readOnly={readOnly}>
          {status.reasons.length > 0 && <span className="llm-conn-status-reason">{status.reasons.map((reason, index) =>
            <FixLink key={index} fix={reason.fix} className="llm-reason">{reason.text}</FixLink>)}</span>}
        </UnknownRequeueStatus>
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
          cancelHref="/admin/models/llm" readOnly={readOnly} fix={open ? fix : null}
          savedModels={view.rows.filter(entry => entry.connection).map(entry => ({ id: entry.key, models: entry.models.ids, error: entry.models.error }))} />
          : <CliToolDetail row={row} />}
        <ModelsBlock row={row} readOnly={readOnly} />
      </div>
    </details>
  </article>;
}

/**
 * LLM 운영(/admin/models/llm) — 「어떤 LLM을 쓸 수 있고, 얼마나, 어디에 쓰고 있나?」(2026-11-07 승인 시안 PR 2).
 * 연결(서버)과 연결 행이 없는 CLI 도구가 한 줄씩: 모델 · 점유 / 동시 실행 한도 · 배정된 작업 · 운영 상태와 까닭 · 재실행 대기.
 * 문제 표시(한도 불일치·까닭·잡 중지 등)는 누르면 고치는 곳으로 간다 — 연결 폼의 그 칸(?edit=…&fix=…), 작업 배정의 그 줄, 계약·기록·잡 상태.
 * 행을 펼치면 기존 연결 폼(saveAiConnectionAction)으로 고치고, 동시 실행 한도는 장비 행 한 곳(saveCapacityDevice)에서만 바꾼다.
 */
export function LlmOpsList({ view, secretBox, readOnly, editId, fix = null, adding }: { view: LlmOpsView; secretBox: boolean; readOnly: boolean; editId: string | null;
  fix?: LlmFixField | null; adding: boolean }) {
  const { totals } = view;
  const saved = view.rows.filter(row => row.connection).map(row => ({ id: row.key, models: row.models.ids, error: row.models.error }));
  return <div className="stack llm-ops" data-llm-page="llm">
    <div className="llm-toolbar">
      <p className="llm-totals"><span>연결 <b>{fmt(totals.connections)}</b></span><span>CLI 도구 <b>{fmt(totals.cliTools)}</b></span><span>모델 <b>{fmt(view.rows.reduce((total, row) => total + listedLines(row).length, 0))}</b></span>
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
      <div className="llm-conn-head llm-conn-cols" aria-hidden="true"><span>LLM(연결)</span><span>모델</span><span>점유 / 한도</span><span>배정된 작업</span><span>상태</span><span>재실행</span></div>
      {view.rows.map(row => <ConnectionRow key={row.key} row={row} view={view} secretBox={secretBox} readOnly={readOnly} open={editId === row.key} fix={fix} />)}
      {!view.rows.length && <p className="llm-empty">{view.errors.length ? "연결을 읽지 못했습니다." : "아직 연결이 없습니다. 「+ 연결 추가」로 만드세요."}</p>}
    </section>
    <LevelLegend />
    <p className="llm-empty">상태 아래 글자가 까닭입니다(예: 계약 없음 · 키 없음 · 연결 꺼짐 · 서버 응답 없음 · 시간 초과). 실행 쪽이 마지막 틱(30분 안)에 남긴 순위 사정과 장부의 최근 1시간 정산에서 읽습니다.
      파란 「— … →」가 붙은 표시는 누르면 고치는 곳으로 갑니다. 점유 / 한도는 장비 행 기준이라 같은 장비를 쓰는 연결은 같은 수를 보입니다.</p>
  </div>;
}

"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { DeskChange, OperatorDesk } from "@/lib/operations/operator-desk-model";

/**
 * 운영자 책상 — 전체 흐름 한 장의 1인 관리자 필수 칸. 읽기만 그린다(조치는 각 줄의 링크가 보내는 화면에서).
 * 위 「할 일」(경보·사람 판단·자리 비운 사이·모두 보기)은 "지금 내가 할 것", 아래 줄(최근 바뀐 설정·장비·점검 창)은 "왜 이렇게 됐나"다.
 * 못 읽은 칸은 0 이 아니라 "읽지 못함"으로 쓴다.
 */
const n = (value: number) => value.toLocaleString("ko-KR");
const KST = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const kstShort = (iso: string) => KST.format(new Date(iso)).replace(/‎/g, "");
/** 기준 시각(서버가 잰 때)에서 얼마 전 — 서버·브라우저가 같은 글자를 내게 Date.now() 를 쓰지 않는다 */
export function agoText(iso: string | null, reference: string): string {
  if (!iso) return "—";
  const minutes = Math.max(0, (Date.parse(reference) - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${Math.floor(minutes)}분 전`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.floor(hours)}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

function Unread({ what }: { what: string }) {
  return <p className="dk-unread" role="status">{what}을(를) 읽지 못했습니다 — 0건이 아닙니다. 다음 자동 갱신에서 다시 읽습니다.</p>;
}

type PanelTone = "bad" | "warn" | "ok" | "mute";
/** countTone — 머리 알약의 색이 칸 테두리와 다를 때(점검 창: 접수는 OPEN 인데 역할 lease 가 경보) */
function Panel({ id, title, count, tone, countTone, children, more }: { id: string; title: string; count?: string | null; tone?: PanelTone; countTone?: PanelTone;
  children: React.ReactNode; more?: { href: string; label: string } }) {
  return (
    <section className="dk-panel" aria-labelledby={id} data-tone={tone}>
      <header className="dk-head">
        <h2 id={id}>{title}</h2>
        {count && <span className="dk-count" data-tone={countTone ?? tone}>{count}</span>}
      </header>
      {children}
      {more && <p className="dk-more"><Link href={more.href} prefetch={false}>{more.label} →</Link></p>}
    </section>
  );
}

/** 숫자 칸의 "가장 오래 N" — 기준 시각에서 잰다 */
const oldest = (iso: string | null, reference: string) => iso ? `가장 오래 ${agoText(iso, reference).replace(/ 전$/, "")}` : null;

/**
 * 할 일 표의 한 줄 — 경보(운영센터 buildActions)와 사람 판단(오늘 할 일 칸)을 같은 열에 놓는다(2026-11-04 4차: 「할 일은 표로」).
 * severity 0 = 긴급, 1 = 주의. 표는 심각도 순(같으면 경보 먼저, 그다음 원래 순서)이다.
 */
export type TodoRow = { key: string; kind: "alert" | "decision"; severity: 0 | 1; title: string; count: string; age: string; href: string | null; action: string };
export const TODO_HEAD_LIMIT = 4;

export function todoRows(desk: OperatorDesk): TodoRow[] {
  const alerts = (desk.alerts?.items ?? []).slice(0, TODO_HEAD_LIMIT).map((item): TodoRow => ({ key: `alert:${item.key}`, kind: "alert",
    severity: item.tone === "critical" ? 0 : 1, title: item.title, count: item.count || "—", age: "—", href: item.href, action: item.actionLabel ?? "열기" }));
  const decisions = (desk.decisions?.items ?? []).slice(0, TODO_HEAD_LIMIT).map((item): TodoRow => ({ key: `decision:${item.key}`, kind: "decision",
    severity: item.tone === "critical" ? 0 : 1, title: item.title, count: `${n(item.count)}건`, age: oldest(item.oldestAt, desk.measuredAt) ?? "—", href: item.href, action: item.action }));
  return [...alerts, ...decisions].map((row, index) => ({ row, index })).sort((a, b) => a.row.severity - b.row.severity
    || (a.row.kind === b.row.kind ? 0 : a.row.kind === "alert" ? -1 : 1) || a.index - b.index).map(({ row }) => row);
}

const SEVERITY_TEXT = ["긴급", "주의"] as const;
const KIND_TEXT: Record<TodoRow["kind"], string> = { alert: "경보", decision: "사람 판단" };

/** 열 너비를 고정한 할 일 표 — 구분 | 심각도 | 항목 | 건수 | 가장 오래됨/변화 | 바로 가기. 숫자 열은 오른쪽 정렬·같은 폭 숫자 */
function TodoTable({ desk }: { desk: OperatorDesk }) {
  const rows = todoRows(desk);
  const alerts = desk.alerts, decisions = desk.decisions;
  const rest = [
    alerts && alerts.items.length > TODO_HEAD_LIMIT ? { key: "alerts", text: `경보 외 ${n(alerts.items.length - TODO_HEAD_LIMIT)}건`, href: "/admin/status", label: "운영센터에서 모두 보기" } : null,
    decisions && decisions.items.length > TODO_HEAD_LIMIT ? { key: "decisions", text: `사람 판단 외 ${n(decisions.items.length - TODO_HEAD_LIMIT)}칸`, href: "#todo-all", label: "모두 보기" } : null,
    decisions && decisions.failed > 0 ? { key: "failed", text: `못 읽은 칸 ${n(decisions.failed)}개`, href: "#todo-all", label: "모두 보기에서 확인" } : null,
  ].filter((row): row is { key: string; text: string; href: string; label: string } => !!row);
  return (
    <div className="dk-table-wrap">
      <table className="dk-table dk-todo-table">
        <colgroup><col className="dk-c-kind" /><col className="dk-c-sev" /><col /><col className="dk-c-num" /><col className="dk-c-age" /><col className="dk-c-go" /></colgroup>
        <thead><tr><th scope="col">구분</th><th scope="col">심각도</th><th scope="col">항목</th><th scope="col" className="dk-r">건수</th>
          <th scope="col" className="dk-r">가장 오래됨/변화</th><th scope="col">바로 가기</th></tr></thead>
        <tbody>
          {!alerts && <tr data-tone="mute"><td>경보</td><td>—</td><td colSpan={4}><Unread what="경보" /></td></tr>}
          {!decisions && <tr data-tone="mute"><td>사람 판단</td><td>—</td><td colSpan={4}><Unread what="결정할 일" /></td></tr>}
          {rows.map((row) => (
            <tr key={row.key} data-tone={row.severity === 0 ? "bad" : "warn"} data-kind={row.kind}>
              <td className="dk-kind">{KIND_TEXT[row.kind]}</td>
              <td><span className="dk-sev" data-tone={row.severity === 0 ? "bad" : "warn"}><span aria-hidden="true">{row.severity === 0 ? "■" : "▲"}</span>{SEVERITY_TEXT[row.severity]}</span></td>
              <th scope="row" className="dk-item">{row.title}</th>
              <td className="dk-r dk-n">{row.count}</td>
              <td className="dk-r dk-age">{row.age}</td>
              <td>{row.href ? <Link className="dk-go" href={row.href} prefetch={false} aria-label={`${row.title} — ${row.action}`}>{row.action} →</Link> : "—"}</td>
            </tr>))}
          {alerts && decisions && rows.length === 0 && <tr data-tone="ok"><td colSpan={6} className="dk-empty">지금 조치할 경보도, 사람이 판단할 일도 없습니다.</td></tr>}
        </tbody>
        {rest.length > 0 && <tfoot><tr><td colSpan={6} className="dk-rest">{rest.map((row, index) => <span key={row.key}>{index > 0 && " · "}{row.text} — {row.href.startsWith("#")
          ? <a href={row.href}>{row.label}</a> : <Link href={row.href} prefetch={false}>{row.label}</Link>}</span>)}</td></tr></tfoot>}
      </table>
    </div>
  );
}

/** 자리 비운 사이 — 표 위 요약 한 줄. 내가 마지막으로 작업 로그에 남긴 때부터(없으면 72시간) 발행·새 보류·다른 사람(도구)의 설정 변경 수 */
function AwayLine({ desk }: { desk: OperatorDesk }) {
  const away = desk.away;
  if (!away) return <Unread what="부재 중 기록" />;
  const others = away.othersChanges.length;
  return (
    <p className="dk-away" data-tone={others ? "warn" : undefined}>
      <span className="dk-away-k" title={away.fromMyLastAction ? `${away.myLogin}이(가) 마지막으로 작업 로그에 남긴 때부터` : "내 작업 기록이 72시간 안에 없어 지난 72시간"}>
        자리 비운 사이 · {kstShort(away.since)} 이후</span>
      <span>발행 <b>{away.published === null ? "—" : `${n(away.published)}건`}</b></span>
      <span>새 보류 <b>{away.newHolds === null ? "—" : `${n(away.newHolds)}건`}</b></span>
      <span>다른 사람·도구의 설정 변경 <b>{n(others)}{others >= 6 ? "+" : ""}건</b>{others > 0 && <> — <a href="#dk-changes">최근 바뀐 설정 ↓</a></>}</span>
    </p>
  );
}

/**
 * 「모두 보기」 — 예전 오늘 할 일 화면(/admin/inbox)의 내용 그대로: 일이 있거나 못 읽은 칸(급한 차례), 칸마다 오래된 다섯 줄, 할 일 없는 칸.
 * 4차: 칸마다 따로 그리던 줄을 열이 맞는 표 하나로 — 칸은 tbody 하나(머리 줄 + 설명 줄 + 상세 줄), 열은 제품·항목 | 사유 | 기다린 시간.
 */
function TodoDrawer({ desk, decisions }: { desk: OperatorDesk; decisions: NonNullable<OperatorDesk["decisions"]> }) {
  const drawer = useRef<HTMLDetailsElement>(null);
  // /admin/inbox 가 #todo 로 보낸다 — 옛 주소로 온 사람에게는 서랍을 열어 둔다
  useEffect(() => { if (drawer.current && ["#todo", "#todo-all"].includes(window.location.hash)) drawer.current.open = true; }, []);
  return (
    <details className="dk-all" id="todo-all" ref={drawer}>
      <summary>모두 보기 <small>남은 일 {n(decisions.remaining)}건{decisions.failed > 0 ? " 이상" : ""} · 최근 24시간 처리 {decisions.done === null ? "?" : n(decisions.done)}건</small></summary>
      {decisions.sections.length === 0 ? <p className="dk-empty">오늘 할 일이 없습니다.</p> : (
        <div className="dk-table-wrap">
          <table className="dk-table dk-all-table">
            <colgroup><col className="dk-c-name" /><col /><col className="dk-c-age" /></colgroup>
            <thead><tr><th scope="col">제품·항목</th><th scope="col">사유</th><th scope="col" className="dk-r">기다린 시간</th></tr></thead>
            {decisions.sections.map((section) => {
              const tone = section.count === null ? "mute" : section.tone === "critical" ? "bad" : "warn";
              return (
                <tbody key={section.key} className="dk-all-sec" data-tone={tone}>
                  <tr className="dk-all-h">
                    <th scope="rowgroup" colSpan={3}>
                      <span className="dk-all-hrow">
                        <span className="dk-all-title">{section.title}</span>
                        <span className="dk-all-n">{section.count === null ? "불러오지 못함" : `${n(section.count)}건`}</span>
                        {section.rows[0]?.since && <small>{oldest(section.rows[0].since, desk.measuredAt)}</small>}
                        {section.note && <small>{section.note}</small>}
                        <Link className="dk-go" href={section.href} prefetch={false}>{section.action}{section.count !== null && section.count > section.rows.length ? ` — ${n(section.count)}건 모두` : ""} →</Link>
                      </span>
                    </th>
                  </tr>
                  <tr className="dk-all-hint"><td colSpan={3}>{section.hint}</td></tr>
                  {section.rows.map((row) => (
                    <tr key={row.id} className="dk-all-row"><td className="dk-all-name">{row.name}</td><td>{row.why}</td><td className="dk-r dk-age">{agoText(row.since, desk.measuredAt)}</td></tr>))}
                </tbody>
              );
            })}
          </table>
        </div>)}
      {decisions.clear.length > 0 && <p className="dk-sub">할 일 없음 — {decisions.clear.map((section, index) => (
        <span key={section.key}>{index > 0 && " · "}<Link href={section.href} prefetch={false}>{section.title}</Link></span>))}</p>}
    </details>
  );
}

/**
 * 할 일 — 예전 받은함·결정함·부재 중 세 칸을 한 칸으로(2026-11-03 3차). 2026-11-04 4차: 경보와 사람 판단을 열이 고정된 표 하나로 합쳤다.
 * 위에 자리 비운 사이 요약 한 줄, 가운데 할 일 표(심각도 순), 아래 「모두 보기」 서랍이 예전 오늘 할 일 화면을 대신한다.
 */
export function TodoPanel({ desk }: { desk: OperatorDesk }) {
  const alerts = desk.alerts, decisions = desk.decisions;
  const urgent = alerts?.critical ?? 0;
  const summary = [urgent ? `긴급 ${n(urgent)}` : null, decisions ? `사람 판단 ${n(decisions.remaining)}건` : null].filter(Boolean).join(" · ");
  return (
    <section className="dk-todo" id="todo" aria-labelledby="dk-todo-title">
      <header className="dk-head">
        <h2 id="dk-todo-title">할 일</h2>
        {summary && <span className="dk-count" data-tone={urgent ? "bad" : decisions?.remaining ? "warn" : "ok"}>{summary}</span>}
        <Link className="dk-head-link" href="/admin/status" prefetch={false}>운영센터 →</Link>
      </header>
      <AwayLine desk={desk} />
      <TodoTable desk={desk} />
      {decisions && <TodoDrawer desk={desk} decisions={decisions} />}
    </section>
  );
}

function ChangeLine({ change, reference }: { change: DeskChange; reference: string }) {
  return (
    <li data-tone={change.ok ? undefined : "bad"}>
      <span className="dk-when" title={kstShort(change.at)}>{agoText(change.at, reference)}</span>
      <span className="dk-line"><b>{change.label}</b><small> · {change.actor}{change.target ? ` · ${change.target}` : ""}{change.ok ? "" : " · 실패"}</small>
        <span className="dk-undo">되돌리기: {change.undo.href ? <Link href={change.undo.href} prefetch={false}>{change.undo.text}</Link> : change.undo.text}</span></span>
    </li>
  );
}

export function ChangesPanel({ desk }: { desk: OperatorDesk }) {
  return (
    // 작업 로그는 지울 수 없다 — 되돌리기는 줄마다 적힌 화면에서 이전 값(작업 로그의 전·후)으로 다시 저장하는 것이다
    <Panel id="dk-changes" title="최근 바뀐 설정" more={{ href: "/admin/activity?group=settings", label: "작업 로그 · 설정·연결" }} tone="mute"
      count={desk.changes ? `${n(desk.changes.length)}줄` : null}>
      {!desk.changes ? <Unread what="작업 로그" /> : desk.changes.length === 0 ? <p className="dk-empty">설정·모델·작업 제어 변경 기록이 없습니다.</p> : (
        <ul className="dk-list dk-changes">{desk.changes.slice(0, 5).map((change) => <ChangeLine key={change.id} change={change} reference={desk.measuredAt} />)}</ul>)}
    </Panel>
  );
}

const LEDGER: Record<string, { text: string; tone: "ok" | "warn" | "bad" | "mute" }> = {
  ok: { text: "장부 정상", tone: "ok" }, review: { text: "검토 대기", tone: "warn" }, alarm: { text: "장부 경보", tone: "bad" }, unknown: { text: "장부 미확인", tone: "mute" },
};
const minutes = (seconds: number) => seconds >= 3600 ? `${Math.floor(seconds / 3600)}시간` : `${Math.floor(seconds / 60)}분`;

export function EquipmentPanel({ desk }: { desk: OperatorDesk }) {
  const equipment = desk.equipment;
  const ledger = equipment ? LEDGER[equipment.ledger.status] : LEDGER.unknown;
  return (
    <Panel id="dk-equipment" title="장비·모델 서버" tone={ledger.tone} count={ledger.text} more={{ href: "/admin/models", label: "LLM 운영" }}>
      {!equipment ? <Unread what="모델 장부" /> : <>
        {equipment.ledger.reasons.length > 0 && <ul className="dk-reasons">{equipment.ledger.reasons.map((reason) => <li key={reason}>
          <b>{reason}</b>{reason === "dispatch_stuck" ? ` · 전송 ${minutes(equipment.ledger.stuckThresholdSeconds)} 넘은 호출 ${n(equipment.ledger.stuckDispatched)}건`
            : reason === "review_backlog" ? ` · 미확정 ${n(equipment.ledger.reviewCount)}건`
            : ` · 가장 오래 ${minutes(equipment.ledger.oldestAgeSeconds ?? 0)}`}
        </li>)}</ul>}
        <ul className="dk-devices">{equipment.devices.slice(0, 6).map((device) => {
          const ratio = device.limit ? Math.min(1, device.held / device.limit) : 0;
          return <li key={device.id} data-tone={device.stuck ? "bad" : device.limit && device.held >= device.limit ? "warn" : undefined}>
            <span className="dk-dev-name" title={device.id}>{device.name}<small>{device.name !== device.id ? device.id : ""}</small></span>
            <span className="dk-meter" aria-hidden="true"><span style={{ width: `${Math.round(ratio * 100)}%` }} /></span>
            <span className="dk-dev-num">{n(device.held)}/{device.limit === null ? "?" : n(device.limit)}칸{device.lending ? " · 빌림" : ""}</span>
            {device.stuck > 0 && <span className="dk-stuck">멈춘 전송 {n(device.stuck)}</span>}
          </li>;
        })}</ul>
        {equipment.servers.length > 0 && <p className="dk-sub">{equipment.servers.map((server) => `${server.name} ${server.ok ? "응답" : `끊김(${server.error ?? "오류"})`}`).join(" · ")}</p>}
      </>}
    </Panel>
  );
}

const ADMISSION: Record<string, { text: string; tone: "ok" | "warn" | "mute"; hint: string }> = {
  open: { text: "OPEN · 접수 중", tone: "ok", hint: "새 모델 호출을 받습니다" },
  draining: { text: "DRAIN · 점검 창", tone: "warn", hint: "새 모델 호출을 받지 않고 진행 중인 것만 끝냅니다 — 배포·장비 점검 중" },
  disabled: { text: "DISABLED · 꺼짐", tone: "mute", hint: "모델 용량 장부를 쓰지 않습니다" },
};

export function WindowPanel({ desk }: { desk: OperatorDesk }) {
  const window = desk.window;
  const admission = window?.admission ? ADMISSION[window.admission] : null;
  const trouble = window ? window.roles.filter((role) => !role.ok) : [];
  return (
    <Panel id="dk-window" title="배포·점검 창" tone={!window ? "mute" : trouble.length || window.schedulerAlarm ? "bad" : admission?.tone ?? "mute"}
      count={admission?.text ?? (window ? "접수 미확인" : null)} countTone={admission?.tone ?? "mute"} more={{ href: "/admin/models#admission", label: "접수 바꾸기(LLM 운영)" }}>
      {!window ? <Unread what="점검 창" /> : <>
        <p className="dk-sub">{admission ? admission.hint : "모델 접수 모드를 읽지 못했습니다"}{window.admissionSince ? ` · ${kstShort(window.admissionSince)}부터` : ""}</p>
        <ul className="dk-roles">{window.roles.map((role) => (
          <li key={role.role} data-tone={role.ok ? "ok" : "bad"}>
            <span aria-hidden="true">{role.ok ? "●" : "■"}</span><b>{role.role}</b> {role.host ?? "—"} · {role.text}
          </li>))}
          {window.schedulerAlarm && <li data-tone="bad"><span aria-hidden="true">■</span><b>scheduler</b> 살아 있는 복제본 부족</li>}
        </ul>
        {trouble.some((role) => role.reason === "standby_active") && <p className="dk-sub dk-warn">예비(mini)가 일하는 중 — 예비는 스스로 양보하지 않습니다. 주가 돌아왔으면 runbook 대로 예비를 잠시 내립니다.</p>}
      </>}
    </Panel>
  );
}

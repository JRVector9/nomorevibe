"use client";

import Link from "next/link";
import { useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ageText, PHASES, TONE_LABELS, type BeltTone, type Conveyor, type HumanBox, type Station } from "@/lib/operations/conveyor-model";
import type { LlmStationKey, StationLlm, TaskLlm } from "@/lib/operations/conveyor-llm";
import { flowRankLinesFor, type FlowRankEditor } from "@/lib/operations/flow-rank-editor";
import { PUBLIC_TRANSLATION_JOBS, stationResponse, STATION_JOBS, type ResponseStep } from "@/lib/operations/flow-response";
import type { OperatorDesk } from "@/lib/operations/operator-desk-model";
import { JobControl } from "../status/JobControl";
import { ChangesPanel, EquipmentPanel, kstShort, TodoPanel, WindowPanel } from "./OperatorDesk";
import { RankDrawer } from "./RankDrawer";

/**
 * 전체 흐름 — 발행 전 과정 한 장(/admin/flow). 2026-11-02 2차: 병목 판정 + 장애 대응 + 1인 관리자 필수 칸.
 *
 * 위에서 아래로 "지금 무엇이 막혔나 → 실시간 전체 흐름 → 내가 할 일 → 선택한 칸의 조치 → 운영 관측" 순서다.
 * 2026-11-03 3차(단순화): 정상인 칸은 조용히(색 없음), 문제가 있는 칸만 색을 쓴다. 할 일은 한 칸(TodoPanel)이고 오늘 할 일 화면을 대신한다.
 * 2026-11-04 4차: 할 일은 열이 고정된 표, 칸 자세히는 모든 칸이 같은 다섯 섹션(상태·모델·처리량·보류·바로 가기), 장애 대응은 먼저 볼 것 + 조치 표.
 * 칸(station)은 벨트 위에 놓이고, 벨트의 움직임이 그 칸의 지금 상태다: 흐름은 움직이고(1시간 처리량이 많을수록 빠름),
 * 쌓임은 짐이 촘촘하고, 막힘은 멈춘 채 빨갛게 쌓인다. 색만으로 뜻을 전하지 않는다 — 칸마다 아이콘과 상태 글자가 함께 있다.
 * 판이 좁으면(컨테이너 1100px 미만) 벨트를 두 줄(탐색·검수 5칸 / 프로필~공개 3칸)로 접는다 — 옆으로 밀어 숨기지 않는다.
 * 공개 완료와 공개 후 검색·번역을 분리한다. 실행 잡 관측과 모델 실행 호출은 같은 수가 아니다.
 * 칸을 누르면 아래에 자세히와 장애 대응이 열린다. 이 화면이 바꾸는 것은 작업 멈춤·재개(운영센터와 같은 폼, 사유 필수) 하나뿐이고,
 * 나머지 조치는 그 일을 하는 기존 화면으로 보낸다(lib/operations/flow-response.ts).
 */
type Selected = Station["key"] | "human";

const n = (value: number) => value.toLocaleString("ko-KR");
const num = (value: number | null | undefined, unit = "") => value === null || value === undefined ? "—" : `${n(value)}${unit}`;
const ICON: Record<BeltTone, string> = { flow: "▶", slow: "▲", jam: "■", stop: "Ⅱ", idle: "○", unknown: "?" };

/** 벨트 속도 — 1시간 처리량이 많을수록 짧은 주기(빠름). 없으면 멈춘다 */
function beltSeconds(perHour: number | null): number | null {
  if (!perHour || perHour <= 0) return null;
  return Math.max(0.4, Math.min(3.2, 3.2 - Math.log10(perHour + 1) * 0.9));
}

const kstHour = (iso: string) => new Intl.DateTimeFormat("ko-KR", { hour: "numeric", hour12: false, timeZone: "Asia/Seoul" }).format(new Date(iso));
const kstClock = (iso: string) => new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Seoul" }).format(new Date(iso));

export function ToneBadge({ tone, text }: { tone: BeltTone; text?: string }) {
  return <span className="cv-badge" data-tone={tone}><span aria-hidden="true">{ICON[tone]}</span>{text ?? TONE_LABELS[tone]}</span>;
}

/** 24시간 선 — 한 계열이라 범례 없이 제목이 이름이다. 마우스·키보드로 시간마다 값을 읽는다(값은 표 보기에도 있다) */
export function Spark({ values, hours, unit, label, large = false }: {
  values: number[]; hours: string[] | null; unit: string; label: string; large?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = large ? 640 : 120; const height = large ? 140 : 30; const pad = large ? 22 : 2;
  const peak = Math.max(0, ...values);
  const max = Math.max(1, peak);
  const x = (index: number) => pad + (index * (width - pad * 2)) / Math.max(1, values.length - 1);
  const y = (value: number) => height - (large ? 18 : 2) - (value / max) * (height - (large ? 30 : 4));
  const line = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join("");
  const area = `${line}L${x(values.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const pick = (event: ReactPointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / Math.max(1, box.width);
    setHover(Math.max(0, Math.min(values.length - 1, Math.round(ratio * (values.length - 1)))));
  };
  const at = hover ?? null;
  const tip = at !== null ? `${hours?.[at] ? kstHour(hours[at]) : `${values.length - at}시간 전`} · ${n(values[at])}${unit}` : null;
  return (
    <div className={large ? "cv-chart" : "cv-spark"}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label} 24시간 시간별 — 최대 ${n(peak)}${unit}, 마지막 시간 ${n(values.at(-1) ?? 0)}${unit}`}
        preserveAspectRatio="none">
        {large && <>
          <line className="cv-axis" x1={pad} x2={width - pad} y1={y(0)} y2={y(0)} />
          <line className="cv-grid" x1={pad} x2={width - pad} y1={y(max)} y2={y(max)} />
          <text className="cv-tick" x={pad} y={y(max) - 4}>{peak === 0 ? `24시간 동안 0${unit}` : `최대 ${n(peak)}${unit}`}</text>
          {hours && [0, 6, 12, 18, hours.length - 1].filter((index) => index < hours.length).map((index) =>
            <text key={index} className="cv-tick" x={x(index)} y={height - 3} textAnchor={index === 0 ? "start" : index === hours.length - 1 ? "end" : "middle"}>{kstHour(hours[index])}</text>)}
        </>}
        <path className="cv-area" d={area} />
        <path className="cv-line" d={line} vectorEffect="non-scaling-stroke" />
        {at !== null && <>
          <line className="cv-cross" x1={x(at)} x2={x(at)} y1={pad / 2} y2={y(0)} vectorEffect="non-scaling-stroke" />
          <circle className="cv-dot" cx={x(at)} cy={y(values[at])} r={large ? 4 : 2.5} />
        </>}
        <rect className="cv-hit" x={0} y={0} width={width} height={height} onPointerMove={pick} onPointerLeave={() => setHover(null)} />
      </svg>
      {tip && <span className="cv-tip" role="status">{tip}</span>}
    </div>
  );
}

/** 작업 멈춤·재개에 쓰는 작업 상태 — 페이지가 읽어 넘긴다. csrf 가 없으면(AUTH_SECRET 없음) 보기만 한다 */
export type FlowJobState = { paused: boolean; notBefore: string | null; version: number; lastSuccessAt: string | null; lastError: boolean;
  /** Stored job timestamps are observations, not a count of active model calls. */
  lastRunAt?: string | null; workerSeenAt?: string | null; runtimeLabel?: string; execution?: "locked" | "stale" | "none";
};
export type FlowControls = { measuredAt?: string; jobs: Record<string, FlowJobState>; csrf: { token: string; expiresAt: number } | null };

/** 모델 줄에서 /admin/models/tasks 로 — 순위를 바꾸는 길은 그 화면 하나뿐이다(이 화면은 읽기만 한다) */
const TASKS_HREF = "/admin/models/tasks#tasks";

const STATE_TEXT: Record<TaskLlm["state"], string> = {
  ok: "최근 1시간 · 설정 1순위 사용", fallback: "순위가 넘어감", other: "설정과 다름", none: "모델 없음 — 멈춤", stuck: "쓸 수 있는 순위 없음 — 멈춤",
  idle: "최근 1시간 호출 없음 · 설정값", set_only: "설정값",
};

/** 카드 맨 아래, 모든 칸이 같은 자리·같은 모양 — LLM 이름표 + 모델 + 어디서·얼마나(한 줄). 모델이 없는 칸도 같은 모양으로 답한다 */
function LlmLine({ llm }: { llm: StationLlm | null }) {
  if (!llm) return <span className="cv-llm" data-llm="unknown"><span className="cv-llm-k">LLM</span><b className="cv-llm-m">확인 못함</b><small className="cv-llm-w">모델 순위를 읽지 못함</small></span>;
  if (llm.kind === "none") return <span className="cv-llm" data-llm="none"><span className="cv-llm-k">LLM</span><b className="cv-llm-m">LLM 없음 · {llm.short}</b><small className="cv-llm-w">모델을 부르지 않음</small></span>;
  if (llm.kind === "unknown") return <span className="cv-llm" data-llm="unknown"><span className="cv-llm-k">LLM</span><b className="cv-llm-m">확인 못함</b><small className="cv-llm-w">{llm.why}</small></span>;
  const head = llm.head.head;
  const tone = llm.flag?.tone ?? "ok";
  const usage = head?.source === "used" ? `최근 1시간 ${n(head.count ?? 0)}건` : llm.head.state === "none" ? "작업 ↔ AI 모델에서 채우기" : STATE_TEXT[llm.head.state];
  return (
    <span className="cv-llm" data-llm={tone} data-state={llm.head.state}>
      <span className="cv-llm-k">LLM{llm.flag && <em className="cv-llm-flag" data-tone={llm.flag.tone}><span aria-hidden="true">{llm.flag.tone === "bad" ? "■" : "▲"}</span> {llm.flag.text}</em>}</span>
      <b className="cv-llm-m">{head ? head.model : "모델 없음"}</b>
      <small className="cv-llm-w">{head ? head.where : "순위 비어 있음"}{llm.more > 0 ? ` · 외 ${llm.more}` : ""} · {usage}</small>
    </span>
  );
}

function rankChain(task: TaskLlm): string {
  return task.slots.filter((slot) => slot.ranks.length).map((slot) =>
    `${slot.label ? `${slot.label}: ` : ""}${slot.ranks.map((rank) => `${rank.rank}순위 ${rank.connection} · ${rank.model}${rank.problem ? ` (${rank.problem})` : ""}`).join(" → ")}`).join(" / ");
}

/** 실제(최근 1시간 장부) 한 줄 */
function usedText(task: TaskLlm): string {
  if (task.used === null) return task.usedWhy === "no_ledger" ? "기록 없음 — 용량 장부를 거치지 않는 작업" : "확인 못함 — 모델 장부를 읽지 못함";
  if (task.used.length === 0) return "최근 1시간 호출 없음";
  return task.used.map((row) => `${row.text} ${n(row.count)}건${row.rank ? ` (${row.rank}순위)` : " (순위에 없음)"}`).join(" · ");
}

/**
 * 자세히 ② 지금 쓰는 모델 — 작업마다 같은 틀: 작업 이름·상태 / 설정(1·2·3순위) / 실제(최근 1시간 장부). 라벨 열 폭은 자세히 전체와 같다(--cv-k).
 * 경고 문장은 ① 상태에 한 번만 쓴다(4차: 위 빨간 상자와 모델 상자의 노란 상자에 같은 경고가 두 번 나왔다) — 여기서는 상태 이름표만 둔다.
 * shown 은 ① 상태에 이미 쓴 문장 — 같은 뜻의 작업 설명(note)을 다시 쓰지 않는다.
 */
function LlmDetail({ llm, shown }: { llm: StationLlm | null; shown: string[] }) {
  if (!llm) return <p className="cv-sec-text">모델 순위를 읽지 못했습니다 — 다음 갱신에서 다시 읽습니다.</p>;
  if (llm.kind === "none") return <p className="cv-sec-text"><b>LLM 없음 · {llm.short}</b> — {llm.why}</p>;
  if (llm.kind === "unknown") return <p className="cv-sec-text">{llm.why}</p>;
  return (
    <div className="cv-llmd">{llm.tasks.map((task) => {
      // 호출 없음(idle)의 설명은 상태 이름표·실제 줄과 같은 말이라 쓰지 않는다
      const note = task.note && task.state !== "idle" && !shown.some((text) => text.includes(task.note!)) ? task.note : null;
      return (
        <dl key={task.task} className="cv-kv cv-llmd-task" data-state={task.state}>
          <dt className="cv-llmd-k">작업</dt><dd className="cv-llmd-v"><b>{task.label}</b><span className="cv-llmd-state" data-state={task.state}>{STATE_TEXT[task.state]}</span></dd>
          <dt className="cv-llmd-k">설정</dt><dd className="cv-llmd-v">{rankChain(task) || "순위 없음"}</dd>
          <dt className="cv-llmd-k">실제</dt><dd className="cv-llmd-v">{usedText(task)}</dd>
          {note && <><dt className="cv-llmd-k">까닭</dt><dd className="cv-llmd-v cv-llmd-note">{note}</dd></>}
        </dl>);
    })}</div>
  );
}

function llmAria(llm: StationLlm | null): string {
  if (!llm) return ", 모델 확인 못함";
  if (llm.kind === "none") return `, LLM 없음 ${llm.short}`;
  if (llm.kind === "unknown") return ", 모델 확인 못함";
  return `, 모델 ${llm.head.head?.model ?? "없음"}${llm.flag ? ` ${llm.flag.text}` : ""}`;
}

function StationCard({ station, hours, selected, onSelect, onChange, controls }: {
  station: Station; hours: string[] | null; selected: boolean; onSelect: () => void; onChange?: () => void; controls: FlowControls;
}) {
  const queue = station.key !== "discover";
  const observation = jobObservation(station.key, controls);
  const rate = [
    <>5분 <b>{num(station.done5m)}</b>{station.unit}</>,
    <>1시간 <b>{num(station.doneHour)}</b>{station.unit}</>,
    <>24시간 <b>{num(station.done24h)}</b>{station.unit}</>,
  ];
  return (
    <div className="cv-card" data-tone={station.tone} data-selected={selected ? "yes" : undefined} data-change={onChange ? "yes" : undefined}>
      <button type="button" className="cv-card-hit" aria-pressed={selected} onClick={onSelect}
        aria-label={`${station.label} — ${station.status}${queue ? `, 대기 ${num(station.waiting)}` : ""}${llmAria(station.llm)}. 자세히와 장애 대응 보기`} />
      <span className="cv-card-body">
        <span className="cv-card-top"><span className="cv-card-name">{station.label}</span><ToneBadge tone={station.tone} text={station.status} /></span>
        {queue
          ? <span className="cv-big"><b>{num(station.waiting)}</b><small>대기 {station.key === "second" ? "후보" : "건"}{station.oldestMinutes !== null && station.waiting ? ` · 최장 ${ageText(station.oldestMinutes)}` : ""}</small></span>
          : <span className="cv-big"><b>{num(station.doneHour)}</b><small>최근 1시간 발견</small></span>}
        {station.spark ? <span className="cv-spark-wrap">{station.rateLabel && <small className="cv-spark-what">선: {station.rateLabel}</small>}
          <Spark values={station.spark} hours={hours} unit={station.unit} label={station.rateLabel ? `${station.label}(${station.rateLabel})` : station.label} /></span>
          : <span className="cv-spark cv-spark-none">시간별 기록 없음 · 24시간 합계만</span>}
        {rate.length > 0 && <span className="cv-rate">{rate.map((part, index) => <span key={index}>{part}</span>)}</span>}
        <span className="cv-activity">{observation.running === null ? "실행 잡 미확인" : `실행 잡 ${n(observation.running)}개`}{observation.stale ? " · 잠금 오래됨" : ""}{station.key === "second" ? " · 소비자 별도" : ""}</span>
        <LlmLine llm={station.llm} />
      </span>
      {onChange && <ChangeButton label={station.label} onClick={onChange} className="cv-card-change" />}
    </div>
  );
}

function Belt({ station }: { station: Station }) {
  const perHour = station.doneHour ?? (station.done5m !== null ? station.done5m * 12 : null);
  // 쌓임인데 처리 속도를 모르는 칸은 천천히 — 멈춘 벨트(막힘)와 달라 보이게
  const seconds = station.tone === "flow" || station.tone === "slow" ? beltSeconds(perHour) ?? (station.tone === "slow" ? 3.2 : null) : null;
  const items = station.tone === "idle" ? "none" : station.tone === "slow" || station.tone === "jam" ? "dense" : "normal";
  return (
    <div className="cv-belt" data-tone={station.tone} data-items={items} data-moving={seconds ? "yes" : "no"}
      style={seconds ? { ["--cv-speed" as string]: `${seconds.toFixed(2)}s` } : undefined} aria-hidden="true">
      <span className="cv-belt-items" />
      {station.tone === "jam" && <span className="cv-belt-stop">■</span>}
    </div>
  );
}

function HumanCard({ human, selected, onSelect, onChange }: {
  human: HumanBox; selected: boolean; onSelect: () => void; onChange?: () => void;
}) {
  return (
    <div className="cv-card cv-human" data-tone={human.tone} data-selected={selected ? "yes" : undefined} data-change={onChange ? "yes" : undefined}>
      <button type="button" className="cv-card-hit" aria-pressed={selected} onClick={onSelect}
        aria-label={`사람 심사 — ${human.status}, 사람 몫 ${n(human.waiting)}건. 자세히와 장애 대응 보기`} />
      <span className="cv-card-body">
        <span className="cv-card-top"><span className="cv-card-name">사람 심사</span><ToneBadge tone={human.tone} text={human.status} /></span>
        <span className="cv-human-nums">
          <span className="cv-big"><b>{n(human.waiting)}</b><small>사람 몫</small></span>
          <span className="cv-rate"><span>직접 판단 <b>{n(human.direct)}</b></span><span>확정만 <b>{n(human.agreed)}</b></span></span>
          <span className="cv-rate"><span>24시간 처리 <b>{num(human.decided24h)}</b></span>{human.oldestDays !== null && human.direct > 0 ? <span>최장 {n(human.oldestDays)}일</span> : null}</span>
        </span>
        <LlmLine llm={human.llm} />
      </span>
      {onChange && <ChangeButton label="사람 심사" onClick={onChange} className="cv-card-change" />}
    </div>
  );
}

function Facts({ items }: { items: { label: string; value: string; tone?: "warn" | "bad" }[] }) {
  if (!items.length) return null;
  return <dl className="cv-facts">{items.map((item) => (
    <div key={item.label} data-tone={item.tone}><dt>{item.label}</dt><dd>{item.value}</dd></div>
  ))}</dl>;
}

/** 자세히의 섹션 하나 — 제목 + 내용. 섹션 사이 간격·구분선은 CSS 하나(.cv-sec)가 정한다 */
function Section({ id, title, tool, children }: { id: string; title: string; tool?: ReactNode; children: ReactNode }) {
  const head = <h3 className="cv-sec-h" id={id}>{title}</h3>;
  return <section className="cv-sec" aria-labelledby={id}>{tool ? <div className="cv-sec-head">{head}{tool}</div> : head}{children}</section>;
}

/** 「바꾸기」 — 카드의 LLM 줄과 자세히 「지금 쓰는 모델」에 같은 모양으로 둔다 */
function ChangeButton({ label, onClick, className = "" }: { label: string; onClick: () => void; className?: string }) {
  return <button type="button" className={`cv-change${className ? ` ${className}` : ""}`} aria-label={`${label} 처리 LLM 바꾸기`}
    onClick={(event) => { event.stopPropagation(); onClick(); }}>바꾸기</button>;
}

/**
 * ① 상태 — 칸의 까닭과 모델 경고를 한 곳에. 까닭이 있으면 그것 하나(같은 사고의 모델 경고는 거기 담겨 있다), 없으면 모델 경고, 둘 다 없으면 조용한 한 줄.
 * 돌려준 문장들은 ② 모델 섹션이 다시 쓰지 않는다.
 */
function statusLines(reason: string | null, llm: StationLlm | null): string[] {
  if (reason) return [reason];
  return llm?.kind === "llm" ? llm.warnings : [];
}

function StatusSection({ tone, status, lines }: { tone: BeltTone; status: string; lines: string[] }) {
  return (
    <Section id="cv-sec-status" title="상태">
      {lines.length ? lines.map((line) => <p key={line} className="cv-reason" data-tone={tone === "flow" || tone === "idle" ? "slow" : tone}>
        <span aria-hidden="true">{ICON[tone === "flow" || tone === "idle" ? "slow" : tone]}</span> {line}</p>)
        : <p className="cv-sec-text cv-quiet"><span aria-hidden="true">{ICON[tone]}</span> {status} — 이 칸에 걸린 문제가 없습니다.</p>}
    </Section>
  );
}

/** ③ 처리량의 숫자 칸 — 열 폭이 같은 격자. 라벨이 두 줄이 돼도 숫자는 아래 기준선에 맞는다 */
function Kpis({ items }: { items: { label: string; value: string }[] }) {
  return <dl className="cv-kpis">{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}

/**
 * 칸 자세히 — 모든 칸이 같은 틀(2026-11-04 4차): ① 상태 ② 지금 쓰는 모델 ③ 처리량 ④ 이 칸에서 빠진 보류 ⑤ 바로 가기.
 * 섹션은 늘 같은 차례로 다 있다 — 없는 것은 「없음」 한 줄로 답한다(칸마다 자리가 바뀌지 않게).
 */
export function StationDetail({ station, hours, onChangeModels, runtime, holdsKnown = true }: {
  station: Station; hours: string[] | null; onChangeModels?: () => void; runtime?: ReactNode; holdsKnown?: boolean;
}) {
  const phase = PHASES.find((row) => row.key === station.phase)?.label;
  const lines = statusLines(station.reason, station.llm);
  const kpis = [
    station.waiting !== null ? { label: "지금 대기", value: num(station.waiting) } : null,
    station.oldestMinutes !== null && !!station.waiting ? { label: "가장 오래 기다림", value: ageText(station.oldestMinutes) } : null,
    station.done5m !== null ? { label: "최근 5분", value: num(station.done5m, station.unit) } : null,
    station.doneHour !== null ? { label: station.rateLabel ? `1시간 ${station.rateLabel}` : "최근 1시간", value: num(station.doneHour, station.unit) } : null,
    station.done24h !== null ? { label: station.rateLabel ? `24시간 ${station.rateLabel}` : "최근 24시간", value: num(station.done24h, station.unit) } : null,
  ].filter((item): item is { label: string; value: string } => !!item);
  const links = [...station.links, ...(station.llm?.kind === "llm" ? [{ href: TASKS_HREF, label: "작업 ↔ AI 모델에서 순위 보기·바꾸기" }] : [])];
  return (
    <div className="cv-detail-main">
      <header className="cv-detail-h">
        <h2 id="cv-detail-title">{phase !== station.label && <small>{phase}</small>}{station.label}</h2>
        <ToneBadge tone={station.tone} text={station.status} />
      </header>
      <p className="cv-what">{station.what}</p>
      <StatusSection tone={station.tone} status={station.status} lines={lines} />
      {runtime}
      <Section id="cv-sec-model" title="지금 쓰는 모델 — 설정과 실제(최근 1시간 장부)"
        tool={onChangeModels ? <ChangeButton label={station.label} onClick={onChangeModels} /> : undefined}><LlmDetail llm={station.llm} shown={lines} /></Section>
      <Section id="cv-sec-rate" title="처리량">
        <Kpis items={kpis} />
        {station.spark ? <div className="cv-detail-chart"><p className="cv-sub">시간별 {station.rateLabel ?? "처리"} · 최근 24시간</p>
          <Spark values={station.spark} hours={hours} unit={station.unit} label={station.label} large /></div>
          : <p className="cv-sec-text cv-quiet">시간별 기록이 없는 칸입니다 — 24시간 합계만 봅니다.</p>}
        <Facts items={station.facts} />
      </Section>
      <Section id="cv-sec-holds" title="이 칸에서 빠진 보류">
        {!holdsKnown ? <p className="cv-sec-text cv-quiet">보류 집계를 읽지 못했습니다 — 0건이 아닙니다.</p>
          : station.holds.length === 0 ? <p className="cv-sec-text cv-quiet">이 칸에서 사람 확인(보류)으로 빠진 것이 없습니다.</p> : (
          <table className="cv-holds-table">
            <colgroup><col /><col className="cv-c-num" /><col className="cv-c-num" /></colgroup>
            <thead><tr><th scope="col">사유</th><th scope="col" className="cv-r">건수</th><th scope="col" className="cv-r">24시간 변화</th></tr></thead>
            <tbody>{station.holds.map((hold) => <tr key={hold.reason}>
              <th scope="row">{hold.href ? <Link href={hold.href} prefetch={false}>{hold.label}</Link> : hold.label}</th>
              <td className="cv-r cv-n">{n(hold.count)}건</td>
              <td className="cv-r cv-n">{hold.recent24h ? <span className="cv-plus">+{n(hold.recent24h)}</span> : "—"}</td>
            </tr>)}</tbody>
          </table>)}
      </Section>
      <Section id="cv-sec-links" title="바로 가기">
        <ul className="cv-links">{links.map((link) => <li key={link.href}><Link href={link.href} prefetch={false}>{link.label} →</Link></li>)}</ul>
      </Section>
    </div>
  );
}

/** 사람 심사 자세히 — 칸과 같은 틀. 보류는 이 칸으로 모이는 쪽이라 ④ 대신 처리량에 단계별 수를 둔다 */
export function HumanDetail({ human, onChangeModels }: { human: HumanBox; onChangeModels?: () => void }) {
  const lines = statusLines(human.reason, human.llm);
  return (
    <div className="cv-detail-main">
      <header className="cv-detail-h"><h2 id="cv-detail-title"><small>검수</small>사람 심사</h2><ToneBadge tone={human.tone} text={human.status} /></header>
      <p className="cv-what">규칙·AI가 가르지 못한 후보(보류)를 사람이 승인하거나 거절합니다. 승인하면 프로필 준비로 돌아갑니다.</p>
      <StatusSection tone={human.tone} status={human.status} lines={lines} />
      <Section id="cv-sec-model" title="지금 쓰는 모델 — 설정과 실제(최근 1시간 장부)"
        tool={onChangeModels ? <ChangeButton label="사람 심사" onClick={onChangeModels} /> : undefined}><LlmDetail llm={human.llm} shown={lines} /></Section>
      <Section id="cv-sec-rate" title="처리량">
        <Kpis items={[{ label: "직접 판단", value: n(human.direct) }, { label: "확정만 하면 됨", value: n(human.agreed) }, { label: "2차 결론 대기", value: n(human.awaitingSecond) },
          { label: "AI 결론 대기", value: n(human.awaitingAi) }, { label: "24시간 사람 결정", value: num(human.decided24h) },
          ...(human.in24h !== null ? [{ label: "24시간 새로 남음", value: `+${n(human.in24h)}` }] : [])]} />
      </Section>
      <Section id="cv-sec-links" title="바로 가기">
        <ul className="cv-links"><li><Link href="/admin/review" prefetch={false}>심사 큐 →</Link></li>
          {human.llm?.kind === "llm" && <li><Link href={TASKS_HREF} prefetch={false}>작업 ↔ AI 모델에서 순위 보기·바꾸기 →</Link></li>}</ul>
      </Section>
    </div>
  );
}

/** 조치 종류 배지 — 폭이 같은 네 가지. 조심은 저장 전에 확인하는 조치다 */
const KIND: Record<"read" | "act" | "careful" | "manual", { text: string; title: string }> = {
  read: { text: "보기", title: "보기만 합니다 — 바뀌는 것이 없습니다" },
  act: { text: "작업", title: "바꾸는 조치 — 되돌릴 수 있습니다" },
  careful: { text: "조심", title: "조심 — 저장 전에 확인합니다" },
  manual: { text: "화면 밖", title: "이 화면에 조치가 없습니다 — 도구·사람 결정으로 합니다" },
};
const stepKind = (step: ResponseStep): keyof typeof KIND => step.kind === "job" ? "act" : step.kind === "manual" ? "manual" : step.risk === "read" ? "read" : step.risk === "careful" ? "careful" : "act";

function KindBadge({ kind }: { kind: keyof typeof KIND }) {
  return <span className="rs-kind" data-kind={kind} title={KIND[kind].title}>{KIND[kind].text}</span>;
}

function JobCell({ step, state, csrf }: { step: Extract<ResponseStep, { kind: "job" }>; state: FlowJobState | undefined; csrf: FlowControls["csrf"] }) {
  if (!state) return <><b>{step.label}</b> <code>{step.job}</code><p className="rs-why">작업 상태를 읽지 못했습니다 — 멈춤·재개는 운영센터 작업 상세에서 합니다.</p></>;
  return (
    <>
      <b>{step.label}</b> <code>{step.job}</code> <span className="rs-state" data-tone={state.paused ? "stop" : state.lastError ? "slow" : "flow"}>
        {state.paused ? "멈춤" : state.lastError ? "마지막 실행 오류" : "실행 허용"}</span>
      <p className="rs-why">{state.paused ? "사람이 멈춘 작업입니다. 원인을 고쳤으면 사유를 적고 재개합니다." : step.why}</p>
      {csrf ? <details className="rs-confirm">
        <summary>{state.paused ? "이 작업 재개…" : "이 작업 멈춤…"}</summary>
        <JobControl name={step.job} paused={state.paused} notBefore={state.notBefore} version={state.version} csrf={csrf} />
      </details> : <p className="rs-why">이 서버에는 확인 열쇠가 없어 보기만 합니다.</p>}
    </>
  );
}

/** 되돌리기 열 — 조치가 적어 둔 되돌리는 법. 보기는 바뀌는 것이 없고, 화면 밖 조치는 적힌 곳에서 한다 */
function undoText(step: ResponseStep): string {
  if (step.kind === "manual") return "—";
  if (step.kind === "job") return step.undo;
  return step.undo ?? (step.risk === "read" ? "바뀌는 것 없음" : "—");
}

/**
 * 장애 대응 — 두 섹션(4차): 먼저 볼 것(번호 목록 — 번호 열 폭 고정, 줄간격 같음) · 할 수 있는 조치(열이 맞는 표: 종류 | 조치 | 되돌리기).
 */
export function ResponsePanel({ steps, checks, controls }: { steps: ResponseStep[]; checks: string[]; controls: FlowControls }) {
  return (
    <aside className="rs" aria-labelledby="rs-title" id="cv-response">
      <h3 id="rs-title">장애 대응</h3>
      <section className="cv-sec" aria-labelledby="rs-sec-checks">
        <h4 className="cv-sec-h" id="rs-sec-checks">먼저 볼 것</h4>
        {checks.length ? <ol className="rs-checks">{checks.map((check, index) => <li key={check}><span className="rs-no" aria-hidden="true">{index + 1}</span><span className="rs-check">{check}</span></li>)}</ol>
          : <p className="cv-sec-text cv-quiet">따로 먼저 볼 것이 없습니다 — 아래 조치에서 고릅니다.</p>}
      </section>
      <section className="cv-sec" aria-labelledby="rs-sec-steps">
        <h4 className="cv-sec-h" id="rs-sec-steps">할 수 있는 조치</h4>
        <table className="rs-table">
          <colgroup><col className="rs-c-kind" /><col /><col className="rs-c-undo" /></colgroup>
          <thead><tr><th scope="col">종류</th><th scope="col">조치</th><th scope="col">되돌리기</th></tr></thead>
          <tbody>{steps.map((step, index) => {
            const kind = stepKind(step);
            return (
              <tr key={`${step.kind}-${step.label}-${index}`} className="rs-step" data-kind={kind}>
                <td><KindBadge kind={kind} /></td>
                <td className="rs-what">{step.kind === "job" ? <JobCell step={step} state={controls.jobs[step.job]} csrf={controls.csrf} />
                  : step.kind === "link" ? <><Link href={step.href} prefetch={false}><b>{step.label}</b> →</Link><p className="rs-why">{step.why}</p></>
                  : <><b>{step.label}</b><p className="rs-why">{step.why}</p><p className="rs-where">{step.where}</p></>}</td>
                <td className="rs-undo">{undoText(step)}</td>
              </tr>);
          })}</tbody>
        </table>
      </section>
    </aside>
  );
}

function Funnel({ rows }: { rows: Conveyor["funnel"] }) {
  const max = Math.max(1, ...rows.map((row) => row.value ?? 0));
  return (
    <section className="cv-panel" aria-labelledby="cv-funnel-title">
      <h2 id="cv-funnel-title">24시간 동안 각 칸을 지난 수</h2>
      <p className="cv-sub">단계별 업무 결과입니다. 사람 결정·공개 후 키워드와 2차 표는 서로 다른 집계이며 합산하지 않습니다.</p>
      <ol className="cv-bars">{rows.map((row) => (
        <li key={row.key} title={`${row.label} · ${num(row.value)}${row.unit}${row.note ? ` (${row.note})` : ""}`}>
          <span className="cv-bar-label">{row.label}</span>
          <span className="cv-bar-track"><span className="cv-bar" style={{ width: `${row.value ? Math.max(1.5, (row.value / max) * 100) : 0}%` }} /></span>
          <span className="cv-bar-value">{num(row.value)}<small>{row.unit}</small></span>
        </li>))}</ol>
    </section>
  );
}

const STATION_NAMES: Record<string, string> = { fetch: "원본 수집", judge: "규칙 심사", first: "AI 1차", second: "AI 2차", profile: "프로필 준비", human: "사람 심사" };

function HoldReasons({ rows, held, rejected }: { rows: Conveyor["holdsByReason"]; held: number | null; rejected: number | null }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <section className="cv-panel" aria-labelledby="cv-holds-title">
      <h2 id="cv-holds-title">사람 확인(보류) {held === null ? "" : `${n(held)}건`} — 어디서 왜 빠졌나</h2>
      <p className="cv-sub">보류 사유와 그 사유를 만든 칸입니다. +는 최근 24시간 안에 바뀐 후보 수입니다.{rejected !== null ? ` 거절 누적 ${n(rejected)}건.` : ""}</p>
      {held === null ? <p className="cv-empty">보류 집계를 읽지 못했습니다 — 0건이 아닙니다.</p>
        : rows.length === 0 ? <p className="cv-empty">보류가 없습니다.</p> : (
        <ol className="cv-bars cv-bars-hold">{rows.slice(0, 10).map((row) => (
          <li key={row.reason}>
            <span className="cv-bar-label">{row.href ? <Link href={row.href} prefetch={false}>{row.label}</Link> : row.label}<small>{STATION_NAMES[row.station] ?? ""}</small></span>
            <span className="cv-bar-track"><span className="cv-bar" style={{ width: `${Math.max(1.5, (row.count / max) * 100)}%` }} /></span>
            <span className="cv-bar-value">{n(row.count)}{row.recent24h ? <small> +{n(row.recent24h)}</small> : null}</span>
          </li>))}</ol>)}
    </section>
  );
}

function llmText(llm: StationLlm | null): string {
  if (!llm || llm.kind === "unknown") return "확인 못함";
  if (llm.kind === "none") return `LLM 없음 · ${llm.short}`;
  const head = llm.head.head;
  return `${head ? `${head.where} · ${head.model}` : "모델 없음"}${llm.more ? ` 외 ${llm.more}` : ""}${llm.flag ? ` (${llm.flag.text})` : ""}`;
}

const STATION_ROLE: Record<Station["key"], string> = {
  discover: "crawler", fetch: "crawler", judge: "reviewer", first: "reviewer", second: "reviewer",
  profile: "text", publish: "publisher", keywords: "text",
};

/** This summarizes the already-loaded job rows. An unlocked job is not proof that a model is running. */
function jobObservation(key: Station["key"], controls: FlowControls) {
  const rows = STATION_JOBS[key].map(({ job, label }) => ({ job, label, state: controls.jobs[job] }));
  const known = rows.filter((row) => row.state !== undefined);
  const complete = known.length === rows.length && rows.length > 0;
  const paused = known.filter((row) => row.state.paused).length;
  const failures = known.filter((row) => row.state.lastError).length;
  const stale = known.filter((row) => row.state.execution === "stale").length;
  const executionKnown = complete && known.every((row) => row.state.execution !== undefined);
  const latest = (field: "lastSuccessAt" | "lastRunAt" | "workerSeenAt") => {
    const values = known.flatMap((row) => row.state[field] ? [row.state[field]!] : []).filter((value) => Number.isFinite(Date.parse(value)));
    return values.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  };
  return {
    rows, complete,
    status: !complete ? "잡 상태 일부 미확인" : paused === rows.length ? "잡 일시 중지" : failures ? "마지막 잡 오류" : paused ? "일부 잡 중지" : "잡 실행 허용",
    running: executionKnown && !stale ? known.filter((row) => row.state.execution === "locked").length : null, stale,
    paused, lastSuccessAt: latest("lastSuccessAt"), lastRunAt: latest("lastRunAt"), workerSeenAt: latest("workerSeenAt"),
  };
}

const observationTime = (value: string | null) => value ? kstShort(value) : "확인 못함";

/** Job completion is not a count of translated products or languages. Keep the missing queue metrics explicit. */
export function PublicTranslations({ controls, llm = null, onChangeModels }: { controls: FlowControls; llm?: StationLlm | null; onChangeModels?: () => void }) {
  return <section className="cv-translations" aria-labelledby="cv-translations-title">
    <div className="cv-post-head"><h3 id="cv-translations-title">소개·번역</h3><span>공개 후·검수 보조 처리</span>{onChangeModels && <ChangeButton label="소개·번역" onClick={onChangeModels} />}</div>
    <dl>{PUBLIC_TRANSLATION_JOBS.map(({ job, label }) => {
      const state = controls.jobs[job];
      return <div key={job}><dt><Link href={`/admin/status?tab=jobs&job=${job}`} prefetch={false}>{label} →</Link></dt>
        <dd>{state?.runtimeLabel ?? "잡 관측 미확인"}<small>최근 잡 성공 {observationTime(state?.lastSuccessAt ?? null)}</small></dd></div>;
    })}</dl>
    <LlmLine llm={llm} />
    {llm?.kind === "llm" && <details className="cv-post-models"><summary>작업별 모델·설정과 실제 보기</summary><LlmDetail llm={llm} shown={[]} /></details>}
    <p className="cv-sub">번역 대기·언어별 저장 완료는 이 흐름에서 집계하지 않습니다.</p>
    <p className="cv-sub">제품 번역·소개 검수는 공개 후, 사유 번역은 검수 기록의 보조 작업입니다.</p>
    <Link className="cv-inline-link" href="/admin/status#korean-translation" prefetch={false}>번역 대기·실행 근거 확인 →</Link>
  </section>;
}

/** Owner and job observations stay alongside the selected station; no additional database query is made. */
export function StationRuntime({ station, controls, desk }: { station: Station; controls: FlowControls; desk: OperatorDesk | null }) {
  const observation = jobObservation(station.key, controls);
  const owner = desk?.window?.roles.find((row) => row.role === STATION_ROLE[station.key]);
  return <div className="cv-runtime" aria-label={`${station.label} 담당·잡 관측`}>
    <dl>
      <div><dt>담당 역할</dt><dd>{STATION_ROLE[station.key]}{station.key === "second" ? " 잡 · AI2 소비자 별도" : ""}</dd></div>
      <div><dt>역할 소유 관측</dt><dd>{owner ? `${owner.host ?? "장비 미확인"} · ${owner.text}` : "확인 못함"}<small>{desk ? `${kstShort(desk.measuredAt)} 기준` : "역할 관측을 읽지 못함"}{station.key === "second" ? " · AI2 소비자 실행 장비와 별도" : ""}</small></dd></div>
      <div><dt>잡 제어·실행</dt><dd>{observation.status}<small>{observation.rows.map((row) => `${row.job}: ${row.state?.execution === "locked" ? "실행 중(잠금 관측)" : row.state?.execution === "stale" ? "잠금 오래됨·회수 대기" : row.state?.runtimeLabel ?? "미확인"}`).join(" · ")}</small></dd></div>
      <div><dt>최근 잡 성공</dt><dd>{observationTime(observation.lastSuccessAt)}<small>잡 성공과 단계의 업무 완료·모델 호출 종료는 별도 관측</small></dd></div>
      <div><dt>최근 잡 관측</dt><dd>시작 {observationTime(observation.lastRunAt)}<small>워커 관측 {observationTime(observation.workerSeenAt)}{controls.measuredAt ? ` · 조회 ${kstShort(controls.measuredAt)}` : " · 조회 시각 미확인"}</small></dd></div>
      <div><dt>모델 실행 중</dt><dd>이 집계에서는 확인하지 않음 <Link href="/admin/models" prefetch={false}>실제 호출·점유 보기 →</Link></dd></div>
    </dl>
  </div>;
}

export function TableView({ data, controls = EMPTY_CONTROLS, desk = null }: { data: Conveyor; controls?: FlowControls; desk?: OperatorDesk | null }) {
  return (
    <div className="admin-table-scroll cv-table"><table>
      <caption className="admin-vh">단계별 대기·처리·모델·담당 역할과 잡 성공 관측. 단계마다 집계 단위가 다릅니다.</caption>
      <thead><tr><th scope="col">단계·단위</th><th scope="col">상태</th><th scope="col">대기</th><th scope="col">최장</th><th scope="col">5분 완료</th><th scope="col">1시간 완료</th><th scope="col">24시간 완료</th><th scope="col">보류</th><th scope="col">모델·담당</th><th scope="col">최근 잡 성공·원인</th></tr></thead>
      <tbody>
        {data.stations.map((station) => {
          const observation = jobObservation(station.key, controls);
          const owner = desk?.window?.roles.find((row) => row.role === STATION_ROLE[station.key]);
          return <tr key={station.key}>
            <th scope="row">{station.label}<small>{station.key === "second" ? "2차 투표 · 후보 수와 다름" : station.rateLabel ?? `${station.unit} 기준`}</small></th><td><ToneBadge tone={station.tone} text={station.status} /></td><td>{num(station.waiting)}</td>
            <td>{station.waiting ? ageText(station.oldestMinutes) : "—"}</td><td>{num(station.done5m, station.unit)}</td><td>{num(station.doneHour, station.unit)}</td>
            <td>{num(station.done24h, station.unit)}</td><td>{data.held === null ? "미확인" : station.holds.length ? `${n(station.holds.reduce((total, hold) => total + hold.count, 0))}건` : "—"}</td>
            <td>{llmText(station.llm)}<small>{owner ? `${owner.host ?? "장비 미확인"} · ${STATION_ROLE[station.key]}` : `${STATION_ROLE[station.key]} · 담당 장비 미확인`}{station.key === "second" ? " · 소비자 별도" : ""}</small></td>
            <td>{observationTime(observation.lastSuccessAt)}<small>{station.reason ?? observation.status}</small></td>
          </tr>;
        })}
        {data.human && <tr><th scope="row">사람 심사</th><td>{data.human.status}</td><td>{n(data.human.waiting)}</td>
          <td>{data.human.oldestDays !== null ? `${n(data.human.oldestDays)}일` : "—"}</td><td>—</td><td>—</td><td>{num(data.human.decided24h)}</td><td>—</td><td>{llmText(data.human.llm)}</td><td>{data.human.reason ?? ""}</td></tr>}
      </tbody>
    </table></div>
  );
}

/** 칸 위의 단계 이름 — 그 단계의 첫 칸에만 글자를 쓰고, 나머지 칸은 밑줄만 잇는다(두 줄로 접혀도 맞다) */
const firstOfPhase = (stations: Station[], index: number) => index === 0 || stations[index - 1].phase !== stations[index].phase;

const EMPTY_CONTROLS: FlowControls = { jobs: {}, csrf: null };
const STATION_LABEL = (data: Conveyor, key: LlmStationKey) => key === "human"
  ? "사람 심사" : data.stations.find((station) => station.key === key)?.label ?? key;

export function FlowBoard({ data, desk = null, controls = EMPTY_CONTROLS, editor = null }: {
  data: Conveyor; desk?: OperatorDesk | null; controls?: FlowControls;
  /** 「바꾸기」 서랍의 순위·선택지(읽기). null 이면 바꾸기를 두지 않고 「작업 ↔ AI 모델」 링크만 남긴다 */
  editor?: FlowRankEditor | null;
}) {
  // 처음 여는 칸 — 가장 막힌 곳, 없으면 미확인 칸, 그것도 없으면 맨 앞(탐색)
  const [selected, setSelected] = useState<Selected>(data.bottleneck ?? data.stations.find((station) => station.tone === "unknown")?.key ?? "discover");
  const [changing, setChanging] = useState<LlmStationKey | null>(null);
  const current = selected === "human" ? null : data.stations.find((station) => station.key === selected) ?? null;
  const tone = current?.tone ?? data.human?.tone ?? "unknown";
  const response = stationResponse(selected, data, desk);
  // 머리 줄 바로 할 일 — 가장 막힌 곳의 조치 중 화면으로 가는 앞 두 개
  const quick = data.bottleneck ? stationResponse(data.bottleneck, data, desk).steps.filter((step): step is Extract<ResponseStep, { kind: "link" }> => step.kind === "link").slice(0, 2) : [];
  const pick = (key: Selected) => {
    setSelected(key);
    const detail = document.getElementById("cv-detail");
    detail?.focus({ preventScroll: true });
    detail?.scrollIntoView({ block: "start" });
  };
  const canChange = (key: LlmStationKey) => flowRankLinesFor(editor, key).length > 0;
  const secondWaiting = data.stations.find((station) => station.key === "second")?.waiting ?? null;
  const mainStations = data.stations.filter((station) => station.key !== "keywords");
  const keywords = data.stations.find((station) => station.key === "keywords");
  return (
    <div className="cv">
      <section className="cv-headline" data-tone={data.headline.tone} aria-live="polite">
        <p className="cv-headline-title"><span className="cv-headline-icon" aria-hidden="true">{ICON[data.headline.tone]}</span>{data.headline.title}</p>
        <p className="cv-stamp">{kstClock(data.measuredAt)} 기준</p>
        {data.headline.detail && <p className="cv-headline-detail">{data.headline.detail}</p>}
        {data.bottleneck && <p className="cv-quick">
          {quick.map((step) => <Link key={step.href + step.label} href={step.href} prefetch={false} className="cv-quick-link">{step.label} →</Link>)}
          <a href="#cv-response" className="cv-quick-link cv-quick-plain" onClick={() => pick(data.bottleneck!)}>장애 대응 보기 ↓</a>
        </p>}
      </section>

      <section className="cv-live" aria-labelledby="cv-live-title">
      <div className="cv-live-head"><h2 id="cv-live-title">실시간 전체 흐름</h2><p>대기 = 현재 잔량 · 완료 = 각 구간의 업무 결과</p></div>
      <div className="cv-scroll" role="region" aria-label="발견부터 공개 완료까지의 주 흐름 — 왼쪽에서 오른쪽으로 흐릅니다">
        <ol className="cv-board">
          {mainStations.map((station, index) => (
            <li key={station.key} className="cv-cell" data-key={station.key}>
              <p className="cv-phase" data-first={firstOfPhase(mainStations, index) ? "yes" : undefined}>
                <span>{firstOfPhase(mainStations, index) ? PHASES.find((phase) => phase.key === station.phase)?.label : " "}</span></p>
              <StationCard station={station} hours={data.hours} selected={selected === station.key} onSelect={() => pick(station.key)}
                controls={controls}
                onChange={canChange(station.key) ? () => setChanging(station.key) : undefined} />
              <Belt station={station} />
              <div className="cv-drop" data-has={station.holds.length ? "yes" : "no"}>
                {station.holds.length > 0 && <>
                  <span className="cv-drop-line" aria-hidden="true" />
                  <button type="button" className="cv-hold" onClick={() => pick(station.key)}
                    aria-label={`${station.label}에서 보류로 빠짐 ${n(station.holds.reduce((total, hold) => total + hold.count, 0))}건 — 자세히 보기`}>
                    <b>{n(station.holds.reduce((total, hold) => total + hold.count, 0))}</b>
                    <small>{station.holds[0].label}{station.holds.length > 1 ? ` 외 ${station.holds.length - 1}` : ""}</small>
                    {station.holds.some((hold) => hold.recent24h) && <small className="cv-plus">24h +{n(station.holds.reduce((total, hold) => total + (hold.recent24h ?? 0), 0))}</small>}
                  </button>
                </>}
              </div>
            </li>
          ))}
          <li className="cv-cell" data-key="sink">
            <p className="cv-phase" data-first="yes"><span>결과</span></p>
            <div className="cv-card cv-sink"><span className="cv-card-top"><span className="cv-card-name">공개 완료</span></span>
              <span className="cv-big"><b>{num(data.published)}</b><small>공개 제품</small></span>
              <span className="cv-rate"><span>1시간 +<b>{num(data.publishedHour)}</b></span></span>
              <Link className="cv-inline-link" href="/admin/products" prefetch={false}>공개 프로젝트 →</Link>
              <LlmLine llm={data.sinkLlm} /></div>
            <div className="cv-belt cv-belt-end" aria-hidden="true" />
            <div className="cv-drop" data-has="no" />
          </li>
        </ol>
        <div className="cv-human-row">
          <span className="cv-lane"><span aria-hidden="true">↳</span> 칸 아래로 빠진 보류는 모두 사람 심사로 모입니다{data.held !== null ? ` · 보류 전체 ${n(data.held)}건` : ""}</span>
          {data.human ? <HumanCard human={data.human} selected={selected === "human"} onSelect={() => pick("human")}
            onChange={canChange("human") ? () => setChanging("human") : undefined} />
            : <p className="cv-card cv-human" data-tone="unknown">사람 심사 수를 읽지 못했습니다</p>}
          <span className="cv-return" aria-hidden="true"><span>승인 → 프로필 준비</span><span>거절 → 끝</span></span>
        </div>
        <div className="cv-post" aria-label="공개 후 검색·번역 분기">
          <div className="cv-post-label"><b><span aria-hidden="true">↳</span> 공개 후 처리</b><p>공개 완료 뒤 별도로 진행합니다. 후보 대기·2차 표·후처리 수를 합산하지 않습니다.</p>
            <Link href="/admin/audit" prefetch={false}>공개 후 품질 감사 →</Link></div>
          {keywords && <div className="cv-post-keywords" data-key="keywords">
            <StationCard station={keywords} hours={data.hours} selected={selected === keywords.key} onSelect={() => pick(keywords.key)} controls={controls}
              onChange={canChange(keywords.key) ? () => setChanging(keywords.key) : undefined} />
            <Belt station={keywords} />
          </div>}
          <PublicTranslations controls={controls} llm={data.supportLlm}
            onChangeModels={canChange("profile") ? () => setChanging("profile") : undefined} />
        </div>
      </div>
      <p className="cv-legend">벨트 움직임은 최근 완료량을 표현합니다. 실행 잡은 조회 시점의 잠금 관측이며 모델 호출 수와 다릅니다. — 는 미집계·확인 불가입니다.</p>
      <div className="cv-scopes" aria-label="제어 범위 안내"><p><b>전역 관문</b> 다음 회차의 발굴·수집·심사·소개·발행·감사를 함께 제어</p><p><b>개별 잡</b> 선택한 잡만 제어 · AI2 소비자는 별도</p><p><b>모델 DRAIN</b> 새 모델 호출 접수 제어 · 기존 호출은 종료까지 관측</p></div>
      </section>

      {desk && <TodoPanel desk={desk} />}

      <section className="cv-detail" data-tone={tone} aria-labelledby="cv-detail-title" id="cv-detail" tabIndex={-1}>
        {current ? <StationDetail key={current.key} station={current} hours={data.hours}
            runtime={<StationRuntime station={current} controls={controls} desk={desk} />}
            holdsKnown={data.held !== null}
            onChangeModels={canChange(current.key) ? () => setChanging(current.key) : undefined} />
          : data.human ? <HumanDetail human={data.human} onChangeModels={canChange("human") ? () => setChanging("human") : undefined} />
          : <div className="cv-detail-main"><h2 id="cv-detail-title">사람 심사</h2></div>}
        <ResponsePanel steps={response.steps} checks={response.checks} controls={controls} />
      </section>

      <section className="cv-panel cv-stage-table" aria-labelledby="cv-stage-table-title">
        <div className="cv-live-head"><h2 id="cv-stage-table-title">단계별 상세 관측</h2><p>5분·1시간·24시간 완료량 · 담당·최근 성공·원인</p></div>
        <p className="cv-sub">2차 대기는 후보 수, 완료는 표 수입니다. 잡 성공은 해당 단계의 업무 완료·모델 응답 완료와 별개입니다.</p>
        <TableView data={data} controls={controls} desk={desk} />
      </section>

      {desk && <div className="dk-row dk-row-bottom">
        <ChangesPanel desk={desk} />
        <EquipmentPanel desk={desk} />
        <WindowPanel desk={desk} />
      </div>}

      <details className="cv-more">
        <summary>24시간 통과 수·보류 사유 더 보기</summary>
        <div className="cv-two">
          <Funnel rows={data.funnel} />
          <HoldReasons rows={data.holdsByReason} held={data.held} rejected={data.rejected} />
        </div>
      </details>
      {desk && <p className="cv-foot">책상 칸 기준 {kstShort(desk.measuredAt)} · 흐름 기준 {kstShort(data.measuredAt)}</p>}
      {changing && editor && <RankDrawer key={changing} editor={editor} lines={flowRankLinesFor(editor, changing)}
        title={changing === "profile" ? "소개 준비·번역·소개 검수" : STATION_LABEL(data, changing)} secondWaiting={secondWaiting} onClose={() => setChanging(null)} />}
    </div>
  );
}

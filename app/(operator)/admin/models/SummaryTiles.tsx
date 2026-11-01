import Link from "next/link";
import type { AdminModelsObservation } from "@/lib/operations/admin-models-observation";
import { capacityAlarmChips, kstClock, leaseHost, modelCardAnchor, probeIdentityOf, secondsAgoLabel, type CapacityAlarmSummary, type ModelCard } from "@/lib/operations/admin-models-view";
import { probeObservationKey, type ProbeObservation } from "@/lib/operations/admin-models-probe";
import type { RoleOverview } from "@/lib/operations/roles";
import { READINESS_LABELS } from "../status/status-summary";
import type { ModelOpsControls } from "./ModelOpsPanel";
import { buttonSmall } from "../settings/Switch";

export type LeaseTile = Pick<RoleOverview, "role" | "reason" | "ownerInstanceId" | "ownerKind" | "ownerRelease" | "epoch" | "secondsUntilExpiry" | "updatedAgoSeconds">;
const CHIP: Record<"ok" | "warn" | "bad" | "plain", string> = { ok: "border-up bg-up/10 text-up", warn: "border-warn bg-warn/10 text-warn", bad: "border-down bg-down/10 text-down", plain: "border-line bg-bg-soft text-fg" };
const GLYPH: Record<"ok" | "warn" | "bad" | "plain", string> = { ok: "●", warn: "▲", bad: "▲", plain: "" };
export function Chip({ tone, children, title }: { tone: keyof typeof CHIP; children: React.ReactNode; title?: string }) {
  return <span title={title} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[13px] leading-[1.5] ${CHIP[tone]}`}>
    {GLYPH[tone] && <span aria-hidden="true" className="model-glyph" data-glyph={GLYPH[tone]} />}{children}</span>;
}
const sum = (cards: ModelCard[], key: "succeeded1h" | "failed1h" | "withdrawn1h" | "dispatched" | "reserved" | "waiting" | "indeterminate") =>
  cards.reduce((n, card) => n + card.rows.reduce((m, row) => m + row[key], 0), 0);
const tile = "flex min-w-0 flex-col gap-1.5 rounded-lg border border-line bg-bg-card px-3 py-2.5";
const head = "text-[13px] font-semibold tracking-[.02em] text-fg-2";

export function AdmissionButton({ observation, controls }: { observation: AdminModelsObservation; controls: ModelOpsControls }) {
  return <button type="button" className={buttonSmall} disabled={controls.disabled || !["open", "draining"].includes(observation.mode ?? "")}
    onClick={() => controls.open(observation.mode === "open" ? "admission-pause" : "admission-open", "model-capacity")}>{observation.mode === "draining" ? "접수 재개" : "접수 일시중지"}</button>;
}

/**
 * 요약 타일 4개(승인 시안) — 접수 / 요청 / 경보 / 역할 lease. 숫자는 모두 장부 관측(observation)·역할 lease 표·장부 경보 요약에서 온다.
 * 경보의 「monitor overall」은 저장되는 곳이 없어 넣지 않는다 — 대신 같은 입력인 「역할 준비」(failover-readiness)와 「장부 경보」(monitor 와 같은 문턱)를 따로 보인다.
 */
export function SummaryTiles({ observation, cards, controls, probes, leases, readiness, alarms }: {
  observation: AdminModelsObservation; cards: ModelCard[]; controls: ModelOpsControls; probes: Record<string, ProbeObservation>;
  leases: LeaseTile[]; readiness: "ok" | "alarm" | null; alarms: CapacityAlarmSummary | null;
}) {
  const mode = observation.mode?.toUpperCase() ?? "미확인", held = sum(cards, "reserved") + sum(cards, "dispatched"), waiting = sum(cards, "waiting"), unknown = sum(cards, "indeterminate");
  const down = cards.filter(card => { const probe = probes[probeObservationKey(probeIdentityOf(card))]; return probe && (probe.listed === false || (probe.error && probe.listed !== true)); });
  const chips = capacityAlarmChips(alarms), firing = chips.filter(chip => chip.tone === "bad" && chip.id !== "ledger");
  return <section className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]" aria-label="요약">
    <div className={tile}>
      <h2 className={head}>접수</h2>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span data-mode={mode} className={`inline-flex items-center gap-2 text-[20px] font-bold ${observation.mode === "open" ? "text-up" : observation.mode === "draining" ? "text-warn" : "text-fg-2"}`}>
          <span aria-hidden="true" className={`inline-block h-3 w-3 ${observation.mode === "open" ? "rounded-full bg-up" : observation.mode === "draining" ? "rounded-[2px] bg-warn" : "rounded-[2px] bg-fg-3"}`} />{mode}</span>
        <span className="text-[13px] text-fg-2">정책 rev <span className="font-mono tabular-nums">{observation.revision ?? "—"}</span> · epoch <span className="font-mono tabular-nums">{observation.epoch ?? "—"}</span></span>
      </div>
      <p className="text-[13px] text-fg-2">관측 <span className="font-mono tabular-nums">{kstClock(observation.observedAt)}</span> KST · DB 장부 · 장비 <span className="font-mono tabular-nums">{observation.groups.length}</span>대
        {observation.groups.some(group => group.lending) && <> · 빌려 쓰는 중 {observation.groups.filter(group => group.lending).length}대</>}{observation.devicesRead ? "" : " · 장비 한도 미확인"}</p>
      <div className="flex flex-wrap items-center gap-1.5"><AdmissionButton observation={observation} controls={controls} /><a href="#devices" className="text-[13px] text-accent-ink underline underline-offset-[3px]">장비 한도 ↓</a>
        <Link href="/admin/models/devices" prefetch={false} className="text-[13px] text-accent-ink underline underline-offset-[3px]">장비 설정 →</Link></div>
    </div>
    <div className={tile}>
      <h2 className={head}>요청</h2>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 tabular-nums">
        <span className="flex items-baseline gap-1.5"><b className="font-mono text-[20px]" data-sum="held">{held}</b><span className="text-[13px] text-fg-2">진행 중</span></span>
        <span className="flex items-baseline gap-1.5"><b className="font-mono text-[20px]" data-sum="waiting">{waiting}</b><span className="text-[13px] text-fg-2">대기</span></span>
        <span className="flex items-baseline gap-1.5"><b className={`font-mono text-[20px] ${unknown ? "text-down" : ""}`} data-sum="unknown">{unknown}</b><span className="text-[13px] text-fg-2">확인 못함</span></span>
      </div>
      <p className="text-[13px] text-fg-2 tabular-nums">최근 1시간 성공 <span className="font-mono text-up">{sum(cards, "succeeded1h")}</span> · 실패 <span className="font-mono text-down">{sum(cards, "failed1h")}</span> · 철회 <span className="font-mono">{sum(cards, "withdrawn1h")}</span></p>
      <p className="text-[13px] text-fg-2">확인 못함은 슬롯을 점유하지 않음 · <a href="#review" className="text-accent-ink underline underline-offset-[3px]">사람 검토 목록 ↓</a></p>
    </div>
    <div className={tile}>
      <h2 className={head}>경보</h2>
      <div className="flex flex-wrap gap-1.5">
        <Chip tone={readiness === "ok" ? "ok" : readiness === "alarm" ? "bad" : "warn"}>역할 준비 <b>{readiness === "ok" ? "정상" : readiness === "alarm" ? "경보" : "미확인"}</b></Chip>
        {chips.filter(chip => chip.id === "ledger").map(chip => <Chip key={chip.id} tone={chip.tone}>{chip.text}</Chip>)}
        {firing.map(chip => <Chip key={chip.id} tone="bad"><span className="font-mono tabular-nums">{chip.text}</span></Chip>)}
        {alarms && alarms.status !== "unknown" && !firing.length && <Chip tone="ok">dispatch_stuck · review_backlog · review_stale 없음</Chip>}
        {down.map(card => <Chip key={card.id} tone="bad">{card.equipment} <b>연결 안 됨</b> · <a href={`#${modelCardAnchor(card.id)}`} className="underline underline-offset-[3px]">{card.name} ↓</a></Chip>)}
      </div>
      <p className="text-[13px] text-fg-2">{alarms && alarms.status !== "unknown" ? <>문턱: 전송 {Math.round(alarms.thresholds.dispatchStuckSeconds / 60)}분 · 검토 {alarms.thresholds.reviewMaxRows}행 · {Math.round(alarms.thresholds.reviewMaxAgeSeconds / 3600)}시간 · 검토 목록 {alarms.count}건</> : "장부 경보 요약을 읽지 못했습니다 — 0건으로 보지 않습니다."}</p>
    </div>
    <div className={tile}>
      <h2 className={head}>역할 lease · 릴리스</h2>
      {leases.length ? <dl className="grid items-baseline gap-x-2.5 gap-y-0.5 text-[13px] [grid-template-columns:auto_auto_1fr]">
        {leases.map(lease => { const host = leaseHost(lease.ownerInstanceId); return <div key={lease.role} className="contents">
          <dt className="font-mono">{lease.role}</dt>
          <dd className={`font-semibold ${host === "M3" ? "text-accent-ink" : host === "mini" ? "text-warn" : "text-fg-2"}`}>{host ?? "—"}{lease.ownerKind === "standby" ? <span className="font-normal text-fg-2"> 예비</span> : ""}</dd>
          <dd className="min-w-0 text-fg-2"><span className="font-mono">{lease.ownerRelease ? lease.ownerRelease.slice(0, 8) : "릴리스 없음"}</span> · 갱신 {secondsAgoLabel(lease.updatedAgoSeconds)}
            {lease.reason !== "ready" && <span className="text-warn"> · {READINESS_LABELS[lease.reason] ?? lease.reason}</span>}</dd>
        </div>; })}
      </dl> : <p className="text-[13px] text-fg-2">역할 lease 표를 읽지 못했습니다.</p>}
    </div>
  </section>;
}

import Link from "next/link";
import { ASSIGNMENT_STAGE_IDS, ASSIGNMENT_STAGES, type AssignmentStage } from "@/lib/llm/capacity-helpers";
import { ASSIGNMENT_STAGE_LABELS } from "@/lib/operations/admin-model-assignments";
import type { AssignmentReadSource } from "@/lib/operations/admin-assignment-source";
import { ageLabel, type ModelHelpersAdminView } from "@/lib/operations/admin-model-helpers";
import type { CatalogJobRegistrationView } from "@/lib/operations/admin-models-jobs";
import { secondsAgoLabel, type ModelContractLink } from "@/lib/operations/admin-models-view";
import { ModelStatusBadge } from "./ModelStageTable";
import { Chip } from "./SummaryTiles";

const TH = "whitespace-nowrap border-b border-line px-1.5 py-1 text-left text-[13px] font-semibold text-fg-2";
const TD = "border-b border-line px-1.5 py-1 align-top";
const mini = "grid min-w-0 gap-1 overflow-x-auto rounded-md border border-line px-2.5 py-2";
export type AssignmentSourceView = { flag: boolean; sources: Partial<Record<AssignmentStage, AssignmentReadSource>>; error: string | null };

/**
 * 접기 1(승인 시안) — 도우미·감시자(/admin/models/helpers 로더) · 배정 표 읽기 출처(lib/operations/admin-assignment-source.ts) · 새 잡 등록(jobs 표).
 * 요약 글은 summary 에 — 접힌 채로도 신호 나이·도우미 수·플래그·등록 수가 보인다.
 */
export function HelpersFold({ helpers, assignment, jobs, contracts }: { helpers: ModelHelpersAdminView | null; assignment: AssignmentSourceView; jobs: CatalogJobRegistrationView; contracts: readonly ModelContractLink[] }) {
  const supervisor = helpers?.supervisor ?? null, registered = jobs.rows.filter(row => row.registered).length;
  const signal = supervisor?.lastSignalAgeMs != null ? `감시자 신호 ${ageLabel(supervisor.lastSignalAgeMs)}` : "감시자 신호 없음";
  const stages = ASSIGNMENT_STAGE_IDS.filter(stage => ASSIGNMENT_STAGES[stage].routeId !== null);
  return <details id="assign" className="min-w-0 rounded-xl border border-line bg-bg-card scroll-mt-28 md:scroll-mt-16">
    <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-[14px] font-semibold">도우미 · 감시자 · 배정 표 출처 · 새 잡
      <span className="text-[13px] font-normal text-fg-2">{signal} · 도우미 {helpers?.helpers.length ?? "—"} · 플래그 MODEL_ASSIGNMENT_TABLE {assignment.flag ? "켜짐" : "꺼짐"} · 새 잡 {jobs.rows.length}개 중 {registered}개 등록</span></summary>
    <div className="grid gap-2.5 px-3 pb-3 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
      <div className={mini}>
        <h3 className="text-[13px] font-semibold text-fg-2">감시자(Oracle) · 도우미</h3>
        {!helpers ? <p className="text-[13px] text-down">도우미 상태를 읽지 못했습니다.</p> : <>
          {supervisor ? <p className="text-[13px]"><ModelStatusBadge status={supervisor.badge === "ok" ? "connected" : supervisor.badge === "late" ? "hold" : supervisor.badge === "off" ? "paused" : "down"}>{supervisor.badgeLabel}</ModelStatusBadge>
            <span className="ml-2 text-fg-2">{supervisor.location} · epoch <span className="font-mono">{supervisor.epoch}</span> · 신호 {supervisor.lastSignalAgeMs == null ? "없음" : ageLabel(supervisor.lastSignalAgeMs)}{supervisor.release ? <> · <span className="font-mono">{supervisor.release.slice(0, 8)}</span></> : ""}</span></p>
            : <p className="text-[13px] text-fg-2">감시자 제어 행이 없습니다.</p>}
          {helpers.helpers.length ? <table className="w-full border-collapse text-[13px]"><caption className="sr-only">도우미 배정과 지금 판정</caption>
            <thead><tr><th scope="col" className={TH}>장비 → 단계</th><th scope="col" className={TH}>모드</th><th scope="col" className={TH}>지금 판정</th><th scope="col" className={`${TH} text-right`}>입장(실제)</th></tr></thead>
            <tbody>{helpers.helpers.map(row => <tr key={row.assignmentId}><td className={TD}><code>{row.deviceId}</code> → {row.stageLabel}</td><td className={TD}>{row.modeLabel}</td>
              <td className={TD}>{row.verdictLabel}{row.verdict !== "help" && row.reasonLabel ? <span className="text-fg-2"> · {row.reasonLabel}</span> : ""}</td>
              <td className={`${TD} text-right font-mono tabular-nums`}>{row.gates.live ? `${row.gates.live.active} / ${row.gates.live.maxSlots}` : "—"}</td></tr>)}</tbody></table>
            : <p className="text-[13px] text-fg-2">도우미 배정이 없습니다.</p>}
          <p className="text-[13px] text-fg-2">자동 정지 {helpers.stops.length} · 돕는 중 {helpers.counts.help} · 섀도만 {helpers.counts.shadowOnly} · 쉬는 중 {helpers.counts.hold} · 섀도 결과는 판정에 쓰지 않음 · <Link href="/admin/models/helpers" prefetch={false} className="text-accent-ink underline underline-offset-[3px]">도우미 설정 →</Link></p></>}
      </div>
      <div className={mini}>
        <h3 className="text-[13px] font-semibold text-fg-2">배정 표 읽기 출처</h3>
        {assignment.error && <p className="text-[13px] text-warn">출처를 읽지 못해 설정(legacy)으로 봅니다 · {assignment.error}</p>}
        <table className="w-full border-collapse text-[13px]"><caption className="sr-only">단계별 모델 읽기 출처와 관리 계약 수</caption>
          <thead><tr><th scope="col" className={TH}>단계</th><th scope="col" className={TH}>읽기</th><th scope="col" className={TH}>계약</th></tr></thead>
          <tbody>{stages.map(stage => { const routeId = ASSIGNMENT_STAGES[stage].routeId!, count = contracts.filter(row => row.routeId === routeId).length, cli = [...ASSIGNMENT_STAGES[stage].transports].every(transport => transport === "cli");
            return <tr key={stage}><td className={TD}>{ASSIGNMENT_STAGE_LABELS[stage]}<span className="block font-mono text-fg-2">{routeId}</span></td>
              <td className={TD}>{assignment.sources[stage] === "table" ? <Chip tone="ok">표</Chip> : <Chip tone="plain">설정(legacy)</Chip>}</td>
              <td className={`${TD} tabular-nums`}>{cli ? <span className="text-fg-2">CLI · 계약 없음</span> : count ? `관리 계약 ${count}` : <span className="text-fg-2">계약 없음</span>}</td></tr>; })}</tbody></table>
        <p className="text-[13px] text-fg-2"><Link href="/admin/models/assignments" prefetch={false} className="text-accent-ink underline underline-offset-[3px]">모델 배정 표 →</Link> · <Link href="/admin/models/contracts" prefetch={false} className="text-accent-ink underline underline-offset-[3px]">계약 관리 →</Link></p>
      </div>
      <div className={mini}>
        <h3 className="text-[13px] font-semibold text-fg-2">새 잡 {jobs.rows.length}개 · 스케줄러 등록</h3>
        {jobs.error && <p className="text-[13px] text-down">jobs 표를 읽지 못했습니다 · {jobs.error}</p>}
        <table className="w-full border-collapse text-[13px]"><caption className="sr-only">분해된 reviewer 잡의 등록 상태</caption>
          <thead><tr><th scope="col" className={TH}>잡</th><th scope="col" className={TH}>상태</th><th scope="col" className={TH}>다음 예정 · 마지막 실행</th></tr></thead>
          <tbody>{jobs.rows.map(row => <tr key={row.name}><td className={TD}><code>{row.name}</code></td>
            <td className={TD}>{row.registered ? <ModelStatusBadge status="connected">등록됨</ModelStatusBadge> : <ModelStatusBadge status="hold">미등록</ModelStatusBadge>}{row.lastError && <span className="block break-all text-down" title={row.lastError}>마지막 오류 있음</span>}</td>
            <td className={`${TD} tabular-nums`}>{!row.registered ? <span className="text-fg-2">스케줄러 먼저 배포</span> : <>{row.nextInSeconds === null ? "예정 없음" : row.nextInSeconds <= 0 ? `${secondsAgoLabel(-row.nextInSeconds).replace(" 전", "")} 뒤` : `${secondsAgoLabel(row.nextInSeconds).replace(" 전", "")} 지남`}
              <span className="block text-fg-2">{row.lastRunAgoSeconds === null ? "실행 기록 없음" : `마지막 실행 ${secondsAgoLabel(row.lastRunAgoSeconds)}`}{row.runs !== null ? ` · ${row.runs}회` : ""}</span></>}</td></tr>)}</tbody></table>
        <p className="text-[13px] text-fg-2">스케줄러를 먼저 배포하지 않으면 크롤러 게이트가 기다리다 시간 초과.</p>
      </div>
    </div>
  </details>;
}

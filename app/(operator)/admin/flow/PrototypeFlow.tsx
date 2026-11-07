"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ageText, type Conveyor, type Station } from "@/lib/operations/conveyor-model";
import type { StationLlm, LlmStationKey } from "@/lib/operations/conveyor-llm";
import { flowStageBadge } from "@/lib/operations/flow-stage-state";
import { flowModelStage } from "@/lib/operations/flow-model-catalog";
import { LISTING_NOTE, listingExclusionText } from "@/lib/operations/public-listing-model";
import { ConfiguredModelRows, LiveModelRows, modelCallCount, RecentModelRows } from "./FlowModels";
import { FlowUnknownReviews } from "./FlowUnknownReviews";
import { FlowPromptButton } from "./FlowPrompt";
import type { OperatorDesk } from "@/lib/operations/operator-desk-model";
import { flowRankLinesFor, type FlowRankEditor } from "@/lib/operations/flow-rank-editor";
import { STATION_JOBS } from "@/lib/operations/flow-response";
import { JobControl } from "../status/JobControl";
import { FlowBoard, jobObservation, STATION_ROLE, type FlowControls } from "./FlowBoard";
import { RankDrawer } from "./RankDrawer";
import { clock, DataTable, Facts, number, Panel, PrototypeSpark, ReadStamp, Stat, Tag } from "./PrototypeParts";
import "./flow-layout.css";

type Range = "5m" | "1h" | "24h";
const stageTargets: Record<Station["key"] | "public", string> = {
  discover: "/admin/flow?tab=diagnostics", fetch: "/admin/flow?tab=diagnostics",
  judge: "/admin/review?tab=all&stage=judge", first: "/admin/review?tab=all&stage=ai",
  second: "/admin/review?tab=all&stage=second", profile: "/admin/review?tab=publish&stage=publish",
  publish: "/admin/review?tab=publish&stage=publish", keywords: "/admin/status?tab=diagnostics", public: "/admin/products",
};
const tone = (value: Station["tone"]) => value === "jam" ? "red" : value === "slow" ? "amber" : value === "flow" ? "green" : "gray";
const result = (station: Station, range: Range) => range === "5m" ? station.done5m : range === "1h" ? station.doneHour : station.done24h;
const rangeLabel = (range: Range) => range === "5m" ? "5분" : range === "1h" ? "1시간" : "24시간";
const stageLabel = (station: Station) => flowModelStage(station.key)?.label ?? station.label;
const stagePhase = (key: Station["key"]) => flowModelStage(key)?.phase ?? "";
const cardPromptStage = (key: Station["key"] | "public") => key === "first" || key === "second" || key === "profile" || key === "publish" || key === "keywords" ? key : null;
const humanStageLabel = flowModelStage("human")?.label ?? "사람 확인 · AI 보조";
const publicStageLabel = flowModelStage("public")?.label ?? "공개 완료";
const publicStagePhase = flowModelStage("public")?.phase ?? "결과";
const REQUEST_KEYS = ["takedown", "introRequest", "feedback", "makerReply", "contact"];
export function requestCount(desk: Pick<OperatorDesk, "decisions"> | null, reactionRequests: number | null = null): number | null {
  if (!desk?.decisions || reactionRequests === null) return null;
  const counts = REQUEST_KEYS.map(key => desk.decisions!.sections.find(section => section.key === key)?.count ?? (desk.decisions!.clear.some(section => section.key === key) ? 0 : null));
  return counts.some(value => value === null) ? null : counts.reduce<number>((sum, value) => sum + value!, reactionRequests);
}
function Workers({ desk }: { desk: OperatorDesk | null }) {
  return <><div className="worker-grid">{["crawler", "reviewer", "publisher", "text", "maintenance"].map(role => {
    const row = desk?.window?.roles.find(value => value.role === role);
    return <div className="worker-card" key={role}><Tag tone={!row ? "gray" : row.ok ? "green" : "amber"}>{row?.text ?? "현재 미확인"}</Tag><b>{role}</b><small>{row?.host ?? "소유 장비 미확인"}</small><small>역할 소유 관측 · 실행 호출 수와 별도</small><small>관측 {clock(desk?.measuredAt)}</small></div>;
  })}</div><div className="flex mt small muted"><span>scheduler {desk?.window ? desk.window.schedulerAlarm ? "경보" : "경보 없음" : "미확인"}</span><span>· 역할 소유와 실제 업무 진척을 별도로 확인</span><span className="spacer">모델 접수 {desk?.window?.admission?.toUpperCase() ?? "미확인"}</span></div></>;
}
function ChangeTable({ desk }: { desk: OperatorDesk | null }) {
  return <DataTable heads={["시각·주체", "대상", "동작", "결과", "복구·근거"]} note="감사 기록을 덧붙여 보존합니다. 이전·이후 값과 사유 원문은 운영 기록에서 확인합니다.">
    {desk?.changes?.length ? desk.changes.map(change => <tr key={change.id}><td className="nowrap">{clock(change.at)}<p>{change.actor} · #{change.id}</p></td><td>{change.target}</td><td>{change.label}</td><td><Tag tone={change.ok ? "green" : "red"}>{change.ok ? "기록됨" : "실패"}</Tag></td><td>{change.undo.text}<p><Link prefetch={false} className="text-button" href={change.undo.href ?? `/admin/activity?target=${encodeURIComponent(change.target)}`}>원본 기록·조치 →</Link></p></td></tr>) : <tr><td colSpan={5}>{desk?.changes ? "최근 설정 변경 기록이 없습니다." : "설정 변경 기록을 읽지 못했습니다."}</td></tr>}
  </DataTable>;
}

export function PrototypeFlowChanges({ desk }: { desk: OperatorDesk | null }) {
  return <div className="stack"><div className="grid three"><Stat label="부재 중 공개" value={number(desk?.away?.published)} foot={`${clock(desk?.away?.since)} 이후`} tone="good" /><Stat label="새 사람 확인" value={number(desk?.away?.newHolds)} foot="해당 기간 새 보류 후보" tone="warn" /><Stat label="최근 설정·제어 변경" value={desk?.changes ? number(desk.changes.length) : "—"} foot="최근 기록 표본 · 최대 8건" /></div><Panel title="최근 바뀐 설정·제어" tool={<Link prefetch={false} className="text-button" href="/admin/activity">모든 운영 기록 →</Link>}><ChangeTable desk={desk} /></Panel><Panel title="공개·판정·요청 타임라인" tool={<ReadStamp at={desk?.measuredAt} />}><ol className="timeline">{desk?.away?.othersChanges.map(change => <li key={change.id} className={change.ok ? "" : "warn"}><b>{change.target} · {change.label}</b><small>{clock(change.at)} · {change.actor} · #{change.id}</small><p>{change.undo.text}</p></li>)}{!desk?.away && <li>부재 중 기록을 읽지 못했습니다.</li>}{desk?.away && !desk.away.othersChanges.length && <li>이 기간 다른 주체의 설정 변경 기록이 없습니다.</li>}</ol><p className="small muted mt">개별 공개·판정·요청 이력 원문은 해당 업무 화면에서 확인합니다.</p></Panel></div>;
}

export function PrototypeFlowAway({ desk }: { desk: OperatorDesk | null }) {
  return <ul className="list-rows"><li><span className="dot" /><div className="main"><b>새 프로젝트 {number(desk?.away?.published)}건 공개</b><p>{clock(desk?.away?.since)} 이후 실제 발행 결과</p></div><Tag tone="green">업무 결과</Tag></li><li><span className="dot amber" /><div className="main"><b>새 보류 {number(desk?.away?.newHolds)}건</b><p>부재 중 보류로 남은 후보</p></div><Link prefetch={false} className="text-button" href="/admin/review">검수 →</Link></li><li><span className="dot" /><div className="main"><b>최근 설정·제어 변경</b><p>{desk?.changes?.[0] ? `${desk.changes[0].target} · ${desk.changes[0].label}` : "최근 변경 미확인"}</p></div><Link prefetch={false} className="text-button" href="/admin/flow?tab=changes">변경 비교 →</Link></li></ul>;
}

function HumanWork({ data, controls, modelSettings }: { data: Conveyor; controls: FlowControls; modelSettings?: ReactNode }) {
  const human = data.human;
  const llm = human?.llm;
  return <section className="panel flow-human-work" id="flow-human-work" aria-labelledby="flow-human-title">
    <div className="panel-head"><div><h3 id="flow-human-title">{humanStageLabel}</h3><p>자동 검수에서 남은 보류 → 사람 판단·확정 → 승인 시 준비·발행 / 반려 시 종료</p></div>
      <div className="right"><FlowPromptButton stage="human" /><Link prefetch={false} className="text-button" href="/admin/models#flow-stage-human">모델·단계 설정 →</Link><Tag tone={human?.waiting ? "amber" : human ? "green" : "gray"}>{human ? human.waiting ? "판단 대기" : "대기 없음" : "미확인"}</Tag><ReadStamp at={data.measuredAt} /></div></div>
    <div className="panel-body flow-human-grid">
      <section className="flow-human-decisions"><h4>사람이 처리할 일</h4>
        <Facts rows={[["직접 판단", `${number(human?.direct)}건`], ["확정 필요", `${number(human?.agreed)}건`],
          ["24시간 결정", `${number(human?.decided24h)}건`], ["최장 대기", human?.oldestDays == null ? "미확인" : `${number(human.oldestDays)}일`]]} />
        <p className="small muted">AI 결론 대기 {number(human?.awaitingAi)} · 2차 결론 대기 {number(human?.awaitingSecond)}건은 직접 판단 수와 분리합니다.</p>
        <div className="flex"><Link prefetch={false} className="button small" href="/admin/review?tab=human">판단·승인·반려 →</Link>
          <Link prefetch={false} className="text-button" href="/admin/review?stage=rejected">반려 기록 →</Link></div>
      </section>
      <section className="flow-human-assist"><h4>AI 위임·재심사 실행</h4>
        {llm?.kind === "llm" ? <ul className="flow-human-jobs">{llm.tasks.map(task => {
          const job = STATION_JOBS.human.find(row => row.job === ({ "human-review": "human-deepseek-review", "split-confirm": "split-confirm", "split-tiebreak": "split-tiebreak", "held-review-retry": "held-qwen-retry" } as Record<string, string>)[task.task]);
          const state = job ? controls.jobs[job.job] : null;
          const subset: StationLlm = { ...llm, tasks: [task], head: task };
          const running = modelCallCount(subset);
          return <li key={task.task}><div className="flow-human-job-head"><b>{task.label}</b><Tag tone={state?.paused ? "gray" : state?.lastError ? "amber" : running ? "green" : "gray"}>
            {state?.paused ? running === null || running > 0 || state.execution === "locked" ? "신규 중지" : "일시정지"
              : state?.lastError ? "오류 확인" : running === null ? "호출 미확인" : running > 0 ? "전송 중" : state ? "장부 대기" : "미확인"}</Tag></div>
            <span className="flow-model-note">현재 설정</span>
            <ConfiguredModelRows llm={subset} compact />
            <span className="flow-model-note">현재 호출</span>
            <LiveModelRows llm={subset} compact />
            {job && <Link prefetch={false} className="text-button small" href={`/admin/status?tab=jobs&job=${job.job}`}>작업 상태·제어 →</Link>}
          </li>;
        })}</ul> : <p className="small muted">AI 보조 실행 관측을 읽지 못했습니다.</p>}
        <details className="flow-human-settings"><summary className="text-button">AI 보조 실행 모델 지정</summary>
          {modelSettings ?? <Link prefetch={false} className="button small" href="/admin/models?advanced=1#model-settings">실행 모델 설정 →</Link>}
          <Link prefetch={false} className="text-button small" href="/admin/models/human#human-review">사람 확인 모델 설정 →</Link>
        </details>
      </section>
    </div>
  </section>;
}

export function PrototypeFlow({ data, desk, controls, editor, tab = "flow", userRequests, reactionRequests = null, awayContent, advancedContent, overviewContent, socialContent, humanModelSettings }: { data: Conveyor; desk: OperatorDesk | null; controls: FlowControls; editor: FlowRankEditor | null; tab?: string; reactionRequests?: number | null; userRequests?: { count: number | null; knownCount: number; failed: number }; awayContent?: ReactNode; advancedContent?: ReactNode; overviewContent?: ReactNode; socialContent?: ReactNode; humanModelSettings?: ReactNode }) {
  const [range, setRange] = useState<Range>("1h");
  const [selected, setSelected] = useState<Station["key"] | "public">(data.bottleneck && data.bottleneck !== "human" ? data.bottleneck : "second");
  const [changing, setChanging] = useState<LlmStationKey | null>(null);
  const current = data.stations.find(station => station.key === selected) ?? null;
  const observation = current ? jobObservation(current.key, controls) : null;
  const owner = current ? desk?.window?.roles.find(role => role.role === STATION_ROLE[current.key]) : null;
  const admission = desk?.window?.admission?.toUpperCase() ?? "미확인";
  const ledger = desk?.equipment?.ledger;
  const requests = userRequests ? userRequests.count : requestCount(desk, reactionRequests);
  const main = [...data.stations.filter(station => station.key !== "keywords"), null, data.stations.find(station => station.key === "keywords")!];
  const pickedTone = current ? tone(current.tone) : data.published === null ? "gray" : "green";
  const listingGap = listingExclusionText(data.listing);
  const pickedBadge = current ? flowStageBadge(current, STATION_JOBS[current.key].map(job => controls.jobs[job.job]), desk?.window?.admission ?? null) : null;
  const changeModels = current && flowRankLinesFor(editor, current.key).length > 0;
  const actions = <div className="flex"><FlowUnknownReviews /><Link prefetch={false} className="button" href="/admin/status">자동 파이프라인 제어</Link><Link prefetch={false} className="button" href="/admin/models">모델 접수 {admission}</Link></div>;
  const jobs = Object.entries(controls.jobs);
  const advanced = <details className="panel" id="flow-advanced"><summary>고급 전체 흐름·장애 대응·모든 제어</summary><div className="panel-body">{advancedContent ?? <FlowBoard data={data} desk={desk} controls={controls} editor={editor} />}</div></details>;

  if (tab === "diagnostics") return <div className="stack"><div className="flow-observation-row"><div className="flow-observation-meta"><ReadStamp at={data.measuredAt} /></div>{actions}</div><div className="grid four"><Stat status label="흐름 관측" value={data.stations.some(station => station.tone === "unknown") ? "일부 미확인" : "조회됨"} foot="조회 성공과 처리 정상은 별도" /><Stat label="역할 상태" value={desk?.window ? `${desk.window.roles.filter(role => role.ok).length} / ${desk.window.roles.length}` : "—"} foot="주·예비 소유 관측" /><Stat label="중지한 잡" value={jobs.length ? number(jobs.filter(([, state]) => state.paused).length) : "—"} foot="이 화면에서 읽는 잡 범위" /><Stat status label="모델 접수" value={admission} foot="수집·워커 중지와 다른 범위" /></div>
    <Panel title="수집 소스별 상태" tool={<Link prefetch={false} className="button small" href="/admin/status?tab=crawlers">원본 공급 조절 →</Link>}><DataTable heads={["소스", "상태", "새 후보 / 1시간", "마지막 성공", "제어"]}>{STATION_JOBS.discover.map(source => { const state = controls.jobs[source.job]; return <tr key={source.job}><td><b>{source.label}</b><p>{source.job}</p></td><td><Tag tone={state?.lastError ? "red" : "gray"}>{state?.runtimeLabel ?? "미확인"}</Tag></td><td>—<p>소스별 완료량 미집계</p></td><td>{clock(state?.lastSuccessAt)}</td><td><Link prefetch={false} className="button small" href={`/admin/status?tab=jobs&job=${source.job}`}>상세·제어 →</Link></td></tr>; })}</DataTable></Panel>
    <Panel title="역할 소유·워커 진행" tool={<ReadStamp at={desk?.measuredAt} />}><Workers desk={desk} /></Panel>
    <Panel title="작업별 실행과 제어"><DataTable heads={["작업", "담당", "현재 상태", "최근 성공", "최근 관측", "조치"]}>{jobs.map(([name, state]) => <tr key={name}><td><code>{name}</code></td><td>{data.stations.find(station => STATION_JOBS[station.key].some(job => job.job === name))?.label ?? "공개 후·보조"}</td><td><Tag tone={state.lastError ? "red" : "gray"}>{state.runtimeLabel ?? "미확인"}</Tag></td><td>{clock(state.lastSuccessAt)}</td><td>{clock(state.workerSeenAt)}</td><td>{controls.csrf ? <details><summary className="text-button">{state.paused ? "재개" : "멈춤"}…</summary><JobControl name={name} paused={state.paused} notBefore={state.notBefore} version={state.version} csrf={controls.csrf} /></details> : <Link prefetch={false} className="text-button" href={`/admin/status?tab=jobs&job=${name}`}>작업 상세 →</Link>}</td></tr>)}</DataTable></Panel>
    <Panel title="상세 진단"><div className="grid three"><Link prefetch={false} className="notice" href="/admin/status?tab=diagnostics">검색 프로필·검수·색인 사본의 반영 확인 →</Link><Link prefetch={false} className="notice" href="/admin/products?tab=translations">언어별 번역 저장·실패 확인 →</Link><Link prefetch={false} className="notice" href="/admin/models?tab=history">모델 장부·실제 종료 근거 확인 →</Link></div></Panel>{advanced}</div>;

  if (tab === "changes") return <PrototypeFlowChanges desk={desk} />;

  return <div className="stack home-workspace flow-workspace"><div className="scenario-strip flow-observation-row"><div className="flow-observation-meta"><span>실제 운영 관측 · 기존 자동 갱신 주기 · KST</span><ReadStamp at={data.measuredAt} /></div>{actions}</div>
    <div className={`callout ${tone(data.headline.tone)}`}><div className="flex"><span className="callout-icon">!</span><div><h3>{data.headline.title}</h3><p>{data.headline.detail || "관측 시각·업무 완료와 모델 호출 상태를 함께 확인하세요."}</p></div></div><Link prefetch={false} className="button" href="/admin/models">원인·호출 확인 →</Link></div>
    {overviewContent ?? <div className="grid four home-kpis"><Stat label="최근 1시간 공개" value={number(data.publishedHour)} foot="실제 발행 결과 기준" tone="good" spark={data.stations.find(station => station.key === "publish")?.spark} /><Stat label="사람이 판단할 후보" value={<>{number(data.human?.waiting)}<small>건</small></>} foot={`직접 판단 ${number(data.human?.direct)} · 확정 ${number(data.human?.agreed)} · 자동 대기 제외`} /><Stat label="열린 사용자 요청" value={<>{number(requests)}<small>건</small></>} foot={userRequests?.failed ? `확인된 ${number(userRequests.knownCount)}건 · 일부 조회 실패` : requests === null ? "일부 요청 집계를 확인하지 못함" : "내림·소개 수정·문의·사용자 글 3종"} tone={requests ? "warn" : ""} /><Stat label="LLM 확인 필요" value={ledger && ledger.status !== "unknown" ? number(ledger.reviewCount) : "—"} foot="미확정 검토 · 물리 점유와 별도" tone={ledger?.reviewCount ? "bad" : ""} /></div>}
    <section className="panel flow-overview"><div className="panel-head"><div><h3>자동 수집의 전체 흐름</h3><p>단계를 선택하면 대기·실행·모델·담당 워커와 가능한 조치가 연결됩니다.</p></div><div className="right"><ReadStamp at={data.measuredAt} /><div className="segmented" aria-label="집계 기간">{(["5m", "1h", "24h"] as const).map(value => <button key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)}>{rangeLabel(value)}</button>)}</div></div></div>
      <div className="flow-conveyor-scroll" role="region" aria-label="자동 수집 9단계 흐름" tabIndex={0}>
        <div className="flow-phases"><span>01 수집</span><span>02 검수 · 정책에 따른 자동 승인 분기</span><span>03 준비·발행</span><span>04 공개·후처리</span></div>
        <div className="flow-grid">{main.map((station, index) => {
          const badge = station ? flowStageBadge(station, STATION_JOBS[station.key].map(job => controls.jobs[job.job]), desk?.window?.admission ?? null)
            : { label: data.publishedHour === null ? "미확인" : "결과 관측", tone: data.publishedHour === null ? "gray" : "green", why: "실제 발행 결과입니다." };
          const promptStage = cardPromptStage(station?.key ?? "public");
          const cardSelected = selected === (station?.key ?? "public");
          return <div className="flow-card" key={station?.key ?? "public"} data-id={station?.key ?? "public"}
            data-tone={station ? tone(station.tone) : data.publishedHour === null ? "gray" : "green"} data-selected={cardSelected ? "true" : "false"}>
            <button className="flow-prompt-card-select" type="button" aria-pressed={cardSelected}
              aria-controls="prototype-selected-stage" onClick={() => setSelected(station?.key ?? "public")}>
              <div className="flow-card-top"><div className="flow-step">{String(index + 1).padStart(2, "0")} / {station ? stagePhase(station.key) : publicStagePhase}</div>
                <span className={`flow-status ${badge.tone}`} title={badge.why}>{badge.label}</span></div>
              <div className="flow-name">{station ? stageLabel(station) : publicStageLabel}</div>
              <div className="flow-value mono"><span className="flow-number">{number(station ? station.key === "discover" ? station.doneHour : station.waiting : data.publishedHour)}</span>
                <small>{station ? station.key === "discover" ? "신규 / 1h" : station.key === "keywords" ? "작업" : "후보" : "공개 / 1h"}</small></div>
              <div className="flow-state">{station?.status ?? (data.publishedHour === null ? "현재 미확인" : "발행 결과 관측")}</div>
              <div className="flow-trend"><PrototypeSpark values={station ? station.spark : data.stations.find(row => row.key === "publish")?.spark} label={`${station?.label ?? "공개"} 실제 시간별 추이`} /></div>
              <div className="flow-rate">{rangeLabel(range)} 완료 {number(station ? result(station, range) : range === "1h" ? data.publishedHour : result(data.stations.find(row => row.key === "publish")!, range))}{station?.unit ?? "건"}</div>
            </button>
            <div className="flow-model">{station ? <><LiveModelRows llm={station.llm} compact />
              {modelCallCount(station.llm) === 0 && station.llm?.kind === "llm" && <span className="flow-model-config"><span className="flow-model-note">현재 설정</span><ConfiguredModelRows llm={station.llm} compact /></span>}</> : "목록 반영 · LLM 없음"}</div>
            {promptStage && <div className="flow-card-prompt"><FlowPromptButton stage={promptStage} /></div>}
          </div>;
        })}</div>
      </div>
      <div className="flow-branches"><Link prefetch={false} className="branch flow-branch-human" href="#flow-human-work"><strong>↳ {humanStageLabel}</strong><small>갈림·근거 부족·확정 필요</small><span className="branch-count mono">{number(data.human?.waiting)}</span></Link><Link prefetch={false} className="branch" href="/admin/review?stage=rejected"><strong>↳ 후보 반려</strong><small>공개 전 판정 기록 · 누적</small><span className="branch-count mono">{number(data.rejected)}</span></Link><Link prefetch={false} className="branch" href="/admin/products?tab=quality"><strong>↳ 공개 후 품질관리</strong><small>감사·생존·사용자 요청</small><span className="branch-count">→</span></Link></div><div className="panel-foot"><span>공개 완료 뒤의 검색·번역은 별도 후처리 분기입니다. 후보·2차 표·후처리 수를 합산하지 않습니다.</span><span>— 는 미집계·확인 불가</span></div></section>
    <HumanWork data={data} controls={controls} modelSettings={humanModelSettings} />
    <Panel id="prototype-selected-stage" title={<><span className="eyebrow">선택한 단계</span> &nbsp; {current ? stageLabel(current) : publicStageLabel}</>} tool={<><Tag tone={pickedBadge?.tone ?? pickedTone}>{pickedBadge?.label ?? "발행 결과"}</Tag><ReadStamp at={data.measuredAt} /></>}><div className="stage-detail"><div className="stage-detail-main"><div className="detail-summary"><div className="mini-stat"><span>현재 대기</span><b className="mono">{number(current?.waiting)}</b><small>{current?.key === "second" ? "후보 · 완료는 표 수" : "현재 잔량"}</small></div><div className="mini-stat"><span>장부 전송 중</span><b className="mono">{current ? number(modelCallCount(current.llm)) : "—"}</b><small>예약·미확정 제외 · 장부 밖 호출 별도</small></div><div className="mini-stat"><span>최장 대기</span><b className="mono">{current?.waiting ? ageText(current.oldestMinutes) : "—"}</b><small>미집계와 일시 중지를 구분</small></div><div className="mini-stat"><span>최근 5분 완료</span><b className="mono">{number(current?.done5m)}</b><small>{current?.unit ?? "발행 결과 기준"}</small></div></div>
      <div className={`cause ${pickedTone}`}><div className="cause-head"><Tag tone={pickedTone}>{current?.status ?? "공개 완료"}</Tag><b>왜 이 상태인가?</b></div><p>{current?.reason ?? current?.what ?? "발행 결과를 기준으로 공개 반영을 확인합니다. 공개 후 검색·번역 완료는 별도입니다."}</p></div>
      <div className="stage-context">
        <section className="stage-context-models" aria-label="선택한 단계의 모델 사용과 설정">
          <h4>모델 사용·설정</h4>
          <Facts rows={[["현재 호출", current ? <LiveModelRows llm={current.llm} /> : "공개 결과 · LLM 호출 없음"], ["현재 설정", current ? <ConfiguredModelRows llm={current.llm} /> : "해당 없음"], ["최근 1시간", current ? <RecentModelRows llm={current.llm} /> : "해당 없음"]]} />
        </section>
        <section className="stage-context-runtime" aria-label="선택한 단계의 담당과 실행 관측">
          <h4>담당·실행 관측</h4>
          <Facts rows={[["담당", current ? `${STATION_ROLE[current.key]} · ${owner?.host ?? "장비 미확인"} · ${owner?.text ?? "역할 상태 미확인"}` : "공개 목록·프로젝트 상세"], ["작업 / 소비자", current ? `${STATION_JOBS[current.key].map(job => job.job).join(" · ")}${current.key === "second" ? " + AI2 소비자는 별도 관측·제어" : ""}` : "실제 발행 결과"], ["잡 실행 관측", observation ? `${observation.running === null ? "미확인" : `${observation.running}개 · 유효 잠금 기준`}${observation.stale ? " · 오래된 잠금 있음" : ""}` : "해당 없음"], ["마지막 잡 성공", clock(observation?.lastSuccessAt)]]} />
        </section>
      </div>
      {current?.key === "keywords" && <div className="notice mt small"><b>현재 수치는 검색 키워드의 대기·완료입니다.</b><br />공개 후 소개·번역의 실제 사용: <RecentModelRows llm={data.supportLlm ?? null} /><br />번역·소개 검수의 완료는 언어별·업무별 원본에서 별도로 확인합니다.<div className="flow-prompt-support"><FlowPromptButton stage="support" /></div></div>}
      <div className="flex mt stage-detail-links"><Link prefetch={false} className="button small" href={stageTargets[selected]}>{selected === "public" ? "전체 프로젝트 보기" : current?.key === "keywords" ? "검색 후처리 진단" : current?.key === "discover" || current?.key === "fetch" ? "수집·작업 진단" : "이 단계 대상 보기"} →</Link><Link prefetch={false} className="button small" href={`/admin/models#flow-stage-${selected}`}>실제 호출·모델 →</Link><Link prefetch={false} className="text-button" href="/admin/activity?group=settings">관련 설정 변경 →</Link></div></div>
      <aside className="control-box"><h4>이 단계의 제어</h4><p>다음 실행부터 멈추거나 재개합니다. 진행 중인 호출은 실제 종료까지 관측합니다.</p>{current ? STATION_JOBS[current.key].map(job => { const state = controls.jobs[job.job]; return <details key={job.job}><summary className="button">{job.label} {state?.paused ? "재개" : "멈춤"}…</summary>{state && controls.csrf ? <JobControl name={job.job} paused={state.paused} notBefore={state.notBefore} version={state.version} csrf={controls.csrf} /> : <p className="small muted">이 화면에서는 제어할 수 없습니다. <Link prefetch={false} href={`/admin/status?tab=jobs&job=${job.job}`}>작업 상세 →</Link></p>}</details>; }) : <Link prefetch={false} className="button" href="/admin/products">프로젝트 관리 →</Link>}{changeModels && current ? <button className="button" type="button" onClick={() => setChanging(current.key)}>모델 순위·적용 출처</button> : <Link prefetch={false} className="button" href="/admin/models?tab=tasks">모델 순위·적용 출처 →</Link>}<div className="scope"><b>영향 범위</b><br />{current?.key === "second" ? "second-review 잡만 제어합니다. AI2 소비자 전체의 중단을 보장하지 않습니다." : "선택한 잡만 제어합니다. 전역 자동 파이프라인 관문·모델 DRAIN은 다른 범위입니다."}</div></aside></div></Panel>
    {socialContent}
    <div className="grid two"><Panel title="먼저 처리할 일" tool={<Link prefetch={false} className="text-button" href="/admin/requests">요청함 전체 →</Link>}><ul className="list-rows">{desk?.decisions?.sections.slice(0, 4).map(section => <li key={section.key}><span className={`dot ${section.tone === "critical" ? "red" : "amber"}`} /><div className="main"><b>{section.title} · {number(section.count)}건</b><p>{section.rows[0]?.name ? `${section.rows[0].name} · ${section.rows[0].why}` : section.hint}</p></div><Link prefetch={false} className="text-button" href={section.href}>{section.action} →</Link></li>)}{!desk?.decisions && <li>처리할 일을 읽지 못했습니다.</li>}{desk?.decisions && !desk.decisions.sections.length && <li>현재 집계된 처리 대상이 없습니다.</li>}</ul></Panel><Panel title="자리 비운 사이">{awayContent ?? <PrototypeFlowAway desk={desk} />}</Panel></div>
    <Panel id="prototype-stage-observations" title="단계별 처리·관측 상세" tool={<ReadStamp at={data.measuredAt} />}><DataTable heads={["단계", "대기 / 실행 잡", "선택 기간 완료", "가장 오래", "실제 사용 모델 / 담당", "최근 성공·관측"]} note="모델 호출 종료와 업무 반영 완료는 따로 확인합니다. 실행 잡 수는 유효 잠금 관측이며 모델 실행 수가 아닙니다.">{main.map(station => { if (!station) return <tr key="public"><td><button className="text-button" onClick={() => setSelected("public")}>{publicStageLabel}</button></td><td>해당 없음<p>공개 상태 {number(data.listing?.publicStatus ?? data.published)} · 목록 노출 {number(data.listing?.listed)}</p>{listingGap && <p title={LISTING_NOTE}>목록에서 빠짐: {listingGap}</p>}</td><td className="mono">{range === "1h" && data.publishedHour != null ? `${number(data.publishedHour)}건` : "—"}<p>공개 완료 · 최근 1시간 집계</p></td><td>해당 없음</td><td>LLM 없음<p>공개 목록 반영 결과</p></td><td>{clock(jobObservation("publish", controls).lastSuccessAt)}<p>발행 잡 최근 성공</p></td></tr>; const observed = jobObservation(station.key, controls); return <tr key={station.key}><td><button className="text-button" onClick={() => setSelected(station.key)}>{stageLabel(station)}</button></td><td>{number(station.waiting)} / {number(observed.running)}<p>{station.key === "second" ? "후보 / 잡 · AI2 소비자 별도" : "대기 / 잡 관측"}</p></td><td className="mono">{number(result(station, range))}{station.unit}</td><td>{station.waiting ? ageText(station.oldestMinutes) : "—"}</td><td><LiveModelRows llm={station.llm} /><p>{STATION_ROLE[station.key]}</p></td><td>{clock(observed.lastSuccessAt)}<p>{station.reason ?? station.status}</p></td></tr>; })}</DataTable></Panel>
    <Panel title="역할·점검 창" tool={<><Tag tone={admission === "OPEN" ? "green" : "amber"}>{admission}</Tag><Link prefetch={false} className="text-button" href="/admin/models?tab=capacity">용량·장비 →</Link></>}><Workers desk={desk} /></Panel>{advanced}
    {changing && editor && <RankDrawer editor={editor} lines={flowRankLinesFor(editor, changing)} title={changing === "profile" ? "소개 준비·번역·소개 검수" : data.stations.find(station => station.key === changing)?.label ?? "모델 순위"} secondWaiting={data.stations.find(station => station.key === "second")?.waiting ?? null} onClose={() => setChanging(null)} />}
  </div>;
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { AI_CLI_TOOL_LABELS } from "@/lib/llm/ai-tasks";
import { formatCount, formatKst } from "@/lib/operations/console-tasks";
import { formatSeconds, modelCompareHref, modelHref, modelKeyText, modelMaxTokens, type ModelConsoleRow, type ModelDeviceState }
  from "@/lib/operations/model-console";
import type { ModelConsoleRead } from "@/lib/operations/model-console-read";
import { SAMPLE_COMPARE_SUPPORTED } from "@/lib/operations/model-sample-compare";
import { MODELS_DASHBOARD_HREF } from "../../workspace-navigation";
import { ModelSettingsForm } from "./ModelSettingsForm";
import { ModelAttachForm } from "./ModelAttachForm";
import type { FlowRankEditor } from "@/lib/operations/flow-rank-editor";
import type { PoolHelpContext } from "@/lib/operations/pool-help";
import { ModelAddFlow, type ModelAddStep } from "../new/ModelAddFlow";
import { aiModelDisplayName } from "@/lib/operations/admin-ai-tasks";
import { ModelDrawer } from "./ModelDrawer";
import { modelDuplicateAssignments, modelRowsFor, modelStatusForUses, modelUsageText, type ModelSort } from "./model-console-view";
import "./model-console.css";

/** Safe reads used by both the standalone attachment form and the shared task editor. */
export type ModelAttachData = { editor: FlowRankEditor | null; poolHelp: PoolHelpContext | null };
export type ModelTaskUse = Readonly<{ key: string; label: string; place: string; href?: string; paused?: boolean }>;
export type ModelConsoleProps = {
  data: ModelConsoleRead; selected: string | null; readOnly: boolean; attach?: ModelAttachData | null;
  /** Unified task reads include settings managed outside the rank table. */
  taskUses?: Readonly<Record<string, readonly ModelTaskUse[]>>;
  /** An empty or partial map cannot prove that a model is unused. */
  taskUsesReadable?: boolean;
  duplicateCount?: number | null;
  onModelOpen?: (connectionId: string) => void; onModelClose?: () => void;
  onTaskOpen?: (taskKey: string, attachConnectionId?: string) => void;
  onModelScope?: (connectionId: string) => void; onReviewDuplicates?: () => void; onAdvancedOpen?: () => void;
};

/** Model inventory and detail drawer. Writes stay in the existing connection/device forms. */
export function ModelConsole({ data, selected, readOnly, attach = null, taskUses, taskUsesReadable, duplicateCount,
  onModelOpen, onModelClose, onTaskOpen, onModelScope, onReviewDuplicates, onAdvancedOpen }: ModelConsoleProps) {
  const router = useRouter();
  const [sort, setSort] = useState<ModelSort>("usage");
  const [unused, setUnused] = useState(false);
  const [adding, setAdding] = useState<{ step: ModelAddStep; id: string | null } | null>(null);
  const { view, admission } = data;
  const row = selected ? view.rows.find(entry => entry.id === selected) ?? null : null;
  const added = adding?.id ? view.rows.find(entry => entry.id === adding.id) ?? null : null;
  // Unknown reads are never represented by a reassuring zero.
  const usesKnown = taskUsesReadable ?? (!!taskUses || !view.errors.some(error => error.includes("쓰는 단계")));
  const effectiveUnused = unused && usesKnown;
  const usesOf = (entry: ModelConsoleRow) => taskUses ? taskUses[entry.id] ?? [] : entry.stages.map(stage => ({
    key: `${stage.task}#${stage.slot}`, label: stage.label, place: stage.place, href: stage.href, paused: stage.paused,
  }));
  const countOf = (entry: ModelConsoleRow) => taskUses ? usesOf(entry).length : entry.stageCount;
  const unusedCount = usesKnown ? view.rows.filter(entry => countOf(entry) === 0).length : null;
  const duplicates = duplicateCount === undefined ? modelDuplicateAssignments(attach?.editor ?? null) : duplicateCount;
  const rows = modelRowsFor(view.rows, sort, effectiveUnused, countOf);
  const closeModel = () => onModelClose ? onModelClose() : router.push("/admin/models", { scroll: false });

  return <section id="models" className="model-console mc-inventory" aria-labelledby="models-title">
    <div className="mc-page-head">
      <div><h1 id="models-title">모델</h1><p>모델을 관리하고, 어떤 작업에 쓰이는지 확인합니다.</p></div>
      <div className="mc-right">
        <Link prefetch={false} className="button" href="/admin/models/compare">표본 비교</Link>
        {!readOnly && <button type="button" className="button primary" onClick={() => setAdding({ step: 1, id: null })}>＋ 모델 추가</button>}
      </div>
    </div>
    <div className="mc-review" aria-label="배정 확인">
      <strong className="mc-st" data-tone={duplicates ? "warn" : "off"}><i aria-hidden="true" />배정 확인</strong>
      {onReviewDuplicates ? <button type="button" className="text-button" onClick={onReviewDuplicates} disabled={duplicates === null}>
        같은 모델 반복 {duplicates === null ? "—" : `${formatCount(duplicates)}개`}</button>
        : <Link prefetch={false} className="text-button" href="/admin/models#tasks">같은 모델 반복 {duplicates === null ? "—" : `${formatCount(duplicates)}개`}</Link>}
      <span className="mc-divider" aria-hidden="true">·</span>
      <button type="button" className="text-button" disabled={!usesKnown} aria-pressed={effectiveUnused} onClick={() => setUnused(true)}>
        쓰는 작업 없는 모델 {unusedCount === null ? "—" : `${formatCount(unusedCount)}개`}</button>
      <span className="mc-review-end">모델 이름을 누르면 설정과 쓰는 작업이 열립니다.</span>
    </div>
    {admission && admission.mode !== "open" && <p id="admission" className="mc-notice" data-tone="warn">
      모델 접수 {admission.mode === "draining" ? "중단" : "꺼짐"}{admission.since ? ` · ${formatKst(admission.since)}부터` : ""} —{" "}
      <Link prefetch={false} href={`${MODELS_DASHBOARD_HREF}#admission`}>접수 바꾸기(대시보드)</Link></p>}
    {view.errors.map(error => <p key={error} role="alert" className="mc-notice">{error}</p>)}
    <div className="mc-list-head">
      <span title={`마지막 확인 ${formatKst(view.checkedAt)} · 한도: 장비의 모델별 한도 → 장비 한도 → 연결 칸 수`}>모델 {formatCount(rows.length)}개</span><span>· 최근 24시간</span>
      <div className="mc-right">
        {effectiveUnused && <button type="button" className="text-button" onClick={() => setUnused(false)}>전체 모델 보기</button>}
        <select className="mc-sort" aria-label="모델 정렬" value={sort} onChange={event => setSort(event.target.value as ModelSort)}>
          <option value="usage">사용률 높은 순</option><option value="calls">호출 많은 순</option><option value="name">이름순</option>
        </select>
      </div>
    </div>
    <div className="mc-scroll" role="region" aria-label="모델 목록" tabIndex={0}>
      <table className="mc-table" aria-label="모델별 사용과 연결 상태">
        <colgroup><col style={{ width: 165 }} /><col style={{ width: 128 }} /><col style={{ width: 62 }} /><col style={{ width: 78 }} /><col />
          <col style={{ width: 82 }} /><col style={{ width: 88 }} /><col style={{ width: 72 }} /><col style={{ width: 142 }} /></colgroup>
        <thead><tr><th scope="col">이름</th><th scope="col">장비</th><th scope="col" className="n">한도</th><th scope="col" className="n">지금</th>
          <th scope="col">24시간 사용률</th><th scope="col" className="n">호출</th><th scope="col" className="n">평균 응답</th><th scope="col" className="n">쓰는 작업</th>
          <th scope="col">상태</th></tr></thead>
        <tbody>
          {rows.map(entry => <tr key={entry.id} data-selected={entry.id === selected ? "true" : undefined} data-model={entry.id}>
            <th scope="row"><Link prefetch={false} scroll={false} href={`${modelHref(entry.id)}#model-detail`}
              onClick={onModelOpen ? event => { event.preventDefault(); onModelOpen(entry.id); } : undefined}
              aria-current={entry.id === selected ? "true" : undefined}>{entry.name}</Link></th>
            <td className="q mc-machine" title={entry.machine}>{entry.machine}</td>
            <td className="n">{formatCount(entry.limit)}</td>
            <td className="n">{entry.active === null ? "—" : `${formatCount(entry.active)} / ${formatCount(entry.limit)}`}</td>
            <td><span className="mc-use" data-idle={entry.utilization !== null && entry.utilization < 0.06 ? "true" : undefined}>
              <span aria-hidden="true"><i style={{ width: `${entry.bar}%` }} /></span><b>{modelUsageText(entry)}</b></span></td>
            <td className="n">{entry.calls === null ? "—" : formatCount(entry.calls)}</td>
            <td className="n">{formatSeconds(entry.avgSeconds)}</td>
            <td className="n">{!usesKnown ? "—" : onModelScope ? <button type="button" className="mc-count-link" aria-label={`${entry.name}의 쓰는 작업 보기`}
              onClick={() => onModelScope(entry.id)}>{countOf(entry) || "—"}</button>
              : <Link prefetch={false} className="mc-count-link" href={`${modelHref(entry.id)}#model-stages`}>{countOf(entry) || "—"}</Link>}</td>
            <td><span className="mc-st" data-tone={modelStatusForUses(entry, usesKnown).tone}><i aria-hidden="true" />{modelStatusForUses(entry, usesKnown).text}</span></td>
          </tr>)}
          {!rows.length && <tr><td colSpan={9} className="mc-empty">{effectiveUnused ? "쓰는 작업이 없는 모델이 없습니다."
            : view.errors.length ? "모델을 읽지 못했습니다." : "아직 모델이 없습니다. 「모델 추가」로 넣으세요."}</td></tr>}
        </tbody>
      </table>
    </div>
    <div className="mc-table-note">
      <span>사용률 = 24시간 호출 시간 합 ÷ (86,400초 × 한도). 같은 장비의 한도는 작업들이 나눠 씁니다.</span>
      <span className="mc-mobile-note">표를 좌우로 밀어 확인하세요.</span>
      {onAdvancedOpen ? <button type="button" className="text-button" onClick={onAdvancedOpen}>연결·장비 고급 설정 ↗</button>
        : <Link prefetch={false} className="text-button" href={MODELS_DASHBOARD_HREF}>연결·장비 고급 설정 ↗</Link>}
    </div>
    {selected && !row && <p role="alert" className="mc-notice">고른 모델을 찾지 못했습니다(지워졌거나 목록을 읽지 못함).</p>}
    {row && !adding && <ModelDrawer title={row.name} eyebrow="모델 상세" titleId="model-detail-title" onClose={closeModel}>
      <ModelDetail key={row.id} row={row} device={data.devices?.find(device => device.deviceId === row.deviceId) ?? null}
        secretBox={data.secretBox} readOnly={readOnly} uses={usesOf(row)} usesKnown={usesKnown} onTaskOpen={onTaskOpen}
        attach={attach ? <ModelAttachForm connectionId={row.id} editor={attach.editor} poolHelp={attach.poolHelp} readOnly={readOnly}
          onTaskOpen={onTaskOpen} devices={data.devices?.map(entry => ({ deviceId: entry.deviceId, active: entry.active, limitSlots: entry.limitSlots })) ?? null} /> : undefined}
        now={view.checkedAt} siblings={view.rows.filter(entry => entry.id !== row.id && entry.deviceId === row.deviceId).map(entry => ({ name: entry.name, models: entry.models }))} />
    </ModelDrawer>}
    {adding && !readOnly && <ModelDrawer title="모델 추가" eyebrow="넣기 → 이름과 한도 → 쓸 작업" titleId="model-add-title" onClose={() => setAdding(null)}>
      <div className="mc-add-content"><ModelAddFlow step={adding.step} row={added}
        missing={adding.step > 1 && view.errors.some(error => error.includes("모델(연결) 목록"))} recommendations={[]} secretBox={data.secretBox} readOnly={readOnly} drawer
        onCreated={id => { setAdding({ id, step: 2 }); router.refresh(); }} onStep={step => setAdding(current => current ? { ...current, step } : null)}
        onReadAgain={() => router.refresh()} onClose={() => setAdding(null)} onAttachModel={id => {
          setAdding(null);
          if (onModelOpen) onModelOpen(id); else router.push(`${modelHref(id)}#model-detail`, { scroll: false });
        }}
        taken={view.rows.flatMap(entry => [entry.connection.label, aiModelDisplayName(entry.connection)])} /></div>
    </ModelDrawer>}
  </section>;
}

const LIMIT_SOURCE: Record<ModelConsoleRow["limitSource"], string> = { model: "장비의 모델별 한도", device: "장비 한도", connection: "연결 칸 수(장비 행 없음)" };
const subscribeHash = (changed: () => void) => { window.addEventListener("hashchange", changed); return () => window.removeEventListener("hashchange", changed); };
type ModelDetailTab = "tasks" | "settings";

/** The drawer has one task entry point; all connection security and CAS forms stay intact. */
export function ModelDetail({ row, device, secretBox, readOnly, now, siblings = [], attach, uses, usesKnown = true,
  onTaskOpen }: { row: ModelConsoleRow; device: ModelDeviceState | null; secretBox: boolean; readOnly: boolean; attach?: ReactNode;
  now: string; siblings?: readonly { name: string; models: readonly string[] }[]; uses?: readonly ModelTaskUse[]; usesKnown?: boolean;
  onTaskOpen?: (taskKey: string, attachConnectionId?: string) => void }) {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => "");
  const [tabChoice, setTabChoice] = useState<{ hash: string; tab: ModelDetailTab } | null>(null);
  const tab = tabChoice?.hash === hash ? tabChoice.tab : hash === "#model-actions" ? "settings" : "tasks";
  const setTab = (value: ModelDetailTab) => setTabChoice({ hash, tab: value });
  const tabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "tasks" : event.key === "End" ? "settings" : tab === "tasks" ? "settings" : "tasks";
    setTab(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`#model-${next}-tab`)?.focus();
  };
  const { connection } = row;
  const status = modelStatusForUses(row, usesKnown);
  const keyText = modelKeyText(connection, now);
  const compareTask = row.stages.find(stage => SAMPLE_COMPARE_SUPPORTED.includes(stage.task))?.task ?? SAMPLE_COMPARE_SUPPORTED[0];
  const assignments = uses ?? row.stages.map(stage => ({ key: `${stage.task}#${stage.slot}`, label: stage.label, place: stage.place, href: stage.href, paused: stage.paused }));
  const problems = row.problems.filter(problem => problem.key === "unused" ? usesKnown && assignments.length === 0
    : problem.key === "paused" ? usesKnown && assignments.length > 0 && assignments.every(use => use.paused) : true);
  return <article id="model-detail" className="mc-detail" aria-labelledby="model-detail-title" data-model-detail={row.id}>
    <div className="mc-drawer-stats">
      <span>24시간 호출<b>{row.calls === null ? "—" : formatCount(row.calls)}</b></span>
      <span>평균 응답<b>{formatSeconds(row.avgSeconds)}</b></span>
      <span>동시 사용<b>{row.active === null ? "—" : `${formatCount(row.active)} / ${formatCount(row.limit)}`}</b></span>
    </div>
    <div className="mc-detail-tabs" role="tablist" aria-label="모델 상세 구획" onKeyDown={tabKeys}>
      <button type="button" role="tab" id="model-tasks-tab" aria-controls="model-tasks-panel" aria-selected={tab === "tasks"} tabIndex={tab === "tasks" ? 0 : -1} onClick={() => setTab("tasks")}>쓰는 작업 {usesKnown ? formatCount(assignments.length) : "—"}</button>
      <button type="button" role="tab" id="model-settings-tab" aria-controls="model-settings-panel" aria-selected={tab === "settings"} tabIndex={tab === "settings" ? 0 : -1} onClick={() => setTab("settings")}>연결·한도</button>
    </div>
    <div id="model-tasks-panel" role="tabpanel" aria-labelledby="model-tasks-tab" hidden={tab !== "tasks"}>
      <section id="model-stages" aria-label="쓰는 작업">
        <p className="mc-drawer-lead">이 모델이 배정된 작업입니다. 작업을 고르면 순위와 실행 방식을 함께 바꿉니다.</p>
        {!usesKnown && <p className="mc-callout" role="alert">일부 배정을 읽지 못해 쓰는 작업 전체를 확인할 수 없습니다.</p>}
        <div className="mc-assignments">{assignments.length ? assignments.map(use => <div className="mc-assignment" key={use.key}>
          <span><b>{use.label}</b><small>{use.place === "함께" ? "동시에 사용" : use.place}{use.paused ? " · 사람이 멈춤" : ""}</small></span>
          {onTaskOpen ? <button type="button" className="text-button" onClick={() => onTaskOpen(use.key)}>배정 보기 →</button>
            : <Link prefetch={false} className="text-button" href={use.href?.startsWith("/admin/models/tasks")
              ? `/admin/models?task=${encodeURIComponent(use.key)}#tasks` : use.href ?? "/admin/models#tasks"}>배정 보기 →</Link>}
        </div>) : usesKnown ? <p className="mc-callout">아직 쓰는 작업이 없습니다. 아래에서 쓸 작업을 골라 붙이세요.</p> : null}</div>
        {attach}
        <div className="mc-acts">
          {!attach && <Link prefetch={false} className="button small" href="/admin/models#tasks">전체 작업 배정 보기</Link>}
          {connection.enabled && <Link prefetch={false} className="text-button" href={modelCompareHref(compareTask, row.id, row.models[0] ?? null)}>표본 비교 →</Link>}
        </div>
      </section>
    </div>
    <div id="model-settings-panel" role="tabpanel" aria-labelledby="model-settings-tab" hidden={tab !== "settings"}>
      <section aria-label="설정" className="mc-settings-overview">
        <dl className="mc-dl mc-settings-summary">
          <dt>이름</dt><dd>{row.name}</dd><dt>장비</dt><dd>{row.machine}</dd>
          <dt>연결 방식</dt><dd>{connection.kind === "api" ? "OpenAI 호환 API" : "CLI 도구"}</dd>
          <dt>서버 목록</dt><dd>{connection.kind === "api" ? <>{connection.modelsReadAt ? `마지막 확인 ${formatKst(connection.modelsReadAt)}` : "아직 확인하지 않음"}
            {connection.modelsError ? " · 모델 목록 확인 실패" : connection.models ? " · 모델 목록 확인" : ""}</> : connection.cliVersion ? `CLI ${connection.cliVersion}` : "CLI 버전 미확인"}</dd>
          <dt>공유 한도</dt><dd>{formatCount(row.limit)}칸</dd>
        </dl>
        <div className="mc-settings-editor"><h3>연결과 한도 고치기</h3>
          <ModelSettingsForm row={row} device={device} secretBox={secretBox} readOnly={readOnly} siblings={siblings} compact
            revealAdvanced={hash === "#model-actions"} advancedDetails={<div className="mc-settings-diagnostics">
        <section aria-label="연결 세부 값"><dl className="mc-dl">
          <dt>방식</dt><dd>{connection.kind === "api" ? "API 주소" : `CLI · ${connection.cliTool ? AI_CLI_TOOL_LABELS[connection.cliTool] : "도구 미확인"}`}</dd>
          {connection.host && <><dt>주소</dt><dd className="num">{connection.host}</dd></>}
          <dt>동시 한도</dt><dd className="num">{formatCount(row.limit)} <span className="mc-muted">· {LIMIT_SOURCE[row.limitSource]}{row.sharedWith.length ? ` · 같은 장비: ${row.sharedWith.join(" · ")}` : ""}</span></dd>
          {connection.kind === "api" && <><dt>최대 토큰</dt><dd className="num">{modelMaxTokens(connection) === null ? "—" : formatCount(modelMaxTokens(connection)!)}
            {!connection.contextTokens && modelMaxTokens(connection) !== null && <span className="mc-muted"> · 서버가 알려 준 값</span>}</dd>
            <dt>추론 여유</dt><dd className="num">{connection.reasoningTokenReserve ? formatCount(connection.reasoningTokenReserve) : "—"}</dd></>}
          <dt>쓸 단계</dt><dd>{connection.allowedTasks?.length ? `${connection.allowedTasks.length}개만 허용` : "모든 단계"}</dd>
          {connection.kind === "api" && <><dt>키</dt><dd className="num">{keyText ?? "없음"}</dd></>}
        </dl>
        <Link prefetch={false} className="text-button" href="/admin/models/contracts">서빙 계약·등록부 열기 ↗</Link></section>
      <section aria-label="문제">
        <h3>상태와 호출</h3>
        <p className="mc-st" data-tone={status.tone}><i aria-hidden="true" />{status.text}</p>
        <p className="mc-kv"><span>거절<b>{row.rejected === null ? "—" : formatCount(row.rejected)}</b></span>
          <span>보내기 전에 끝남<b>{row.notStarted === null ? "—" : formatCount(row.notStarted)}</b></span>
          <span>미확정<b>{row.indeterminate === null ? "—" : formatCount(row.indeterminate)}</b></span><span>사용률<b>{row.utilizationText}</b></span></p>
        {problems.length ? <ul className="mc-cause">{problems.map(problem => <li key={problem.key}><span>{problem.label}</span>
          <span>{problem.text}{problem.href ? <> <Link prefetch={false} href={problem.href}>{problem.action ?? "보기"} →</Link></> : null}</span></li>)}</ul>
          : <p className="mc-muted">읽은 값에서 문제를 찾지 못했습니다.</p>}
      </section>
      <section aria-label="연결 확인">
        <h3>연결 확인</h3>
        <p className="mc-muted">서버가 알려 준 이름{row.served.length ? "" : " 없음"}
          {row.served.map((group, index) => <span key={group.ids.join("\u0000")}>{index ? " · " : ": "}<code>{group.ids.join(" = ")}</code>
            {group.maxModelLen ? ` (최대 ${formatCount(group.maxModelLen)})` : ""}</span>)}
          {connection.modelsReadAt ? ` · ${formatKst(connection.modelsReadAt)} 읽음` : ""}{` · 장비 id ${row.deviceId}`}{connection.note ? ` · 메모: ${connection.note}` : ""}</p>
      </section>
      </div>} /></div></section>
    </div>
  </article>;
}

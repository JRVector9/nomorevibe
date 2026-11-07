"use client";

import Link from "next/link";
import { AI_TASKS, AI_TASK_GROUP_LABELS, AI_TASK_KIND_LABELS, AI_CLI_TOOL_LABELS, aiTaskSlotLabel, isAiLiveTask, type AiTaskDef } from "@/lib/llm/ai-tasks";
import type { ModelDefinition } from "@/lib/llm/model-registry";
import { summarizeStageCapacity, type StageCapacityGroup } from "@/lib/operations/admin-model-stage-capacity";
import type { AdminModelsObservation, AdminModelMetrics } from "@/lib/operations/admin-models-observation";
import { deviceServer, modelStageId, type ModelContractLink, type ModelStageAssignment } from "@/lib/operations/admin-models-view";
import type { FlowRankEditor } from "@/lib/operations/flow-rank-editor";
import type { CapacityDevicesAdminView } from "@/lib/operations/admin-capacity-devices";
import type { ModelHelpersAdminView } from "@/lib/operations/admin-model-helpers";
import type { OpsState } from "@/lib/operations/ops-runner/contract";
import type { Conveyor, Station } from "@/lib/operations/conveyor-model";
import { FLOW_MODEL_STAGES, flowModelTaskHref, flowModelTaskStage, type FlowModelStage } from "@/lib/operations/flow-model-catalog";
import { ModelOpsPanel } from "./ModelOpsPanel";
import { ModelCallsPanel, MODEL_REQUEST_REVIEW_HREF } from "./ModelCallsPanel";
import { modelPickerConnectionLabel, modelPickerConnectionModels, modelPickerModelLabel } from "./model-picker-display";
import { ConfiguredModelRows, LiveModelRows, RecentModelRows } from "../flow/FlowModels";
import { clock, DataTable, Facts, number, Panel, ReadStamp, Stat, Tag } from "../flow/PrototypeParts";

type StageTone = "red" | "amber" | "green" | "gray" | "blue";
const stageStationOf = (flow: Conveyor | null, stage: FlowModelStage): Station | null => {
  if (!flow || stage.id === "human" || stage.id === "public" || stage.id === "support") return null;
  return flow.stations.find(station => station.key === stage.id) ?? null;
};
const stageLlmOf = (flow: Conveyor | null, stage: FlowModelStage) => {
  if (!flow) return null;
  if (stage.id === "human") return flow.human?.llm ?? null;
  if (stage.id === "public") return flow.sinkLlm ?? null;
  if (stage.id === "support") return flow.supportLlm ?? null;
  return stageStationOf(flow, stage)?.llm ?? null;
};
const stageToneValue = (value: Station["tone"] | null | undefined): StageTone =>
  value === "jam" ? "red" : value === "slow" ? "amber" : value === "flow" ? "green" : "gray";
const stageToneOf = (flow: Conveyor | null, stage: FlowModelStage): StageTone => {
  if (!flow) return "gray";
  if (stage.id === "human") return stageToneValue(flow.human?.tone);
  if (stage.id === "public") return flow.publishedHour === null ? "gray" : "green";
  if (stage.id === "support") return "blue";
  return stageToneValue(stageStationOf(flow, stage)?.tone);
};
const stageStatusOf = (flow: Conveyor | null, stage: FlowModelStage) => {
  if (!flow) return "흐름 미확인";
  if (stage.id === "human") return flow.human?.status ?? "미확인";
  if (stage.id === "public") return flow.publishedHour === null ? "현재 미확인" : "발행 결과 관측";
  if (stage.id === "support") return "공개 후 보조 · 별도 집계";
  return stageStationOf(flow, stage)?.status ?? "미확인";
};
const taskOf = (id: string) => AI_TASKS.find(task => task.id === id) ?? null;
const taskLabelOf = (id: string) => taskOf(id)?.label ?? id;
const isLedgerTask = (task: AiTaskDef | null): task is AiTaskDef & { routeId: string; wiring: Exclude<AiTaskDef['wiring'], 'uncapped'> } => !!task?.routeId && task.wiring !== "uncapped";
const summaryStageIdOf = (task: AiTaskDef) => (task.routeId && modelStageId(task.routeId) === task.id ? task.id : task.routeId ?? task.id);
const taskObservationRows = (task: AiTaskDef, observation: AdminModelsObservation) =>
  observation.rows.filter(row => row.routeId === task.routeId || modelStageId(row.routeId) === task.id);
function stageCapacityFor(stage: FlowModelStage, observation: AdminModelsObservation, assignments: ModelStageAssignment[]) {
  const summaries = stage.taskIds.flatMap(taskId => {
    const task = taskOf(taskId);
    if (!isLedgerTask(task)) return [];
    const assignment = isAiLiveTask(task.id) ? assignments.find(row => row.id === task.id) : undefined;
    return [summarizeStageCapacity(summaryStageIdOf(task), observation, assignment)];
  });
  const groupsById = new Map<string, StageCapacityGroup>();
  for (const summary of summaries) for (const group of summary.groups) {
    const previous = groupsById.get(group.labelId);
    groupsById.set(group.labelId, previous ? {
      ...previous,
      runningForStage: previous.runningForStage + group.runningForStage,
      reservedForStage: previous.reservedForStage + group.reservedForStage,
    } : group);
  }
  const groups = [...groupsById.values()].sort((a, b) => a.labelId.localeCompare(b.labelId));
  const unavailable = summaries.length > 0 && summaries.every(summary => summary.unavailable);
  const unresolved = summaries.some(summary => summary.unresolved);
  const running = unavailable || !summaries.length || !groups.length ? null : groups.reduce((total, group) => total + group.runningForStage, 0);
  const reserved = unavailable || !summaries.length || !groups.length ? null : groups.reduce((total, group) => total + group.reservedForStage, 0);
  const limit = unavailable || unresolved || !groups.length || groups.some(group => group.limit === null)
    ? null : groups.reduce((total, group) => total + (group.limit ?? 0), 0);
  return { unavailable, unresolved, groups, limit, running, reserved };
}
const sum = (rows: readonly AdminModelMetrics[], key: "dispatched" | "reserved" | "waiting" | "indeterminate" | "succeeded1h" | "failed1h") => rows.reduce((total, row) => total + row[key], 0);
const stageLedgerRows = (stage: FlowModelStage, observation: AdminModelsObservation) => {
  const rows = new Set<AdminModelMetrics>();
  for (const taskId of stage.taskIds) {
    const task = taskOf(taskId);
    if (!isLedgerTask(task)) continue;
    for (const row of taskObservationRows(task, observation)) rows.add(row);
  }
  return [...rows];
};
const stageLedgerCounts = (stage: FlowModelStage, observation: AdminModelsObservation) => {
  const rows = stageLedgerRows(stage, observation);
  if (!rows.length) return null;
  return {
    succeeded1h: sum(rows, "succeeded1h"),
    failed1h: sum(rows, "failed1h"),
    indeterminate: sum(rows, "indeterminate"),
  };
};
const actual = (rows: AdminModelMetrics[], unavailable: boolean) => unavailable ? "확인 불가" : [...new Set(rows.filter(row => row.dispatched || row.succeeded1h || row.failed1h || row.lastSuccessAt).map(row => row.model))].join(" / ") || "최근 실행 기록 없음";
const requestHref = MODEL_REQUEST_REVIEW_HREF;
export function PrototypeModels({ observation, assignments, models, contracts, editor = null, devices = null, helpers = null, tab = "live", readOnly = false, opsStates = [], flow = null }: {
  observation: AdminModelsObservation; assignments: ModelStageAssignment[]; models: readonly ModelDefinition[]; contracts: ModelContractLink[];
  editor?: FlowRankEditor | null; devices?: CapacityDevicesAdminView | null; helpers?: ModelHelpersAdminView | null; tab?: string; readOnly?: boolean; opsStates?: OpsState[]; flow?: Conveyor | null;
}) {
  const unavailable = !!observation.error || !observation.observedAt;
  const mode = observation.mode?.toUpperCase() ?? "미확인";
  const dispatched = unavailable ? null : sum(observation.rows, "dispatched"), waiting = unavailable ? null : sum(observation.rows, "waiting"), unknown = unavailable ? null : sum(observation.rows, "indeterminate");
  const source = (id: string) => isAiLiveTask(id) ? "작업별 모델 순위"
    : flowModelTaskStage(id)?.id === "human" ? "사람 확인 모델 편집"
    : ["product-embedding", "search-embedding", "search-rerank"].includes(id) ? "검색 모델 설정"
    : id === "product-intro-check" ? "기존 CLI 설정 · 원본 확인"
    : AI_TASKS.find(task => task.id === id)?.group === "audit" ? "감사 설정 · 원본 확인"
    : "실행 설정 원본 확인";
  const lookupLabel = (id: string) => {
    const connection = editor?.connections.find(row => row.id === id);
    return connection ? modelPickerConnectionLabel(connection) : "연결 미확인";
  };
  const lookupModelLabel = (id: string, model: string) => {
    const connection = editor?.connections.find(row => row.id === id);
    return connection ? modelPickerModelLabel(connection, model) : model;
  };
  const taskRanks = (id: string) => editor?.rows.filter(row => row.task === id).sort((a, b) => a.slot - b.slot || a.rank - b.rank) ?? [];
  const calls = <ModelCallsPanel observation={observation} />;

  const stageTaskPairs = FLOW_MODEL_STAGES.flatMap(stage => stage.taskIds
    .map(id => AI_TASKS.find(task => task.id === id))
    .filter((task): task is AiTaskDef => !!task)
    .map(task => ({ stage, task })));
  const taskTable = <DataTable heads={["작업·흐름 단계", "저장된 순위 · 비교용", "현재 적용 출처", "관측 모델", "편집"]} note="저장된 순위는 live 작업을 제외하면 비교용입니다. 장부 밖 단계의 실제 호출은 이 표에서 확인할 수 없습니다.">{stageTaskPairs.map(({ stage, task }) => <tr key={task.id}><td><b>{task.label}</b><p>{stage.label} · {AI_TASK_GROUP_LABELS[task.group]}</p></td><td>{editor ? <>{taskRanks(task.id).length ? Array.from({ length: task.slots }, (_, index) => <p key={index}>{task.slots > 1 ? `${aiTaskSlotLabel(task, index + 1)}: ` : ""}{taskRanks(task.id).filter(row => row.slot === index + 1).map(row => `${row.rank}순위 ${lookupLabel(row.connectionId)} · ${lookupModelLabel(row.connectionId, row.model)}${!row.enabled ? " (꺼짐)" : ""}`).join(" → ") || "순위 없음"}</p>) : <Tag tone="gray">저장된 순위 없음</Tag>}{!isAiLiveTask(task.id) && <Tag tone="amber">저장·비교용 · 실제 적용 아님</Tag>}</> : "순위를 읽지 못함"}</td><td><Tag tone={isAiLiveTask(task.id) ? "blue" : "amber"}>{source(task.id)}</Tag><p>{isAiLiveTask(task.id) ? "실행 쪽이 순위를 읽음" : "저장된 순위만으로 적용을 판단하지 않음"}</p></td><td>{isLedgerTask(task) ? actual(taskObservationRows(task, observation), unavailable) : <><span>장부 밖 · 별도 관측</span>{task.id === "product-embedding" && <p><Link prefetch={false} className="text-button" href="/admin/models/search">검색 모델 상태 →</Link></p>}</>}</td><td><Link prefetch={false} className="button small" href={flowModelTaskHref(task.id)}>{isAiLiveTask(task.id) ? "순위 편집" : "현재 실행 설정에서 변경"} →</Link></td></tr>)}</DataTable>;

  const contents = tab === "tasks" ? <div className="stack"><div className="notice blue"><b>편집은 현재 적용 출처에서만.</b><br />작업 순위·배정 표·기존 설정·환경 강제를 구분하고 원본 편집기를 엽니다.</div><Panel flush title={`흐름 단계별 작업 요약 · 전체 ${AI_TASKS.length}개 작업과 같은 원본`} tool={<a className="text-button" href="#all-ai-task-inventory">전체 작업 ↓</a>}>{taskTable}</Panel><Panel flush id="all-ai-task-inventory" title={`전체 AI 작업 · ${AI_TASKS.length}개`} description="현재 코드의 전체 작업 목록과 저장된 순위입니다. 현재 실행 출처·장부 관측은 별도로 대조합니다." tool={<div className="right">{Object.entries(AI_TASK_GROUP_LABELS).map(([key, label]) => <Tag tone="blue" key={key}>{label} {AI_TASKS.filter(task => task.group === key).length}</Tag>)}</div>} note="장부 밖 작업의 저장된 설정을 실제 호출 성공으로 표시하지 않습니다."><DataTable min={1020} heads={["작업·종류", "분류", "저장된 순위 · 비교용", "실제 적용 출처의 경계", "모델·연결 제약", "편집"]}>{AI_TASKS.map(task => { const stage = flowModelTaskStage(task.id); return <tr key={task.id} data-full-task={task.id}><td><b>{task.label}</b><p><code>{task.id}</code></p><Tag>{AI_TASK_KIND_LABELS[task.kind]}</Tag></td><td><Tag tone="blue">{AI_TASK_GROUP_LABELS[task.group]}</Tag><p>{stage ? `${stage.label} · ${stage.phase}` : "벨트 밖 · 흐름 단계 없음"}</p></td><td>{editor ? <>{taskRanks(task.id).length ? taskRanks(task.id).map(row => <p key={`${row.slot}:${row.rank}`}>{task.slots > 1 ? `${aiTaskSlotLabel(task, row.slot)} · ` : ""}{row.rank}순위 {lookupLabel(row.connectionId)} · {lookupModelLabel(row.connectionId, row.model)}{!row.enabled ? " (꺼짐)" : ""}</p>) : <Tag tone="gray">저장된 순위 없음</Tag>}{!isAiLiveTask(task.id) && <Tag tone="amber">저장·비교용 · 실제 적용 아님</Tag>}</> : "순위를 읽지 못함"}</td><td><Tag tone={isAiLiveTask(task.id) ? "green" : "gray"}>{isAiLiveTask(task.id) ? "실행이 작업 순위 읽음" : "저장·비교용 설정"}</Tag><p>{isAiLiveTask(task.id) ? "현재 사용 모델은 실제 호출 관측과 대조" : "단계 풀·배정 표·환경·캠페인 등 실제 출처 별도 확인"}</p></td><td>{[task.api ? "API 주소" : "", ...task.cliTools.map(tool => AI_CLI_TOOL_LABELS[tool])].filter(Boolean).join(" · ")}<p>{task.slots > 1 ? `${task.slots}개 독립 투표자` : "한 작업 순위"}{task.sameModelAcrossRanks ? " · 대체 순위는 같은 모델 필요" : ""}</p><p>{task.sameModelAs ? `${task.sameModelAs} 작업과 모델 일치 필요` : task.description}</p></td><td><Link prefetch={false} className="button small" href={flowModelTaskHref(task.id)}>{isAiLiveTask(task.id) ? (task.slots > 1 ? "투표자별 편집" : "순위 편집") : "현재 실행 설정에서 변경"} →</Link></td></tr>; })}</DataTable></Panel><Panel title="배정 표·레거시의 고급 영역"><div className="grid two"><Facts rows={[["배정 원본", "작업별 순위와 별도 적용 출처"], ["전송 방식", "엔진 직접·CLI 계약과 대조"], ["장비 배정", "장비·역할 순서와 물리 점유 확인"]]} /><div><p className="notice amber">환경 강제·기존 전용 경로는 순위만 바꿔도 적용되지 않을 수 있습니다.</p><div className="decision-bar"><Link prefetch={false} className="button" href="/admin/models/assignments">배정 원본 →</Link><Link prefetch={false} className="button" href="/admin/models/tasks#import">기존 설정 가져오기 →</Link></div></div></div></Panel></div>
    : tab === "connections" ? <div className="stack"><div className="toolbar"><Tag>API·CLI 연결</Tag><span className="small muted">일반 연결과 서빙 계약·등록부를 구분합니다.</span><Link prefetch={false} className="button spacer" href="/admin/models/tasks#connection-form">연결 추가 →</Link></div><Panel title="AI 연결"><DataTable heads={["연결", "방식·주소", "제공 모델", "키·최근 확인", "관리"]}>{editor?.connections.map(connection => <tr key={connection.id}><td><b>{modelPickerConnectionLabel(connection)}</b><p><Tag tone={connection.enabled ? "green" : "gray"}>{connection.enabled ? "사용 설정" : "꺼짐"}</Tag></p></td><td>{connection.kind.toUpperCase()}<p><code>{connection.baseUrl ?? connection.cliTool ?? "주소 미확인"}</code></p></td><td>{connection.kind === "cli" ? connection.cliTool === "opencode" ? <details><summary>마지막 저장 모델 {connection.cliModels.length}개</summary><ul className="grid max-h-64 gap-1 overflow-y-auto">{connection.cliModels.map(model => <li key={model}><code className="break-all">{model}</code></li>)}</ul></details> : connection.cliModels.join(" · ") : connection.models ? <details><summary>{modelPickerConnectionModels(connection)!.length}개</summary>{modelPickerConnectionModels(connection)!.map(model => <p key={model.id}>{modelPickerModelLabel(connection, model.id)}</p>)}</details> : "목록 미확인"}</td><td>{connection.kind === "cli" ? <>{connection.cliVersion ?? "CLI 버전 미확인"}{connection.cliTool === "opencode" && <p>{connection.hasKey ? "호스트 RPC 인증 정보 저장됨" : "호스트 RPC 인증 정보 미확인"}</p>}</> : connection.hasKey ? "키 저장됨" : "키 없음"}<p>{clock(connection.modelsReadAt)}</p>{connection.modelsError && <Tag tone="amber">마지막 목록 조회 오류</Tag>}</td><td><Link prefetch={false} className="button small" href={`/admin/models/tasks?edit=${connection.id}#connection-form`}>편집·연결 확인 →</Link></td></tr>)}{!editor && <tr><td colSpan={5}>연결 목록을 읽지 못했습니다.</td></tr>}</DataTable></Panel><Panel title="고급 · 서빙 계약·등록부 예외"><DataTable heads={["대상", "현재 출처", "계약·주소", "편집"]}>{contracts.map((contract, index) => <tr key={`${contract.routeId}:${contract.model}:${index}`}><td><b>{contract.model}</b><p>{contract.routeId}</p></td><td><Tag tone="blue">관리 계약</Tag></td><td>{contract.transport === "direct" ? "엔진 직접" : "게이트웨이"}<p>{contract.host ?? "주소 미확인"}</p></td><td><Link prefetch={false} className="button small" href="/admin/models/contracts">고급 편집 →</Link></td></tr>)}</DataTable></Panel></div>
    : tab === "capacity" ? <div className="stack"><div className="grid four"><Stat label="관측 장비" value={devices ? number(devices.devices.length) : "—"} foot="장비 행·정책·실시간 상태의 합집합" /><Stat label="실행 중 호출" value={number(dispatched)} foot="dispatched · 실제 전송 관측" /><Stat label="예약 점유" value={unavailable ? "—" : number(sum(observation.rows, "reserved"))} foot="전송 전 확보한 슬롯" tone="warn" /><Stat label="미확정 검토" value={number(unknown)} foot="이 행 자체는 슬롯을 점유하지 않음" tone={unknown ? "bad" : ""} /></div><Panel title="장비·물리 그룹" tool={<Link prefetch={false} className="button" href="/admin/models/devices">장비 한도 편집 →</Link>}><DataTable heads={["장비", "실제 점유 / 한도", "상태", "담당 작업", "확인할 근거"]} note="미확정 검토를 닫아도 물리 점유가 풀렸다고 표시하지 않습니다. 예약·진행 점유와 실제 종료 근거를 대조합니다.">{devices?.devices.map(device => { const group = unavailable ? null : observation.groups.find(row => row.groupId === device.deviceId); return <tr key={device.deviceId}><td><b>{device.deviceId}</b><p>{device.source}</p></td><td><span className="mono">{number(group?.held)} / {number(device.settings.limitSlots)}</span>{group && device.settings.limitSlots && <div className={`meter ${group.held >= device.settings.limitSlots ? "amber" : ""}`}><span style={{ width: `${Math.min(100, group.held / device.settings.limitSlots * 100)}%` }} /></div>}</td><td><Tag tone={device.issues.length ? "amber" : !device.enabled ? "gray" : "green"}>{device.issues[0] ?? (device.enabled ? device.live?.lending ? "빌려 쓰는 중" : "장비 사용 설정" : "꺼짐")}</Tag></td><td>{device.roles.map(role => `${role.label} · ${role.rank ?? "미배정"}순위`).join(" / ") || "역할 순서 없음"}</td><td><Link prefetch={false} className="text-button" href="/admin/models/devices">상태·소유 근거 →</Link></td></tr>; })}{!devices && <tr><td colSpan={5}>장비 관측을 읽지 못했습니다.</td></tr>}</DataTable></Panel><Panel title="경로별 토큰·기한·묶음" tool={<Link prefetch={false} className="button" href="/admin/models/limits">실시간 한도 →</Link>}><div className="token-grid">{["경로 출력 상한", "요청 기한", "텍스트 묶음", "틱 예산"].map(label => <div key={label}><small>{label}</small><b className="mono">—</b><small>작업별 원본 설정에서 확인</small></div>)}</div><p className="small muted mt">모델과 작업마다 다른 상한을 한 숫자로 합산하지 않습니다.</p></Panel><Panel title="도우미 장비·감독자" tool={<Link prefetch={false} className="button" href="/admin/models/helpers">도우미 모드·설정 →</Link>}><div className="grid two"><Facts rows={[["도우미 배정", helpers ? `${helpers.helpers.length}개` : "미확인"], ["실제 도움", helpers ? `${helpers.counts.help}개` : "미확인"], ["관측만", helpers ? `${helpers.counts.shadowOnly}개` : "미확인"], ["쉬는 중", helpers ? `${helpers.counts.hold}개` : "미확인"]]} /><div>{helpers?.helpers.map(helper => <p key={helper.assignmentId}><Tag tone={helper.mode === "live" ? "green" : "blue"}>{helper.modeLabel}</Tag> {helper.deviceId} · {helper.model}<br /><span className="small muted">{helper.verdictLabel} · {helper.reasonLabel}</span></p>)}{!helpers && <p className="notice">감독자·도우미 관측을 읽지 못했습니다.</p>}</div></div></Panel></div>
    : tab === "history" ? <div className="stack">{calls}<Panel title="모델 설정·용량·제어 조치"><p className="notice">호출 상태와 관리자 조치 기록은 서로 다른 원본입니다. 작업 로그에서 변경 주체·전후 값·사유를 확인합니다.</p><div className="decision-bar"><Link prefetch={false} className="button" href="/admin/activity?group=settings">설정·제어 기록 →</Link><Link prefetch={false} className="button" href="/admin/models/tasks#audit">작업별 순위 변경 기록 →</Link></div></Panel></div>
    : <div className="stack"><div className={`callout ${unavailable ? "gray" : unknown ? "red" : observation.mode !== "open" || waiting ? "" : "green"}`}><div><h3>{unavailable ? "최근 실행을 읽지 못했습니다." : observation.mode === "draining" ? "DRAIN · 새 모델 호출을 받지 않습니다." : unknown ? `결과 미확정 ${number(unknown)}건의 근거를 검토하세요.` : waiting ? `모델 호출 ${number(waiting)}건이 용량을 기다립니다.` : "모델 호출·종료 기록을 관측하고 있습니다."}</h3><p>설정 모델·실제 전송·물리 점유·업무 완료를 나눠 확인합니다. 연결 성공만으로 정상 처리라고 표시하지 않습니다.</p></div><Link prefetch={false} className="button" href="/admin/models?tab=tasks">적용 출처 확인 →</Link></div><div className="grid four"><Stat status label="접수 상태" value={mode} foot={observation.mode === "open" ? "새 호출 허용" : "기존 호출과 업무 기록 보존"} tone={observation.mode === "open" ? "good" : "warn"} /><Stat label="실행 중 호출" value={number(dispatched)} foot="실제 dispatched 관측" /><Stat label="용량 대기" value={number(waiting)} foot="후보 대기와 별도 집계" tone={waiting ? "warn" : ""} /><Stat label="미확정 검토" value={number(unknown)} foot="물리 점유와 다른 검토 상태" tone={unknown ? "bad" : ""} /></div><Panel flush title="흐름 단계 × 실제 사용 모델 · 전체 단계" description="흐름 화면과 같은 단계 순서·이름으로 사람 확인 분기와 공개 후 보조까지 보여 줍니다. 사람 확인은 자동 검수에서 남은 보류 분기입니다. 저장된 순위와 실제 호출·장비 한도는 서로 다른 원본입니다." tool={<div className="flex gap-2"><span>흐름</span><ReadStamp at={flow?.measuredAt} /><span>모델 장부</span><ReadStamp at={observation.observedAt} /></div>}><DataTable min={1280} heads={["단계", "상태", "실행 / 한도", "설정 모델 / 출처", "실제 모델", "최근 1시간 · 성공 / 실패", "다음 행동"]} note="현재 호출·단계 상태는 흐름 관측에서, 실행 수와 공유 한도는 모델 장부에서 읽습니다. 실행 수는 dispatched만 세고 예약·미확정·최근 종료는 따로 표시합니다. 같은 장비 그룹의 한도는 한 번만 세며, 공유 장부를 거치지 않는 작업은 0으로 표시하지 않습니다.">{FLOW_MODEL_STAGES.map(stage => {
  const llm = stageLlmOf(flow, stage), capacity = stageCapacityFor(stage, observation, assignments);
  const ledgerTasks = stage.taskIds.map(taskOf).filter(isLedgerTask);
  const uncappedTasks = stage.taskIds.map(taskOf).filter(task => task?.wiring === "uncapped");
  const recent = stageLedgerCounts(stage, observation);
  const status = stageStatusOf(flow, stage), statusTone = stageToneOf(flow, stage);
  const offLedger = uncappedTasks.length > 0;
  const runText = !stage.llm || !flow ? "—" : !ledgerTasks.length ? "별도 관측" : capacity.unavailable ? "미확인" : capacity.running === null ? "—" : offLedger ? `장부 ${number(capacity.running)}` : number(capacity.running);
  const limitText = !stage.llm || !flow ? "—" : !ledgerTasks.length ? "한도 없음" : capacity.unavailable ? "미확인" : capacity.unresolved ? "일부 미확인" : capacity.limit === null ? "한도 미확인" : number(capacity.limit);
  return <tr key={stage.id} id={`flow-stage-${stage.id}`}><td><b>{stage.label}</b><p>{stage.phase}</p>{stage.id === "human" && <p>자동 검수의 보류 분기</p>}{stage.taskIds.length ? <p>{stage.taskIds.map(taskLabelOf).join(" · ")}</p> : <p>LLM 없음</p>}</td><td><Tag tone={statusTone}>{status}</Tag>{stage.id === "keywords" && <p><Link prefetch={false} className="text-button" href="/admin/models/search">검색 모델 상태 →</Link></p>}</td><td className="mono">{runText} / {limitText}<p>{!stage.llm ? "LLM 없음 · 한도 없음" : !flow ? "흐름 관측 미확인" : !ledgerTasks.length ? "BGE 등 공유 장부 경로 없음" : "실행 중(dispatched) / 공유 한도"}</p>{capacity.reserved !== null && <p>예약 {number(capacity.reserved)} · 미확정 {recent ? number(recent.indeterminate) : "—"}</p>}{capacity.groups.map(group => <p key={group.labelId}>{deviceServer(group.labelId, models).name}: 장비 전체 점유 {number(group.sharedHeld)} / {number(group.limit)}{group.runningForStage > 0 ? ` · 이 단계 전송 ${number(group.runningForStage)}` : ""}{group.reservedForStage > 0 ? ` · 이 단계 예약 ${number(group.reservedForStage)}` : ""}</p>)}{capacity.unresolved && <p>현재 설정의 장비 한도 일부 미확인</p>}{offLedger && <p>공유 장부 밖 작업이 있어 실행 수를 0으로 단정하지 않습니다. {stage.taskIds.includes("product-embedding") && <Link prefetch={false} className="text-button" href="/admin/models/search">product-embedding 검색 모델 상태 →</Link>}</p>}</td><td>{stage.llm ? <ConfiguredModelRows llm={llm} /> : <span className="flow-model-note">LLM 없음</span>}</td><td>{stage.llm ? <LiveModelRows llm={llm} /> : <span className="flow-model-note">LLM 없음</span>}</td><td>{stage.llm ? <><RecentModelRows llm={llm} />{recent ? <p className="small muted">장부 최근 1시간 · 성공 {number(recent.succeeded1h)} / 실패 {number(recent.failed1h)}</p> : <p className="small muted">장부 표본 없음 · 별도 관측</p>}{offLedger && <p className="small muted">BGE 등 공유 장부 밖 · 별도 관측</p>}</> : <span className="flow-model-note">LLM 없음</span>}</td><td><Link prefetch={false} className="button small" href={stage.editHref}>단계 설정 →</Link>{stage.taskIds.map(id => <p key={id}><Link prefetch={false} className="text-button" href={flowModelTaskHref(id)}>{taskLabelOf(id)} · {isAiLiveTask(id) ? "순위 편집" : "현재 실행 설정에서 변경"} →</Link></p>)}</td></tr>; })}</DataTable></Panel><div className="grid two"><Panel title="결과 미확정 · 사람 검토"><div className="flex mb"><Tag tone={unknown ? "red" : "gray"}>미확정 검토 {number(unknown)}건</Tag><span className="small muted">성공·실패와 종료 근거를 대조</span></div><Facts rows={[["최근 요청", observation.requests.find(request => request.state === "indeterminate")?.requestId ?? (unavailable ? "미확인" : "열린 표본 없음")], ["현재 상태", "실제 성공·실패는 원본 근거로 검토"], ["점유 관계", "이 검토 행 자체는 슬롯을 점유하지 않음"]]} /><div className="decision-bar"><Link prefetch={false} className="button" href={requestHref}>근거 검토·기존 검토 폼 →</Link></div></Panel><Panel title="업무 완료의 증거"><ul className="list-rows"><li><span className="dot" /><div className="main"><b>모델 응답 종료</b><p>전송 결과·모델·시각·종료 사유</p></div><Tag tone="blue">호출 기록</Tag></li><li><span className="dot" /><div className="main"><b>판정·번역·공개 반영</b><p>도메인 원본의 실제 저장과 공개 확인</p></div><Link prefetch={false} className="text-button" href="/admin/flow">업무 흐름 →</Link></li><li><span className="dot" /><div className="main"><b>실행 중 전송의 물리 점유</b><p>소유 프로세스와 실제 종료 증거로 대조</p></div><Link prefetch={false} className="text-button" href="/admin/models?tab=capacity">장비 확인 →</Link></li></ul></Panel></div>{calls}</div>;

  return <ModelOpsPanel mode={observation.mode} requests={[]} models={[]} initialStates={opsStates} renderControls={controls => <div className="stack" style={{ width: "100%" }}><div className="flex between"><ReadStamp at={observation.observedAt} /><div className="flex"><button type="button" className="button" disabled={readOnly || unavailable || controls.disabled || !["open", "draining"].includes(observation.mode ?? "")} onClick={() => controls.open(observation.mode === "open" ? "admission-pause" : "admission-open", "model-capacity")}>{observation.mode === "draining" ? "신규 호출 접수 재개" : "신규 호출 접수 중지"}</button><Link prefetch={false} className="button" href={`/admin/models?tab=${tab}&advanced=1#model-advanced`}>고급 운영·기존 제어 →</Link></div></div>{contents}</div>} />;
}

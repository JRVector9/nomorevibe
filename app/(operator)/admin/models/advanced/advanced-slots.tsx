import Link from "next/link";
import { Suspense } from "react";
import { ensureCliStageCatalogs } from "@/lib/llm/admin-model-pools";
import { getSettings, settingsFormVersion } from "@/lib/crawl/settings";
import { readServedContractModels } from "@/lib/operations/admin-engine-connect";
import { configuredHumanModelsProbe, type HumanModelProbe } from "@/lib/operations/admin-models-human";
import { currentModelEnv } from "@/lib/operations/model-env";
import { adminModelStageView, type TextStageBindings } from "@/lib/operations/admin-model-stage-view";
import { firstReviewers } from "@/lib/crawl/first-reviewers";
import { ensureReviewTaskRanks } from "@/lib/crawl/review-task-ranks";
import { secondReviewVoterSets } from "@/lib/crawl/second-review-voters";
import { readAdminModelsObservation } from "@/lib/operations/admin-models-repository";
import { capacityMonitorThresholds, readModelCapacityUnknowns } from "@/lib/operations/model-capacity-unknowns";
import { buildModelCards, modelContractLinks, modelRecoveryBlocked, type CapacityAlarmSummary, type ModelContractLink, type ModelStageAssignment } from "@/lib/operations/admin-models-view";
import { AI_TEXT_TASK_IDS } from "@/lib/llm/ai-tasks";
import { TextTaskRanks } from "@/lib/llm/ai-task-resolver";
import { configuredModel, modelForPurpose, modelRequestName, MODEL_PURPOSE_ENV, readModelRegistry } from "@/lib/llm/model-registry";
import { servingContractSnapshot } from "@/lib/llm/serving-contract-store";
import { agentRequest } from "@/lib/operations/agent-client";
import type { AgentStatus } from "@/lib/operations/contracts";
import { screenModelConfig } from "@/lib/screen-review/vision-review";
import { modelServerHealth } from "@/lib/operations/model-servers";
import { assignmentSources, assignmentTableFlag } from "@/lib/operations/admin-assignment-source";
import { ASSIGNMENT_STAGE_IDS } from "@/lib/llm/capacity-helpers";
import { readCapacityDevicesAdminView } from "@/lib/operations/admin-capacity-devices";
import { readModelHelpersAdminView } from "@/lib/operations/admin-model-helpers";
import { readCatalogJobRegistration } from "@/lib/operations/admin-models-jobs";
import { autoProbeDirectEngines, readProbeObservations, recordAutoProbes } from "@/lib/operations/admin-models-probe-repository";
import { readbackServingEndpoint } from "@/lib/operations/admin-serving-contracts";
import { readModelRouteStatus } from "@/lib/operations/model-route-status";
import { roleOverview } from "@/lib/operations/roles";
import { MODELS_ADVANCED_EDITORS } from "../../workspace-navigation";
import { ReviewModelsForm } from "../ReviewModelsForm";
import { LiveModels } from "../LiveModels";
import { DevicesPanel } from "../DevicesPanel";
import { HelpersFold, type AssignmentSourceView } from "../HelpersFold";
import { HashTarget } from "./HashTarget";
import { ModelRouteContracts } from "./ModelRouteContracts";
import { TextTaskRanksStatus } from "./TextTaskRanksStatus";

/**
 * 고급 설정(/admin/models/advanced, 2026-11-07 승인 시안 PR 5) — 편집기 목록과 「장애 분석」.
 * 장애 분석은 옛 「한 화면」(/admin/models?advanced=1)에서 다른 곳에 자리가 없는 것만 옮겼다: 단계 × 모델 표(연결 확인·모델 재시작·정식 해제),
 * 장비 상세, 도우미 접기, 운영센터 진단 탭에 있던 text 작업 순위·모델 경로 계약 표. 확인 못함 검토 목록은 「기록」 화면이 맡는다.
 * page.tsx 는 Next 가 정한 것만 내보낼 수 있어 여기 둔다 — 시험은 이 함수들을 그대로 그린다(저장소 모듈만 바꿔 끼운다).
 */

/** 서버가 이 화면을 그리기 시작한 시각. 구성 요소 밖에서 읽는다(렌더 순수성 규칙). */
const renderClock = () => new Date();
/** 자동 확인 호출의 소요 ms — 결과와 함께 관측에 남긴다. */
async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> { const started = Date.now(); const value = await run(); return { value, ms: Date.now() - started }; }

/** 고급 설정 목록 — 편집기 일곱 개(무엇을 하고 언제 여는지 한 줄씩)와 이 화면 안의 두 구획. 이름은 메뉴와 같은 MODELS_ADVANCED_EDITORS 다. */
export function AdvancedEditorsIndex() {
  return <section className="llm-panel" aria-labelledby="advanced-editors-title">
    <div className="llm-panel-head"><h2 id="advanced-editors-title">편집기</h2>
      <span className="llm-muted text-[13px]">처음 설정하거나 장애를 분석할 때만 엽니다. 매일 보는 것은 대시보드·LLM 운영·작업 배정·기록에 있습니다.</span></div>
    <div className="llm-panel-body">
      <ul className="advanced-editors">{MODELS_ADVANCED_EDITORS.map(editor => <li key={editor.id} data-editor={editor.id}>
        <Link prefetch={false} href={editor.href} className="advanced-editor">
          <span className="advanced-editor-name">{editor.label} →</span>
          <span className="advanced-editor-purpose">{editor.purpose}</span>
        </Link>
      </li>)}</ul>
      <p className="llm-empty">이 화면 아래: <a className="llm-link" href="#analysis">장애 분석</a>(단계 × 모델 표·장비 상세·도우미·작업 순위·경로 계약) ·{" "}
        <a className="llm-link" href="#model-settings">단계별 모델 풀</a>(작업 배정에 없는 단계)</p>
    </div>
  </section>;
}

/** currentModelEnv already opened these cached snapshots. Only the non-secret identity and actual provider reach the view. */
async function textStageBindings(): Promise<TextStageBindings> {
  return Object.fromEntries(await Promise.all(AI_TEXT_TASK_IDS.map(async route => {
    try { return [route, (await TextTaskRanks.open(route)).bindings().map(({ identity, provider }) => ({ identity, provider }))] as const; }
    catch { return [route, null] as const; }
  })));
}

/** Bootstrap lives inside the boundary so cold contract/rank snapshots do not hide its fallback. */
export async function ModelsAdvancedAnalysis({ readOnly }: { readOnly: boolean }) {
  // Admin registry overrides (0148) are part of the registry this page shows and validates against.
  // ensureReviewTaskRanks already waits for both contracts and task ranks.
  const [settings, assignmentLocked] = await Promise.all([getSettings(),
    // 배정 표 플래그(3b-B) — 켜졌으면 아래 모델 선택 폼을 읽기 전용으로(PR 3b-D). 못 읽으면 꺼짐(편집 가능)
    assignmentTableFlag(), ensureReviewTaskRanks()]);
  const [models, bindings] = await Promise.all([currentModelEnv(), textStageBindings()]);

  await ensureCliStageCatalogs();
  const registry = readModelRegistry();
  const { defaults, assignments: stageAssignments } = adminModelStageView({ models, pools: settings.stageModelPools, bindings,
    legacyDefault: stage => stage.purpose === "screen-review" ? screenModelConfig()?.model ?? "미설정"
      : stage.purpose in MODEL_PURPOSE_ENV ? configuredModel(stage.purpose as keyof typeof MODEL_PURPOSE_ENV) : modelRequestName(modelForPurpose(stage.purpose)) });
  // 1차·2차는 「작업 ↔ 모델」 순위(PR C1) — 실행 쪽이 읽는 그대로(1차 1·2·3순위, 2차 칸마다 지금 표를 내는 순위 → 그 밖의 순위)
  const secondSets = secondReviewVoterSets(settings);
  const assignments: ModelStageAssignment[] = [
    { id: "first-review", label: "1차 검수", models: firstReviewers(settings) },
    { id: "second-review", label: "2차 검수", models: [...secondSets.voters, ...secondSets.fallbacks] },
    ...stageAssignments,
  ];
  // 관리 계약(0147)의 주소는 host:port 만 넘긴다 — 장비 칸의 「장비 미확인」을 줄이고 전송 방식을 보이기 위해서다. 키는 ModelContractLink 에 없다.
  const contracts = modelContractLinks(servingContractSnapshot().rows);
  const observationRead = readAdminModelsObservation({ throughput: true });
  const servedModels = !readOnly ? readServedContractModels() : Promise.resolve([]);
  // 사람 위임 슬롯의 자동 연결 확인은 한 번만 — 표(연결 확인 열)가 이 약속을 기다린다.
  const humanKeys = settings.stageModelPools?.["human-review"] ?? [];
  const humanProbe = !readOnly ? configuredHumanModelsProbe(humanKeys).catch((): HumanModelProbe[] => []) : Promise.resolve([] as HumanModelProbe[]);
  return <>
    <section className="panel scroll-mt-28 md:scroll-mt-16" id="analysis" aria-labelledby="analysis-title">
      <div className="panel-head"><div><h2 id="analysis-title">장애 분석</h2>
        <p>단계 × 모델 표에서 연결 확인·모델 재시작·정식 해제를 합니다. 모델 재시작과 정식 해제는 되돌릴 수 없어 사유를 적어야 누를 수 있습니다.</p></div></div>
      <div className="panel-body stack">
        <Suspense fallback={<p aria-busy="true" className="text-[13px]">운영 DB 실측 확인 중…</p>}><LiveModelsSlot assignments={assignments} models={registry.models} contracts={contracts} humanProbe={humanProbe} served={servedModels} read={observationRead} readOnly={readOnly} /></Suspense>
        <p id="review" className="notice scroll-mt-28 md:scroll-mt-16">확인 못함 · 사람 검토(다시 대기열·닫기)는 「기록」 화면에서 합니다.{" "}
          <Link prefetch={false} href="/admin/models/history" className="font-semibold text-accent-ink">기록 →</Link></p>
        <Suspense fallback={<p aria-busy="true" className="text-[13px]">장비 한도 확인 중…</p>}><DevicesSlot models={registry.models} /></Suspense>
        <Suspense fallback={<p aria-busy="true" className="text-[13px]">도우미·배정 출처·새 잡 확인 중…</p>}><HelpersSlot contracts={contracts} /></Suspense>
        <section id="llm-routes" className="grid min-w-0 gap-3 scroll-mt-28 md:scroll-mt-16 *:min-w-0" aria-label="작업 순위·경로 계약">
          <Suspense fallback={<p className="text-[13px] text-fg-3" aria-busy="true">작업 ↔ 모델 순위를 읽는 중…</p>}><TextTaskRanksSlot /></Suspense>
          <Suspense fallback={<p className="text-[13px] text-fg-3" aria-busy="true">모델 경로 계약을 읽는 중…</p>}><ModelRouteSlot /></Suspense>
        </section>
        <section className="grid min-w-0 gap-2 rounded-xl border border-line bg-bg-card p-4" aria-labelledby="auto-probes-title">
          <h3 id="auto-probes-title" className="text-[15px] font-semibold">자동 연결 확인 · 다른 화면에서 고치는 모델</h3>
          <p className="text-[13px] text-fg-2">이 화면을 열 때마다 확인해 표의 연결 확인 열에 남깁니다. 모델 선택은 각 화면에서 합니다.</p>
          {readOnly ? <p className="text-[13px] text-fg-2">읽기 전용 미리보기에서는 새 연결 확인을 하지 않습니다. 위 표에 저장된 결과를 보입니다.</p> : <ul className="grid gap-1.5 text-[13px]">
            <Suspense fallback={<li aria-busy="true">카테고리 분류 모델 확인 중…</li>}><ClassifierProbeSlot /></Suspense>
            <Suspense fallback={<li aria-busy="true">검색 서버 확인 중…</li>}><SearchProbeSlot /></Suspense>
          </ul>}
        </section>
        <p className="text-[13px] leading-relaxed text-fg-2">처리 시간은 장부 접수 → 실제 종료(대기 포함). 1시간 성공·실패는 최근 1시간의 실제 종료만 집계. 철회·미확인 요청은 처리량에 넣지 않음. 접수 일시중지/재개는 모든 공통 모델에 적용. 저장한 설정은 배포 없이 30초 안에 각 앱이 다음 작업부터 사용.</p>
      </div>
    </section>
    <details id="stage-pools" className="min-w-0 rounded-xl border border-line bg-bg-card scroll-mt-28 md:scroll-mt-16">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-[15px] font-semibold"><span id="model-settings-title">단계별 모델 풀</span>
        <span className="text-[13px] font-normal text-fg-2">작업 배정 순위가 없는 단계(Qwen 검수 풀·감사·화면 판별 등)의 모델 · 이 화면에서만 바꿉니다{assignmentLocked ? " · 배정 표로 옮겨져 읽기 전용" : ""}</span></summary>
      <div className="flex min-w-0 flex-col gap-3 px-4 pb-4" aria-labelledby="model-settings-title">
        <ReviewModelsForm settings={settings} version={settingsFormVersion(settings)} models={registry.models} defaults={defaults} locked={assignmentLocked || readOnly} />
      </div>
    </details>
    <HashTarget />
  </>;
}

/** 장부 경보 요약 — monitor 와 같은 읽기(readModelCapacityUnknowns)·같은 문턱. 못 읽었으면 unknown(0건으로 보지 않는다). */
async function readAlarmSummary(): Promise<CapacityAlarmSummary> {
  const thresholds = capacityMonitorThresholds(), report = await readModelCapacityUnknowns(thresholds).catch(() => null);
  if (!report || report.status === "unknown") return { status: "unknown", count: 0, oldestAgeSeconds: null, stuckDispatched: 0, alarmReasons: [], thresholds };
  return { status: report.status, count: report.count, oldestAgeSeconds: report.oldestAgeSeconds, stuckDispatched: report.stuckDispatched, alarmReasons: [...report.alarmReasons], thresholds };
}

async function LiveModelsSlot({ assignments, models, contracts, humanProbe, served, read, readOnly = false }: { assignments: ModelStageAssignment[]; models: ReturnType<typeof readModelRegistry>["models"]; contracts: ModelContractLink[]; humanProbe: Promise<HumanModelProbe[]>; served: ReturnType<typeof readServedContractModels>; read?: ReturnType<typeof readAdminModelsObservation>; readOnly?: boolean }) {
  const { readModelOpsStates } = await import("@/lib/operations/ops-runner/repository");
  const observationRead = read ?? readAdminModelsObservation();
  // 엔진 직접 연결 계약의 자동 확인(GET /models, 슬롯마다 1분에 한 번) — 장부를 읽자마자 다른 읽기·사람 위임 확인과 나란히 돈다. 던지지 않는다.
  const directProbes = readOnly ? Promise.resolve(0) : observationRead.then(observation => autoProbeDirectEngines(buildModelCards(observation, models, assignments, contracts),
    servingContractSnapshot().rows, readbackServingEndpoint)).catch(() => 0);
  const [observation, states, roles, alarms, human, servedModels] = await Promise.all([observationRead, readModelOpsStates().catch(() => []),
    roleOverview().catch(() => null), readAlarmSummary(), humanProbe, served]);
  // 사람 위임 슬롯의 자동 확인 결과를 같은 키(probe:<provider>:<key>)에 남긴 뒤 읽는다 — 표의 연결 확인 열이 「자동(렌더)」으로 보인다.
  await Promise.all([readOnly ? Promise.resolve(0) : recordAutoProbes(human.map(probe => ({ identity: { routeId: "human-deepseek-review", provider: probe.provider, model: probe.key },
    result: { listed: probe.ready ? true : null, listMs: probe.ms, callBlocked: "유료 DeepSeek 시험 호출은 허용되지 않습니다.", error: probe.ready ? null : "사람 위임 모델 목록 확인 실패(연결 또는 목록 없음)" },
    detail: "사람 위임 슬롯 · GET /models" }))), directProbes]);
  const probes = await readProbeObservations();
  return <LiveModels observation={observation} opsStates={states} assignments={assignments} models={models} contracts={contracts} served={servedModels} probes={probes}
    leases={roles?.roles ?? []} readiness={roles?.overall ?? null} alarms={alarms}
    restartModels={models.map(row => ({ key: row.key, label: row.displayName, blockedReason: modelRecoveryBlocked(row.equipment, row.provider) }))} />;
}

async function DevicesSlot({ models }: { models: ReturnType<typeof readModelRegistry>["models"] }) {
  const [view, probes] = await Promise.all([readCapacityDevicesAdminView(renderClock()), readProbeObservations()]);
  return <DevicesPanel view={view} models={models} probes={probes} />;
}

async function HelpersSlot({ contracts }: { contracts: ModelContractLink[] }) {
  const [helpers, flag, sources, jobs] = await Promise.all([readModelHelpersAdminView().catch(() => null), assignmentTableFlag(),
    assignmentSources(ASSIGNMENT_STAGE_IDS).then(value => ({ value, error: null as string | null })).catch(error => ({ value: {}, error: error instanceof Error ? error.message : "read_failed" })),
    readCatalogJobRegistration()]);
  const assignment: AssignmentSourceView = { flag, sources: sources.value, error: sources.error };
  return <HelpersFold helpers={helpers} assignment={assignment} jobs={jobs} contracts={contracts} />;
}

/** 작업 ↔ 모델 text 작업 순위(PR B, 운영센터 진단 탭에서 옮김) — 저장한 순위·쓸 수 없는 까닭(이 웹 프로세스의 스냅숏)과 잡의 마지막 틱의 순위 사정 */
async function TextTaskRanksSlot() {
  const { readAiTaskRuntime } = await import("@/lib/operations/admin-ai-tasks-repository");
  const read = await readAiTaskRuntime().then(value => ({ value, error: null }),
    (cause: unknown) => ({ value: {} as Awaited<ReturnType<typeof readAiTaskRuntime>>, error: cause instanceof Error ? cause.message.slice(0, 120) : "read_failed" }));
  const lines = await Promise.all(AI_TEXT_TASK_IDS.map(async task => ({ task, resolution: (await TextTaskRanks.open(task)).resolution,
    runtime: read.value[task] ?? null })));
  return <TextTaskRanksStatus lines={lines} error={read.error} />;
}

/** 모델 경로 계약·전환 진행(ops-v8 PR8, 운영센터 진단 탭에서 옮김) — 운영 CLI status 와 같은 readback 을 복제본에서만. 못 읽으면 보류 */
async function ModelRouteSlot() {
  return <ModelRouteContracts status={await readModelRouteStatus(await currentModelEnv())} />;
}

/**
 * 카테고리 분류(connect CLI)의 자동 확인 — 우선·예비 모델을 probe:<provider>:<model> 로 남긴다. 연결 안 됨은 목록 null + 오류다.
 * 모델 선택은 운영센터 › AI 연결(분류 모델 선택)이 맡는다 — 여기는 결과 한 줄과 그리로 가는 링크만.
 */
async function ClassifierProbeSlot() {
  const { value: initial, ms } = await timed(() => agentRequest<AgentStatus>("status").catch(() => null));
  const configured = initial ? [initial.config.primary, initial.config.fallback].filter((row): row is NonNullable<typeof row> => !!row) : [];
  const saved = await recordAutoProbes(configured.map(row => ({ identity: { routeId: null, provider: initial?.modelOptions?.find(option => option.model === row.model)?.provider ?? "codex-cli", model: row.model },
    result: { listed: initial?.connected && initial.classifyReady !== false ? true : null, listMs: ms,
      error: !initial?.connected ? "connect 에이전트 연결 안 됨" : initial.classifyReady === false ? "분류 요청을 받지 않음(설정·계정 확인)" : null },
    detail: "카테고리 분류 · connect 상태" })));
  const state = !initial ? "connect 상태를 읽지 못함(연결 안 됨으로 보지 않음)" : !initial.connected ? "연결 안 됨" : initial.classifyReady === false ? "분류 요청을 받지 않음" : "연결됨";
  const names = configured.map(row => row.model).join(" → ");
  return <li><b>카테고리 분류 모델</b> · {state}{names ? ` · ${names}` : ""}{initial ? ` · 응답 ${ms}ms` : ""}{saved ? ` · 관측 ${saved}건 저장` : ""}
    {" · "}<Link prefetch={false} href="/admin/status?tab=ai#ai-model-title" className="font-semibold text-accent-ink">운영센터 › AI 연결에서 모델 고르기 →</Link></li>;
}

/** 검색 서버(임베딩·재정렬)의 자동 확인 — probe:search-server:embedding|rerank 로 남긴다. 모델 바꾸기는 「검색 모델」 화면. */
async function SearchProbeSlot() {
  const { value: health, ms } = await timed(() => modelServerHealth());
  const saved = await recordAutoProbes(health.map(row => ({ identity: { routeId: null, provider: "search-server", model: row.name === "임베딩" ? "embedding" : "rerank" },
    result: { listed: row.ok ? true : null, listMs: ms, error: row.ok ? null : `서버 확인 실패 · ${row.error ?? "미확인"}` }, detail: "검색 API 메타데이터·상태 응답" })));
  const parts = health.map(row => `${row.name} ${row.ok ? "응답 확인" : `확인 실패(${row.error ?? "미확인"})`}`);
  return <li><b>검색 서버</b> · {parts.length ? parts.join(" · ") : "연결 환경 미설정"}{health.length ? ` · 응답 ${ms}ms` : ""}{saved ? ` · 관측 ${saved}건 저장` : ""}
    {" · "}<Link prefetch={false} href="/admin/models/search" className="font-semibold text-accent-ink">검색 모델 →</Link></li>;
}

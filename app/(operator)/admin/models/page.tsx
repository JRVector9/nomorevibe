import { TextModelStagesTable } from "./TextModelStagesTable";
import { ModelRegistryTable } from "./ModelRegistryTable";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { getSettings, settingsFormVersion } from "@/lib/crawl/settings";
import { listGatewayModels } from "@/lib/crawl/agent-review-gateway";
import { configuredHumanModelsProbe, configuredHumanModelsReady, humanReviewModelDisplay, type HumanModelProbe } from "@/lib/operations/admin-models-human";
import { currentModelEnv } from "@/lib/operations/model-env";
import { PageStamp } from "../components/PageStamp";
import { HumanReviewSwitch } from "../review/HumanReviewSwitch";
import { ReviewModelsForm } from "./ReviewModelsForm";
import { reviewModelOptions } from "./model-options";
import { readAdminModelsObservation } from "@/lib/operations/admin-models-repository";
import { LiveModels } from "./LiveModels";
import { ModelsTopBar } from "./RefreshBar";
import { UnknownReviewList } from "./UnknownReviewList";
import { DevicesPanel } from "./DevicesPanel";
import { HelpersFold, type AssignmentSourceView } from "./HelpersFold";
import { capacityMonitorThresholds, readModelCapacityReviewQueue, readModelCapacityUnknowns } from "@/lib/operations/model-capacity-unknowns";
import { modelContractLinks, modelRecoveryBlocked, type CapacityAlarmSummary, type ModelContractLink, type ModelStageAssignment } from "@/lib/operations/admin-models-view";
import { ADMIN_MODEL_STAGES } from "@/lib/llm/admin-model-stages";
import { configuredModel, modelForPurpose, modelRequestName, MODEL_PURPOSE_ENV, readModelRegistry } from "@/lib/llm/model-registry";
import { ensureServingContracts, servingContractSnapshot } from "@/lib/llm/serving-contract-store";
import { AiConnection } from "../status/AiConnection";
import { agentRequest } from "@/lib/operations/agent-client";
import type { AgentStatus } from "@/lib/operations/contracts";
import { screenModelConfig } from "@/lib/screen-review/vision-review";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/lib/domain/products/embedding";
import { modelServerHealth } from "@/lib/operations/model-servers";
import { assignmentSources, assignmentTableFlag } from "@/lib/operations/admin-assignment-source";
import { ASSIGNMENT_STAGE_IDS } from "@/lib/llm/capacity-helpers";
import { readCapacityDevicesAdminView } from "@/lib/operations/admin-capacity-devices";
import { readModelHelpersAdminView } from "@/lib/operations/admin-model-helpers";
import { readCatalogJobRegistration } from "@/lib/operations/admin-models-jobs";
import { readProbeObservations, recordAutoProbes } from "@/lib/operations/admin-models-probe-repository";
import { roleOverview } from "@/lib/operations/roles";
import { SearchModelConstraints } from "./SearchModelConstraints";
import "../status/operations.css";
import "./models.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "모델 운영 현황 — NoMoreVibe", robots: { index: false } };

/** 서버가 이 화면을 그리기 시작한 시각 — 상단 띠의 「마지막 갱신」. 구성 요소 밖에서 읽는다(렌더 순수성 규칙). */
const renderClock = () => new Date();
/** 자동 확인 호출의 소요 ms — 결과와 함께 관측에 남긴다. */
async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> { const started = Date.now(); const value = await run(); return { value, ms: Date.now() - started }; }

/**
 * /admin/models 한 화면(2026-10-31 승인 시안): 고정 상단 띠 → 요약 타일 4 → 단계 × 모델 표 → 장비 표 | 확인 못함 목록 → 접기 2(도우미·감시자·배정 출처·새 잡 / 참고).
 * 모든 구획이 실제 출처만 읽는다 — 장부 관측·장비 로더·도우미 로더·배정 출처·역할 lease·장부 경보 요약·jobs 표·연결 확인 관측. 하위 화면은 그대로 두고 여기서는 요약+링크다.
 */
export default async function ModelsPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  // Admin registry overrides (0148) are part of the registry this page shows and validates against.
  await ensureServingContracts();
  const renderedAt = renderClock().toISOString();
  const [settings, gatewayModels, models, assignmentLocked] = await Promise.all([getSettings(), listGatewayModels(), currentModelEnv(),
    // 배정 표 플래그(3b-B) — 켜졌으면 아래 모델 선택 폼을 읽기 전용으로(PR 3b-D). 못 읽으면 꺼짐(편집 가능)
    assignmentTableFlag()]);

  const registry = readModelRegistry();
  const defaults = Object.fromEntries(ADMIN_MODEL_STAGES.map(stage => [stage.id, stage.purpose === "screen-review" ? screenModelConfig()?.model ?? "미설정"
    : stage.purpose in MODEL_PURPOSE_ENV ? configuredModel(stage.purpose as keyof typeof MODEL_PURPOSE_ENV) : modelRequestName(modelForPurpose(stage.purpose))]));
  const assignments: ModelStageAssignment[] = [
    { id: "first-review", label: "1차 검수", models: [settings.firstReview ?? { provider: "abcllm", model: modelRequestName(modelForPurpose("ai1-preset")) }, ...(settings.firstReviewAdditional ?? [])] },
    { id: "second-review", label: "2차 검수", models: [...settings.secondReview.voters, ...(settings.secondReview.fallbacks ?? [])] },
    ...ADMIN_MODEL_STAGES.map(stage => ({ id: stage.id, label: stage.label, models: (settings.stageModelPools?.[stage.id]?.length
      ? settings.stageModelPools[stage.id]! : [defaults[stage.id]]).map(model => ({ provider: stage.provider, model })) })),
  ];
  // 관리 계약(0147)의 주소는 host:port 만 넘긴다 — 장비 칸의 「장비 미확인」을 줄이고 전송 방식을 보이기 위해서다. 키는 ModelContractLink 에 없다.
  const contracts = modelContractLinks(servingContractSnapshot().rows);
  // 사람 위임 슬롯의 자동 연결 확인은 한 번만 — 표(연결 확인 열)와 참고의 사람 검토 단계가 같은 약속을 기다린다.
  const humanKeys = settings.stageModelPools?.["human-review"] ?? [];
  const humanProbe = configuredHumanModelsProbe(humanKeys).catch((): HumanModelProbe[] => []);
  return <main className="mx-auto flex max-w-[1440px] flex-col gap-3 px-8 pb-28 max-sm:px-4">
    <PageStamp />
    <ModelsTopBar renderedAt={renderedAt} />
    <Suspense fallback={<p aria-busy="true" className="text-[13px]">운영 DB 실측 확인 중…</p>}><LiveModelsSlot assignments={assignments} models={registry.models} contracts={contracts} humanProbe={humanProbe} /></Suspense>
    <div className="grid gap-3 [grid-template-columns:minmax(0,7fr)_minmax(0,5fr)] max-[980px]:grid-cols-1">
      <Suspense fallback={<p aria-busy="true" className="text-[13px]">장비 한도 확인 중…</p>}><DevicesSlot models={registry.models} /></Suspense>
      <Suspense fallback={<p aria-busy="true" className="text-[13px]">사람 검토 목록 확인 중…</p>}><UnknownReviewSlot /></Suspense>
    </div>
    <Suspense fallback={<p aria-busy="true" className="text-[13px]">도우미·배정 출처·새 잡 확인 중…</p>}><HelpersSlot contracts={contracts} /></Suspense>
    <details id="ref" className="min-w-0 rounded-xl border border-line bg-bg-card scroll-mt-28 md:scroll-mt-16">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-[14px] font-semibold">참고 · 카테고리 분류 · 검색 모델 · 모델 연결(계약) · 등록부 · 모델 선택
        <span className="text-[13px] font-normal text-fg-2">관리 계약 <span className="font-mono tabular-nums">{contracts.length}</span> · 등록부 <span className="font-mono tabular-nums">{registry.models.length}</span>{assignmentLocked ? " · 모델 선택 폼은 배정 표로 옮겨져 읽기 전용" : ""}</span></summary>
      <div className="flex min-w-0 flex-col gap-4 px-3 pb-3">
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
          <Suspense fallback={<p aria-busy="true" className="text-[13px]">카테고리 분류 모델 확인 중…</p>}><CategoryModelsSlot reviewMode={settings.reviewMode} /></Suspense>
          <Suspense fallback={<p aria-busy="true" className="text-[13px]">검색 모델 서버 확인 중…</p>}><SearchModelsSlot /></Suspense>
        </div>
        <section className="flex flex-col gap-3 rounded-xl border border-line bg-bg-card p-4" aria-labelledby="human-model-heading">
          <h2 id="human-model-heading" className="text-[15px] font-semibold">사람 검토 단계</h2>
          <p className="text-[13px] text-fg-2">직접 판단: 사람이 심사 큐에서 결정합니다. 사람 위임 검수 모델을 켜면 기존 정책에 따라 자동 판단하고, 불확실하거나 실패한 항목은 사람이 검토합니다.</p>
          <Suspense fallback={<p aria-busy="true" className="text-[13px]">사람 위임 모델 연결 확인 중…</p>}>
            <HumanSlot enabled={settings.humanReview.enabled} generation={settings.humanReview.generation} keys={humanKeys} humanProbe={humanProbe} />
          </Suspense>
          <Link prefetch={false} href="/admin/review" className="text-[13px] font-semibold text-accent-ink">사람이 검토할 심사 큐 열기 →</Link>
        </section>
        <section className="flex flex-col gap-3 rounded-xl border border-line bg-bg-card p-4" aria-labelledby="text-model-heading">
          <h2 id="text-model-heading" className="text-[15px] font-semibold">다른 LLM 단계 · 배포 기본값</h2>
          <p className="text-[13px] text-fg-2">풀을 비웠을 때 사용하는 웹 프로세스의 배포 기본값입니다. 단계별 모델 풀에서 저장한 선택이 새 작업에 우선합니다. 실제 호출과 점유는 위 단계 × 모델 표에서 확인하세요.</p>
          <TextModelStagesTable models={models} />
          <div className="flex flex-wrap gap-4 text-[13px] font-semibold text-accent-ink"><Link href="/admin/audit" prefetch={false}>감사 단계 설정 →</Link><Link href="/admin/status#ai-model-title" prefetch={false}>카테고리 분류 모델 선택 →</Link><Link href="/admin/status" prefetch={false}>단계별 실제 경로 →</Link></div>
        </section>
        <ModelRegistryTable />
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="model-settings">
          <h2 id="model-settings" className="text-[15px] font-semibold">단계별 모델 선택(설정)</h2>
          <ReviewModelsForm settings={settings} version={settingsFormVersion(settings)} models={registry.models} defaults={defaults} locked={assignmentLocked}
            firstChoices={reviewModelOptions(gatewayModels, false)} secondChoices={reviewModelOptions(gatewayModels, true)} />
        </section>
      </div>
    </details>
    <p className="text-[13px] leading-relaxed text-fg-2">처리 시간은 장부 접수 → 실제 종료(대기 포함). 1시간 성공·실패는 최근 1시간의 실제 종료만 집계. 철회·미확인 요청은 처리량에 넣지 않음. 접수 일시중지/재개는 모든 공통 모델에 적용. 저장한 설정은 배포 없이 30초 안에 각 앱이 다음 작업부터 사용.</p>
  </main>;
}

/** 장부 경보 요약 — monitor 와 같은 읽기(readModelCapacityUnknowns)·같은 문턱. 못 읽었으면 unknown(0건으로 보지 않는다). */
async function readAlarmSummary(): Promise<CapacityAlarmSummary> {
  const thresholds = capacityMonitorThresholds(), report = await readModelCapacityUnknowns(thresholds).catch(() => null);
  if (!report || report.status === "unknown") return { status: "unknown", count: 0, oldestAgeSeconds: null, stuckDispatched: 0, alarmReasons: [], thresholds };
  return { status: report.status, count: report.count, oldestAgeSeconds: report.oldestAgeSeconds, stuckDispatched: report.stuckDispatched, alarmReasons: [...report.alarmReasons], thresholds };
}

async function LiveModelsSlot({ assignments, models, contracts, humanProbe }: { assignments: ModelStageAssignment[]; models: ReturnType<typeof readModelRegistry>["models"]; contracts: ModelContractLink[]; humanProbe: Promise<HumanModelProbe[]> }) {
  const { readModelOpsStates } = await import("@/lib/operations/ops-runner/repository");
  const [observation, states, roles, alarms, human] = await Promise.all([readAdminModelsObservation(), readModelOpsStates().catch(() => []),
    roleOverview().catch(() => null), readAlarmSummary(), humanProbe]);
  // 사람 위임 슬롯의 자동 확인 결과를 같은 키(probe:<provider>:<key>)에 남긴 뒤 읽는다 — 표의 연결 확인 열이 「자동(렌더)」으로 보인다.
  await recordAutoProbes(human.map(probe => ({ identity: { routeId: "human-deepseek-review", provider: probe.provider, model: probe.key },
    result: { listed: probe.ready ? true : null, listMs: probe.ms, callBlocked: "유료 DeepSeek 시험 호출은 허용되지 않습니다.", error: probe.ready ? null : "사람 위임 모델 목록 확인 실패(연결 또는 목록 없음)" },
    detail: "사람 위임 슬롯 · GET /models" })));
  const probes = await readProbeObservations();
  return <LiveModels observation={observation} opsStates={states} assignments={assignments} models={models} contracts={contracts} probes={probes}
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

async function CategoryModelsSlot({ reviewMode }: { reviewMode: string }) {
  const { value: initial, ms } = await timed(() => agentRequest<AgentStatus>("status").catch(() => null));
  // 카테고리 분류(connect CLI)의 자동 확인 — 우선·예비 모델을 probe:<provider>:<model> 로 남긴다. 연결 안 됨은 목록 null + 오류다.
  const configured = initial ? [initial.config.primary, initial.config.fallback].filter((row): row is NonNullable<typeof row> => !!row) : [];
  const saved = await recordAutoProbes(configured.map(row => ({ identity: { routeId: null, provider: initial?.modelOptions?.find(option => option.model === row.model)?.provider ?? "codex-cli", model: row.model },
    result: { listed: initial?.connected && initial.classifyReady !== false ? true : null, listMs: ms,
      error: !initial?.connected ? "connect 에이전트 연결 안 됨" : initial.classifyReady === false ? "분류 요청을 받지 않음(설정·계정 확인)" : null },
    detail: "카테고리 분류 · connect 상태" })));
  return <section className="rounded-xl border border-line bg-bg-card p-4"><h2 className="mb-2 text-[15px] font-semibold">카테고리 분류 모델</h2>
    <p className="mb-2 text-[13px] text-fg-2">{initial ? `연결 확인 자동(렌더) · 방금 · 응답 ${ms}ms${saved ? ` · 관측 ${saved}건 저장` : ""}` : "connect 상태를 읽지 못했습니다 — 연결 안 됨으로 보지 않습니다."}</p>
    <AiConnection initial={initial} reviewMode={reviewMode} /></section>;
}

async function SearchModelsSlot() {
  const { value: health, ms } = await timed(() => modelServerHealth());
  const saved = await recordAutoProbes(health.map(row => ({ identity: { routeId: null, provider: "search-server", model: row.name === "임베딩" ? "embedding" : "rerank" },
    result: { listed: row.ok ? true : null, listMs: ms, error: row.ok ? null : `서버 확인 실패 · ${row.error ?? "미확인"}` }, detail: "검색 모델 서버 · GET /health" })));
  return <SearchModelConstraints health={health} embeddingModel={EMBEDDING_MODEL} dimensions={EMBEDDING_DIMENSIONS} probedAgo={health.length ? `방금 · 응답 ${ms}ms${saved ? ` · 관측 ${saved}건 저장` : ""}` : null} />;
}

async function HumanSlot({ enabled, generation, keys, humanProbe }: { enabled: boolean; generation: number; keys: string[]; humanProbe: Promise<HumanModelProbe[]> }) {
  const probes = await humanProbe;
  const ready = probes.length ? probes.every(probe => probe.ready) : await configuredHumanModelsReady(keys);
  return <HumanReviewSwitch key={generation} enabled={enabled} generation={generation} ready={ready} {...humanReviewModelDisplay(keys)} />;
}

async function UnknownReviewSlot() {
  return <UnknownReviewList queue={await readModelCapacityReviewQueue()} />;
}

import { cache, Suspense } from "react";
import { readEvidenceVerdicts, readSourceSplit, type EvidenceVerdicts } from "@/lib/operations/flow-reads";
import type { ReplicaRead } from "@/lib/operations/replica-hold";
import { readXStatus } from "@/lib/operations/x-status";
import { logger } from "@/lib/observability/logger";
import type { ActionInputs, DerivedStatus } from "./attention";
import type { ActionItem } from "./dashboard/AttentionList";
import { DOT_TONE, EnrichmentCell, FlowCellPending, SourceCell, TransitionCell } from "./dashboard/FlowCells";
import { enrichmentNodes, enrichmentSummary, sourceSummary, transitionSummary, xSummary } from "./flow-model";
import { controlStatusOnce } from "./render-reads";

/**
 * 운영센터 v8 요약 칸의 조각 — 칸마다 따로 기다린다(칸별 Suspense). 지금 블록의 조각(page.tsx)과 따로 흐른다.
 * 들어오는 곳·보강의 새 숫자는 복제본 전용(lib/operations/flow-reads.ts), 설정 전환은 장부 조각과 같은 cache() 결과다.
 */
export type FlowSlotProps = { inputs: ActionInputs; derived: DerivedStatus; actions: ActionItem[]; fresh: boolean };

/** 같은 렌더의 보강 칸·폰 미니 점·흐름 상세가 근거 판정을 한 번만 받게 — 새로고침이 캐시를 건너뛰어도 렌더당 한 번 */
export const evidenceFor = cache((inputs: ActionInputs, fresh: boolean): Promise<ReplicaRead<EvidenceVerdicts>> =>
  readEvidenceVerdicts({ settings: inputs.settings, jobs: inputs.jobStates, observations: inputs.ops.observations, batch: inputs.jobBatch,
    now: new Date(inputs.ops.fetchedAt), fresh }).catch((error) => {
    logger.warn("operations.evidence_verdicts_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return { ok: false as const, reason: "error" as const };
  }));

/** 레일 옆 칸과 흐름 상세 탭이 같은 렌더에서 나눔을 한 번만 받게(인스턴스 캐시 60초와 별개) */
export const sourceSplitOnce = cache(() => readSourceSplit());

export async function SourceCellSlot({ inputs }: Pick<FlowSlotProps, "inputs">) {
  const split = await sourceSplitOnce();
  return <SourceCell summary={sourceSummary(split, inputs.settings)} x={xSummary(readXStatus(inputs.ops.observations, inputs.ops.fetchedAt))} />;
}

export async function EnrichmentCellSlot({ inputs, derived, actions, fresh }: FlowSlotProps) {
  const evidence = await evidenceFor(inputs, fresh);
  const nodes = enrichmentNodes({ actions, jobs: inputs.jobStates, evidence, health: derived.health, attention: inputs.attention, now: inputs.ops.fetchedAt });
  return <EnrichmentCell nodes={nodes} evidence={evidence} />;
}

export async function TransitionCellSlot() {
  return <TransitionCell summary={transitionSummary(await controlStatusOnce())} />;
}

/** 폰 흐름 미니의 "보강" 점 — 보강 칸과 같은 판정. 오기 전에는 회색 점으로 자리를 지킨다 */
export async function EnrichmentDotSlot({ inputs, derived, actions, fresh }: FlowSlotProps) {
  const evidence = await evidenceFor(inputs, fresh);
  const summary = enrichmentSummary(enrichmentNodes({ actions, jobs: inputs.jobStates, evidence, health: derived.health,
    attention: inputs.attention, now: inputs.ops.fetchedAt }), evidence);
  return <EnrichmentDot tone={DOT_TONE[summary.tone]} title={`발행 후 보강 ${summary.value}`} />;
}

export function EnrichmentDot({ tone, title }: { tone?: "ok" | "warn" | "bad"; title: string }) {
  return <span className="d" title={title}><i className="dash-dot" data-tone={tone} aria-hidden /><b>보강</b></span>;
}

/**
 * 요약 칸 셋. rail — 넓은 화면의 레일 오른쪽 4칸(레일 높이 안, 1,180px 이하에서는 숨김). tab — 흐름 상세 탭 맨 위(모든 폭).
 */
export function FlowSideCells({ variant, ...props }: FlowSlotProps & { variant: "rail" | "tab" }) {
  return (
    <div className={variant === "rail" ? "dash-4 ops-v8-side" : "ops-v8-cells"} aria-label="흐름 요약 — 들어오는 곳 · 발행 후 보강 · 설정 전환">
      <div className="ops-v8-cells-in">
        <Suspense fallback={<FlowCellPending label="들어오는 곳" />}><SourceCellSlot inputs={props.inputs} /></Suspense>
        <Suspense fallback={<FlowCellPending label="발행 후 보강 12단계" />}><EnrichmentCellSlot {...props} /></Suspense>
        <Suspense fallback={<FlowCellPending label="설정 전환 · 재해 복구" />}><TransitionCellSlot /></Suspense>
      </div>
    </div>
  );
}

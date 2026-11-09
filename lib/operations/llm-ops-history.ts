import type { AdminModelsObservation } from "./admin-models-observation";
import type { CapacityReviewItem, CapacityReviewQueue } from "./model-capacity-unknowns";
import { llmReasonShort, routeTaskLabel } from "./llm-ops-view";
import { requeueReasonText, type RequeueOutcome } from "./model-capacity-requeue-text";
export { LLM_RETRY_HREF, llmRetryRowHref } from "./llm-ops-links";

/**
 * 「LLM 운영 › 기록」(2026-11-07 승인 시안 PR 3)의 화면 모형 — DB 를 읽지 않는 순수 함수다.
 * 재실행 패널(결과 미확정 묶음)·최근 1시간 실패·변경 기록 한 표의 갈래(연결·한도·순위·조치)를 만든다. 쓰기는 기존 서버 동작 그대로다
 * (requeueUnknownReviews·closeUnknownReview).
 */

// ── 변경 기록 갈래 ──────────────────────────────────────────────────────────────────────────────────

/**
 * 작업 로그 「LLM 운영」 묶음(app/(operator)/admin/activity/labels.ts ACTION_GROUPS.llm)을 넷으로 나눈다. 한 작업은 한 갈래에만 든다 —
 * 시험(tests/admin-llm-history.test.ts)이 두 목록이 같은지 본다. 새 작업을 묶음에 더하면 여기에도 더한다.
 */
export const LLM_HISTORY_KINDS = Object.freeze({
  connection: { label: "연결", actions: ["ai-connection-save", "ai-connection-models-read", "ai-connection-delete", "ai-connection-model-hide", "ai-connection-key-fill",
    "model-serving-contract-save", "model-serving-contract-disable", "model-registry-override-save", "model-registry-override-disable",
    "search-model-settings-save", "admin-models-probe-start", "admin-models-probe-result",
    "selected-model-response-probe-start", "selected-model-response-probe-result"] },
  limit: { label: "한도", actions: ["runtime-settings-save", "model-capacity-device-save", "model-capacity-route-quota-save", "model-capacity-model-limit-save", "model-capacity-device-retire", "model-capacity-routes-prune", "model-helper-save", "model-helper-mode",
    "model-helper-promote", "model-supervisor-toggle", "pipeline-control-capacity-policy"] },
  rank: { label: "순위", actions: ["ai-task-models-save", "ai-task-models-import", "ai-task-execution-save", "model-assignment-save"] },
  action: { label: "조치", actions: ["model-capacity-unknown-reviewed", "model-capacity-unknown-requeued", "model-capacity-unknown-reclaimed",
    "model-capacity-owner-gone", "model-provider-boundary-release", "model-replaced-provider-boundary-release",
    "model-replaced-path-boundary-release", "model-cli-executor-boundary-release", "model-cli-executor-removed-boundary-release",
    "model-cli-executor-indeterminate-boundary-release", "model-cli-executor-indeterminate-removed-boundary-release",
    "pipeline-control-capacity-mode", "pipeline-control-stage-drain", "pipeline-control-stage-contract", "pipeline-control-stage-complete",
    "pipeline-control-agent-scan-drain", "pipeline-control-agent-scan-contract", "pipeline-control-agent-scan-complete",
    "ops-runner-state", "ops-runner-control", "llm-assist-control"] },
} as const satisfies Record<string, { label: string; actions: readonly string[] }>);
export type LlmHistoryKind = keyof typeof LLM_HISTORY_KINDS;
export const LLM_HISTORY_KIND_IDS = Object.keys(LLM_HISTORY_KINDS) as LlmHistoryKind[];
export const LLM_HISTORY_ACTIONS: readonly string[] = LLM_HISTORY_KIND_IDS.flatMap(kind => LLM_HISTORY_KINDS[kind].actions);

export function llmHistoryKindOf(action: string): LlmHistoryKind | null {
  return LLM_HISTORY_KIND_IDS.find(kind => (LLM_HISTORY_KINDS[kind].actions as readonly string[]).includes(action)) ?? null;
}

export type LlmHistoryFilter = Readonly<{ kind: LlmHistoryKind | null; failedOnly: boolean; before: number | null }>;
type Params = Readonly<{ kind?: string | null; failed?: string | null; before?: string | null }>;

/** 주소(?kind·failed·before)를 읽는다. 모르는 갈래는 전체, id 는 serial(int4) 범위 안만 받는다(작업 로그와 같다). */
export function llmHistoryFilter(params: Params): LlmHistoryFilter {
  const kind = params.kind && Object.hasOwn(LLM_HISTORY_KINDS, params.kind) ? params.kind as LlmHistoryKind : null;
  const before = Number(params.before);
  return { kind, failedOnly: params.failed === "1", before: Number.isSafeInteger(before) && before > 0 && before <= 2_147_483_647 ? before : null };
}

/** 기록 화면 주소 — 변경 기록 표(#audit)로 바로 간다. 각 하위 화면의 「최근 3건」 아래 링크도 이것을 쓴다. */
export function llmHistoryHref(filter: Partial<LlmHistoryFilter> = {}, hash = "audit"): string {
  const search = new URLSearchParams();
  if (filter.kind) search.set("kind", filter.kind);
  if (filter.failedOnly) search.set("failed", "1");
  if (filter.before) search.set("before", String(filter.before));
  return `/admin/models/history${search.size ? `?${search}` : ""}${hash ? `#${hash}` : ""}`;
}

/** 각 하위 화면의 변경 기록은 최근 이만큼만 보이고 나머지는 기록 화면에서 본다(시안 「각 화면에는 최근 3건만」). */
export const RECENT_AUDIT_ROWS = 3;

// ── 재실행 패널 ─────────────────────────────────────────────────────────────────────────────────────

export type RetryCount = Readonly<{ key: string; label: string; count: number }>;
/** 「다시 대기열」을 누르면(미리보기) — 다시 넣을 행·할 일이 끝나 닫을 행·남을 행과 남는 까닭. 목록에 실린 행에서 센다. */
export type RetryPlanView = Readonly<{ requeue: number; close: number; left: number; reasons: RetryCount[] }>;
export type RetryItemPlan = Readonly<{ outcome: RequeueOutcome; reason: string; text: string }>;
export type RetryGroupView = Readonly<{
  routeId: string; label: string; count: number; supported: boolean;
  /** 아래 셋은 목록에 실린 행(오래된 100건)에서 센다 — sampled 가 count 보다 작으면 화면이 그렇게 말한다. */
  sampled: number; models: RetryCount[]; reasons: RetryCount[]; localEnded: number; oldPolicy: number; oldestAt: string | null;
  /** 미리보기를 못 읽었으면 null */
  plan: RetryPlanView | null;
}>;
export type RetryItemView = CapacityReviewItem & Readonly<{ plan: RetryItemPlan | null }>;
export type RetryView = Readonly<{
  readable: boolean; error: string | null; total: number; supportedTotal: number; truncated: boolean;
  groups: RetryGroupView[]; items: RetryItemView[];
}>;
/** 미리보기 한 행(model-capacity-requeue previewModelCapacityUnknowns 의 값 모양) */
export type RetryPreviewRow = Readonly<{ outcome: RequeueOutcome; reason: string }>;

const counted = (values: readonly string[], label: (value: string) => string): RetryCount[] =>
  [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())]
    .map(([key, count]) => ({ key, label: label(key), count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

/**
 * 장부 검토 목록(readModelCapacityReviewQueue) → 단계(route)별 묶음. 「다시 대기열」은 서버가 route 단위로만 하므로 묶음도 route 다.
 * 모델·까닭·근거는 묶음 안에서 센다. supported 는 서버의 지원 목록(canRequeueUnknownRoute)을 그대로 받는다.
 */
export function buildRetryView(queue: CapacityReviewQueue, supported: (routeId: string) => boolean,
  preview: ReadonlyMap<string, RetryPreviewRow> | null = null): RetryView {
  const fromItems = [...queue.items.reduce((map, item) => map.set(item.routeId, (map.get(item.routeId) ?? 0) + 1), new Map<string, number>())]
    .map(([routeId, count]) => ({ routeId, count }));
  const counts = queue.groups.length ? queue.groups : fromItems;
  const planOf = (item: CapacityReviewItem): RetryItemPlan | null => {
    const row = preview?.get(item.requestId);
    return row ? { outcome: row.outcome, reason: row.reason, text: requeueReasonText(row.reason) } : null;
  };
  const items: RetryItemView[] = queue.items.map(item => ({ ...item, plan: planOf(item) }));
  const groups = counts.map(({ routeId, count }): RetryGroupView => {
    const own = items.filter(item => item.routeId === routeId);
    const oldest = own.map(item => item.dispatchedAt ?? item.markedAt).filter((value): value is string => !!value).sort()[0] ?? null;
    const plans = own.map(item => item.plan).filter((plan): plan is RetryItemPlan => plan !== null);
    const plan: RetryPlanView | null = plans.length ? { requeue: plans.filter(row => row.outcome === "requeued").length,
      close: plans.filter(row => row.outcome === "done").length, left: plans.filter(row => row.outcome === "skipped").length,
      reasons: counted(plans.filter(row => row.outcome === "skipped").map(row => row.reason), requeueReasonText) } : null;
    return { routeId, label: routeTaskLabel(routeId), count, supported: supported(routeId), sampled: own.length,
      models: counted(own.map(item => item.model), model => model),
      reasons: counted(own.map(item => item.reason ?? "none"), code => code === "none" ? "사유 기록 없음" : llmReasonShort(code) ?? code),
      localEnded: own.filter(item => item.localEndRecorded).length, oldPolicy: own.filter(item => item.oldPolicy).length, oldestAt: oldest, plan };
  });
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  return { readable: !queue.error, error: queue.error, total, supportedTotal: groups.filter(group => group.supported).reduce((sum, group) => sum + group.count, 0),
    truncated: queue.truncated, groups, items };
}

// ── 최근 1시간 실패 ─────────────────────────────────────────────────────────────────────────────────

export type FailureRowView = Readonly<{ key: string; routeId: string; label: string; model: string; groupId: string; failed: number; succeeded: number; lastSuccessAt: string | null }>;

/** 장부 1시간 정산에서 실패가 있는 (단계·모델·장비) 줄 — 실패가 많은 것부터. 장부를 못 읽었으면 null(0건으로 보이지 않는다). */
export function recentFailures(observation: AdminModelsObservation): FailureRowView[] | null {
  if (observation.error || !observation.observedAt) return null;
  return observation.rows.filter(row => row.failed1h > 0)
    .map(row => ({ key: `${row.routeId}\u0000${row.provider}\u0000${row.model}\u0000${row.groupId}`, routeId: row.routeId, label: routeTaskLabel(row.routeId),
      model: row.model, groupId: row.groupId, failed: row.failed1h, succeeded: row.succeeded1h, lastSuccessAt: row.lastSuccessAt }))
    .sort((a, b) => b.failed - a.failed || a.label.localeCompare(b.label));
}

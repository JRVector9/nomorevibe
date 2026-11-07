import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import type { ModelCapacityDeviceState } from "@/lib/llm/capacity-devices";
import type { AiConnectionView, AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import type { AiTaskRuntimeView } from "@/lib/operations/admin-ai-tasks-repository";
import { buildAdminModelsObservation, type AdminModelMetrics, type AdminModelRequest } from "@/lib/operations/admin-models-observation";
import type { StationLlm, TaskLlm } from "@/lib/operations/conveyor-llm";
import type { BeltTone, Conveyor, Station } from "@/lib/operations/conveyor-model";
import type { LlmClassifierInput, LlmCliContractInput } from "@/lib/operations/llm-ops-view";

/** LLM 운영 개편 시험 자료 — 2026-11-07 16:20 KST 운영 관측을 닮게 만든 고정값(시안의 예시와 같은 모양). 운영 DB 를 읽지 않는다. */
export const LLM_NOW = "2026-11-07T07:20:00.000Z";
export const GPU = "11111111-1111-4111-8111-111111111111";
export const MLX = "22222222-2222-4222-8222-222222222222";
export const SUPA = "33333333-3333-4333-8333-333333333333";
export const OPENCODE = "44444444-4444-4444-8444-444444444444";
export const CLAUDE = "55555555-5555-4555-8555-555555555555";
export const M1 = "66666666-6666-4666-8666-666666666666";

const connection = (patch: Partial<AiConnectionView> & Pick<AiConnectionView, "id" | "label" | "kind" | "deviceId">): AiConnectionView => ({
  baseUrl: null, host: null, hasKey: false, cliTool: null, cliModels: [], models: null, modelsReadAt: null, modelsError: null, capacitySlots: 1,
  contextTokens: null, enabled: true, version: 3, note: null, updatedBy: "fixture", updatedAt: "2026-11-07T06:00:00.000Z", cliVersion: null, ...patch });
export const llmConnections: AiConnectionView[] = [
  connection({ id: GPU, label: "gpu3090-qwen", kind: "api", deviceId: "gpu3090-qwen", baseUrl: "http://100.77.43.63:8090/v1", host: "100.77.43.63:8090",
    models: [{ id: "qwen3.8-flash-next", maxModelLen: 131072 }], modelsReadAt: "2026-11-07T07:10:00.000Z", capacitySlots: 4 }),
  connection({ id: MLX, label: "m3-mlx (2)", kind: "api", deviceId: "m3-mlx", baseUrl: "http://100.92.77.66:8010/v1", host: "100.92.77.66:8010", hasKey: true,
    models: [{ id: "gpt-oss-120b", maxModelLen: null }, { id: "deepseek-v4.1-flash-1017", maxModelLen: null }, { id: "qwen3.6-35b-heretic", maxModelLen: null }],
    modelsReadAt: "2026-11-07T07:20:00.000Z", capacitySlots: 1 }),
  connection({ id: SUPA, label: "supa-direct", kind: "api", deviceId: "supa-direct", baseUrl: "http://100.78.219.124:8000/v1", host: "100.78.219.124:8000",
    models: [{ id: "supa", maxModelLen: null }], modelsReadAt: "2026-11-07T07:00:00.000Z", capacitySlots: 20 }),
  connection({ id: M1, label: "m1-qwen", kind: "api", deviceId: "m1-qwen", baseUrl: "http://m1.invalid:8080/v1", host: "m1.invalid:8080", models: null, modelsError: "unreachable", capacitySlots: 2 }),
  connection({ id: OPENCODE, label: "M3 OpenCode", kind: "cli", cliTool: "opencode", deviceId: "m3-opencode-host", baseUrl: "http://100.92.77.66:4096", host: "100.92.77.66:4096",
    hasKey: true, cliModels: ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-pro"], cliVersion: "2.2.6", capacitySlots: 2 }),
  connection({ id: CLAUDE, label: "Claude CLI", kind: "cli", cliTool: "claude", deviceId: "anthropic-cli", cliModels: ["sonnet"], cliVersion: "2.1.263 (Claude Code)", capacitySlots: 4 }),
];

const rank = (task: string, slot: number, order: number, connectionId: string, model: string, enabled = true): AiTaskRankRow =>
  ({ task, slot, rank: order, connectionId, model, options: {}, enabled });
export const llmRankRows: AiTaskRankRow[] = [
  rank("first-review", 1, 1, OPENCODE, "deepseek/deepseek-v4.1-flash"), rank("first-review", 1, 2, GPU, "qwen3.8-flash-next"),
  rank("second-review", 1, 1, SUPA, "supa"), rank("second-review", 2, 1, MLX, "gpt-oss-120b"),
  rank("crawl-tagline", 1, 1, MLX, "gpt-oss-120b"),
  rank("product-search-profile", 1, 1, MLX, "gpt-oss-120b"), rank("product-search-profile", 1, 2, MLX, "deepseek-v4.1-flash-1017"),
  rank("product-search-verify", 1, 1, SUPA, "supa"),
];

const route = (routeId: string, provider: string, model: string, groupId: string) => ({ routeId, provider, model, groupId, providerBudgetId: groupId });
export const llmRoutes = [
  route("crawl-agent-review", "opencode-cli", "deepseek/deepseek-v4.1-flash", "m3-opencode-host"),
  route("crawl-agent-review", "local-direct", "qwen3.8-flash-next", "gpu3090-qwen"),
  route("second-review", "abcllm", "supa", "supa-direct"),
  route("crawl-tagline", "abcllm", "gpt-oss-120b", "m3-mlx"),
  route("product-search-verify", "abcllm", "supa", "supa-direct"),
  route("product-intro-check", "claude-cli", "sonnet", "anthropic-cli"),
  route("crawl-publish-classify", "codex-cli", "gpt-5.6-terra", "openai-cli"),
];
const groups = ["m3-opencode-host", "gpu3090-qwen", "supa-direct", "m3-mlx", "anthropic-cli", "openai-cli"];
export const llmPolicy: ModelCapacityPolicy = { version: 1, groupLimits: Object.fromEntries(groups.map(group => [group, 2])),
  providerLimits: Object.fromEntries(groups.map(group => [group, 8])), maxWaiting: 50, queueTtlMs: 60_000, reservationTtlMs: 30_000, routes: llmRoutes };

const metric = (index: number, patch: Partial<AdminModelMetrics>): AdminModelMetrics => ({ ...llmRoutes[index], succeeded1h: 0, failed1h: 0, withdrawn1h: 0,
  unclassified1h: 0, waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, lastSuccessAt: null, ...patch });
export const llmMetrics: AdminModelMetrics[] = [
  metric(0, { succeeded1h: 84, failed1h: 2, dispatched: 1, lastSuccessAt: "2026-11-07T07:19:00.000Z" }),
  metric(1, { succeeded1h: 93, dispatched: 2, waiting: 4, indeterminate: 1, lastSuccessAt: "2026-11-07T07:19:30.000Z" }),
  metric(2, { succeeded1h: 105, dispatched: 1, waiting: 5, lastSuccessAt: "2026-11-07T07:18:00.000Z" }),
  metric(3, { succeeded1h: 100, dispatched: 0, lastSuccessAt: "2026-11-07T07:15:00.000Z" }),
  metric(6, { succeeded1h: 12, lastSuccessAt: "2026-11-07T07:05:00.000Z" }),
];
export const llmRequests: AdminModelRequest[] = [{ ...llmRoutes[1], requestId: "161d7780-5b1f-4ce8-be8d-baed927b28e8", state: "indeterminate",
  queuedAt: "2026-11-07T05:18:00.000Z", dispatchedAt: "2026-11-07T05:18:01.000Z", stateSince: "2026-11-07T05:20:00.000Z", reservedUntil: null,
  ownerInstanceId: "reviewer-m3-1", localEndRecorded: true }];

const device = (deviceId: string, limitSlots: number, patch: Partial<ModelCapacityDeviceState> = {}): ModelCapacityDeviceState => ({ deviceId, source: "table", limitSlots,
  secondaryCap: limitSlots, idleMs: 60_000, reserveSlots: 0, active: 0, secondaryActive: 0, secondaryBound: limitSlots, primaryBusy: false, lending: false,
  waiting: 0, waitingPrimary: 0, version: 3, updatedAt: "2026-11-06T00:00:00.000Z", helpers: [], ...patch });
export const llmDevices: ModelCapacityDeviceState[] = [
  device("gpu3090-qwen", 5, { waiting: 4 }), device("m3-mlx", 1), device("supa-direct", 2, { waiting: 5 }), device("m3-opencode-host", 1),
  device("anthropic-cli", 4), device("openai-cli", 2), device("m1-qwen", 2),
];

export function llmObservation() {
  return buildAdminModelsObservation({ observedAt: LLM_NOW, control: { mode: "open", epoch: 4, revision: 12, policy: llmPolicy,
    policyHash: modelCapacityPolicyHash(llmPolicy), updatedAt: "2026-11-07T07:15:00.000Z" }, metrics: llmMetrics, requests: llmRequests, devices: llmDevices });
}

export const llmRuntime: Record<string, AiTaskRuntimeView> = {
  "first-review": { from: "job", at: "2026-11-07T07:18:00.000Z", served: [{ rank: 1, count: 3 }], unusable: [{ rank: 1, code: "engine_slow", text: "이 틱의 호출이 느려 쉼", count: 1 }], degraded: null },
  // 오래된 관측(30분 넘음)은 까닭으로 쓰지 않는다
  "crawl-tagline": { from: "job", at: "2026-11-07T05:00:00.000Z", served: [], unusable: [{ rank: 1, code: "no_direct_contract", text: "계약 없음", count: 9 }], degraded: null },
};
export const llmJobs = [{ name: "product-search-verify", paused: true }, { name: "product-intro-check", paused: true }, { name: "crawl-agent-review", paused: false }];
export const llmCliContracts: LlmCliContractInput[] = [
  { provider: "grok-cli", routeId: "grok-session-check", model: "grok-4.7", cliVersion: "0.9.1" },
  { provider: "opencode-cli", routeId: "crawl-agent-review", model: "deepseek/deepseek-v4.1-flash", cliVersion: "2.2.6" },
];
export const llmClassifier: LlmClassifierInput = { observedAt: "2026-11-07T07:19:50.000Z", fresh: true, ready: true,
  models: [{ rank: 1, model: "gpt-5.6-terra", provider: "codex-cli" }, { rank: 2, model: "sonnet", provider: "claude-cli" }],
  versions: [{ provider: "codex-cli", cliVersion: "codex-cli 0.98.0" }] };

// ── 흐름 관측(대시보드 단계 띠) ───────────────────────────────────────────────────────────────────────
const task = (taskId: string, label: string, model: string, where: string): TaskLlm => ({ task: taskId, label, live: true, state: "ok", slots: [], used: [], usedWhy: null,
  head: { model, where, rank: 1, source: "used", count: 10 }, note: null });
export const stationLlm = (taskId: string, label: string, model: string, where: string, more = 0): StationLlm => {
  const head = task(taskId, label, model, where);
  return { kind: "llm", tasks: [head], head, more, flag: null, stopped: [], liveCount: 1, sameModel: false, warnings: [] };
};
const station = (key: Station["key"], tone: BeltTone, status: string, llm: StationLlm | null, reason: string | null = null): Station => ({ key, phase: "review", label: key, what: "",
  waiting: 0, oldestMinutes: null, done5m: null, doneHour: null, done24h: null, unit: "건", spark: null, tone, status, reason, holds: [], facts: [], links: [], llm });
export function llmConveyor(patch: Partial<Record<Station["key"], [BeltTone, string, string | null]>> = {}): Conveyor {
  const tone = (key: Station["key"], fallback: [BeltTone, string, string | null]) => patch[key] ?? fallback;
  const make = (key: Station["key"], llm: StationLlm | null, fallback: [BeltTone, string, string | null]) => { const [t, s, r] = tone(key, fallback); return station(key, t, s, llm, r); };
  return {
    measuredAt: "2026-11-07T07:19:45.000Z", hours: null,
    stations: [
      make("first", stationLlm("first-review", "1차 AI 검수", "deepseek-v4.1-flash", "M3 OpenCode", 1), ["flow", "흐름", null]),
      make("second", stationLlm("second-review", "2차 AI 검수", "supa", "supa-direct"), ["flow", "흐름", null]),
      make("profile", stationLlm("crawl-tagline", "수집 소개 짓기", "gpt-oss-120b", "m3-mlx"), ["idle", "일감 없음", null]),
      make("publish", stationLlm("publish-classify", "카테고리 분류", "gpt-5.6-terra", "Codex CLI"), ["flow", "흐름", null]),
      make("keywords", stationLlm("product-search-profile", "검색 키워드 짓기", "gpt-oss-120b", "m3-mlx"), ["slow", "쌓임", "지금 속도로 30분 안에 다 못 비울 만큼 쌓였습니다"]),
    ],
    human: { waiting: 3, direct: 1, agreed: 2, awaitingSecond: 0, awaitingAi: 0, decided24h: 4, oldestDays: 1, in24h: 3, tone: "idle", status: "일감 없음", reason: null,
      llm: stationLlm("human-review", "사람 몫 위임 검수", "deepseek-v4.1-flash", "M3 OpenCode") },
    held: 0, rejected: 0, published: 0, publishedHour: 0, bottleneck: null, headline: { tone: "flow", title: "", detail: "" }, funnel: [], holdsByReason: [], sinkLlm: null,
    supportLlm: stationLlm("product-tagline-ko", "한국어 소개 번역", "gpt-oss-120b", "m3-mlx", 2),
  };
}

import { AI_CLI_TOOL_LABELS, AI_CLI_TOOL_PROVIDERS, AI_TASKS, aiCliToolOfProvider, aiTask, aiTaskSlotLabel, type AiTaskDef } from "@/lib/llm/ai-tasks";
import { aiConnectionLabel, aiModelsErrorText, type AiConnectionView, type AiTaskRankRow } from "./admin-ai-tasks";
import type { AiTaskExecutionAdminView } from "./admin-ai-task-execution";
import type { AiTaskRuntimeView } from "./admin-ai-tasks-repository";
import type { AdminModelMetrics, AdminModelsObservation } from "./admin-models-observation";
import { elapsedModelTime, modelStageId, modelStageLabel } from "./admin-models-view";
import type { StationLlm } from "./conveyor-llm";
import type { BeltTone, Conveyor } from "./conveyor-model";
import { FLOW_MODEL_STAGES, type FlowModelStage } from "./flow-model-catalog";

/**
 * 「LLM 운영」 개편(2026-11-07 승인 시안 PR 1·2)의 화면 모형 — DB 를 읽지 않는 순수 함수다.
 * 대시보드(/admin/models)와 LLM 운영(/admin/models/llm)이 기존 읽기(장부 관측·흐름 관측·연결·순위·실행 쪽 순위 사정·잡 상태)를 받아
 * 판단 띠·KPI·장비 점유·단계 띠·먼저 할 일, 연결(서버)·CLI 도구 행을 만든다. 쓰기는 하지 않는다 — 고치는 곳은 늘 기존 화면·기존 저장 함수다.
 *
 * 읽지 못한 값은 0 으로 꾸미지 않는다: 숫자 자리는 「확인 불가」, 상태는 unknown 이다.
 */

// ── 상태(색 + 모양 + 글자) ─────────────────────────────────────────────────────────────────────────────

export type LlmOpsLevel = "ok" | "warn" | "bad" | "idle" | "unknown";
/** 색만으로 뜻을 전하지 않는다 — 화면은 늘 모양과 글자를 같이 쓴다. label 은 범례 글자다. */
export const LLM_OPS_LEVELS: Readonly<Record<LlmOpsLevel, { shape: string; label: string }>> = Object.freeze({
  ok: { shape: "●", label: "정상" },
  warn: { shape: "▲", label: "느림·주의" },
  bad: { shape: "■", label: "멈춤·실패" },
  idle: { shape: "‖", label: "의도적 중지·쉼" },
  unknown: { shape: "?", label: "확인 불가" },
});
const LEVEL_RANK: Readonly<Record<LlmOpsLevel, number>> = { ok: 0, idle: 1, unknown: 2, warn: 3, bad: 4 };
export const worseLevel = (a: LlmOpsLevel, b: LlmOpsLevel): LlmOpsLevel => LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a;
export const UNREADABLE = "확인 불가";
const fmt = (value: number) => value.toLocaleString("ko-KR");

// ── 까닭 코드 → 짧은 말 ──────────────────────────────────────────────────────────────────────────────

/**
 * 실행 쪽 순위 사정(ai_task.ranks unusable)·모델 목록 오류·미확정 사유 코드 → 상태 옆 한 줄. 긴 설명은 기존 문장(textRankUnusableText 등)을 그대로 쓴다.
 * 모르는 코드는 코드 그대로 보인다(지어내지 않는다).
 */
const REASON_SHORT: Readonly<Record<string, string>> = Object.freeze({
  // 계약
  no_direct_contract: "계약 없음", cli_contract_missing: "계약 없음", cli_engine_contract_not_stored: "계약 없음",
  provider_contract_unavailable: "계약 닫힘", cli_contract_unavailable: "계약 확인 실패", gateway_auth: "계약 인증 방식 오류",
  cli_engine_source_invalid: "계약 불일치", cli_version_mismatch: "CLI 버전 다름",
  // 키
  connection_key_missing: "키 없음", stored_key_unreadable: "키 열 수 없음", key_unreadable: "키 열 수 없음", engine_no_key: "키 거절",
  cli_engine_auth_invalid: "인증 정보 오류",
  // 연결·순위
  connection_disabled: "연결 꺼짐", rank_disabled: "순위 꺼짐", connection_not_api: "연결 종류 다름", cli_tool_unsupported: "연결 종류 다름",
  // 서버
  engine_network: "서버 응답 없음", unreachable: "서버 응답 없음", engine_model_unavailable: "서버에 모델 없음",
  engine_tokenizer_unavailable: "tokenizer 확인 실패", endpoint_invalid: "주소 오류", cli_engine_endpoint_invalid: "주소 오류",
  cli_model_invalid: "모델 이름 오류",
  // 호출 결과
  engine_slow: "시간 초과", client_timeout: "시간 초과", timeout: "시간 초과",
  invalid_output: "출력 형식", output_invalid: "출력 형식", parse_failed: "출력 형식",
  engine_failed: "호출 실패", engine_unknown: "결과 모름", transport_unknown: "결과 모름", local_abort: "중단됨", process_exit: "프로세스 종료",
  commit_unknown: "정산 결과 모름",
  // 용량·정책
  unmapped: "정책 경로 없음", device_unconfigured: "장비 행 없음", capacity: "칸 가득", queue_full: "대기열 가득",
  blocked_unconfirmed: "미확인 점유로 가득", helper_ineligible: "도우미 경로 닫힘", model_paused: "쉬는 중",
  // 작업
  no_task_models: "순위 없음", all_ranks_unusable: "쓸 수 있는 순위 없음", task_models_unreadable: "순위 못 읽음",
});
export function llmReasonShort(code: string | null | undefined): string | null {
  if (!code) return null;
  const known = REASON_SHORT[code];
  if (known) return known;
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return http[1] === "401" || http[1] === "403" ? `키 거절(HTTP ${http[1]})` : http[1].startsWith("5") ? `서버 오류(HTTP ${http[1]})` : `HTTP ${http[1]}`;
  return code;
}
/** 순위를 아예 쓸 수 없는 까닭(설정·계약·키·서버) — 이 틱만 쉬는 까닭(포화·느림·실패)과 가른다. */
const HARD_REASONS = new Set(["connection_key_missing", "stored_key_unreadable", "no_direct_contract", "cli_contract_missing", "cli_version_mismatch",
  "cli_contract_unavailable", "gateway_auth", "unmapped", "device_unconfigured", "provider_contract_unavailable", "engine_no_key", "engine_model_unavailable",
  "engine_network", "cli_tool_unsupported", "cli_model_invalid", "cli_engine_endpoint_invalid", "cli_engine_source_invalid", "cli_engine_auth_invalid",
  "cli_engine_contract_not_stored", "connection_not_api", "engine_tokenizer_unavailable"]);
export const llmReasonLevel = (code: string): LlmOpsLevel => HARD_REASONS.has(code) ? "bad" : code === "rank_disabled" || code === "connection_disabled" ? "idle" : "warn";

// ── 공통 ────────────────────────────────────────────────────────────────────────────────────────────

export type JobPause = Readonly<{ name: string; paused: boolean }>;
export const observationReadable = (observation: AdminModelsObservation) => !observation.error && !!observation.observedAt;
const sum = (rows: readonly AdminModelMetrics[], key: "dispatched" | "reserved" | "waiting" | "indeterminate" | "succeeded1h" | "failed1h" | "unclassified1h") =>
  rows.reduce((total, row) => total + row[key], 0);
/** 장부 route → AI 작업(작업 목록의 routeId, 없으면 단계 id). */
export function taskOfRoute(routeId: string): AiTaskDef | null {
  return AI_TASKS.find(task => task.routeId === routeId) ?? aiTask(modelStageId(routeId));
}
export const routeTaskLabel = (routeId: string) => {
  const task = taskOfRoute(routeId);
  if (task) return task.label;
  const stage = modelStageLabel(routeId);
  return stage === "다른 모델 단계" ? routeId : stage;
};
const pausedTaskIds = (jobs: readonly JobPause[] | null): Set<string> | null => {
  if (!jobs) return null;
  const paused = new Set(jobs.filter(job => job.paused).map(job => job.name));
  return new Set(AI_TASKS.filter(task => task.jobs.length > 0 && task.jobs.every(job => paused.has(job))).map(task => task.id));
};
/** 잘 알려진 CLI 장비 이름 → 그 도구(정책 경로가 없을 때도 장비 행만으로 CLI 행을 세운다). */
const CLI_VENDOR_DEVICES: Readonly<Record<string, string>> = Object.freeze({ "anthropic-cli": "claude-cli", "openai-cli": "codex-cli", "xai-cli": "grok-cli" });
const isCliProvider = (provider: string) => /-cli$/.test(provider);
const cliProviderLabel = (provider: string) => {
  const tool = aiCliToolOfProvider(provider);
  return tool ? AI_CLI_TOOL_LABELS[tool] : provider;
};

/** 장비 id → 사람이 읽는 이름(그 장비를 쓰는 연결 이름, 없으면 CLI 도구 이름). */
export function deviceLabels(connections: readonly AiConnectionView[] | null, observation: AdminModelsObservation): Map<string, string> {
  const names = new Map<string, string[]>();
  const add = (deviceId: string, name: string) => { const list = names.get(deviceId) ?? []; if (!list.includes(name)) list.push(name); names.set(deviceId, list); };
  for (const connection of [...connections ?? []].sort((a, b) => Number(b.enabled) - Number(a.enabled))) add(connection.deviceId, aiConnectionLabel(connection));
  for (const route of observation.configuredRoutes ?? []) if (isCliProvider(route.provider) && !names.has(route.groupId)) add(route.groupId, cliProviderLabel(route.provider));
  return new Map([...names].map(([deviceId, list]) => [deviceId, list.join(" · ")]));
}

// ── 대시보드 ────────────────────────────────────────────────────────────────────────────────────────

export type DashboardInput = Readonly<{
  now: string;
  observation: AdminModelsObservation;
  /** 흐름 관측(readConveyor). null = 읽지 못함 */
  conveyor: Conveyor | null;
  /** 잡 상태(멈춤 여부). null = 읽지 못함 */
  jobs: readonly JobPause[] | null;
  /** AI 연결(장비 이름표·한도 불일치·목록 못 읽음). null = 읽지 못함 */
  connections: readonly AiConnectionView[] | null;
}>;
export type DashboardKpi = Readonly<{ id: "running" | "waiting" | "settled" | "retry"; label: string; value: string; foot: string; level: LlmOpsLevel }>;
export type DashboardDevice = Readonly<{ deviceId: string; label: string; held: number; limit: number | null; percent: number | null; waiting: number | null;
  lending: boolean; level: LlmOpsLevel; note: string | null }>;
export type DashboardStage = Readonly<{ id: string; label: string; level: LlmOpsLevel; status: string; model: string | null; detail: string | null; href: string }>;
export type DashboardTodo = Readonly<{ id: string; level: LlmOpsLevel; title: string; detail: string; href: string; action: string }>;
export type DashboardView = Readonly<{
  readable: boolean; observedAt: string | null; flowAt: string | null;
  banner: { level: LlmOpsLevel; title: string; lines: string[] };
  admission: { mode: AdminModelsObservation["mode"]; text: string; level: LlmOpsLevel; detail: string };
  kpis: DashboardKpi[]; devices: DashboardDevice[]; devicesNote: string | null;
  stages: DashboardStage[]; todos: DashboardTodo[]; moreTodos: number;
}>;

const LLM_STAGES = FLOW_MODEL_STAGES.filter(stage => stage.llm);
function stageLlmOf(conveyor: Conveyor, stage: FlowModelStage): StationLlm | null {
  if (stage.id === "human") return conveyor.human?.llm ?? null;
  if (stage.id === "support") return conveyor.supportLlm ?? null;
  return conveyor.stations.find(station => station.key === stage.id)?.llm ?? null;
}
function stageStationOf(conveyor: Conveyor, stage: FlowModelStage): { tone: BeltTone; status: string; reason: string | null } | null {
  if (stage.id === "human") return conveyor.human ? { tone: conveyor.human.tone, status: conveyor.human.status, reason: conveyor.human.reason } : null;
  if (stage.id === "support") return null;
  const station = conveyor.stations.find(row => row.key === stage.id);
  return station ? { tone: station.tone, status: station.status, reason: station.reason } : null;
}
function modelText(llm: StationLlm | null): string | null {
  if (!llm || llm.kind === "unknown") return null;
  if (llm.kind === "none") return llm.short;
  const head = llm.head.head;
  if (!head) return `${llm.head.label} · 모델 없음`;
  return `${head.model}${head.where ? ` · ${head.where}` : ""}${llm.more ? ` 외 ${llm.more}` : ""}`;
}
const TONE_LEVEL: Readonly<Record<BeltTone, LlmOpsLevel>> = { flow: "ok", idle: "ok", slow: "warn", jam: "bad", stop: "idle", unknown: "unknown" };
const TONE_TEXT: Readonly<Partial<Record<BeltTone, string>>> = { flow: "흐름", idle: "일감 없음", stop: "의도적 중지", unknown: UNREADABLE };

function buildStage(stage: FlowModelStage, input: DashboardInput, paused: Set<string> | null): DashboardStage {
  const tasks = stage.taskIds.map(aiTask).filter((task): task is AiTaskDef => !!task);
  const withJobs = tasks.filter(task => task.jobs.length > 0);
  const pausedTasks = paused ? withJobs.filter(task => paused.has(task.id)) : [];
  const pausedText = pausedTasks.map(task => task.label).join(" · ");
  const llm = input.conveyor ? stageLlmOf(input.conveyor, stage) : null;
  const base = { id: stage.id, label: stage.label, model: modelText(llm), href: stage.editHref };
  if (withJobs.length > 0 && pausedTasks.length === withJobs.length)
    return { ...base, level: "idle", status: "의도적 중지", detail: `잡 일시중지: ${pausedText}` };
  let level: LlmOpsLevel, status: string, detail: string | null;
  if (!input.conveyor) { level = "unknown"; status = UNREADABLE; detail = "흐름 관측을 읽지 못했습니다"; }
  else {
    const station = stageStationOf(input.conveyor, stage);
    if (station) {
      level = TONE_LEVEL[station.tone]; status = TONE_TEXT[station.tone] ?? station.status; detail = station.reason;
      if (station.tone === "jam" || station.tone === "slow") status = station.status;
    } else if (!llm || llm.kind === "unknown") { level = "unknown"; status = UNREADABLE; detail = "모델 관측을 읽지 못했습니다"; }
    else if (llm.kind === "llm" && llm.liveCount > 0 && llm.stopped.length >= llm.liveCount) { level = "bad"; status = "모델 없음 — 멈춤"; detail = llm.stopped.join(" · "); }
    else if (llm.kind === "llm" && llm.stopped.length) { level = "warn"; status = "일부 멈춤"; detail = llm.stopped.join(" · "); }
    else { level = "ok"; status = "정상"; detail = llm.kind === "llm" ? llm.flag?.text ?? null : null; }
  }
  if (observationReadable(input.observation)) {
    const ids = new Set(tasks.map(task => task.id));
    const rows = input.observation.rows.filter(row => { const task = taskOfRoute(row.routeId); return !!task && ids.has(task.id); });
    const failed = sum(rows, "failed1h"), succeeded = sum(rows, "succeeded1h");
    if (failed > 0 && succeeded === 0) {
      level = worseLevel(level, "bad");
      if (status === "흐름" || status === "일감 없음" || status === "정상" || status === UNREADABLE) status = "실패";
      detail = [detail, `최근 1시간 실패 ${fmt(failed)}건 · 성공 0건`].filter(Boolean).join(" · ");
    } else if (failed > 0) detail = [detail, `최근 1시간 실패 ${fmt(failed)}건`].filter(Boolean).join(" · ");
  }
  if (pausedTasks.length) detail = [`일부 중지: ${pausedText}`, detail].filter(Boolean).join(" · ");
  return { ...base, level, status, detail };
}

export function buildDashboardView(input: DashboardInput): DashboardView {
  const { observation } = input;
  const readable = observationReadable(observation);
  const rows = readable ? observation.rows : [];
  const paused = pausedTaskIds(input.jobs);
  const labels = deviceLabels(input.connections, observation);

  // 접수
  const mode = readable ? observation.mode : null;
  const admission = { mode, text: mode ? mode.toUpperCase() : UNREADABLE,
    level: (mode === "open" ? "ok" : mode === "draining" ? "warn" : mode === "disabled" ? "bad" : "unknown") as LlmOpsLevel,
    detail: mode === "open" ? "새 모델 호출을 받는 중" : mode === "draining" ? "새 호출을 받지 않음 · 진행 중 호출은 끝까지" : mode === "disabled" ? "용량 제어 꺼짐" : "접수 상태를 읽지 못했습니다" };

  // KPI
  const dispatched = sum(rows, "dispatched"), reserved = sum(rows, "reserved"), waiting = sum(rows, "waiting"), indeterminate = sum(rows, "indeterminate");
  const succeeded = sum(rows, "succeeded1h"), failed = sum(rows, "failed1h"), unclassified = sum(rows, "unclassified1h");
  const configuredGroups = new Set((observation.configuredRoutes ?? []).map(route => route.groupId));
  const groups = readable ? observation.groups.filter(group => group.source !== null || configuredGroups.has(group.groupId) || group.held > 0) : [];
  const known = groups.filter(group => group.limit !== null);
  const totalSlots = known.length ? known.reduce((total, group) => total + group.limit!, 0) : null;
  const missingLimits = groups.length - known.length;
  const unreadableKpi = (id: DashboardKpi["id"], label: string): DashboardKpi => ({ id, label, value: UNREADABLE, foot: "운영 DB 실측을 읽지 못했습니다 — 0으로 보지 않습니다", level: "unknown" });
  const kpis: DashboardKpi[] = readable ? [
    { id: "running", label: "실행 중 / 전체 칸", value: `${fmt(dispatched)} / ${totalSlots === null ? UNREADABLE : fmt(totalSlots)}`,
      foot: `예약 ${fmt(reserved)} 포함 점유 ${fmt(dispatched + reserved)}${missingLimits ? ` · 한도 확인 불가 장비 ${missingLimits}대` : ""}`,
      level: totalSlots !== null && dispatched + reserved >= totalSlots && totalSlots > 0 ? "warn" : totalSlots === null ? "unknown" : "ok" },
    { id: "waiting", label: "대기", value: fmt(waiting), foot: "빈 칸을 기다리는 호출(현재 정책 세대)", level: waiting > 0 ? "warn" : "ok" },
    { id: "settled", label: "최근 1시간 정산", value: fmt(succeeded + failed + unclassified),
      foot: `성공 ${fmt(succeeded)} · 실패 ${fmt(failed)}${unclassified ? ` · 판정 없음 ${fmt(unclassified)}` : ""}`,
      level: failed > 0 && succeeded === 0 ? "bad" : failed > 0 ? "warn" : "ok" },
    { id: "retry", label: "재실행 대기", value: fmt(indeterminate), foot: `결과 미확정 ${fmt(indeterminate)}건 · 칸을 차지하지 않음`, level: indeterminate > 0 ? "warn" : "ok" },
  ] : [unreadableKpi("running", "실행 중 / 전체 칸"), unreadableKpi("waiting", "대기"), unreadableKpi("settled", "최근 1시간 정산"), unreadableKpi("retry", "재실행 대기")];

  // 장비 점유
  const devices: DashboardDevice[] = groups.map(group => {
    const state = observation.devices.find(device => device.deviceId === group.groupId);
    const percent = group.limit ? Math.min(100, Math.round(group.held / group.limit * 100)) : null;
    const level: LlmOpsLevel = group.limit === null ? "unknown" : group.held >= group.limit ? "warn" : "ok";
    const note = [group.limit === null ? "한도 확인 불가" : null, group.source === "policy_fallback" ? "장비 행 없음 · 정책 대체 한도" : null,
      group.lending ? "빌려 쓰는 중" : null, state && state.waiting > 0 ? `대기 ${fmt(state.waiting)}` : null].filter(Boolean).join(" · ") || null;
    return { deviceId: group.groupId, label: labels.get(group.groupId) ?? group.groupId, held: group.held, limit: group.limit, percent,
      waiting: state ? state.waiting : null, lending: group.lending, level, note };
  });
  const devicesNote = !readable ? "장비 점유를 읽지 못했습니다." : !observation.devicesRead ? "장비 행을 읽지 못해 정책 대체 한도만 보입니다." : null;

  // 단계 띠
  const stages = LLM_STAGES.map(stage => buildStage(stage, input, paused));

  // 판단 띠
  type Issue = { level: LlmOpsLevel; text: string };
  const issues: Issue[] = [];
  if (!readable) issues.push({ level: "unknown", text: "LLM 장부(운영 DB)를 읽지 못했습니다. 숫자를 0으로 보지 마세요." });
  if (mode === "draining") issues.push({ level: "warn", text: "접수 DRAIN — 새 모델 호출을 받지 않습니다." });
  if (mode === "disabled") issues.push({ level: "bad", text: "용량 제어가 꺼져 있습니다(disabled)." });
  const badStages = stages.filter(stage => stage.level === "bad"), warnStages = stages.filter(stage => stage.level === "warn");
  if (badStages.length) issues.push({ level: "bad", text: `${badStages.map(stage => stage.label).join(" · ")} 단계가 멈췄거나 실패만 하고 있습니다.` });
  if (indeterminate > 0) issues.push({ level: "warn", text: `결과 미확정 ${fmt(indeterminate)}건이 재실행을 기다립니다.` });
  const failureOnly = rows.filter(row => row.failed1h > 0 && row.succeeded1h === 0);
  if (failed > 0) issues.push({ level: "warn", text: `최근 1시간 실패 ${fmt(failed)}건(성공 ${fmt(succeeded)}건)${failureOnly.length ? ` — 실패만 있는 모델 ${failureOnly.length}개` : ""}.` });
  if (warnStages.length) issues.push({ level: "warn", text: `${warnStages.map(stage => stage.label).join(" · ")} 단계를 확인하세요.` });
  if (!input.conveyor) issues.push({ level: "unknown", text: "단계 흐름을 읽지 못했습니다." });
  const pausedStages = stages.filter(stage => stage.level === "idle" || stage.detail?.startsWith("일부 중지"));
  const pausedLabels = paused ? AI_TASKS.filter(task => paused.has(task.id) && LLM_STAGES.some(stage => stage.taskIds.includes(task.id))).map(task => task.label) : [];
  const pausedLine = pausedLabels.length ? `의도적 중지(잡 일시중지): ${pausedLabels.join(" · ")}` : null;
  const ranked = [...issues].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  const level = ranked.reduce<LlmOpsLevel>((worst, issue) => worseLevel(worst, issue.level), "ok");
  const title = ranked[0]?.text ?? (pausedStages.length ? "정상 — 의도적으로 멈춘 작업 외에는 문제가 없습니다." : "모든 LLM 단계가 정상입니다.");
  const lines = [...ranked.slice(1).map(issue => issue.text), ...(pausedLine ? [pausedLine] : [])];

  // 먼저 할 일
  const todos: DashboardTodo[] = [];
  if (mode === "draining") todos.push({ id: "drain", level: "warn", title: "접수가 DRAIN 상태입니다", detail: "새 모델 호출을 받지 않습니다. 작업이 끝났으면 위 접수 칸에서 OPEN 으로 되돌리세요.",
    href: "#admission", action: "접수 칸으로" });
  for (const stage of badStages) todos.push({ id: `stage-${stage.id}`, level: "bad", title: `${stage.label} ${stage.status}`, detail: stage.detail ?? "단계 설정과 실행 오류를 확인하세요.",
    href: stage.href, action: "작업 배정에서 확인" });
  if (indeterminate > 0) {
    const oldest = observation.requests.filter(request => request.state === "indeterminate").sort((a, b) => Date.parse(a.stateSince) - Date.parse(b.stateSince))[0];
    todos.push({ id: "indeterminate", level: "warn", title: `미확정 ${fmt(indeterminate)}건 정리`,
      detail: oldest ? `가장 오래된 것: ${routeTaskLabel(oldest.routeId)} · ${oldest.model} · ${elapsedModelTime(oldest.stateSince, observation.observedAt)} 전${oldest.localEndRecorded ? " · 로컬 종료 기록 있음" : ""}`
        : "근거를 보고 다시 대기열에 넣거나 닫습니다.",
      href: "/admin/models?advanced=1#review", action: "다시 대기열·닫기" });
  }
  for (const row of failureOnly.slice(0, 2)) todos.push({ id: `fail-${row.routeId}-${row.model}-${row.groupId}`, level: "bad",
    title: `${routeTaskLabel(row.routeId)} · ${row.model} 실패 ${fmt(row.failed1h)}건`, detail: `최근 1시간 성공 0건(장비 ${labels.get(row.groupId) ?? row.groupId}) — 연결 상태와 까닭을 확인하세요.`,
    href: "/admin/models/llm", action: "LLM 운영에서 보기" });
  if (readable && observation.devicesRead) for (const connection of input.connections ?? []) {
    if (!connection.enabled) continue;
    const state = observation.devices.find(device => device.deviceId === connection.deviceId);
    if (state?.source === "table" && state.limitSlots !== connection.capacitySlots)
      todos.push({ id: `limit-${connection.id}`, level: "warn", title: `${aiConnectionLabel(connection)} 한도 확인`,
        detail: `연결 폼의 칸 수 ${fmt(connection.capacitySlots)}, 장비 행 ${fmt(state.limitSlots)}(으)로 적용 중 — 실제로 쓰는 값은 장비 행입니다.`,
        href: `/admin/models/llm?edit=${connection.id}#conn-${connection.id}`, action: "LLM 운영에서 맞추기" });
  }
  for (const connection of input.connections ?? []) {
    if (!connection.enabled || connection.kind !== "api" || (connection.models && connection.models.length)) continue;
    todos.push({ id: `models-${connection.id}`, level: "warn", title: `${aiConnectionLabel(connection)} 모델 목록 못 읽음`,
      detail: llmReasonShort(connection.modelsError) ?? (connection.models === null ? "아직 읽지 않았습니다" : "모델 0개"),
      href: `/admin/models/llm?edit=${connection.id}#conn-${connection.id}`, action: "LLM 운영에서 다시 읽기" });
  }
  if (paused) for (const task of AI_TASKS) {
    if (!paused.has(task.id) || !LLM_STAGES.some(stage => stage.taskIds.includes(task.id))) continue;
    todos.push({ id: `paused-${task.id}`, level: "idle", title: `${task.label} 잡 일시중지`, detail: "의도적으로 멈춘 것인지 확인하세요. 다시 켜기는 작업 상태 화면에서 합니다.",
      href: `/admin/status?tab=jobs&job=${encodeURIComponent(task.jobs[0])}`, action: "잡 상태 보기" });
  }
  const sorted = todos.map((todo, index) => ({ todo, index })).sort((a, b) => LEVEL_RANK[b.todo.level] - LEVEL_RANK[a.todo.level] || a.index - b.index).map(entry => entry.todo);

  return { readable, observedAt: observation.observedAt, flowAt: input.conveyor?.measuredAt ?? null,
    banner: { level, title, lines }, admission, kpis, devices, devicesNote, stages, todos: sorted.slice(0, 3), moreTodos: Math.max(0, sorted.length - 3) };
}

// ── LLM 운영 ────────────────────────────────────────────────────────────────────────────────────────

/** CLI 계약 행(cli:<provider>:<route>) — 키·명령 없이 이름·버전만. */
export type LlmCliContractInput = Readonly<{ provider: string; routeId: string; model: string; cliVersion: string | null }>;
/** connect 에이전트가 남긴 분류(카테고리) 설정 관측 — 우선·예비 모델과 그 도구, 에이전트가 확인한 CLI 버전. */
export type LlmClassifierInput = Readonly<{ observedAt: string; fresh: boolean; ready: boolean | null;
  models: readonly Readonly<{ rank: number; model: string; provider: string | null }>[];
  versions: readonly Readonly<{ provider: string; cliVersion: string }>[] }>;
const CLASSIFIER_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
/** CLI 버전 글자(계약·에이전트 관측) — 제어 문자 없이 80자까지 */
export const CLI_VERSION_PATTERN = /^[^\p{Cc}]{1,80}$/u;
export const CLASSIFIER_FRESH_MS = 5 * 60_000;
/** connect 에이전트 관측 값 → 우선·예비 모델과 그 CLI 도구, 분류를 받는가, 에이전트가 확인한 CLI 버전. 모양이 틀린 칸은 버린다(키 등 다른 칸은 읽지 않는다). */
export function parseClassifierObservation(observedAt: string, value: unknown, now = Date.now()): LlmClassifierInput | null {
  if (!value || typeof value !== "object" || !Number.isFinite(Date.parse(observedAt))) return null;
  const record = value as Record<string, unknown>;
  const config = record.config && typeof record.config === "object" ? record.config as Record<string, unknown> : {};
  const options = Array.isArray(record.modelOptions) ? record.modelOptions as unknown[] : [];
  const providerOf = (model: string) => {
    const option = options.find(row => !!row && typeof row === "object" && (row as Record<string, unknown>).model === model) as Record<string, unknown> | undefined;
    return typeof option?.provider === "string" && /^[a-z0-9-]{1,40}$/.test(option.provider) ? option.provider : null;
  };
  const models = [config.primary, config.fallback].flatMap((candidate, index) => {
    const model = candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>).model : null;
    return typeof model === "string" && CLASSIFIER_MODEL.test(model) ? [{ rank: index + 1, model, provider: providerOf(model) }] : [];
  });
  const contracts = Array.isArray(record.classificationContracts) ? record.classificationContracts as unknown[] : [];
  const versions = contracts.flatMap(row => {
    if (!row || typeof row !== "object") return [];
    const { provider, cliVersion } = row as Record<string, unknown>;
    return typeof provider === "string" && /^[a-z0-9-]{1,40}-cli$/.test(provider) && typeof cliVersion === "string" && CLI_VERSION_PATTERN.test(cliVersion) ? [{ provider, cliVersion }] : [];
  });
  const age = now - Date.parse(observedAt);
  return { observedAt, fresh: age >= -60_000 && age <= CLASSIFIER_FRESH_MS, ready: typeof record.classifyReady === "boolean" ? record.classifyReady : null, models, versions };
}
export type LlmOpsInput = Readonly<{
  now: string;
  observation: AdminModelsObservation;
  connections: readonly AiConnectionView[] | null;
  rows: readonly AiTaskRankRow[] | null;
  executions: readonly Pick<AiTaskExecutionAdminView, "task" | "slot" | "mode" | "members">[] | null;
  runtime: Readonly<Record<string, AiTaskRuntimeView>> | null;
  jobs: readonly JobPause[] | null;
  cliContracts: readonly LlmCliContractInput[] | null;
  classifier: LlmClassifierInput | null;
}>;
export type LlmTaskChip = Readonly<{ key: string; task: string; label: string; rank: number | null; slot: number; model: string; enabled: boolean;
  source: "rank" | "pool" | "policy" | "classifier"; paused: boolean; href: string }>;
export type LlmCapacity = Readonly<{ deviceId: string; limit: number | null; held: number | null; waiting: number | null; source: "table" | "policy_fallback" | null;
  /** 연결 폼에 저장된 칸 수(장비 행이 없을 때 순위 저장이 장비 행을 만드는 값). CLI 도구 행은 null */
  stored: number | null; mismatch: boolean; level: LlmOpsLevel; text: string; note: string | null; sharedWith: string[] }>;
export type LlmLimitForm = Readonly<{ deviceId: string; current: number | null; expectedVersion: number | null; policyHash: string | null;
  eligible: boolean; reason: string | null; sharedWith: string[] }>;
export type LlmOpsStatus = Readonly<{ level: LlmOpsLevel; text: string; reason: string | null; detail: string | null }>;
export type LlmOpsRow = Readonly<{
  key: string; anchor: string; source: "connection" | "cli-tool";
  connection: AiConnectionView | null;
  label: string; kind: "api" | "cli"; kindText: string; address: string | null; version: string | null; versionSource: string | null;
  enabled: boolean; keyText: string | null;
  models: { ids: string[]; title: string; error: string | null; readAt: string | null };
  modelTasks: Readonly<Record<string, LlmTaskChip[]>>;
  capacity: LlmCapacity | null; otherDevices: string[];
  tasks: LlmTaskChip[];
  status: LlmOpsStatus;
  ledger: { succeeded1h: number; failed1h: number; dispatched: number; settled1h: number } | null;
  retry: number | null;
  limitForm: LlmLimitForm | null;
  editLinks: { href: string; label: string }[];
}>;
export type LlmOpsView = Readonly<{ readable: boolean; observedAt: string | null; rows: LlmOpsRow[];
  totals: { connections: number; cliTools: number; models: number; limitSum: number | null }; errors: string[] }>;

export const RUNTIME_FRESH_MS = 30 * 60_000;
const chipHref = (task: string, slot: number) => `/admin/models/tasks#execution-${task}-${slot}`;
const chipSort = (a: LlmTaskChip, b: LlmTaskChip) => (a.rank ?? 99) - (b.rank ?? 99)
  || AI_TASKS.findIndex(task => task.id === a.task) - AI_TASKS.findIndex(task => task.id === b.task) || a.slot - b.slot;

function capacityOf(deviceId: string, observation: AdminModelsObservation, stored: number | null, sharedWith: string[]): LlmCapacity {
  const readable = observationReadable(observation);
  const state = readable ? observation.devices.find(device => device.deviceId === deviceId) : undefined;
  const group = readable ? observation.groups.find(row => row.groupId === deviceId) : undefined;
  const limit = state?.limitSlots ?? group?.limit ?? null;
  const held = readable ? group?.held ?? 0 : null;
  const source = state?.source ?? (group?.source ?? null);
  const mismatch = stored !== null && state?.source === "table" && state.limitSlots !== stored;
  const level: LlmOpsLevel = !readable || limit === null ? "unknown" : held !== null && held >= limit ? "warn" : "ok";
  const text = !readable ? UNREADABLE : `${fmt(held ?? 0)} / ${limit === null ? UNREADABLE : fmt(limit)}`;
  const note = !readable ? "장부를 읽지 못했습니다"
    : mismatch ? `연결 폼 ${fmt(stored!)}칸과 다름 — 장비 행 ${fmt(limit!)}칸이 적용됨`
    : !state && !group ? stored !== null ? `장비 행 없음 — 순위를 저장하면 ${fmt(stored)}칸으로 만듭니다` : "장비 행 없음"
    : source === "policy_fallback" ? "장비 행 없음 · 정책 대체 한도"
    : !observation.devicesRead ? "장비 행을 읽지 못함" : null;
  return { deviceId, limit, held, waiting: state ? state.waiting : null, source, stored, mismatch, level, text, note, sharedWith };
}

function limitFormOf(connection: AiConnectionView, observation: AdminModelsObservation, sharedWith: string[]): LlmLimitForm {
  const readable = observationReadable(observation);
  const state = readable ? observation.devices.find(device => device.deviceId === connection.deviceId) : undefined;
  const inPolicy = (observation.configuredRoutes ?? []).some(route => route.groupId === connection.deviceId);
  const current = state?.limitSlots ?? null;
  const base = { deviceId: connection.deviceId, current, expectedVersion: state?.version ?? null, policyHash: observation.policyHash, sharedWith };
  const reason = !readable ? "장부를 읽지 못해 지금은 장비 한도를 저장할 수 없습니다."
    : !observation.policyVerified || !observation.policyHash ? "용량 정책을 확인하지 못해 장비 한도를 여기서 저장할 수 없습니다."
    : !connection.enabled ? "꺼진 연결의 장비 한도는 고급 설정 → 장비 한도에서 바꿉니다."
    : !inPolicy ? "이 장비를 쓰는 정책 경로가 아직 없습니다 — 작업 배정에서 순위를 저장하면 이 값으로 장비 행을 만듭니다."
    : !state ? "장비 상태를 읽지 못했습니다."
    : null;
  return { ...base, eligible: reason === null, reason };
}

function statusOf(signals: LlmOpsStatus[], base: LlmOpsStatus): LlmOpsStatus {
  const worst = signals.reduce<LlmOpsStatus | null>((current, signal) => !current || LEVEL_RANK[signal.level] > LEVEL_RANK[current.level] ? signal : current, null);
  if (!worst || LEVEL_RANK[worst.level] <= LEVEL_RANK.idle) return base;
  const others = signals.filter(signal => signal !== worst && signal.reason).map(signal => signal.reason!);
  return { ...worst, reason: [worst.reason, ...others].filter(Boolean).slice(0, 2).join(" · ") || null };
}

/** 이 연결의 순위 중 실행 쪽이 마지막 틱에 쓸 수 없다고 남긴 것(30분 안). 여러 칸 작업은 그 순위의 모든 칸이 이 연결일 때만. */
function runtimeUnusable(connectionId: string, input: LlmOpsInput): { task: string; code: string; count: number; text: string }[] {
  if (!input.runtime || !input.rows) return [];
  const now = Date.parse(input.now), out: { task: string; code: string; count: number; text: string }[] = [];
  for (const [taskId, runtime] of Object.entries(input.runtime)) {
    if (!(now - Date.parse(runtime.at) <= RUNTIME_FRESH_MS)) continue;
    for (const entry of runtime.unusable) {
      const ranked = input.rows.filter(row => row.task === taskId && row.rank === entry.rank);
      if (ranked.length && ranked.every(row => row.connectionId === connectionId)) out.push({ task: taskId, code: entry.code, count: entry.count, text: entry.text });
    }
  }
  return out;
}

function ledgerOf(rows: readonly AdminModelMetrics[] | null) {
  if (!rows) return null;
  const succeeded1h = sum(rows, "succeeded1h"), failed1h = sum(rows, "failed1h");
  return { succeeded1h, failed1h, dispatched: sum(rows, "dispatched"), settled1h: succeeded1h + failed1h + sum(rows, "unclassified1h") };
}

function commonSignals(ledgerRows: readonly AdminModelMetrics[] | null, tasks: readonly LlmTaskChip[]): { signals: LlmOpsStatus[]; base: LlmOpsStatus } {
  const signals: LlmOpsStatus[] = [];
  const ledger = ledgerOf(ledgerRows);
  const indeterminate = ledgerRows ? sum(ledgerRows, "indeterminate") : 0;
  if (ledger && ledger.failed1h > 0 && ledger.succeeded1h === 0) signals.push({ level: "bad", text: "실패만", reason: `1시간 실패 ${fmt(ledger.failed1h)}건 · 성공 0건`, detail: null });
  else if (ledger && ledger.failed1h > 0) signals.push({ level: "warn", text: "일부 실패", reason: `1시간 정산 ${fmt(ledger.settled1h)} · 실패 ${fmt(ledger.failed1h)}`, detail: null });
  if (indeterminate > 0) signals.push({ level: "warn", text: "미확정 있음", reason: `재실행 대기 ${fmt(indeterminate)}건`, detail: null });
  const active = tasks.filter(task => task.enabled);
  const base: LlmOpsStatus = !active.length ? { level: "idle", text: "배정 없음", reason: "이 연결을 쓰는 작업이 없습니다", detail: null }
    : active.every(task => task.paused) ? { level: "idle", text: "의도적 중지", reason: `잡 일시중지: ${[...new Set(active.map(task => task.label))].join(" · ")}`, detail: null }
    : !ledger ? { level: "unknown", text: UNREADABLE, reason: "장부를 읽지 못했습니다", detail: null }
    : ledger.settled1h > 0 || ledger.dispatched > 0 ? { level: "ok", text: "정상", reason: `1시간 정산 ${fmt(ledger.settled1h)}${ledger.dispatched ? ` · 실행 중 ${fmt(ledger.dispatched)}` : ""}`, detail: null }
    : { level: "idle", text: "1시간 호출 없음", reason: "최근 1시간 정산·실행 기록이 없습니다", detail: null };
  return { signals, base };
}

export function buildLlmOpsView(input: LlmOpsInput): LlmOpsView {
  const { observation } = input;
  const readable = observationReadable(observation);
  const errors: string[] = [];
  if (!input.connections) errors.push("AI 연결을 읽지 못했습니다.");
  if (!input.rows) errors.push("작업 순위를 읽지 못했습니다 — 배정된 작업 칸이 비어 보일 수 있습니다.");
  if (!readable) errors.push("LLM 장부(운영 DB)를 읽지 못했습니다 — 점유·정산은 「확인 불가」로 보입니다.");
  if (!input.runtime) errors.push("실행 쪽 순위 사정을 읽지 못했습니다 — 실패 까닭이 빠질 수 있습니다.");
  const paused = pausedTaskIds(input.jobs) ?? new Set<string>();
  const connections = input.connections ?? [];
  const ledgerRows = readable ? observation.rows : null;
  const policy = observation.configuredRoutes ?? [];
  const labelOf = (connection: AiConnectionView) => aiConnectionLabel(connection);

  // 연결마다 순위·분산 칩
  const chipsOf = (connection: AiConnectionView): LlmTaskChip[] => {
    const chips: LlmTaskChip[] = [];
    for (const row of input.rows ?? []) {
      if (row.connectionId !== connection.id) continue;
      const task = aiTask(row.task);
      chips.push({ key: `rank:${row.task}:${row.slot}:${row.rank}`, task: row.task, label: task ? (task.slots > 1 ? aiTaskSlotLabel(task, row.slot) : task.label) : row.task,
        rank: row.rank, slot: row.slot, model: row.model, enabled: row.enabled, source: "rank", paused: paused.has(row.task), href: chipHref(row.task, row.slot) });
    }
    for (const execution of input.executions ?? []) {
      if (execution.mode !== "workload_pool") continue;
      for (const member of execution.members) {
        if (member.connectionId !== connection.id) continue;
        const task = aiTask(execution.task);
        chips.push({ key: `pool:${execution.task}:${execution.slot}:${member.memberId}`, task: execution.task,
          label: task ? (task.slots > 1 ? aiTaskSlotLabel(task, execution.slot) : task.label) : execution.task, rank: null, slot: execution.slot, model: member.model,
          enabled: true, source: "pool", paused: paused.has(execution.task), href: chipHref(execution.task, execution.slot) });
      }
    }
    return chips;
  };

  // CLI 도구: 정책 경로·장부·CLI 계약·분류 설정·잘 알려진 CLI 장비 행에서 모은다
  type CliTool = { provider: string; devices: Set<string>; models: Set<string>; versions: Map<string, string>; chips: LlmTaskChip[]; ledger: AdminModelMetrics[]; classifier: boolean };
  const tools = new Map<string, CliTool>();
  const tool = (provider: string) => {
    let entry = tools.get(provider);
    if (!entry) { entry = { provider, devices: new Set(), models: new Set(), versions: new Map(), chips: [], ledger: [], classifier: false }; tools.set(provider, entry); }
    return entry;
  };
  const policyChip = (provider: string, routeId: string, model: string): LlmTaskChip => {
    const task = taskOfRoute(routeId);
    return { key: `policy:${provider}:${routeId}:${model}`, task: task?.id ?? routeId, label: task?.label ?? routeTaskLabel(routeId), rank: null, slot: 1, model, enabled: true,
      source: "policy", paused: task ? paused.has(task.id) : false, href: task ? chipHref(task.id, 1) : "/admin/models/contracts" };
  };
  for (const route of policy) {
    if (!isCliProvider(route.provider)) continue;
    const entry = tool(route.provider);
    entry.devices.add(route.groupId); entry.models.add(route.model);
    entry.chips.push(policyChip(route.provider, route.routeId, route.model));
  }
  for (const row of ledgerRows ?? []) {
    if (!isCliProvider(row.provider)) continue;
    const entry = tool(row.provider);
    entry.devices.add(row.groupId); entry.models.add(row.model); entry.ledger.push(row);
  }
  for (const contract of input.cliContracts ?? []) {
    if (!isCliProvider(contract.provider)) continue;
    const entry = tool(contract.provider);
    entry.models.add(contract.model);
    if (contract.cliVersion) entry.versions.set(contract.cliVersion, "계약");
    entry.chips.push(policyChip(contract.provider, contract.routeId, contract.model));
  }
  if (input.classifier) for (const model of input.classifier.models) {
    if (!model.provider || !isCliProvider(model.provider)) continue;
    const entry = tool(model.provider);
    entry.models.add(model.model); entry.classifier = true;
    entry.chips.push({ key: `classifier:${model.provider}:${model.rank}`, task: "publish-classify", label: aiTask("publish-classify")?.label ?? "카테고리 분류", rank: model.rank, slot: 1,
      model: model.model, enabled: true, source: "classifier", paused: paused.has("publish-classify"), href: "/admin/status?tab=ai" });
  }
  if (input.classifier) for (const version of input.classifier.versions) if (tools.has(version.provider)) tools.get(version.provider)!.versions.set(version.cliVersion, "분류 에이전트 관측");
  if (readable) for (const device of observation.devices) {
    const provider = CLI_VENDOR_DEVICES[device.deviceId];
    if (provider && ![...tools.values()].some(entry => entry.devices.has(device.deviceId))) tool(provider).devices.add(device.deviceId);
  }
  /** 같은 작업·칸·순위는 한 번만. 순위·분산·분류 설정이 있는 작업은 정책 경로에서 온 칩을 덧붙이지 않는다. */
  const dedupe = (chips: LlmTaskChip[]) => {
    const explicit = new Set(chips.filter(chip => chip.source !== "policy").map(chip => chip.task));
    const seen = new Set<string>(), out: LlmTaskChip[] = [];
    for (const chip of chips) {
      if (chip.source === "policy" && explicit.has(chip.task)) continue;
      const key = `${chip.task}:${chip.slot}:${chip.rank ?? ""}:${chip.source}`;
      if (seen.has(key)) continue;
      seen.add(key); out.push(chip);
    }
    return out;
  };

  // 같은 장비를 쓰는 다른 연결·도구 이름
  const deviceUsers = new Map<string, string[]>();
  const addUser = (deviceId: string, name: string) => { const list = deviceUsers.get(deviceId) ?? []; if (!list.includes(name)) list.push(name); deviceUsers.set(deviceId, list); };
  for (const connection of connections) addUser(connection.deviceId, labelOf(connection));
  const covered = new Map<string, AiConnectionView>();
  for (const connection of connections) {
    if (connection.kind !== "cli" || !connection.cliTool) continue;
    const provider = AI_CLI_TOOL_PROVIDERS[connection.cliTool];
    if (!covered.has(provider) || (!covered.get(provider)!.enabled && connection.enabled)) covered.set(provider, connection);
  }
  for (const entry of tools.values()) if (!covered.has(entry.provider)) for (const deviceId of entry.devices) addUser(deviceId, cliProviderLabel(entry.provider));
  const sharedWith = (deviceId: string, self: string) => (deviceUsers.get(deviceId) ?? []).filter(name => name !== self);

  const rows: LlmOpsRow[] = [];
  for (const connection of connections) {
    const label = labelOf(connection);
    const provider = connection.kind === "cli" && connection.cliTool ? AI_CLI_TOOL_PROVIDERS[connection.cliTool] : null;
    const extra = provider && covered.get(provider)?.id === connection.id ? tools.get(provider) ?? null : null;
    const ranked = chipsOf(connection);
    const tasks = dedupe([...ranked, ...(extra?.chips.filter(chip => !ranked.some(own => own.task === chip.task)) ?? [])]).sort(chipSort);
    const ids = connection.kind === "api" ? (connection.models ?? []).map(model => model.id) : [...connection.cliModels];
    const modelTasks: Record<string, LlmTaskChip[]> = {};
    for (const chip of tasks) (modelTasks[chip.model] ??= []).push(chip);
    const own = ledgerRows ? ledgerRows.filter(row => row.groupId === connection.deviceId) : null;
    const { signals, base } = commonSignals(own, tasks);
    if (connection.enabled && connection.kind === "api" && (!connection.models || !connection.models.length))
      signals.push({ level: "bad", text: "목록 못 읽음", reason: llmReasonShort(connection.modelsError) ?? (connection.models === null ? "아직 읽지 않음" : "모델 0개"),
        detail: aiModelsErrorText(connection.modelsError) });
    for (const entry of connection.enabled ? runtimeUnusable(connection.id, input) : []) {
      const level = llmReasonLevel(entry.code);
      signals.push({ level, text: level === "bad" ? "부르지 못함" : "일부 건너뜀",
        reason: `${llmReasonShort(entry.code)} ${fmt(entry.count)}회(${aiTask(entry.task)?.label ?? entry.task})`, detail: entry.text });
    }
    if (extra?.classifier && input.classifier?.fresh && input.classifier.ready === false)
      signals.push({ level: "bad", text: "분류 요청 안 받음", reason: "connect 에이전트가 분류를 받지 않음", detail: null });
    const status = !connection.enabled ? { level: "idle" as const, text: "꺼짐", reason: "순위 선택지에서 빠져 있습니다(저장된 순위는 남음)", detail: null } : statusOf(signals, base);
    const versions = connection.cliVersion ? [connection.cliVersion] : [...(extra?.versions.keys() ?? [])];
    const others = sharedWith(connection.deviceId, label);
    rows.push({ key: connection.id, anchor: `conn-${connection.id}`, source: "connection", connection, label, kind: connection.kind,
      kindText: connection.kind === "api" ? "API" : `CLI · ${connection.cliTool ? AI_CLI_TOOL_LABELS[connection.cliTool] : "도구 미확인"}`,
      address: connection.kind === "api" ? connection.host ?? connection.baseUrl : connection.cliTool === "opencode" ? connection.host : null,
      version: versions[0] ?? null, versionSource: connection.cliVersion ? "연결" : versions.length ? extra!.versions.get(versions[0]) ?? null : null,
      enabled: connection.enabled,
      keyText: connection.kind === "api" ? (connection.hasKey ? "키 저장됨" : "키 없음") : connection.cliTool === "opencode" ? (connection.hasKey ? "호스트 인증 저장됨" : "호스트 인증 미확인") : null,
      models: { ids, title: connection.kind === "api" ? (connection.models ? `${ids.length}개` : "목록 없음")
        : connection.cliTool === "opencode" ? `카탈로그 ${ids.length}개` : `${ids.length}개`,
        error: aiModelsErrorText(connection.modelsError), readAt: connection.modelsReadAt },
      modelTasks, capacity: capacityOf(connection.deviceId, observation, connection.capacitySlots, others), otherDevices: [],
      tasks, status, ledger: ledgerOf(own), retry: own ? sum(own, "indeterminate") : null,
      limitForm: limitFormOf(connection, observation, others), editLinks: extra?.classifier ? [{ href: "/admin/status?tab=ai", label: "분류 모델 설정" }] : [] });
  }
  for (const entry of [...tools.values()].sort((a, b) => cliProviderLabel(a.provider).localeCompare(cliProviderLabel(b.provider)))) {
    if (covered.has(entry.provider)) continue;
    const label = cliProviderLabel(entry.provider);
    const devices = [...entry.devices].sort();
    const tasks = dedupe(entry.chips).sort(chipSort);
    const modelTasks: Record<string, LlmTaskChip[]> = {};
    for (const chip of tasks) (modelTasks[chip.model] ??= []).push(chip);
    const own = ledgerRows ? ledgerRows.filter(row => row.provider === entry.provider) : null;
    const { signals, base } = commonSignals(own, tasks);
    if (entry.classifier && input.classifier?.fresh && input.classifier.ready === false)
      signals.push({ level: "bad", text: "분류 요청 안 받음", reason: "connect 에이전트가 분류를 받지 않음", detail: null });
    if (entry.classifier && input.classifier && !input.classifier.fresh)
      signals.push({ level: "unknown", text: UNREADABLE, reason: "분류 에이전트 관측이 오래됨", detail: null });
    const versions = [...entry.versions.keys()];
    const cliTool = aiCliToolOfProvider(entry.provider);
    const editLinks = [
      ...(entry.classifier || entry.provider === "codex-cli" ? [{ href: "/admin/status?tab=ai", label: "분류 모델 설정" }] : []),
      ...(tasks.some(chip => chip.source !== "classifier") ? [{ href: "/admin/models/tasks", label: "작업 배정(순위)" }] : []),
      ...(cliTool && cliTool !== "codex" ? [{ href: "/admin/models/llm?add=1#connection-new", label: "CLI 연결로 등록" }] : []),
      { href: "/admin/models/contracts", label: "CLI 계약" },
      ...(devices.length ? [{ href: "/admin/models/devices", label: "장비 한도" }] : []),
    ];
    rows.push({ key: `cli:${entry.provider}`, anchor: `cli-${entry.provider}`, source: "cli-tool", connection: null, label, kind: "cli", kindText: `CLI 도구 · ${entry.provider}`,
      address: devices.length ? `장비 ${devices.join(" · ")}` : null, version: versions[0] ?? null, versionSource: versions.length ? entry.versions.get(versions[0]) ?? null : null,
      enabled: true, keyText: null,
      models: { ids: [...entry.models].sort(), title: `설정·관측 ${entry.models.size}개`, error: null, readAt: null },
      modelTasks, capacity: devices.length ? capacityOf(devices[0], observation, null, sharedWith(devices[0], label)) : null, otherDevices: devices.slice(1),
      tasks, status: statusOf(signals, base), ledger: ledgerOf(own), retry: own ? sum(own, "indeterminate") : null, limitForm: null, editLinks });
  }
  const limitDevices = new Map<string, number>();
  for (const row of rows) if (row.capacity && row.capacity.limit !== null) limitDevices.set(row.capacity.deviceId, row.capacity.limit);
  return { readable, observedAt: observation.observedAt, rows, errors,
    totals: { connections: rows.filter(row => row.source === "connection").length, cliTools: rows.filter(row => row.source === "cli-tool").length,
      models: rows.reduce((total, row) => total + row.models.ids.length, 0),
      limitSum: limitDevices.size ? [...limitDevices.values()].reduce((total, value) => total + value, 0) : null } };
}

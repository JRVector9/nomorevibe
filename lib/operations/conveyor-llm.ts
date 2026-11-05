import { AI_TASKS, aiTaskAliasIdentity, isAiLiveTask, type AiTaskDef } from "@/lib/llm/ai-tasks";
import { bareModelName, sameUnderlyingModel } from "@/lib/crawl/review-model-identity";
import { deviceServer, isLocalModelHost } from "./admin-models-view";
import { NO_MODEL_TEXT, type StationKey } from "./conveyor-model";

/**
 * 전체 흐름 칸마다 「지금 쓰는 모델」 — 설정한 순위(작업 ↔ AI 모델 1·2·3순위)와 실제 쓰인 모델(최근 1시간 모델 장부 정산)을 견준다.
 *
 * DB 를 읽지 않는 순수 함수다(읽기는 conveyor-llm-read.ts). 이 화면은 읽기만 한다 — 순위를 바꾸는 길은 「작업 ↔ AI 모델」 화면 하나뿐이고, 여기서는 그리로 보낸다.
 *
 * 근거:
 * - 칸 ↔ 작업: 아래 STATION_TASKS. 작업 목록·용량 route id(장부 이름)·「실행 쪽이 순위를 읽는가」(isAiLiveTask)는 lib/llm/ai-tasks.ts 의 AI_TASKS 가 정한다.
 *   모든 AI 작업은 칸에 있거나 벨트 밖(OFF_BELT_TASKS)에 있어야 한다 — 새 작업이 생기면 tests/conveyor-llm.test.ts 가 깨져 이 표를 고치게 한다.
 * - LLM 없는 칸: 탐색·원본 수집·규칙 심사. 이 칸들의 잡은 AI_TASKS 어느 작업에도 없고, 코드에서 확인했다(NO_LLM — 아래 근거 글).
 * - 순위가 비어 작업이 멈추는 경우(2026-11-02 21:13Z 드롭다운 사고, no_task_models): 실행 쪽이 순위를 읽는 작업(live)의 1순위가 비면 그 작업은 돌지 않는다
 *   (옛 설정·기본값으로 대신 부르지 않는다). 칸을 「모델 없음 — 멈춤」으로 올린다.
 * - 1차와 2차가 같은 모델: 2차 관문(lib/crawl/second-review.ts)은 1차와 다른 모델의 투표자가 없으면 표를 내지 못하고 1차 승인을 「2차 갈림」으로 보류한다.
 */
export type LlmStationKey = StationKey | "human";

/** 칸 → 그 칸이 부르는 AI 작업(AI_TASKS 의 id). 칸의 잡(STATION_JOBS)과 작업의 jobs·route 가 같은 일을 가리키는 것을 기준으로 정했다. */
export const STATION_TASKS: Readonly<Record<LlmStationKey, readonly string[]>> = Object.freeze({
  discover: [], fetch: [], judge: [],
  first: ["first-review"],
  second: ["second-review"],
  // 순위 편집의 기존 묶음을 보존한다. 흐름 관측은 아래 buildStationLlm 에서 공개 전 소개 / 공개 후·보조 작업을 분리한다.
  profile: ["crawl-tagline", "product-tagline-ko", "korean-translation-direct", "product-translate", "reason-translate", "product-intro-check"],
  publish: ["publish-classify"],
  // 키워드 등록 — 검색 키워드 짓기·검수(잡 product-search-profile·verify)와 제품 벡터(product-embedding)
  keywords: ["product-search-profile", "product-search-verify", "product-embedding"],
  human: ["human-review", "split-confirm", "split-tiebreak", "held-review-retry"],
});

/** 벨트 밖의 AI 작업 — 웹 요청(검색)·발행 뒤 감사·보강·Grok 로그인 유지. 이 화면의 칸이 아니다 */
export const OFF_BELT_TASKS: readonly string[] = Object.freeze([
  "search-query-translate", "search-embedding", "search-rerank",
  "audit-review", "audit-second-opinion", "published-filter", "screen-review", "product-audit", "assist-review", "assist-audit",
  "grok-session-check",
]);

/** LLM 을 안 쓰는 칸 — 짧은 말(카드)과 코드 근거(자세히) */
export const NO_LLM: Readonly<Record<"discover" | "fetch" | "judge" | "sink", { short: string; why: string }>> = Object.freeze({
  discover: { short: "탐색 API", why: "GitHub 검색·Show HN·한국어 프로젝트 탐색은 검색 API 호출과 규칙으로만 합니다(lib/crawl/jobs/seed.ts·hn-show.ts, 잡 crawl-seed·hn-show-seed·crawl-ko-apply — AI 작업 목록에 없음)." },
  fetch: { short: "내려받기", why: "README·홈페이지를 내려받습니다. 「AI 흔적 더듬기」도 파일 목록과 커밋 문구 규칙일 뿐 모델을 부르지 않습니다(lib/crawl/ai-evidence-gate.ts, 잡 crawl-fetch)." },
  judge: { short: "규칙", why: "포크·대형 오픈소스·URL 없음 같은 규칙으로 거릅니다. 잡 카탈로그에 「crawl-judge 모델 없음」으로 적혀 있고 AI 작업 목록에도 없습니다(lib/jobs/catalog.ts)." },
  sink: { short: "게시", why: "공개 목록에 올라간 제품 수를 보여 주는 끝 칸입니다." },
});

// ── 입력 ─────────────────────────────────────────────────────────────────────────────────────────

export type LlmConnection = { id: string; label: string; kind: "api" | "cli"; baseUrl?: string | null; cliTool: string | null; hasKey: boolean; enabled: boolean };
export type LlmRankRow = { task: string; slot: number; rank: number; connectionId: string; model: string; enabled: boolean };
/**
 * 최근 1시간 장부(model_capacity_requests state=settled)를 route·provider·model 로 센 것. groups 는 그 호출들이 잡은 장비 그룹(group_id) —
 * 순위에 맞지 않는 호출의 「어디서」를 장비 이름으로 보이는 데 쓴다(없으면 빈 배열).
 */
export type LlmUsedRow = { routeId: string; provider: string; model: string; count: number; lastAt: string | null; groups?: string[] };
/** 실행 쪽 순위 사정(잡의 마지막 틱 관측 ai_task.ranks) — 오래됐으면 쓰지 않는다 */
export type LlmRuntime = { at: string; degraded: { code: string; detail: string | null } | null; unusable: { rank: number; code: string; text: string }[] };
export type LlmInputs = {
  now: string;
  /** null = 읽지 못함 */
  connections: LlmConnection[] | null;
  rows: LlmRankRow[] | null;
  used: LlmUsedRow[] | null;
  runtime: Record<string, LlmRuntime> | null;
};

/** 실행 쪽 사정 관측을 믿는 시간 — 잡 관측이 멈춰 있어도(2차는 10:46Z 에 멈춘 채) 옛 오류를 지금 것으로 보이지 않게 한다 */
export const RUNTIME_FRESH_MS = 30 * 60_000;

// ── 출력 ─────────────────────────────────────────────────────────────────────────────────────────

export type RankSeen = { rank: number; connection: string; model: string; problem: string | null };
export type SlotSeen = { slot: number; label: string | null; ranks: RankSeen[] };
export type UsedSeen = { text: string; model: string; where: string; count: number; rank: number | null; lastAt: string | null };
export type TaskState =
  /** 설정 1순위를 쓰고 있다 */
  | "ok"
  /** 1순위가 아닌 순위로 넘어갔다(키 없는 연결·꺼진 연결·쓸 수 없는 순위) */
  | "fallback"
  /** 장부에 보이는 모델이 어느 순위에도 없다 */
  | "other"
  /** 순위가 비어 작업이 멈춘다(no_task_models) */
  | "none"
  /** 순위는 있으나 모두 쓸 수 없어 멈춘다(all_ranks_unusable) */
  | "stuck"
  /** 최근 1시간 호출이 없다 — 설정만 보인다 */
  | "idle"
  /** 설정만 알 수 있다(장부 밖이거나 장부를 읽지 못함, 또는 실행 쪽이 아직 이 순위를 읽지 않는 작업) */
  | "set_only";
export type TaskHead = { model: string; where: string; rank: number | null; source: "used" | "set"; count: number | null };
export type TaskLlm = {
  task: string; label: string; live: boolean; state: TaskState;
  slots: SlotSeen[];
  /** null = 알 수 없음(장부 밖 route·읽지 못함) */
  used: UsedSeen[] | null;
  usedWhy: "no_ledger" | "unread" | null;
  head: TaskHead | null;
  /** 한 줄 설명(왜 이 상태인지) */
  note: string | null;
};
export type LlmFlag = { tone: "bad" | "warn"; text: string };
export type StationLlm =
  | { kind: "none"; short: string; why: string }
  | { kind: "unknown"; why: string }
  | {
    kind: "llm"; tasks: TaskLlm[]; head: TaskLlm;
    /** 대표가 아닌 작업 중 다른 모델(또는 모델 없음)을 쓰는 수 — 카드의 「외 N」 */
    more: number;
    flag: LlmFlag | null;
    /** 순위가 비어 멈춘 작업(live) / live 작업 수 */
    stopped: string[]; liveCount: number;
    /** 1차·2차가 같은 모델이다(칸마다 같은 값) */
    sameModel: boolean;
    warnings: string[];
  };

// ── 계산 ─────────────────────────────────────────────────────────────────────────────────────────

const taskDef = (id: string): AiTaskDef | null => AI_TASKS.find((row) => row.id === id) ?? null;

function problemOf(row: LlmRankRow, connection: LlmConnection | undefined): string | null {
  if (!row.enabled) return "순위가 꺼져 있음";
  if (!connection) return "연결을 찾을 수 없음";
  if (!connection.enabled) return "연결이 꺼져 있음";
  // 로컬 직접 연결(gpu3090-qwen·supa-direct·m3-mlx)은 키 없이 부른다 — hasKey=false 를 멈춤으로 오해하지 않는다
  if (connection.kind === "api" && !connection.hasKey && !isLocalModelHost(connection.baseUrl)) return "연결에 키가 없음 — 건너뜀";
  return null;
}

function slotsOf(def: AiTaskDef, inputs: LlmInputs, runtime: LlmRuntime | null): SlotSeen[] {
  const fresh = runtime && Date.parse(inputs.now) - Date.parse(runtime.at) <= RUNTIME_FRESH_MS ? runtime : null;
  return Array.from({ length: def.slots }, (_, index) => index + 1).map((slot) => {
    const ranks = (inputs.rows ?? []).filter((row) => row.task === def.id && row.slot === slot).sort((a, b) => a.rank - b.rank).map((row): RankSeen => {
      const connection = inputs.connections?.find((entry) => entry.id === row.connectionId);
      // 실행 쪽이 마지막 틱에서 이 순위를 쓸 수 없다고 한 까닭이 있으면 그것이 더 정확하다(칸이 하나인 작업만 순위로 가를 수 있다)
      const seen = def.slots === 1 ? fresh?.unusable.find((entry) => entry.rank === row.rank)?.text ?? null : null;
      return { rank: row.rank, connection: connection?.label ?? "연결 없음", model: row.model, problem: seen ?? problemOf(row, connection) };
    });
    return { slot, label: def.slotLabel ? `${def.slotLabel} ${slot}` : null, ranks };
  });
}

/** 순위 한 줄을 장부의 model 이름과 맞춘다 — 같은 모델을 다른 연결에도 둔 이름(모델@연결 8자)을 먼저, 그다음 접두어를 뗀 이름 */
function matchRank(slots: SlotSeen[], rows: LlmRankRow[], task: string, used: LlmUsedRow): RankSeen | null {
  const all = slots.flatMap((slot) => slot.ranks.map((rank) => ({ rank, slot: slot.slot })));
  const ids = new Map(rows.filter((row) => row.task === task).map((row) => [`${row.slot}:${row.rank}`, row.connectionId]));
  const exact = all.find(({ rank, slot }) => {
    const connectionId = ids.get(`${slot}:${rank.rank}`);
    return used.model === rank.model || (connectionId ? used.model === aiTaskAliasIdentity(rank.model, connectionId) : false);
  });
  if (exact) return exact.rank;
  return all.find(({ rank }) => bareModelName(used.model) === bareModelName(rank.model))?.rank ?? null;
}

const where = (rank: RankSeen) => rank.connection;

/**
 * 장부 provider 값의 사람 말. 엔진 직접 계약의 장부 provider 는 옛 이름 그대로 `abcllm` 이지만(admin-engine-connect.ts — 장부·용량 정책 route 의 이름을
 * 지키려고 남겨 둔 내부 키) nomorevibe 는 abcLLM 을 쓰지 않는다 — 화면에 그 키를 그대로 쓰지 않는다(2026-11-04 사람 지적).
 */
const PROVIDER_TEXT: Readonly<Record<string, string>> = { abcllm: "직접 연결", "local-direct": "직접 연결", "llama-server": "직접 연결",
  "claude-cli": "Claude CLI", "grok-cli": "Grok CLI", "codex-cli": "Codex CLI", "opencode-cli": "OpenCode CLI" };

/**
 * 순위에 맞지 않는 장부 호출의 「어디서」 — 1) 장부 이름의 연결 표지(모델@연결 8자) → 그 연결 이름, 2) 호출이 잡은 장비 그룹 → 장비 이름(gpu3090 등),
 * 3) 같은 모델을 순위에 둔 연결이 하나뿐이면 그 연결 이름, 4) provider 의 사람 말. 내부 provider 키(abcllm)는 쓰지 않는다.
 */
function placeOf(row: LlmUsedRow, inputs: LlmInputs): string {
  const tag = row.model.match(/@([0-9a-f]{8})$/i)?.[1]?.toLowerCase();
  const tagged = tag ? inputs.connections?.find((connection) => connection.id.toLowerCase().startsWith(tag)) : undefined;
  if (tagged) return tagged.label;
  const devices = [...new Set((row.groups ?? []).filter(Boolean).map((group) => deviceServer(group, []).name))];
  if (devices.length) return devices.sort().join(" · ");
  const same = [...new Set((inputs.rows ?? []).filter((rank) => bareModelName(rank.model) === bareModelName(row.model)).map((rank) => rank.connectionId))];
  const only = same.length === 1 ? inputs.connections?.find((connection) => connection.id === same[0]) : undefined;
  if (only) return only.label;
  return PROVIDER_TEXT[row.provider] ?? row.provider;
}

function taskLlm(def: AiTaskDef, inputs: LlmInputs): TaskLlm {
  const live = isAiLiveTask(def.id);
  const runtime = inputs.runtime?.[def.id] ?? null;
  const fresh = runtime && Date.parse(inputs.now) - Date.parse(runtime.at) <= RUNTIME_FRESH_MS ? runtime : null;
  const slots = slotsOf(def, inputs, runtime);
  const configured = slots.flatMap((slot) => slot.ranks);
  const base = { task: def.id, label: def.label, live, slots };

  const usedWhy = !def.routeId ? "no_ledger" as const : inputs.used === null ? "unread" as const : null;
  const usedRows = usedWhy ? null : (inputs.used ?? []).filter((row) => row.routeId === def.routeId).sort((a, b) => b.count - a.count);
  const used: UsedSeen[] | null = usedRows && usedRows.map((row) => {
    const rank = inputs.rows ? matchRank(slots, inputs.rows, def.id, row) : null;
    const place = rank ? where(rank) : placeOf(row, inputs);
    return { text: `${place} · ${row.model}`, model: rank?.model ?? row.model, where: place, count: row.count, rank: rank?.rank ?? null, lastAt: row.lastAt };
  });

  // 순위가 비었다 — 실행 쪽이 순위를 읽는 작업은 돌지 않는다
  if (!configured.length) {
    if (live) return { ...base, state: "none", used, usedWhy, head: null,
      note: "작업 ↔ AI 모델에 순위가 없습니다 — 이 작업은 돌지 않습니다(no_task_models). 옛 설정·기본값으로 대신 부르지 않습니다." };
    const first = used?.[0] ?? null;
    return { ...base, state: "set_only", used, usedWhy,
      head: first ? { model: first.model, where: first.where, rank: null, source: "used", count: first.count } : null,
      note: "순위가 비어 있습니다. 이 작업은 실행 쪽이 아직 순위를 읽지 않아 옛 설정으로 부릅니다." };
  }

  // 지금 설정에서 쓸 수 있는 가장 높은 순위(첫 칸 — 2차는 투표자 1부터 보이는 순서)
  const slotWithRanks = slots.find((slot) => slot.ranks.length) ?? slots[0];
  const usable = slotWithRanks.ranks.find((rank) => !rank.problem) ?? null;
  const effective = usable ?? slotWithRanks.ranks[0];

  // 쓸 수 있는 순위가 하나도 없다 — 모든 순위가 꺼짐·키 없음이거나, 실행 쪽이 마지막 틱에 모두 쓸 수 없다고 했는데 최근 1시간 호출도 없다
  const anyUsable = slots.some((slot) => slot.ranks.some((rank) => !rank.problem));
  if (live && (!anyUsable || (fresh?.degraded?.code === "all_ranks_unusable" && !used?.length))) {
    return { ...base, state: "stuck", used, usedWhy,
      head: { model: effective.model, where: where(effective), rank: effective.rank, source: "set", count: null },
      note: `순위는 있으나 모두 쓸 수 없습니다 — ${configured.map((rank) => `${rank.rank}순위 ${rank.problem ?? "실행 쪽이 쓸 수 없다고 함"}`).join(" · ")}` };
  }

  const set: TaskHead = { model: effective.model, where: where(effective), rank: effective.rank, source: "set", count: null };
  if (used === null) return { ...base, state: effective.rank > 1 && live ? "fallback" : "set_only", used, usedWhy, head: set,
    note: usedWhy === "no_ledger" ? "용량 장부를 거치지 않는 작업이라 실제 호출은 장부에 남지 않습니다 — 설정한 순위만 보입니다."
      : "모델 장부를 읽지 못해 실제 사용은 확인하지 못했습니다 — 설정한 순위만 보입니다." };
  if (!live) {
    const top = used[0] ?? null;
    return { ...base, state: "set_only", used, usedWhy, head: top ? { model: top.model, where: top.where, rank: top.rank, source: "used", count: top.count } : set,
      note: "실행 쪽이 아직 이 순위를 읽지 않습니다 — 실제 호출은 옛 설정을 따릅니다." };
  }
  if (!used.length) return { ...base, state: effective.rank > 1 ? "fallback" : "idle", used, usedWhy, head: set,
    note: effective.rank > 1 ? `${slotWithRanks.ranks.find((rank) => rank.problem)?.rank ?? 1}순위를 쓸 수 없어 ${effective.rank}순위가 대신 서야 합니다(최근 1시간 호출 없음).`
      : "최근 1시간 호출이 없습니다 — 설정한 1순위를 보입니다." };

  const top = used[0];
  const headOf: TaskHead = { model: top.model, where: top.where, rank: top.rank, source: "used", count: top.count };
  const lowestRank = Math.min(...slots.flatMap((slot) => slot.ranks.map((rank) => rank.rank)));
  if (top.rank === null) return { ...base, state: "other", used, usedWhy, head: headOf,
    note: `최근 1시간에 쓰인 ${top.text} 은(는) 설정한 어느 순위에도 없습니다 — 순위가 바뀌기 전 호출이거나 설정과 다른 경로입니다.` };
  if (top.rank > lowestRank) {
    const skipped = slotWithRanks.ranks.filter((rank) => rank.rank < top.rank! && rank.problem).map((rank) => `${rank.rank}순위 ${rank.problem}`);
    return { ...base, state: "fallback", used, usedWhy, head: headOf,
      note: `${top.rank}순위로 넘어가 있습니다${skipped.length ? ` — ${skipped.join(" · ")}` : ""}.` };
  }
  return { ...base, state: "ok", used, usedWhy, head: headOf, note: null };
}

/** 대표를 고르는 순서 — 멈춤 > 순위가 바뀜 > 설정과 다름 > 정상 > 호출 없음 > 설정만(실행 쪽이 아직 읽지 않는 작업). 같으면 칸의 작업 순서 */
const SEVERITY: Record<TaskState, number> = { none: 0, stuck: 1, fallback: 2, other: 3, ok: 4, idle: 5, set_only: 6 };

const modelOf = (task: TaskLlm | null): string | null => task?.head?.model ?? null;

/** 2차가 실제로 표를 낼 모델들 — 최근 1시간 장부에 보인 것, 없으면 투표자마다 쓸 수 있는 가장 높은 순위 */
function secondModels(task: TaskLlm | undefined): string[] {
  if (!task) return [];
  if (task.used?.length) return task.used.map((row) => row.model);
  return task.slots.flatMap((slot) => {
    const pick = slot.ranks.find((rank) => !rank.problem) ?? slot.ranks[0];
    return pick ? [pick.model] : [];
  });
}

function stationLlm(tasks: TaskLlm[]): StationLlm {
  const head = [...tasks].sort((a, b) => SEVERITY[a.state] - SEVERITY[b.state])[0];
  const others = tasks.filter((task) => task !== head);
  // 「외 N」 — 대표와 다른 모델을 쓰는 작업의 모델 수 + 모델이 없어 멈춘 작업 수. 순위가 없지만 멈추지 않는 작업(실행 쪽이 아직 순위를 읽지 않음)은 세지 않는다
  const distinct = new Set(others.flatMap((task) => { const model = modelOf(task); return model && model !== modelOf(head) ? [model] : []; }));
  const stoppedOthers = others.filter((task) => task.state === "none" || task.state === "stuck").length;
  const live = tasks.filter((task) => task.live);
  const stopped = live.filter((task) => task.state === "none" || task.state === "stuck").map((task) => task.label);
  const flagFor = (): LlmFlag | null => {
    if (head.state === "none") return { tone: "bad", text: NO_MODEL_TEXT };
    if (head.state === "stuck") return { tone: "bad", text: "쓸 수 있는 순위 없음 — 멈춤" };
    if (head.state === "fallback") return { tone: "warn", text: `${head.head?.rank ?? 2}순위로 넘어감` };
    if (head.state === "other") return { tone: "warn", text: "순위에 없는 모델" };
    return null;
  };
  return { kind: "llm", tasks, head, more: distinct.size + stoppedOthers, flag: flagFor(), stopped, liveCount: live.length, sameModel: false, warnings: [] };
}

/** 칸마다 지금 쓰는 모델 — 읽지 못한 입력은 그 칸을 「확인 못함」으로 둔다(0 이나 정상으로 보이지 않게) */
export function buildStationLlm(inputs: LlmInputs): Record<LlmStationKey | "sink" | "support", StationLlm> {
  const out = {} as Record<LlmStationKey | "sink" | "support", StationLlm>;
  const unreadable = inputs.rows === null || inputs.connections === null;
  const summarize = (ids: readonly string[]): StationLlm => {
    if (unreadable) return { kind: "unknown", why: "작업 ↔ AI 모델 순위를 읽지 못했습니다" };
    return stationLlm(ids.flatMap((id) => { const def = taskDef(id); return def ? [taskLlm(def, inputs)] : []; }));
  };
  for (const key of Object.keys(STATION_TASKS) as LlmStationKey[]) {
    // 공개된 제품의 번역·소개 검수나 판정 사유 번역은 공개 전 소개 준비의 선행 조건이 아니다.
    const ids = key === "profile" ? STATION_TASKS.profile.filter((id) => id === "crawl-tagline") : STATION_TASKS[key];
    if (!ids.length) {
      const none = NO_LLM[key as "discover" | "fetch" | "judge"];
      out[key] = { kind: "none", short: none.short, why: none.why };
      continue;
    }
    out[key] = summarize(ids);
  }
  out.support = summarize(STATION_TASKS.profile.filter((id) => id !== "crawl-tagline"));
  out.sink = { kind: "none", short: NO_LLM.sink.short, why: NO_LLM.sink.why };

  // 1차와 2차가 같은 모델 — 2차 관문은 1차와 다른 모델의 투표자가 없으면 표를 내지 못한다(lib/crawl/second-review.ts)
  const first = out.first, second = out.second;
  if (first.kind === "llm" && second.kind === "llm") {
    const firstTask = first.tasks[0], secondTask = second.tasks[0];
    const firstModel = firstTask.state === "none" || firstTask.state === "stuck" ? null : firstTask.used?.[0]?.model ?? modelOf(firstTask);
    const voters = secondTask.state === "none" || secondTask.state === "stuck" ? [] : secondModels(secondTask);
    if (firstModel && voters.length && voters.every((model) => sameUnderlyingModel(firstModel, model))) {
      const text = (side: "first" | "second") => side === "second"
        ? `1차(${firstModel})와 같은 모델이라 2차가 표를 못 냅니다 — 1차 승인 후보가 「2차 갈림」으로 보류됩니다. 2차 투표자를 1차와 다른 모델로 바꾸세요`
        : `2차 투표자도 같은 모델(${voters[0]})이라 2차가 표를 못 냅니다 — 1차 승인이 「2차 갈림」으로 보류됩니다`;
      out.first = { ...first, sameModel: true, warnings: [text("first")], flag: first.flag ?? { tone: "warn", text: "2차와 같은 모델" } };
      out.second = { ...second, sameModel: true, warnings: [text("second")], flag: second.flag ?? { tone: "warn", text: "1차와 같은 모델" } };
    }
  }
  return out;
}

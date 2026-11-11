import { AI_TASKS, aiTaskAliasIdentity, aiTaskLedgerTracked, aiTaskOwnsLedgerRoute, aiTaskReadsRanks, type AiTaskDef } from "@/lib/llm/ai-tasks";
import { bareModelName } from "@/lib/crawl/review-model-identity";
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
 * - 1차와 2차에 같은 모델을 둘 수 있다. 2차 관문은 모델 이름과 관계없이 별도 2차 결과를 요구한다.
 */
export type LlmStationKey = StationKey | "human";

/** 칸 → 그 칸이 부르는 AI 작업(AI_TASKS 의 id). 칸의 잡(STATION_JOBS)과 작업의 jobs·route 가 같은 일을 가리키는 것을 기준으로 정했다. */
export const STATION_TASKS: Readonly<Record<LlmStationKey, readonly string[]>> = Object.freeze({
  discover: [], fetch: [], judge: [],
  first: ["first-review"],
  second: ["second-review"],
  // 순위 편집의 기존 묶음을 보존한다. 흐름 관측은 아래 buildStationLlm 에서 공개 전 소개 / 공개 후·보조 작업을 분리한다.
  profile: ["crawl-tagline", "product-tagline-ko", "product-translate", "reason-translate", "product-intro-check"],
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
  discover: { short: "탐색 API", why: "GitHub 검색·Show HN·Show GN·한국어 프로젝트 탐색은 검색 API·RSS 호출과 규칙으로만 합니다(lib/crawl/jobs/seed.ts·hn-show.ts·gn-show.ts, 잡 crawl-seed·hn-show-seed·gn-show-seed·crawl-ko-apply — AI 작업 목록에 없음)." },
  fetch: { short: "내려받기", why: "README·홈페이지를 내려받습니다. 「AI 흔적 더듬기」도 파일 목록과 커밋 문구 규칙일 뿐 모델을 부르지 않습니다(lib/crawl/ai-evidence-gate.ts, 잡 crawl-fetch)." },
  judge: { short: "규칙", why: "포크·대형 오픈소스·URL 없음 같은 규칙으로 거릅니다. 잡 카탈로그에 「crawl-judge 모델 없음」으로 적혀 있고 AI 작업 목록에도 없습니다(lib/jobs/catalog.ts)." },
  sink: { short: "게시", why: "공개 목록에 올라간 제품 수를 보여 주는 끝 칸입니다." },
});

// ── 입력 ─────────────────────────────────────────────────────────────────────────────────────────

/** deviceId: 그 연결이 쓰는 장비(정책 groupId) — 장부 호출의 장비를 연결 이름으로 부를 때 쓴다 */
export type LlmConnection = { id: string; label: string; kind: "api" | "cli"; baseUrl?: string | null; cliTool: string | null; hasKey: boolean; enabled: boolean; updatedAt?: string;
  deviceId?: string };
export type LlmRankRow = { task: string; slot: number; rank: number; connectionId: string; model: string; enabled: boolean; updatedAt?: string };
/**
 * 최근 1시간 장부(model_capacity_requests state=settled)를 route·provider·model 로 센 것. groups 는 그 호출들이 잡은 장비 그룹(group_id) —
 * 순위에 맞지 않는 호출의 「어디서」를 장비 이름으로 보이는 데 쓴다(없으면 빈 배열).
 */
export type LlmUsedRow = { routeId: string; provider: string; model: string; count: number; lastAt: string | null; groups?: string[] };
/** Current shared-ledger calls, distinct from historical completed requests. */
export type LlmActiveRow = LlmUsedRow & { state: "reserved" | "dispatched" | "indeterminate" };
/** 실행 쪽 순위 사정(잡의 마지막 틱 관측 ai_task.ranks) — 오래됐으면 쓰지 않는다 */
export type LlmExecutionRow = {
  task: string; slot: number; mode: "fallback" | "workload_pool"; revision: number | null; updatedAt: string | null;
  members: readonly { memberId: string; position: number; connectionId: string; model: string; deviceId: string }[];
};
export type LlmPoolRuntime = { configRevision: number; members: number; served: Readonly<Record<string, number>>;
  unusable: readonly { memberId: string; code: string; count: number }[] };
export type LlmRuntime = { at: string; startedAt?: string; pool?: LlmPoolRuntime; degraded: { code: string; detail: string | null } | null; unusable: { rank: number; code: string; text: string }[] };
export type LlmLegacyPublish = { source: string; observedAt: string | null; ready: boolean | null;
  models: { rank: number; model: string; where: string }[] };
export type LlmEffectiveConfig = { source: string; models: { model: string; where: string }[]; error: string | null; skip: string | null; notes: string[] };
export type LlmInputs = {
  now: string;
  /** null = 읽지 못함 */
  connections: LlmConnection[] | null;
  rows: LlmRankRow[] | null;
  used: LlmUsedRow[] | null;
  /** Undefined is retained for older pure fixtures; null means the current read failed. */
  active?: LlmActiveRow[] | null;
  /** Existing connect-agent observation, reused from the same operations snapshot. */
  legacyPublish?: LlmLegacyPublish | null;
  runtime: Record<string, LlmRuntime> | null;
  /** Explicit null means the mode read failed. Undefined preserves existing fallback-only pure fixtures. */
  execution?: readonly LlmExecutionRow[] | null;
  /** nonlive 실제 적용 설정. null = 읽지 못함, undefined = 기존 fixture(없음). */
  effective?: Record<string, LlmEffectiveConfig> | null;
};

/** 실행 쪽 사정 관측을 믿는 시간 — 잡 관측이 멈춰 있어도(2차는 10:46Z 에 멈춘 채) 옛 오류를 지금 것으로 보이지 않게 한다 */
export const RUNTIME_FRESH_MS = 30 * 60_000;

// ── 출력 ─────────────────────────────────────────────────────────────────────────────────────────

export type RankSeen = { rank: number; connection: string; model: string; problem: string | null };
export type SlotSeen = { slot: number; label: string | null; ranks: RankSeen[] };
export type UsedSeen = { text: string; model: string; where: string; count: number; rank: number | null; lastAt: string | null };
export type ActiveSeen = UsedSeen & { state: LlmActiveRow["state"] };
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
export type TaskLlmPool = {
  summary: string; modelCount: number; deviceCount: number;
  members: { memberId: string; slot: number; configRevision: number | null; connectionId?: string; connection: string; model: string; deviceId: string; problem: string | null }[];
  /** Only the exact current membership/revision may contribute member observations. */
  runtime: (LlmPoolRuntime & { at: string }) | null;
};
export type TaskLlm = {
  task: string; label: string; live: boolean; state: TaskState;
  slots: SlotSeen[];
  pool?: TaskLlmPool;
  legacy?: LlmLegacyPublish;
  effective?: LlmEffectiveConfig;
  /** null = 알 수 없음(장부 밖 route·읽지 못함) */
  used: UsedSeen[] | null;
  /** Current reservations/transmissions/uncertainties. A reservation is not a running call. */
  active?: ActiveSeen[] | null;
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

/** A previous rank's failure must not be attached to a newly saved rank with the same number. */
function currentRuntime(def: AiTaskDef, inputs: LlmInputs): LlmRuntime | null {
  const runtime = inputs.runtime?.[def.id];
  if (!runtime || !(Date.parse(inputs.now) - Date.parse(runtime.at) <= RUNTIME_FRESH_MS)) return null;
  // A tick may start with the old ranks and only finish after the save.
  const observedAt = Date.parse(runtime.startedAt ?? runtime.at);
  const pools = inputs.execution?.filter(row => row.task === def.id && row.mode === "workload_pool") ?? [];
  if (pools.length) {
    // Current adapters expose one task/slot observation; never apply an old rank/member failure to a new pool.
    if (pools.length !== 1 || !runtime.pool || runtime.pool.configRevision !== pools[0].revision
      || runtime.pool.members !== pools[0].members.length) return null;
    const ids = new Set(pools[0].members.map(member => member.memberId));
    if ([...Object.keys(runtime.pool.served), ...runtime.pool.unusable.map(member => member.memberId)].some(id => !ids.has(id))) return null;
    const changed = pools[0].updatedAt && Date.parse(pools[0].updatedAt) > observedAt
      || pools[0].members.some(member => inputs.connections?.some(connection => connection.id === member.connectionId
        && connection.updatedAt && Date.parse(connection.updatedAt) > observedAt));
    return changed ? null : runtime;
  }
  if (runtime.pool) return null;
  const changedSinceObservation = (inputs.execution ?? []).some(row => row.task === def.id && row.updatedAt
    && Date.parse(row.updatedAt) > observedAt) || (inputs.rows ?? []).some(row => row.task === def.id && row.updatedAt
    && Date.parse(row.updatedAt) > observedAt);
  return changedSinceObservation ? null : runtime;
}

function slotsOf(def: AiTaskDef, inputs: LlmInputs, fresh: LlmRuntime | null): SlotSeen[] {
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
 * 순위에 맞지 않는 장부 호출의 「어디서」 — 1) 장부 이름의 연결 표지(모델@연결 8자) → 그 연결 이름, 2) 호출이 잡은 장비 그룹 → 그 장비를 쓰는 연결 이름
 * (켜진 것 먼저 — llm-display deviceDisplay 와 같은 규칙), 연결이 없는 장비는 서버 이름(gpu3090 등),
 * 3) 같은 모델을 순위에 둔 연결이 하나뿐이면 그 연결 이름, 4) provider 의 사람 말. 내부 provider 키(abcllm)는 쓰지 않는다.
 */
function deviceConnectionNames(group: string, inputs: LlmInputs): string | null {
  const mine = (inputs.connections ?? []).filter((connection) => connection.deviceId === group);
  const named = mine.some((connection) => connection.enabled) ? mine.filter((connection) => connection.enabled) : mine;
  return named.length ? [...new Set(named.map((connection) => connection.label))].sort((a, b) => a.localeCompare(b, "ko")).join(" · ") : null;
}
function placeOf(row: LlmUsedRow, inputs: LlmInputs): string {
  const tag = row.model.match(/@([0-9a-f]{8})$/i)?.[1]?.toLowerCase();
  const tagged = tag ? inputs.connections?.find((connection) => connection.id.toLowerCase().startsWith(tag)) : undefined;
  if (tagged) return tagged.label;
  const devices = [...new Set((row.groups ?? []).filter(Boolean).map((group) => deviceConnectionNames(group, inputs) ?? deviceServer(group, []).name))];
  if (devices.length) return devices.sort().join(" · ");
  const same = [...new Set((inputs.rows ?? []).filter((rank) => bareModelName(rank.model) === bareModelName(row.model)).map((rank) => rank.connectionId))];
  const only = same.length === 1 ? inputs.connections?.find((connection) => connection.id === same[0]) : undefined;
  if (only) return only.label;
  return PROVIDER_TEXT[row.provider] ?? row.provider;
}

function taskLlm(def: AiTaskDef, inputs: LlmInputs): TaskLlm {
  const fresh = currentRuntime(def, inputs);
  const poolConfigs = inputs.execution?.filter(row => row.task === def.id && row.mode === "workload_pool") ?? [];
  // LLM 보강은 순위가 있을 때만 실행 쪽이 순위를 읽는다(없으면 옛 env — 실제 적용 설정으로 보인다)
  const live = aiTaskReadsRanks(def.id, (inputs.rows ?? []).some(row => row.task === def.id)) || def.id === "publish-classify" && poolConfigs.length > 0;
  // 장부 route — 작업의 route id, LLM 보강은 보강 일마다의 local-assist-<일>-<backend>
  const tracked = aiTaskLedgerTracked(def), owns = (routeId: string) => aiTaskOwnsLedgerRoute(def, routeId);
  const active: ActiveSeen[] | null = !tracked || inputs.active == null ? null : inputs.active
    .filter(row => owns(row.routeId)).map(row => {
      const place = placeOf(row, inputs);
      return { text: `${place} · ${row.model}`, model: row.model, where: place, count: row.count, rank: null,
        lastAt: row.lastAt, state: row.state };
    });
  if (poolConfigs.length) {
    const members = poolConfigs.flatMap(config => config.members.map(member => {
      const connection = inputs.connections?.find(row => row.id === member.connectionId);
      return { memberId: member.memberId, slot: config.slot, configRevision: config.revision, connectionId: member.connectionId,
        connection: connection?.label ?? "연결 없음", model: member.model, deviceId: member.deviceId,
        problem: !connection ? "연결을 찾을 수 없음" : !connection.enabled ? "연결이 꺼져 있음" : null };
    }));
    const modelCount = new Set(members.map(member => member.model)).size, deviceCount = new Set(members.map(member => member.deviceId)).size;
    const pool: TaskLlmPool = { members, modelCount, deviceCount,
      summary: `작업 분산 · 모델 ${modelCount}개 · 장비 ${deviceCount}대`, runtime: fresh?.pool ? { ...fresh.pool, at: fresh.at } : null };
    const usedWhy = !tracked ? "no_ledger" as const : inputs.used === null ? "unread" as const : null;
    // Ledger use is route-wide historical evidence, not proof that this pool/member supplied a particular call.
    const used: UsedSeen[] | null = usedWhy ? null : (inputs.used ?? []).filter(row => owns(row.routeId))
      .sort((a, b) => b.count - a.count).map(row => { const place = placeOf(row, inputs);
        return { text: `${place} · ${row.model}`, model: row.model, where: place, count: row.count, rank: null, lastAt: row.lastAt }; });
    const top = used?.[0];
    // Only an explicit whole-pool failure, after currentRuntime's identity/time guards, stops the task.
    // Individual member_unusable counters never imply that every member is unavailable.
    const unavailable = fresh?.pool && fresh.degraded?.code === "all_ranks_unusable" ? fresh.degraded : null;
    return { task: def.id, label: def.label, live, slots: [], pool, used, active, usedWhy,
      state: unavailable ? "stuck" : used?.length === 0 ? "idle" : "set_only",
      head: top ? { model: top.model, where: top.where, rank: null, source: "used", count: top.count }
        : { model: `모델 ${pool.modelCount}개 · 작업 분산`, where: `장비 ${pool.deviceCount}대`, rank: null, source: "set", count: null },
      note: unavailable ? `현재 작업 분산 구성의 최근 틱에서 모든 구성원을 사용할 수 없었습니다${unavailable.detail ? ` — ${unavailable.detail}` : ""}`
        : used === null ? "작업 분산 설정입니다. 최근 실제 사용은 장부에서 확인하지 못했습니다."
        : "작업 분산 설정입니다. 최근 1시간 장부는 설정 변경 전 호출도 포함하며 구성원별 실행을 확정하지 않습니다." };
  }
  const slots = slotsOf(def, inputs, fresh);
  const configured = slots.flatMap((slot) => slot.ranks);
  const base = { task: def.id, label: def.label, live, slots, active };

  const usedWhy = !tracked ? "no_ledger" as const : inputs.used === null ? "unread" as const : null;
  const usedRows = usedWhy ? null : (inputs.used ?? []).filter((row) => owns(row.routeId)).sort((a, b) => b.count - a.count);
  const used: UsedSeen[] | null = usedRows && usedRows.map((row) => {
    const rank = inputs.rows ? matchRank(slots, inputs.rows, def.id, row) : null;
    const place = rank ? where(rank) : placeOf(row, inputs);
    return { text: `${place} · ${row.model}`, model: rank?.model ?? row.model, where: place, count: row.count, rank: rank?.rank ?? null, lastAt: row.lastAt };
  });

  // Fallback publication is owned by connect-agent, not ai_task_models. Empty API ranks are not a missing CLI model.
  if (def.id === "publish-classify") {
    const legacy = inputs.legacyPublish ?? { source: "기존 connect CLI 설정", observedAt: null, ready: null, models: [] };
    const first = legacy.models[0];
    return { ...base, legacy, state: "set_only", used, usedWhy,
      head: first ? { model: first.model, where: first.where, rank: first.rank, source: "set", count: null } : null,
      note: legacy.observedAt ? "기존 CLI 분류 설정입니다. API 분산 모델과 별도이며 현재 호출은 장부에서 확인합니다."
        : "기존 CLI 분류를 사용하지만 현재 연결 에이전트 설정은 미확인입니다. API 순위가 비었다는 이유로 모델 미설정으로 판단하지 않습니다." };
  }

  // 실행 쪽이 순위를 읽지 않는 작업 — 저장된 순위가 아니라 실제 적용 설정만 보인다.
  if (!live) {
    const effective = inputs.effective?.[def.id] ?? null;
    const plainUsed = usedWhy ? null : (inputs.used ?? []).filter(row => owns(row.routeId)).sort((a, b) => b.count - a.count)
      .map(row => { const place = placeOf(row, inputs);
        return { text: `${place} · ${row.model}`, model: row.model, where: place, count: row.count, rank: null, lastAt: row.lastAt }; });
    const firstUsed = plainUsed?.[0] ?? null;
    const first = effective?.models[0] ?? null;
    const notes = effective
      ? [effective.error ? `실제 적용 설정 오류: ${effective.error}` : null, effective.skip, ...effective.notes,
        effective.source ? `출처: ${effective.source}` : null].filter((text): text is string => !!text)
      : ["실제 적용 설정을 읽지 못했습니다 — 저장된 순위는 실행에 쓰이지 않습니다."];
    return { ...base, slots: [], ...(effective ? { effective } : {}), used: plainUsed, usedWhy, state: "set_only",
      head: first ? { model: first.model, where: first.where, rank: null, source: "set", count: null }
        : !effective && firstUsed ? { model: firstUsed.model, where: firstUsed.where, rank: null, source: "used", count: firstUsed.count } : null,
      note: notes.length ? notes.join(" · ") : null };
  }

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
    if (head.state === "stuck") return { tone: "bad", text: head.pool ? "최근 틱 · 분산 구성원 전체 사용 불가" : "쓸 수 있는 순위 없음 — 멈춤" };
    if (head.state === "fallback") return { tone: "warn", text: `${head.head?.rank ?? 2}순위로 넘어감` };
    if (head.state === "other") return { tone: "warn", text: "순위에 없는 모델" };
    return null;
  };
  return { kind: "llm", tasks, head, more: distinct.size + stoppedOthers, flag: flagFor(), stopped, liveCount: live.length, sameModel: false, warnings: [] };
}

/** 칸마다 지금 쓰는 모델 — 읽지 못한 입력은 그 칸을 「확인 못함」으로 둔다(0 이나 정상으로 보이지 않게) */
export function buildStationLlm(inputs: LlmInputs): Record<LlmStationKey | "sink" | "support", StationLlm> {
  const out = {} as Record<LlmStationKey | "sink" | "support", StationLlm>;
  const unreadable = inputs.rows === null || inputs.connections === null || inputs.execution === null;
  const summarize = (ids: readonly string[]): StationLlm => {
    if (unreadable) return { kind: "unknown", why: inputs.execution === null
      ? "작업 ↔ AI 모델의 실행 모드를 읽지 못했습니다" : "작업 ↔ AI 모델 순위를 읽지 못했습니다" };
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

  return out;
}

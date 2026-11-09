import { AI_TASKS, aiTask, aiTaskAccepts, aiTaskSlotLabel, isAiLiveTask } from "@/lib/llm/ai-tasks";
import { aiTaskEditTarget } from "./ai-task-edit-target";
import {
  AI_RANK_SLOT_NAMES, aiRankChoiceOfRow, aiConnectionLabel, aiConnectionModelIds, aiModelsErrorText, aiRankOptionBlocked, aiSameUnderlyingModel, aiTaskRankOptions, validateAiTaskRanks,
  type AiConnectionView, type AiRankChoice, type AiRankOption, type AiTaskRankRow,
} from "./admin-ai-tasks";
import { isLocalModelHost } from "./admin-models-view";
import { STATION_TASKS, type LlmStationKey } from "./conveyor-llm";
import type { AiTaskExecutionAdminView } from "./admin-ai-task-execution";

/**
 * 전체 흐름에서 칸의 처리 LLM 을 그 자리에서 바꾸기(2026-11-04 5차) — 순수 함수만(DB·서버 동작 없음).
 *
 * 저장은 새 길을 만들지 않는다: 서랍이 「작업 ↔ AI 모델」(/admin/models/tasks)의 줄 저장과 같은 서버 동작(saveAiTaskRanksAction)에
 * 같은 폼 칸(task·slot·revision·rank<N>Connection·rank<N>Model)을 보낸다. 선택 상자도 같은 RankSelects 라 값 열쇠가 같다
 * (provider\u0000model 의 NUL 이 브라우저에서 U+FFFD 로 바뀌어 순위가 지워진 2026-11-02 사고 — rankOptionKey 는 encodeURIComponent 방식).
 * 이 파일은 서랍이 보일 것(작업 줄·선택지·연결 상태)과 저장 전에 보일 것(전→후·경고)만 계산한다.
 */

// ── 서랍의 줄 ───────────────────────────────────────────────────────────────────────────────────

/** 연결의 최근 상태 — 선택지 묶음 이름과 서랍 아래 연결 표에 쓴다 */
export type FlowConnectionState = { id: string; label: string; device: string; state: "ok" | "no_key" | "off" | "no_list" | "cli"; text: string };

export function flowConnectionState(connection: AiConnectionView): FlowConnectionState {
  const base = { id: connection.id, label: aiConnectionLabel(connection), device: connection.deviceId };
  if (!connection.enabled) return { ...base, state: "off", text: "꺼짐" };
  if (connection.kind === "cli") return { ...base, state: "cli", text: connection.cliVersion ? `CLI ${connection.cliVersion.trim().split(/\s+/)[0]}` : "CLI" };
  if (!connection.models || connection.models.length === 0)
    return { ...base, state: "no_list", text: `모델 목록 미확인 — ${aiModelsErrorText(connection.modelsError) ?? (connection.models === null ? "아직 못 읽음" : "모델 0개")}` };
  // 로컬 직접 연결은 키 없이도 목록을 확인할 수 있다. 목록 확인은 실제 호출 준비 완료와 구분한다.
  if (!connection.hasKey && isLocalModelHost(connection.baseUrl)) return { ...base, state: "ok", text: "모델 목록 확인 · 키 없음" };
  if (!connection.hasKey) return { ...base, state: "no_key", text: "키 없음" };
  return { ...base, state: "ok", text: "모델 목록 확인" };
}

/** 선택지 한 칸 — 묶음(group) = 「연결 · 장비 · 상태」, off = 꺼진 연결(보이되 고를 수 없다) */
export type FlowRankOption = AiRankOption & { off?: boolean };

export type FlowRankLine = {
  /** `${task}#${slot}` — 감사 target 과 같은 모양. station 은 흐름 칸(벨트 밖 작업은 "off_belt" — 작업 배정 화면에서만 쓴다) */
  key: string; station: LlmStationKey | "off_belt"; task: string; slot: number; label: string;
  /** 「작업 ↔ AI 모델」 줄의 판(compare-and-set) — 서버가 aiTaskSlotRevision 으로 만든다 */
  revision: string;
  saved: AiRankChoice[]; options: FlowRankOption[];
  /** 실행 쪽이 이 순위를 읽는가 — 아니면 「설정값」(바꿔도 지금 동작은 그대로) */
  live: boolean;
  /** 화면에서 바꿀 수 없는 까닭(선택 상자를 막는다) */
  lock: string | null;
  /** Safe stored mode/member settings; never contains decrypted connection credentials. */
  execution?: AiTaskExecutionAdminView;
  /** 저장된 순위에 아직 없는 계약·경로·장비 — 순위를 바꾸지 않고 다시 저장하면 만든다(작업 배정 화면이 채운다, aiRankPendingText) */
  pending?: readonly string[];
  /** 저장된 순위의 막힘(bad)·알림(warn) — 작업 배정 화면이 채운다(aiRanksReadiness) */
  notes?: readonly { tone: "bad" | "warn"; text: string }[];
};

export type FlowRankEditor = {
  lines: FlowRankLine[];
  connections: AiConnectionView[];
  /** 모든 작업의 저장된 순위 — 검증(다른 칸·다른 작업과의 규칙)에 쓴다 */
  rows: AiTaskRankRow[];
  states: FlowConnectionState[];
};

/**
 * 화면에서 바꿀 수 없는 작업 — 까닭을 보이고 선택 상자를 막는다.
 * 소개 검수: Claude CLI 전용 코드(intro-check-model-capacity.ts capturedClaudeCliRun)이고 호출 계약이 reviewer 앱 env(CLI_SERVING_CONTRACTS)에 있다.
 * 순위 행은 표시만(wiring deferred)이라 바꿔도 실행이 따르지 않고, 모델만 바꾸면 계약이 없어(no_contract) 소개 검수가 멈출 수 있다(2026-11-03 확인).
 */
export const FLOW_RANK_LOCKS: Readonly<Record<string, string>> = Object.freeze({
  "product-intro-check": "화면에서 바꿀 수 없습니다 — 소개 검수는 Claude CLI 전용 코드이고 호출 계약이 reviewer 앱 env(CLI_SERVING_CONTRACTS)에 있습니다. 모델을 바꾸려면 reviewer env 변경과 재배포가 필요합니다.",
});

/** 「설정값」 작업(실행 쪽이 이 순위를 읽지 않는다)의 안내 */
export const SET_ONLY_TEXT = "설정값 — 실행 쪽이 아직 이 순위를 읽지 않습니다. 저장해도 지금 동작은 그대로입니다.";

/** 칸 → 서랍의 줄. LLM 을 쓰지 않는 칸(탐색·원본 수집·규칙 심사·공개)은 빈 목록이다 — 바꾸기를 두지 않는다 */
export function flowRankLinesFor(editor: FlowRankEditor | null, station: LlmStationKey | "sink"): FlowRankLine[] {
  if (!editor || station === "sink") return [];
  return editor.lines.filter((line) => line.station === station);
}

/**
 * 서랍의 줄을 만든다(서버가 읽은 연결·순위로). revisionOf 는 「작업 ↔ AI 모델」 줄 판(aiTaskSlotRevision — 서버의 sha256)이다.
 * 선택지는 그 화면과 같은 aiTaskRankOptions(켜진 연결 · 이 작업이 받는 연결 · 실제로 내놓는 모델 · 저장된 값)에 꺼진 연결을 「고를 수 없음」으로 더한 것이다.
 */
export function buildFlowRankEditor(connections: readonly AiConnectionView[], rows: readonly AiTaskRankRow[],
  revisionOf: (rows: readonly AiTaskRankRow[]) => string, executions: readonly AiTaskExecutionAdminView[] = []): FlowRankEditor {
  const entries = (Object.entries(STATION_TASKS) as [LlmStationKey, readonly string[]][]).flatMap(([station, tasks]) => tasks.map(id => [station, id] as const));
  return buildRankEditor(entries, connections, rows, revisionOf, executions);
}

/**
 * 작업 배정(/admin/models/tasks)의 서랍 — 흐름 칸에 없는 작업(검색어 번역·감사·보강·Grok 로그인 유지)까지 모든 AI 작업을 작업 목록 순서로.
 * 줄·선택지·잠금·저장 폼은 buildFlowRankEditor 와 같다(같은 서랍, 같은 저장 동작). 칸에 없는 작업의 station 은 "off_belt" 라 흐름 칸 고르기에는 걸리지 않는다.
 */
export function buildTaskRankEditor(connections: readonly AiConnectionView[], rows: readonly AiTaskRankRow[],
  revisionOf: (rows: readonly AiTaskRankRow[]) => string, executions: readonly AiTaskExecutionAdminView[] = []): FlowRankEditor {
  const stationOf = new Map<string, LlmStationKey>();
  for (const [station, tasks] of Object.entries(STATION_TASKS) as [LlmStationKey, readonly string[]][]) for (const id of tasks) if (!stationOf.has(id)) stationOf.set(id, station);
  return buildRankEditor(AI_TASKS.map(task => [stationOf.get(task.id) ?? "off_belt", task.id] as const), connections, rows, revisionOf, executions);
}

function buildRankEditor(entries: readonly (readonly [LlmStationKey | "off_belt", string])[], connections: readonly AiConnectionView[], rows: readonly AiTaskRankRow[],
  revisionOf: (rows: readonly AiTaskRankRow[]) => string, executions: readonly AiTaskExecutionAdminView[]): FlowRankEditor {
  const states = connections.map(flowConnectionState);
  const stateOf = new Map(states.map((state) => [state.id, state]));
  const group = (id: string, fallback: string) => {
    const state = stateOf.get(id);
    // 연결 이름만 — 장비 id(정책 groupId)는 보이는 이름으로 쓰지 않는다(2026-11-09). 같은 장비를 쓰는 연결은 「연결 상태」 표의 장비 칸이 보인다
    return state ? `${state.label} · ${state.text}` : fallback;
  };
  const lines: FlowRankLine[] = [];
  for (const [station, id] of entries) {
    const task = aiTask(id);
    if (!task) continue;
    for (let slot = 1; slot <= task.slots; slot += 1) {
      const execution = executions.find(view => view.task === id && view.slot === slot);
      const own = rows.filter((row) => row.task === id && row.slot === slot).sort((a, b) => a.rank - b.rank);
      const options: FlowRankOption[] = aiTaskRankOptions(task, connections, own).map((option) => ({ ...option, group: group(option.provider, option.group ?? "지워진 연결") }));
      // 꺼진 연결도 보인다(상태 「꺼짐」) — 고를 수는 없다(저장 검증도 막는다)
      for (const connection of connections) {
        if (connection.enabled || !aiTaskAccepts(task, connection)) continue;
        for (const model of aiConnectionModelIds(connection)) {
          if (options.some((option) => option.provider === connection.id && option.model === model)) continue;
          options.push({ provider: connection.id, model, label: `${aiConnectionLabel(connection)} · ${model}`, group: group(connection.id, connection.label), text: model, off: true });
        }
      }
      const editTarget = id === "publish-classify" ? null : aiTaskEditTarget(id);
      lines.push({ key: `${id}#${slot}`, station, task: id, slot, label: aiTaskSlotLabel(task, slot), revision: revisionOf(own),
        saved: own.map(aiRankChoiceOfRow), options, live: isAiLiveTask(id), ...(execution ? { execution } : {}),
        lock: execution?.mode === "workload_pool" ? "작업 분산 중입니다. 분산 모델과 실행 방식은 「작업 배정」의 실행 방식에서 변경하세요."
          : FLOW_RANK_LOCKS[id] ? `${FLOW_RANK_LOCKS[id]}${editTarget ? ` 실제 적용 설정: ${editTarget.href}` : ""}`
            : editTarget ? `실제 적용 설정에서 변경하세요: ${editTarget.href}` : null });
    }
  }
  return { lines, connections: [...connections], rows: [...rows], states };
}

/** 이 선택지를 이 칸에서 고를 수 없는가 — 「작업 ↔ AI 모델」과 같은 규칙(aiRankOptionBlocked) + 꺼진 연결 */
export function flowOptionBlocked(editor: FlowRankEditor, line: FlowRankLine, index: number, option: AiRankChoice, slots: readonly (AiRankChoice | null)[]): boolean {
  const task = aiTask(line.task);
  if (!task) return true;
  if (line.options.some((entry) => entry.off && entry.provider === option.provider && entry.model === option.model)) return true;
  return aiRankOptionBlocked(task, line.slot, index, option, slots, editor.rows);
}

/** 저장을 막는 문제 — 서버와 같은 검증(validateAiTaskRanks) */
export function flowRankIssues(editor: FlowRankEditor, line: FlowRankLine, ranks: readonly (AiRankChoice | null)[]): string[] {
  return validateAiTaskRanks(line.task, line.slot, ranks, { connections: editor.connections, rows: editor.rows });
}

// ── 바뀌는 것 ───────────────────────────────────────────────────────────────────────────────────

export type RankDrafts = Readonly<Record<string, readonly (AiRankChoice | null)[]>>;

const trim = (ranks: readonly (AiRankChoice | null)[]) => {
  const out = [...ranks];
  while (out.length && !out.at(-1)) out.pop();
  return out;
};
const same = (a: readonly (AiRankChoice | null)[], b: readonly (AiRankChoice | null)[]) => {
  const x = trim(a), y = trim(b);
  return x.length === y.length && x.every((row, index) => (!row && !y[index]) || (!!row && !!y[index] && row.provider === y[index]!.provider && row.model === y[index]!.model && (row.reasoningEffort ?? "") === (y[index]!.reasoningEffort ?? "")));
};

/** 사람에게 보이는 순위 사슬 — 「1순위 gpu3090-qwen · qwen3.8-flash-next → 2순위 …」, 비면 「비어 있음」 */
export function rankChainText(editor: FlowRankEditor | null, ranks: readonly (AiRankChoice | null)[]): string {
  const parts = ranks.map((row, index) => {
    if (!row) return null;
    const connection = editor?.connections.find((entry) => entry.id === row.provider);
    return `${index + 1}순위 ${connection ? aiConnectionLabel(connection) : "지워진 연결"} · ${row.model}${row.reasoningEffort ? ` · 추론 ${row.reasoningEffort}` : ""}`;
  }).filter((part): part is string => !!part);
  return parts.length ? parts.join(" → ") : "비어 있음";
}

/** resave = 순위는 그대로 두고 다시 저장(빠진 계약·경로·장비를 만든다 — 예전 순위판의 「다시 저장」) */
export type RankChange = { line: FlowRankLine; before: AiRankChoice[]; after: (AiRankChoice | null)[]; beforeText: string; afterText: string; resave?: true };

/** 저장 전 「전 → 후」 — 바뀐 줄만, 서랍의 줄 차례대로 */
export function rankChanges(editor: FlowRankEditor, lines: readonly FlowRankLine[], drafts: RankDrafts): RankChange[] {
  return lines.flatMap((line) => {
    const draft = drafts[line.key];
    if (!draft || line.lock || same(draft, line.saved)) return [];
    const after = trim(draft);
    return [{ line, before: line.saved, after, beforeText: rankChainText(editor, line.saved), afterText: rankChainText(editor, after) }];
  });
}

/**
 * 바꾸지 않은 줄을 그대로 다시 저장 — 가져온 순위처럼 계약·경로·장비가 아직 없는 줄(pending)만, 사람이 고른 줄(keys)만.
 * 같은 저장 동작(saveAiTaskRanksAction)에 지금 순위를 그대로 보낸다. 이미 바꾼 줄(drafts 가 다름)은 rankChanges 가 맡는다.
 */
export function rankResaves(editor: FlowRankEditor, lines: readonly FlowRankLine[], drafts: RankDrafts, keys: ReadonlySet<string>): RankChange[] {
  return lines.flatMap((line) => {
    if (!keys.has(line.key) || line.lock || !line.pending?.length || !line.saved.length) return [];
    if (drafts[line.key] && !same(drafts[line.key], line.saved)) return [];
    const text = rankChainText(editor, line.saved);
    return [{ line, before: line.saved, after: [...line.saved], beforeText: text, afterText: text, resave: true as const }];
  });
}

// ── 장비 한도 미리보기 ────────────────────────────────────────────────────────────────────────────

/** 장비 한도(장부 관측) — 서랍을 여는 화면이 넘긴다. 못 읽었으면 넘기지 않는다(그때는 연결 폼 칸 수만 보인다). */
export type RankDeviceLimit = Readonly<{ deviceId: string; limit: number | null; held: number | null; source: "table" | "policy_fallback" | null }>;
export type RankDeviceImpact = Readonly<{
  deviceId: string; connections: string[];
  /** 장비 행 한도(모르면 null)와 지금 점유 */
  limit: number | null; held: number | null;
  /** 장비 행이 없어 저장이 만들 때의 칸 수(연결 폼 값) — 장비 행이 있으면 null */
  create: number | null;
  /** 저장 뒤 이 장비를 함께 쓰는 다른 작업(바꾼 줄 밖) */
  sharing: string[];
}>;

/**
 * 저장 뒤 순위가 가리키는 장비마다: 한도·점유, 장비 행이 없으면 만들 칸 수, 같은 장비를 나눠 쓰는 다른 작업.
 * devices 가 null 이면 한도를 모른다(흐름 화면 — 그때는 「LLM 운영에서 확인」).
 */
export function rankDeviceImpact(editor: FlowRankEditor, changes: readonly RankChange[], devices: readonly RankDeviceLimit[] | null): RankDeviceImpact[] {
  const changed = new Set(changes.map((change) => change.line.key));
  const out = new Map<string, { deviceId: string; connections: Set<string>; create: number | null }>();
  for (const change of changes) for (const row of change.after) {
    const connection = row ? editor.connections.find((entry) => entry.id === row.provider) : undefined;
    if (!connection) continue;
    const entry = out.get(connection.deviceId) ?? { deviceId: connection.deviceId, connections: new Set<string>(), create: null };
    entry.connections.add(aiConnectionLabel(connection));
    entry.create ??= connection.capacitySlots;
    out.set(connection.deviceId, entry);
  }
  return [...out.values()].map((entry) => {
    const device = devices?.find((row) => row.deviceId === entry.deviceId) ?? null;
    const sharing = new Set<string>();
    for (const line of editor.lines) {
      if (changed.has(line.key)) continue;
      const uses = [...line.saved, ...(line.execution?.mode === "workload_pool" ? line.execution.members.map((member) => ({ provider: member.connectionId })) : [])];
      if (uses.some((row) => editor.connections.find((connection) => connection.id === row.provider)?.deviceId === entry.deviceId)) sharing.add(line.label);
    }
    return { deviceId: entry.deviceId, connections: [...entry.connections], limit: device?.limit ?? null, held: device?.held ?? null,
      create: devices && device?.source !== "table" ? entry.create : null, sharing: [...sharing] };
  });
}

// ── 경고 ────────────────────────────────────────────────────────────────────────────────────────

export type RankWarning = {
  code: "first_cleared" | "set_only_cleared" | "voter_reopen";
  /** bad = 저장하면 일이 멈추거나 보류로 빠진다(확인 칸을 눌러야 저장) · warn = 영향 안내 */
  tone: "bad" | "warn";
  /** 경고가 붙는 줄 */
  line: string;
  /** 바꾸기 전부터 그런 상태였다(지금 상태 경고) — 바꾼 것 때문이 아니다 */
  existing: boolean;
  text: string;
};

const rank1 = (ranks: readonly (AiRankChoice | null)[] | undefined) => ranks?.[0] ?? null;

/**
 * 바꾼 뒤(drafts — 안 바꾼 줄은 저장된 값)를 보고 위험을 알린다.
 * 1차·2차는 같은 모델을 쓸 수 있으며, 2차 결과는 별도 호출로 받아야 한다.
 * - 1순위를 비움 — 실행 쪽이 순위를 읽는 작업은 no_task_models 로 멈춘다(2026-11-02 21:13Z 드롭다운 저장으로 1차 순위가 지워져 1차 0건).
 * - 2차 투표자에서 모델을 뺌 — 옛 투표자의 열린 표가 model_removed 로 닫히고 새 투표자가 같은 대상을 다시 심사한다(2026-11-03 829행 닫힘·약 790건 재심사).
 * secondWaiting 은 지금 2차 대기(열린 표) — 다시 볼 양을 어림하게 같이 적는다.
 */
export function rankWarnings(editor: FlowRankEditor, lines: readonly FlowRankLine[], drafts: RankDrafts, context: { secondWaiting: number | null } = { secondWaiting: null }): RankWarning[] {
  const warnings: RankWarning[] = [];
  const all = editor.lines;
  const now = (key: string) => all.find((line) => line.key === key)?.saved ?? [];
  const after = (key: string) => drafts[key] ? trim(drafts[key]) : now(key);
  // ① 1순위를 비움 — 나란한 칸(2차 투표자 2·3)은 비어도 작업이 멈추지 않는다(투표자 1 이 표를 낸다). 첫 칸만 본다
  for (const line of lines) {
    if (line.lock || line.slot > 1) continue;
    const before = rank1(line.saved), afterRank = rank1(after(line.key));
    if (afterRank) continue;
    const existing = !before;
    if (line.live) warnings.push({ code: "first_cleared", tone: "bad", line: line.key, existing,
      text: existing ? `지금 ${line.label}의 1순위가 비어 있어 이 작업이 멈춰 있습니다(no_task_models) — 1순위를 고르세요.`
        : `1순위를 비우면 ${line.label} 작업이 멈춥니다(no_task_models) — 2026-11-02 21:13Z 드롭다운 저장으로 1차 순위가 지워져 18분 동안 1차 처리 0건이었습니다.` });
    else if (!existing) warnings.push({ code: "set_only_cleared", tone: "warn", line: line.key, existing,
      text: `${line.label}의 순위를 비웁니다 — 실행 쪽은 아직 이 순위를 읽지 않아 지금 동작은 그대로지만, 순위를 읽게 되는 날 이 작업이 멈춥니다.` });
  }

  // ② 2차 투표자에서 모델을 뺌 — 옛 투표자의 열린 표가 닫히고 다시 심사
  for (const line of lines) {
    if (line.task !== "second-review" || !drafts[line.key]) continue;
    const keep = after(line.key).filter((row): row is AiRankChoice => !!row);
    const gone = line.saved.filter((row) => !keep.some((other) => aiSameUnderlyingModel(other.model, row.model)));
    if (!gone.length) continue;
    const waiting = context.secondWaiting !== null ? ` 지금 2차 대기 ${context.secondWaiting.toLocaleString("ko-KR")}표.` : "";
    warnings.push({ code: "voter_reopen", tone: "warn", line: line.key, existing: false,
      text: `${line.label}에서 ${gone.map((row) => row.model).join("·")}을(를) 빼면 그 모델의 열린 표가 model_removed 로 닫히고 새 투표자가 같은 대상을 다시 심사합니다`
        + ` — 2026-11-03 투표자를 바꿨을 때 829행이 닫히고 약 790건을 다시 봤습니다. 그동안 1차 승인분의 발행이 늦어집니다.${waiting} 되돌리기도 같은 재심사를 일으킵니다.` });
  }
  return warnings;
}

/** 저장 전 확인 칸이 필요한가 — bad 경고 중 바꾼 것 때문에 생기는 것이 있으면 */
export const needsAcknowledge = (warnings: readonly RankWarning[]) => warnings.some((warning) => warning.tone === "bad" && !warning.existing);

/**
 * 저장에 보낼 폼 — 예전 「작업 ↔ AI 모델」 줄 폼과 같은 칸: task · slot · revision · RankSelects 의 숨은 칸(AI_RANK_SLOT_NAMES).
 * 서버는 같은 aiTaskRanksInputFromForm 으로 읽는다. 값은 연결 id(uuid)와 모델 이름 그대로 — 제어 글자를 쓰지 않는다.
 */
export function rankForm(line: Pick<FlowRankLine, "task" | "slot" | "revision">, ranks: readonly (AiRankChoice | null)[]): FormData {
  const form = new FormData();
  form.set("task", line.task);
  form.set("slot", String(line.slot));
  form.set("revision", line.revision);
  ranks.forEach((row, index) => {
    if (!row || !AI_RANK_SLOT_NAMES[index]) return;
    form.set(AI_RANK_SLOT_NAMES[index].provider, row.provider);
    form.set(AI_RANK_SLOT_NAMES[index].model, row.model);
    form.set(AI_RANK_SLOT_NAMES[index].reasoningEffort, row.reasoningEffort ?? "");
  });
  return form;
}

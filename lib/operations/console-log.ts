import { humanBatchUndo } from "@/lib/crawl/human-batch-model";
import { CHANGE_WATCH_ACTIONS, collectChanges, isAutomaticActor, type WatchAuditRow } from "./change-watch";
import { CHANGE_UNDO, type DeskUndo } from "./operator-desk-model";

/**
 * 기록 화면(운영 콘솔 개편 조각 4b, 2026-11-12 최종 시안 「화면 6 기록」) — 작업 로그(operations_audit) 줄을 「바꾼 것 한 줄씩」으로 묶는 순수 함수.
 *
 * - 사람이 바꾼 설정·조치는 바꾼 것 지켜보기(조각 1c)의 합치기 규칙(change-watch.ts collectChanges)을 그대로 쓴다:
 *   접수 중단 → 다시 열림은 한 줄(걸린 분), 같은 사람의 연결 저장(30분)·한도 저장(10분)은 한 줄.
 * - 그 밖에도 같은 사람이 같은 대상에 같은 일을 30분 안에 잇달아 한 줄은 한 줄로 합친다(「3번」).
 * - 실패한 줄은 합치지 않고 따로 둔다. 자동 처리자(모델·잡·system:)의 줄과 읽기·시험·내보내기 줄은 이 화면에 줄로 그리지 않고 수만 센다 —
 *   원시 줄은 「모두 보기」(/admin/activity)에서 그대로 보인다. 작업 로그를 숨기거나 지우지 않는다(DB 가 고치기·지우기를 거부한다).
 * - 되돌리기는 이미 있는 곳에만 잇는다: 사람 확인 묶음은 일괄 결정 기록의 「묶음째 되돌리기」, 설정은 「최근 바뀐 설정」이 아는 그 설정 화면(CHANGE_UNDO).
 *   순위 저장은 이 저장 전·후 순위를 적어 두고 그 순위를 고치는 곳으로 보낸다. 여기서 새로 쓰지 않는다.
 */

export const CONSOLE_LOG_RULES = Object.freeze({
  /** 같은 사람·같은 일·같은 대상을 한 줄로 합치는 간격(분) */
  mergeMinutes: 30,
  /** 한 쪽에 읽는 작업 로그 줄 — 숨기는 줄(자동·읽기)이 많아도 한 쪽에 바꾼 것이 넉넉히 남게 */
  pageRows: 300,
});

/** 바꾼 것이 아닌 줄 — 읽기·연결 확인·시험·내보내기·운영 실행기의 진행 기록 */
export const LOG_QUIET_ACTIONS: readonly string[] = Object.freeze(["export", "ai-connection-models-read", "ai-probe", "ai-test", "admin-models-probe-start",
  "admin-models-probe-result", "selected-model-response-probe-start", "selected-model-response-probe-result", "ops-runner-state", "operator-name"]);

export type LogAuditRow = Readonly<{ id: number; createdAt: Date; actor: string; actorKind: string | null; action: string; target: string;
  detail: Record<string, unknown> | null; ok: boolean; error: string | null }>;

/** 순위 저장의 되돌리기 안내 — 지금(이 저장 뒤)과 되돌린 뒤(이 저장 전)의 1·2·3순위 */
export type RankUndo = { now: string; back: string };

export type LogLine = Readonly<{
  key: string;
  /** 이 줄에 든 작업 로그 id(오래된 것부터) */
  ids: readonly number[];
  /** 첫 줄의 때 */
  at: string;
  /** 접수 중단 → 다시 열림의 열린 때 */
  until: string | null;
  actor: string;
  action: string;
  target: string;
  title: string;
  /** 합친 줄 수(1이면 한 번) */
  count: number;
  ok: boolean;
  error: string | null;
  undo: DeskUndo | null;
  rankUndo: RankUndo | null;
}>;

export type LogLines = { lines: LogLine[]; hidden: { automatic: number; quiet: number }; oldestId: number | null };

const MINUTE = 60_000;

type RankRow = { rank: number; connectionId: string; model: string };
const rankRows = (value: unknown): RankRow[] => Array.isArray(value)
  ? value.filter((row): row is RankRow => !!row && typeof row === "object" && typeof (row as RankRow).rank === "number"
    && typeof (row as RankRow).connectionId === "string" && typeof (row as RankRow).model === "string").sort((a, b) => a.rank - b.rank) : [];
const chain = (rows: readonly RankRow[], labels: ReadonlyMap<string, string>) =>
  rows.length ? rows.map(row => labels.get(row.connectionId) ?? row.model).join(" → ") : "순위 없음";

/** 대상 표기(작업 로그 화면 labels.targetLabel 과 같은 것을 부르는 쪽이 넘긴다 — 이 모듈은 화면 모듈을 가져오지 않는다) */
export type LogLabels = { action: (action: string) => string; target: (target: string) => string; connectionLabels: ReadonlyMap<string, string> };

function undoOf(action: string, target: string): DeskUndo | null {
  return CHANGE_UNDO[action]?.(target) ?? humanBatchUndo(action, target) ?? null;
}

/** 작업 로그 줄(아무 차례) → 기록 화면의 줄(최근 것부터) */
export function buildLogLines(rows: readonly LogAuditRow[], labels: LogLabels): LogLines {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const hidden = { automatic: 0, quiet: 0 };
  type Draft = { -readonly [K in keyof LogLine]: LogLine[K] } & { ids: number[]; lastAt: number };
  const out: Draft[] = [];
  const watchRows: WatchAuditRow[] = [];
  const iso = (row: LogAuditRow) => row.createdAt.toISOString();

  for (const row of sorted) {
    if (isAutomaticActor(row.actor, row.actorKind)) { hidden.automatic += 1; continue; }
    if (LOG_QUIET_ACTIONS.includes(row.action)) { hidden.quiet += 1; continue; }
    if (!row.ok) {
      // 실패는 합치지 않는다 — 무엇이 거절됐는지 한 줄씩
      out.push({ key: `f${row.id}`, ids: [row.id], at: iso(row), lastAt: row.createdAt.getTime(), until: null, actor: row.actor, action: row.action, target: row.target,
        title: `${labels.action(row.action)} · ${labels.target(row.target)}`, count: 1, ok: false, error: row.error, undo: null, rankUndo: null });
      continue;
    }
    if (CHANGE_WATCH_ACTIONS.includes(row.action)) { watchRows.push({ id: row.id, at: iso(row), actor: row.actor, actorKind: row.actorKind, action: row.action,
      target: row.target, detail: row.detail ?? {} }); continue; }
    const at = row.createdAt.getTime();
    const prior = [...out].reverse().find(line => line.actor === row.actor);
    if (prior && prior.ok && prior.action === row.action && prior.target === row.target && at - prior.lastAt <= CONSOLE_LOG_RULES.mergeMinutes * MINUTE
      && !CHANGE_WATCH_ACTIONS.includes(prior.action)) {
      prior.ids.push(row.id); prior.count += 1; prior.lastAt = at;
      continue;
    }
    const target = labels.target(row.target);
    out.push({ key: `a${row.id}`, ids: [row.id], at: iso(row), lastAt: at, until: null, actor: row.actor, action: row.action, target: row.target,
      title: target ? `${labels.action(row.action)} · ${target}` : labels.action(row.action), count: 1, ok: true, error: null, undo: undoOf(row.action, row.target), rankUndo: null });
  }

  // 설정·조치(지켜보기 대상) — 조각 1c 의 합치기 규칙 그대로. 그 뒤 같은 사람·같은 대상의 잇단 저장을 더 합친다(접수 전환은 그대로)
  const changes = collectChanges(watchRows, { connectionTasks: new Map(), connectionLabels: labels.connectionLabels }, labels.action);
  const byId = new Map(watchRows.map(row => [row.id, row]));
  const merged: Draft[] = [];
  for (const change of changes) {
    const at = Date.parse(change.at);
    const prior = merged.at(-1);
    const lastIds = change.ids;
    const first = byId.get(lastIds[0]);
    const last = byId.get(lastIds[lastIds.length - 1]);
    if (prior && change.kind !== "capacity" && prior.action === change.action && prior.actor === change.actor && prior.target === change.target
      && at - prior.lastAt <= CONSOLE_LOG_RULES.mergeMinutes * MINUTE) {
      prior.ids.push(...lastIds); prior.count += lastIds.length; prior.lastAt = Date.parse(last?.at ?? change.at);
      prior.rankUndo = rankUndoOf(change.action, byId.get(prior.ids[0])?.detail, last?.detail, labels.connectionLabels) ?? prior.rankUndo;
      continue;
    }
    // 지켜보기가 이름을 짓지 못한 변경(「작업 · 대상」)은 대상을 사람 말로(작업 로그 화면과 같은 이름표)
    const plain = `${labels.action(change.action)} · ${change.target}`;
    const title = change.title === plain ? `${labels.action(change.action)} · ${labels.target(change.target)}` : change.title;
    merged.push({ key: `c${change.key}`, ids: [...lastIds], at: change.at, lastAt: Date.parse(last?.at ?? change.at), until: change.until, actor: change.actor,
      action: change.action, target: change.target, title, count: change.kind === "capacity" ? 1 : lastIds.length, ok: true, error: null,
      undo: change.kind === "capacity" ? null : undoOf(change.action, change.target),
      rankUndo: rankUndoOf(change.action, first?.detail, last?.detail, labels.connectionLabels) });
  }

  const lines = [...out, ...merged].sort((a, b) => b.ids[0] - a.ids[0]).map(draft => {
    const line: Omit<Draft, "lastAt"> & { lastAt?: number } = { ...draft };
    delete line.lastAt;
    return line;
  });
  return { lines, hidden, oldestId: sorted.length ? sorted[0].id : null };
}

/** 순위 저장 — 첫 저장 전(되돌린 뒤)과 마지막 저장 뒤(지금). 순위가 없는 줄(정리 등)은 null */
function rankUndoOf(action: string, first: Readonly<Record<string, unknown>> | undefined, last: Readonly<Record<string, unknown>> | undefined,
  labels: ReadonlyMap<string, string>): RankUndo | null {
  if (action !== "ai-task-models-save" || !first || !last) return null;
  const before = rankRows(first.before), after = rankRows(last.after);
  if (!before.length && !after.length) return null;
  return { now: chain(after, labels), back: chain(before, labels) };
}

/** 원시 줄 보기 — 이 줄의 첫 id 바로 앞까지(그 줄부터 보인다). 대상이 제품·저장소면 대상으로 거른다 */
export function logRawHref(line: Pick<LogLine, "ids">): string {
  return `/admin/activity?before=${line.ids[line.ids.length - 1] + 1}`;
}

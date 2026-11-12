import type { ConsoleGroupKey, ConsoleTask, ConsoleTaskBoard } from "./console-tasks";

/**
 * 휴대폰 알림(운영 콘솔 개편 조각 4b, 2026-11-12 최종 시안 흐름 7 「자리에 없을 때」·「할 일이 생기는 조건」의 알림 열) — 순수 함수.
 *
 * 홈의 할 일 중 알림을 받는 묶음(멈춤 · 평소와 다름 — console-tasks.ts CONSOLE_GROUPS.notify)이 **새로 생겼을 때** 한 번 알린다.
 * - 알림 한 건 = 할 일 하나의 「한 번 생김」(console_alerts 한 줄, 마이그레이션 0183). 같은 할 일이 이어지는 동안은 그 줄을 이어 쓰고 다시 보내지 않는다.
 *   할 일이 사라져 10분(closeAfterMissingMs) 넘게 돌아오지 않으면 그 줄을 닫는다 — 그 뒤 다시 생기면 새 줄(다시 알림). 문턱 근처에서 깜빡여도 되풀이하지 않는다.
 * - 「그대로 둔다」로 표시한 할 일(console-task-keep)은 할 일 목록에서 내려가므로 알리지 않고, 열린 줄은 바로 닫는다.
 * - 그 묶음의 읽기를 못 했으면(셀 수 없음) 그 묶음의 열린 줄을 닫지 않는다 — 못 읽은 것은 해소가 아니다.
 * - 알림을 끄면 열린 줄을 모두 닫는다(다시 켜면 그때 있는 할 일을 새로 알린다). 조용한 시간에는 새 줄을 내보내지 않고 기다렸다가, 끝났을 때도 그 할 일이 있으면 내보낸다.
 * - 「내보냄(released)」은 전달 통로에 넘겼다는 뜻이다 — 실제 전송은 감시(monitor) → 복구 게이트웨이 → Oracle watchdog 의 기존 Telegram 통로가 하고,
 *   Oracle 이 같은 줄을 한 번만 보낸다(incident_notifications.py, 줄 id 로). 이 모듈은 보내지 않는다.
 */

const MINUTE = 60_000;

export const CONSOLE_ALERT_RULES = Object.freeze({
  /** 할 일이 이만큼 이어서 보이지 않으면 해소로 보고 닫는다(잡 주기 5분 — 두 번 연속 없음) */
  closeAfterMissingMs: 10 * MINUTE,
  /**
   * 전달 통로로 한 번에 넘기는 줄 수와 글자 상한(감시 파일·게이트웨이·Oracle 검사와 같은 수). Oracle 이 SSH 로 받는 보고 전체가 32KB 를 넘지 않게
   * (JSON 이 한글을 \uXXXX 로 적어 글자당 6바이트) 8줄 × (제목 80 + 사실 160 + 주소 200)로 묶는다. 먼저 열린 줄부터 넘기고, 넘는 줄은 앞 줄이 닫히면 넘어간다.
   */
  maxRelay: 8,
  titleMax: 80,
  factMax: 160,
  hrefMax: 200,
  /** 닫힌 줄을 남겨 두는 날 수 */
  retentionDays: 30,
});

/** 감사 기록(작업 로그) 작업 이름 — 알림 설정 저장 한 번이 한 줄이다(새 표 없이, 마지막 줄이 지금 설정) */
export const CONSOLE_ALERT_SETTINGS_ACTION = "console-alert-settings";

export type ConsoleAlertSettings = Readonly<{
  enabled: boolean;
  /** 조용한 시간(KST, 「HH:MM」) — 둘 다 있고 서로 다를 때만. 시작이 끝보다 늦으면 자정을 넘는다(23:00~07:00) */
  quietStart: string | null;
  quietEnd: string | null;
}>;
/** 설정 기록이 없으면 꺼짐 — 운영자가 알림 화면에서 켠다(켜기 전에 전달 통로 설치를 확인하라는 안내가 거기 있다) */
export const CONSOLE_ALERT_DEFAULTS: ConsoleAlertSettings = Object.freeze({ enabled: false, quietStart: null, quietEnd: null });

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (clock: string | null): number | null => {
  const match = clock ? CLOCK.exec(clock) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/** 폼 값 → 설정. 시각은 둘 다 비우거나 둘 다 「HH:MM」(서로 달라야 함). 틀리면 null */
export function parseAlertSettings(input: { enabled?: unknown; quietStart?: unknown; quietEnd?: unknown }): ConsoleAlertSettings | null {
  const clock = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const start = clock(input.quietStart), end = clock(input.quietEnd);
  if (typeof input.enabled !== "boolean") return null;
  if (!start && !end) return { enabled: input.enabled, quietStart: null, quietEnd: null };
  if (!CLOCK.test(start) || !CLOCK.test(end) || start === end) return null;
  return { enabled: input.enabled, quietStart: start, quietEnd: end };
}

/** 작업 로그 한 줄의 detail → 설정(옛·틀린 값은 기본으로) */
export function alertSettingsFrom(detail: Readonly<Record<string, unknown>> | null | undefined): ConsoleAlertSettings {
  const after = detail && typeof detail.after === "object" && detail.after ? detail.after as Record<string, unknown> : null;
  return (after && parseAlertSettings(after)) ?? CONSOLE_ALERT_DEFAULTS;
}

/** KST 의 하루 안 분(0~1439) */
const kstMinute = (ms: number) => Math.floor(((ms + 9 * 3_600_000) % 86_400_000 + 86_400_000) % 86_400_000 / MINUTE);

/** 지금이 조용한 시간인가 — 끝나는 때(epoch ms)도 준다 */
export function quietHours(settings: ConsoleAlertSettings, nowMs: number): { quiet: boolean; endsAt: number | null } {
  const start = minutesOf(settings.quietStart), end = minutesOf(settings.quietEnd);
  if (start === null || end === null || start === end) return { quiet: false, endsAt: null };
  const minute = kstMinute(nowMs);
  const quiet = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!quiet) return { quiet: false, endsAt: null };
  const ahead = (end - minute + 1440) % 1440;
  const floor = nowMs - (nowMs % MINUTE);
  return { quiet: true, endsAt: floor + ahead * MINUTE };
}

/** 할 일 → 홈의 그 줄 앵커(ConsoleHome TaskRow 의 id) */
export const consoleTaskAnchor = (taskId: string) => `task-${taskId.replace(/[^A-Za-z0-9_-]+/g, "-")}`;

/**
 * 알림에서 누르면 가는 곳 — 그 할 일의 단계 패널(첫 링크가 /admin/flow?stage= 이면 그것), 아니면 홈의 그 줄.
 * 경로만 넘긴다: 사이트 주소는 받는 쪽(Oracle watchdog 설정 adminOrigin)이 붙인다 — 감시 쪽 보고가 다른 사이트 주소를 넣을 수 없게.
 */
export function consoleAlertHref(task: Pick<ConsoleTask, "id" | "actions">): string {
  const panel = task.actions.find(action => action.kind === "link" && action.href.startsWith("/admin/flow?stage="));
  return panel && panel.kind === "link" ? panel.href.split("#")[0] : `/admin/flow#${consoleTaskAnchor(task.id)}`;
}

/** 전달 통로가 받는 글자 — 제어 글자·방향 바꿈 글자를 빼고 상한까지 */
export function relayText(value: string, max: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return [...clean].length > max ? `${[...clean].slice(0, max - 1).join("")}…` : clean;
}

export type ConsoleAlertCandidate = Readonly<{ taskId: string; rule: string; group: ConsoleGroupKey; title: string; fact: string; href: string }>;

/** 알림 대상 — 알림 묶음의 할 일 중 notify 가 켜진 것(접수 중단으로 접은 30분 전 줄은 꺼져 있다). 「그대로 둔」 할 일은 목록에 없다 */
export function consoleAlertCandidates(board: Pick<ConsoleTaskBoard, "groups">): ConsoleAlertCandidate[] {
  return board.groups.flatMap(group => group.tasks).filter(task => task.notify).map(task => ({
    taskId: task.id, rule: task.rule, group: task.group, title: relayText(task.title, CONSOLE_ALERT_RULES.titleMax),
    fact: relayText(task.fact, CONSOLE_ALERT_RULES.factMax), href: consoleAlertHref(task).slice(0, CONSOLE_ALERT_RULES.hrefMax) }));
}

/** 열린 알림 줄(console_alerts) */
export type ConsoleAlertRow = Readonly<{ id: number; taskId: string; group: ConsoleGroupKey; title: string; fact: string; href: string;
  openedAt: string; seenAt: string; missingSince: string | null; releasedAt: string | null }>;

export type ConsoleAlertPlan = {
  /** 새로 생긴 할 일 — release 면 바로 내보낸다(조용한 시간이 아니면) */
  open: { candidate: ConsoleAlertCandidate; release: boolean }[];
  /** 아직 있는 할 일 — 본 때를 새로 하고 글자를 고친다. release 면 이제 내보낸다(조용한 시간이 끝났다) */
  seen: { id: number; candidate: ConsoleAlertCandidate; release: boolean }[];
  /** 이번에 처음 안 보인 할 일 — 안 보이기 시작한 때를 적는다 */
  missing: number[];
  close: { id: number; reason: "resolved" | "kept" | "disabled" }[];
  /** 이번에 읽지 못해 그대로 두는 줄 수(셀 수 없음) */
  uncertain: number;
};

/**
 * 할 일 목록과 열린 알림 줄 → 할 것. 같은 할 일(열쇠)이 이어지면 같은 줄, 사라져 10분이 지나면 닫고, 다시 생기면 새 줄이다.
 */
export function planConsoleAlerts(input: { open: readonly ConsoleAlertRow[]; board: Pick<ConsoleTaskBoard, "groups" | "kept">; settings: ConsoleAlertSettings;
  nowMs: number }): ConsoleAlertPlan {
  const plan: ConsoleAlertPlan = { open: [], seen: [], missing: [], close: [], uncertain: 0 };
  if (!input.settings.enabled) {
    plan.close = input.open.map(row => ({ id: row.id, reason: "disabled" as const }));
    return plan;
  }
  const quiet = quietHours(input.settings, input.nowMs).quiet;
  const candidates = new Map(consoleAlertCandidates(input.board).map(candidate => [candidate.taskId, candidate]));
  const kept = new Set(input.board.kept.map(row => row.task.id));
  // 그 묶음에서 못 읽은 규칙이 있으면 사라진 줄도 해소로 보지 않는다
  const uncertain = new Set(input.board.groups.filter(group => group.unknown.length > 0).map(group => group.key));
  const known = new Set<string>();
  for (const row of input.open) {
    known.add(row.taskId);
    const candidate = candidates.get(row.taskId);
    if (candidate) { plan.seen.push({ id: row.id, candidate, release: !row.releasedAt && !quiet }); continue; }
    if (kept.has(row.taskId)) { plan.close.push({ id: row.id, reason: "kept" }); continue; }
    if (uncertain.has(row.group)) { plan.uncertain += 1; continue; }
    const since = row.missingSince ? Date.parse(row.missingSince) : NaN;
    if (!Number.isFinite(since)) plan.missing.push(row.id);
    else if (input.nowMs - since >= CONSOLE_ALERT_RULES.closeAfterMissingMs) plan.close.push({ id: row.id, reason: "resolved" });
  }
  for (const candidate of candidates.values()) if (!known.has(candidate.taskId)) plan.open.push({ candidate, release: !quiet });
  return plan;
}

/** 전달 통로로 넘기는 한 줄 — 감시가 파일에 쓰고 게이트웨이·Oracle 이 같은 모양을 검사한다 */
export type ConsoleAlertRelay = Readonly<{ id: number; title: string; fact: string; href: string }>;

/** DB 줄 → 넘기는 줄. 모양이 틀린 줄은 뺀다(통로 전체를 깨지 않게) */
export function consoleAlertRelay(rows: readonly { id: number | string; title: string; fact: string; href: string }[]): ConsoleAlertRelay[] {
  return rows.flatMap(row => {
    const id = Number(row.id);
    const title = relayText(row.title, CONSOLE_ALERT_RULES.titleMax), fact = relayText(row.fact, CONSOLE_ALERT_RULES.factMax);
    if (!Number.isSafeInteger(id) || id <= 0 || !title || !RELAY_HREF.test(row.href) || row.href.length > CONSOLE_ALERT_RULES.hrefMax) return [];
    return [{ id, title, fact, href: row.href }];
  }).slice(0, CONSOLE_ALERT_RULES.maxRelay);
}
/** 관리자 화면 경로만(사이트 주소 없이). 게이트웨이(recovery_gateway.py)·Oracle(oracle_watchdog.py)이 같은 식으로 다시 본다 */
export const RELAY_HREF = /^\/admin[A-Za-z0-9/?=&%#._:~+-]*$/;

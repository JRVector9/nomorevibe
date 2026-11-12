import { describe, expect, it } from "vitest";
import type { Conveyor, Station } from "@/lib/operations/conveyor-model";
import {
  alertSettingsFrom, CONSOLE_ALERT_DEFAULTS, CONSOLE_ALERT_RULES, consoleAlertCandidates, consoleAlertHref, consoleAlertRelay, consoleTaskAnchor,
  parseAlertSettings, planConsoleAlerts, quietHours, relayText, RELAY_HREF, type ConsoleAlertPlan, type ConsoleAlertRow, type ConsoleAlertSettings,
} from "@/lib/operations/console-alerts";
import { buildConsoleTasks, type ConsoleKept, type ConsoleTaskBoard, type ConsoleTaskInputs } from "@/lib/operations/console-tasks";
import { consoleFixtureInputs } from "./fixtures/console-home";

const MIN = 60_000;
const NOW = Date.parse("2026-11-12T00:00:00.000Z"); // 09:00 KST
const ON: ConsoleAlertSettings = { enabled: true, quietStart: null, quietEnd: null };

function station(key: Station["key"], patch: Partial<Station> = {}): Station {
  return { key, phase: "review", label: key, what: "", waiting: 0, oldestMinutes: null, done5m: 0, doneHour: 0, done24h: 0, unit: "건",
    spark: null, tone: "flow", status: "흐름", reason: null, holds: [], facts: [], links: [], llm: null, ...patch };
}
const human: NonNullable<Conveyor["human"]> = { waiting: 10, direct: 10, agreed: 0, awaitingSecond: 0, awaitingAi: 0, decided24h: 3, oldestDays: 4, in24h: 10,
  tone: "flow", status: "처리 중", reason: null, llm: null };
/** AI 1차가 멈췄는가(doneHour)만 바꾸는 홈 입력 */
function inputs(at: number, patch: { stalled?: boolean; kept?: ConsoleKept[]; conveyor?: null; admission?: ConsoleTaskInputs["admission"] } = {}): ConsoleTaskInputs {
  return { now: new Date(at).toISOString(),
    conveyor: patch.conveyor === null ? null : { stations: [station("first", { label: "AI 1차", waiting: 857, doneHour: patch.stalled === false ? 400 : 3 })], human, holdsByReason: [] },
    progress: { stages: [{ stage: "first", job: "crawl-agent-review", reason: "running", waiting: 857 }] }, jobs: [],
    admission: patch.admission ?? { mode: "open", since: new Date(at - 3_600_000).toISOString() },
    takedown: { count: 0, overdue: 0 }, agreed: { approve: 0, reject: 0 }, audit: { open: 0, overdue: 0, oldestWaitDays: null },
    connections: [], ranks: [], pools: [], devices: [], ledger: [], kept: patch.kept };
}

/** 알림 줄 표를 흉내 낸다 — 계획을 그대로 반영(잡이 하는 일) */
class AlertTable {
  rows: ({ -readonly [K in keyof ConsoleAlertRow]: ConsoleAlertRow[K] } & { closedAt: string | null; closeReason: string | null })[] = [];
  next = 1;
  open() { return this.rows.filter(row => !row.closedAt); }
  apply(plan: ConsoleAlertPlan, at: number) {
    const iso = new Date(at).toISOString();
    for (const { candidate, release } of plan.open) {
      if (this.open().some(row => row.taskId === candidate.taskId)) continue;
      this.rows.push({ id: this.next++, taskId: candidate.taskId, group: candidate.group, title: candidate.title, fact: candidate.fact, href: candidate.href,
        openedAt: iso, seenAt: iso, missingSince: null, releasedAt: release ? iso : null, closedAt: null, closeReason: null });
    }
    for (const { id, candidate, release } of plan.seen) {
      const row = this.rows.find(entry => entry.id === id)!;
      Object.assign(row, { seenAt: iso, missingSince: null, title: candidate.title, fact: candidate.fact, releasedAt: row.releasedAt ?? (release ? iso : null) });
    }
    for (const id of plan.missing) { const row = this.rows.find(entry => entry.id === id)!; row.missingSince ??= iso; }
    for (const { id, reason } of plan.close) Object.assign(this.rows.find(entry => entry.id === id)!, { closedAt: iso, closeReason: reason });
  }
  /** 전달 통로가 보는 줄(닫히지 않았고 내보냄) */
  relayed() { return this.open().filter(row => row.releasedAt).map(row => row.id); }
}

/** 잡 한 틱 — 할 일을 세고 계획을 세워 반영한다 */
function tick(table: AlertTable, at: number, settings: ConsoleAlertSettings, patch: Parameters<typeof inputs>[1] = {}) {
  const board = buildConsoleTasks(inputs(at, patch));
  const plan = planConsoleAlerts({ open: table.open(), board, settings, nowMs: at });
  table.apply(plan, at);
  return plan;
}

/** Oracle 이 줄 id 마다 한 번 보낸다 — 보낸 id 를 모은다(incident_notifications 와 같은 뜻) */
function deliveries(relayedPerTick: number[][]): number[] {
  const sent = new Set<number>(); const out: number[] = [];
  for (const ids of relayedPerTick) {
    for (const id of ids) if (!sent.has(id)) { sent.add(id); out.push(id); }
    for (const id of [...sent]) if (!ids.includes(id)) sent.delete(id);
  }
  return out;
}

describe("phone alerts — new once, again after it resolves, never for kept tasks (console 4b)", () => {
  it("alerts once when a stop task appears and not again while it continues", () => {
    const table = new AlertTable();
    const relayed: number[][] = [];
    for (let i = 0; i < 4; i += 1) { tick(table, NOW + i * 5 * MIN, ON); relayed.push(table.relayed()); }
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ taskId: "stop:stage:first", group: "stop", title: "AI 1차가 거의 멈췄습니다",
      fact: "대기 857건 · 최근 1시간 3건", href: "/admin/flow?stage=first", closedAt: null });
    expect(deliveries(relayed)).toEqual([1]);
  });

  it("closes only after the task stays away ten minutes, and alerts again when it comes back", () => {
    const table = new AlertTable();
    const relayed: number[][] = [];
    const at = (minutes: number) => NOW + minutes * MIN;
    tick(table, at(0), ON); relayed.push(table.relayed());
    // 5분 동안 사라졌다가 돌아옴 — 깜빡임: 같은 줄, 다시 보내지 않는다
    tick(table, at(5), ON, { stalled: false }); relayed.push(table.relayed());
    expect(table.rows[0].missingSince).not.toBeNull();
    tick(table, at(10), ON); relayed.push(table.relayed());
    expect(table.rows[0].missingSince).toBeNull();
    // 이번에는 10분 넘게 사라짐 — 닫힌다(해소)
    for (const minutes of [15, 20, 25]) { tick(table, at(minutes), ON, { stalled: false }); relayed.push(table.relayed()); }
    expect(table.rows[0]).toMatchObject({ closeReason: "resolved" });
    // 다시 생김 — 새 줄, 다시 알림
    tick(table, at(30), ON); relayed.push(table.relayed());
    expect(table.rows.map(row => [row.id, row.closeReason])).toEqual([[1, "resolved"], [2, null]]);
    expect(deliveries(relayed)).toEqual([1, 2]);
  });

  it("does not alert a task a person marked 「그대로 둔다」, and closes its open row at once", () => {
    // 사람이 멈춘 작업(job-paused)은 「사유 남기고 유지」를 받는 규칙이다
    const paused = (at: number, kept?: ConsoleKept[]) => ({ ...inputs(at, { stalled: false, kept }),
      jobs: [{ name: "product-intro-check", paused: true, lastRunAt: new Date(at - 8 * 86_400_000).toISOString(), controlVersion: 7 }] });
    const keep: ConsoleKept = { taskId: "stop:job:product-intro-check", at: new Date(NOW).toISOString(), until: new Date(NOW + 7 * 86_400_000).toISOString(),
      actor: "JR", reason: "번역 끝날 때까지", ref: "7" };
    const fresh = planConsoleAlerts({ open: [], board: buildConsoleTasks(paused(NOW, [keep])), settings: ON, nowMs: NOW });
    expect(fresh.open).toEqual([]);
    const table = new AlertTable();
    table.apply(planConsoleAlerts({ open: [], board: buildConsoleTasks(paused(NOW)), settings: ON, nowMs: NOW }), NOW);
    expect(table.rows[0]).toMatchObject({ taskId: "stop:job:product-intro-check", href: "/admin/flow#task-stop-job-product-intro-check" });
    const plan = planConsoleAlerts({ open: table.open(), board: buildConsoleTasks(paused(NOW + 5 * MIN, [keep])), settings: ON, nowMs: NOW + 5 * MIN });
    expect(plan.close).toEqual([{ id: 1, reason: "kept" }]);
  });

  it("never closes a row because the reads failed — unknown is not resolved", () => {
    const table = new AlertTable();
    tick(table, NOW, ON);
    for (const minutes of [5, 10, 15, 20]) {
      const plan = tick(table, NOW + minutes * MIN, ON, { conveyor: null });
      expect(plan.uncertain).toBe(1);
    }
    expect(table.rows[0]).toMatchObject({ closedAt: null, missingSince: null });
  });

  it("holds new alerts during quiet hours and releases them when quiet hours end, if the task is still there", () => {
    const quiet: ConsoleAlertSettings = { enabled: true, quietStart: "08:30", quietEnd: "09:20" };
    const table = new AlertTable();
    tick(table, NOW, quiet);
    expect(table.rows[0].releasedAt).toBeNull();
    expect(table.relayed()).toEqual([]);
    tick(table, NOW + 15 * MIN, quiet);
    expect(table.relayed()).toEqual([]);
    tick(table, NOW + 20 * MIN, quiet); // 09:20 KST — 끝
    expect(table.relayed()).toEqual([1]);
    // 이미 보낸 줄은 조용한 시간이 와도 그대로(다시 보내지 않는다)
    const later: ConsoleAlertSettings = { enabled: true, quietStart: "09:25", quietEnd: "10:00" };
    tick(table, NOW + 30 * MIN, later);
    expect(table.relayed()).toEqual([1]);
  });

  it("a task that comes and goes inside quiet hours is never sent", () => {
    const quiet: ConsoleAlertSettings = { enabled: true, quietStart: "08:00", quietEnd: "10:00" };
    const table = new AlertTable();
    tick(table, NOW, quiet);
    for (const minutes of [5, 10, 15]) tick(table, NOW + minutes * MIN, quiet, { stalled: false });
    expect(table.rows[0]).toMatchObject({ releasedAt: null, closeReason: "resolved" });
    tick(table, NOW + 65 * MIN, quiet, { stalled: false });
    expect(table.relayed()).toEqual([]);
  });

  it("turning alerts off closes every open row without reading tasks; turning on again alerts what is there", () => {
    const table = new AlertTable();
    tick(table, NOW, ON);
    const off = planConsoleAlerts({ open: table.open(), board: { groups: [], kept: [] }, settings: { ...ON, enabled: false }, nowMs: NOW + 5 * MIN });
    expect(off).toMatchObject({ open: [], seen: [], close: [{ id: 1, reason: "disabled" }] });
    table.apply(off, NOW + 5 * MIN);
    tick(table, NOW + 10 * MIN, ON);
    expect(table.relayed()).toEqual([2]);
  });

  it("does not alert the silent admission fold under thirty minutes, and does once it passes thirty", () => {
    const table = new AlertTable();
    tick(table, NOW, ON, { admission: { mode: "draining", since: new Date(NOW - 18 * MIN).toISOString() } });
    expect(table.rows).toEqual([]);
    tick(table, NOW + 15 * MIN, ON, { admission: { mode: "draining", since: new Date(NOW - 18 * MIN).toISOString() } });
    expect(table.rows.map(row => [row.taskId, row.title])).toEqual([["stop:admission", "접수가 33분째 멈춰 있습니다"]]);
    expect(table.relayed()).toEqual([1]);
  });
});

describe("phone alerts — what is sent", () => {
  const board: ConsoleTaskBoard = buildConsoleTasks(consoleFixtureInputs());

  it("takes only 멈춤 and 평소와 다름 with the task's title, fact line and a link to it", () => {
    const candidates = consoleAlertCandidates(board);
    expect(candidates.map(row => [row.group, row.title, row.fact, row.href])).toEqual([
      ["stop", "AI 1차가 거의 멈췄습니다", "대기 857건 · 가장 오래된 것 8시간 2분 · 최근 1시간 3건", "/admin/flow?stage=first"],
      ["stop", "소개 검수가 8일째 멈춰 있습니다", "대기 2,143건 · 사람이 멈춤", "/admin/flow#task-stop-job-product-intro-check"],
      ["odd", "규칙 심사 보류가 갑자기 늘었습니다", "규칙으로 못 가름 · 24시간 +323건 · 누적 325건", "/admin/flow#task-odd-hold-ambiguous"],
    ]);
  });

  it("links to the stage panel when the task's first link is one, else to the home row — a path only (Oracle adds the site)", () => {
    expect(consoleAlertHref({ id: "stop:stage:first", actions: [{ kind: "link", label: "단계 열기", href: "/admin/flow?stage=first#sp-models" }] }))
      .toBe("/admin/flow?stage=first");
    expect(consoleAlertHref({ id: "stop:takedown", actions: [{ kind: "link", label: "요청 열기", href: "/admin/requests" }] }))
      .toBe("/admin/flow#task-stop-takedown");
    expect(consoleTaskAnchor("odd:change-watch:123")).toBe("task-odd-change-watch-123");
  });

  it("strips control and bidi characters, bounds the text and keeps only admin links", () => {
    expect(relayText("a\u0000b‮c\n d", 80)).toBe("a b c d");
    expect([...relayText("가".repeat(100), CONSOLE_ALERT_RULES.titleMax)]).toHaveLength(CONSOLE_ALERT_RULES.titleMax);
    const rows = consoleAlertRelay([{ id: 3, title: "t", fact: "f", href: "/admin/flow?stage=first" }, { id: "4", title: "u", fact: "", href: "https://evil.test/admin/flow" },
      { id: 5, title: " ", fact: "", href: "/admin/flow" }, { id: "6", title: "v", fact: "", href: "/admin/flow#task-stop-admission" }]);
    expect(rows).toEqual([{ id: 3, title: "t", fact: "f", href: "/admin/flow?stage=first" }, { id: 6, title: "v", fact: "", href: "/admin/flow#task-stop-admission" }]);
    expect(RELAY_HREF.test("javascript:alert(1)")).toBe(false);
    expect(consoleAlertRelay(Array.from({ length: 12 }, (_, index) => ({ id: index + 1, title: "x", fact: "", href: "/admin/flow" })))).toHaveLength(CONSOLE_ALERT_RULES.maxRelay);
  });
});

describe("phone alert settings", () => {
  it("reads on/off and a quiet window from the form, both clocks or none", () => {
    expect(parseAlertSettings({ enabled: true, quietStart: "", quietEnd: "" })).toEqual({ enabled: true, quietStart: null, quietEnd: null });
    expect(parseAlertSettings({ enabled: false, quietStart: "23:00", quietEnd: "07:00" })).toEqual({ enabled: false, quietStart: "23:00", quietEnd: "07:00" });
    for (const bad of [{ enabled: true, quietStart: "23:00", quietEnd: "" }, { enabled: true, quietStart: "07:00", quietEnd: "07:00" },
      { enabled: true, quietStart: "24:00", quietEnd: "07:00" }, { enabled: "yes", quietStart: "", quietEnd: "" }]) expect(parseAlertSettings(bad)).toBeNull();
  });

  it("defaults to off when there is no record or the record is broken", () => {
    expect(CONSOLE_ALERT_DEFAULTS.enabled).toBe(false);
    expect(alertSettingsFrom(null)).toEqual(CONSOLE_ALERT_DEFAULTS);
    expect(alertSettingsFrom({ after: { enabled: true, quietStart: "x", quietEnd: "y" } })).toEqual(CONSOLE_ALERT_DEFAULTS);
    expect(alertSettingsFrom({ before: {}, after: { enabled: true, quietStart: null, quietEnd: null } })).toEqual(ON);
  });

  it("knows quiet hours in KST, across midnight, and when they end", () => {
    const at = (kst: string) => Date.parse(`2026-11-12T${kst}:00+09:00`);
    const night: ConsoleAlertSettings = { enabled: true, quietStart: "23:00", quietEnd: "07:00" };
    expect(quietHours(night, at("23:30"))).toEqual({ quiet: true, endsAt: Date.parse("2026-11-13T07:00:00+09:00") });
    expect(quietHours(night, at("06:59")).quiet).toBe(true);
    expect(quietHours(night, at("07:00")).quiet).toBe(false);
    expect(quietHours({ enabled: true, quietStart: "12:00", quietEnd: "13:00" }, at("12:30"))).toEqual({ quiet: true, endsAt: at("13:00") });
    expect(quietHours(ON, at("03:00"))).toEqual({ quiet: false, endsAt: null });
  });
});

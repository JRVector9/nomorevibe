import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { consoleAlerts } from "@/lib/db/schema";
import type { ConsoleAlertCandidate, ConsoleAlertPlan } from "@/lib/operations/console-alerts";
import { readConsoleAlertRelay } from "@/lib/operations/console-alerts-relay";
import { applyConsoleAlertPlan, pruneConsoleAlerts, readConsoleAlertSettings, readConsoleAlertsView, readOpenConsoleAlerts,
  saveConsoleAlertSettings } from "@/lib/operations/console-alerts-store";
import { ensureSchema } from "./setup";

vi.mock("server-only", () => ({}));

const empty = (): ConsoleAlertPlan => ({ open: [], seen: [], missing: [], close: [], uncertain: 0 });
const candidate = (taskId: string, patch: Partial<ConsoleAlertCandidate> = {}): ConsoleAlertCandidate => ({ taskId, rule: "stage-stalled", group: "stop",
  title: "AI 1차가 거의 멈췄습니다", fact: "대기 857건 · 최근 1시간 3건", href: "/admin/flow?stage=first", ...patch });

beforeAll(() => ensureSchema());
beforeEach(async () => { await db.delete(consoleAlerts); });

/** 휴대폰 알림 줄(0183, 운영 콘솔 조각 4b) — 표와 쓰기 경로 */
describe("console alert rows", () => {
  it("keeps one open row per task, even if two ticks race to open it", async () => {
    await applyConsoleAlertPlan({ ...empty(), open: [{ candidate: candidate("stop:stage:first"), release: true }] }, undefined);
    await applyConsoleAlertPlan({ ...empty(), open: [{ candidate: candidate("stop:stage:first"), release: true }] }, undefined);
    const open = await readOpenConsoleAlerts();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ taskId: "stop:stage:first", group: "stop", releasedAt: expect.any(String), missingSince: null });
    expect(await readConsoleAlertRelay()).toEqual([{ id: open[0].id, title: "AI 1차가 거의 멈췄습니다", fact: "대기 857건 · 최근 1시간 3건", href: "/admin/flow?stage=first" }]);
  });

  it("holds an unreleased row out of the relay until it is released, then follows seen → missing → closed, and reopens as a new row", async () => {
    await applyConsoleAlertPlan({ ...empty(), open: [{ candidate: candidate("odd:hold:ambiguous", { group: "odd" }), release: false }] }, undefined);
    const [row] = await readOpenConsoleAlerts();
    expect(await readConsoleAlertRelay()).toEqual([]);
    await applyConsoleAlertPlan({ ...empty(), seen: [{ id: row.id, candidate: candidate("odd:hold:ambiguous", { group: "odd", fact: "누적 400건" }), release: true }] }, undefined);
    expect((await readConsoleAlertRelay()).map(entry => [entry.id, entry.fact])).toEqual([[row.id, "누적 400건"]]);
    await applyConsoleAlertPlan({ ...empty(), missing: [row.id] }, undefined);
    expect((await readOpenConsoleAlerts())[0].missingSince).not.toBeNull();
    await applyConsoleAlertPlan({ ...empty(), close: [{ id: row.id, reason: "resolved" }] }, undefined);
    expect(await readOpenConsoleAlerts()).toEqual([]);
    expect(await readConsoleAlertRelay()).toEqual([]);
    await applyConsoleAlertPlan({ ...empty(), open: [{ candidate: candidate("odd:hold:ambiguous", { group: "odd" }), release: true }] }, undefined);
    const view = await readConsoleAlertsView();
    expect(view.map(entry => [entry.taskId, entry.closeReason])).toEqual([["odd:hold:ambiguous", null], ["odd:hold:ambiguous", "resolved"]]);
  });

  it("refuses control characters and unknown close reasons at the table", async () => {
    await expect(db.insert(consoleAlerts).values({ taskId: "x", rule: "r", groupKey: "stop", title: "a\nb", fact: "", href: "/admin/flow" })).rejects.toThrow();
    await applyConsoleAlertPlan({ ...empty(), open: [{ candidate: candidate("stop:admission"), release: false }] }, undefined);
    const [row] = await readOpenConsoleAlerts();
    await expect(db.update(consoleAlerts).set({ closedAt: new Date(), closeReason: "gone" as "resolved" }).where(eq(consoleAlerts.id, row.id))).rejects.toThrow();
  });

  it("prunes rows closed more than thirty days ago", async () => {
    await applyConsoleAlertPlan({ ...empty(), open: [{ candidate: candidate("stop:a"), release: true }, { candidate: candidate("stop:b"), release: true }] }, undefined);
    const rows = await readOpenConsoleAlerts();
    await db.update(consoleAlerts).set({ closedAt: sql`now() - interval '40 days'`, closeReason: "resolved" }).where(eq(consoleAlerts.id, rows[0].id));
    await db.update(consoleAlerts).set({ closedAt: sql`now() - interval '2 days'`, closeReason: "resolved" }).where(eq(consoleAlerts.id, rows[1].id));
    expect(await pruneConsoleAlerts(undefined)).toBe(1);
    expect((await readConsoleAlertsView()).map(row => row.taskId)).toEqual(["stop:b"]);
  });
});

describe("console alert settings", () => {
  it("are the last saved work-log row — off until someone turns them on", async () => {
    const before = await readConsoleAlertSettings();
    const after = { enabled: !before.settings.enabled, quietStart: "23:00", quietEnd: "07:00" };
    await saveConsoleAlertSettings(before.settings, after, "jr");
    const read = await readConsoleAlertSettings();
    expect(read).toMatchObject({ settings: after, actor: "jr", at: expect.any(String) });
  });
});

describe("log search (⌘K 「그 이름이 나온 기록」)", () => {
  it("finds rows by target, detail text and Korean action label", async () => {
    const { recordAdminAction } = await import("@/lib/operations/admin-log");
    const { activityLog, activityFilter } = await import("@/app/(operator)/admin/activity/query");
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await recordAdminAction("jr", { action: "job-pause", target: `job-${run}`, detail: { reason: `배포 ${run}` } });
    await recordAdminAction("jr", { action: "evidence-settings", target: "evidence_settings", detail: { note: `model supa-${run} 50%_off` } });
    const hits = async (q: string) => (await activityLog(activityFilter({ q }), 50)).map(row => row.action);
    expect(await hits(`job-${run}`)).toEqual(["job-pause"]);
    expect(await hits(`supa-${run}`)).toEqual(["evidence-settings"]);
    // % _ 는 글자 그대로
    expect(await hits(`${run} 50%_off`)).toEqual(["evidence-settings"]);
    expect(await hits(`${run} 50%xoff`)).toEqual([]);
    // 한국어 이름표(「개별 작업 멈춤」)로도 — 같은 실행의 줄만 본다
    expect((await activityLog(activityFilter({ q: "개별 작업 멈춤" }), 500)).some(row => row.target === `job-${run}`)).toBe(true);
  });
});

describe("admission in the header", () => {
  it("reads the mode and who switched it last when that row matches the mode", async () => {
    const { readAdmissionStatus } = await import("@/lib/operations/admission-status");
    const { recordAdminAction } = await import("@/lib/operations/admin-log");
    const [control] = await db.execute<{ mode: string }>(sql`SELECT mode FROM model_capacity_control WHERE id = 1`);
    expect(control).toBeDefined();
    await recordAdminAction("JR", { action: "pipeline-control-capacity-mode", target: "model-capacity", detail: { before: {}, after: { mode: control.mode } } });
    expect(await readAdmissionStatus(true)).toMatchObject({ mode: control.mode, actor: "JR", since: expect.any(String) });
    await recordAdminAction("JR", { action: "pipeline-control-capacity-mode", target: "model-capacity", detail: { before: {}, after: { mode: "other" } } });
    expect(await readAdmissionStatus(true)).toMatchObject({ mode: control.mode, actor: null });
  });
});

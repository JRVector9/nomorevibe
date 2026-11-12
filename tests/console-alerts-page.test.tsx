import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), redirect: vi.fn(), settings: vi.fn(), view: vi.fn(), jobs: vi.fn(), readOnly: vi.fn(), save: vi.fn(),
  open: vi.fn(), apply: vi.fn(), prune: vi.fn(), home: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin, authSecret: () => "s".repeat(64) }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/operations/admin-workspace-preview", () => ({ adminWorkspaceReadOnly: mocks.readOnly }));
vi.mock("@/lib/jobs/runner", () => ({ listJobStates: mocks.jobs }));
vi.mock("@/app/(operator)/admin/alerts/actions", () => ({ saveConsoleAlertSettingsAction: mocks.save }));
vi.mock("@/lib/operations/console-alerts-store", () => ({ readConsoleAlertSettings: mocks.settings, readConsoleAlertsView: mocks.view,
  readOpenConsoleAlerts: mocks.open, applyConsoleAlertPlan: mocks.apply, pruneConsoleAlerts: mocks.prune }));
vi.mock("@/lib/operations/console-home-read", () => ({ readConsoleHome: mocks.home }));

import AdminAlertsPage from "@/app/(operator)/admin/alerts/page";
import { sendConsoleAlerts } from "@/lib/jobs/console-alerts";
import { consoleFixtureRead } from "./fixtures/console-home";

const NOW = Date.parse("2026-11-12T00:00:00.000Z");
const iso = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const alert = (id: number, patch: Record<string, unknown> = {}) => ({ id, taskId: `stop:stage:${id}`, group: "stop", title: "AI 1차가 거의 멈췄습니다",
  fact: "대기 857건 · 최근 1시간 3건", href: "https://nomorevibe.com/admin/flow?stage=first", openedAt: iso(30), seenAt: iso(1), missingSince: null,
  releasedAt: iso(30), closedAt: null, closeReason: null, ...patch });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  mocks.admin.mockResolvedValue({ login: "jr", exp: 9_999_999_999 });
  mocks.readOnly.mockReturnValue(false);
  mocks.settings.mockResolvedValue({ settings: { enabled: true, quietStart: "23:00", quietEnd: "07:00" }, at: iso(60), actor: "JR" });
  mocks.view.mockResolvedValue([alert(3), alert(2, { title: "규칙 심사 보류가 갑자기 늘었습니다", group: "odd", releasedAt: null }),
    alert(1, { closedAt: iso(5), closeReason: "resolved" })]);
  mocks.jobs.mockResolvedValue([{ name: "console-alerts", lastRunAt: new Date(NOW - 120_000), lastError: null, pausedUntil: null, notBefore: null }]);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

/** 홈 › 알림(조각 4b) */
describe("alerts screen", () => {
  it("shows the state, the settings form with a confirm step, the delivery route and the alert rows", async () => {
    const html = renderToStaticMarkup(await AdminAlertsPage());
    const plain = text(html);
    expect(plain).toContain("알림 켜짐 조용한 시간 23:00 ~ 07:00 열린 알림 2 알림 작업 11-12 08:58 마지막 저장 11-12 08:00 · JR");
    expect(html).toContain('type="checkbox" checked=""');
    expect(html).toContain(">저장 전 확인</button>");
    expect(plain).toContain("Oracle 감시자(watchdog)가 복구 게이트웨이로 읽어 장애 알림과 같은 Telegram 대화방에 줄마다 한 번 보냅니다.");
    const states = [...html.matchAll(/<span class="al-st" data-tone="(\w+)"><i aria-hidden="true"><\/i>([^<]+)<\/span>/g)].map(match => [match[1], match[2]]);
    expect(states).toEqual([["ok", "보냄"], ["warn", "다음 작업에서 보냄"], ["off", "닫힘 · 해소"]]);
    expect(html).toContain('<col style="width:112px"/><col/><col style="width:168px"/><col style="width:112px"/>');
  });

  it("locks the form in the read-only preview", async () => {
    mocks.readOnly.mockReturnValue(true);
    const html = renderToStaticMarkup(await AdminAlertsPage());
    expect(html).toContain("읽기 전용 미리보기 — 여기서는 저장할 수 없습니다.");
    expect(html).toMatch(/<input type="checkbox"[^>]*disabled=""[^>]*\/>/);
  });

  it("says when the table cannot be read (before migration 0183)", async () => {
    mocks.view.mockRejectedValue(new Error("relation does not exist"));
    expect(text(renderToStaticMarkup(await AdminAlertsPage()))).toContain("알림 줄을 읽지 못했습니다(마이그레이션 0183 전이거나 DB 읽기 실패).");
  });
});

/** 알림 작업(console-alerts, maintenance 5분) — 웹 요청이 아니라 잡이 보낸다 */
describe("console-alerts job", () => {
  const ctx = () => ({ cursor: null, save: vi.fn(), hasBudget: () => true, log: vi.fn(), lease: undefined });

  it("when alerts are off, it closes open rows and never reads the home", async () => {
    mocks.settings.mockResolvedValue({ settings: { enabled: false, quietStart: null, quietEnd: null }, at: null, actor: null });
    mocks.open.mockResolvedValue([alert(4)]);
    mocks.apply.mockResolvedValue({ opened: 0, released: 0, closed: 1 });
    mocks.prune.mockResolvedValue(0);
    const job = ctx();
    expect(await sendConsoleAlerts(job)).toEqual({ done: true, cursor: null });
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ open: [], close: [{ id: 4, reason: "disabled" }] }), undefined);
    expect(mocks.home).not.toHaveBeenCalled();
  });

  it("when on, it reads the same home tasks and opens a row for each new 멈춤 · 평소와 다름", async () => {
    mocks.open.mockResolvedValue([]);
    mocks.home.mockResolvedValue(consoleFixtureRead());
    mocks.apply.mockResolvedValue({ opened: 3, released: 3, closed: 0 });
    mocks.prune.mockResolvedValue(0);
    mocks.settings.mockResolvedValue({ settings: { enabled: true, quietStart: null, quietEnd: null }, at: iso(60), actor: "JR" });
    const job = ctx();
    expect(await sendConsoleAlerts(job)).toEqual({ done: true, cursor: null });
    const plan = mocks.apply.mock.calls[0][0];
    expect(plan.open.map((row: { candidate: { taskId: string }; release: boolean }) => [row.candidate.taskId, row.release]))
      .toEqual([["stop:stage:first", true], ["stop:job:product-intro-check", true], ["odd:hold:ambiguous", true]]);
    expect(job.log).toHaveBeenCalledWith("console.alerts_tick", expect.objectContaining({ enabled: true, opened: 3 }));
  });
});

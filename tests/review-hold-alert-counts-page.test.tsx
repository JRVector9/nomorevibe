import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rows: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => ({ login: "fixture", exp: 9_999_999_999 }), authSecret: () => null }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("unexpected login"); }, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/operations/admin-workspace-preview", () => ({ adminWorkspaceReadOnly: () => true }));
vi.mock("@/lib/jobs/runner", () => ({ listJobStates: async () => [] }));
vi.mock("@/app/(operator)/admin/alerts/actions", () => ({ saveConsoleAlertSettingsAction: vi.fn() }));
vi.mock("@/lib/operations/console-alerts-store", () => ({
  readConsoleAlertSettings: async () => ({ settings: { enabled: true, quietStart: null, quietEnd: null }, at: null, actor: null }),
  readConsoleAlertsView: mocks.rows,
}));

import Page from "@/app/(operator)/admin/alerts/page";
import { FlowBoard } from "@/app/(operator)/admin/flow/FlowBoard";
import { buildConveyor, type ConveyorInputs } from "@/lib/operations/conveyor-model";
import { buildConsoleTasks } from "@/lib/operations/console-tasks";
import { consoleFixtureInputs } from "./fixtures/console-home";

afterEach(() => vi.useRealTimers());

/** Optional HTML capture uses the real server page and components, only the reads are mocked. */
describe("hold alert page without DB or login", () => {
  it("renders distinct rule and AI alert rows, and first-hold counts in the flow panel", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-17T00:00:00Z") });
    // Synthetic threshold-crossing fixture, not a production measurement.
    const holds = process.env.REVIEW_HOLD_CAPTURE_BEFORE === "1"
      ? [{ reason: "ambiguous", count: 180, recent24h: 130 }]
      : [{ reason: "ambiguous", count: 80, recent24h: 60 }, { reason: "ai_first_ambiguous", count: 100, recent24h: 70 }];
    const data = buildConveyor({ now: "2026-11-17T00:00:00Z", enabled: true, throughput: null, flow: null, hourly: null, human: null,
      progress: null, search: null, holds, rejected: 0, classification: null, sources: [] } satisfies ConveyorInputs);
    const tasks = buildConsoleTasks({ ...consoleFixtureInputs(), conveyor: data }).groups.flatMap(group => group.tasks).filter(task => task.rule === "hold-surge");
    mocks.rows.mockResolvedValue(tasks.map((task, index) => ({ id: index + 1, taskId: task.id, group: task.group,
      title: task.title, fact: task.fact, href: task.actions[0].kind === "link" ? task.actions[0].href : "/admin/review", openedAt: data.measuredAt, seenAt: data.measuredAt,
      missingSince: null, releasedAt: data.measuredAt, closedAt: null, closeReason: null })));
    const page = renderToStaticMarkup(await Page());
    const flow = renderToStaticMarkup(<FlowBoard data={data} />);
    expect(page).toContain("규칙 심사 보류가 갑자기 늘었습니다");
    if (process.env.REVIEW_HOLD_CAPTURE_BEFORE !== "1") {
      expect(page).toContain("AI 1차 판단 보류가 갑자기 늘었습니다");
      expect(flow).toContain("최근 24시간에 처음 보류된 후보 수");
    }
    const output = process.env.REVIEW_HOLD_CAPTURE_DIR;
    if (output) {
      mkdirSync(output, { recursive: true });
      const css = ["admin.css", "prototype.css", "flow/flow.css", "alerts/alerts.css"].map(file => readFileSync(path.join("app/(operator)/admin", file), "utf8")).join("\n");
      const section = flow.match(/<section class="cv-panel" aria-labelledby="cv-holds-title">[\s\S]*?<\/section>/)?.[0];
      if (!section) throw new Error("Missing holds panel");
      const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>심사 보류 알림 검수</title><style>
        *{box-sizing:border-box}body{margin:0;padding:28px;background:#f7f8f3;font-family:Arial,sans-serif}a{color:inherit}h1,h2,p{margin:0}button,input{font:inherit}
        :root{--color-fg:#23281f;--color-fg-2:#56604d;--color-fg-3:#737c6b;--color-bg-card:#fff;--color-line:#e0e4db;--color-accent-ink:#486824;--color-warn:#a16b12;--font-mono:monospace}
        ${css}
        .capture-note{margin-bottom:20px;color:#56604d}.capture-flow{margin-top:30px}.capture-flow .cv-panel{padding:20px;background:white;border:1px solid #e0e4db;border-radius:10px}
        </style><body><div class="admin-prototype"><p class="capture-note">시험 자료 · DB·로그인 없이 실제 서버 화면 렌더 · ${process.env.REVIEW_HOLD_CAPTURE_BEFORE === "1" ? "변경 전" : "변경 후"}</p>${page}<div class="cv capture-flow">${section}</div></div></body></html>`;
      writeFileSync(path.join(output, "screen.html"), html);
    }
  });
});

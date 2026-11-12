import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {}, onReplica: (load: () => unknown) => load(), onPrimary: (load: () => unknown) => load() }));

import { buildLogLines, logRawHref, type LogAuditRow } from "@/lib/operations/console-log";
import { actionLabel, targetLabel } from "@/app/(operator)/admin/activity/labels";

const base = Date.parse("2026-11-11T23:00:00.000Z"); // 08:00 KST
let id = 100;
function row(minute: number, action: string, patch: Partial<LogAuditRow> = {}): LogAuditRow {
  id += 1;
  return { id, createdAt: new Date(base + minute * 60_000), actor: "JR", actorKind: "github", action, target: "x", detail: {}, ok: true, error: null, ...patch };
}
const labels = { action: actionLabel, target: (target: string) => targetLabel(target).text,
  connectionLabels: new Map([["c-supa", "supa"], ["c-qwen", "gpu3090-qwen"], ["c-deepseek", "OpenCode deepseek"]]) };
const capacity = (mode: string) => ({ before: { mode: mode === "open" ? "draining" : "open" }, after: { mode } });

/** 기록 화면(조각 4b, 시안 「화면 6 기록」) — 바꾼 것 한 줄씩 */
describe("log lines", () => {
  it("joins an admission pause and its reopening into one line with the minutes, by whoever paused", () => {
    const { lines } = buildLogLines([row(8, "pipeline-control-capacity-mode", { target: "model-capacity", detail: capacity("draining") }),
      row(26, "pipeline-control-capacity-mode", { target: "model-capacity", detail: capacity("open") })], labels);
    expect(lines.map(line => [line.title, line.actor, line.count, line.until !== null, line.undo])).toEqual([["접수 중단 → 다시 열림 (18분)", "JR", 1, true, null]]);
  });

  it("joins one person's back-to-back saves of the same thing into one line, newest lines first", () => {
    const rank = (minute: number, before: string, after: string) => row(minute, "ai-task-models-save", { target: "first-review#1",
      detail: { before: [{ rank: 1, connectionId: before, model: "m" }, { rank: 2, connectionId: "c-qwen", model: "q" }],
        after: [{ rank: 1, connectionId: after, model: "m" }, { rank: 2, connectionId: "c-qwen", model: "q" }] } });
    const rows = [rank(0, "c-deepseek", "c-supa"), rank(4, "c-supa", "c-supa"), row(5, "job-pause", { target: "product-intro-check", detail: { reason: "배포" } }),
      row(40, "evidence-settings", { target: "evidence_settings" }), row(45, "evidence-settings", { target: "evidence_settings" }), row(49, "evidence-settings", { target: "evidence_settings" })];
    const { lines } = buildLogLines(rows, labels);
    expect(lines.map(line => [line.title, line.count])).toEqual([
      ["근거 설정 저장 · 근거 설정", 3],
      ["소개 검수 멈춤", 1],
      ["1차 AI 검수 1순위를 supa로", 2],
    ]);
    // 순위 저장 되돌리기 — 첫 저장 전과 마지막 저장 뒤의 순위, 그 순위를 고치는 곳(기존 화면)
    const ranks = lines[2];
    expect(ranks.rankUndo).toEqual({ now: "supa → gpu3090-qwen", back: "OpenCode deepseek → gpu3090-qwen" });
    expect(ranks.undo).toMatchObject({ href: "/admin/models/tasks" });
    expect(ranks.ids).toHaveLength(2);
    expect(logRawHref(ranks)).toBe(`/admin/activity?before=${ranks.ids[1] + 1}`);
  });

  it("does not join different people, targets, or saves more than thirty minutes apart", () => {
    const { lines } = buildLogLines([row(0, "evidence-settings", { target: "evidence_settings" }), row(10, "evidence-settings", { target: "evidence_settings", actor: "jr-claude" }),
      row(50, "evidence-settings", { target: "evidence_settings", actor: "jr-claude" }), row(55, "news-hide", { target: "news:1" }), row(56, "news-hide", { target: "news:2" })], labels);
    expect(lines.map(line => [line.actor, line.title, line.count])).toEqual([["JR", "소식 숨김 · 소식 #2", 1], ["JR", "소식 숨김 · 소식 #1", 1],
      ["jr-claude", "근거 설정 저장 · 근거 설정", 1], ["jr-claude", "근거 설정 저장 · 근거 설정", 1], ["JR", "근거 설정 저장 · 근거 설정", 1]]);
  });

  it("keeps failures as their own lines and counts — never drops — automatic and read-only rows", () => {
    const { lines, hidden, oldestId } = buildLogLines([row(0, "audit-auto-keep", { actor: "model:qwen", actorKind: "model" }), row(1, "export", { target: "export:activity" }),
      row(2, "ops-runner-state", { actor: "system:ops-runner", actorKind: "system" }), row(3, "ai-connection-models-read"),
      row(4, "ai-task-models-save", { target: "first-review#1", ok: false, error: "stale_revision" })], labels);
    expect(lines.map(line => [line.title, line.ok, line.error])).toEqual([["작업 ↔ 모델 순위 저장 · first-review#1", false, "stale_revision"]]);
    expect(lines[0].undo).toBeNull();
    expect(hidden).toEqual({ automatic: 2, quiet: 2 });
    expect(oldestId).toBe(lines[0].ids[0] - 4);
  });

  it("links a batch decision to the existing 「묶음째 되돌리기」 and says when a change cannot be undone", () => {
    const { lines } = buildLogLines([row(0, "human-batch-run", { target: "batch:12", detail: { decision: "approve", count: 27 } }),
      row(1, "model-capacity-unknown-reviewed", { target: "req-1" })], labels);
    expect(lines.find(line => line.action === "human-batch-run")!.undo).toMatchObject({ href: expect.stringContaining("/admin/review/batches#") });
    expect(lines.find(line => line.action === "model-capacity-unknown-reviewed")!.undo).toMatchObject({ href: null });
  });
});

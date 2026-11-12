import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ inserted: [] as unknown[], rows: [] as unknown[] }));
vi.mock("@/lib/db", () => {
  const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => db.rows };
  return {
    onPrimary: (load: () => Promise<unknown>) => load(),
    db: {
      transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ insert: () => ({ values: async (row: unknown) => { db.inserted.push(row); } }) }),
      select: () => chain,
    },
  };
});
vi.mock("@/lib/operations/admin-log", () => ({
  adminAuditRow: async (actor: string, entry: { action: string; target: string; detail?: Record<string, unknown> }) => ({ actor, ...entry, ok: true }),
}));

import { CONSOLE_TASK_KEEP_ACTION, keepConsoleTask, keptFromAudit, parseConsoleKeep, readConsoleKept } from "@/lib/operations/console-task-keep";

beforeEach(() => { db.inserted.length = 0; db.rows.length = 0; });

describe("「사유 남기고 유지」·「그대로 두기」 — 작업 로그 한 줄", () => {
  it("accepts only the two keepable task shapes, a known job and a reason", () => {
    expect(parseConsoleKeep({ taskId: "stop:job:product-intro-check", ref: "28123", reason: "  이번 주 끔 ", title: "소개 검수가 8일째 멈춰 있습니다" }))
      .toEqual({ taskId: "stop:job:product-intro-check", ref: "28123", reason: "이번 주 끔", title: "소개 검수가 8일째 멈춰 있습니다" });
    expect(parseConsoleKeep({ taskId: "tidy:no-result:c8f1666d-e05c-4b84-9dba-eba484e8dfd3", ref: null, reason: "약관", title: "" }))
      .toMatchObject({ taskId: "tidy:no-result:c8f1666d-e05c-4b84-9dba-eba484e8dfd3", ref: null });
    for (const bad of [
      { taskId: "stop:stage:first", reason: "x" },                 // 받는 규칙이 아니다
      { taskId: "stop:job:not-a-job", reason: "x" },               // 모르는 잡
      { taskId: "stop:job:product-intro-check", reason: "   " },   // 사유 없음
      { taskId: "stop:job:product-intro-check", reason: "x".repeat(501) },
      { taskId: "stop:job:product-intro-check", reason: "x", ref: "v1" },
    ]) expect(parseConsoleKeep(bad), JSON.stringify(bad).slice(0, 60)).toBeNull();
  });

  it("writes one operations_audit row with the reason, until and the job-control version", async () => {
    const now = new Date("2026-11-12T00:00:00.000Z");
    const result = await keepConsoleTask({ taskId: "stop:job:product-intro-check", ref: "28123", reason: "이번 주 끔", title: "소개 검수" }, "jr", now);
    expect(result).toEqual({ until: "2026-11-19T00:00:00.000Z" });
    expect(db.inserted).toEqual([{ actor: "jr", action: CONSOLE_TASK_KEEP_ACTION, target: "stop:job:product-intro-check", ok: true,
      detail: { reason: "이번 주 끔", until: "2026-11-19T00:00:00.000Z", ref: "28123", title: "소개 검수", keepDays: 7 } }]);
  });

  it("reads the latest mark per task inside the window", async () => {
    const at = (iso: string) => new Date(iso);
    const rows = [
      { id: 10, at: at("2026-11-10T00:00:00.000Z"), actor: "jr", target: "stop:job:product-intro-check", detail: { reason: "옛 사유", until: "2026-11-17T00:00:00.000Z" } },
      { id: 12, at: at("2026-11-11T00:00:00.000Z"), actor: "JR", target: "stop:job:product-intro-check", detail: { reason: "새 사유", until: "2026-11-18T00:00:00.000Z", ref: "41" } },
      { id: 11, at: at("2026-11-11T00:00:00.000Z"), actor: "jr", target: "tidy:no-result:conn-x", detail: {} },
      { id: 13, at: at("2026-11-11T00:00:00.000Z"), actor: "jr", target: "<script>", detail: { reason: "x" } },
    ];
    expect(keptFromAudit(rows)).toEqual([
      { taskId: "stop:job:product-intro-check", at: "2026-11-11T00:00:00.000Z", until: "2026-11-18T00:00:00.000Z", actor: "JR", reason: "새 사유", ref: "41" },
      { taskId: "tidy:no-result:conn-x", at: "2026-11-11T00:00:00.000Z", until: "2026-11-18T00:00:00.000Z", actor: "jr", reason: "" },
    ]);
    db.rows.push(...rows);
    expect((await readConsoleKept(new Date("2026-11-18T12:00:00.000Z"))).map(row => row.taskId)).toEqual([]);
    expect((await readConsoleKept(new Date("2026-11-12T00:00:00.000Z"))).map(row => row.taskId)).toEqual(["stop:job:product-intro-check", "tidy:no-result:conn-x"]);
  });
});

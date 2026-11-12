import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), csrf: vi.fn(), keep: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://admin.example" }) }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin, authSecret: () => "secret", adminOrigin: () => "https://admin.example",
  adminLocalLoginEnabled: () => false, LOCAL_ADMIN_LOGIN: "local" }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: <T>(fn: T) => fn }));
vi.mock("@/app/(operator)/admin/status/job-control-csrf", () => ({ assertJobControlCsrf: mocks.csrf }));
vi.mock("@/lib/operations/console-task-keep", async () => {
  const actual = await vi.importActual<typeof import("@/lib/operations/console-task-keep")>("@/lib/operations/console-task-keep");
  return { ...actual, keepConsoleTask: mocks.keep };
});
vi.mock("@/lib/db", () => ({ db: {}, onPrimary: (load: () => unknown) => load() }));

import { keepConsoleTaskAction } from "@/app/(operator)/admin/flow/task-keep-actions";

const input = { taskId: "stop:job:product-intro-check", ref: "28123", reason: "이번 주 끔", title: "소개 검수", csrfToken: "a".repeat(64), csrfExpiresAt: 9_999_999_999 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.csrf.mockReset();
  mocks.admin.mockResolvedValue({ login: "jr", exp: 9_999_999_999 });
  mocks.keep.mockResolvedValue({ until: "2026-11-19T00:00:00.000Z" });
});

describe("keepConsoleTaskAction — 작업 멈춤·재개와 같은 관문", () => {
  it("needs a signed-in administrator and the job-control CSRF token", async () => {
    mocks.admin.mockResolvedValue(null);
    expect(await keepConsoleTaskAction(input)).toEqual({ error: "관리자 로그인이 필요합니다." });
    mocks.admin.mockResolvedValue({ login: "jr", exp: 9_999_999_999 });
    mocks.csrf.mockImplementation(() => { throw new Error("forbidden"); });
    expect(await keepConsoleTaskAction(input)).toEqual({ error: "요청을 확인하지 못했습니다. 새로고침한 뒤 다시 해 주세요." });
    expect(mocks.keep).not.toHaveBeenCalled();
  });
  it("refuses a missing reason or an unkeepable task, then writes one row and refreshes the home and the log", async () => {
    expect(await keepConsoleTaskAction({ ...input, reason: " " })).toEqual({ error: "할 일과 사유를 확인해 주세요." });
    expect(await keepConsoleTaskAction({ ...input, taskId: "stop:stage:first" })).toEqual({ error: "할 일과 사유를 확인해 주세요." });
    expect(mocks.keep).not.toHaveBeenCalled();
    expect(await keepConsoleTaskAction(input)).toEqual({ message: "11-19 09:00까지 할 일 목록에서 내립니다. 그때도 같으면 다시 올라옵니다." });
    expect(mocks.csrf).toHaveBeenCalledWith(expect.objectContaining({ token: input.csrfToken, expiresAt: input.csrfExpiresAt, origin: "https://admin.example" }));
    expect(mocks.keep).toHaveBeenCalledWith({ taskId: input.taskId, ref: "28123", reason: "이번 주 끔", title: "소개 검수" }, "jr");
    expect(mocks.revalidate.mock.calls.map(([path]) => path)).toEqual(["/admin/flow", "/admin/activity"]);
  });
});

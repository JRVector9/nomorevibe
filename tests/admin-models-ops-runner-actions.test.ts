import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), submit: vi.fn(), read: vi.fn(), audit: vi.fn(), cancel: vi.fn() }));
vi.mock("@/lib/operations/admin-log", () => ({ recordAdminAction: mocks.audit }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("@/lib/operations/ops-runner/repository", () => ({ submitModelOpsCommand: mocks.submit, readModelOpsState: mocks.read, cancelModelOpsCommand: mocks.cancel }));
import { cancelAdminModelOperation, submitAdminModelOperation, readAdminModelOperation } from "@/app/(operator)/admin/models/ops-runner-actions";
const command = { id: "ad2b84de-4ddf-4b2e-9dbd-605c64f7d728", action: "request-release", targetId: "161d7780-5b1f-4ce8-be8d-baed927b28e8", reason: "시험", confirmed: true };
beforeEach(() => { vi.resetAllMocks(); mocks.admin.mockResolvedValue({ login: "admin" }); mocks.submit.mockResolvedValue({ id: command.id }); mocks.read.mockResolvedValue(null); });
it("비관리자의 제출과 상태 조회를 서버에서 거절한다", async () => {
  mocks.admin.mockResolvedValue(null);
  expect(await submitAdminModelOperation(command)).toHaveProperty("error"); expect(await readAdminModelOperation(command.id)).toHaveProperty("error");
  expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
});
it("허용되지 않은 작업과 가짜 evidence를 서버에서 거절한다", async () => {
  expect(await submitAdminModelOperation({ ...command, action: "ssh" })).toHaveProperty("error");
  expect(await submitAdminModelOperation({ ...command, receipt: { stopped: true } })).toHaveProperty("error");
  expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.audit).toHaveBeenCalledTimes(2);
});
it("확인한 버튼은 허용된 명령만 감사 큐로 보낸다", async () => {
  expect(await submitAdminModelOperation(command)).toEqual({ state: { id: command.id } });
  expect(mocks.submit).toHaveBeenCalledWith(command, "admin");
});
it("실패에 포함된 비밀 값/예외를 UI에 노출하지 않는다", async () => {
  mocks.submit.mockRejectedValue(new Error("secret-key-value"));
  expect(JSON.stringify(await submitAdminModelOperation(command))).not.toContain("secret-key-value");
});

it("시작 전 취소: 관리자·사유를 서버에서 확인하고, 거절 까닭은 정해 둔 한국어 문장으로만 보인다", async () => {
  mocks.cancel.mockResolvedValue({ id: command.id, status: "cancelled" });
  expect(await cancelAdminModelOperation({ id: command.id, reason: "대상 요청 이미 닫힘" })).toEqual({ state: { id: command.id, status: "cancelled" } });
  expect(mocks.cancel).toHaveBeenCalledWith({ id: command.id, reason: "대상 요청 이미 닫힘" }, "admin");
  expect(await cancelAdminModelOperation({ id: command.id, reason: "" })).toEqual({ error: "취소 사유(1~300자)를 입력해주세요." });
  expect(await cancelAdminModelOperation({ id: "not-a-uuid", reason: "x" })).toHaveProperty("error");
  mocks.cancel.mockRejectedValueOnce(new Error("ops_runner_running"));
  expect(await cancelAdminModelOperation({ id: command.id, reason: "x" })).toEqual({ error: "운영 실행기가 이 작업을 처리하고 있어 취소할 수 없습니다." });
  mocks.cancel.mockRejectedValueOnce(new Error("secret-key-value"));
  expect(JSON.stringify(await cancelAdminModelOperation({ id: command.id, reason: "x" }))).not.toContain("secret");
  mocks.admin.mockResolvedValue(null);
  expect(await cancelAdminModelOperation({ id: command.id, reason: "x" })).toHaveProperty("error");
  expect(mocks.cancel).toHaveBeenCalledTimes(3);
});

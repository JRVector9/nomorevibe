import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), insert: vi.fn(), values: vi.fn(), audit: vi.fn(), observation: vi.fn(), list: vi.fn(), control: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/db", () => ({ db: { insert: mocks.insert }, onPrimary: (fn: () => unknown) => fn() }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ runWebWrite: (fn: () => unknown) => fn(), webWriteAction: (fn: unknown) => fn }));
vi.mock("@/lib/operations/admin-log", () => ({ adminAuditRow: mocks.audit }));
vi.mock("@/lib/operations/admin-models-repository", () => ({ readAdminModelsObservation: mocks.observation }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ listGatewayModels: mocks.list }));
vi.mock("@/lib/operations/model-env", () => ({ currentModelEnv: async () => ({}) }));
vi.mock("@/lib/operations/pipeline-control-repository", () => ({ runPipelineControl: mocks.control }));
import { probeAdminModel, changeAdminModelAdmission } from "@/app/(operator)/admin/models/operation-actions";

const identity = { routeId: "crawl-agent-review", provider: "abcllm", model: "test-model" };
const input = { to: "draining", fromMode: "open", expectEpoch: 1, expectRevision: 2, reason: "점검", confirmed: true };
beforeEach(() => {
  vi.resetAllMocks(); mocks.admin.mockResolvedValue({ login: "admin" });
  mocks.insert.mockReturnValue({ values: mocks.values }); mocks.values.mockResolvedValue(undefined);
  mocks.audit.mockImplementation(async (_actor, entry) => entry);
  mocks.observation.mockResolvedValue({ error: null, rows: [identity] });
  mocks.list.mockResolvedValue([identity.model]); mocks.control.mockResolvedValue({ executed: true });
});
it("비관리자는 연결·접수 변경을 서버에서 거절한다", async () => {
  mocks.admin.mockResolvedValue(null);
  expect(await probeAdminModel(identity)).toMatchObject({ error: expect.stringContaining("관리자") });
  expect(await changeAdminModelAdmission(input)).toMatchObject({ error: expect.stringContaining("관리자") });
  expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.control).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled();
});
it("DB에 없는 임의 모델을 호출하지 않는다", async () => {
  expect(await probeAdminModel({ ...identity, model: "injected" })).toHaveProperty("error");
  expect(mocks.list).not.toHaveBeenCalled();
});
it("의도 감사 기록에 실패하면 네트워크 호출 전에 멈춘다", async () => {
  mocks.values.mockRejectedValue(new Error("audit_failure"));
  await expect(probeAdminModel(identity)).rejects.toThrow("audit_failure");
  expect(mocks.list).not.toHaveBeenCalled();
});
it("모델 목록 확인과 시간·짧은 호출 차단을 별개로 보고하고 감사한다", async () => {
  expect(await probeAdminModel(identity)).toMatchObject({ listed: true, listMs: expect.any(Number), callBlocked: expect.stringContaining("정식 슬롯") });
  expect(mocks.audit.mock.calls.map(call => call[1].action)).toEqual(["admin-models-probe-start", "admin-models-probe-result"]);
  expect(mocks.values).toHaveBeenCalledTimes(2);
});
it("유료 DeepSeek 호출을 만들지 않는다", async () => {
  const row = { ...identity, provider: "deepseek", model: "deepseek-chat" }; mocks.observation.mockResolvedValue({ rows: [row] });
  expect(await probeAdminModel(row)).toMatchObject({ callBlocked: expect.stringContaining("허용되지 않습니다") });
  expect(mocks.list).not.toHaveBeenCalled();
});
it("접수 전환은 기존 정식 CAS·감사 제어기에 위임하고 경로 보호를 완화하지 않는다", async () => {
  expect(await changeAdminModelAdmission(input)).toEqual({ ok: true });
  expect(mocks.control).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "capacity mode", execute: true,
    allowDeferredRoutes: false, options: { to: "draining", fromMode: "open", expectEpoch: 1, expectRevision: 2, reason: "점검", operator: "admin" } }), undefined, {});
});
it("CAS 충돌과 접수 재개 계약 거절을 표시하고 실패 감사 기록을 만든다", async () => {
  mocks.control.mockResolvedValue({ executed: false, plan: { blocked: ["expect_revision_mismatch:3", "deferred_routes:1"] } });
  expect(await changeAdminModelAdmission(input)).toMatchObject({ error: expect.any(String), blocked: ["expect_revision_mismatch:3", "deferred_routes:1"] });
  expect(mocks.audit).toHaveBeenCalledWith("admin", expect.objectContaining({ action: "admin-models-admission-rejected", ok: false }));
});
it("확인하지 않았거나 사유가 없는 변경은 제어기에 도달하지 않는다", async () => {
  expect(await changeAdminModelAdmission({ ...input, confirmed: false })).toHaveProperty("error");
  expect(await changeAdminModelAdmission({ ...input, reason: " " })).toHaveProperty("error");
  expect(mocks.control).not.toHaveBeenCalled();
});

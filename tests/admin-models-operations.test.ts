import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), insert: vi.fn(), values: vi.fn(), audit: vi.fn(), observation: vi.fn(), list: vi.fn(), control: vi.fn(), submit: vi.fn(), saveProbe: vi.fn() }));
vi.mock("@/lib/operations/ops-runner/repository", () => ({ submitModelOpsCommand: mocks.submit }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/db", () => ({ db: { insert: mocks.insert }, onPrimary: (fn: () => unknown) => fn() }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ runWebWrite: (fn: () => unknown) => fn(), webWriteAction: (fn: unknown) => fn }));
vi.mock("@/lib/operations/admin-log", () => ({ adminAuditRow: mocks.audit }));
vi.mock("@/lib/operations/admin-models-repository", () => ({ readAdminModelsObservation: mocks.observation }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ listReviewEngineModels: mocks.list }));
vi.mock("@/lib/operations/model-env", () => ({ currentModelEnv: async () => ({}) }));
vi.mock("@/lib/operations/pipeline-control-repository", () => ({ runPipelineControl: mocks.control }));
// 2026-10-31 한 화면: 연결 확인 결과는 관측 표(probe:<provider>:<model>)에 남는다 — 저장소는 목으로 두고 호출 모양만 본다
vi.mock("@/lib/operations/admin-models-probe-repository", () => ({ saveProbeObservation: mocks.saveProbe }));
import { probeAdminModel } from "@/app/(operator)/admin/models/operation-actions";

const identity = { routeId: "crawl-agent-review", provider: "abcllm", model: "test-model" };
beforeEach(() => {
  vi.resetAllMocks(); mocks.admin.mockResolvedValue({ login: "admin" });
  mocks.insert.mockReturnValue({ values: mocks.values }); mocks.values.mockResolvedValue(undefined);
  mocks.audit.mockImplementation(async (_actor, entry) => entry);
  mocks.observation.mockResolvedValue({ error: null, rows: [identity], mode: "open", epoch: 1, revision: 2 });
  mocks.submit.mockResolvedValue({ id: "queued-id" }); mocks.list.mockResolvedValue([identity.model]); mocks.control.mockResolvedValue({ executed: true });
  mocks.saveProbe.mockResolvedValue({ key: `probe:${identity.provider}:${identity.model}`, observedAt: "2026-10-31T05:00:00.000Z" });
});
// 접수 OPEN/DRAIN 은 운영 실행기 접수(ops-runner-actions)만 쓴다 — 쓰이지 않던 호환 경로 changeAdminModelAdmission 은 PR 5 에서 지웠다.
it("비관리자는 연결 확인을 서버에서 거절한다", async () => {
  mocks.admin.mockResolvedValue(null);
  expect(await probeAdminModel(identity)).toMatchObject({ error: expect.stringContaining("관리자") });
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
  expect(await probeAdminModel(identity)).toMatchObject({ listed: true, listMs: expect.any(Number), callBlocked: expect.stringContaining("정식 슬롯"),
    observedAt: "2026-10-31T05:00:00.000Z", source: "manual" });
  expect(mocks.audit.mock.calls.map(call => call[1].action)).toEqual(["admin-models-probe-start", "admin-models-probe-result"]);
  expect(mocks.values).toHaveBeenCalledTimes(2);
  // 결과는 감사 뒤 슬롯 키에 수동(manual) 출처로 남는다 — 비밀 없이 식별자·결과만
  expect(mocks.saveProbe).toHaveBeenCalledTimes(1);
  expect(mocks.saveProbe.mock.calls[0][0]).toEqual(identity); expect(mocks.saveProbe.mock.calls[0][2]).toBe("manual");
  expect(JSON.stringify(mocks.saveProbe.mock.calls[0][1])).not.toMatch(/Bearer|apiKey|ABCLLM/i);
});
it("관측 저장이 실패해도 연결 확인 결과는 돌려주고 saveError 로만 알린다", async () => {
  mocks.saveProbe.mockRejectedValue(new Error("db_down"));
  expect(await probeAdminModel(identity)).toMatchObject({ listed: true, saveError: expect.stringContaining("관측 표") });
  expect(mocks.audit.mock.calls.map(call => call[1].action)).toEqual(["admin-models-probe-start", "admin-models-probe-result"]);
});
it("유료 DeepSeek 호출을 만들지 않는다", async () => {
  const row = { ...identity, provider: "deepseek", model: "deepseek-chat" }; mocks.observation.mockResolvedValue({ rows: [row] });
  expect(await probeAdminModel(row)).toMatchObject({ callBlocked: expect.stringContaining("허용되지 않습니다") });
  expect(mocks.list).not.toHaveBeenCalled();
});
it("장부의 local-direct 모델 이름도 정식 등록 장비의 목록 경로로 확인한다", async () => {
  const row = { routeId: "direct-review", provider: "local-direct", model: "qwen3.8-flash-next" };
  mocks.observation.mockResolvedValue({ rows: [row] });
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: row.model }] })));
  vi.stubGlobal("fetch", request);
  try {
    expect(await probeAdminModel(row)).toMatchObject({ listed: true });
    expect(request.mock.calls[0][0]).toMatch(/\/models$/);
    expect(mocks.list).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

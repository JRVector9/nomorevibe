import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 퇴역한 abcLLM 게이트웨이(abcllm-api.brut.bot)는 연결 확인·배정 probe 의 네트워크 대상이 아니다.
// 같은 provider(abcllm)라도 직접 엔진 주소는 그대로 확인한다 — 막는 기준은 제공자가 아니라 호스트다.
const fixtures = vi.hoisted(() => ({
  retired: { key: "eng:retired", equipment: "eng", displayName: "Retired", provider: "abcllm", baseUrl: "https://abcllm-api.brut.bot/v1",
    model: "retired-model", family: "retired", timeoutMs: 60_000, maxTokens: 8_000, concurrency: 1, purposes: ["fixture"] },
  direct: { key: "eng:direct", equipment: "eng", displayName: "Direct", provider: "abcllm", baseUrl: "http://100.92.77.66:8014/v1",
    model: "direct-model", family: "direct", timeoutMs: 60_000, maxTokens: 8_000, concurrency: 1, purposes: ["fixture"] },
}));
const mocks = vi.hoisted(() => ({ admin: vi.fn(), insert: vi.fn(), values: vi.fn(), audit: vi.fn(), observation: vi.fn(), saveProbe: vi.fn(),
  probeEngineContract: vi.fn() }));

vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/db", () => ({ db: { insert: mocks.insert }, onPrimary: (fn: () => unknown) => fn() }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ runWebWrite: (fn: () => unknown) => fn(), webWriteAction: (fn: unknown) => fn }));
vi.mock("@/lib/operations/admin-log", () => ({ adminAuditRow: mocks.audit }));
vi.mock("@/lib/operations/admin-models-repository", () => ({ readAdminModelsObservation: mocks.observation }));
vi.mock("@/lib/operations/admin-models-probe-repository", () => ({ saveProbeObservation: mocks.saveProbe }));
vi.mock("@/lib/llm/serving-contract-store", () => ({ servingContractSnapshot: () => ({ rows: [] }) }));
vi.mock("@/lib/llm/model-registry", async importOriginal => ({ ...(await importOriginal<object>()),
  readModelRegistry: () => ({ version: 1, models: [fixtures.retired, fixtures.direct] }) }));
// 배정 저장은 계약 모양을 읽기 위해 이 모듈을 연다 — probe 함수는 목으로 두어 네트워크를 만들지 않는다.
vi.mock("@/lib/operations/admin-engine-connect", () => ({ ENGINE_CONNECT_ROUTES: ["crawl-agent-review"],
  engineBaseUrl: (value: string) => value, engineRouteContract: () => null, probeEngineContract: mocks.probeEngineContract }));

import { probeAdminModel } from "@/app/(operator)/admin/models/operation-actions";
import { saveModelAssignment } from "@/lib/llm/capacity-helpers-repository";
import { PROBE_LIST_FAILED_MESSAGE } from "@/lib/operations/admin-models-probe";
import type { ProductTransaction } from "@/lib/domain/products/generation";

const identity = (model: string) => ({ routeId: "crawl-agent-review", provider: "abcllm", model });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.admin.mockResolvedValue({ login: "admin" });
  mocks.insert.mockReturnValue({ values: mocks.values }); mocks.values.mockResolvedValue(undefined);
  mocks.audit.mockImplementation(async (_actor, entry) => entry);
  mocks.observation.mockResolvedValue({ error: null, rows: [], mode: "open", epoch: 1, revision: 2 });
  mocks.saveProbe.mockResolvedValue({ key: "probe:abcllm:retired-model", observedAt: "2026-11-04T00:00:00.000Z" });
});
afterEach(() => vi.unstubAllGlobals());

describe("연결 확인 — 퇴역 게이트웨이 호스트", () => {
  it("퇴역 게이트웨이 정의는 fetch 없이 목록 실패(null) 결과로 끝난다", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    mocks.observation.mockResolvedValue({ error: null, rows: [identity("retired-model")] });
    const result = await probeAdminModel(identity("retired-model"));
    expect(request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: PROBE_LIST_FAILED_MESSAGE });
    expect(result.listed).toBeUndefined();
  });

  it("같은 abcllm 제공자라도 직접 엔진 주소는 그대로 fetch 한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "direct-model" }] }), { status: 200 }));
    vi.stubGlobal("fetch", request);
    mocks.observation.mockResolvedValue({ error: null, rows: [identity("direct-model")] });
    const result = await probeAdminModel(identity("direct-model"));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("http://100.92.77.66:8014/v1/models");
    expect(result).toMatchObject({ listed: true });
    expect(result.error).toBeUndefined();
  });
});

describe("배정 probe — 퇴역 게이트웨이 호스트", () => {
  it("네트워크 전에 retired_gateway_probe_blocked 로 거절한다", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const saved = saveModelAssignment(fakeAssignmentTx(), { assignmentId: "eng:ai1:eng:retired", expectedVersion: null, stage: "ai1", deviceId: "eng",
      registryKey: "eng:retired", transport: "direct", rank: 1, role: "primary", vote: false, mode: "live", maxSlots: 1, note: null }, "admin",
    { registry: () => ({ version: 1, models: [fixtures.retired] } as never) });
    await expect(saved).rejects.toThrow("retired_gateway_probe_blocked");
    expect(request).not.toHaveBeenCalled();
    expect(mocks.probeEngineContract).not.toHaveBeenCalled();
  });
});

/** 배정 저장이 probe 전에 읽는 두 SELECT(장비 행·계약 행)만 흉내 낸다 — 잠금·쓰기에는 닿지 않는다. */
function fakeAssignmentTx(): ProductTransaction {
  let selects = 0;
  return {
    select: () => {
      const rows = ++selects === 1 ? [{ deviceId: "eng", version: 1 }] : [];
      const result = Promise.resolve(rows) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
      result.limit = () => Promise.resolve(rows);
      return { from: () => ({ where: () => result }) };
    },
  } as unknown as ProductTransaction;
}

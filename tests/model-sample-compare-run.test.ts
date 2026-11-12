import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SampleComparison, SampleItem } from "@/lib/operations/model-sample-compare";

/**
 * 표본 비교의 요청(기록)과 한국어 소개 잡의 한 걸음 — DB·장부·모델은 바꿔 끼우고, 무엇을 고르고 무엇을 남기는지만 본다.
 * 장부를 거치는 호출 자체(translateKoreanTaglinesWithModelCapacity)는 tests/korean-tagline-model-capacity.test.ts 가 본다.
 */
const mocks = vi.hoisted(() => ({
  connections: vi.fn(), ranks: vi.fn(), readiness: vi.fn(), prepare: vi.fn(), saveResources: vi.fn(), pending: vi.fn(), inserts: [] as { table: unknown; value: unknown }[],
  openRow: [] as unknown[], claim: vi.fn(), save: vi.fn(), batch: vi.fn(), translate: vi.fn(), bind: vi.fn(), raw: vi.fn(), find: vi.fn(), cancel: vi.fn(),
}));
vi.mock("@/lib/operations/admin-ai-tasks-repository", () => ({ listAiConnections: mocks.connections, listAiTaskRows: mocks.ranks, readAiTaskReadinessInput: async () => ({}),
  prepareAiTaskServingResources: mocks.prepare, saveAiTaskServingResources: mocks.saveResources, aiTaskCrossResourceIssues: () => [] }));
vi.mock("@/lib/operations/admin-ai-tasks", async original => ({ ...await original<object>(), aiRanksReadiness: mocks.readiness }));
vi.mock("@/lib/domain/products/korean-taglines", () => ({ homeListSlugs: async () => [], pendingKoreanTaglines: mocks.pending, pendingKoreanTaglineBatch: mocks.batch,
  koreanTaglineSource: (task: { tagline: string }) => task.tagline }));
vi.mock("@/lib/operations/dr/epoch", () => ({ writerSiteActive: async () => true, DrWriterFencedError: class extends Error {} }));
vi.mock("@/lib/operations/admin-log", () => ({ adminAuditRow: async (actor: string, entry: object) => ({ actor, ...entry }) }));
vi.mock("@/lib/db", () => {
  const chain = { from: () => chain, where: () => chain, limit: async () => mocks.openRow };
  const tx = {
    execute: async () => [],
    select: () => chain,
    insert: (table: unknown) => ({ values: (value: unknown) => { mocks.inserts.push({ table, value }); return Object.assign(Promise.resolve(), { returning: async () => [{ id: 7 }] }); } }),
  };
  return { db: { transaction: async (run: (value: typeof tx) => unknown) => run(tx), execute: mocks.raw }, onPrimary: (run: () => unknown) => run() };
});
// 잡 걸음 쪽
vi.mock("@/lib/domain/products/korean-tagline-model-capacity", () => ({ translateKoreanTaglinesWithModelCapacity: mocks.translate }));
vi.mock("@/lib/llm/ai-task-resolver", () => ({ bindApiTaskRank: mocks.bind }));
vi.mock("@/lib/llm/serving-contract-store", () => ({ ensureServingContracts: async () => undefined }));
vi.mock("@/lib/llm/product-tagline-ko-serving-contract", () => ({ productTaglineKoServingProvider: () => "abcllm" }));
vi.mock("@/lib/llm/capacity-repository", () => ({ findOwnPendingProductTextRequests: mocks.find, cancelOwnPendingProductTextRequest: mocks.cancel }));
vi.mock("@/lib/llm/model-registry", async original => ({ ...await original<object>(), modelRouteTimeoutMs: () => 30_000 }));
vi.mock("@/lib/jobs/tick-deadline", () => ({ tickRemaining: () => () => 50_000 }));
vi.mock("@/lib/operations/model-sample-compare-repository", async original => ({ ...await original<object>(),
  claimModelSampleComparison: mocks.claim, saveModelSampleProgress: mocks.save }));

import { requestModelSampleComparison } from "@/lib/operations/model-sample-compare-repository";
import { runKoreanTaglineSampleStep } from "@/lib/jobs/products/korean-tagline-sample";
import { modelSampleComparisons, operationsAudit } from "@/lib/db/schema";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { modelFixtureConnections } from "./fixtures/model-console";

const CANDIDATE = "4d2c7f1e-0000-4000-8000-00000000e1a0", CURRENT = "4d2c7f1e-0000-4000-8000-0000000000a1";
const connections = () => modelFixtureConnections().map(row => row.id === "conn-m1max" ? { ...row, id: CANDIDATE } : row.id === "conn-m3-gpt-oss" ? { ...row, id: CURRENT } : row);
const queue = Array.from({ length: 120 }, (_, index) => ({ productId: 1000 + index, name: `p${index}`, repoUrl: null, tagline: `Tool number ${index}`, attempts: 0,
  lastError: null, qualityRejections: 0 }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserts.length = 0; mocks.openRow = [];
  mocks.connections.mockResolvedValue(connections());
  mocks.ranks.mockResolvedValue([{ task: "product-tagline-ko", slot: 1, rank: 1, connectionId: CURRENT, model: "gpt-oss-120b", enabled: true, options: {} }]);
  mocks.readiness.mockReturnValue([{ blocking: [], warnings: [] }]);
  mocks.prepare.mockResolvedValue({ ok: true, contracts: [], cliContracts: [], localContracts: [] });
  mocks.saveResources.mockResolvedValue({ contracts: ["product-tagline-ko · mlx-community/Qwen3.8-27B-4bit (#91)"], devices: [], routes: [], policyRevision: 33 });
  mocks.pending.mockResolvedValue(queue);
});

describe("표본 비교 요청 — 기록과 감사", () => {
  it("대기 일감에서 표본을 골라 비교 줄과 감사 한 줄을 남긴다(지금 모델 = 1순위), 후보의 부를 길은 순위 저장과 같은 준비로", async () => {
    const result = await requestModelSampleComparison({ task: "product-tagline-ko", connectionId: CANDIDATE, model: "mlx-community/Qwen3.8-27B-4bit", size: 20 }, "jr");
    expect(result).toEqual({ ok: true, id: 7, size: 20, created: ["product-tagline-ko · mlx-community/Qwen3.8-27B-4bit (#91)"] });
    const row = mocks.inserts.find(entry => entry.table === modelSampleComparisons)!.value as { candidate: unknown; current: unknown; sampleSize: number; items: SampleItem[] };
    expect(row.candidate).toEqual({ connectionId: CANDIDATE, model: "mlx-community/Qwen3.8-27B-4bit", name: "M1max" });
    expect(row.current).toEqual({ connectionId: CURRENT, model: "gpt-oss-120b", name: "m3-gpt-oss" });
    expect(row.sampleSize).toBe(20);
    // 맨 앞 32건(실제 잡이 곧 집어 갈 것)은 표본에 없다
    expect(Math.min(...row.items.map(item => item.productId))).toBeGreaterThanOrEqual(1032);
    expect(row.items[0]).toMatchObject({ name: expect.any(String), text: expect.stringMatching(/^Tool number/), current: null, candidate: null });
    const audit = mocks.inserts.find(entry => entry.table === operationsAudit)!.value as { action: string; target: string; detail: { productIds: number[] } };
    expect([audit.action, audit.target, audit.detail.productIds]).toEqual(["model-sample-compare-request", "product-tagline-ko#7", row.items.map(item => item.productId)]);
    // 준비는 후보 하나를 1순위 자리로 — 순위 행은 쓰지 않는다
    expect(mocks.readiness.mock.calls[0][1]).toEqual([expect.objectContaining({ rank: 1, model: "mlx-community/Qwen3.8-27B-4bit" })]);
  });

  it("지원 안 함 · 이미 1순위 · 쉬는 모델 · 열린 비교는 아무것도 쓰지 않고 까닭을 돌려준다", async () => {
    expect(await requestModelSampleComparison({ task: "product-translate", connectionId: CANDIDATE, model: "x", size: 5 }, "jr"))
      .toMatchObject({ ok: false, issues: [expect.stringMatching(/^지원 안 함 — 공개 번역은/)] });
    expect(await requestModelSampleComparison({ task: "product-tagline-ko", connectionId: CURRENT, model: "gpt-oss-120b", size: 5 }, "jr"))
      .toMatchObject({ ok: false, issues: ["이미 이 단계의 1순위 모델입니다. 다른 후보를 고르세요."] });
    mocks.connections.mockResolvedValue(connections().map(row => row.id === CANDIDATE ? { ...row, enabled: false } : row));
    expect(await requestModelSampleComparison({ task: "product-tagline-ko", connectionId: CANDIDATE, model: "mlx-community/Qwen3.8-27B-4bit", size: 5 }, "jr"))
      .toMatchObject({ ok: false, issues: ["쉬는 중인 모델은 비교할 수 없습니다. 먼저 켜세요."] });
    mocks.connections.mockResolvedValue(connections());
    mocks.openRow = [{ id: 3 }];
    expect(await requestModelSampleComparison({ task: "product-tagline-ko", connectionId: CANDIDATE, model: "mlx-community/Qwen3.8-27B-4bit", size: 5 }, "jr"))
      .toMatchObject({ ok: false, issues: ["이 작업에 아직 끝나지 않은 비교가 있습니다. 끝난 뒤 다시 요청하세요."] });
    expect(mocks.inserts).toEqual([]);
  });
});

describe("한국어 소개 잡의 비교 한 걸음", () => {
  const ctx = { lease: { name: "product-tagline-ko", token: "t", requestedVersion: 1 } as never, log: vi.fn(), hasBudget: () => true };
  const items = (): SampleItem[] => [1, 2, 3].map(id => ({ productId: id, name: `p${id}`, text: `Tool number ${id}`, current: null, candidate: null }));
  const record = (over: Partial<SampleComparison> = {}): SampleComparison => ({ id: 7, task: "product-tagline-ko", status: "running", statusCode: null,
    candidate: { connectionId: CANDIDATE, model: "q", name: "M1max" }, current: { connectionId: CURRENT, model: "gpt-oss-120b", name: "m3-gpt-oss" }, size: 3, items: items(),
    deferrals: 0, requestedBy: "jr", requestedAt: "2026-11-12T00:00:00.000Z", startedAt: null, finishedAt: null, ...over });
  const tasks = (ids: number[]) => ids.map(id => ({ productId: id, name: `p${id}`, repoUrl: null, tagline: `Tool number ${id}`, attempts: 0, lastError: null, qualityRejections: 0 }));
  beforeEach(() => {
    mocks.raw.mockResolvedValue([{ task: "product-tagline-ko", slot: 1, rank: 1, model: "gpt-oss-120b", enabled: true, options: {}, connection_id: CURRENT, label: "m3-gpt-oss",
      kind: "api", base_url: "https://m3.example/v1", api_key_ciphertext: null, cli_tool: null, device_id: "m3-mlx", connection_enabled: true, models: [], connection_options: {},
      connection_version: 3, cli_models: [], capacity_slots: 2 }]);
    mocks.bind.mockReturnValue({ binding: { routeId: "product-tagline-ko", rank: 1, connectionId: CURRENT, connectionLabel: "m3-gpt-oss", identity: "gpt-oss-120b",
      engineModel: "gpt-oss-120b", provider: "abcllm", bearer: null, deviceId: "m3-mlx" }, unusable: null });
    mocks.save.mockResolvedValue(true);
    mocks.find.mockResolvedValue([]);
  });

  it("열린 비교가 없으면 아무것도 하지 않는다", async () => {
    mocks.claim.mockResolvedValue(null);
    expect(await runKoreanTaglineSampleStep(ctx)).toEqual({ kind: "idle" });
    expect(mocks.translate).not.toHaveBeenCalled();
  });

  it("지금 모델 쪽 한 묶음을 실제 경로로 부르고, 품질 검사 결과만 비교 기록에 쓴다(운영 표 쓰기 없음)", async () => {
    mocks.claim.mockResolvedValue(record());
    mocks.batch.mockResolvedValue(tasks([1, 2, 3]));
    mocks.translate.mockResolvedValue({ kind: "result", result: { ok: true, outputs: ["번호 1번 도구", "Tool number 2", "번호 3번 도구"] } });
    const outcome = await runKoreanTaglineSampleStep(ctx);
    expect(outcome).toEqual({ kind: "ran", id: 7, side: "current", called: 3, status: "running" });
    // 장부를 거치는 원래 호출 하나, 결과를 기록하는 쓰기(recordKoreanTaglines)는 부르지 않는다
    expect(mocks.translate).toHaveBeenCalledTimes(1);
    expect(mocks.translate.mock.calls[0][0]).toEqual(tasks([1, 2, 3]));
    const saved = mocks.save.mock.calls[0][1] as { items: SampleItem[]; status: string };
    expect(saved.items.map(item => [item.current?.pass, item.current?.reason ?? null, item.candidate])).toEqual([[true, null, null], [false, "rejected:not_korean", null], [true, null, null]]);
  });

  it("그 사이 옮겨진 표본은 「이미 처리됨」으로 건너뛰고 남은 것만 부른다", async () => {
    mocks.claim.mockResolvedValue(record());
    mocks.batch.mockImplementation(async (keys: string[]) => keys.length > 1 ? null : keys[0] === "product-tagline-ko:2" ? null : tasks([Number(keys[0].split(":")[1])]));
    mocks.translate.mockResolvedValue({ kind: "result", result: { ok: true, outputs: ["번호 1번 도구", "번호 3번 도구"] } });
    await runKoreanTaglineSampleStep(ctx);
    const saved = mocks.save.mock.calls[0][1] as { items: SampleItem[] };
    expect(saved.items.map(item => item.current?.reason ?? (item.current?.pass ? "pass" : null))).toEqual(["pass", "already_done", "pass"]);
  });

  it("용량으로 미뤄지면 남긴 대기 줄을 물리고 결과 없이 미룸 수만 올린다", async () => {
    mocks.claim.mockResolvedValue(record({ deferrals: 2 }));
    mocks.batch.mockResolvedValue(tasks([1, 2, 3]));
    mocks.translate.mockRejectedValue(new ModelCapacityDeferredError("capacity"));
    const pending = { request: { requestId: "r1" }, memberKeys: ["product-tagline-ko:1", "product-tagline-ko:2", "product-tagline-ko:3"] };
    mocks.find.mockResolvedValue([pending, { request: { requestId: "r2" }, memberKeys: ["product-tagline-ko:99"] }]);
    vi.stubEnv("ROLE_LEASE_INSTANCE_ID", "text-m3"); vi.stubEnv("ROLE_LEASE_BOOT_ID", "6f0c3a52-8f6b-4c8d-9d7e-2a1b3c4d5e6f");
    try { await runKoreanTaglineSampleStep(ctx); } finally { vi.unstubAllEnvs(); }
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.cancel.mock.calls[0][0]).toBe(pending);
    expect(mocks.save.mock.calls[0][1]).toMatchObject({ deferrals: 3, status: "running", items: items() });
  });

  it("후보를 이 단계에서 부를 수 없으면(계약 없음 등) 그 쪽 표본을 까닭과 함께 건너뛴다", async () => {
    mocks.claim.mockResolvedValue(record({ items: items().map(item => ({ ...item, current: { state: "done", output: "가", pass: true } })) }));
    mocks.bind.mockReturnValue({ binding: null, unusable: "no_direct_contract" });
    const outcome = await runKoreanTaglineSampleStep(ctx);
    expect(outcome).toMatchObject({ side: "candidate", called: 0, status: "done" });
    expect((mocks.save.mock.calls[0][1] as { items: SampleItem[] }).items.every(item => item.candidate?.reason === "unusable:no_direct_contract")).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ verify: vi.fn(), verifications: vi.fn(), verifyWrite: vi.fn(), choose: vi.fn() }));
vi.mock("@/lib/llm/ai-task-workload-selector", () => ({ chooseTaskWorkloadMember: mocks.choose }));
// 고정 대상의 지난 모델을 장부에서 찾는 읽기 — 이 시험에는 지난 요청이 없다
vi.mock("@/lib/llm/text-task-pool-resume", () => ({ pendingTextPoolTargetModel: async () => null, pendingTextPoolModel: async () => null }));
vi.mock("@/lib/domain/products/search-profiles", () => ({ pendingVerifications: mocks.verifications, recordVerificationResult: mocks.verifyWrite,
  readSearchVerifyAffinityMember: async (task: { product: { id: number } }) => ({ productId: task.product.id }), restExpiredVerification: async () => false }));
vi.mock("@/lib/domain/products/search-verify-model-capacity", () => ({
  verifyKeywordsWithModelCapacity: async (task: { product: { id: number } }) => ({ kind: "result", result: await mocks.verify(task.product.id) }),
}));
import { verifySearchKeywords } from "@/lib/jobs/products/search-verify";
import { setAiTaskExecutionConfigsForTest } from "@/lib/llm/ai-task-execution-snapshot";
import type { AiTaskExecutionConfig, AiTaskPoolMember } from "@/lib/llm/ai-task-execution-config";
import { textTaskModel, type TextTaskRankBinding } from "@/lib/llm/ai-task-rank-scope";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import type { JobContext } from "@/lib/jobs/runner";
import { pinTextRanks, textContract, textRankRow } from "./text-task-ranks-fixture";

/**
 * 검색 키워드 검수의 「동시에」(2026-11-12) — 제품마다 한 호출인 줄 구조(키워드 짓기·수집 소개 짓기도 같은 꼴)에서
 * 칸 수의 합만큼 줄이 함께 돌고, 구성원마다 칸 수를 넘지 않으며, 한 구성원이 서면 그 제품만 넘기고 남은 구성원이 계속한다.
 */
const JOB = "product-search-verify";
const QWEN = "gpu3090-qwen", M1 = "m1max", QWEN_BASE = "http://qwen.test:8000/v1", M1_BASE = "http://m1.test:8000/v1";
const member = (memberId: string, model: string, connectionId: string, baseUrl: string, position: number, maxSlots: number | null): AiTaskPoolMember =>
  Object.freeze({ memberId, position, connectionId, model, options: {}, canonicalModel: model, deviceId: "test-device", engineKey: "0".repeat(64), maxSlots,
    connection: textRankRow(JOB, model, { connectionId, baseUrl, label: model }).connection });
const QWEN_MEMBER = "0b0c0d0e-0000-4000-8000-00000000aaaa";
const pool = (qwenSlots: number | null, m1Slots: number | null): AiTaskExecutionConfig => Object.freeze({ task: JOB, slot: 1, mode: "workload_pool",
  revision: 3, updatedAt: null, reserveRanks: false, members: [member(QWEN_MEMBER, QWEN, "0b0c0d0e-0000-4000-8000-0000000000a1", QWEN_BASE, 1, qwenSlots),
    member("0b0c0d0e-0000-4000-8000-00000000bbbb", M1, "0b0c0d0e-0000-4000-8000-0000000000b1", M1_BASE, 2, m1Slots)] });
const context = (): JobContext<null> => ({ cursor: null, lease: { name: JOB, token: "fixture-token", requestedVersion: 1 }, hasBudget: () => true, save: vi.fn(), log: vi.fn() });
const task = (id: number) => ({ product: { id, slug: `doc-${id}`, name: `Doc ${id}`, url: `https://doc-${id}.test`, category: "Tools", tagline: "Document tool",
  description: "Manage documents", status: "verified", searchTopics: null, searchPageText: null, searchReadme: null },
  profile: { keywordsEn: ["document tool"], keywordsKo: [], verifyError: null }, reviewerNote: null });

const done = new Set<number>(), models = new Map<number, string>();
let now = new Map<string, number>(), max = new Map<string, number>(), total = 0, maxTotal = 0;
beforeEach(() => {
  vi.resetAllMocks();
  done.clear(); models.clear(); now = new Map(); max = new Map(); total = 0; maxTotal = 0;
  pinTextRanks([]);
  setServingContractSnapshotForTest([textContract(JOB, QWEN, { baseUrl: QWEN_BASE }), textContract(JOB, M1, { baseUrl: M1_BASE })]);
  // DB 처럼: 끝낸 제품·이번 틱에 집은 제품은 다시 나오지 않는다
  const all = Array.from({ length: 10 }, (_, index) => task(index + 1));
  mocks.verifications.mockImplementation(async (limit: number, exclude: number[]) => all.filter(row => !done.has(row.product.id) && !exclude.includes(row.product.id)).slice(0, limit));
  mocks.verifyWrite.mockImplementation(async (row: { product: { id: number } }) => { done.add(row.product.id); return true; });
  mocks.choose.mockImplementation(async (_config, candidates: readonly TextTaskRankBinding[]) => candidates[0] ?? null);
});
afterEach(() => { setAiTaskExecutionConfigsForTest(null); setServingContractSnapshotForTest(null); pinTextRanks(null); });
const call = async (id: number, fail?: (model: string) => void) => {
  const model = textTaskModel(JOB);
  fail?.(model);
  now.set(model, (now.get(model) ?? 0) + 1); max.set(model, Math.max(max.get(model) ?? 0, now.get(model)!)); total++; maxTotal = Math.max(maxTotal, total);
  await new Promise(resolve => setTimeout(resolve, 10));
  now.set(model, now.get(model)! - 1); total--; models.set(id, model);
  return { ok: true, unsupported: [] };
};

describe("검색 키워드 검수 「동시에」", () => {
  it("칸 수(qwen 3 · m1 2)의 합 5줄이 함께 돌고(단계 동시 수 4를 넘어), 구성원마다 칸 수를 넘지 않는다", async () => {
    setAiTaskExecutionConfigsForTest([pool(3, 2)]);
    mocks.verify.mockImplementation((id: number) => call(id));
    const ctx = context();
    expect(await verifySearchKeywords(ctx)).toEqual({ done: true });
    expect(done.size).toBe(10);
    expect(maxTotal).toBe(5);
    expect(max.get(QWEN)).toBe(3);
    expect(max.get(M1)).toBe(2);
    expect(ctx.log).toHaveBeenLastCalledWith("ai_task.ranks", expect.objectContaining({ pool_lanes: 5, pool_members: 2 }));
  });

  it("한 구성원이 서면 그 제품만 넘기고(다른 구성원에 넘기지 않음) 남은 구성원이 나머지를 끝낸다", async () => {
    setAiTaskExecutionConfigsForTest([pool(1, 1)]);
    const refused: number[] = [];
    mocks.verify.mockImplementation((id: number) => call(id, model => {
      if (model === QWEN) { refused.push(id); throw new ModelCapacityDeferredError("model_quota"); }
    }));
    const ctx = context();
    expect(await verifySearchKeywords(ctx)).toEqual({ done: false });
    expect(refused).toHaveLength(1);
    expect(models.has(refused[0])).toBe(false);
    expect(done.size).toBe(9);
    expect([...models.values()].every(model => model === M1)).toBe(true);
    expect(ctx.log).toHaveBeenCalledWith("search_verify.skipped", { productId: refused[0], reason: "model_quota" });
    expect(ctx.log).toHaveBeenLastCalledWith("ai_task.ranks", expect.objectContaining({ [`member_unusable.${QWEN_MEMBER}.model_quota`]: 1 }));
  });

  it("칸 수를 적지 않은 옛 묶음은 예전처럼 단계 동시 수(4)만큼", async () => {
    setAiTaskExecutionConfigsForTest([pool(null, null)]);
    mocks.verify.mockImplementation((id: number) => call(id));
    expect(await verifySearchKeywords(context())).toEqual({ done: true });
    expect(maxTotal).toBe(4);
    expect(done.size).toBe(10);
  });
});

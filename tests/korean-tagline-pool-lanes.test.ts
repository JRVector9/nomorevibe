import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ translate: vi.fn(), tasks: vi.fn(), write: vi.fn(), choose: vi.fn() }));
vi.mock("@/lib/llm/ai-task-workload-selector", () => ({ chooseTaskWorkloadMember: mocks.choose }));
vi.mock("@/lib/llm/text-task-pool-resume", () => ({ pendingTextPoolTargetModel: async () => null, pendingTextPoolModel: async () => null }));
vi.mock("@/lib/llm/capacity-repository", async load => ({
  ...await load<typeof import("@/lib/llm/capacity-repository")>(), readModelCapacityCallerControl: async () => ({ mode: "open" }) }));
vi.mock("@/lib/domain/products/korean-taglines", async load => ({
  ...await load<typeof import("@/lib/domain/products/korean-taglines")>(), homeListSlugs: async () => [], pendingKoreanTaglines: mocks.tasks,
  recordKoreanTaglines: mocks.write }));
vi.mock("@/lib/domain/products/korean-tagline-model-capacity", () => ({
  translateKoreanTaglinesWithModelCapacity: async (tasks: readonly { productId: number }[]) => ({ kind: "result", result: await mocks.translate(tasks) }),
}));
import { writeKoreanTaglines } from "@/lib/jobs/products/korean-tagline";
import { setAiTaskExecutionConfigsForTest } from "@/lib/llm/ai-task-execution-snapshot";
import type { AiTaskExecutionConfig, AiTaskPoolMember } from "@/lib/llm/ai-task-execution-config";
import { textTaskModel, type TextTaskRankBinding } from "@/lib/llm/ai-task-rank-scope";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import type { JobContext } from "@/lib/jobs/runner";
import { pinTextRanks, textContract, textRankRow } from "./text-task-ranks-fixture";

/**
 * 한국어 소개의 「동시에」(2026-11-12) — 바퀴마다 줄 수만큼 묶음을 만들어 함께 보내는 구조. 칸 수의 합만큼 묶음이 함께 돌고, 구성원마다 칸 수를 넘지 않는다.
 * 결과 품질 검사(checkKoreanTaglineOutput)는 어느 구성원이 답했든 같은 검사를 거쳐 기록된다.
 */
const JOB = "product-tagline-ko";
const QWEN = "gpu3090-qwen", M1 = "m1max", QWEN_BASE = "http://qwen.test:8000/v1", M1_BASE = "http://m1.test:8000/v1";
const member = (memberId: string, model: string, connectionId: string, baseUrl: string, position: number, maxSlots: number | null): AiTaskPoolMember =>
  Object.freeze({ memberId, position, connectionId, model, options: {}, canonicalModel: model, deviceId: "test-device", engineKey: "0".repeat(64), maxSlots,
    connection: textRankRow(JOB, model, { connectionId, baseUrl, label: model }).connection });
const pool = (qwenSlots: number | null, m1Slots: number | null): AiTaskExecutionConfig => Object.freeze({ task: JOB, slot: 1, mode: "workload_pool",
  revision: 6, updatedAt: null, reserveRanks: false, members: [member("0b0c0d0e-0000-4000-8000-00000000aaaa", QWEN, "0b0c0d0e-0000-4000-8000-0000000000a1", QWEN_BASE, 1, qwenSlots),
    member("0b0c0d0e-0000-4000-8000-00000000bbbb", M1, "0b0c0d0e-0000-4000-8000-0000000000b1", M1_BASE, 2, m1Slots)] });
const context = (): JobContext<null> => ({ cursor: null, lease: { name: JOB, token: "fixture-token", requestedVersion: 1 }, hasBudget: () => true, save: vi.fn(), log: vi.fn() });
// 두 번 실패한 소개는 혼자 보낸다(soloAttempts 2) — 묶음 하나에 소개 하나가 되게
const task = (productId: number) => ({ productId, name: `Doc ${productId}`, tagline: "Document tool", repoUrl: null, attempts: 2 });

type Entry = { task: { productId: number }; result: { kind: string; model: string; line?: string; error?: string } };
const written = new Map<number, Entry["result"]>();
let now = new Map<string, number>(), max = new Map<string, number>(), total = 0, maxTotal = 0;
beforeEach(() => {
  vi.resetAllMocks();
  written.clear(); now = new Map(); max = new Map(); total = 0; maxTotal = 0;
  pinTextRanks([]);
  setServingContractSnapshotForTest([textContract(JOB, QWEN, { baseUrl: QWEN_BASE }), textContract(JOB, M1, { baseUrl: M1_BASE })]);
  const all = Array.from({ length: 6 }, (_, index) => task(index + 1));
  mocks.tasks.mockImplementation(async (limit: number) => all.filter(row => !written.has(row.productId)).slice(0, limit));
  mocks.write.mockImplementation(async (entries: Entry[]) => { for (const entry of entries) written.set(entry.task.productId, entry.result); return entries.length; });
  mocks.choose.mockImplementation(async (_config, candidates: readonly TextTaskRankBinding[]) => candidates[0] ?? null);
  mocks.translate.mockImplementation(async (tasks: readonly { productId: number }[]) => {
    const model = textTaskModel(JOB);
    now.set(model, (now.get(model) ?? 0) + 1); max.set(model, Math.max(max.get(model) ?? 0, now.get(model)!)); total++; maxTotal = Math.max(maxTotal, total);
    await new Promise(resolve => setTimeout(resolve, 10));
    now.set(model, now.get(model)! - 1); total--;
    // qwen 의 답 하나는 한국어가 아니다 — 어느 구성원의 답이든 같은 검사가 거른다
    return { ok: true, outputs: tasks.map(row => model === QWEN && row.productId === 1 ? "Document tool" : "문서를 다루는 도구") };
  });
});
afterEach(() => { setAiTaskExecutionConfigsForTest(null); setServingContractSnapshotForTest(null); pinTextRanks(null); });

describe("한국어 소개 「동시에」", () => {
  it("칸 수(qwen 2 · m1 1)의 합 3묶음이 함께 돌고, 구성원마다 칸 수를 넘지 않으며, 결과 검사는 구성원과 관계없이 같다", async () => {
    setAiTaskExecutionConfigsForTest([pool(2, 1)]);
    const ctx = context();
    expect(await writeKoreanTaglines(ctx)).toEqual({ done: true });
    expect(written.size).toBe(6);
    expect(maxTotal).toBe(3);
    expect(max.get(QWEN)).toBe(2);
    expect(max.get(M1)).toBe(1);
    expect(new Set([...written.values()].map(result => result.model))).toEqual(new Set([QWEN, M1]));
    const first = written.get(1)!;
    if (first.model === QWEN) expect(first).toMatchObject({ kind: "failure", error: expect.stringMatching(/^rejected:/) });
    expect([...written.entries()].filter(([id]) => id !== 1).every(([, result]) => result.kind === "success" && result.line === "문서를 다루는 도구")).toBe(true);
    expect(ctx.log).toHaveBeenLastCalledWith("ai_task.ranks", expect.objectContaining({ pool_lanes: 3, pool_members: 2 }));
  });

  it("칸 수를 적지 않은 옛 묶음은 예전처럼 단계 동시 수(1)만큼", async () => {
    setAiTaskExecutionConfigsForTest([pool(null, null)]);
    expect(await writeKoreanTaglines(context())).toEqual({ done: true });
    expect(maxTotal).toBe(1);
    expect(written.size).toBe(6);
  });
});

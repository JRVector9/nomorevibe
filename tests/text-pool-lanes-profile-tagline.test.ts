import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), profiles: vi.fn(), profileWrite: vi.fn(), tagTasks: vi.fn(), tagWrite: vi.fn(), choose: vi.fn() }));
vi.mock("@/lib/llm/ai-task-workload-selector", () => ({ chooseTaskWorkloadMember: mocks.choose }));
vi.mock("@/lib/llm/text-task-pool-resume", () => ({ pendingTextPoolTargetModel: async () => null, pendingTextPoolModel: async () => null }));
vi.mock("@/lib/jobs/role-leader", async load => ({ ...await load<typeof import("@/lib/jobs/role-leader")>(), roleLeaseFromEnv: () => undefined }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => ({ enabled: true }) }));
vi.mock("@/lib/domain/products/search-profiles", () => ({ pendingProfiles: mocks.profiles, recordProfileResult: mocks.profileWrite, resumedProfileModel: () => null }));
vi.mock("@/lib/domain/products/search-profile-model-capacity", () => ({
  writeKeywordsWithModelCapacity: async (task: { product: { id: number } }) => ({ kind: "result", result: await mocks.call(task.product.id) }) }));
vi.mock("@/lib/crawl/taglines", () => ({ pendingTaglines: mocks.tagTasks, recordTaglineResult: mocks.tagWrite,
  readCrawlTaglineAffinityMember: async (task: { candidate: { id: number } }) => ({ candidateId: task.candidate.id }) }));
vi.mock("@/lib/crawl/tagline-model-capacity", () => ({
  writeCrawlTaglineWithModelCapacity: async (task: { candidate: { id: number } }) => ({ kind: "result", askOrdinal: 1, result: await mocks.call(task.candidate.id) }) }));
import { writeSearchProfiles } from "@/lib/jobs/products/search-profile";
import { writeTaglines } from "@/lib/crawl/jobs/tagline";
import { setAiTaskExecutionConfigsForTest } from "@/lib/llm/ai-task-execution-snapshot";
import type { AiTaskExecutionConfig, AiTaskPoolMember } from "@/lib/llm/ai-task-execution-config";
import { textTaskModel, type TextTaskRankBinding } from "@/lib/llm/ai-task-rank-scope";
import type { AiTextTaskId } from "@/lib/llm/ai-tasks";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import type { JobContext } from "@/lib/jobs/runner";
import { pinTextRanks, textContract, textRankRow } from "./text-task-ranks-fixture";

/**
 * 검색 키워드 짓기·수집 소개 짓기의 「동시에」(2026-11-12) — 제품(후보)마다 한 호출인 줄 구조. 칸 수의 합만큼 줄이 함께 돌고 구성원마다 칸 수를 넘지 않으며,
 * 한 구성원이 서면 그 일만 넘기고 남은 구성원이 계속한다.
 */
const QWEN = "gpu3090-qwen", M1 = "m1max", QWEN_BASE = "http://qwen.test:8000/v1", M1_BASE = "http://m1.test:8000/v1";
const member = (task: string, memberId: string, model: string, connectionId: string, baseUrl: string, position: number, maxSlots: number | null): AiTaskPoolMember =>
  Object.freeze({ memberId, position, connectionId, model, options: {}, canonicalModel: model, deviceId: "test-device", engineKey: "0".repeat(64), maxSlots,
    connection: textRankRow(task, model, { connectionId, baseUrl, label: model }).connection });
const pool = (task: string, qwenSlots: number | null, m1Slots: number | null): AiTaskExecutionConfig => Object.freeze({ task, slot: 1, mode: "workload_pool",
  revision: 8, updatedAt: null, reserveRanks: false, members: [member(task, "0b0c0d0e-0000-4000-8000-00000000aaaa", QWEN, "0b0c0d0e-0000-4000-8000-0000000000a1", QWEN_BASE, 1, qwenSlots),
    member(task, "0b0c0d0e-0000-4000-8000-00000000bbbb", M1, "0b0c0d0e-0000-4000-8000-0000000000b1", M1_BASE, 2, m1Slots)] });
const context = (name: string): JobContext<null> => ({ cursor: null, lease: { name, token: "fixture-token", requestedVersion: 1 }, hasBudget: () => true, save: vi.fn(), log: vi.fn() });
const product = (id: number) => ({ product: { id, slug: `doc-${id}`, name: `Doc ${id}`, url: `https://doc-${id}.test`, category: "Tools",
  tagline: "Document tool", description: "Manage documents", status: "verified", searchTopics: null, searchPageText: null, searchReadme: null }, profile: null, reviewerNote: null });
const candidate = (id: number) => ({ candidate: { id, repo: `fixture/doc-${id}` },
  document: { productUrl: `https://doc-${id}.test`, repoMeta: {}, pageMeta: { title: `Doc ${id}`, textSample: "Document manager" } }, written: null });

const done = new Set<number>(), models = new Map<number, string>();
let routeId: AiTextTaskId = "product-search-profile";
let now = new Map<string, number>(), max = new Map<string, number>(), total = 0, maxTotal = 0;
const scenarios = [
  { name: "product-search-profile" as const, run: writeSearchProfiles, result: { ok: true, en: ["document tool"], ko: ["문서 관리"] }, base: 2, idOf: (row: unknown) => (row as ReturnType<typeof product>).product.id },
  { name: "crawl-tagline" as const, run: writeTaglines, result: { ok: true, tagline: "Document manager", source: "page" }, base: 2, idOf: (row: unknown) => (row as ReturnType<typeof candidate>).candidate.id },
];
beforeEach(() => {
  vi.resetAllMocks();
  done.clear(); models.clear(); now = new Map(); max = new Map(); total = 0; maxTotal = 0;
  pinTextRanks([]);
  const products = Array.from({ length: 10 }, (_, index) => product(index + 1)), candidates = Array.from({ length: 10 }, (_, index) => candidate(index + 1));
  mocks.profiles.mockImplementation(async (limit: number, _role: unknown, exclude: number[]) => products.filter(row => !done.has(row.product.id) && !exclude.includes(row.product.id)).slice(0, limit));
  mocks.profileWrite.mockImplementation(async (row: { product: { id: number } }) => { done.add(row.product.id); return true; });
  mocks.tagTasks.mockImplementation(async (limit: number, selection: { exclude: number[] }) => candidates.filter(row => !done.has(row.candidate.id) && !selection.exclude.includes(row.candidate.id)).slice(0, limit));
  mocks.tagWrite.mockImplementation(async (row: { candidate: { id: number } }) => { done.add(row.candidate.id); return { stored: true, released: false }; });
  mocks.choose.mockImplementation(async (_config, rows: readonly TextTaskRankBinding[]) => rows[0] ?? null);
});
afterEach(() => { setAiTaskExecutionConfigsForTest(null); setServingContractSnapshotForTest(null); pinTextRanks(null); });
const engine = (result: object, fail?: (model: string) => void) => async (id: number) => {
  const model = textTaskModel(routeId);
  fail?.(model);
  now.set(model, (now.get(model) ?? 0) + 1); max.set(model, Math.max(max.get(model) ?? 0, now.get(model)!)); total++; maxTotal = Math.max(maxTotal, total);
  await new Promise(resolve => setTimeout(resolve, 10));
  now.set(model, now.get(model)! - 1); total--; models.set(id, model);
  return result;
};
const setup = (name: AiTextTaskId, qwen: number | null, m1: number | null) => {
  routeId = name;
  setServingContractSnapshotForTest([textContract(name, QWEN, { baseUrl: QWEN_BASE }), textContract(name, M1, { baseUrl: M1_BASE })]);
  setAiTaskExecutionConfigsForTest([pool(name, qwen, m1)]);
};

it.each(scenarios)("$name: 칸 수(qwen 3 · m1 2)의 합 5줄이 함께 돌고 구성원마다 칸 수를 넘지 않는다", async scenario => {
  setup(scenario.name, 3, 2);
  mocks.call.mockImplementation(engine(scenario.result));
  const ctx = context(scenario.name);
  expect((await scenario.run(ctx)).done).toBe(true);
  expect(done.size).toBe(10);
  expect(maxTotal).toBe(5);
  expect(max.get(QWEN)).toBe(3);
  expect(max.get(M1)).toBe(2);
  expect(ctx.log).toHaveBeenLastCalledWith("ai_task.ranks", expect.objectContaining({ pool_lanes: 5 }));
});

it.each(scenarios)("$name: 한 구성원이 서면 그 일만 넘기고 남은 구성원이 나머지를 끝낸다", async scenario => {
  setup(scenario.name, 1, 1);
  const refused: number[] = [];
  let current = 0;
  mocks.call.mockImplementation(async (id: number) => { current = id; return engine(scenario.result, model => {
    if (model === QWEN) { refused.push(current); throw new ModelCapacityDeferredError("route_quota"); }
  })(id); });
  const ctx = context(scenario.name);
  await scenario.run(ctx);
  expect(refused).toHaveLength(1);
  expect(models.has(refused[0])).toBe(false);
  expect(done.size).toBe(9);
  expect([...models.values()].every(model => model === M1)).toBe(true);
});

it.each(scenarios)("$name: 칸 수를 적지 않은 옛 묶음은 예전처럼 단계 동시 수만큼", async scenario => {
  setup(scenario.name, null, null);
  mocks.call.mockImplementation(engine(scenario.result));
  await scenario.run(context(scenario.name));
  expect(maxTotal).toBe(scenario.base);
  expect(done.size).toBe(10);
});

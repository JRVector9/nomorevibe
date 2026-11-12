import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), keyFill: vi.fn(async () => ({ filled: [] })), review: vi.fn(async () => undefined) }));
vi.mock("@/lib/db", () => ({ db: {}, onPrimary: (run: () => unknown) => run() }));
vi.mock("@/lib/observability/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/operations/ai-connection-key-fill", async original => ({ ...await original<object>(), maybeFillConnectionKeys: mocks.keyFill }));
vi.mock("@/lib/crawl/review-task-ranks", async original => ({ ...await original<object>(), ensureReviewTaskRanks: mocks.review }));
vi.mock("@/lib/llm/ai-task-models-snapshot", async original => {
  const actual = await original<typeof import("@/lib/llm/ai-task-models-snapshot")>();
  return { ...actual, withReadOnlyAiTaskModels: <T,>(run: () => T) => { mocks.scope(); return actual.withReadOnlyAiTaskModels(run); } };
});
import { readAiTasksAdminView, setAiTaskDepsForTest } from "@/lib/operations/admin-ai-tasks-repository";
afterEach(() => { setAiTaskDepsForTest(null); vi.clearAllMocks(); });

describe("통합 작업 조회의 간접 snapshot 초기화 보호", () => {
  it("읽기 전용은 전체 조회를 기존 AsyncLocalStorage 범위에 넣고 키 자동 채움을 생략한다", async () => {
    setAiTaskDepsForTest({ current: async () => [] });
    await readAiTasksAdminView({ readOnly: true });
    expect(mocks.scope).toHaveBeenCalledOnce(); expect(mocks.review).toHaveBeenCalledWith(0); expect(mocks.keyFill).not.toHaveBeenCalled();
  });
  it("원래 호출자는 기존 키 자동 채움을 유지한다", async () => {
    setAiTaskDepsForTest({ current: async () => [] });
    await readAiTasksAdminView();
    expect(mocks.scope).not.toHaveBeenCalled(); expect(mocks.keyFill).toHaveBeenCalledOnce();
  });
});

import { beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";

/**
 * 처리량 집계(1초 안팎)를 관리자 화면 여러 곳이 같은 때 부르면 한 번만 센다 — 흐름 판·조치 목록·메뉴 배지가 겹쳐 서로 밀렸다(2026-11-10).
 * 담아 두지는 않는다(끝나면 다음 부름은 새로 센다). 시각을 준 부름(배포 관문 worker-progress-query)은 나누지 않는다.
 */
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), release: [] as (() => void)[] }));
vi.mock("@/lib/db", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@/lib/llm/ai-task-execution-snapshot", async (original) => ({ ...await original<object>(), ensureAiTaskExecutionConfigs: async () => {} }));
vi.mock("@/lib/llm/ai-task-models-snapshot", async (original) => ({ ...await original<object>(), ensureAiTaskModels: async () => {} }));
vi.mock("@/lib/llm/serving-contract-store", async (original) => ({ ...await original<object>(), ensureServingContracts: async () => {} }));
vi.mock("@/lib/crawl/agent-review-repository", () => ({ reviewApprovalPredicate: () => sql`true`, reviewCandidatePredicate: () => sql`true`, starAutoApprovalPredicate: () => sql`true` }));
vi.mock("@/lib/crawl/repository", () => ({ judgementQueuePredicate: () => sql`true` }));
vi.mock("@/lib/operations/categories", () => ({ classificationReadyPredicate: () => sql`true` }));
vi.mock("@/lib/crawl/second-review", () => ({ SECOND_REVIEW_TRANSIENT_ERRORS: ["timeout"], SECOND_REVIEW_RETRY_MS: 3_600_000, TRANSIENT_RETRY_MS: 300_000 }));

import { pipelineThroughput } from "@/lib/operations/throughput";

const settings = { enabled: true, reviewMode: "auto", secondReview: { enabled: true } } as unknown as CrawlSettings;
const row = { key: "fetch", one: 1, five: 3, waiting: 2, oldest: 1, errors: 0, extra: 0, progress: 0, manual: 0 };

beforeEach(() => {
  mocks.release.length = 0;
  mocks.transaction.mockReset().mockImplementation(() => new Promise(resolve => { mocks.release.push(() => resolve([row])); }));
});
const releaseAll = async () => { await vi.waitFor(() => expect(mocks.release.length).toBeGreaterThan(0)); for (const release of mocks.release.splice(0)) release(); };

it("시각 없이 겹친 부름은 한 번만 센다 — 끝나면 다음 부름은 새로 센다", async () => {
  const first = pipelineThroughput(settings), second = pipelineThroughput(settings);
  await releaseAll();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBe(b);
  expect(a.stages[0]).toMatchObject({ key: "fetch", completed5m: 3, waiting: 2 });
  expect(mocks.transaction).toHaveBeenCalledTimes(1);
  const third = pipelineThroughput(settings);
  await releaseAll();
  expect(await third).not.toBe(a);
  expect(mocks.transaction).toHaveBeenCalledTimes(2);
});

it("시각을 준 부름(배포 관문)과 다른 설정은 나누지 않는다 · 실패도 담지 않는다", async () => {
  const now = new Date("2026-11-10T00:00:00Z");
  const reads = [pipelineThroughput(settings, now), pipelineThroughput(settings, now), pipelineThroughput(settings), pipelineThroughput({ ...settings, enabled: false })];
  await vi.waitFor(() => expect(mocks.transaction).toHaveBeenCalledTimes(4));
  await releaseAll();
  expect((await Promise.all(reads))[0].measuredAt).toBe(now.toISOString());
  mocks.transaction.mockRejectedValueOnce(new Error("db"));
  await expect(pipelineThroughput(settings)).rejects.toThrow("db");
  const after = pipelineThroughput(settings);
  await releaseAll();
  expect((await after).stages).toHaveLength(1);
});

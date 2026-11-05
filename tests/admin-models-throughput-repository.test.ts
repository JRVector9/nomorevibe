import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { transaction: (fn: (tx: unknown) => unknown) => fn({ execute: mocks.execute }) }, onPrimary: (fn: () => unknown) => fn() }));
vi.mock("@/lib/db/pool", () => ({ withDbDeadline: (_deadline: number, fn: () => unknown) => fn() }));
import { readAdminModelsObservation } from "@/lib/operations/admin-models-repository";
import { redesignObservation, redesignPolicy, redesignMetrics, redesignRequests, redesignNow } from "./fixtures/admin-models-redesign";
beforeEach(() => { vi.resetAllMocks(); });
it("종료 이력 조회는 settled_at의 최근24시간 범위로 제한하고 실측으로만 집계한다", async () => {
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ observedAt: redesignNow, mode: "open", epoch: 1, revision: 7,
    policy: redesignPolicy, policyHash: redesignObservation().policyHash, updatedAt: redesignNow }])
    .mockResolvedValueOnce(redesignMetrics).mockResolvedValueOnce(redesignRequests).mockResolvedValueOnce([{ ...redesignMetrics[1],
      state: "settled", queuedAt: "2026-10-29T06:59:40.000Z", settledAt: redesignNow, responseOk: true }]);
  const result = await readAdminModelsObservation();
  expect(result.throughput?.byStage["first-review"].hour).toMatchObject({ count: 1, medianMs: 20000 });
  const queries = mocks.execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query).sql);
  expect(queries[2]).toContain("state IN ('waiting','reserved','dispatched','indeterminate')");
  expect(queries[4]).toContain("state='settled' AND settled_at >= transaction_timestamp()-interval '24 hours' AND settled_at <= transaction_timestamp()");
  expect(queries.join(" ")).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/);
});
it("DB 오류나 완전하지 않은 종료 표본을 0건 성공으로 바꾸지 않는다", async () => {
  mocks.execute.mockRejectedValueOnce(new Error("fixture_db_unavailable"));
  expect(await readAdminModelsObservation()).toMatchObject({ error: expect.stringContaining("0건으로 간주하지 않습니다"), observedAt: null });
});
it("기본 상태판은 현재 점유·열린 요청·성공/실패 집계를 유지하고 고급 종료 표본만 생략한다", async () => {
  mocks.execute.mockResolvedValue([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ observedAt: redesignNow, mode: "open", epoch: 1, revision: 7,
    policy: redesignPolicy, policyHash: redesignObservation().policyHash, updatedAt: redesignNow }])
    .mockResolvedValueOnce(redesignMetrics).mockResolvedValueOnce(redesignRequests);
  const result = await readAdminModelsObservation({ throughput: false });
  expect(result).toMatchObject({ error: null, observedAt: redesignNow, mode: "open", epoch: 1, revision: 7 });
  expect(result.rows).toEqual(expect.arrayContaining(redesignMetrics));
  expect(result.requests).toEqual(redesignRequests);
  expect(result.throughput).toBeUndefined();
  const queries = mocks.execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query).sql);
  expect(queries.join(" ")).toContain('AS "succeeded1h"');
  expect(queries.join(" ")).toContain("state IN ('waiting','reserved','dispatched','indeterminate')");
  expect(queries.join(" ")).not.toContain("LIMIT 50001");
  expect(queries.join(" ")).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/);
});
it("고급 기본 reader는 종료 표본 5만건 초과를 계속 미확인으로 처리한다", async () => {
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ observedAt: redesignNow, mode: "open", epoch: 1, revision: 7,
    policy: redesignPolicy, policyHash: redesignObservation().policyHash, updatedAt: redesignNow }])
    .mockResolvedValueOnce(redesignMetrics).mockResolvedValueOnce(redesignRequests).mockResolvedValueOnce(Array(50_001).fill({}));
  expect(await readAdminModelsObservation()).toMatchObject({ error: expect.stringContaining("0건으로 간주하지 않습니다"), observedAt: null });
});

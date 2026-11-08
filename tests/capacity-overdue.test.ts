import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * 주인 스스로의 「전송 중」 정리(capacity-overdue). 2026-11-07 키워드 검수 호출 835e8cc3 이 주인이 살아 있는 채 dispatched 로 5시간
 * 남아 supa 칸 하나와 배포 관문을 묶었다. 기한 + 여유가 지나도 행이 dispatched 면 주인이 commit_unknown 으로 넘긴다.
 */
const mocks = vi.hoisted(() => ({ read: vi.fn(), mark: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelDispatchStates: mocks.read, markModelDispatchIndeterminate: mocks.mark }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() } }));
import { OVERDUE_DEFAULT_CALL_MS, OVERDUE_GRACE_MS, overdueTrackedForTest, resetOverdueDispatchesForTest,
  sweepOverdueDispatches, trackOverdueDispatch } from "@/lib/llm/capacity-overdue";
import type { ModelCapacityDispatch } from "@/lib/llm/capacity";

const owner = { instanceId: "m3-text", bootId: randomUUID() };
const T0 = 1_794_079_555_259;
function dispatch(binding?: Record<string, unknown>): ModelCapacityDispatch {
  return { requestId: randomUUID(), owner, token: randomUUID(), epoch: 1, revision: 23, policyHash: "p".repeat(64),
    ...(binding ? { binding, bindingHash: "b".repeat(64) } : {}) } as unknown as ModelCapacityDispatch;
}
const row = (value: ModelCapacityDispatch, patch: Record<string, unknown> = {}) => ({ requestId: value.requestId, state: "dispatched",
  ownerInstanceId: owner.instanceId, ownerBootId: owner.bootId,
  dispatchBindingHash: (value as { bindingHash?: string }).bindingHash ?? null, ...patch });
const states = (...rows: ReturnType<typeof row>[]) => new Map(rows.map(item => [item.requestId, item]));

beforeEach(() => { vi.resetAllMocks(); resetOverdueDispatchesForTest(); mocks.mark.mockResolvedValue(true); });
afterEach(() => resetOverdueDispatchesForTest());

it("uses the binding deadline when the route carries one, otherwise a generous call ceiling", () => {
  const verify = dispatch({ kind: "search_verify_gateway", deadlineAt: T0 + 60_000 }), legacy = dispatch();
  trackOverdueDispatch(verify, "product-search-verify", T0);
  trackOverdueDispatch(legacy, "product-translate", T0);
  expect(overdueTrackedForTest().get(verify.requestId)?.overdueAt).toBe(T0 + 60_000 + OVERDUE_GRACE_MS);
  expect(overdueTrackedForTest().get(legacy.requestId)?.overdueAt).toBe(T0 + OVERDUE_DEFAULT_CALL_MS + OVERDUE_GRACE_MS);
});

it("does not touch the ledger before any tracked dispatch is overdue", async () => {
  trackOverdueDispatch(dispatch({ kind: "search_verify_gateway", deadlineAt: T0 + 60_000 }), "product-search-verify", T0);
  expect(await sweepOverdueDispatches(T0 + 60_000 + OVERDUE_GRACE_MS - 1)).toEqual({ due: 0, marked: 0, dropped: 0, failed: 0 });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.mark).not.toHaveBeenCalled();
});

it("marks its own still-dispatched overdue row commit_unknown and forgets it", async () => {
  const stuck = dispatch({ kind: "search_verify_gateway", deadlineAt: T0 + 60_000 });
  trackOverdueDispatch(stuck, "product-search-verify", T0);
  mocks.read.mockResolvedValue(states(row(stuck)));
  expect(await sweepOverdueDispatches(T0 + 60_000 + OVERDUE_GRACE_MS)).toEqual({ due: 1, marked: 1, dropped: 0, failed: 0 });
  expect(mocks.read).toHaveBeenCalledWith([stuck.requestId]);
  expect(mocks.mark).toHaveBeenCalledWith(stuck, "commit_unknown");
  expect(overdueTrackedForTest().has(stuck.requestId)).toBe(false);
  expect(mocks.warn).toHaveBeenCalledWith("model_capacity.overdue_dispatch_marked",
    expect.objectContaining({ requestId: stuck.requestId, routeId: "product-search-verify" }));
});

it("drops settled, missing, foreign-owner and re-bound rows without opening a mark TX", async () => {
  const settled = dispatch({ kind: "x", deadlineAt: T0 }), missing = dispatch({ kind: "x", deadlineAt: T0 });
  const foreign = dispatch({ kind: "x", deadlineAt: T0 }), rebound = dispatch({ kind: "x", deadlineAt: T0 });
  const rolledBack = dispatch({ kind: "x", deadlineAt: T0 });
  for (const value of [settled, missing, foreign, rebound, rolledBack]) trackOverdueDispatch(value, "product-translate", T0);
  mocks.read.mockResolvedValue(states(row(settled, { state: "settled" }), row(foreign, { ownerBootId: randomUUID() }),
    row(rebound, { dispatchBindingHash: "c".repeat(64) }), row(rolledBack, { state: "reserved" })));
  expect(await sweepOverdueDispatches(T0 + OVERDUE_GRACE_MS)).toEqual({ due: 5, marked: 0, dropped: 5, failed: 0 });
  expect(mocks.mark).not.toHaveBeenCalled();
  expect(overdueTrackedForTest().size).toBe(0);
});

it("keeps a row whose mark failed and retries it on the next sweep", async () => {
  const stuck = dispatch({ kind: "search_verify_gateway", deadlineAt: T0 });
  trackOverdueDispatch(stuck, "product-search-verify", T0);
  mocks.read.mockResolvedValue(states(row(stuck)));
  mocks.mark.mockRejectedValueOnce(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
  expect(await sweepOverdueDispatches(T0 + OVERDUE_GRACE_MS)).toMatchObject({ marked: 0, failed: 1 });
  expect(overdueTrackedForTest().has(stuck.requestId)).toBe(true);
  expect(await sweepOverdueDispatches(T0 + OVERDUE_GRACE_MS + 30_000)).toMatchObject({ marked: 1, failed: 0 });
  expect(mocks.mark).toHaveBeenCalledTimes(2);
  expect(overdueTrackedForTest().has(stuck.requestId)).toBe(false);
});

it("keeps every due row when the state read fails", async () => {
  const stuck = dispatch({ kind: "x", deadlineAt: T0 });
  trackOverdueDispatch(stuck, "product-translate", T0);
  mocks.read.mockRejectedValue(new Error("connection terminated"));
  expect(await sweepOverdueDispatches(T0 + OVERDUE_GRACE_MS)).toEqual({ due: 1, marked: 0, dropped: 0, failed: 1 });
  expect(mocks.mark).not.toHaveBeenCalled();
  expect(overdueTrackedForTest().has(stuck.requestId)).toBe(true);
});

it("forgets a row the locked mark no longer owns", async () => {
  const stuck = dispatch({ kind: "x", deadlineAt: T0 });
  trackOverdueDispatch(stuck, "product-translate", T0);
  mocks.read.mockResolvedValue(states(row(stuck)));
  mocks.mark.mockResolvedValue(false);
  expect(await sweepOverdueDispatches(T0 + OVERDUE_GRACE_MS)).toEqual({ due: 1, marked: 0, dropped: 1, failed: 0 });
  expect(overdueTrackedForTest().has(stuck.requestId)).toBe(false);
});

it("every dispatch_started event carries its dispatch handle, so every non-CLI route is tracked", () => {
  // 새 「전송 중」 경로가 손잡이 없이 사건을 쓰면 주인 정리에서 빠진다. 손잡이 없는 것은 호출처가 없는 옛 beginModelDispatch 하나다.
  const source = readFileSync(new URL("../lib/llm/capacity-repository.ts", import.meta.url), "utf8");
  const calls = source.match(/await event\(tx, changed, ["']dispatch_started["'][^;]*;/g) ?? [];
  expect(calls.length).toBeGreaterThanOrEqual(13);
  expect(calls.filter(call => !/\{ dispatch \}\);$/.test(call))).toEqual([`await event(tx, changed, "dispatch_started", "reserved", "dispatched");`]);
  expect(source).toMatch(/if \(kind === "dispatch_started"\) trackOwnDispatch\(row, evidence\);/);
});

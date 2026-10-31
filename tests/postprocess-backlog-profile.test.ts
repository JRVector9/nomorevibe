import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";

const m = vi.hoisted(() => ({ pending: vi.fn(), record: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/domain/products/search-profiles", () => ({ pendingProfiles: m.pending, recordProfileResult: m.record }));
vi.mock("@/lib/domain/products/search-profile-model-capacity", () => ({ writeKeywordsWithModelCapacity: m.write }));
vi.mock("@/lib/domain/products/search-profile", () => ({ PROFILE_MODEL: "[MLX] gpt-oss-120b", profileEvidence: () => ({}), profileHash: () => "hash" }));
const { writeSearchProfiles } = await import("@/lib/jobs/products/search-profile");

const task = (id: number) => ({ product: { id, name: `p${id}` }, profile: null, reviewerNote: null });
const ctx = () => ({ lease: { name: "product-search-profile", token: "lease", requestedVersion: 1 }, hasBudget: () => true, log: vi.fn(),
  cursor: null, save: vi.fn() }) as unknown as JobContext<null> & { log: ReturnType<typeof vi.fn> };
const roleEnv = { ROLE_LEASE_ROLE: "text", ROLE_LEASE_INSTANCE_ID: "m3-text", ROLE_LEASE_BOOT_ID: "f7d9f24b-c29a-4ebd-b137-ac93196d270e",
  ROLE_LEASE_RELEASE: "r1", ROLE_LEASE_EPOCH: "3" };
let active = 0, peak = 0;
beforeEach(() => {
  vi.clearAllMocks(); active = 0; peak = 0;
  vi.stubEnv("ABCLLM_API_KEY", "test");
  for (const [key, value] of Object.entries(roleEnv)) vi.stubEnv(key, value);
  m.pending.mockResolvedValueOnce([task(1), task(2), task(3), task(4)]).mockResolvedValue([]);
  m.record.mockResolvedValue(true);
  m.write.mockImplementation(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return { kind: "result", result: { ok: true, en: ["list"], ko: ["목록"] } };
  });
});
afterEach(() => vi.unstubAllEnvs());

// 2026-10-31 결정: 다른 route 가 같은 장비에서 기다려도 일꾼을 줄이지 않는다(otherRoutesWaitingOnGroup 양보 삭제) — 하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다
it("keeps the registered concurrency and never consults another route's queue to yield", async () => {
  const context = ctx();
  await expect(writeSearchProfiles(context)).resolves.toEqual({ done: true });
  expect(peak).toBe(2); expect(m.write).toHaveBeenCalledTimes(4);
  expect(context.log.mock.calls.map(([name]) => name)).not.toContain("search_profile.fair_share");
  // 다른 단계의 큐를 읽는 모듈 함수가 더는 없다
  expect(Object.keys(await import("@/lib/llm/capacity-busy-targets"))).not.toContain("otherRoutesWaitingOnGroup");
});

it("processes each product at most once per tick and logs the exact deferral reason", async () => {
  const deferred = new ModelCapacityDeferredError("capacity");
  m.write.mockImplementationOnce(async () => { throw deferred; });
  const context = ctx();
  await expect(writeSearchProfiles(context)).rejects.toBe(deferred);
  const ids = m.write.mock.calls.map(([value]) => value.product.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(context.log).toHaveBeenCalledWith("search_profile.capacity_deferred", expect.objectContaining({ reason: "capacity" }));
});

// 2026-10-31 결정: 한 제품만의 미룸(work_busy·dispatched·ledger_mismatch)은 그 제품만 넘기고 나머지를 짓는다
it.each(["work_busy", "dispatched", "ledger_mismatch"] as const)("skips only the product deferred for its own reason (%s) and writes the rest", async reason => {
  m.write.mockImplementation(async ({ product }: { product: { id: number } }) => {
    if (product.id === 2) throw new ModelCapacityDeferredError(reason);
    return { kind: "result", result: { ok: true, en: ["list"], ko: ["목록"] } };
  });
  const context = ctx();
  await expect(writeSearchProfiles(context)).resolves.toEqual({ done: true });
  expect(m.write.mock.calls.map(([value]) => value.product.id).sort()).toEqual([1, 2, 3, 4]);
  expect(m.record).toHaveBeenCalledTimes(3);
  expect(context.log).toHaveBeenCalledWith("search_profile.passed", { productId: 2, reason });
  // 다음 조회는 넘긴 제품을 다시 집지 않는다(visited)
  expect(m.pending.mock.calls[1][2]).toEqual(expect.arrayContaining([1, 2, 3, 4]));
});

// 2026-10-31 결정: 한 제품의 실패(5xx·시간 초과·429)는 그 제품의 시도로만 남고 다음 제품을 본다 — 잇따라 둘이어도 틱을 접지 않는다
it("records each failed product and keeps going; only a proven engine outage ends the tick", async () => {
  m.write.mockImplementation(async ({ product }: { product: { id: number } }) =>
    ({ kind: "result", result: product.id <= 3 ? { ok: false, error: "http_502" } : { ok: true, en: ["list"], ko: ["목록"] } }));
  const context = ctx();
  await expect(writeSearchProfiles(context)).resolves.toEqual({ done: true });
  expect(m.write).toHaveBeenCalledTimes(4);
  expect(context.log).not.toHaveBeenCalledWith("search_profile.gateway_blocked", expect.anything());
  // 모델이 없다는 답은 모든 제품에 대해 증명된 엔진 탈 — 한 번으로 접는다
  vi.clearAllMocks();
  m.pending.mockResolvedValueOnce([task(5), task(6), task(7)]).mockResolvedValue([]);
  m.record.mockResolvedValue(true);
  m.write.mockImplementation(async () => ({ kind: "result", result: { ok: false, error: "model_unavailable" } }));
  const down = ctx();
  await expect(writeSearchProfiles(down)).resolves.toEqual({ done: true });
  expect(down.log).toHaveBeenCalledWith("search_profile.gateway_blocked", expect.objectContaining({ error: "model_unavailable" }));
  expect(m.write.mock.calls.length).toBeLessThanOrEqual(2);
});

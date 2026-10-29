import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";

const m = vi.hoisted(() => ({ pending: vi.fn(), record: vi.fn(), write: vi.fn(), contended: vi.fn() }));
vi.mock("@/lib/domain/products/search-profiles", () => ({ pendingProfiles: m.pending, recordProfileResult: m.record }));
vi.mock("@/lib/domain/products/search-profile-model-capacity", () => ({ writeKeywordsWithModelCapacity: m.write }));
vi.mock("@/lib/domain/products/search-profile", () => ({ PROFILE_MODEL: "[MLX] gpt-oss-120b", profileEvidence: () => ({}), profileHash: () => "hash" }));
vi.mock("@/lib/llm/capacity-busy-targets", () => ({ otherRoutesWaitingOnGroup: m.contended }));
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

it("uses one worker for the batch while another route waits on the same model group, and says so", async () => {
  m.contended.mockResolvedValue(true);
  const context = ctx();
  await expect(writeSearchProfiles(context)).resolves.toEqual({ done: true });
  expect(m.contended).toHaveBeenCalledWith("product-search-profile", "[MLX] gpt-oss-120b");
  expect(peak).toBe(1); expect(m.write).toHaveBeenCalledTimes(4);
  expect(context.log).toHaveBeenCalledWith("search_profile.fair_share", { concurrency: 1 });
});

it("keeps the registered concurrency when nobody else waits", async () => {
  m.contended.mockResolvedValue(false);
  await writeSearchProfiles(ctx());
  expect(peak).toBe(2); expect(m.write).toHaveBeenCalledTimes(4);
});

it("does not consult the ledger on the legacy path without a role lease", async () => {
  for (const key of Object.keys(roleEnv)) vi.stubEnv(key, undefined as unknown as string);
  m.contended.mockResolvedValue(true);
  await writeSearchProfiles(ctx());
  expect(m.contended).not.toHaveBeenCalled(); expect(peak).toBe(2);
});

it("processes each product at most once per tick and logs the exact deferral reason", async () => {
  m.contended.mockResolvedValue(false);
  const deferred = new ModelCapacityDeferredError("capacity");
  m.write.mockImplementationOnce(async () => { throw deferred; });
  const context = ctx();
  await expect(writeSearchProfiles(context)).rejects.toBe(deferred);
  const ids = m.write.mock.calls.map(([value]) => value.product.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(context.log).toHaveBeenCalledWith("search_profile.capacity_deferred", expect.objectContaining({ reason: "capacity" }));
});

import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), replay: vi.fn(() => null as unknown) }));
vi.mock("@/lib/db", () => ({ db: { execute: mocks.execute }, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: mocks.replay }));
import { blockedFirstReviewerKeys, readBlockedFirstReviewerKeys } from "@/lib/crawl/first-reviewer-blocks";
import { firstReviewerKey } from "@/lib/crawl/first-reviewers";

beforeEach(() => { mocks.execute.mockReset(); mocks.replay.mockReturnValue(null); });

const supa = { routeId: "ai1-supa", provider: "abcllm", model: "[supa] qwen", providerBudgetId: "supa", groupId: "supa-gpu" };
const mlx = { routeId: "ai1-mlx", provider: "abcllm", model: "[MLX] gpt-oss-120b", providerBudgetId: "m3", groupId: "m3-mlx" };
const text = { routeId: "text-mlx", provider: "abcllm", model: "[MLX] text", providerBudgetId: "m3", groupId: "m3-mlx" };
const policy = { version: 1, globalLimit: 8, providerLimits: { supa: 2, m3: 4 }, groupLimits: { "supa-gpu": 1, "m3-mlx": 2 },
  routes: [supa, mlx, text] };

it("blocks a route only when unknown rows fill its group or provider budget", () => {
  expect(blockedFirstReviewerKeys(policy, [])).toEqual(new Set());
  expect(blockedFirstReviewerKeys(policy, [{ groupId: "supa-gpu", providerBudgetId: "supa" }]))
    .toEqual(new Set([firstReviewerKey(supa)]));
  // One unknown in a group of two leaves capacity: not blocked.
  expect(blockedFirstReviewerKeys(policy, [{ groupId: "m3-mlx", providerBudgetId: "m3" }])).toEqual(new Set());
  // A shared physical group blocks every route in it (AI1 and text share M3 MLX).
  expect(blockedFirstReviewerKeys(policy, [{ groupId: "m3-mlx", providerBudgetId: "m3" }, { groupId: "m3-mlx", providerBudgetId: "m3" }]))
    .toEqual(new Set([firstReviewerKey(mlx), firstReviewerKey(text)]));
});

it("treats an unreadable policy as no hint, keeping the original fixed assignment", () => {
  expect(blockedFirstReviewerKeys(null, [{ groupId: "supa-gpu", providerBudgetId: "supa" }])).toEqual(new Set());
  expect(blockedFirstReviewerKeys({ routes: "x" }, [{ groupId: "supa-gpu", providerBudgetId: "supa" }])).toEqual(new Set());
});

it("never reads the ledger: indeterminate rows occupy nothing since 2026-10-30, so no route is blocked by them", async () => {
  mocks.execute.mockResolvedValueOnce([{ policy, unknown: [{ groupId: "supa-gpu", providerBudgetId: "supa" }] }]);
  expect(await readBlockedFirstReviewerKeys()).toEqual(new Set());
  mocks.replay.mockReturnValue({});
  expect(await readBlockedFirstReviewerKeys()).toEqual(new Set());
  expect(mocks.execute).not.toHaveBeenCalled();
});

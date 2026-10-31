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
// PR 1b: 한도는 장비(groupId)별이다. providerLimits 는 한도가 아니라 예산 선언이고 groupLimits 는 장비 행이 없을 때의 대체값이다.
const policy = { version: 1, globalLimit: 8, providerLimits: { supa: 2, m3: 4 }, groupLimits: { "supa-gpu": 1, "m3-mlx": 2 },
  routes: [supa, mlx, text] };

it("blocks a route only when the rows fill its device (policy groupLimits as the fallback limit); the provider budget is not a limit", () => {
  expect(blockedFirstReviewerKeys(policy, [])).toEqual(new Set());
  expect(blockedFirstReviewerKeys(policy, [{ groupId: "supa-gpu", providerBudgetId: "supa" }]))
    .toEqual(new Set([firstReviewerKey(supa)]));
  // One row on a device of two leaves capacity: not blocked.
  expect(blockedFirstReviewerKeys(policy, [{ groupId: "m3-mlx", providerBudgetId: "m3" }])).toEqual(new Set());
  // A shared device blocks every route on it (AI1 and text share M3 MLX).
  expect(blockedFirstReviewerKeys(policy, [{ groupId: "m3-mlx", providerBudgetId: "m3" }, { groupId: "m3-mlx", providerBudgetId: "m3" }]))
    .toEqual(new Set([firstReviewerKey(mlx), firstReviewerKey(text)]));
  // Two rows under the m3 budget on another device never block the mlx device: no provider dimension.
  expect(blockedFirstReviewerKeys(policy, [{ groupId: "elsewhere", providerBudgetId: "m3" }, { groupId: "elsewhere", providerBudgetId: "m3" }])).toEqual(new Set());
});

it("prefers the live device limit (model_capacity_devices) over the policy fallback and reports nothing for an unconfigured device", () => {
  const rows = [{ groupId: "m3-mlx" }, { groupId: "m3-mlx" }];
  expect(blockedFirstReviewerKeys(policy, rows, { "m3-mlx": 4 })).toEqual(new Set());
  expect(blockedFirstReviewerKeys(policy, [{ groupId: "supa-gpu" }, { groupId: "supa-gpu" }], { "supa-gpu": 2 })).toEqual(new Set([firstReviewerKey(supa)]));
  const { groupLimits, ...bare } = policy; void groupLimits;
  expect(blockedFirstReviewerKeys(bare, rows)).toEqual(new Set());
  expect(blockedFirstReviewerKeys(bare, rows, { "m3-mlx": 2 })).toEqual(new Set([firstReviewerKey(mlx), firstReviewerKey(text)]));
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

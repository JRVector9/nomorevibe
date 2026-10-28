import { describe, expect, it, vi } from "vitest";
import { runDiscoveryBudget, type DiscoveryBudgetInput, type DiscoveryLane } from "@/lib/crawl/discovery-budget";

const basic = (patch: Partial<DiscoveryBudgetInput> = {}): DiscoveryBudgetInput => ({ pages: 10, nextLane: "latest",
  latestReady: true, fullReady: true, run: async (_lane, pages) => ({ usedPages: pages }), ...patch });

describe("discovery fair budget", () => {
  it("reserves half the page and wall-time budgets for each busy lane", async () => {
    const run = vi.fn(async (_lane, pages) => ({ usedPages: pages }));
    expect(await runDiscoveryBudget(basic({ run, now: () => 100, deadlineAt: 1_100 }))).toMatchObject({
      used: { latest: 5, full: 5 }, nextLane: "full", donated: 0,
    });
    expect(run.mock.calls).toEqual([["latest", 5, 600], ["full", 5, 1_100]]);
  });
  it("one page alternates on subsequent ticks", async () => {
    const lanes: DiscoveryLane[] = [];
    const run: DiscoveryBudgetInput["run"] = async (lane, pages) => { lanes.push(lane); return { usedPages: pages }; };
    const first = await runDiscoveryBudget(basic({ pages: 1, run }));
    await runDiscoveryBudget(basic({ pages: 1, run, nextLane: first.nextLane }));
    expect(lanes).toEqual(["latest", "full"]);
  });
  it("reuses unused pages only after both reserved turns", async () => {
    const calls: string[] = [];
    const result = await runDiscoveryBudget(basic({ run: async (lane, pages) => {
      calls.push(`${lane}:${pages}`);
      return lane === "latest" ? { usedPages: 2, idle: true } : { usedPages: pages };
    } }));
    expect(calls).toEqual(["latest:5", "full:5", "full:3"]);
    expect(result).toMatchObject({ used: { latest: 2, full: 8 }, donated: 3 });
  });
  it("gives an API-waiting lane's entire budget to its ready peer", async () => {
    const run = vi.fn(async (_lane, pages) => ({ usedPages: pages }));
    await runDiscoveryBudget(basic({ latestReady: false, run }));
    expect(run.mock.calls).toEqual([["full", 10, undefined]]);
  });
  it("does not call either lane again after a shared admission or authentication block", async () => {
    const run = vi.fn(async () => ({ usedPages: 1, blocked: true }));
    expect((await runDiscoveryBudget(basic({ run }))).blocked).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("makes oldest real progress first while retaining both shares", async () => {
    const run = vi.fn(async (_lane, pages) => ({ usedPages: pages }));
    await runDiscoveryBudget(basic({ run, lastProgressAt: { latest: 200_000, full: 100_000 } }));
    expect(run.mock.calls[0][0]).toBe("full");
    expect(run.mock.calls[1][0]).toBe("latest");
  });
  it("stops when the actual global wall-clock budget is exhausted", async () => {
    let at = 0;
    const run = vi.fn(async () => { at = 1_001; return { usedPages: 1 }; });
    const result = await runDiscoveryBudget(basic({ now: () => at, deadlineAt: 1_000, run }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.nextLane).toBe("full");
  });
  it("rejects impossible usage so unused budget cannot be counted twice", async () => {
    await expect(runDiscoveryBudget(basic({ run: async () => ({ usedPages: 6 }) }))).rejects.toThrow("discovery_budget_usage_invalid");
  });
});

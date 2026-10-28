export type DiscoveryLane = "latest" | "full";
export type DiscoverySlice = { usedPages: number; blocked?: boolean; idle?: boolean };
export type DiscoveryBudgetInput = {
  pages: number;
  nextLane: DiscoveryLane;
  latestReady: boolean;
  fullReady: boolean;
  deadlineAt?: number;
  now?: () => number;
  /** Last real page progress, not merely a successful empty worker tick. */
  lastProgressAt?: Partial<Record<DiscoveryLane, number>>;
  run: (lane: DiscoveryLane, pages: number, deadlineAt?: number) => Promise<DiscoverySlice>;
};

/** Fair page and wall-time slices. Each next tick starts with the other lane. */
export async function runDiscoveryBudget(input: DiscoveryBudgetInput) {
  const now = input.now ?? Date.now;
  const total = Number.isSafeInteger(input.pages) ? Math.max(0, input.pages) : 0;
  const ready = { latest: input.latestReady, full: input.fullReady };
  const used = { latest: 0, full: 0 };
  const allocated = { latest: 0, full: 0 };
  const idle = { latest: !ready.latest, full: !ready.full };
  const latestAge = input.lastProgressAt?.latest;
  const fullAge = input.lastProgressAt?.full;
  // Age wins only once it is meaningfully older. Ordinary busy lanes alternate.
  const aged = latestAge !== undefined && fullAge !== undefined && Math.abs(latestAge - fullAge) >= 60_000
    ? latestAge < fullAge ? "latest" : "full" : input.nextLane;
  const first: DiscoveryLane = ready[aged] ? aged : aged === "latest" ? "full" : "latest";
  const second: DiscoveryLane = first === "latest" ? "full" : "latest";
  const nextLane: DiscoveryLane = first === "latest" ? "full" : "latest";
  let blocked = false;
  let donated = 0;
  const remainingTime = () => input.deadlineAt === undefined || now() < input.deadlineAt;
  const run = async (lane: DiscoveryLane, pages: number, deadlineAt?: number) => {
    if (pages <= 0 || !ready[lane] || blocked || !remainingTime()) return;
    allocated[lane] += pages;
    const result = await input.run(lane, pages, deadlineAt);
    // A buggy count must never mint extra budget or silently overrun it.
    if (!Number.isSafeInteger(result.usedPages) || result.usedPages < 0 || result.usedPages > pages) {
      throw new Error("discovery_budget_usage_invalid");
    }
    used[lane] += result.usedPages;
    idle[lane] = result.idle === true || result.usedPages === 0;
    blocked = result.blocked === true;
  };
  if (!total || (!ready.latest && !ready.full)) return { nextLane, used, allocated, donated, blocked };
  const firstPages = ready[first] && ready[second] ? Math.ceil(total / 2) : total;
  const secondPages = total - firstPages;
  const firstDeadline = secondPages > 0 && input.deadlineAt !== undefined
    ? now() + Math.max(0, Math.floor((input.deadlineAt - now()) / 2)) : input.deadlineAt;
  await run(first, firstPages, firstDeadline);
  await run(second, secondPages, input.deadlineAt);
  let spare = total - used.latest - used.full;
  // Donation happens after both reserved turns, so a busy latest lane cannot steal full's turn.
  for (const lane of [second, first]) {
    if (!spare || blocked || !remainingTime()) break;
    if (!ready[lane] || idle[lane]) continue;
    const before = used[lane];
    await run(lane, spare, input.deadlineAt);
    const consumed = used[lane] - before;
    donated += consumed;
    spare -= consumed;
  }
  return { nextLane, used, allocated, donated, blocked };
}

vi.mock("@/lib/domain/evidence/source-control", () => ({ canonicalSourceMode: async () => false }));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JobLeaseLostError } from "@/lib/jobs/control";
import type { JobContext } from "@/lib/jobs/runner";
import type { EvidenceRefreshCursor } from "@/lib/jobs/products/evidence-refresh";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  due: vi.fn(),
  queueInitial: vi.fn(),
  refresh: vi.fn(),
  dueRequests: vi.fn(),
  begin: vi.fn(),
  saveProgress: vi.fn(),
}));

vi.mock("@/lib/domain/evidence/settings-store", () => ({ currentEvidenceSettings: mocks.settings }));
vi.mock("@/lib/domain/evidence/refresh", () => ({
  dueEvidenceProductSlugs: mocks.due,
  queueInitialProductEvidenceRefresh: mocks.queueInitial,
  refreshProductEvidence: mocks.refresh,
}));
vi.mock("@/lib/domain/evidence/refresh-requests", () => ({
  beginProductRefresh: mocks.begin,
  dueProductRefreshRequests: mocks.dueRequests,
  saveProductRefreshProgress: mocks.saveProgress,
}));

const { refreshProductEvidenceJob } = await import("@/lib/jobs/products/evidence-refresh");

const ok = { sourcesAttempted: 1, sourcesFailed: 0, factsChanged: 0, eventsInserted: 0, mediaInserted: 0, complete: true };

function context(options: { deadlineAt: number; now: () => number; budget?: () => boolean; signal?: AbortSignal }) {
  const saved: EvidenceRefreshCursor[] = [];
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const ctx: JobContext<EvidenceRefreshCursor> = {
    cursor: null,
    deadlineAt: options.deadlineAt,
    signal: options.signal ?? new AbortController().signal,
    hasBudget: options.budget ?? (() => options.now() < options.deadlineAt),
    save: async (cursor) => { saved.push(cursor); },
    log: (event, fields) => { logs.push({ event, fields }); },
    lease: { name: "product-evidence-refresh", token: "owner", requestedVersion: 1 },
  };
  return { ctx, saved, logs };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.settings.mockResolvedValue({ batchSize: 20 });
  mocks.dueRequests.mockResolvedValue([]);
  mocks.queueInitial.mockResolvedValue(null);
  mocks.refresh.mockResolvedValue(ok);
});
afterEach(() => { vi.restoreAllMocks(); });

it("asks to continue when the shared deadline hits and the selected page still has a later product", async () => {
  const deadlineAt = 5_000;
  let now = deadlineAt - 20;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.due.mockResolvedValue(["alpha", "beta"]);
  mocks.refresh.mockImplementation(async () => { now = deadlineAt; return ok; });
  const run = context({ deadlineAt, now: () => now });

  await expect(refreshProductEvidenceJob(run.ctx, { now: () => new Date(0) })).resolves.toEqual({
    done: false, continuation: "ready", cursor: { afterSlug: "alpha" },
  });
  expect(mocks.due).toHaveBeenCalledTimes(1);
  expect(run.saved).toEqual([{ afterSlug: "alpha" }]);
});

it("keeps a later page ready when the deadline lands exactly on the full page boundary", async () => {
  const deadlineAt = 5_000;
  let now = deadlineAt - 20;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.settings.mockResolvedValue({ batchSize: 2 });
  mocks.due.mockImplementation(async ({ limit }) => ["alpha", "beta", "gamma"].slice(0, limit));
  mocks.refresh.mockImplementation(async slug => {
    if (slug === "beta") now = deadlineAt;
    return ok;
  });
  const run = context({ deadlineAt, now: () => now });

  await expect(refreshProductEvidenceJob(run.ctx, { now: () => new Date(0) })).resolves.toEqual({
    done: false, continuation: "ready", cursor: { afterSlug: "beta" },
  });
  expect(mocks.due).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ limit: 3 }));
  expect(mocks.refresh.mock.calls.map(([slug]) => slug)).toEqual(["alpha", "beta"]);
  expect(run.saved).toEqual([{ afterSlug: "alpha" }, { afterSlug: "beta" }]);
  expect(run.logs.at(-1)?.fields).toMatchObject({ attempted: 2, succeeded: 2, failed: 0 });
});

it("recognizes the final full page before the deadline without a later SQL probe", async () => {
  const deadlineAt = 5_000;
  let now = deadlineAt - 20;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.settings.mockResolvedValue({ batchSize: 2 });
  mocks.due.mockImplementation(async ({ limit }) => ["alpha", "beta"].slice(0, limit));
  mocks.refresh.mockImplementation(async slug => {
    if (slug === "beta") now = deadlineAt;
    return ok;
  });
  const run = context({ deadlineAt, now: () => now });

  await expect(refreshProductEvidenceJob(run.ctx, { now: () => new Date(0) })).resolves.toEqual({ done: true });
  expect(mocks.due).toHaveBeenCalledTimes(1);
  expect(run.saved.at(-1)).toEqual({ afterSlug: "beta" });
});

it("obtains the maximum page's one-row lookahead before collecting and never advances to it", async () => {
  const deadlineAt = 5_000;
  let now = deadlineAt - 20;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.settings.mockResolvedValue({ batchSize: 100 });
  const slugs = Array.from({ length: 101 }, (_, index) => `product-${String(index).padStart(3, "0")}`);
  mocks.due.mockImplementation(async ({ afterSlug, limit }) => {
    expect(now).toBeLessThan(deadlineAt);
    expect(mocks.refresh).not.toHaveBeenCalled();
    return slugs.filter(slug => !afterSlug || slug > afterSlug).slice(0, limit);
  });
  mocks.refresh.mockImplementation(async slug => {
    if (slug === slugs[99]) now = deadlineAt;
    return ok;
  });
  const run = context({ deadlineAt, now: () => now });

  await expect(refreshProductEvidenceJob(run.ctx, { now: () => new Date(0) })).resolves.toEqual({
    done: false, continuation: "ready", cursor: { afterSlug: slugs[99] },
  });
  expect(mocks.due.mock.calls.map(([input]) => ({ limit: input.limit, afterSlug: input.afterSlug }))).toEqual([
    { limit: 100, afterSlug: undefined }, { limit: 1, afterSlug: slugs[99] },
  ]);
  expect(mocks.refresh).toHaveBeenCalledTimes(100);
  expect(run.saved.at(-1)).toEqual({ afterSlug: slugs[99] });
  expect(run.logs.at(-1)?.fields).toMatchObject({ attempted: 100, succeeded: 100 });
});

it.each(["hold", "failure", "abort"] as const)("keeps the normal scheduling after %s at a full page boundary", async mode => {
  const deadlineAt = 5_000;
  let now = deadlineAt - 20;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.settings.mockResolvedValue({ batchSize: 2 });
  mocks.due.mockImplementation(async ({ limit }) => ["alpha", "beta", "gamma"].slice(0, limit));
  const controller = new AbortController();
  mocks.refresh.mockImplementation(async (slug, options) => {
    if (slug === "beta") {
      now = deadlineAt;
      if (mode === "hold") options.dependencies.log("evidence.github_refresh", { httpClass: "rate_limited" });
      if (mode === "abort") controller.abort();
      if (mode === "failure") throw new Error("provider failure");
    }
    return ok;
  });
  const run = context({ deadlineAt, now: () => now, signal: controller.signal });

  await expect(refreshProductEvidenceJob(run.ctx, { now: () => new Date(0) })).resolves.toEqual({
    done: false, cursor: { afterSlug: "beta" },
  });
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  expect(run.saved.at(-1)).toEqual({ afterSlug: "beta" });
});

it("starts no maximum-page lookahead if the selection used the remaining budget", async () => {
  const deadlineAt = 5_000;
  let now = deadlineAt - 20;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.settings.mockResolvedValue({ batchSize: 100 });
  mocks.due.mockImplementation(async () => {
    now = deadlineAt;
    return Array.from({ length: 100 }, (_, index) => `product-${index}`);
  });
  const run = context({ deadlineAt, now: () => now });

  await expect(refreshProductEvidenceJob(run.ctx, { now: () => new Date(0) })).resolves.toEqual({ done: false, cursor: null });
  expect(mocks.due).toHaveBeenCalledTimes(1);
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(run.saved).toEqual([]);
});

it("visits the lookahead in the next page when budget remains", async () => {
  const deadlineAt = 5_000;
  vi.spyOn(Date, "now").mockReturnValue(deadlineAt - 20);
  mocks.settings.mockResolvedValue({ batchSize: 2 });
  mocks.due.mockImplementation(async ({ afterSlug, limit }) => ["alpha", "beta", "gamma"]
    .filter(slug => !afterSlug || slug > afterSlug).slice(0, limit));
  const run = context({ deadlineAt, now: () => deadlineAt - 20 });

  await expect(refreshProductEvidenceJob(run.ctx, { now: () => new Date(0) })).resolves.toEqual({ done: true });
  expect(mocks.refresh.mock.calls.map(([slug]) => slug)).toEqual(["alpha", "beta", "gamma"]);
  expect(mocks.due.mock.calls.map(([input]) => input.afterSlug)).toEqual([undefined, "beta"]);
  expect(run.saved.at(-1)).toEqual({ afterSlug: "gamma" });
});

it("does not mark the last full-page partial product complete or request a continuation", async () => {
  const deadlineAt = 5_000;
  let now = deadlineAt - 20;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.settings.mockResolvedValue({ batchSize: 2 });
  mocks.due.mockImplementation(async ({ limit }) => ["alpha", "beta"].slice(0, limit));
  mocks.refresh.mockImplementation(async slug => {
    if (slug === "beta") {
      now = deadlineAt;
      return { ...ok, complete: false };
    }
    return ok;
  });
  const run = context({ deadlineAt, now: () => now });

  await expect(refreshProductEvidenceJob(run.ctx, { now: () => new Date(0) })).resolves.toEqual({
    done: false, cursor: { afterSlug: "beta" },
  });
  expect(mocks.due).toHaveBeenCalledTimes(1);
  expect(run.logs.at(-1)?.fields).toMatchObject({ attempted: 2, succeeded: 1 });
});

it("does not continue when the first selected product is incomplete and none completed", async () => {
  const deadlineAt = 5_000;
  let now = deadlineAt - 20;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.due.mockResolvedValue(["alpha", "beta"]);
  mocks.refresh.mockImplementation(async () => { now = deadlineAt; return { ...ok, complete: false }; });
  const run = context({ deadlineAt, now: () => now });
  const log = run.ctx.log;

  await expect(refreshProductEvidenceJob(run.ctx, { now: () => new Date(0) })).resolves.toEqual({
    done: false, cursor: { afterSlug: "alpha" },
  });
  expect(run.ctx.log).toBe(log);
  expect(mocks.due).toHaveBeenCalledTimes(1);
});

it("keeps the caller log and suppresses continuation after a provider hold on a completed product", async () => {
  const deadlineAt = 5_000;
  let now = deadlineAt - 20;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.due.mockResolvedValue(["alpha", "beta"]);
  mocks.refresh.mockImplementation(async (_slug, options) => {
    options.dependencies.log("evidence.github_refresh", { outcome: "deferred", httpClass: "auth_unavailable" });
    now = deadlineAt;
    return ok;
  });
  const run = context({ deadlineAt, now: () => now });
  const log = run.ctx.log;

  await expect(refreshProductEvidenceJob(run.ctx, { now: () => new Date(0) })).resolves.toEqual({
    done: false, cursor: { afterSlug: "alpha" },
  });
  expect(run.ctx.log).toBe(log);
});

it("does not continue when the only selected product is the partial checkpoint", async () => {
  const deadlineAt = 5_000;
  let now = deadlineAt - 20;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.due.mockResolvedValue(["only"]);
  mocks.refresh.mockImplementation(async () => { now = deadlineAt; return { ...ok, complete: false }; });
  const run = context({ deadlineAt, now: () => now });

  await expect(refreshProductEvidenceJob(run.ctx, { now: () => new Date(0) })).resolves.toEqual({
    done: false, cursor: { afterSlug: "only" },
  });
  expect(mocks.due).toHaveBeenCalledTimes(1);
});

it("does not continue on an empty due page, a yield before the deadline, abort, failure, or quota", async () => {
  const deadlineAt = 5_000;
  const now = () => deadlineAt;
  vi.spyOn(Date, "now").mockImplementation(now);
  mocks.due.mockResolvedValueOnce([]);
  const empty = context({ deadlineAt, now: () => deadlineAt - 1, budget: () => true });
  await expect(refreshProductEvidenceJob(empty.ctx, { now: () => new Date(0) })).resolves.toEqual({ done: true });

  let clock = deadlineAt - 50;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  mocks.due.mockResolvedValue(["alpha", "beta"]);
  mocks.refresh.mockResolvedValue(ok);
  const yielded = context({ deadlineAt, now: () => clock, budget: () => false });
  await expect(refreshProductEvidenceJob(yielded.ctx, { now: () => new Date(0) })).resolves.toEqual({ done: false, cursor: null });
  expect(mocks.refresh).not.toHaveBeenCalled();

  const controller = new AbortController();
  controller.abort();
  clock = deadlineAt;
  mocks.refresh.mockImplementation(async () => ok);
  const aborted = context({ deadlineAt, now: () => clock, signal: controller.signal, budget: () => false });
  await expect(refreshProductEvidenceJob(aborted.ctx, { now: () => new Date(0) })).resolves.toEqual({ done: false, cursor: null });

  mocks.refresh.mockRejectedValueOnce(new Error("provider down"));
  const failed = context({ deadlineAt, now: () => deadlineAt, budget: (() => {
    let left = 2;
    return () => left-- > 0;
  })() });
  await expect(refreshProductEvidenceJob(failed.ctx, { now: () => new Date(0) })).resolves.toEqual({
    done: false, cursor: { afterSlug: "alpha" },
  });

  mocks.refresh.mockImplementationOnce(async (_slug, options) => {
    options.dependencies.log("evidence.github_refresh", { outcome: "deferred", httpClass: "rate_limited" });
    return ok;
  });
  const quota = context({ deadlineAt, now: () => deadlineAt, budget: (() => {
    let left = 2;
    return () => left-- > 0;
  })() });
  await expect(refreshProductEvidenceJob(quota.ctx, { now: () => new Date(0) })).resolves.toEqual({
    done: false, cursor: { afterSlug: "alpha" },
  });
});

it("does not treat a shorter dependency deadline as the shared job deadline", async () => {
  const deadlineAt = 5_000;
  vi.spyOn(Date, "now").mockImplementation(() => deadlineAt - 10);
  mocks.due.mockResolvedValue(["alpha", "beta"]);
  mocks.refresh.mockResolvedValue({ ...ok, complete: false });
  const run = context({ deadlineAt, now: () => deadlineAt - 10, budget: () => false });

  await expect(refreshProductEvidenceJob(run.ctx, {
    now: () => new Date(0), deadlineAt: deadlineAt - 100,
  })).resolves.toEqual({ done: false, cursor: null });
  expect(mocks.due).not.toHaveBeenCalled();
});

it("propagates lease loss instead of requesting another tick", async () => {
  const deadlineAt = 5_000;
  vi.spyOn(Date, "now").mockImplementation(() => deadlineAt);
  mocks.due.mockResolvedValue(["alpha", "beta"]);
  mocks.refresh.mockRejectedValue(new JobLeaseLostError());
  const run = context({ deadlineAt, now: () => deadlineAt, budget: () => true });

  await expect(refreshProductEvidenceJob(run.ctx, { now: () => new Date(0) })).rejects.toThrow("job_lease_lost");
});

it.each(["due", "request"] as const)("%s evidence permit holds cannot consume failure, backoff or job ACK", async lane => {
  const { HttpOriginPermitError } = await import("@/lib/net/http-origin-policy");
  mocks.due.mockResolvedValue(["alpha"]);
  mocks.refresh.mockResolvedValue({ ...ok, complete: false, sourcesAttempted: 0, deferred: "http_origin_permit" });
  if (lane === "request") {
    const request = { slug: "alpha", productId: 1, requestedVersion: 1, activeVersion: 1, activeForce: true,
      progress: { completedKeys: [], retryAfterByKey: {} } };
    mocks.dueRequests.mockResolvedValue([request]);
    mocks.begin.mockResolvedValue(request);
  }
  const run = context({ deadlineAt: Date.now() + 25_000, now: Date.now });
  await expect(refreshProductEvidenceJob(run.ctx)).rejects.toBeInstanceOf(HttpOriginPermitError);
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.saveProgress).not.toHaveBeenCalled();
  expect(run.logs.some(log => log.event === "evidence.product_refresh_failed")).toBe(false);
  expect(run.saved.some(cursor => cursor.afterSlug === "alpha")).toBe(false);
});

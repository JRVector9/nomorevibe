import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn(), request: vi.fn(), handler: vi.fn(),
  finished: undefined as Promise<void> | undefined, signal: new AbortController().signal }));
vi.mock("@/scripts/worker", async importOriginal => ({
  ...await importOriginal<typeof import("@/scripts/worker")>(),
  withRuntimeProcess: async (_role: string, handler: (signal: AbortSignal, report: () => void) => Promise<void>) => {
    mocks.finished = handler(mocks.signal, () => {});
    await mocks.finished;
  },
}));
vi.mock("@/lib/jobs/registry", () => ({ JOBS: {
  "product-audit": mocks.handler, "crawl-publish": mocks.handler, "crawl-fetch": mocks.handler,
} }));
vi.mock("@/lib/jobs/runner", () => ({ runJob: mocks.run, getJobState: async () => ({ cursor: null, lastError: null }) }));
vi.mock("@/lib/jobs/control", () => ({ requestJob: mocks.request }));

const originalArgv = process.argv;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.finished = undefined;
  mocks.run.mockResolvedValue({ status: "completed" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

it.each([
  ["product-audit", 70_000], ["crawl-publish", 120_000], ["crawl-fetch", undefined],
])("manual %s uses the same budget and cancellation as its worker", async (name, budgetMs) => {
  process.argv = [originalArgv[0], "run-job.ts", name as string];
  await import("@/scripts/run-job");
  await mocks.finished;
  expect(mocks.request).toHaveBeenCalledWith(name);
  expect(mocks.run).toHaveBeenCalledWith(name, mocks.handler, {
    requestedOnly: true, signal: mocks.signal, ...(budgetMs === undefined ? {} : { budgetMs }),
  });
});

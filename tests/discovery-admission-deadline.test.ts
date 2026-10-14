import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), read: vi.fn(), input: vi.fn(), matches: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@/lib/crawl/agent-review-contract", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-contract")>(), createReviewInput: mocks.input,
}));
vi.mock("@/lib/crawl/second-review-input", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/second-review-input")>(), secondReviewInputMatches: mocks.matches,
}));
const { readDiscoveryAdmission } = await import("@/lib/crawl/discovery-admission");

beforeEach(() => { vi.useFakeTimers(); mocks.transaction.mockReset(); mocks.read.mockReset(); mocks.input.mockReset(); mocks.matches.mockReset(); });
afterEach(async () => { await vi.runAllTimersAsync(); vi.useRealTimers(); });

function fixture(delay: number, total: number) {
  const budgets: number[] = [];
  const delayed = async (rows: unknown[]) => {
    mocks.read();
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    return rows;
  };
  const chain = (rows: unknown[]) => {
    const value = { from: () => value, where: () => value, orderBy: () => value, limit: () => value,
      innerJoin: () => value, leftJoin: () => value, then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => delayed(rows).then(resolve, reject) };
    return value;
  };
  const tx = {
    select: (fields: Record<string, unknown>) => chain(fields.vote ? [{ candidate: { id: 1, repo: "acme/app" } }] : [{ count: 0 }]),
    selectDistinctOn: () => chain([{ id: 1, repositoryKey: "acme/app" }]),
    execute: (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const compiled = new PgDialect().sqlToQuery(query);
      if (compiled.sql.includes("set_config")) { budgets.push(Number(compiled.params[0])); return Promise.resolve([]); }
      if (compiled.sql.includes("set local")) return Promise.resolve([]);
      return delayed(compiled.sql.includes("select 'fetch'") ? [] : [{ id: 1, scanId: 1, total }]);
    },
  };
  mocks.transaction.mockImplementation(async (load, options) => {
    expect(options).toMatchObject({ accessMode: "read only" });
    return load(tx);
  });
  return budgets;
}

it("bounds the whole read-only snapshot rather than granting three seconds to every sequential query", async () => {
  const budgets = fixture(900, 65);
  let settled = false;
  const pending = readDiscoveryAdmission({ ...DEFAULT_CRAWL_SETTINGS, enabled: true }).then(snapshot => { settled = true; return snapshot; });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(settled).toBe(true);
  expect(await pending).toMatchObject({ timedOut: true, secondWindowLimited: true });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(mocks.read).toHaveBeenCalledTimes(4);
  expect(budgets.at(-1)).toBeLessThanOrEqual(250);
});

it("marks a snapshot incomplete when semantic input construction crosses its CPU deadline", async () => {
  fixture(0, 1);
  mocks.input.mockImplementation(() => { vi.setSystemTime(Date.now() + 3_100); return {}; });
  expect(await readDiscoveryAdmission(DEFAULT_CRAWL_SETTINGS)).toMatchObject({ timedOut: true, secondWindowLimited: true });
  expect(mocks.input).toHaveBeenCalledOnce();
  expect(mocks.matches).not.toHaveBeenCalled();
});

it.each(["57014", "55P03", "DB_POOL_WAIT_TIMEOUT"])("returns incomplete pressure telemetry when the read budget fails with %s", async code => {
  mocks.transaction.mockRejectedValue(new Error("query failed", { cause: { code } }));
  expect(await readDiscoveryAdmission(DEFAULT_CRAWL_SETTINGS)).toMatchObject({ timedOut: true, secondWindowLimited: true });
});

it("preserves database failures unrelated to a deadline", async () => {
  const error = new Error("query failed", { cause: { code: "42P01" } });
  mocks.transaction.mockRejectedValue(error);
  await expect(readDiscoveryAdmission(DEFAULT_CRAWL_SETTINGS)).rejects.toBe(error);
});

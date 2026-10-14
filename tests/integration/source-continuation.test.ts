import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { JobLeaseLostError, requestJob } from "@/lib/jobs/control";
import { getJobState, runJob } from "@/lib/jobs/runner";
import { ensureSchema } from "./setup";

beforeAll(ensureSchema);
beforeEach(async () => { await db.delete(jobs); });
afterEach(() => { vi.restoreAllMocks(); });

function elapsedClock() {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return { advance: (ms: number) => { now += ms; } };
}

async function runSource(handler: () => Promise<{ done: boolean; continuation?: "ready" }>, budgetMs: number) {
  await requestJob("product-evidence-refresh");
  return runJob("product-evidence-refresh", handler, { requestedOnly: true, budgetMs });
}

it("queues one source continuation only after the run budget elapsed", async () => {
  const clock = elapsedClock();
  const result = await runSource(async () => {
    clock.advance(50);
    return { done: false, continuation: "ready" };
  }, 40);
  expect(result).toMatchObject({ status: "completed", done: false, sourceContinuation: true });
  expect(await getJobState("product-evidence-refresh")).toMatchObject({ processedVersion: 1, requestedVersion: 2, notBefore: null });
});

it("rejects a forged ready before the budget, on done, and for another job", async () => {
  const early = await runSource(async () => ({ done: false, continuation: "ready" }), 60_000);
  expect(early).toMatchObject({ status: "completed", done: false });
  expect(early).not.toHaveProperty("sourceContinuation");
  expect(await getJobState("product-evidence-refresh")).toMatchObject({ processedVersion: 1, requestedVersion: 1 });

  await requestJob("product-evidence-refresh");
  const clock = elapsedClock();
  const finished = await runJob("product-evidence-refresh", async () => {
    clock.advance(50);
    return { done: true, continuation: "ready" };
  }, { requestedOnly: true, budgetMs: 40 });
  expect(finished).not.toHaveProperty("sourceContinuation");
  expect(await getJobState("product-evidence-refresh")).toMatchObject({ processedVersion: 2, requestedVersion: 2 });

  await requestJob("crawl-fetch");
  const other = await runJob("crawl-fetch", async () => {
    clock.advance(50);
    return { done: false, continuation: "ready" };
  }, { requestedOnly: true, budgetMs: 40 });
  expect(other).not.toHaveProperty("sourceContinuation");
  expect(await getJobState("crawl-fetch")).toMatchObject({ processedVersion: 1, requestedVersion: 1 });
});

it("preserves a newer request and a future pause or backoff", async () => {
  const clock = elapsedClock();
  const pauseAt = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
  const backoffAt = new Date(Date.now() + 60_000);
  await requestJob("product-evidence-refresh");
  const newer = await runJob("product-evidence-refresh", async () => {
    await requestJob("product-evidence-refresh");
    clock.advance(50);
    return { done: false, continuation: "ready" };
  }, { requestedOnly: true, budgetMs: 40 });
  expect(newer).toMatchObject({ sourceContinuation: true });
  expect(await getJobState("product-evidence-refresh")).toMatchObject({ processedVersion: 1, requestedVersion: 2 });

  await db.delete(jobs);
  await requestJob("product-evidence-refresh");
  const paused = await runJob("product-evidence-refresh", async () => {
    await db.update(jobs).set({ notBefore: pauseAt }).where(eq(jobs.name, "product-evidence-refresh"));
    clock.advance(50);
    return { done: false, continuation: "ready" };
  }, { requestedOnly: true, budgetMs: 40 });
  expect(paused).not.toHaveProperty("sourceContinuation");
  expect(await getJobState("product-evidence-refresh")).toMatchObject({
    processedVersion: 1, requestedVersion: 1, notBefore: pauseAt,
  });

  await db.delete(jobs);
  await requestJob("product-evidence-refresh");
  const backedOff = await runJob("product-evidence-refresh", async () => {
    await db.update(jobs).set({ notBefore: backoffAt }).where(eq(jobs.name, "product-evidence-refresh"));
    clock.advance(50);
    return { done: false, continuation: "ready" };
  }, { requestedOnly: true, budgetMs: 40 });
  expect(backedOff).not.toHaveProperty("sourceContinuation");
  expect((await getJobState("product-evidence-refresh"))?.notBefore).toEqual(backoffAt);
  expect(await getJobState("product-evidence-refresh")).toMatchObject({ processedVersion: 1, requestedVersion: 1 });
});

it("does not mark continuation when app time is past a database-future backoff that still holds a newer request", async () => {
  const clock = elapsedClock();
  await requestJob("product-evidence-refresh");
  const result = await runJob("product-evidence-refresh", async () => {
    await requestJob("product-evidence-refresh");
    await db.execute(sql`update jobs set not_before = now() + interval '1 hour' where name = 'product-evidence-refresh'`);
    clock.advance(2 * 60 * 60 * 1000);
    return { done: false, continuation: "ready" };
  }, { requestedOnly: true, budgetMs: 40 });
  expect(result).toMatchObject({ status: "completed", done: false });
  expect(result).not.toHaveProperty("sourceContinuation");
  const state = await getJobState("product-evidence-refresh");
  expect(state).toMatchObject({ processedVersion: 1, requestedVersion: 2 });
  vi.restoreAllMocks();
  expect(state?.notBefore?.getTime()).toBeGreaterThan(Date.now());
});

it("leaves a stolen lease unchanged when the old owner completes", async () => {
  const clock = elapsedClock();
  await requestJob("product-evidence-refresh");
  const stolen = "stolen-lease-token-0000000000000000";
  const result = await runJob("product-evidence-refresh", async () => {
    await db.update(jobs).set({ leaseToken: stolen, cursor: { afterSlug: "kept" }, notBefore: null })
      .where(eq(jobs.name, "product-evidence-refresh"));
    clock.advance(50);
    return { done: false, continuation: "ready", cursor: { afterSlug: "old" } };
  }, { requestedOnly: true, budgetMs: 40 });
  expect(result.status).toBe("failed");
  expect(result).not.toHaveProperty("sourceContinuation");
  expect(await getJobState("product-evidence-refresh")).toMatchObject({
    requestedVersion: 1, processedVersion: 0, leaseToken: stolen, cursor: { afterSlug: "kept" }, notBefore: null,
  });
});

it("does not queue a source continuation after the signal aborts", async () => {
  const clock = elapsedClock();
  const controller = new AbortController();
  await requestJob("product-evidence-refresh");
  const result = await runJob("product-evidence-refresh", async () => {
    clock.advance(50);
    controller.abort();
    return { done: false, continuation: "ready" };
  }, { requestedOnly: true, budgetMs: 40, signal: controller.signal });
  expect(result).toMatchObject({ status: "completed", done: false });
  expect(result).not.toHaveProperty("sourceContinuation");
  expect(await getJobState("product-evidence-refresh")).toMatchObject({ processedVersion: 1, requestedVersion: 1 });
});

it("does not queue or mark continuation when the lease is lost", async () => {
  const clock = elapsedClock();
  const result = await runSource(async () => {
    clock.advance(50);
    throw new JobLeaseLostError();
  }, 40);
  expect(result.status).toBe("failed");
  expect(result).not.toHaveProperty("sourceContinuation");
  const state = await getJobState("product-evidence-refresh");
  expect(state).toMatchObject({ processedVersion: 0, requestedVersion: 1 });
  expect(state?.notBefore).not.toBeNull();
});

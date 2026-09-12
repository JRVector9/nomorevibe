import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { assertJobLease, pendingJobNames, requestDueJobs, requestJob } from "@/lib/jobs/control";
import { getJobState, runJob } from "@/lib/jobs/runner";
import { ensureSchema } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => { await db.delete(jobs); });

describe("persistent job requests", () => {
  it("releases ownership even when a handler error contains a PostgreSQL-forbidden NUL", async () => {
    await requestJob("crawl-agent-review");
    expect(await runJob("crawl-agent-review", async () => {
      throw new Error("upstream\0invalid text");
    }, { requestedOnly: true })).toMatchObject({ status: "failed" });
    expect(await getJobState("crawl-agent-review")).toMatchObject({
      lockedAt: null, leaseToken: null, processedVersion: 0,
      lastError: "upstream\\0invalid text",
    });
    expect((await getJobState("crawl-agent-review"))?.notBefore).toBeInstanceOf(Date);
  });

  it("reclaims a two-minute abandoned review through the worker queue", async () => {
    await db.insert(jobs).values({ name: "crawl-agent-review", requestedVersion: 1,
      leaseToken: "abandoned", lockedAt: sql`now() - interval '2 minutes'`, cursor: { resume: true } });
    expect(await pendingJobNames("reviewer")).toContain("crawl-agent-review");
    await expect(db.transaction(tx => assertJobLease(tx, {
      name: "crawl-agent-review", token: "abandoned", requestedVersion: 1,
    }))).rejects.toThrow("job_lease_lost");
    expect(await runJob("crawl-agent-review", async ctx => {
      expect(ctx.cursor).toEqual({ resume: true });
      await db.transaction(tx => assertJobLease(tx, ctx.lease!));
      return { done: true };
    }, { requestedOnly: true })).toMatchObject({ status: "completed" });
    expect(await getJobState("crawl-agent-review")).toMatchObject({ processedVersion: 1, lockedAt: null });
  });

  it("keeps a recently renewed review exclusive", async () => {
    await db.insert(jobs).values({ name: "crawl-agent-review", requestedVersion: 1,
      leaseToken: "live", lockedAt: sql`now() - interval '60 seconds'` });
    expect(await pendingJobNames("reviewer")).not.toContain("crawl-agent-review");
    await db.transaction(tx => assertJobLease(tx, { name: "crawl-agent-review", token: "live", requestedVersion: 1 }));
    expect(await runJob("crawl-agent-review", async () => { throw new Error("duplicate execution"); },
      { requestedOnly: true })).toEqual({ status: "skipped", reason: "locked" });
  });

  it("coalesces overlapping scheduler polls without running any handler", async () => {
    await Promise.all([requestDueJobs(), requestDueJobs()]);
    const state = await getJobState("crawl-fetch");
    expect(state?.requestedVersion).toBe(1);
    expect(state?.processedVersion).toBe(0);
    expect(state?.lastRunAt).toBeNull();
    expect(state?.nextScheduledAt).toBeInstanceOf(Date);
    expect(await getJobState("ranking-refresh")).toBeUndefined();
  });

  it("preserves a new request arriving during a partial tick", async () => {
    await requestJob("crawl-fetch");
    let start!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const running = runJob("crawl-fetch", async () => {
      start(); await paused;
      return { done: false, cursor: { page: 2 } };
    }, { requestedOnly: true });
    await started;
    await requestJob("crawl-fetch");
    resume();
    expect((await running).status).toBe("completed");
    expect(await getJobState("crawl-fetch")).toMatchObject({ requestedVersion: 2, processedVersion: 1, cursor: { page: 2 } });
    await runJob("crawl-fetch", async ctx => {
      expect(ctx.cursor).toEqual({ page: 2 }); return { done: false };
    }, { requestedOnly: true });
    expect((await getJobState("crawl-fetch"))?.processedVersion).toBe(2);
    const idle = await runJob("crawl-fetch", async () => { throw new Error("must not run"); }, { requestedOnly: true });
    expect(idle).toEqual({ status: "skipped", reason: "not_requested" });
  });

  it("rejects a replaced owner's cursor and does not release the replacement", async () => {
    await requestJob("crawl-fetch");
    const result = await runJob("crawl-fetch", async ctx => {
      await db.update(jobs).set({ leaseToken: "replacement", cursor: { replacement: true } }).where(eq(jobs.name, "crawl-fetch"));
      await ctx.save({ stale: true });
      return { done: true };
    }, { requestedOnly: true });
    expect(result).toMatchObject({ status: "failed", error: "job_lease_lost" });
    expect(await getJobState("crawl-fetch")).toMatchObject({ leaseToken: "replacement", processedVersion: 0, cursor: { replacement: true } });
    expect((await getJobState("crawl-fetch"))?.lockedAt).toBeInstanceOf(Date);
  });

  it("keeps failed requests pending and requests ranking only after a complete rollup", async () => {
    await requestJob("click-rollup");
    const failure = await runJob("click-rollup", async () => { throw new Error("unavailable"); }, { requestedOnly: true });
    expect(failure.status).toBe("failed");
    expect(await getJobState("ranking-refresh")).toBeUndefined();
    expect(await getJobState("click-rollup")).toMatchObject({ requestedVersion: 1, processedVersion: 0 });
    expect((await getJobState("click-rollup"))?.notBefore).toBeInstanceOf(Date);
    await runJob("click-rollup", async () => ({ done: false }));
    expect(await getJobState("ranking-refresh")).toBeUndefined();
    await runJob("click-rollup", async () => ({ done: true }));
    expect((await getJobState("ranking-refresh"))?.requestedVersion).toBe(1);
  });
});

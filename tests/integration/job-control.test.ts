import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { requestDueJobs, requestJob } from "@/lib/jobs/control";
import { getJobState, runJob } from "@/lib/jobs/runner";
import { ensureSchema } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => { await db.delete(jobs); });

describe("persistent job requests", () => {
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

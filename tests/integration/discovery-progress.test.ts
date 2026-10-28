import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { like } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsObservations } from "@/lib/db/schema";
import { ensureSchema } from "./setup";
import { recordDiscoveryProgress } from "@/lib/crawl/discovery-progress";
import { buildDiscoveryProgress } from "@/lib/operations/discovery-progress";

const worker = `progress-test-${randomUUID()}`;
beforeAll(ensureSchema);
afterEach(async () => {
  await db.delete(operationsObservations).where(like(operationsObservations.key, "discovery-progress:%"));
});

describe("discovery atomic progress counters", () => {
  it("preserves both concurrent batch increments without double reading", async () => {
    await Promise.all([1, 2, 3, 4].map(discovered => recordDiscoveryProgress({ worker, lane: "full", signal: "test", counts: { discovered, examined: 10 } })));
    const rows = await db.select().from(operationsObservations).where(like(operationsObservations.key, "discovery-progress:%"));
    const report = buildDiscoveryProgress(new Date().toISOString(), rows);
    const row = report.rows.find(row => row.worker === worker);
    expect(row?.hour).toMatchObject({ discovered: 10, examined: 40 });
  });
  it("an incomplete page does not create a completed range; an idle tick does not move progress", async () => {
    const input = { worker, lane: "latest" as const, signal: "test", window: { from: "2026-10-25", to: "2026-10-26" } };
    await recordDiscoveryProgress({ ...input, counts: { pagesVisited: 1, incomplete: 1 } });
    const read = async () => {
      const rows = await db.select().from(operationsObservations).where(like(operationsObservations.key, "discovery-progress:%"));
      return buildDiscoveryProgress(new Date().toISOString(), rows).rows.find(row => row.worker === worker)!;
    };
    const first = await read();
    expect(first.completedThrough).toBeNull();
    await recordDiscoveryProgress({ ...input, counts: {}, blockedBy: "api_wait" });
    expect((await read()).lastProgressAt).toEqual(first.lastProgressAt);
    await recordDiscoveryProgress({ ...input, completedThrough: "2026-10-26", counts: {} });
    expect(await read()).toMatchObject({ completedThrough: "2026-10-26T00:00:00.000Z", pendingSince: null });
  });
});

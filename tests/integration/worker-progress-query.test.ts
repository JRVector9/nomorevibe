import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, operationsObservations } from "@/lib/db/schema";
import { saveSettings } from "@/lib/crawl/settings";
import { readWorkerProgress } from "@/lib/operations/worker-progress-query";
import { observeService } from "@/lib/operations/observations";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

beforeAll(ensureSchema);
beforeEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(operationsObservations);
  await saveSettings({ enabled: true }, "test");
});

it("counts recent boots and ignores a late observation from an older process", async () => {
  vi.stubEnv("SERVICE_INSTANCE_ID", "audit-crawler");
  const start = Date.now();
  for (let number = 1; number <= 4; number++) {
    await observeService("crawler", { status: "running", bootId: `boot-${number}`, bootedAt: start + number });
  }
  await observeService("crawler", { status: "failed", bootId: "boot-2", bootedAt: start + 2 });
  const [row] = await db.select().from(operationsObservations)
    .where(eq(operationsObservations.key, "service:crawler:audit-crawler"));
  expect(row.value).toMatchObject({ bootId: "boot-4", restartCount5m: 3, status: "running" });
  expect((await readWorkerProgress()).liveness.find(item => item.role === "crawler")?.reason).toBe("restart_loop");
});

it("uses the persisted eligible frontier and worker observation for a no-progress signal", async () => {
  const now = new Date();
  await db.insert(crawlFrontier).values({ repo: "audit/old-ready", signal: "test", state: "pending",
    discoveredAt: new Date(now.getTime() - 10 * 60_000),
    updatedAt: new Date(now.getTime() - 10 * 60_000),
    nextAttemptAt: new Date(now.getTime() - 10 * 60_000) });
  await db.insert(operationsObservations).values({ key: "service:crawler:audit", value: { status: "running" }, observedAt: now });
  const fetch = async () => (await readWorkerProgress(now)).stages.find(row => row.stage === "fetch")!;
  expect(await fetch()).toMatchObject({ role: "crawler", reason: "no_progress", alarm: true });
  await db.update(crawlFrontier).set({ nextAttemptAt: new Date(now.getTime() + 10 * 60_000) })
    .where(eq(crawlFrontier.repo, "audit/old-ready"));
  expect(await fetch()).toMatchObject({ role: "crawler", reason: "no_work", alarm: false });
});

it("emits a machine-readable alarm with exit code 2 for an external monitor", async () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-worker-progress.ts"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    encoding: "utf8", timeout: 10_000,
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ overall: "alarm", stages: expect.any(Array),
    scheduler: expect.any(Object), liveness: expect.any(Array) });
});

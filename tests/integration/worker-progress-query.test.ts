import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { categoryDecisions, crawlCandidates, crawlDocuments, crawlFrontier, crawlPublicationChanges, crawlSettings, operationsObservations } from "@/lib/db/schema";
import { saveSettings } from "@/lib/crawl/settings";
import { buildWorkerProgress, readWorkerProgress } from "@/lib/operations/worker-progress-query";
import { observeService } from "@/lib/operations/observations";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

beforeAll(ensureSchema);
beforeEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(categoryDecisions);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(operationsObservations);
  await saveSettings({ enabled: true }, "test");
});

it("reports publisher, text, and maintenance liveness separately", () => {
  const now = new Date();
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [] }, [], [
    { key: 'service:publisher:pub', value: { status: 'running' }, observedAt: now },
    { key: 'service:text:txt', value: { status: 'running' }, observedAt: now },
    { key: 'service:maintenance:mt', value: { status: 'running' }, observedAt: now },
  ], now);
  expect(report.liveness.filter(row => ['publisher', 'text', 'maintenance'].includes(row.role)))
    .toMatchObject([{ role: 'publisher', reason: 'present' }, { role: 'maintenance', reason: 'present' },
      { role: 'text', reason: 'present' }]);
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

it("keeps an hour of boots and counts same-release restarts, not deploys", async () => {
  vi.stubEnv("SERVICE_INSTANCE_ID", "audit-publisher");
  const start = Date.now() - 30 * 60_000;
  await observeService("publisher", { status: "running", bootId: "a", bootedAt: start, release: "r1" });
  await observeService("publisher", { status: "running", bootId: "b", bootedAt: start + 60_000, release: "r2" });
  await observeService("publisher", { status: "running", bootId: "c", bootedAt: start + 20 * 60_000, release: "r2" });
  const [row] = await db.select().from(operationsObservations)
    .where(eq(operationsObservations.key, "service:publisher:audit-publisher"));
  // r1 → r2 는 배포, r2 → r2 는 죽고 다시 뜬 것. 5분 안 재시작은 없다
  expect(row.value).toMatchObject({ bootId: "c", restartCount1h: 1, restartCount5m: 0 });
});

it("ages an expired classification hold from its retry time, not from when it was held", async () => {
  // 같은 샤드의 다른 파일이 남긴 최근 발행이 있으면 "진행 중"으로 읽힌다 — 발행 진행이 없는 상태에서 잰다
  await db.delete(crawlPublicationChanges);
  const now = new Date();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  // 2026-10-08: 1시간 보류가 막 풀린 후보가 "61분 대기"로 보여 감시가 발행 워커를 재시작했다
  await db.insert(crawlCandidates).values({ repo: "audit/held", state: "approved", reason: "passed", decidedBy: "auto", updatedAt: ago(120) });
  await db.insert(categoryDecisions).values({ repo: "audit/held", sourceHash: "h", category: null, reason: "held",
    actor: "test", retryAt: ago(1), updatedAt: ago(61) });
  await db.insert(operationsObservations).values({ key: "service:publisher:audit", value: { status: "running" }, observedAt: now });
  const publish = async () => (await readWorkerProgress(now)).stages.find(row => row.stage === "publish")!;
  expect(await publish()).toMatchObject({ role: "publisher", reason: "warming_up", alarm: false });
  await db.update(categoryDecisions).set({ retryAt: ago(11) }).where(eq(categoryDecisions.repo, "audit/held"));
  expect(await publish()).toMatchObject({ role: "publisher", reason: "no_progress", alarm: true });
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

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlFrontier, crawlSettings, jobs, operationsAudit } from "@/lib/db/schema";
import { requestDueJobs } from "@/lib/jobs/control";
import { getJobState } from "@/lib/jobs/runner";
import { saveFeedSource } from "@/lib/crawl/feed-source-store";
import { getSettings } from "@/lib/crawl/settings";
import { feedSourceSchema } from "@/lib/crawl/feed-source-schema";
import { ensureSchema } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => { await db.delete(jobs); });

/** next_scheduled_at − now(), 초. 시간대 없는 칸이라 DB 안에서 잰다 */
async function secondsAhead(name: string): Promise<number> {
  const [row] = await db.execute<{ s: number }>(sql`SELECT extract(epoch from (next_scheduled_at - now()))::float8 AS s FROM jobs WHERE name = ${name}`);
  return Number(row.s);
}
const none = new Map<string, number>();

describe("scheduler 의 잡 주기 덮어쓰기", () => {
  it("덮어쓰기가 없으면 카탈로그 주기 그대로다(첫 요청 → 다음 예약 = 지금 + 주기, 예약 전에는 요청하지 않는다)", async () => {
    await requestDueJobs(undefined, { overrides: none });
    expect(await getJobState("crawl-judge")).toMatchObject({ requestedVersion: 1, processedVersion: 0 });
    expect(await secondsAhead("crawl-judge")).toBeGreaterThan(299);
    expect(await secondsAhead("crawl-judge")).toBeLessThanOrEqual(300);
    expect(await secondsAhead("gn-show-seed")).toBeGreaterThan(1799);
    await db.update(jobs).set({ processedVersion: 1 }).where(eq(jobs.name, "crawl-judge"));
    await requestDueJobs(undefined, { overrides: none });
    expect((await getJobState("crawl-judge"))?.requestedVersion).toBe(1);
    // 예약이 지나면 예약 시각에서 주기만큼 민다(처리 끝이 아니라 예약 기준)
    await db.update(jobs).set({ nextScheduledAt: sql`now() - interval '7 minutes'` }).where(eq(jobs.name, "crawl-judge"));
    await requestDueJobs(undefined, { overrides: none });
    expect((await getJobState("crawl-judge"))?.requestedVersion).toBe(2);
    expect(await secondsAhead("crawl-judge")).toBeGreaterThan(179);
    expect(await secondsAhead("crawl-judge")).toBeLessThanOrEqual(180);
  });

  it("덮어쓴 주기로 다음 예약을 잡고, 주기를 줄이면 멀리 잡힌 예약을 기다리지 않는다", async () => {
    await requestDueJobs(undefined, { overrides: new Map([["crawl-judge", 20 * 60_000]]) });
    expect(await secondsAhead("crawl-judge")).toBeGreaterThan(1199);
    await db.update(jobs).set({ processedVersion: 1 }).where(eq(jobs.name, "crawl-judge"));
    // 20분 → 2분: 18분 넘게 남은 예약을 버리고 바로 한 번 요청, 다음 예약은 2분 안
    await requestDueJobs(undefined, { overrides: new Map([["crawl-judge", 2 * 60_000]]) });
    expect((await getJobState("crawl-judge"))?.requestedVersion).toBe(2);
    const ahead = await secondsAhead("crawl-judge");
    expect(ahead).toBeGreaterThan(0);
    expect(ahead).toBeLessThanOrEqual(120);
    // 덮어쓰기를 지우면(코드 기본값) 이미 잡힌 예약까지 기다린다 — 기본 동작에는 줄이기 규칙이 없다
    await db.update(jobs).set({ processedVersion: 2, nextScheduledAt: sql`now() + interval '40 minutes'` }).where(eq(jobs.name, "crawl-judge"));
    await requestDueJobs(undefined, { overrides: none });
    expect((await getJobState("crawl-judge"))?.requestedVersion).toBe(2);
  });

  it("운영 설정 행의 덮어쓰기를 읽는다(범위 밖 값은 버리고 코드 기본값)", async () => {
    const [saved] = await db.execute<{ values: unknown }>(sql`SELECT values FROM runtime_settings WHERE id = 1`);
    try {
      await db.execute(sql`INSERT INTO runtime_settings (id, values, updated_by) VALUES (1, ${JSON.stringify({ version: 1,
        jobs: { "crawl-judge": { intervalMs: 45 * 60_000 }, "crawl-fetch": { intervalMs: 1_000 } } })}::jsonb, 'test')
        ON CONFLICT (id) DO UPDATE SET values = excluded.values`);
      const { resetJobIntervalOverridesForTest } = await import("@/lib/jobs/job-interval-reader");
      resetJobIntervalOverridesForTest();
      await requestDueJobs();
      expect(await secondsAhead("crawl-judge")).toBeGreaterThan(45 * 60 - 1);
      expect(await secondsAhead("crawl-fetch")).toBeLessThanOrEqual(60);
      resetJobIntervalOverridesForTest();
    } finally {
      if (saved) await db.execute(sql`UPDATE runtime_settings SET values = ${JSON.stringify(saved.values)}::jsonb WHERE id = 1`);
      else await db.execute(sql`DELETE FROM runtime_settings WHERE id = 1`);
    }
  });
});

describe("글 목록 수집원 저장", () => {
  const feed = feedSourceSchema.parse({ id: "feeds-example-abc123", name: "Example Show", url: "https://feeds.example/show.rss", titlePrefix: "Show:",
    link: { kind: "entry-link" }, intervalMinutes: 60, priority: 90, enabled: true });
  it("discover.feeds 만 바꾸고(검색 신호·Show GN 그대로) 화면이 본 값과 견주며, 이름이 겹치면 거절 — 모두 작업 로그에 남는다", async () => {
    await db.delete(crawlFrontier);
    const original = await db.select().from(crawlSettings);
    try {
      const before = await getSettings();
      const created = await saveFeedSource({ next: feed, expected: null, actor: "jr", reason: "새 수집원" });
      expect(created).toMatchObject({ ok: true, created: true });
      const after = await getSettings();
      expect(after.discover.feeds).toEqual([feed]);
      expect(after.discover.queries).toEqual(before.discover.queries);
      expect(after.discover.showGn).toEqual(before.discover.showGn);
      const [audit] = await db.select().from(operationsAudit).orderBy(desc(operationsAudit.id)).limit(1);
      expect(audit).toMatchObject({ action: "crawl-source-save", target: feed.id, actor: "jr", ok: true });
      // 같은 것을 다시 「새로」 넣으면 화면이 본 값과 다르다
      expect(await saveFeedSource({ next: feed, expected: null, actor: "jr" })).toMatchObject({ ok: false });
      // 끄기는 지금 값과 견준 뒤에만
      expect(await saveFeedSource({ next: { ...feed, enabled: false }, expected: feed, actor: "jr", reason: "잠시" })).toMatchObject({ ok: true, created: false });
      expect((await getSettings()).discover.feeds[0].enabled).toBe(false);
      // 검색 신호·Show HN 과 같은 이름은 받지 않는다
      const taken = await saveFeedSource({ next: { ...feed, id: "other-123456", name: before.discover.queries[0].label }, expected: null, actor: "jr" });
      expect(taken).toMatchObject({ ok: false });
      expect(await saveFeedSource({ next: { ...feed, id: "hn-123456", name: "show hn" }, expected: null, actor: "jr" })).toMatchObject({ ok: false });
      const [refused] = await db.select().from(operationsAudit).orderBy(desc(operationsAudit.id)).limit(1);
      expect(refused).toMatchObject({ action: "crawl-source-save", ok: false, error: "name_taken" });
    } finally {
      await db.delete(crawlSettings);
      if (original.length) await db.insert(crawlSettings).values(original);
    }
  });
});

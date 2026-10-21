import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, operationsObservations } from "@/lib/db/schema";
import { runJob as run } from "@/lib/jobs/runner";
import { jobTallyKey, jobTallyUpsert, READ_JOB_TALLIES, summarizeJobTallies } from "@/lib/jobs/tally";
import { operationsData } from "@/lib/operations/admin";
import { ensureSchema } from "./setup";

/**
 * 수집기 회차 누적(job-tally:<job>) — runner 가 성공 틱마다 이벤트 숫자를 정시·10분 묶음에 더하고, 실패 틱은 횟수·시각만 남긴다.
 * job:<name>(마지막 회차)은 그대로 덮어쓰고, 누적은 따로 쌓인다. 화면은 이 줄을 크롤러 활동에서만 읽는다.
 */
beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(jobs);
  await db.delete(operationsObservations).where(like(operationsObservations.key, "job-tally:%"));
  await db.delete(operationsObservations).where(like(operationsObservations.key, "job:%"));
});

/** 워커처럼 누적을 켠 한 틱 */
const runJob: typeof run = (name, handler, options = {}) => run(name, handler, { ...options, tally: true });
const tallyOf = async (name: string) => {
  const [row] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, jobTallyKey(name)));
  return row?.value as { at?: string; counts: Record<string, number>; lastFailedAt?: string } | undefined;
};
/** 지표 하나의 정시 묶음·10분 묶음 값 */
const buckets = (counts: Record<string, number>, metric: string) => Object.entries(counts)
  .filter(([key]) => key.endsWith(`|${metric}`)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key[0], value]);

describe("runner 의 회차 누적", () => {
  it("성공 틱의 모든 이벤트(마지막 12개만이 아니다)를 더하고, 다음 틱에 이어 더한다", async () => {
    const tick = () => runJob("crawl-fetch", async (ctx) => {
      // 관측(job:crawl-fetch)에는 마지막 12개만 남는다 — 누적에는 15개가 다 들어가야 한다
      for (let index = 0; index < 15; index++) ctx.log("crawl.fetched", { fetched: 2, skipped: 1, failed: 0, gated: 0, drained: true });
      ctx.log("crawl.fetch_rate_limited");
      ctx.log("crawl.seeded", { discovered: 3, page: 7, scanId: 99 });
      return { done: true };
    });
    expect(await tick()).toMatchObject({ status: "completed" });
    let tally = await tallyOf("crawl-fetch");
    expect(buckets(tally!.counts, "crawl.fetched#fetched")).toEqual([["h", 30], ["m", 30]]);
    expect(buckets(tally!.counts, "crawl.fetched#skipped")).toEqual([["h", 15], ["m", 15]]);
    // 0 은 싣지 않고, 참거짓·자리 값(page)은 더하지 않는다. 숫자 없는 이벤트는 나온 횟수다
    expect(Object.keys(tally!.counts).some((key) => /#(failed|gated|drained|page|scanId)$/.test(key))).toBe(false);
    expect(buckets(tally!.counts, "crawl.fetch_rate_limited")).toEqual([["h", 1], ["m", 1]]);
    expect(buckets(tally!.counts, "@ok")).toEqual([["h", 1], ["m", 1]]);
    const [last] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, "job:crawl-fetch"));
    expect((last.value as { events: unknown[] }).events).toHaveLength(12);

    await tick();
    tally = await tallyOf("crawl-fetch");
    expect(buckets(tally!.counts, "crawl.fetched#fetched")).toEqual([["h", 60], ["m", 60]]);
    expect(buckets(tally!.counts, "@ok")).toEqual([["h", 2], ["m", 2]]);
  });

  it("실패 틱은 숫자를 더하지 않고 @failed 와 lastFailedAt 만 남긴다 — 마지막 성공 회차는 그대로", async () => {
    await runJob("news-refresh", async (ctx) => { ctx.log("news.refreshed", { added: 4, failed: 1 }); return { done: true }; });
    const [success] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, "job:news-refresh"));
    expect(await runJob("news-refresh", async (ctx) => { ctx.log("news.refreshed", { added: 99 }); throw new Error("공급자 장애"); }))
      .toMatchObject({ status: "failed" });
    const tally = await tallyOf("news-refresh");
    expect(buckets(tally!.counts, "news.refreshed#added")).toEqual([["h", 4], ["m", 4]]);
    expect(buckets(tally!.counts, "@failed")).toEqual([["h", 1], ["m", 1]]);
    expect(Number.isFinite(Date.parse(tally!.lastFailedAt ?? ""))).toBe(true);
    const [after] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, "job:news-refresh"));
    expect(after.observedAt).toEqual(success.observedAt);

    // 다음 성공은 lastFailedAt 을 지우지 않는다(화면이 마지막 성공보다 나중인지로 가른다)
    await runJob("news-refresh", async () => ({ done: true }));
    expect((await tallyOf("news-refresh"))!.lastFailedAt).toBe(tally!.lastFailedAt);
  });

  it("수집기가 아닌 잡과 누적을 켜지 않은 직접 호출은 누적을 남기지 않는다", async () => {
    await runJob("second-review", async (ctx) => { ctx.log("second_review.voted", { voted: 3 }); return { done: true }; });
    await runJob("tally-unrelated", async () => ({ done: true }));
    expect(await tallyOf("second-review")).toBeUndefined();
    expect(await tallyOf("tally-unrelated")).toBeUndefined();
    await run("crawl-seed", async (ctx) => { ctx.log("crawl.seeded", { discovered: 3 }); return { done: true }; });
    expect(await tallyOf("crawl-seed")).toBeUndefined();
  });
});

describe("누적 한 줄 upsert", () => {
  it("동시에 써도 잃지 않고 더한다", async () => {
    await Promise.all(Array.from({ length: 12 }, () => db.execute(jobTallyUpsert("crawl-seed", { "crawl.seeded#discovered": 5, "@ok": 1 }))));
    const tally = await tallyOf("crawl-seed");
    expect(buckets(tally!.counts, "crawl.seeded#discovered")).toEqual([["h", 60], ["m", 60]]);
    expect(buckets(tally!.counts, "@ok")).toEqual([["h", 12], ["m", 12]]);
  });

  it("창 밖 묶음·모양이 틀린 열쇠·값은 버린다", async () => {
    const [clock] = await db.execute<{ hour: string; old_hour: string; old_ten: string }>(sql`
      SELECT to_char(date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24') AS hour,
        to_char(date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC') - interval '30 hours', 'YYYY-MM-DD"T"HH24') AS old_hour,
        to_char(date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC') - interval '3 hours', 'YYYY-MM-DD"T"HH24:MI') AS old_ten`);
    await db.insert(operationsObservations).values({ key: jobTallyKey("hn-show-seed"), observedAt: new Date(), value: { counts: {
      [`h${clock.old_hour}|@ok`]: 9, [`m${clock.old_ten}|@ok`]: 9, [`h${clock.hour}|@ok`]: 2,
      [`h${clock.hour}|DROP TABLE`]: 1, [`h${clock.hour}|crawl.show_hn_seeded#discovered`]: "7", "junk": 3,
    }, keep: "other field" } });
    await db.execute(jobTallyUpsert("hn-show-seed", { "@ok": 1 }));
    const tally = await tallyOf("hn-show-seed") as { counts: Record<string, number>; keep?: string };
    expect(tally.counts[`h${clock.hour}|@ok`]).toBe(3);
    expect(Object.keys(tally.counts).filter((key) => key.startsWith("h")).map((key) => key.split("|")[1]).sort()).toEqual(["@ok", "crawl.show_hn_seeded#discovered"]);
    expect(Object.keys(tally.counts).some((key) => key.includes(clock.old_hour) || key.startsWith(`m${clock.old_ten}`) || key === "junk")).toBe(false);
    // 다른 필드는 그대로 둔다
    expect(tally.keep).toBe("other field");
  });

  it("읽은 DB 시각 기준으로 최근 1시간·24시간을 더하고, 관측 표 전체 읽기에는 섞이지 않는다", async () => {
    await db.execute(jobTallyUpsert("crawl-fetch", { "crawl.fetched#fetched": 7, "@ok": 1 }));
    await db.execute(jobTallyUpsert("crawl-fetch", { "@failed": 1 }, { failed: true }));
    const [row] = await db.execute<{ at: string; rows: unknown }>(READ_JOB_TALLIES);
    const [summary] = summarizeJobTallies(row.at, row.rows);
    expect(summary).toMatchObject({ job: "crawl-fetch", hour: { "crawl.fetched#fetched": 7, "@ok": 1, "@failed": 1 },
      day: { "crawl.fetched#fetched": 7, "@ok": 1, "@failed": 1 } });
    expect(Number.isFinite(Date.parse(summary.lastFailedAt ?? ""))).toBe(true);
    const ops = await operationsData();
    expect(ops.observations.some((observation) => observation.key.startsWith("job-tally:"))).toBe(false);
  });
});

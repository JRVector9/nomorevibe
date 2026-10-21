import { describe, expect, it } from "vitest";
import { createTally, jobTallyKey, summarizeJobTallies, tallyCounts, TALLY_METRICS_PER_TICK } from "@/lib/jobs/tally";

describe("한 틱의 지표 합", () => {
  it("숫자 필드는 더하고, 0·참거짓·자리 값은 빼고, 이벤트마다 나온 횟수를 센다", () => {
    expect(tallyCounts([
      { event: "crawl.fetched", counts: { fetched: 3, skipped: 0, drained: true } },
      { event: "crawl.fetched", counts: { fetched: 2, skipped: 1 } },
      { event: "crawl.seeded", counts: { discovered: 4, page: 12, incompleteWindows: 2 } },
      { event: "crawl.show_hn_failed", counts: { page: 3 } },
      { event: "crawl.fetch_rate_limited", counts: {} },
    ])).toEqual({ "crawl.fetched": 2, "crawl.fetched#fetched": 5, "crawl.fetched#skipped": 1, "crawl.seeded": 1, "crawl.seeded#discovered": 4,
      "crawl.show_hn_failed": 1, "crawl.fetch_rate_limited": 1 });
  });

  it("한도 대기로 끝난 회차의 실제 모양({ fetched, resetAt }) — 나온 횟수와 그때까지 확보한 수를 모두 남긴다", () => {
    // lib/crawl/jobs/fetch.ts: ctx.log("crawl.fetch_rate_limited", { fetched: tally.fetched, resetAt: retryAt.toISOString() })
    // runner 는 숫자·참거짓만 넘긴다(resetAt 글자는 빠진다)
    expect(tallyCounts([{ event: "crawl.fetch_rate_limited", counts: { fetched: 7 } }]))
      .toEqual({ "crawl.fetch_rate_limited": 1, "crawl.fetch_rate_limited#fetched": 7 });
    expect(tallyCounts([{ event: "crawl.fetch_auth_unavailable", counts: { fetched: 0 } }])).toEqual({ "crawl.fetch_auth_unavailable": 1 });
  });

  it("이름 모양이 틀리거나 음수·소수·번호(…Id)는 버리고, 화면이 모르는 지표에만 상한을 둔다", () => {
    expect(tallyCounts([{ event: "DROP|x", counts: { a: 1 } }, { event: "ok.event", counts: { "bad field": 1, minus: -1, half: 0.5, good: 2, scanId: 7, id: 3 } }]))
      .toEqual({ "ok.event": 1, "ok.event#good": 2 });
    const tally = createTally();
    for (let index = 0; index < TALLY_METRICS_PER_TICK + 10; index++) tally.add({ event: `e${index}`, counts: {} });
    // 늦게 오는 요약(crawl.fetched)은 상한과 상관없이 싣는다
    tally.add({ event: "crawl.fetched", counts: { fetched: 9 } });
    const counts = tally.counts();
    expect(Object.keys(counts).filter((key) => key.startsWith("e"))).toHaveLength(TALLY_METRICS_PER_TICK);
    expect(counts).toMatchObject({ "crawl.fetched": 1, "crawl.fetched#fetched": 9 });
    // 이미 있는 지표는 상한을 넘어도 더한다
    tally.add({ event: "e0", counts: {} });
    expect(tally.counts().e0).toBe(2);
  });
});

describe("창마다 더하기", () => {
  const at = "2026-10-21T03:45:00.000Z";
  it("10분 묶음 7칸(최근 1시간)·정시 묶음 24칸(최근 24시간)만 더한다", () => {
    const [summary] = summarizeJobTallies(at, [{ key: jobTallyKey("crawl-fetch"), value: { lastFailedAt: "2026-10-21T03:40:00.000Z", counts: {
      "m2026-10-21T03:40|@ok": 3, "m2026-10-21T02:40|@ok": 2, "m2026-10-21T02:30|@ok": 100,
      "h2026-10-21T03|@ok": 5, "h2026-10-20T04|@ok": 7, "h2026-10-20T03|@ok": 100, "h2026-10-21T05|@ok": 100,
      "m2026-10-21T03:40|crawl.fetched#fetched": 9, "h2026-10-21T03|crawl.fetched#fetched": 9, "x|@ok": 1, "m2026-10-21T03:40|@failed": -1,
    } } }, { key: "job:crawl-fetch", value: {} }]);
    expect(summary).toEqual({ job: "crawl-fetch", hour: { "@ok": 5, "crawl.fetched#fetched": 9 }, day: { "@ok": 12, "crawl.fetched#fetched": 9 },
      lastFailedAt: "2026-10-21T03:40:00.000Z" });
    expect(summarizeJobTallies("not a time", [])).toEqual([]);
  });
});

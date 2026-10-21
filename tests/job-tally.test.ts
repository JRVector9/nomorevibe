import { describe, expect, it } from "vitest";
import { createTally, jobTallyKey, summarizeJobTallies, tallyCounts, TALLY_METRICS_PER_TICK } from "@/lib/jobs/tally";

describe("한 틱의 지표 합", () => {
  it("숫자 필드는 더하고, 0·참거짓·자리 값은 빼고, 숫자 없는 이벤트는 나온 횟수로 센다", () => {
    expect(tallyCounts([
      { event: "crawl.fetched", counts: { fetched: 3, skipped: 0, drained: true } },
      { event: "crawl.fetched", counts: { fetched: 2, skipped: 1 } },
      { event: "crawl.seeded", counts: { discovered: 4, page: 12, incompleteWindows: 2 } },
      { event: "crawl.show_hn_failed", counts: { page: 3 } },
      { event: "crawl.fetch_rate_limited", counts: {} },
      { event: "crawl.fetch_rate_limited", counts: {} },
    ])).toEqual({ "crawl.fetched#fetched": 5, "crawl.fetched#skipped": 1, "crawl.seeded#discovered": 4,
      "crawl.show_hn_failed": 1, "crawl.fetch_rate_limited": 2 });
  });

  it("이름 모양이 틀리거나 음수·소수는 버리고, 지표 수에 상한을 둔다", () => {
    expect(tallyCounts([{ event: "DROP|x", counts: { a: 1 } }, { event: "ok.event", counts: { "bad field": 1, minus: -1, half: 0.5, good: 2, scanId: 7, id: 3 } }]))
      .toEqual({ "ok.event#good": 2 });
    const tally = createTally();
    for (let index = 0; index < TALLY_METRICS_PER_TICK + 10; index++) tally.add({ event: `e${index}`, counts: { n: 1 } });
    expect(Object.keys(tally.counts())).toHaveLength(TALLY_METRICS_PER_TICK);
    // 이미 있는 지표는 상한을 넘어도 더한다
    tally.add({ event: "e0", counts: { n: 4 } });
    expect(tally.counts()["e0#n"]).toBe(5);
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

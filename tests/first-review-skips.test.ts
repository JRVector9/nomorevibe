import { describe, expect, it } from "vitest";
import { applyFirstReviewTick, boundFirstReviewSkips, candidateBoundSkip, excludedFirstReviewCandidates, forgetFirstReviewSkips,
  readFirstReviewSkips, FIRST_REVIEW_SKIP_ENTRY_TTL_MS, FIRST_REVIEW_SKIP_EXCLUDE_MS, FIRST_REVIEW_SKIP_STREAK_LIMIT,
  FIRST_REVIEW_SKIP_STRIKE_LIMIT, FIRST_REVIEW_SKIP_TABLE_MAX, type FirstReviewSkipTable, type FirstReviewTickOutcome } from "@/lib/crawl/first-review-skips";

const NOW = Date.parse("2026-11-12T00:00:00Z");
const tick = (table: FirstReviewSkipTable, outcomes: [number, FirstReviewTickOutcome][], now = NOW) =>
  applyFirstReviewTick(table, new Map(outcomes), now);
const running = { kind: "skipped", reason: "running" } as const;

/**
 * 2026-11-12 사용자 지시 「최대 재시도 횟수를 정해야 한다」 — 건너뜀은 시도 행이 없어 끝없이 되풀이됐다(2026-11-11 두 후보가 매 틱 running).
 * 같은 후보·같은 까닭의 연속 건너뜀을 세어 상한에서 잠시 빼고, 빼기를 거듭하면 사람에게 넘긴다.
 */
describe("1차 심사 건너뜀 상한", () => {
  it("상수는 연속 5회 · 30분 제외 · 3번이면 사람 확인이다", () => {
    expect([FIRST_REVIEW_SKIP_STREAK_LIMIT, FIRST_REVIEW_SKIP_EXCLUDE_MS, FIRST_REVIEW_SKIP_STRIKE_LIMIT, FIRST_REVIEW_SKIP_TABLE_MAX])
      .toEqual([5, 30 * 60_000, 3, 64]);
  });

  it("같은 까닭으로 연속 다섯 번이면 30분 쪽에서 빼고, 세 번째로 닿으면 사람에게 넘길 차례다", () => {
    let table: FirstReviewSkipTable = {};
    let now = NOW;
    const caps = [];
    for (let strike = 1; strike <= FIRST_REVIEW_SKIP_STRIKE_LIMIT; strike++) {
      for (let n = 1; n <= FIRST_REVIEW_SKIP_STREAK_LIMIT; n++) {
        now += 60_000;
        const result = tick(table, [[642281, running]], now);
        table = result.table;
        if (n < FIRST_REVIEW_SKIP_STREAK_LIMIT) expect(result.capped).toEqual([]);
        else caps.push(...result.capped);
      }
      expect(excludedFirstReviewCandidates(table, now)).toEqual([642281]);
      expect(excludedFirstReviewCandidates(table, now + FIRST_REVIEW_SKIP_EXCLUDE_MS)).toEqual([]);
      now += FIRST_REVIEW_SKIP_EXCLUDE_MS;
    }
    expect(caps.map(cap => [cap.candidateId, cap.reason, cap.strikes, cap.handOff])).toEqual([
      [642281, "running", 1, false], [642281, "running", 2, false], [642281, "running", 3, true]]);
    // 처음 상한에 닿은 때는 바뀌지 않는다 — 사람에게 넘기기 전에 그 뒤의 진전을 본다
    expect(new Set(caps.map(cap => cap.firstCappedAt)).size).toBe(1);
  });

  it("심사로 나아가면 칸을 지우고, 모델·틱 쪽 사정은 세지도 지우지도 않는다", () => {
    let { table } = tick({}, [[1, running], [2, running]]);
    ({ table } = tick(table, [[1, { kind: "progressed" }], [2, { kind: "neutral" }]]));
    ({ table } = tick(table, [[2, { kind: "skipped", reason: "all_ranks_unusable" }], [2, { kind: "skipped", reason: "tick_window_closed" }]]));
    expect(Object.keys(table)).toEqual(["2"]);
    expect(table["2"]).toMatchObject({ reason: "running", streak: 1 });
    for (const reason of ["all_ranks_unusable", "model_paused", "model_deferred", "tick_window_closed", "stage_inactive", "disabled",
      "reservation_lost", "withdrawn", "retry_wait", "capacity"]) expect(candidateBoundSkip(reason), reason).toBe(false);
    for (const reason of ["running", "item_owned", "input_changed", "input_too_large", "reviewer_unassigned", "dispatched", "work_busy"])
      expect(candidateBoundSkip(reason), reason).toBe(true);
  });

  it("까닭이 바뀌면 연속을 새로 센다 — 빼기 횟수는 이어진다", () => {
    const table: FirstReviewSkipTable = { "7": { reason: "running", streak: 4, strikes: 2, firstCappedAt: NOW - 3600_000, excludedUntil: null, lastAt: NOW } };
    const result = tick(table, [[7, { kind: "skipped", reason: "work_busy" }]]);
    expect(result.capped).toEqual([]);
    expect(result.table["7"]).toMatchObject({ reason: "work_busy", streak: 1, strikes: 2, firstCappedAt: NOW - 3600_000 });
  });

  it("커서의 표는 모양을 검사하고, 수명이 다한 칸·크기 상한 밖의 칸을 버린다(빼 둔 칸을 마지막에 버린다)", () => {
    const entry = (lastAt: number, excludedUntil: number | null = null) => ({ reason: "running", streak: 1, strikes: 0, firstCappedAt: null, excludedUntil, lastAt });
    expect(readFirstReviewSkips({ "1": entry(NOW), "x": entry(NOW), "2": { reason: "running" }, "3": entry(NOW - FIRST_REVIEW_SKIP_ENTRY_TTL_MS - 1) }, NOW))
      .toEqual({ "1": entry(NOW) });
    expect(readFirstReviewSkips("garbage", NOW)).toEqual({});
    const many: FirstReviewSkipTable = Object.fromEntries(Array.from({ length: FIRST_REVIEW_SKIP_TABLE_MAX + 5 }, (_, index) =>
      [String(index + 1), entry(NOW - index * 1000, index === FIRST_REVIEW_SKIP_TABLE_MAX + 4 ? NOW + 60_000 : null)]));
    const bounded = boundFirstReviewSkips(many, NOW);
    expect(Object.keys(bounded)).toHaveLength(FIRST_REVIEW_SKIP_TABLE_MAX);
    // 가장 오래된 칸이라도 빼 둔 칸은 남는다
    expect(bounded[String(FIRST_REVIEW_SKIP_TABLE_MAX + 5)]).toBeDefined();
    expect(forgetFirstReviewSkips(bounded, [1])["1"]).toBeUndefined();
  });
});

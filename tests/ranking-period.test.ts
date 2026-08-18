import { describe, expect, it } from "vitest";
import { nextSeasonPeriod, periodContaining } from "@/lib/domain/ranking/period";

describe("KST season periods", () => {
  it("starts a weekly season on Monday 00:00 KST", () => {
    const period = periodContaining(new Date("2026-08-18T03:00:00.000Z"), "weekly");
    expect(period).toMatchObject({ key: "2026-W34", isTransition: false });
    expect(period.startsAt.toISOString()).toBe("2026-08-16T15:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2026-08-23T15:00:00.000Z");

    const following = periodContaining(period.endsAt, "weekly");
    expect(following.startsAt).toEqual(period.endsAt);
    expect(following.key).toBe("2026-W35");
  });

  it("uses first-to-first calendar months", () => {
    const period = periodContaining(new Date("2026-08-18T03:00:00.000Z"), "monthly");
    expect(period.key).toBe("2026-08");
    expect(period.startsAt.toISOString()).toBe("2026-07-31T15:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2026-08-31T15:00:00.000Z");
  });

  it("creates a short transition when cadence changes off-boundary", () => {
    const current = periodContaining(new Date("2026-08-18T03:00:00.000Z"), "weekly");
    const next = nextSeasonPeriod(current.endsAt, "monthly");
    expect(next.isTransition).toBe(true);
    expect(next.key).toBe("2026-08-transition-20260824");
    expect(next.startsAt).toEqual(current.endsAt);
    expect(next.endsAt.toISOString()).toBe("2026-08-31T15:00:00.000Z");
  });
});
